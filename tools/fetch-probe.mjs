// Headless verification probe for the Corona Heights FETCH-THE-BALL loop + pet
// adoption + tool/UI cleanup. Boots the app in headless Chrome (WebGPU/metal)
// WITHOUT ?autostart (so the real settle gate runs), simulates the name-gate
// Start, pins the clock, teleports the camera to the dog park (waiting out the
// render warmup + the camera fly-in the way dog-park-probe does), then drives
// the whole loop through the exposed __sf hooks and asserts:
//   1. toolbar DOM = exactly ball,paint,bubbles (order) + verb + default select
//   2. cycling tools never throws; no chimes/rope globals survive
//   3. ball tool -> a tennis ball is clasped visible in the player's hand
//   4. scripted throw inside the park -> ball leaves the hand, flies an arc,
//      lands, a DOG chases it and mouth-carries it back and waits (proved from
//      sampled dog+ball trajectories, not mere proximity)
//   5. player near the waiting dog -> the click verb flips to "take"
//   6. a second complete cycle with the SAME dog fires adoption; the pet then
//      follows the player 400+ m away (past ACTIVITY_RANGE, gate shut) staying
//      < 12 m and still animating (pet update is not behind the park gate)
//   7. the park's OWN owner delivery ends with the ball within 0.35 m of an
//      owner HAND world-pos while the mitt is clasped (not floating at a shoulder)
//   8. dog top speed sits in a believable band and small dogs < large dogs
//   9. zero console errors / page exceptions across boot + the whole run
// Plus 4 screenshots: clasped-ball close-up, mid-fetch chase, handoff clasp,
// pet following away from the park.
//
//   node tools/fetch-probe.mjs
// Env: SF_PROBE_OUT (default scratchpad), CHROME_BIN, SF_TIME (default 13.5)

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.env.SF_PROBE_OUT ?? "/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/b523ba44-1f66-4eb6-9094-b48e50a5577c/scratchpad/fetch-probe");
const TIME = Number(process.env.SF_TIME ?? 13.5);
const W = 1280, H = 720;
const DT = 1 / 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror of layout.ts CORONA_DOG_PARK (for in-bounds checks).
const DOG_PARK = [
  [325.72, 2728.49], [330.12, 2729.44], [339.39, 2730.28], [358.81, 2718.47],
  [387.78, 2707.78], [401.72, 2705.57], [410.71, 2706.15], [405.81, 2695.76],
  [410.34, 2682.36], [408.82, 2678.87], [399.63, 2678.48], [386.37, 2682.08],
  [358.43, 2694.09], [341.07, 2707.59], [330.49, 2720.34]
];
const SUMMIT = { x: 408, z: 2760 };
function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function distToPolygonEdge(x, z, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ez = bz - az, ll = ex * ex + ez * ez;
    const t = ll > 1e-9 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / ll)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + ex * t), z - (az + ez * t)));
  }
  return best;
}

