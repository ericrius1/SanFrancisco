// Water look sheet: boot headless, teleport to a water viewpoint, pin the civil
// clock, and capture the same spot at several headings and times of day.
//
// Water shading is dominated by two things a single screenshot cannot show:
// the Fresnel swing between looking DOWN (water body) and looking at the HORIZON
// (reflected sky), and the sun-glint path, which only exists when the sun is in
// or near frame. So every capture here is a grid of (time × heading) from one
// fixed position — that is the smallest thing that can actually falsify a
// reflection change.
//
//   node tools/water-look-probe.mjs <spot> <tag>
//
// env: SF_PROBE_URL (default http://127.0.0.1:5241), SF_PROBE_OUT,
//      SF_HOURS (comma list, default 8.5,15,19.2), SF_HEADINGS (comma list of
//      radians, default sun-relative — see HEADING_MODE), SF_W, SF_H
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(
  ROOT,
  process.env.SF_PROBE_OUT ?? path.join(process.env.TMPDIR ?? "/tmp", "sf-water-look")
);
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5241";
const W = Number(process.env.SF_W ?? 1600);
const H = Number(process.env.SF_H ?? 1000);
const HOURS = (process.env.SF_HOURS ?? "8.5,15,19.2").split(",").map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Water viewpoints. `eye`/`target` are resolved per-heading at capture time;
// `x`/`z` is where the PLAYER goes — the near (560 m) and hero (120 m) displaced
// sheets follow the player, not the camera, so a freecam-only shot would render
// the cheap far material while looking like open water.
const SPOTS = {
  // Open Pacific west of the Ocean Beach authored surf strip, IN BOUNDS (the
  // perf probe's `pacific` at z=5600 is 600 m off the south edge of the grid).
  pacific: { x: -6600, z: 3200, eyeY: 3.0 },
  // Marina shoreline: sea level, full hero+near+all four cascades.
  baywater: { x: -700, z: -2440, eyeY: 3.0 },
  // Lands End / Sutro water, the view in the original report.
  sutro: { x: -6350, z: 1117, eyeY: 4.0 },
  // Mid-bay open water, no land in frame.
  midbay: { x: 2000, z: -3500, eyeY: 3.0 },
  // Airborne over the bay — the drone framing, where the body colour dominates.
  drone: { x: 2000, z: -3500, eyeY: 90.0 }
};

const WHERE = process.argv[2] ?? "pacific";
const TAG = process.argv[3] ?? WHERE;
const SPOT = SPOTS[WHERE] ?? SPOTS.pacific;

