// CityGen cliff-lip foundation probe — the Point Lobos bluff above Sutro Baths.
//
// Buildings whose footprint sits on a cliff lip used to render with nothing under
// their downhill wall: the baked `base` and the old footprint-only ground sampler
// both read only the lot's OWN high ground, so neither tier knew about the
// drop-off a few metres west. render/foundation.ts now samples a ring DILATED
// outside the footprint and both tiers extrude a foundation skirt down to it.
//
// This boots the real city headless (WebGPU), streams tile 1_12, and then
//   1. ASSERTS numerically, from the live ring, that every building near the
//      bluff has foot <= the rendered ground just outside its own walls, and
//   2. SHOOTS the bluff from out over the water — the angle the float showed at.
//
//   node tools/citygen-cliff-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = process.env.SF_OUT ?? path.join(ROOT, ".data", "citygen-shots");
// The two reported floaters (tile 1_12) and the bluff they stand on.
const FOCUS = { x: -6172, z: 1284 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue; return c;
  }
  throw new Error("no chrome");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout " + url); }
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); }
  close() { this.#ws.close(); }
}
async function evaluate(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, expr)) return true; } catch {} await sleep(300); } return false; }
async function tick(c) { try { await evaluate(c, "window.__sf.tick(0.05)"); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 }); const f = path.join(OUT, name); writeFileSync(f, Buffer.from(s.data, "base64")); console.log("  saved", f); return f; }

let pass = 0, fail = 0;
const check = (ok, label, extra = "") => { (ok ? pass++ : fail++); console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); };

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const relayPort = await freePort();
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(SERVER_URL, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-cliff-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    if (!await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.citygenRing)", 180000)) throw new Error("boot timeout");
    console.log("[probe] booted");
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5);
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics)s.aiCars.postPhysics=()=>{}; } }catch{}
      if(!window.__f){window.__f=1; s.chase.update=()=>{}; s.player.update=()=>{};} return 1;})()`);
    // The ring is background-admitted after the reveal settles — wait for it.
    if (!await waitEval(c, "Boolean(window.__sf.citygenRing.current)", 180000)) throw new Error("ring never constructed");
    console.log("[probe] ring up:", await evaluate(c, "window.__sf.citygenRing.current.count"));

    // Stand on the bluff so tile 1_12 streams to the DETAIL tier (the tier that
    // had no skirt at all) rather than only the merged chunk prism.
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundTop(${FOCUS.x},${FOCUS.z})+2;
      p.position.set(${FOCUS.x},y,${FOCUS.z}); p.renderPosition.copy(p.position);
      s.physics.world.setBodyTransform(p.body,[${FOCUS.x},y,${FOCUS.z}],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 400; i++) await tick(c);
    const stats = await evaluate(c, "JSON.stringify(window.__sf.citygenRing.current.stats())");
    console.log("[probe] stats", stats);

    // ---- numeric invariant -------------------------------------------------
    // For every streamed building near the bluff, walk its own perimeter and
    // sample the RENDERED ground just outside each wall. The wall bottom (`foot`)
    // must never sit above that ground, or you can see under the building.
    const report = await evaluate(c, `(()=>{
      const s = window.__sf, ring = s.citygenRing.current;
      const rows = ring.debugEntriesNear(${FOCUS.x}, ${FOCUS.z}, 220).filter(e => e.foot !== undefined);
      const out = [];
      for (const e of rows) {
        // The no-float invariant is about the REAL wall line: walk the footprint,
        // sample the rendered ground a hair OUTSIDE each wall, and require the
        // wall bottom (\`foot\`) to sit at or below it. Sampling a circle around
        // the centroid instead would wander down the cliff face in FRONT of the
        // building, where terrain is legitimately far below the wall.
        const p = e.poly;
        let area = 0;
        for (let k = 0; k < p.length; k++) { const a = p[k], b = p[(k + 1) % p.length]; area += a[0] * b[1] - b[0] * a[1]; }
        const ring2 = area < 0 ? [...p].reverse() : p;   // outward normal needs CCW
        let worst = -Infinity, at = null;
        for (let k = 0; k < ring2.length; k++) {
          const [x0, z0] = ring2[k], [x1, z1] = ring2[(k + 1) % ring2.length];
          const ex = x1 - x0, ez = z1 - z0, len = Math.hypot(ex, ez) || 1e-3;
          const nx = ez / len, nz = -ex / len;
          const n = Math.max(2, Math.ceil(len / 1.0));
          for (let i = 0; i <= n; i++) {
            const t = i / n;
            const x = x0 + ex * t + nx * 0.4, z = z0 + ez * t + nz * 0.4;
            const g = s.map.groundTop(x, z);
            if (e.foot - g > worst) { worst = e.foot - g; at = [Math.round(x), Math.round(z), Math.round(g * 10) / 10]; }
          }
        }
        out.push({ i: e.i, cx: Math.round(e.cx), cz: Math.round(e.cz), state: e.state,
          base: e.base, grade: Math.round(e.grade * 100) / 100, foot: Math.round(e.foot * 100) / 100,
          skirt: Math.round((e.base - e.foot) * 100) / 100, worstGap: Math.round(worst * 100) / 100, at });
      }
      out.sort((a, b) => b.worstGap - a.worstGap);
      return JSON.stringify(out);
    })()`);
    const rows = JSON.parse(report);
    console.log(`\n[probe] ${rows.length} streamed buildings within 220 m of the bluff`);
    for (const r of rows.slice(0, 8)) console.log("   ", JSON.stringify(r));
    check(rows.length > 0, "bluff cells streamed buildings", `n=${rows.length}`);
    const floaters = rows.filter((r) => r.worstGap > 0.3);
    check(floaters.length === 0, "no building's foundation sits above nearby ground",
      `worst=${rows[0] ? rows[0].worstGap.toFixed(2) : "n/a"}m floaters=${floaters.length}`);
    const targets = rows.filter((r) => r.i === 1 || r.i === 2);
    check(targets.length === 2 && targets.every((r) => r.skirt > 0.5),
      "the two reported floaters grew a real foundation skirt",
      targets.map((r) => `#${r.i} skirt=${r.skirt}m foot=${r.foot}`).join("  "));

    // ---- the shots ---------------------------------------------------------
    // The gap only reads from OUTSIDE and BELOW — from the water and along the
    // approach. Each eye is lifted clear of whatever ground it stands over so a
    // camera placed over the bluff never ends up buried inside the hill.
    const setCam = async (ex, lift, ez, lx, ly, lz) =>
      evaluate(c, `(()=>{const g=window.__sf.map.groundTop(${ex},${ez});
        window.__sfFreeCam([${ex}, Math.max(g,0)+${lift}, ${ez}], [${lx},${ly},${lz}]); return 1;})()`);
    for (const [name, cam] of [
      ["citygen_cliff_water.jpg", [FOCUS.x - 170, 8, FOCUS.z + 40, FOCUS.x, 14, FOCUS.z]],
      ["citygen_cliff_low.jpg", [FOCUS.x - 85, 5, FOCUS.z + 25, FOCUS.x, 13, FOCUS.z]],
      ["citygen_cliff_approach.jpg", [FOCUS.x - 110, 22, FOCUS.z - 80, FOCUS.x, 14, FOCUS.z]],
    ]) {
      await setCam(...cam);
      for (let i = 0; i < 40; i++) await tick(c);
      await sleep(600);
      await shot(c, name);
    }
    c.close();
  } finally {
    try { chrome?.kill(); } catch {}
    try { process.kill(-dev.pid); } catch {}
  }
  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
