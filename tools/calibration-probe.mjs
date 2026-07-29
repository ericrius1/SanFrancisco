// Headless tone-calibration probe. Boots the app in headless Chrome (WebGPU via
// ANGLE-metal), enables the grey-card chart (src/ui/calibrationChart.ts), pins a
// set of times of day over Marina Green, and for each one samples the rendered
// pixels of every calibration sphere. Prints measured display values next to a
// textbook prediction (sun-only Lambert → the live grade → sRGB), plus how many
// stops the 18% card sits above/below photographic neutral. This is the referee
// for any exposure / light-ratio / grading change.
//
//   node --experimental-strip-types tools/calibration-probe.mjs
// Env:
//   SF_PROBE_OUT  out dir (default .data/calibration-probe)
//   SF_PROBE_URL  existing vite (default http://127.0.0.1:5191 — starts its own)
//   SF_TIMES      comma list of hours (default "9,12,13.1,15.5,17.8,19,21,23")
//   SF_EXPOSURE   override toneMappingExposure for the whole run (default: app value)
//
// The camera is a free cam 25 m over Marina Green looking directly AWAY from the
// sun, so each sphere's sun-facing spot is visible. Two readings per sphere:
//   max   — brightest pixel on the disc ≈ the fully sunlit point (NdotL ≈ 1)
//   center— mean 3×3 at the sphere centre (normal points at the camera)
// Predictions ignore the analytic sky IBL and the 4% specular term, so measured
// should sit ABOVE predicted; big gaps beyond the configured IBL fill mean the
// mental model of the pipeline is wrong somewhere.

import { evaluateLook, findLook } from "../src/render/gradeLooks.ts";
import { decodePng, sampleDisc } from "./lib/pngSample.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/calibration-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5191";
const TIMES = (process.env.SF_TIMES ?? "9,12,13.1,15.5,17.8,19,21,23")
  .split(",").map(Number).filter((t) => Number.isFinite(t));
const EXPOSURE = process.env.SF_EXPOSURE ? Number(process.env.SF_EXPOSURE) : null;
const W = 1280, H = 720;
// Marina Green: flat, open grass, no shadowing towers (see memory/fun layer)
const SPOT = { x: -700, z: -2380 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- display transform ------------------------------------------------------
// The prediction runs the SAME code the renderer bakes into its LUT, imported
// from the single source of truth rather than transcribed. It used to be a hand
// copy of three's ACES fit, which was correct while the renderer used ACES and
// became a silent lie the moment it did not — a referee that measures against a
// stale model reports drift as calibration error. Whatever look is live in the
// page is the look predicted here, including the legacy `aces` one.
const srgbDecode = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const linLum = (srgbRgb) => lum(srgbRgb.map(srgbDecode));

/** Sun-only Lambert prediction; measured-minus-predicted contains analytic IBL. */
function predict(state, albedo, ndl) {
  const look = findLook(state.gradeLook);
  const rad = [0, 1, 2].map((i) => {
    const sun = state.sunC[i] * state.sunI * ndl;
    return (sun * albedo * state.exposure) / Math.PI;
  });
  return evaluateLook(look, rad[0], rad[1], rad[2]);
}

// -------------------------------------------------------- harness (fog-probe) --
async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDevIfNeeded() {
  try { await waitHttp(SERVER_URL, 2500, "existing vite"); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}

class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) { if (this.onEvent) this.onEvent(m); return; }
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(50); } }

// -------------------------------------------------------------- page snippets --
// Light-rig state + sun direction (sun light rides cameraPos + SUN_DIR·400).
const STATE_EXPR = `(()=>{const s=window.__sf.sky,sun=s.sun;
  const d=sun.position.clone().sub(sun.target.position).normalize();
  return {exposure:window.__sf.renderer.toneMappingExposure,
    sunI:sun.intensity,sunC:sun.color.toArray(),sunDir:d.toArray(),
    environmentI:window.__sf.scene.environmentIntensity,
    gradeLook:window.__sf.pipeline.grade.activeLookId(),
    elev:s.sunElevation};})()`;

// Each sphere's screen-space disc + camera-facing normal terms. Pixel sampling
// happens node-side on the CDP screenshot (drawImage of a WebGPU canvas reads
// back black in headless Chrome, so the page only reports geometry).
const GEOM_EXPR = `(()=>{const sf=window.__sf,THREE=sf.THREE,cam=sf.camera,chart=sf.calibrationChart;
  const cv=sf.renderer.domElement,w=cv.width,h=cv.height;
  const sun=sf.sky.sun;const sd=sun.position.clone().sub(sun.target.position).normalize();
  const v=new THREE.Vector3(),n=new THREE.Vector3();
  const f=(h*0.5)/Math.tan(THREE.MathUtils.degToRad(cam.fov*0.5));
  const out={w,h,spheres:[]};
  for(const s of chart.spheres){
    s.mesh.getWorldPosition(v);
    n.copy(cam.position).sub(v).normalize();
    const ndl=Math.max(0,n.dot(sd)),ny=n.y,dist=v.distanceTo(cam.position);
    v.project(cam);
    out.spheres.push({albedo:s.albedo,ndl,ny,
      cx:(v.x*0.5+0.5)*w,cy:(-v.y*0.5+0.5)*h,
      pr:Math.max(4,chart.radius/dist*f*0.72)});
  }
  return out;})()`;

