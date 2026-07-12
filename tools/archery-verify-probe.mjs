// Verification probe for the archery + pickleball(visual) + clubhouse pass.
// Boots the app once in headless Chrome (WebGPU/metal), drives __sf.tick, and
// walks all three sites taking screenshots that the verifier reads.
//   node tools/archery-verify-probe.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/archery-verify");
const SERVER_URL = "http://127.0.0.1:5232";
const RELAY_PORT = 8792;
const W = 1280, H = 720, DT = 1 / 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue; return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); } throw new Error(`timeout ${label}: ${url}`); }
async function startDev() {
  try { await waitHttp(SERVER_URL, 2000, "existing"); return null; } catch {}
  console.log(`[probe] starting Vite ${SERVER_URL} (relay ${RELAY_PORT})`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5232", "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(RELAY_PORT) }, stdio: ["ignore", "ignore", "ignore"] });
  await waitHttp(SERVER_URL, 60000, "vite"); return child;
}
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) { if (this.onEvent) this.onEvent(m); return; } const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {}); });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
let ownedDev = null, chromeProc = null, activeCdp = null;
function cleanup() { try { activeCdp?.close(); } catch {} try { chromeProc?.kill(); } catch {} try { ownedDev?.kill(); } catch {} }
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`); return r.result?.value; }
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(DT)); await sleep(40); } }
async function teleport(c, x, z, facing) { await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`); }
async function freeCamAt(c, ex, ey, ez, tx, ty, tz) {
  await ev(c, `window.__sfFreeCam([${ex},${ey},${ez}],[${tx},${ty},${tz}])`);
  for (let i = 0; i < 160; i++) { await tick(c, 0); const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`); if (Math.hypot(p[0] - ex, p[1] - ey, p[2] - ez) < 0.06) return; await sleep(30); }
  console.log("[probe] warn: free camera never fully acquired");
}
async function shoot(c, name, shots) { const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true }); const file = path.join(OUT, `${name}.jpg`); writeFileSync(file, Buffer.from(shot.data, "base64")); shots.push(file); console.log(`[probe] shot ${name}`); return file; }

async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDev();
  const chrome = await findChrome();
  const port = await freePort();
  chromeProc = spawn(chrome, [`--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page;
  for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl); activeCdp = c;
  const pageErrors = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; const text = (d.exception && (d.exception.description || d.exception.value)) || d.text; pageErrors.push(`exception: ${String(text).slice(0, 300)}`); console.log("[page-exception]", String(text).slice(0, 200)); }
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") { const text = m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300); pageErrors.push(`console.error: ${text}`); console.log("[page-error]", text.slice(0, 200)); }
  };
  await c.open(); await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf + __archery...");
  const t0 = Date.now(); let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player&&window.__archery&&window.__archery.game)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf/__archery never ready");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const idleStart = Date.now();
  while (Date.now() - idleStart < 90000) {
    if (await ev(c, `window.__sf.renderIdle()`)) break;
    await sleep(300);
  }
  if (!(await ev(c, `window.__sf.renderIdle()`))) throw new Error("render warmup never became idle");
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(13.5);return true;})()`);
  await ev(c, `document.body.classList.add("started")`);

  const out = {};
  const shots = [];

  // ============================ ARCHERY ============================
  const AC = { x: -5533, z: 2079 };
  await teleport(c, AC.x - 14, AC.z, Math.PI / 2); // stand at shooting line, face downrange +X
  await settle(c, 24);
  out.archeryWake = await ev(c, `window.__archery.stats()`);
  console.log("[archery] wake stats", JSON.stringify(out.archeryWake));

  // Start through the same public E-chain entry point main.ts uses. Verify the
  // activity requests first person and that its camera-space bow survives the
  // local-avatar hide at the end of the handoff.
  out.archeryInteract = await ev(c, `(()=>{
    const g=window.__sf, a=window.__archery.game;
    const consumed=a.tryInteract(g.player,g.hud,g.chase);
    for(let i=0;i<45;i++) g.tick(${DT});
    const vm=g.camera.getObjectByName('archery-first-person-bow');
    const p=g.player.renderPosition, cam=g.camera.position;
    const look=g.camera.getWorldDirection(new g.THREE.Vector3());
    return {consumed,holding:window.__archery.stats().holding,firstPerson:g.chase.firstPersonBlend,viewModel:!!vm&&vm.visible,cameraToPlayer:cam.distanceTo(p),avatarVisible:g.player.meshes.walk.visible,downrangeDot:look.x};
  })()`);
  console.log("[archery] interaction", JSON.stringify(out.archeryInteract));
  if (!out.archeryInteract.consumed || !out.archeryInteract.holding || out.archeryInteract.firstPerson < 0.9 || !out.archeryInteract.viewModel || out.archeryInteract.cameraToPlayer > 1.5 || out.archeryInteract.avatarVisible || out.archeryInteract.downrangeDot < 0.9) {
    throw new Error(`archery first-person interaction failed: ${JSON.stringify(out.archeryInteract)}`);
  }
  await shoot(c, "archery_first_person", shots);
  await ev(c, `window.__archery.game.tryInteract(window.__sf.player,window.__sf.hud,window.__sf.chase)`);
  await settle(c, 8);

  // targets/ground info for framing
  const geo = await ev(c, `(()=>{const g=window.__sf; const ts=window.__archery.targets.map(t=>({lane:t.lane,x:t.center.x,y:t.center.y,z:t.center.z,d:t.distance})); const gy=g.map.groundHeight(${AC.x},${AC.z}); return {ts,gy};})()`);
  const gy = geo.gy;
  // (A) range overview: elevated 3/4 from behind the line looking downrange
  await freeCamAt(c, AC.x - 24, gy + 13, AC.z + 20, AC.x + 6, gy + 1.5, AC.z - 2);
  await tick(c, DT);
  await shoot(c, "archery_range_overview", shots);

  // (B) drive deterministic shots
  const fireSeq = await ev(c, `(()=>{
    const fire = window.__archery.fire;
    const before = window.__archery.stats();
    fire(2, 0, 0);        // dead centre → gold
    fire(2, 0.20, 0.10);  // red/blue ring
    fire(2, -0.34, 0.14); // outer ring
    fire(2, 0.05, -0.42); // low outer
    fire(2, 0, -2.0);     // below the butt → embedded in the grass
    for (let i=0;i<90;i++) window.__sf.tick(${DT});
    const after = window.__archery.stats();
    return { before, after };
  })()`);
  out.archeryFire = fireSeq;
  console.log("[archery] fire before end", JSON.stringify(fireSeq.before.end), "after end", JSON.stringify(fireSeq.after.end), "endTotal", fireSeq.after.endTotal, "grand", fireSeq.after.grandTotal, "stuck", fireSeq.after.stuck);
  if (fireSeq.after.stuck < 5 || fireSeq.after.end[4] !== 0) {
    throw new Error(`archery ground impact did not persist: ${JSON.stringify(fireSeq.after)}`);
  }

  // (C) arrows stuck in the lane-2 face: front 3/4 closeup
  const t2 = geo.ts.find((t) => t.lane === 2);
  await freeCamAt(c, t2.x - 2.6, t2.y + 0.5, t2.z + 1.9, t2.x, t2.y, t2.z);
  await tick(c, DT);
  await shoot(c, "archery_arrows_stuck", shots);

  // (D) player draw pose — bow in hand, full draw
  await teleport(c, AC.x - 14, AC.z, Math.PI / 2);
  await settle(c, 6);
  const pdraw = await ev(c, `(()=>{
    const p = window.__sf.player;
    p.setBowCarried(true);
    p.setArcherPose(true, 0.92, 0.02);
    const rp = p.renderPosition;
    return { x: rp.x, y: rp.y, z: rp.z, heading: p.heading };
  })()`);
  await settle(c, 4);
  // profile view of the archer from their draw side
  await freeCamAt(c, pdraw.x + 0.5, pdraw.y + 0.7, pdraw.z + 3.2, pdraw.x, pdraw.y + 0.6, pdraw.z);
  await tick(c, DT);
  await shoot(c, "archery_draw_profile", shots);
  // front-ish angle to confirm bow gripped in hand + fingers
  await freeCamAt(c, pdraw.x + 2.4, pdraw.y + 0.6, pdraw.z + 1.6, pdraw.x, pdraw.y + 0.6, pdraw.z);
  await tick(c, DT);
  await shoot(c, "archery_draw_front", shots);
  await ev(c, `(()=>{const p=window.__sf.player;p.setArcherPose(false);p.setBowCarried(false);return true;})()`);

  // (E) freeze when far + no arrows
  out.archeryFreeze = await ev(c, `(()=>{
    const p = window.__sf.player; const m = window.__sf.map;
    // teleport far away so the site gate deactivates
    const fx = 0, fz = 0; const y = m.groundHeight(fx,fz);
    p.teleportTo({x:fx,y:y+1.5,z:fz,facing:0,mode:'walk'});
    for (let i=0;i<40;i++) window.__sf.tick(${DT}); // let gate deactivate + arrows resolve
    const s1 = window.__archery.stats();
    const r1 = s1.updatesRan;
    for (let i=0;i<30;i++) window.__sf.tick(${DT});
    const s2 = window.__archery.stats();
    return { awake: s2.awake, visible: s2.visible, flying: s2.flying, ranBefore: r1, ranAfter: s2.updatesRan };
  })()`);
  console.log("[archery] freeze", JSON.stringify(out.archeryFreeze));

  // ============================ PICKLEBALL ============================
  const PB = { x: -1330, z: 2140 };
  await teleport(c, PB.x, PB.z, 0);
  await settle(c, 20);
  out.pickleball = await ev(c, `(()=>{
    const g = window.__sf; const amb = g.pickleballAmbient;
    let courts = 0, athletes = 0, paddles = 0, balls = 0;
    if (amb) amb.group.traverse((o)=>{ if(o.name==="pickleball-game"&&o.visible) courts++; if(o.name==="pickleball-paddle-face") paddles++; if(/player/.test(o.name)&&o.visible) athletes++; if(o.name==="pickleball-ball"&&o.visible&&o.position.y>0.2) balls++; });
    // run a bit to get a rally going
    for(let i=0;i<200;i++) g.tick(${DT});
    let balls2=0; if(amb) amb.group.traverse((o)=>{ if(o.name==="pickleball-ball"&&o.visible&&o.position.y>0.25) balls2++; });
    let inter=null; try{ const it=amb&&amb.getInteraction(g.player.position); if(it) inter={ref:it.ref,side:it.side,prompt:it.prompt,d:it.distance,available:it.available}; }catch(e){ inter='err:'+e; }
    const chip = document.querySelector('#hud .pb-card'); const chipShown = !!chip && chip.classList.contains('show');
    return { hasAmbient: !!amb, courts, athletes, paddles, ballsAirborne: balls2, interaction: inter, chipText: chip?chip.textContent:'', chipShown };
  })()`);
  console.log("[pickleball]", JSON.stringify(out.pickleball).slice(0, 400));

  // stand near an athlete's baseline to make interaction prompt available
  const pbInter = await ev(c, `(()=>{
    const g = window.__sf; const a = g.goldenGateTennis.courtAnchors.get('14A');
    if(!a) return null;
    const x = a.x - Math.sin(a.yaw)*7.4, z = a.z - Math.cos(a.yaw)*7.4; const y = g.map.groundHeight(x,z);
    g.player.teleportTo({x,y:y+1.5,z,facing:a.yaw,mode:'walk'});
    for(let i=0;i<24;i++) g.tick(${DT});
    let it=null; try{ const r=g.pickleballAmbient.getInteraction(g.player.position); if(r) it={ref:r.ref,side:r.side,prompt:r.prompt,d:r.distance}; }catch(e){it='err:'+e;}
    return it;
  })()`);
  out.pickleballInteraction = pbInter;
  console.log("[pickleball] interaction near athlete", JSON.stringify(pbInter));

  // screenshot ambient courts mid-rally + HUD chip
  await ev(c, `(()=>{const u=window.__sf.pickleballUI; if(u){u.setVisible(true);u.setScore([7,5],0,4);} return true;})()`);
  const pby = await ev(c, `window.__sf.map.groundHeight(${PB.x},${PB.z})`);
  await teleport(c, PB.x - 26, PB.z + 30, 0.5);
  await settle(c, 6);
  await freeCamAt(c, PB.x - 20, pby + 12, PB.z + 24, PB.x + 2, pby + 1, PB.z - 2);
  for (let i = 0; i < 6; i++) await tick(c, DT);
  await shoot(c, "pickleball_courts", shots);

  // paddle-grip closeup on an ambient athlete
  const grip = await ev(c, `(()=>{
    const amb = window.__sf.pickleballAmbient; if(!amb) return null;
    const THREE = window.__sf.THREE;
    for(const root of amb.group.children){ const rig = root.getObjectByName("pickleball-player-far")||root.getObjectByName("pickleball-player-near"); if(!rig) continue; const face=rig.getObjectByName("pickleball-paddle-face"); if(!face) continue; root.updateWorldMatrix(true,true); const fp=face.getWorldPosition(new THREE.Vector3()); const ap=rig.getWorldPosition(new THREE.Vector3()); const q=new THREE.Quaternion(); rig.getWorldQuaternion(q); const fwd=new THREE.Vector3(0,0,-1).applyQuaternion(q); return {fx:fp.x,fy:fp.y,fz:fp.z,ax:ap.x,az:ap.z,hx:fwd.x,hz:fwd.z}; }
    return null;
  })()`);
  if (grip) {
    const h = Math.atan2(grip.hx, grip.hz); const side = h + Math.PI * 0.3;
    await freeCamAt(c, grip.ax + Math.sin(side) * 1.7, grip.fy + 0.25, grip.az + Math.cos(side) * 1.7, grip.fx, grip.fy, grip.fz);
    await shoot(c, "pickleball_grip", shots);
  }

  // ============================ CLUBHOUSE ============================
  const CH = { x: -1363.78, z: 2197.26 };
  await teleport(c, CH.x + 14, CH.z - 8, -2.3); // stand off the court/east side
  await settle(c, 24);
  out.clubhouse = await ev(c, `(()=>{
    const g = window.__sf; const gt = g.goldenGateTennis; if(!gt) return {err:'no site'};
    for(let i=0;i<30;i++) g.tick(${DT});
    // NPC count via scene traverse under the site — count visible rigs near clubhouse
    let floorTop=null; try{ floorTop = gt.groundOverlay ? gt.groundOverlay(${CH.x},${CH.z}, g.map.groundHeight(${CH.x},${CH.z})) : null; }catch(e){ floorTop='err:'+e; }
    const baseGround = g.map.groundHeight(${CH.x},${CH.z});
    return { floorTop, baseGround, hasUpdate: typeof gt.update==='function' };
  })()`);
  console.log("[clubhouse]", JSON.stringify(out.clubhouse));

  const chy = await ev(c, `window.__sf.map.groundHeight(${CH.x},${CH.z})`);
  // exterior from the courts (east side, elevated)
  await freeCamAt(c, CH.x + 22, chy + 9, CH.z - 20, CH.x, chy + 3, CH.z);
  for (let i = 0; i < 4; i++) await tick(c, DT);
  await shoot(c, "clubhouse_exterior", shots);

  // interior: place camera inside the bar looking at reception
  await freeCamAt(c, CH.x + 6, chy + 2.0, CH.z - 6, CH.x - 4, chy + 1.4, CH.z + 4);
  for (let i = 0; i < 4; i++) await tick(c, DT);
  await shoot(c, "clubhouse_interior_a", shots);
  await freeCamAt(c, CH.x - 2, chy + 2.0, CH.z + 8, CH.x + 2, chy + 1.2, CH.z - 8);
  for (let i = 0; i < 4; i++) await tick(c, DT);
  await shoot(c, "clubhouse_interior_b", shots);

  // walk player inside + screenshot from a body-height view
  await teleport(c, CH.x, CH.z, -1.5);
  await settle(c, 10);
  out.clubhousePlayerY = await ev(c, `(()=>{const p=window.__sf.player.renderPosition; return {y:p.y, ground:window.__sf.map.groundHeight(p.x,p.z), floorOverlay: (window.__sf.goldenGateTennis.groundOverlay?window.__sf.goldenGateTennis.groundOverlay(p.x,p.z,window.__sf.map.groundHeight(p.x,p.z)):null)};})()`);
  await freeCamAt(c, CH.x + 5, chy + 2.2, CH.z - 3, CH.x - 6, chy + 1.3, CH.z + 3);
  for (let i = 0; i < 4; i++) await tick(c, DT);
  await shoot(c, "clubhouse_interior_c", shots);

  out.pageErrors = pageErrors.slice(0, 8);
  writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ out, shots }, null, 2));
  console.log("[probe] DONE. errors:", pageErrors.length);
  cleanup();
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[probe] FAIL", e); process.exit(1); });