async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue;
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
  close() { try { this.#ws.close(); } catch {} }
}

let ownedDev = null, chromeProc = null, activeCdp = null;
function cleanup() {
  try { activeCdp?.close(); } catch {}
  try { chromeProc?.kill("SIGKILL"); } catch {}
  try { if (ownedDev) process.kill(-ownedDev.pid, "SIGKILL"); } catch { try { ownedDev?.kill("SIGKILL"); } catch {} }
  activeCdp = null; chromeProc = null; ownedDev = null;
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(50); } }
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}
async function freeCam(c, x, z, facing, back, up) {
  return ev(c, `(()=>{const m=window.__sf.map;const gy=m.groundHeight(${x},${z});
    const dx=Math.sin(${facing}),dz=Math.cos(${facing});
    const eye=[${x}-dx*${back}, gy+${up}, ${z}-dz*${back}];
    window.__sfFreeCam(eye,[${x}+dx*40, gy+${Math.max(3, up * 0.4)}, ${z}+dz*40]);return eye;})()`);
}
async function settleCamera(c, eye) {
  for (let i = 0; i < 180; i++) {
    await tick(c, 0);
    const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`);
    if (Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) < 0.06) return;
    await sleep(40);
  }
  throw new Error("free camera never acquired the render pose");
}
// The deferred render warmup makes tick early-return for real seconds after the
// world settles. The park rewrites coronaHeights.group.visible every live frame,
// so a cleared flag that comes back true proves the full sim path ran.
async function waitWorldLive(c, label) {
  for (let i = 0; i < 200; i++) {
    const live = await ev(c, `(()=>{const ch=window.__sf.coronaHeights;ch.group.visible=false;window.__sf.tick(${DT});return ch.group.visible;})()`);
    if (live) { if (i > 0) console.log(`[probe] world live for ${label} after ${(i * 0.3).toFixed(1)}s`); return; }
    await sleep(300);
  }
  throw new Error(`world never went live (${label}) — render warmup stuck?`);
}

// ------------------------------------------------------------- page helpers
const PAGE_HELPERS = `(() => {
  const T = window.__sf.THREE;
  const tmp = new T.Vector3();
  window.__fp = {
    // Prefer the free ball a player-claimed dog is interacting with; else any
    // visible thrown ball (infinite throws leave several in the scene).
    playerBall() {
      const balls = [];
      window.__sf.scene.traverse((o) => {
        if (o.name === 'player_tennis_ball' && o.visible) balls.push(o);
      });
      if (!balls.length) return null;
      const dog = window.__sf.coronaHeights.dogs.find((d) => d.controller === 'player');
      if (dog) {
        let best = balls[0], bestD = Infinity;
        for (const b of balls) {
          const dd = Math.hypot(b.position.x - dog.x, b.position.z - dog.z);
          if (dd < bestD) { bestD = dd; best = b; }
        }
        return best;
      }
      return balls[balls.length - 1];
    },
    snap() {
      const sf = window.__sf, ch = sf.coronaHeights, fb = sf.fetchBall;
      const ball = window.__fp.playerBall();
      const bpos = ball ? { x: ball.position.x, y: ball.position.y, z: ball.position.z, vis: ball.visible } : null;
      const dogs = ch.dogs.map((d, i) => {
        ch.dogMouthWorld(d, tmp);
        return { i, x: d.x, z: d.z, speed: d.speed, scale: d.style.scale, controller: d.controller,
          fetch: d.playerFetchCount, name: d.style.name, mouthX: tmp.x, mouthY: tmp.y, mouthZ: tmp.z,
          leg0: d.legs[0].rotation.x, jaw: d.jaw.rotation.x };
      });
      const p = sf.player.position;
      return { ball: bpos, dogs, player: { x: p.x, y: p.y, z: p.z },
        verb: fb.verb(), wantsTake: fb.wantsTake(), throwProg: fb.throwProgress(),
        groundAtBall: bpos ? sf.map.groundTop(bpos.x, bpos.z) : 0, activityVis: ch.activity.visible };
    },
    // E-to-pick-up (replaces click-to-take)
    pickupBall() {
      return window.__sf.fetchBall.tryPickup(window.__sf.player.position);
    },
    // run frames with a live-world heartbeat; stop early on a named condition
    run(dt, maxFrames, cond) {
      const sf = window.__sf, ch = sf.coronaHeights;
      const out = [];
      for (let i = 0; i < maxFrames; i++) {
        ch.group.visible = false;
        sf.tick(dt);
        if (!ch.group.visible) return { frozen: true, samples: out };
        const s = window.__fp.snap();
        out.push(s);
        if (cond === 'takeReady' && sf.fetchBall.wantsTake()) return { frozen: false, hit: true, samples: out };
        if (cond === 'midChase') {
          const d = s.dogs.find((x) => x.controller === 'player');
          if (d && s.ball && s.ball.vis) {
            const dd = Math.hypot(s.ball.x - d.x, s.ball.z - d.z);
            if (dd > 2.5 && dd < 9) return { frozen: false, hit: true, samples: out };
          }
        }
        if (cond === 'ownerReceive') {
          const o = ch.owners[0];
          if (o.reach > 0.45 && o.clasp > 0.4) return { frozen: false, hit: true, samples: out };
        }
      }
      return { frozen: false, hit: false, samples: out };
    },
    // fetchBall.click with an aim into the park interior (or a take)
    clickBall(px, pz, tx, tz, up) {
      const sf = window.__sf;
      const T = sf.THREE;
      const origin = new T.Vector3(px, 1.4, pz);
      const aim = new T.Vector3(tx - px, up, tz - pz).normalize();
      sf.fetchBall.click(origin, aim);
      return true;
    },
    // owner-hand handoff snapshot (assertion 7)
    ownerHandoff() {
      const sf = window.__sf, ch = sf.coronaHeights, T = sf.THREE;
      const o = ch.owners[0], rig = o.rig;
      rig.group.updateWorldMatrix(true, true);
      const hand = new T.Vector3(); rig.handR.getWorldPosition(hand);
      const sh = new T.Vector3(); rig.armR.getWorldPosition(sh);
      const ball = sf.scene.getObjectByName('corona_tennis_ball');
      return { clasp: o.clasp, reach: o.reach,
        hand: { x: hand.x, y: hand.y, z: hand.z }, shoulder: { x: sh.x, y: sh.y, z: sh.z },
        ball: { x: ball.position.x, y: ball.position.y, z: ball.position.z } };
    },
    // held ball prop (assertion 3): find the clasped tennis ball in the walk rig
    heldBall() {
      const sf = window.__sf;
      const walk = sf.player.meshes.walk;
      let prop = null;
      walk.traverse((o) => {
        if (prop) return;
        if (o.isMesh && o.geometry && o.geometry.type === 'SphereGeometry' &&
            o.material && o.material.color && o.material.color.getHex() === 0xb9ef31) prop = o;
      });
      if (!prop) return { found: false };
      const w = new T.Vector3(); prop.getWorldPosition(w);
      const hand = new T.Vector3(); sf.player.handWorldPos(hand);
      const g = sf.map.groundTop(w.x, w.z);
      return { found: true, visible: prop.visible, world: { x: w.x, y: w.y, z: w.z },
        hand: { x: hand.x, y: hand.y, z: hand.z }, aboveGround: w.y - g,
        distToHand: Math.hypot(w.x - hand.x, w.y - hand.y, w.z - hand.z) };
    },
    toolbarDom() {
      const btns = Array.from(document.querySelectorAll('.toolbar .tools .tool'));
      return btns.map((b) => {
        const spans = Array.from(b.querySelectorAll('span')).map((s) => s.textContent.trim());
        const label = spans.find((t) => /^(ball|paint|bubbles)$/.test(t)) || spans[1] || '';
        return { label, on: b.classList.contains('on') };
      });
    },
    hasVerb(text) { return document.body.innerText.includes(text); },
    globalsClean() {
      const sf = window.__sf;
      const sfKeys = Object.keys(sf).filter((k) => /chime|rope/i.test(k));
      const win = Object.keys(window).filter((k) => /^chime|^rope|chimes$|ropes$/i.test(k));
      return { sfBad: sfKeys, winBad: win };
    }
  };
  return true;
})()`;

async function shoot(c, name) {
  await ev(c, `window.__sf.sky.setTimeOfDay(${TIME})`);
  for (let i = 0; i < 6; i++) await tick(c, DT);
  const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
  const file = path.join(OUT, `${name}.jpg`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`[probe] shot ${name}`);
  return file;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const results = [];
  const shots = [];
  const push = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} — ${detail}`); };

  // ---- own vite on a free port (never the shared 5179), relay 8788
  const vitePort = await freePort();
  const relayPort = 8788;
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  console.log(`[probe] starting Vite at ${SERVER_URL} (relay ${relayPort})`);
  ownedDev = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "pipe", "pipe"], detached: true
  });
  ownedDev.stdout.on("data", () => {});
  ownedDev.stderr.on("data", (d) => { const s = String(d); if (/error/i.test(s)) console.error("[vite]", s.slice(0, 300)); });
  await waitHttp(SERVER_URL, 60000, "vite");

  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  // NO ?autostart — let the real settle gate run. ?fullfps: webdriver would cap rAF.
  chromeProc = spawn(chrome, [
    `--user-data-dir=${profile}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?fullfps`
  ], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);

  let page;
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
  activeCdp = c;
  const pageErrors = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      pageErrors.push(`exception: ${String(text).slice(0, 300)}`);
      console.log("[page-exception]", String(text).slice(0, 300));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const text = m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300);
      pageErrors.push(`console.error: ${text}`);
      console.log("[page-error]", text);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  // ---- boot: wait for __sf, then simulate the name-gate Start (settle gate flow)
  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player&&window.__sf.fetchBall&&window.__sf.coronaHeights)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready (see [page-exception]/[page-error])");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // wait for the settle gate to reveal + enable Start, then click it (real entry)
  const t1 = Date.now();
  let started = false;
  while (Date.now() - t1 < 60000) {
    const st = await ev(c, `(()=>{const b=document.querySelector('[data-start-form] button');const loading=document.getElementById('loading');
      if(loading&&loading.classList.contains('done')) return 'already';
      if(b&&!b.disabled){b.click();return 'clicked';}return b?'wait':'nobtn';})()`);
    if (st === "clicked" || st === "already") { started = true; console.log(`[probe] game entered (${st})`); break; }
    await sleep(500);
  }
  if (!started) throw new Error("name-gate Start never became clickable (settle gate stuck?)");

  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // deterministic ticks
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
  await ev(c, PAGE_HELPERS);
  await settle(c, 12);

  // ============================================================ assertion 1+2
  // (toolbar DOM + verb + default; cycling never throws; no chimes/rope globals)
  const dom0 = await ev(c, `window.__fp.toolbarDom()`);
  const order = dom0.map((d) => d.label);
  const orderOk = order.length === 3 && order[0] === "ball" && order[1] === "paint" && order[2] === "bubbles";
  const defaultSel = dom0.find((d) => d.on)?.label ?? "(none)";
  push("toolbar-order", orderOk, `tools DOM = [${order.join(", ")}] (expected ball, paint, bubbles); default-selected = ${defaultSel}`);

  const globals = await ev(c, `window.__fp.globalsClean()`);
  // exercise tool cycling via the public setTool + ensure no throw fires
  await ev(c, `window.__sf.setTool('ball')`);
  await settle(c, 3);
  await ev(c, `window.__sf.setTool('bubbles')`);
  await ev(c, `window.__sf.setTool('spray')`);
  await ev(c, `window.__sf.setTool('ball')`);
  await settle(c, 3);
  const afterCycle = await ev(c, `window.__fp.snap()`);
  const ballThrown = !!(afterCycle.ball && afterCycle.ball.vis);
  push("cycle-no-throw-no-globals",
    !ballThrown && globals.sfBad.length === 0 && globals.winBad.length === 0,
    `ball thrown by cycling: ${ballThrown}; chimes/rope keys on __sf: [${globals.sfBad.join(",")}], on window: [${globals.winBad.join(",")}]`);

  // verb visible after selecting ball
  await ev(c, `window.__sf.setTool('ball')`); await settle(c, 2);
  const verbShown = await ev(c, `window.__fp.hasVerb('throw the ball')`);
  push("verb-throw-the-ball", verbShown, `HUD shows "throw the ball": ${verbShown}`);

  // ============================================================ teleport to park
  await teleport(c, 368, 2703, 2.3);
  await settle(c, 16);
  const eyeA = await freeCam(c, 368, 2703, 2.3, 20, 8);
  await waitWorldLive(c, "park");
  await settleCamera(c, eyeA);
  await waitWorldLive(c, "park post-settle");
  const gateTicks = await ev(c, `(()=>{const sf=window.__sf;for(let i=0;i<300;i++){sf.tick(${DT});if(sf.coronaHeights.activity.visible)return i;}return -1;})()`);
  if (gateTicks < 0) throw new Error("dog park activity gate never opened");
  console.log(`[probe] activity gate open after ${gateTicks} ticks`);

  if (process.env.SF_MEASURE) {
    // one-off: dump owner right/left hand + ball geometry at clasp frames
    await ev(c, `(()=>{window.__fp.measure=()=>{const sf=window.__sf,ch=sf.coronaHeights,T=sf.THREE;const o=ch.owners[0],rig=o.rig;rig.group.updateWorldMatrix(true,true);
      const hR=new T.Vector3();rig.handR.getWorldPosition(hR);const hL=new T.Vector3();rig.handL.getWorldPosition(hL);
      const aR=new T.Vector3();rig.armR.getWorldPosition(aR);const ball=sf.scene.getObjectByName('corona_tennis_ball');
      const g=sf.map.groundTop(o.x,o.z);const cy=Math.cos(o.yaw),sy=Math.sin(o.yaw);
      const inv=(wx,wz)=>({lx:(wx-o.x)*cy-(wz-o.z)*sy, lz:(wx-o.x)*sy+(wz-o.z)*cy});
      return {reach:o.reach,clasp:o.clasp,yaw:o.yaw,g,
        handR:{...inv(hR.x,hR.z),ly:hR.y-g},handL:{...inv(hL.x,hL.z),ly:hL.y-g},
        ball:{...inv(ball.position.x,ball.position.z),ly:ball.position.y-g},
        dBallHandR:Math.hypot(ball.position.x-hR.x,ball.position.y-hR.y,ball.position.z-hR.z),
        dBallHandL:Math.hypot(ball.position.x-hL.x,ball.position.y-hL.y,ball.position.z-hL.z)};};return true;})()`);
    const rows = [];
    for (let i = 0; i < 1400; i++) {
      await ev(c, `window.__sf.tick(${DT})`);
      const m = await ev(c, `(()=>{const o=window.__sf.coronaHeights.owners[0];return o.clasp>0.5?window.__fp.measure():null;})()`);
      if (m) rows.push(m);
      if (rows.length > 40) break;
    }
    console.log("[measure] clasp-frame samples (owner-local lx,lz,ly):");
    for (const m of rows.slice(0, 20)) {
      console.log(`  reach=${m.reach.toFixed(2)} clasp=${m.clasp.toFixed(2)} | handR(lx=${m.handR.lx.toFixed(2)},lz=${m.handR.lz.toFixed(2)},ly=${m.handR.ly.toFixed(2)}) handL(lx=${m.handL.lx.toFixed(2)},lz=${m.handL.lz.toFixed(2)},ly=${m.handL.ly.toFixed(2)}) ball(lx=${m.ball.lx.toFixed(2)},lz=${m.ball.lz.toFixed(2)},ly=${m.ball.ly.toFixed(2)}) | dR=${m.dBallHandR.toFixed(2)} dL=${m.dBallHandL.toFixed(2)}`);
    }
    cleanup();
    process.exit(0);
  }

  // ============================================================ assertion 3
  // ball tool -> clasped ball visible in hand. Put the player at a park-edge
  // interior spot in walk mode, select the ball tool, verify the held prop.
  const PX = 348, PZ = 2716, PFACE = 0.9; // facing ~SE, into the run
  await teleport(c, PX, PZ, PFACE);
  await ev(c, `window.__sf.setTool('ball')`);
  await settle(c, 6);
  const held = await ev(c, `window.__fp.heldBall()`);
  push("ball-clasped-in-hand",
    !!held.found && held.visible && held.distToHand < 0.4 && held.aboveGround > 0.8,
    held.found ? `prop visible=${held.visible}, ${held.distToHand?.toFixed(3)} m from hand, ${held.aboveGround?.toFixed(2)} m above ground` : "held ball prop not found in walk rig");

  // clasped-ball close-up screenshot: eye just behind/above the player's head,
  // looking down-forward at the hand.
  {
    const hand = held.hand ?? { x: PX, y: 1.2, z: PZ };
    const eye = await ev(c, `(()=>{const m=window.__sf.map;const gy=m.groundHeight(${PX},${PZ});
      const dx=Math.sin(${PFACE}),dz=Math.cos(${PFACE});
      const eye=[${PX}-dx*1.3, gy+1.75, ${PZ}-dz*1.3];
      window.__sfFreeCam(eye,[${hand.x}, ${hand.y}, ${hand.z}]);return eye;})()`);
    try { await settleCamera(c, eye); shots.push(await shoot(c, "clasped_ball_closeup")); }
    catch (e) { console.log("[shot-fail] clasped_ball_closeup", String(e).slice(0, 120)); }
  }

  // ============================================================ assertion 4+5+6
  // Re-pin the overview camera near the park for the fetch loop + chase shot.
  const eyeF = await freeCam(c, 372, 2704, 1.2, 30, 16);
  await waitWorldLive(c, "fetch-cam");
  await settleCamera(c, eyeF);

  // helper: throw from the player spot into the interior and run to take-ready
  const throwAndReturn = async (label) => {
    await teleport(c, PX, PZ, PFACE);
    await settle(c, 2);
    await ev(c, `window.__fp.clickBall(${PX}, ${PZ}, 388, 2696, 0.28)`);
    // run in bounded chunks so a warmup freeze can be waited out
    let all = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await ev(c, `window.__fp.run(${DT}, 260, 'takeReady')`);
      all = all.concat(r.samples);
      if (r.frozen) { await waitWorldLive(c, `${label} frozen`); continue; }
      if (r.hit) return { samples: all, tookReady: true };
      if (r.samples.length < 260) break;
    }
    return { samples: all, tookReady: false };
  };

  // ---- cycle 1
  const cyc1 = await throwAndReturn("cycle1");
  writeFileSync(path.join(OUT, "cycle1.json"), JSON.stringify(cyc1.samples));

  // analyse cycle 1 for chase + carry + arc
  const analyseFetch = (samples) => {
    let airRun = 0, maxAir = 0;
    let chaseFrames = 0, minDogBall = Infinity, maxDogBall = 0;
    let carryFrames = 0;   // ball riding a dog's mouth
    let firstDogBall = null, lastDogBall = null;
    let landed = false, launchPos = null, maxHoriz = 0;
    for (let t = 0; t < samples.length; t++) {
      const s = samples[t];
      if (!s.ball || !s.ball.vis) continue;
      if (launchPos === null) launchPos = { x: s.ball.x, z: s.ball.z };
      maxHoriz = Math.max(maxHoriz, Math.hypot(s.ball.x - launchPos.x, s.ball.z - launchPos.z));
      const h = s.ball.y - s.groundAtBall;
      airRun = h > 0.5 ? airRun + 1 : 0; maxAir = Math.max(maxAir, airRun);
      if (h < 0.4) landed = true;
      const dog = s.dogs.find((d) => d.controller === "player");
      if (dog) {
        const dd = Math.hypot(s.ball.x - dog.x, s.ball.z - dog.z);
        if (firstDogBall === null) firstDogBall = dd;
        lastDogBall = dd;
        minDogBall = Math.min(minDogBall, dd);
        maxDogBall = Math.max(maxDogBall, dd);
        chaseFrames++;
        // carry: ball glued to the dog's mouth carry point
        const dm = Math.hypot(s.ball.x - dog.mouthX, s.ball.y - dog.mouthY, s.ball.z - dog.mouthZ);
        if (dm < 0.35) carryFrames++;
      }
    }
    return { maxAir, chaseFrames, minDogBall, maxDogBall, carryFrames, firstDogBall, lastDogBall, landed, maxHoriz };
  };
  const a1 = analyseFetch(cyc1.samples);
  console.log("[probe] cycle1 analysis:", JSON.stringify(a1));
  push("throw-arc-chase-carry",
    a1.maxAir >= 4 && a1.landed && a1.maxHoriz > 3 && a1.chaseFrames > 10 &&
      a1.minDogBall < 0.6 && a1.carryFrames >= 8 && cyc1.tookReady,
    `airborne ${a1.maxAir} frames, horiz travel ${a1.maxHoriz?.toFixed(1)} m, chase ${a1.chaseFrames} frames (dog→ball ${a1.maxDogBall?.toFixed(1)}→${a1.minDogBall?.toFixed(2)} m), carry ${a1.carryFrames} frames, take-ready ${cyc1.tookReady}`);

  // assertion 5: wantsTake is true while the dog waits within reach (pickup is E)
  let takeReady = false;
  if (cyc1.tookReady) {
    takeReady = await ev(c, `window.__sf.fetchBall.wantsTake()`);
  }
  push("wants-take-while-dog-waits",
    takeReady,
    `wantsTake while dog waits in reach = ${takeReady} (expected true; pickup is E)`);

  // mid-fetch chase screenshot: drive a fresh throw and stop mid-chase
  {
    await teleport(c, PX, PZ, PFACE); await settle(c, 2);
    await ev(c, `window.__fp.clickBall(${PX}, ${PZ}, 388, 2696, 0.28)`);
    const r = await ev(c, `window.__fp.run(${DT}, 200, 'midChase')`);
    const eyeC = await freeCam(c, 372, 2704, 1.2, 26, 15);
    try { await settleCamera(c, eyeC); shots.push(await shoot(c, "mid_fetch_chase")); }
    catch (e) { console.log("[shot-fail] mid_fetch_chase", String(e).slice(0, 120)); }
    // let this stray throw resolve back to take-ready so state is clean
    for (let a = 0; a < 6; a++) { const rr = await ev(c, `window.__fp.run(${DT}, 260, 'takeReady')`); if (rr.frozen) { await waitWorldLive(c, "midchase drain"); continue; } if (rr.hit || rr.samples.length < 260) break; }
    // take it back with E (this counts as a fetch on whichever dog is claimed)
    const wt = await ev(c, `window.__sf.fetchBall.wantsTake()`);
    if (wt) { await ev(c, `window.__fp.pickupBall()`); await settle(c, 3); }
  }

  // Take cycle 1's ball back if still waiting (idempotent guard)
  {
    const wt = await ev(c, `window.__sf.fetchBall.wantsTake()`);
    if (wt) { await ev(c, `window.__fp.pickupBall()`); await settle(c, 3); }
  }
  const fetchCountAfter1 = await ev(c, `(()=>{const ds=window.__sf.coronaHeights.dogs;return Math.max(...ds.map(d=>d.playerFetchCount));})()`);
  console.log(`[probe] max playerFetchCount after cycle 1 takes: ${fetchCountAfter1}`);

  // ---- keep throwing/taking until an adoption fires (controller 'pet' appears)
  let adopted = false, adoptDetail = "", petIndex = -1;
  for (let cyc = 0; cyc < 4 && !adopted; cyc++) {
    const r = await throwAndReturn(`cycle${cyc + 2}`);
    if (r.tookReady) { await ev(c, `window.__fp.pickupBall()`); await settle(c, 3); }
    const petInfo = await ev(c, `(()=>{const ds=window.__sf.coronaHeights.dogs;const i=ds.findIndex(d=>d.controller==='pet');return {i, counts: ds.map(d=>d.playerFetchCount)};})()`);
    console.log(`[probe] after extra cycle ${cyc + 1}: pet index ${petInfo.i}, counts [${petInfo.counts.join(",")}]`);
    if (petInfo.i >= 0) { adopted = true; petIndex = petInfo.i; adoptDetail = `dog[${petInfo.i}] controller=pet, fetch counts [${petInfo.counts.join(",")}]`; }
  }
  push("adoption-after-two-fetches", adopted, adopted ? adoptDetail : "no dog ever reached controller 'pet' after repeated fetch cycles");

  // ============================================================ assertion 6 (pet-follow)
  // Move the player + camera 400+ m from the summit (past ACTIVITY_RANGE=420 so
  // the park gate shuts) and prove the pet keeps following + animating.
  let petFollow = { ok: false, detail: "adoption never happened" };
  if (adopted) {
    const FAR_X = 408, FAR_Z = 2320; // camera eye lands ~452 m from summit (past 420)
    // Pin the camera FAR first so the park's activity gate genuinely shuts, then
    // WALK the player east in short hops so the pet has to trot (legs swing).
    await teleport(c, FAR_X, FAR_Z, 0.0);
    const eyeP = await freeCam(c, FAR_X, FAR_Z, 0.0, 12, 6);
    await waitWorldLive(c, "pet-far");
    await settleCamera(c, eyeP);
    let legVals = [], maxDist = 0, gateEverOpen = false, snapDist = 0;
    for (let step = 1; step <= 8; step++) {
      await teleport(c, FAR_X + step * 3.5, FAR_Z, 0.0); // step east ~3.5 m
      let r;
      for (let a = 0; a < 6; a++) { r = await ev(c, `window.__fp.run(${DT}, 22, null)`); if (r.frozen) { await waitWorldLive(c, "pet-walk"); continue; } break; }
      for (const s of r.samples) {
        const pet = s.dogs[petIndex];
        const d = Math.hypot(pet.x - s.player.x, pet.z - s.player.z);
        maxDist = Math.max(maxDist, d);
        legVals.push(pet.leg0);
        if (s.activityVis) gateEverOpen = true;
      }
    }
    const legRange = Math.max(...legVals) - Math.min(...legVals);
    const lastDist = await ev(c, `(()=>{const s=window.__fp.snap();const pet=s.dogs[${petIndex}];return Math.hypot(pet.x-s.player.x, pet.z-s.player.z);})()`);
    const activityVis = await ev(c, `window.__sf.coronaHeights.activity.visible`);
    const petCtrl = await ev(c, `window.__sf.coronaHeights.dogs[${petIndex}].controller`);
    snapDist = lastDist;
    petFollow = {
      ok: snapDist < 12 && legRange > 0.05 && !activityVis && !gateEverOpen && petCtrl === "pet",
      detail: `pet(controller=${petCtrl}) dist now ${snapDist.toFixed(2)} m (max during walk ${maxDist.toFixed(1)}), leg-anim range ${legRange.toFixed(3)} rad, park activity gate shut throughout: ${!activityVis && !gateEverOpen}`
    };
    // re-pin camera on the player's final spot so the pet is in frame
    try {
      const px = FAR_X + 8 * 3.5;
      const eyeS = await freeCam(c, px, FAR_Z, 0.0, 11, 5);
      await settleCamera(c, eyeS);
      shots.push(await shoot(c, "pet_following"));
    } catch (e) { console.log("[shot-fail] pet_following", String(e).slice(0, 120)); }
  }
  push("pet-follows-past-gate", petFollow.ok, petFollow.detail);

  // ============================================================ assertion 7 (owner handoff)
  // Re-pin the camera at the park and run the park's OWN ball delivery until the
  // owner's mitt clasps the returned ball; sample ball-vs-hand while clasped.
  await teleport(c, 368, 2703, 2.3);
  await settle(c, 8);
  const eyeH = await freeCam(c, 360, 2700, 2.2, 12, 4);
  await waitWorldLive(c, "handoff");
  await settleCamera(c, eyeH);
  let handoff = { ok: false, detail: "owner never reached the clasp handoff" };
  let handoffShot = false;
  {
    let minBallHand = Infinity, atShoulder = Infinity, sawReceive = false, bestSnap = null;
    for (let a = 0; a < 40 && !sawReceive; a++) {
      const r = await ev(c, `window.__fp.run(${DT}, 120, 'ownerReceive')`);
      if (r.frozen) { await waitWorldLive(c, "handoff frozen"); continue; }
      if (r.hit) sawReceive = true;
    }
    // now sample the clasp window frame-by-frame
    for (let i = 0; i < 60; i++) {
      await tick(c, DT);
      const h = await ev(c, `window.__fp.ownerHandoff()`);
      if (h.clasp > 0.5) {
        const dHand = Math.hypot(h.ball.x - h.hand.x, h.ball.y - h.hand.y, h.ball.z - h.hand.z);
        const dSh = Math.hypot(h.ball.x - h.shoulder.x, h.ball.y - h.shoulder.y, h.ball.z - h.shoulder.z);
        if (dHand < minBallHand) { minBallHand = dHand; bestSnap = { ...h, dHand, dSh }; }
        atShoulder = Math.min(atShoulder, dSh);
        if (h.reach > 0.4 && !handoffShot) {
          try { const eyeS = await freeCam(c, 360, 2700, 2.2, 9, 3.4); await settleCamera(c, eyeS); shots.push(await shoot(c, "handoff_clasp")); handoffShot = true; } catch {}
        }
      }
    }
    const nearerHand = bestSnap ? bestSnap.dHand < bestSnap.dSh : false;
    handoff = {
      ok: minBallHand < 0.35 && nearerHand,
      detail: bestSnap
        ? `min ball→hand ${minBallHand.toFixed(3)} m while clasped (ball→shoulder ${bestSnap.dSh.toFixed(2)} m; hand-nearer=${nearerHand})`
        : "clasp>0.5 never observed"
    };
  }
  if (!handoffShot) { try { shots.push(await shoot(c, "handoff_clasp")); } catch {} }
  push("handoff-into-hand", handoff.ok, handoff.detail);

  // ============================================================ assertion 8 (dog speed)
  const speedStats = await ev(c, `(()=>{const ch=window.__sf.coronaHeights;
    const rows=ch.dogs.map(d=>({scale:d.style.scale, sprint:ch.dogSprintSpeed(d), name:d.style.name}));
    return rows;})()`);
  const sprints = speedStats.map((r) => r.sprint);
  const maxSprint = Math.max(...sprints), minSprint = Math.min(...sprints);
  const scaleSorted = [...speedStats].sort((a, b) => a.scale - b.scale);
  const monotone = scaleSorted.every((r, i, arr) => i === 0 || r.sprint >= arr[i - 1].sprint - 1e-6);
  const smallest = scaleSorted[0], largest = scaleSorted[scaleSorted.length - 1];
  // also confirm real chased speed sat in-band (from cycle1 samples)
  let observedMax = 0;
  for (const s of cyc1.samples) for (const d of s.dogs) if (d.controller === "player") observedMax = Math.max(observedMax, d.speed);
  push("dog-speed-band-and-small-slower",
    maxSprint >= 4 && maxSprint <= 8.5 && monotone && smallest.sprint < largest.sprint && observedMax <= 8.5,
    `sprint band ${minSprint.toFixed(2)}–${maxSprint.toFixed(2)} m/s; smallest(scale ${smallest.scale}) ${smallest.sprint.toFixed(2)} < largest(scale ${largest.scale}) ${largest.sprint.toFixed(2)}; monotone-by-scale=${monotone}; observed chase max ${observedMax.toFixed(2)}`);

  // ============================================================ assertion 9
  push("no-console-errors", pageErrors.length === 0, pageErrors.length === 0 ? "clean run" : `${pageErrors.length} error(s): ${pageErrors.slice(0, 4).join(" | ").slice(0, 500)}`);

  writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, shots }, null, 2));
  console.log(`[probe] results + screenshots in ${OUT}`);
  cleanup();
  const failed = results.filter((r) => !r.pass);
  if (failed.length) { console.error(`[probe] FAIL — ${failed.length} assertion(s): ${failed.map((f) => f.name).join(", ")}`); process.exit(1); }
  console.log("[probe] PASS — all assertions green");
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[probe] FAIL", e); process.exit(1); });