// ---- minimal PNG decode (8-bit RGB/RGBA, non-interlaced — what CDP emits) ----
async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  const proc = spawn(chrome, [
    `--user-data-dir=${profile}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
  ], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  // Match on the URL, not on target.type: current headless Chrome reports the
  // app tab as type "other" rather than "page", and the old filter also hard-
  // coded 127.0.0.1 so any SF_PROBE_URL using localhost found nothing. Both
  // failed identically with "no app page target", which reads like the app
  // never booted rather than like a stale predicate.
  const host = new URL(SERVER_URL).host;
  let page;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.webSocketDebuggerUrl && typeof t.url === "string" && t.url.includes(host));
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error(`no app page target for ${host} on CDP port ${port}`);
  const c = new Cdp(page.webSocketDebuggerUrl);
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      console.log("[page-exception]", (d.exception && (d.exception.description || d.exception.value)) || d.text);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      console.log("[page-error]", m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300));
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.calibrationChart)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready (see [page-exception]/[page-error] above)");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // deterministic frame driving

  // pin the sky, park the player on Marina Green, raise the grey cards
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;
    window.__sf.RENDER_TUNING.values.greyCards=true;
    ${EXPOSURE !== null ? `window.__sf.RENDER_TUNING.values.exposure=${EXPOSURE};window.__sf.renderer.toneMappingExposure=${EXPOSURE};` : ""}
    const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${SPOT.x},${SPOT.z});
    p.teleportTo({x:${SPOT.x},y:y+1.5,z:${SPOT.z},facing:0,mode:'walk'});return true;})()`);
  await settle(c, 16); // stream tiles around the spot once

  const report = [];
  for (const t of TIMES) {
    await ev(c, `window.__sf.sky.setTimeOfDay(${t})`);
    await ev(c, frame(0)); // let #applySun move the key light before reading it
    // free cam 25 m up, looking horizontally straight AWAY from the sun so every
    // sphere shows its sunlit hemisphere to the lens
    await ev(c, `(()=>{const sf=window.__sf,sun=sf.sky.sun;
      const d=sun.position.clone().sub(sun.target.position).normalize();
      const vx=-d.x,vz=-d.z,l=Math.hypot(vx,vz)||1;
      const gy=sf.map.groundHeight(${SPOT.x},${SPOT.z});
      const eye=[${SPOT.x},gy+25,${SPOT.z}];
      window.__sfFreeCam(eye,[eye[0]+vx/l*60,eye[1],eye[2]+vz/l*60]);return true;})()`);
    await settle(c, 10);
    const state = await ev(c, STATE_EXPR);
    const geom = await ev(c, GEOM_EXPR);
    const shot = await c.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const pngBuf = Buffer.from(shot.data, "base64");
    writeFileSync(path.join(OUT, `t${t.toFixed(2).replace(".", "_")}.png`), pngBuf);
    const png = decodePng(pngBuf);
    const scale = png.w / geom.w; // canvas buffer px → screenshot px

    const rows = geom.spheres.map((s) => {
      const m = sampleDisc(png, s.cx * scale, s.cy * scale, s.pr * scale);
      const predMax = predict(state, s.albedo, 1);
      const predCenter = predict(state, s.albedo, s.ndl);
      return { ...s, ...m, predMax, predCenter };
    });
    report.push({ time: t, state, spheres: rows });

    console.log(`\n== t=${t.toFixed(2)}h  sun-elev=${state.elev.toFixed(1)}°  key=${state.sunI.toFixed(1)}  IBL=${state.environmentI.toFixed(3)}  exposure=${state.exposure}`);
    console.log("   albedo | sunlit-max sRGB (pred) | centre sRGB (pred)");
    for (const r of rows) {
      const m = lum(r.max), pm = lum(r.predMax), cJ = lum(r.center), pc = lum(r.predCenter);
      console.log(`   ${(r.albedo * 100).toFixed(0).padStart(4)}% |  ${m.toFixed(3)} (${pm.toFixed(3)})        |  ${cJ.toFixed(3)} (${pc.toFixed(3)})`);
    }
    const grey = rows.find((r) => Math.abs(r.albedo - 0.18) < 1e-6);
    if (grey) {
      const dl = linLum(grey.max);
      const stops = Math.log2(Math.max(dl, 1e-5) / 0.18);
      console.log(`   18% grey sunlit spot: display-linear ${dl.toFixed(3)} → ${stops >= 0 ? "+" : ""}${stops.toFixed(2)} stops vs photographic neutral (0.18)`);
    }
  }

  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n[probe] report + screenshots in ${OUT}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