async function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`timeout ${label}: ${url}`);
}
class Cdp {
  #ws;
  #id = 1;
  #p = new Map();
  constructor(u) {
    this.#ws = new WebSocket(u);
  }
  async open() {
    await new Promise((res, rej) => {
      this.#ws.addEventListener("open", res, { once: true });
      this.#ws.addEventListener("error", rej, { once: true });
    });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id);
      if (!p) return;
      this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { res, rej, method }));
  }
  close() {
    this.#ws.close();
  }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 700)}`);
  return r.result?.value;
}

/**
 * Capture a frame that is actually the one we just rendered.
 *
 * Page.captureScreenshot returns the COMPOSITOR's last presented surface, not
 * the WebGPU queue's last submit. With rAF parked by __sfManual(true), draining
 * the device queue proves the GPU finished but says nothing about presentation,
 * so a naive capture silently returns the previous frame — three consecutive
 * headings once came back byte-identical, which reads exactly like "the shading
 * change did nothing". Re-render across real compositor frames and require the
 * bytes to change before trusting the shot.
 */
async function capture(c, { renders = 3, settleMs = 220 } = {}) {
  let prev = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    for (let i = 0; i < renders; i++) {
      await ev(
        c,
        `(async()=>{const sf=window.__sf;sf.pipeline.render();
         await sf.renderer.backend.device.queue.onSubmittedWorkDone();
         await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`
      );
    }
    await sleep(settleMs);
    const { data } = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (prev !== null && data === prev) return data; // two identical reads = settled
    prev = data;
  }
  return prev;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  await waitHttp(SERVER_URL, 4000, "vite (start one first)");
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(
    chrome,
    [
      `--user-data-dir=${path.join(OUT, "chrome-" + TAG)}`,
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      "--hide-scrollbars",
      "--mute-audio",
      `--window-size=${W},${H}`,
      `${SERVER_URL}/?autostart=1&fullfps=1&profile=1`
    ],
    { cwd: ROOT, stdio: "ignore" }
  );

  let page;
  await sleep(2500);
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl);
  await c.open();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) {
    try {
      if (
        await ev(
          c,
          `!!(window.__sf&&window.__sf.player&&window.__sf.renderer?.backend?.device&&window.__sf.renderIdle?.()&&window.__sf.worldArrival?.snapshot?.state==='idle'&&!window.__sf.player.worldArrivalHeld)`
        )
      ) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(600);
  }
  if (!ready) throw new Error("app never ready");

  // Cross-city relocation must go through the arrival coordinator.
  const gen = await ev(
    c,
    `(()=>{const sf=window.__sf;const g=sf.worldArrival.snapshot.generation;sf.teleportToTarget(${SPOT.x},${SPOT.z},'water look');return g;})()`
  );
  const aT0 = Date.now();
  let arrived = false;
  while (Date.now() - aT0 < 180000) {
    try {
      if (
        await ev(
          c,
          `(()=>{const a=window.__sf.worldArrival.snapshot;return a.generation>${gen}&&a.state==='idle'&&!window.__sf.player.worldArrivalHeld;})()`
        )
      ) {
        arrived = true;
        break;
      }
    } catch {}
    await sleep(400);
  }
  if (!arrived) throw new Error("arrival never settled");

  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await ev(
    c,
    `(()=>{const sf=window.__sf;sf.dynRes?.setEnabled?.(false);sf.hud?.setHidden?.(true);sf.remotes?.setTagsVisible?.(false);
     for(const a of sf.remotes?.avatars?.values?.()??[])a.root.visible=false;
     for(const m of Object.values(sf.player.meshes??{}))m.visible=false;
     sf.worldCursor?.setEnabled?.(false);
     const l=document.getElementById('loading');if(l)l.style.display='none';
     const canvas=sf.renderer.domElement;
     for(const el of document.body.querySelectorAll('*')){if(el!==canvas&&!el.contains(canvas))el.style.visibility='hidden';}
     return true;})()`
  );
  // Park the player on the water so the near + hero displaced sheets are live —
  // they follow playerPos, not the camera, so a freecam-only shot would render
  // the cheap far material while looking like open water. 'walk' is the swim
  // controller too; its buoyancy floats the capsule to the waterline.
  await ev(
    c,
    `(async()=>{const sf=window.__sf,dev=sf.renderer.backend.device;
     sf.player.teleportTo({x:${SPOT.x},y:sf.map.groundTop(${SPOT.x},${SPOT.z})+1.1,z:${SPOT.z},facing:0,mode:'walk'});
     for(let i=0;i<180;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}
     return sf.player.position.toArray();})()`
  );

  // Wait for the water sheets to actually be in the scene. worldSystemsCore
  // hides all six roots and compiles them detached (warmHiddenRoot), restoring
  // visibility only once every compileAsync resolves — and the water sheets are
  // among the heaviest TSL graphs in the app. Capture before that lands and you
  // photograph a flat sea with the displaced sheets missing, which is
  // indistinguishable from "the shading change did nothing".
  const wT0 = Date.now();
  let sheeted = false;
  while (Date.now() - wT0 < 120000) {
    const s = await ev(
      c,
      `(()=>{const w=window.__sf.water;return w.near.visible&&w.far.visible&&w.horizon.visible;})()`
    );
    if (s) {
      sheeted = true;
      break;
    }
    await ev(c, `(async()=>{const sf=window.__sf;for(let i=0;i<10;i++){sf.tick(1/60);await sf.renderer.backend.device.queue.onSubmittedWorkDone();}return true;})()`);
    await sleep(400);
  }
  if (!sheeted) throw new Error("water sheets never became visible (warm never finished)");

  const shots = [];
  for (const hour of HOURS) {
    // setCivilTime (not setTimeOfDay): it also nulls the pocket time authority
    // and zeroes the live-fog mix, so two runs are actually comparable.
    const sky = await ev(
      c,
      `(()=>{const s=window.__sf.sky;s.setCivilTime({year:2026,month:7,day:26,hour:${hour}});
       return {hour:s.timeOfDay,elev:s.sunElevation,azim:s.sunAzimuth,realTime:s.realTime,cycle:s.cycleEnabled};})()`
    );
    // Headings measured against the SUN so "into the glint path" is captured at
    // every time of day, not just when the sun happens to sit near +z.
    const sunAz = (sky.azim * Math.PI) / 180;
    const headings = [
      { name: "intosun", yaw: sunAz, drop: 42 },
      { name: "cross", yaw: sunAz + Math.PI / 2, drop: 42 },
      { name: "away", yaw: sunAz + Math.PI, drop: 42 },
      // Steeply down at the near water: this is the frame where the hero patch
      // and every cascade are unambiguously in play, so it separates "the
      // shading is flat" from "this framing is all far-sheet LOD".
      { name: "down", yaw: sunAz + Math.PI / 2, drop: 420 }
    ];
    for (const hd of headings) {
      await ev(
        c,
        `(async()=>{const sf=window.__sf,dev=sf.renderer.backend.device;
         const yaw=${hd.yaw}, ex=${SPOT.x}, ez=${SPOT.z}, ey=${SPOT.eyeY};
         const dx=Math.sin(yaw), dz=Math.cos(yaw);
         // aim a few degrees below the horizon so both water and sky are in frame
         window.__sfFreeCam([ex,ey,ez],[ex+dx*400, ey-${hd.drop}, ez+dz*400]);
         for(let i=0;i<45;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}
         sf.pipeline.render(); await dev.queue.onSubmittedWorkDone(); return true;})()`
      );
      const name = `${TAG}-h${String(hour).replace(".", "_")}-${hd.name}.png`;
      const data = await capture(c);
      writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
      shots.push({ name, hour, heading: hd.name, sunElev: sky.elev, sunAzim: sky.azim });
      console.log(`[look] ${name}  sun elev ${sky.elev.toFixed(1)}° azim ${sky.azim.toFixed(0)}°`);
      if (process.env.SF_SHEET_SPLIT) {
        // Which sheet owns which pixels? Force each candidate on/off and shoot
        // again. The four sheets hand off by an exact alpha-0.5 cut, so a frame
        // that looks like one surface is really up to four materials and a
        // flat-looking mid-field is usually a coverage question, not a shading
        // one.
        for (const [label, expr] of [
          ["farOn", `w.far.visible=true`],
          ["noHorizon", `w.far.visible=true;w.horizon.visible=false`]
        ]) {
          await ev(
            c,
            `(async()=>{const sf=window.__sf,w=sf.water,dev=sf.renderer.backend.device;${expr};
             sf.pipeline.render();await dev.queue.onSubmittedWorkDone();return true;})()`
          );
          const n2 = `${TAG}-h${String(hour).replace(".", "_")}-${hd.name}-${label}.png`;
          writeFileSync(path.join(OUT, n2), Buffer.from(await capture(c), "base64"));
          console.log(`[look]   split ${n2}`);
        }
        await ev(c, `(()=>{const w=window.__sf.water;w.horizon.visible=true;return true;})()`);
      }
    }
  }

  // Coverage assertions. A water shot can look like open ocean while actually
  // rendering the cheap far material: the near (560 m) and hero (120 m)
  // displaced sheets follow the PLAYER, and a freecam that drifted away from
  // them silently downgrades the frame. Record enough to prove which sheet owned
  // the pixels, plus the CPU surface height, so a flat-looking frame can be
  // diagnosed without re-running.
  const state = await ev(
    c,
    `(()=>{const sf=window.__sf,w=sf.water,p=sf.player.position,c=sf.camera.position;
     const hx=w.heroNear.position.x,hz=w.heroNear.position.z;
     const nx=w.near.position.x,nz=w.near.position.z;
     const wh=(x,z)=>sf.map.waterHeight?sf.map.waterHeight(x,z,performance.now()/1000):null;
     return {simMask:w.simMask,near:w.near.visible,hero:w.heroNear.visible,far:w.far.visible,horizon:w.horizon.visible,
       player:[+p.x.toFixed(1),+p.y.toFixed(2),+p.z.toFixed(1)],
       camera:[+c.x.toFixed(1),+c.y.toFixed(2),+c.z.toFixed(1)],
       heroCentre:[hx,hz], nearCentre:[nx,nz],
       camToHero:+Math.hypot(c.x-hx,c.z-hz).toFixed(1),
       camToNear:+Math.hypot(c.x-nx,c.z-nz).toFixed(1),
       groundTop:+sf.map.groundTop(c.x,c.z).toFixed(2),
       isWater:sf.map.isWater?sf.map.isWater(c.x,c.z):null,
       surfaceY:wh(c.x,c.z)};})()`
  );
  writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify({ spot: WHERE, SPOT, shots, water: state }, null, 2));
  console.log(`[look] water sheets: ${JSON.stringify(state)}`);
  c.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("[look] FAILED:", e.message);
  process.exit(1);
});
