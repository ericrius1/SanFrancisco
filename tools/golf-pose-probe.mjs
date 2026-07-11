// Golf pose/screenshot probe: boots headless, starts a round on hole 1, drives
// a full charge → release swing under the manual clock, and screenshots the
// golfer at address / backswing / impact / finish from golf-TV angles so the
// stance, grip and club can be iterated visually.
//
//   node tools/golf-pose-probe.mjs
// Env: SF_PROBE_OUT (default .data/golf-pose-probe), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/golf-pose-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5197";
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  close() { try { this.#ws.close(); } catch {} }
}
let ownedDev = null, chromeProc = null, activeCdp = null;
function cleanup() {
  try { activeCdp?.close(); } catch {}
  try { chromeProc?.kill(); } catch {}
  try { ownedDev?.kill(); } catch {}
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function ticks(c, n, dt) { for (let i = 0; i < n; i++) await tick(c, dt); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(50); } }

/** measure club head / hands / feet vs ball — the numeric truth for tuning. */
async function measure(c, tag) {
  const m = await ev(c, `(()=>{
    const s = window.__sf, T = s.THREE;
    const walk = s.player.meshes.walk;
    const find = (n) => { let f=null; walk.traverse(o=>{ if(o.name===n) f=o; }); return f; };
    const wp = (o) => { const v=new T.Vector3(); o.getWorldPosition(v); return [v.x,v.y,v.z]; };
    const b = window.__golfBall.pos;
    const head = find("club-head"), grip = find("club-grip"), hl = find("hand-L"), hr = find("hand-R"), footL = find("hand-L");
    const foot = (()=>{ let f=null; walk.traverse(o=>{ if(o.isMesh && o.material===s.player && false) f=o; }); return f; })();
    const rel = (p) => p ? [Math.round((p[0]-b.x)*100)/100, Math.round((p[1]-b.y)*100)/100, Math.round((p[2]-b.z)*100)/100] : null;
    const rp = s.player.renderPosition;
    return {
      ballY: Math.round(b.y*100)/100,
      renderY: Math.round(rp.y*100)/100,
      meshY: Math.round(walk.position.y*100)/100,
      phase: s.player.mode,
      headRelBall: head ? rel(wp(head)) : null,   // want ~[0,0,0] at address
      gripRelBall: grip ? rel(wp(grip)) : null,
      handGap: (hl&&hr) ? Math.round(Math.hypot(...wp(hl).map((v,i)=>v-wp(hr)[i]))*100)/100 : null, // want small
      handY: hl ? Math.round((wp(hl)[1]-b.y)*100)/100 : null
    };
  })()`);
  console.log(`[measure ${tag}]`, JSON.stringify(m));
  return m;
}

/** camera on the golfer: angles are golf-TV names. */
async function view(c, name) {
  await ev(c, `(()=>{
    const s = window.__sf, T = s.THREE;
    const b = window.__golfBall.pos;
    const a = s.chase.yaw + Math.PI; // aim yaw
    const sh = new T.Vector3(Math.sin(a), 0, Math.cos(a)); // shot dir
    const toes = new T.Vector3(-Math.cos(a), 0, Math.sin(a)); // golfer → ball
    const focus = new T.Vector3(b.x, b.y + 0.75, b.z).addScaledVector(toes, -0.5);
    let eye;
    let look = focus.clone();
    if ("${name}".startsWith("faceon")) eye = focus.clone().addScaledVector(toes, 3.4).add(new T.Vector3(0, 0.7, 0));
    else if ("${name}".startsWith("dtl")) eye = focus.clone().addScaledVector(sh, -3.8).add(new T.Vector3(0, 0.9, 0));
    else if ("${name}".startsWith("over")) {
      const p = window.__sf.player.renderPosition;
      look = new T.Vector3(p.x, p.y + 3.3, p.z);
      eye = look.clone().add(new T.Vector3(0.4, 7, 0.4)); // straight-ish down onto the floating arrow
    } else if ("${name}".startsWith("wide")) {
      // pulled back + up behind the golfer: shows the floating arrow + tee beam
      const p = window.__sf.player.renderPosition;
      look = new T.Vector3(p.x, p.y + 3.2, p.z);
      eye = look.clone().addScaledVector(toes, 10).addScaledVector(sh, -2.5).add(new T.Vector3(0, 3.6, 0));
    } else eye = focus.clone().addScaledVector(toes, 2.8).addScaledVector(sh, -2.4).add(new T.Vector3(0, 0.8, 0));
    window.__sfFreeCam([eye.x, eye.y, eye.z], [look.x, look.y, look.z]);
    return true;
  })()`);
  await tick(c, 0);
  const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
  writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(shot.data, "base64"));
  console.log(`[probe] shot ${name}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDevIfNeeded();
  const golf = await (await fetch(`${SERVER_URL}/data/golf.json`)).json();
  const h1 = golf.holes.find((h) => h.ref === 1) ?? golf.holes[0];

  const chrome = await findChrome();
  const port = await freePort();
  chromeProc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
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
      pageErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300));
      console.log("[page-exception]", pageErrors[pageErrors.length - 1]);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const msg = m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300);
      pageErrors.push(msg);
      console.log("[page-error]", msg);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for golf...");
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    try { if (await ev(c, "!!(window.__sf && window.__sf.golf && window.__golfBall)")) break; } catch {}
    await sleep(600);
  }
  if (!(await ev(c, "!!(window.__sf && window.__sf.golf)"))) throw new Error("golf never ready");
  await ev(c, "window.__sfManual && window.__sfManual(true)");
  await ev(c, "(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(14);return true;})()");

  // onto the tee, walking; settle tiles/ground
  await ev(c, `(()=>{const s=window.__sf;const y=s.map.effectiveGround(${h1.teeXZ[0]},${h1.teeXZ[1]})+1.2;s.player.teleportTo({x:${h1.teeXZ[0]},y,z:${h1.teeXZ[1]},facing:0,mode:"walk"});return true;})()`);
  await settle(c, 25);
  await ev(c, `(()=>{Object.defineProperty(document,"hasFocus",{value:()=>true});window.__sf.input.locked=true;return true;})()`);

  const started = await ev(c, "window.__sf.golf.tryStartAtTee(window.__sf.player, window.__sf.hud)");
  if (!started) throw new Error("could not start round at tee");
  // let the teleported capsule finish falling AND the aim/address stance ease in
  await ticks(c, 150, 1 / 60);
  await measure(c, "settled-address");
  const parkedRoundBags = await ev(c, `(()=>{
    const cart = window.__sf.scene.getObjectByName('golf-cart-parked');
    if (!cart?.visible) return 0;
    let bags = 0;
    cart.traverse(o => { if (o.visible && o.name?.startsWith('golfbag')) bags++; });
    return bags;
  })()`);
  if (parkedRoundBags < 1) throw new Error("active golfer's parked cart lost its bag");
  console.log("[cart-bags] parked during round:", parkedRoundBags);

  // SWEEP (one boot): hold FULL BACKSWING (charge saturated → s≈-1), sweep the
  // club raise + side-arc, read where the head lands vs the ball. A good top of
  // backswing has the head HIGH above the ball (y large) and behind (z > 0).
  if (process.env.SF_SWEEP) {
    await ev(c, "(window.__sf.input.fireHeld = true, true)"); // start charging → backswing
    await ticks(c, 80, 1 / 60); // saturate charge (1.15s) → s≈-1
    for (const raise of [0.7, 1.15, 1.6]) {
      for (const swingZ of [1.5, 2.0, 2.5]) {
        await ev(c, `(window.__golfTune = { raise: ${raise}, swingZ: ${swingZ} }, true)`);
        await ticks(c, 6, 1 / 60);
        await measure(c, `top raise=${raise} z=${swingZ}`);
      }
    }
    await ev(c, "(window.__sf.input.fireHeld = false, delete window.__golfTune, true)");
    await ticks(c, 60, 1 / 60);
  }

  // wide shot in AIM (before charging): shows the floating next-hole arrow
  // (aims at the pin) + the active tee's boosted glow/beam from gameplay range
  const gstate = await ev(c, `(()=>{
    const s=window.__sf; let g=null; s.scene.traverse(o=>{ if(o.name==='golf-guide') g=o; });
    if(!g) return { found:false };
    const wp=new s.THREE.Vector3(); g.getWorldPosition(wp);
    const p=s.player.renderPosition;
    let arrowVis=null, spinChildren=null;
    g.traverse(o=>{ if(o.isMesh){ arrowVis = o.visible; } });
    return { found:true, groupVisible:g.visible, scale:Math.round(g.scale.x*100)/100,
      pos:[wp.x,wp.y,wp.z].map(n=>Math.round(n*10)/10),
      player:[p.x,p.y,p.z].map(n=>Math.round(n*10)/10),
      children:g.children.length, arrowMeshVisible:arrowVis, mode:s.player.mode };
  })()`);
  console.log("[guide]", JSON.stringify(gstate));
  await view(c, "wide_aim");
  // Isolate the active tee beacon from a stable exterior angle so its blue
  // web structure remains easy to compare across shader/tone-map changes.
  await ev(c, `(()=>{
    const s=window.__sf, b=window.__golfBall.pos;
    window.__sfFreeCam([b.x+12,b.y+7,b.z+12],[b.x,b.y+4,b.z]);
    return true;
  })()`);
  await tick(c, 0);
  {
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
    writeFileSync(path.join(OUT, "beacon_web.jpg"), Buffer.from(shot.data, "base64"));
    console.log("[probe] shot beacon_web");
  }

  // --- cart boarding: teleport onto the parked cart, press E, confirm we drive it
  const board = await ev(c, `(()=>{
    const s = window.__sf, g = window.__golfGame;
    const cp = g.parkedCartPosition;
    if (!cp) return { err: "no parked cart" };
    const y = s.map.effectiveGround(cp.x, cp.z) + 1.2;
    s.player.teleportTo({ x: cp.x + 1, y, z: cp.z, facing: 0, mode: "walk" });
    return { cartPos: [cp.x, cp.z].map(n => Math.round(n*10)/10) };
  })()`);
  console.log("[cart-board] pre:", JSON.stringify(board));
  await ticks(c, 90, 1 / 60); // settle onto the ground next to the cart
  const boarded = await ev(c, `(()=>{
    const s = window.__sf, g = window.__golfGame;
    const ok = g.tryStartAtTee(s.player, s.hud);
    return { consumed: ok, mode: s.player.mode };
  })()`);
  await ticks(c, 20, 1 / 60);
  const drive = await ev(c, `(()=>{
    const s = window.__sf;
    // find the golf-bag props under the active drive mesh (0/1/2 visible)
    let bags = 0; s.player.meshes.drive.traverse(o => { if (o.name && o.name.startsWith('golfbag') && o.visible) bags++; });
    return { mode: s.player.mode, bagsVisible: bags };
  })()`);
  console.log("[cart-board] post:", JSON.stringify(boarded), "drive:", JSON.stringify(drive));
  // frame the golfer sitting in the cart
  await ev(c, `(()=>{
    const s = window.__sf, p = s.player.renderPosition, T = s.THREE;
    window.__sfFreeCam([p.x + 5, p.y + 3, p.z - 4.5], [p.x, p.y + 0.5, p.z]);
    return true;
  })()`);
  await tick(c, 0);
  {
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
    writeFileSync(path.join(OUT, "cart_boarded.jpg"), Buffer.from(shot.data, "base64"));
    console.log("[probe] shot cart_boarded");
  }
  // passenger joins → second bag; then hop off → cart re-parks
  const twoBags = await ev(c, `(()=>{
    window.__golfGame.setCartOccupants(2);
    let bags = 0; window.__sf.player.meshes.drive.traverse(o => { if (o.name && o.name.startsWith('golfbag') && o.visible) bags++; });
    return bags;
  })()`);
  await ev(c, `(window.__sf.player.trySwitch('walk'), true)`);
  await ticks(c, 30, 1 / 60);
  const reparked = await ev(c, `(()=>{
    const s=window.__sf, g=window.__golfGame, cart=s.scene.getObjectByName('golf-cart-parked');
    let bags=0;
    cart?.traverse(o=>{ if(o.visible && o.name?.startsWith('golfbag')) bags++; });
    return { mode:s.player.mode, cartParked:!!g.parkedCartPosition && !!cart?.visible, bagsVisible:bags };
  })()`);
  if (!reparked.cartParked || reparked.bagsVisible < 1) throw new Error("cart or bag disappeared after golfer exited");
  console.log("[cart-board] twoBags:", twoBags, "afterExit:", JSON.stringify(reparked));
  await ev(c, `(()=>{
    const s=window.__sf, cart=s.scene.getObjectByName('golf-cart-parked'), p=new s.THREE.Vector3();
    cart.getWorldPosition(p);
    window.__sfFreeCam([p.x+5,p.y+3,p.z-4.5],[p.x,p.y+0.6,p.z]);
    return true;
  })()`);
  await tick(c, 0);
  {
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
    writeFileSync(path.join(OUT, "cart_reparked.jpg"), Buffer.from(shot.data, "base64"));
    console.log("[probe] shot cart_reparked");
  }

  // --- teleport-leaves-golf: a big jump must end the round + hide the guide
  const activeBefore = await ev(c, "window.__golfGame.active");
  await ev(c, `(()=>{ const s=window.__sf; s.player.teleportTo({ x: 0, y: s.map.effectiveGround(0,0)+1.5, z: 0, facing: 0, mode: "walk" }); return true; })()`);
  await ticks(c, 12, 1 / 60);
  const afterLeave = await ev(c, `(()=>{
    const s=window.__sf, g=window.__golfGame;
    let guideVis=false; s.scene.traverse(o=>{ if(o.name==='golf-guide') guideVis=o.visible; });
    return { active: g.active, guideVisible: guideVis };
  })()`);
  console.log("[leave-golf] activeBefore:", activeBefore, "after:", JSON.stringify(afterLeave));

  // --- golf cart hero shots: spawn one beside the tee, frame it 3/4 front + rear
  const cart = await ev(c, `(()=>{
    const t = ${JSON.stringify(h1.teeXZ)};
    const m = window.__spawnGolfCart(t[0] + 5, t[1] + 3, 2);
    window.__cart = m;
    return { x: m.position.x, y: Math.round(m.position.y*100)/100, z: m.position.z };
  })()`);
  console.log("[cart]", JSON.stringify(cart));
  for (const [tag, ex, ey, ez] of [["cart_front34", 4.5, 2.6, -4.5], ["cart_rear34", -3.8, 2.4, 4.8], ["cart_side", 6.2, 1.8, 0.5]]) {
    await ev(c, `(()=>{
      const m = window.__cart, T = window.__sf.THREE;
      const c = m.position;
      window.__sfFreeCam([c.x + ${ex}, c.y + ${ey}, c.z + ${ez}], [c.x, c.y + 0.4, c.z]);
      return true;
    })()`);
    await tick(c, 0);
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
    writeFileSync(path.join(OUT, `${tag}.jpg`), Buffer.from(shot.data, "base64"));
    console.log(`[probe] shot ${tag}`);
  }

  // --- address (tiny charge so the pose is live at s≈0)
  await ev(c, "(window.__sf.input.fireHeld = true, true)");
  await ticks(c, 4, 1 / 60);
  await measure(c, "address");
  await view(c, "faceon_address");
  await view(c, "dtl_address");
  await view(c, "front34_address");

  // --- half backswing
  await ticks(c, 33, 1 / 60);
  await view(c, "faceon_back_half");

  // --- full backswing (charge saturates at 1.15s)
  await ticks(c, 45, 1 / 60);
  await measure(c, "backswing");
  await view(c, "faceon_back_full");
  await view(c, "dtl_back_full");
  await view(c, "front34_back_full");

  // --- release: downswing → impact → finish
  await ev(c, "(window.__sf.input.fireHeld = false, true)");
  await ticks(c, 3, 1 / 60);
  await view(c, "faceon_downswing");
  await ticks(c, 4, 1 / 60);
  await view(c, "faceon_impact");
  await ticks(c, 12, 1 / 60);
  await view(c, "faceon_follow");
  await view(c, "front34_follow");
  await ticks(c, 20, 1 / 60);
  await view(c, "faceon_finish");
  await view(c, "dtl_finish");

  // ball must actually be away
  const ball = await ev(c, "(()=>{const b=window.__golfBall;return {ph:b.phase,p:[b.pos.x,b.pos.y,b.pos.z].map(n=>Math.round(n*10)/10)};})()");
  console.log("[probe] ball after swing:", JSON.stringify(ball));
  console.log(`[probe] page errors: ${pageErrors.length}`);
  cleanup();
  if (pageErrors.some((e) => /golf|NaN|non-finite/i.test(e))) process.exit(1);
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[probe] FAIL", e); process.exit(1); });
