// Headless verification probe for the pickleball overhaul (shared-avatar
// athletes + ambient NPC matches + HUD + court audio). Boots the app in
// headless Chrome (WebGPU via ANGLE-metal), teleports to the Goldman mini
// courts, builds the PickleballAmbient cluster in-page (main.ts wiring is a
// separate integration step), then:
//   A. drives ~14 simulated seconds and asserts: the networked 14B match
//      rallies (paddle contacts + ball motion), ambient courts rally, a
//      takeover interaction is reachable, night empties the courts, the
//      audio layer constructs + handles events without throwing, and the
//      HUD scoreboard/banner DOM mounts.
//   B. screenshots: ambient courts mid-rally, an athlete paddle-grip closeup,
//      a mid-swing frame (probe-driven seat), and the HUD scoreboard+banner.
// Any page exception or console.error fails the probe.
//
//   node tools/pickleball-probe.mjs
// Env:
//   SF_PROBE_OUT  out dir (default .data/pickleball-probe)
//   SF_PROBE_URL  existing vite (default http://127.0.0.1:5221)
//   SF_TIME       time of day hours (default 13.5)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/pickleball-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5221";
const RELAY_PORT = Number(process.env.SF_RELAY_PORT ?? 8791);
const TIME = Number(process.env.SF_TIME ?? 13.5);
const W = 1280, H = 720;
const DT = 1 / 30;
const COURTS = { x: -1330, z: 2140 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const vitePort = Number(new URL(SERVER_URL).port);
  console.log(`[probe] starting Vite at ${SERVER_URL} (relay ${RELAY_PORT})`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(RELAY_PORT) }, stdio: ["ignore", "ignore", "ignore"]
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
let ownedDev = null, chromeProc = null, activeCdp = null;
function cleanup() {
  try { activeCdp?.close(); } catch {}
  try { chromeProc?.kill(); } catch {}
  try { ownedDev?.kill(); } catch {}
  activeCdp = chromeProc = ownedDev = null;
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__pbFrame(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(50); } }
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}
async function freeCamAt(c, ex, ey, ez, tx, ty, tz) {
  await ev(c, `window.__sfFreeCam([${ex},${ey},${ez}],[${tx},${ty},${tz}])`);
  for (let i = 0; i < 160; i++) {
    await tick(c, 0);
    const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`);
    if (Math.hypot(p[0] - ex, p[1] - ey, p[2] - ez) < 0.05) return;
    await sleep(40);
  }
  throw new Error("free camera never acquired the pose");
}
async function shoot(c, name, shots) {
  const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
  const file = path.join(OUT, `${name}.jpg`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  shots.push(file);
  console.log(`[probe] shot ${name}`);
  return file;
}

/** Heartbeat past the deferred pipeline.warmup freeze: the 14B match is awake
 *  here, so its phase timer (serveDelay/pointDelay) or ball position must move
 *  when a tick actually runs the sim. */
async function waitWorldLive(c, label) {
  for (let i = 0; i < 220; i++) {
    const live = await ev(c, `(()=>{
      const g = window.__sf.pickleball;
      const a = g.diagnostics; const t0 = a.phaseTimer, b0 = a.ballPosition.join(",");
      window.__sf.tick(${DT});
      const b = g.diagnostics;
      return g.active && (b.phaseTimer !== t0 || b.ballPosition.join(",") !== b0);
    })()`);
    if (live) { if (i > 0) console.log(`[probe] world live for ${label} after ${(i * 0.3).toFixed(1)}s`); return; }
    await sleep(300);
  }
  throw new Error(`world never went live (${label})`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  chromeProc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
    `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
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

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player&&window.__sf.pickleball)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);

  // one frame driver everywhere: app tick + probe-owned ambient cluster
  await ev(c, `(()=>{
    window.__pbT = 0;
    window.__pbSeatInput = null;
    window.__pbFrame = (dt)=>{
      window.__sf.tick(dt);
      const amb = window.__pbAmbient;
      if (amb && dt > 0) {
        window.__pbT += dt;
        window.__pbLastAmb = amb.update(dt, window.__pbT, window.__sf.player.position, window.__pbSeatInput ?? undefined);
      }
    };
    return true;
  })()`);

  await teleport(c, COURTS.x, COURTS.z, 0);
  await settle(c, 16);
  await waitWorldLive(c, "arrival");

  // ---- build the ambient cluster + HUD + audio in-page ---------------------
  const built = await ev(c, `(async()=>{
    const sf = window.__sf;
    const [amb, aud, ui] = await Promise.all([
      import('/src/gameplay/pickleball/ambient.ts'),
      import('/src/gameplay/pickleball/audio.ts'),
      import('/src/gameplay/pickleball/ui.ts')
    ]);
    const gt = sf.goldenGateTennis;
    const refs = ["14A","14C","14D","15"];
    const anchors = refs.map((ref)=>({ ref, anchor: gt.courtAnchors.get(ref) })).filter((a)=>a.anchor);
    const audio = new aud.PickleballAudio(sf.nature);
    const ambient = new amb.PickleballAmbient({
      anchors,
      daylight: () => sf.sky.sunElevation > 0.05,
      audio
    });
    sf.scene.add(ambient.group);
    ambient.setAwake(true);
    window.__pbAmbient = ambient;
    window.__pbAudio = audio;
    // Prefer main.ts's real integrated HUD (now wired) so the probe verifies
    // the shipped UI; fall back to a fresh instance if the app hasn't built one.
    window.__pbUi = window.__sf.pickleballUI ?? new ui.PickleballUI();
    return { courts: anchors.map((a)=>a.ref) };
  })()`);
  console.log(`[probe] ambient cluster built: ${built.courts.join(", ")}`);

  const results = [];
  const push = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} — ${detail}`); };

  // ---- part A: simulate ~14 s and sample --------------------------------
  const sim = await ev(c, `(()=>{
    const sf = window.__sf;
    const amb = window.__pbAmbient;
    const games = [...amb.group.children].map((root)=>root); // roots only for visibility
    const stats = { mainPaddle0: sf.pickleball.diagnostics.collisionCounts.paddle, ambRally: 0, interactionSeen: false, ballSeen: 0 };
    for (let i = 0; i < ${Math.round(14 / DT)}; i++) {
      window.__pbFrame(${DT});
      const f = window.__pbLastAmb;
      if (f && f.interaction) stats.interactionSeen = true;
    }
    stats.mainPaddle1 = sf.pickleball.diagnostics.collisionCounts.paddle;
    stats.mainBall = sf.pickleball.diagnostics.ballPosition;
    stats.mainPhase = sf.pickleball.diagnostics.phase;
    return stats;
  })()`);
  push("main-court-rallies", sim.mainPaddle1 > sim.mainPaddle0,
    `14B paddle contacts ${sim.mainPaddle0} → ${sim.mainPaddle1} over 14 s (phase ${sim.mainPhase})`);

  // takeover prompt: stand at an ambient athlete's baseline (interaction
  // radius is 2.35 m — the court-center teleport above is too far away)
  const interact = await ev(c, `(()=>{
    const sf = window.__sf;
    const a = sf.goldenGateTennis.courtAnchors.get("${built.courts[0]}");
    // near-side athlete idles ~7.4 m down the local -Z baseline
    const x = a.x - Math.sin(a.yaw) * 7.4, z = a.z - Math.cos(a.yaw) * 7.4;
    const y = sf.map.groundHeight(x, z);
    sf.player.teleportTo({ x, y: y + 1.5, z, facing: a.yaw, mode: 'walk' });
    for (let i = 0; i < 20; i++) window.__pbFrame(${DT});
    const f = window.__pbLastAmb;
    return f && f.interaction ? { ref: f.interaction.ref, side: f.interaction.side, prompt: f.interaction.prompt, d: f.interaction.distance } : null;
  })()`);
  push("takeover-interaction", Boolean(interact ?? sim.interactionSeen),
    interact ? `"${interact.prompt}" (${interact.ref} side ${interact.side}, ${interact.d.toFixed(2)} m)` : "no ambient interaction within reach");

  const ambStats = await ev(c, `(()=>{
    const amb = window.__pbAmbient;
    // per-court sims are private; the scene graph is the public truth —
    // count visible court roots and live balls under the ambient group
    let liveBalls = 0, visibleCourts = 0;
    amb.group.traverse((o)=>{
      if (o.name === "pickleball-ball" && o.visible) liveBalls++;
      if (o.name === "pickleball-game" && o.visible) visibleCourts++;
    });
    return { liveBalls, visibleCourts };
  })()`);
  push("ambient-courts-live", ambStats.visibleCourts >= 2, `${ambStats.visibleCourts} ambient courts visible, ${ambStats.liveBalls} balls in flight`);

  // night: courts empty; day: they come back
  const night = await ev(c, `(()=>{
    const sf = window.__sf;
    sf.sky.setTimeOfDay(23.5);
    for (let i=0;i<12;i++) window.__pbFrame(${DT});
    let visible = 0;
    window.__pbAmbient.group.traverse((o)=>{ if (o.name === "pickleball-game" && o.visible) visible++; });
    sf.sky.setTimeOfDay(${TIME});
    for (let i=0;i<12;i++) window.__pbFrame(${DT});
    let back = 0;
    window.__pbAmbient.group.traverse((o)=>{ if (o.name === "pickleball-game" && o.visible) back++; });
    return { visible, back };
  })()`);
  push("night-empties-courts", night.visible === 0 && night.back >= 2, `night visible=${night.visible}, day restored=${night.back}`);

  // audio path: resume ctx (headless autoplay allowed) and pump events
  const audio = await ev(c, `(async()=>{
    const sf = window.__sf;
    const io = sf.nature.voiceBus();
    if (io && io.ctx.state !== "running") { try { await io.ctx.resume(); } catch {} }
    const THREE = sf.THREE;
    const at = new THREE.Vector3(${COURTS.x}, sf.map.groundHeight(${COURTS.x},${COURTS.z}) + 1, ${COURTS.z});
    let threw = null;
    try {
      window.__pbAudio.handle({ kind: "serve", server: 0 }, at);
      window.__pbAudio.handle({ kind: "paddle", side: 0, rallyHits: 1, worldPosition: at }, at);
      window.__pbAudio.handle({ kind: "bounce", side: 1, inCourt: true, worldPosition: at }, at);
      window.__pbAudio.handle({ kind: "net", worldPosition: at }, at);
      window.__pbAudio.handle({ kind: "point", winner: 0, loser: 1, scoringSide: 0, reason: "out", score: [10, 4] }, at);
      window.__pbAudio.handle({ kind: "game", winner: 0, score: [11, 4] }, at);
    } catch (e) { threw = String(e); }
    return { state: io ? io.ctx.state : "no-ctx", threw };
  })()`);
  push("audio-no-throw", audio.threw === null, `ctx=${audio.state}${audio.threw ? ` threw: ${audio.threw}` : " — all six one-shots dispatched"}`);

  // HUD DOM
  const hud = await ev(c, `(()=>{
    const ui = window.__pbUi;
    ui.setVisible(true);
    ui.setScore([7, 5], 0, 9);
    ui.setSeated(true, false);
    ui.banner("gamepoint", "GAME POINT");
    const card = document.querySelector('#hud .pb-card');
    const banner = document.querySelector('#hud .pb-banner');
    const hints = document.querySelector('#hud .pb-hints');
    return {
      card: !!card && card.classList.contains('show'),
      score: card ? card.textContent : "",
      banner: !!banner && banner.classList.contains('pop') && banner.textContent,
      hints: !!hints && hints.classList.contains('show')
    };
  })()`);
  push("hud-mounts", Boolean(hud.card && hud.banner && hud.hints), `card="${hud.score}" banner="${hud.banner}" hints=${hud.hints}`);

  // ---- part B: screenshots ------------------------------------------------
  const shots = [];

  // (d) HUD scoreboard + banner while it's popped. body:not(.started) hides
  // #hud entirely (start-gate rule) — force the started class for the capture.
  await ev(c, `(()=>{document.body.classList.add("started");window.__pbUi.banner("gamepoint", "GAME POINT");return true;})()`);
  await tick(c, DT);
  await shoot(c, "hud_score_banner", shots);
  await ev(c, `(()=>{window.__pbUi.setSeated(false);window.__pbUi.setVisible(false);return true;})()`);

  // (a) ambient courts mid-rally: run until an ambient ball is visibly in
  // flight, then frame the mini-court cluster from a raised 3/4 view
  const rallyTick = await ev(c, `(()=>{
    for (let i = 0; i < 600; i++) {
      window.__pbFrame(${DT});
      let flying = 0;
      window.__pbAmbient.group.traverse((o)=>{ if (o.name === "pickleball-ball" && o.visible && o.position.y > 0.25) flying++; });
      if (flying >= 1 && i > 30) return i;
    }
    return -1;
  })()`);
  console.log(`[probe] ambient rally ball airborne after ${rallyTick} ticks`);
  const gy = await ev(c, `window.__sf.map.groundHeight(${COURTS.x},${COURTS.z})`);
  await teleport(c, COURTS.x - 30, COURTS.z + 55, 0.5); // park avatar out of frame
  await settle(c, 4);
  await freeCamAt(c, COURTS.x - 24, gy + 13, COURTS.z + 26, COURTS.x + 4, gy + 1, COURTS.z - 2);
  for (let i = 0; i < 4; i++) await tick(c, DT);
  await shoot(c, "ambient_courts", shots);

  // (b) paddle-grip closeup: aim the camera at an ambient athlete's actual
  // paddle-face mesh (world position), framed with the mitt — no glow-serving
  // athlete in shot (pick the SECOND court's far figure, away from 14B).
  const grip = await ev(c, `(()=>{
    const amb = window.__pbAmbient;
    const root = amb.group.children[1] ?? amb.group.children[0];
    const rigGroup = root.getObjectByName("pickleball-player-far");
    const face = rigGroup.getObjectByName("pickleball-paddle-face");
    root.updateWorldMatrix(true, true);
    const THREE = window.__sf.THREE;
    const fp = face.getWorldPosition(new THREE.Vector3());
    const ap = rigGroup.getWorldPosition(new THREE.Vector3());
    const q = new THREE.Quaternion();
    rigGroup.getWorldQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return { fx: fp.x, fy: fp.y, fz: fp.z, ax: ap.x, ay: ap.y, az: ap.z, hx: fwd.x, hz: fwd.z };
  })()`);
  {
    // stand ~1.7 m off the athlete's front-right so face, fingers and torso
    // all share the frame
    const h = Math.atan2(grip.hx, grip.hz);
    const side = h + Math.PI * 0.3;
    const ex = grip.ax + Math.sin(side) * 1.7, ez = grip.az + Math.cos(side) * 1.7;
    await freeCamAt(c, ex, grip.fy + 0.25, ez, grip.fx, grip.fy, grip.fz);
    await shoot(c, "grip_closeup", shots);
  }

  // (c) mid-swing: take an ambient seat, feed a swing, freeze mid-stroke
  const seat = await ev(c, `(()=>{
    const amb = window.__pbAmbient;
    const hit = amb.getInteraction(window.__sf.player.position) ??
      { ref: "${built.courts[0]}", side: 0 };
    const ok = amb.enterCourt(hit.ref, hit.side ?? 0, undefined);
    return { ok, ref: hit.ref, side: hit.side ?? 0 };
  })()`);
  console.log(`[probe] ambient seat: ${JSON.stringify(seat)}`);
  if (seat.ok) {
    // settle into the seat, park the camera in profile FIRST (freeCamAt ticks
    // only dt=0 frames, which the ambient driver skips — the pose holds), then
    // feed one swing press and freeze mid-stroke / at the finish
    const sp = await ev(c, `(()=>{
      window.__pbSeatInput = {};
      for (let i=0;i<8;i++) window.__pbFrame(${DT});
      const f = window.__pbLastAmb;
      const p = f && f.seat ? f.seat.frame.localPose : null;
      return p ? { x: p.worldPosition.x, y: p.worldPosition.y, z: p.worldPosition.z, h: p.worldHeading } : null;
    })()`);
    if (sp) {
      const side = sp.h + Math.PI / 2; // profile — the swing must read side-on
      const ex = sp.x + Math.sin(side) * 3.4, ez = sp.z + Math.cos(side) * 3.4;
      await freeCamAt(c, ex, sp.y + 1.35, ez, sp.x, sp.y + 1.0, sp.z);
      await ev(c, `(()=>{
        window.__pbSeatInput = { swing: true };
        window.__pbFrame(${DT});
        window.__pbSeatInput = {};
        for (let i=0;i<5;i++) window.__pbFrame(${DT}); // ~0.2 s in: drive phase
        return true;
      })()`);
      await shoot(c, "swing_profile", shots);
      await ev(c, `(()=>{ for (let i=0;i<5;i++) window.__pbFrame(${DT}); window.__pbSeatInput = null; return true; })()`);
      await shoot(c, "swing_finish", shots);
    } else {
      console.log("[probe] no seat pose — skipping swing shot");
    }
    await ev(c, `window.__pbAmbient.exitCourt()`);
  }
  push("ambient-seat", Boolean(seat.ok), `enterCourt(${seat.ref}, ${seat.side}) → ${seat.ok}`);

  push("no-console-errors", pageErrors.length === 0,
    pageErrors.length === 0 ? "clean run" : `${pageErrors.length} error(s): ${pageErrors.slice(0, 3).join(" | ").slice(0, 400)}`);

  writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, shots }, null, 2));
  cleanup();
  const failed = results.filter((r) => !r.pass).length;
  if (failed > 0) { console.error(`[probe] FAIL — ${failed} assertion(s)`); process.exit(1); }
  console.log("[probe] PASS — all assertions green");
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[probe] FAIL", e); process.exit(1); });
