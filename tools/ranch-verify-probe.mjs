// Ranch-wide verification + progress capture: one headless boot, then visits
// every training pen (Biscuit's nursery, the horse paddock, the goat pen),
// reads each pen's ground-truth state and screenshots them all.
//
//   node tools/ranch-verify-probe.mjs [--out DIR] [--label NAME]
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argOf = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const OUT = path.resolve(ROOT, argOf("out", ".data/ranch-verify"));
const LABEL = argOf("label", "ranch");
const PORT = 5237;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const W = 1280, H = 720, DT = 1 / 30;
// keep in sync with src/gameplay/pup/meta.ts + src/gameplay/ranch/meta.ts
const PUP = { x: -650, z: -1640 };
const HORSES = { x: -775, z: -1655 };
const GOATS = { x: -705, z: -1675 };
const CENTER = { x: -720, z: -1655 };
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
  try { execSync(`lsof -ti tcp:${PORT} | xargs kill -9`, { stdio: "ignore" }); } catch {}
  console.log(`[probe] starting Vite ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
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
process.on("exit", cleanup);
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`); return r.result?.value; }
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(DT)); await sleep(20); } }
async function freeCamAt(c, ex, ey, ez, tx, ty, tz) {
  await ev(c, `window.__sfFreeCam([${ex},${ey},${ez}],[${tx},${ty},${tz}])`);
  for (let i = 0; i < 120; i++) { await tick(c, 0); const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`); if (Math.hypot(p[0] - ex, p[1] - ey, p[2] - ez) < 0.06) return; await sleep(30); }
  console.log("[probe] warn: free camera never fully acquired");
}
async function shoot(c, name) { const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true }); const file = path.join(OUT, `${name}.jpg`); writeFileSync(file, Buffer.from(shot.data, "base64")); console.log(`[probe] shot ${file}`); return file; }

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

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now(); let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player&&window.__sf.map)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  await ev(c, `window.__sfManual(true)`);
  await ev(c, `(()=>{try{window.__sf.sky.setTimeOfDay?.(14.0)}catch(e){} return true})()`);
  await ev(c, `(()=>{const h=document.getElementById('hud');if(h)h.style.display='none';return true})()`);

  // Stand at the ranch centre: inside every pen's approach radius, so the
  // serialized optional-site loader hydrates pup AND ranch one after the other.
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const x=${CENTER.x},z=${CENTER.z};const y=m.groundTop(x,z);p.teleportTo({x,y:y+1.5,z,facing:0,mode:'walk'});return true;})()`);
  await settle(c, 30);

  console.log("[probe] waiting for pup + ranch sites...");
  const t1 = Date.now(); let both = false;
  while (Date.now() - t1 < 180000) {
    await settle(c, 6);
    try { if (await ev(c, `!!(window.__sf.pup && window.__sf.ranch && window.__sf.siteGate.awake('pup') && window.__sf.siteGate.awake('ranch'))`)) { both = true; break; } } catch {}
  }
  if (!both) throw new Error("pup/ranch sites never woke");
  console.log(`[probe] pens awake in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

  await settle(c, 90); // let everyone live a bit
  const pupState = await ev(c, `window.__sf.pup.debugState()`);
  const ranchState = await ev(c, `window.__sf.ranch.debugState()`);
  console.log("[probe] pup:", JSON.stringify(pupState));
  console.log("[probe] ranch:", JSON.stringify(ranchState));

  const g = (x, z) => `window.__sf.map.groundTop(${x},${z})`;
  // pup close
  await freeCamAt(c, pupState.wx + 1.5, pupState.wy + 1.0, pupState.wz + 1.9, pupState.wx, pupState.wy + 0.25, pupState.wz);
  await settle(c, 6);
  await shoot(c, `${LABEL}-pup`);
  // horse paddock wide (jumps + all three)
  const gh = await ev(c, g(HORSES.x, HORSES.z));
  await freeCamAt(c, HORSES.x + 20, gh + 8, HORSES.z + 30, HORSES.x, gh + 1, HORSES.z);
  await settle(c, 6);
  await shoot(c, `${LABEL}-horses`);
  // goat pen
  const gg = await ev(c, g(GOATS.x, GOATS.z));
  const goats = ranchState.find((p) => p.id === "goats");
  const gc = goats?.creatures?.[0];
  if (gc) await freeCamAt(c, gc.wx + 2.2, gc.wy + 1.3, gc.wz + 2.6, gc.wx, gc.wy + 0.3, gc.wz);
  else await freeCamAt(c, GOATS.x + 6, gg + 3, GOATS.z + 8, GOATS.x, gg + 0.7, GOATS.z);
  await settle(c, 6);
  await shoot(c, `${LABEL}-goats`);
  // ranch overview
  await freeCamAt(c, CENTER.x + 55, (gh + gg) / 2 + 30, CENTER.z + 75, CENTER.x - 10, (gh + gg) / 2, CENTER.z - 10);
  await settle(c, 6);
  await shoot(c, `${LABEL}-overview`);

  for (const [name, file] of [["pup", "pup_policy.json"], ["horse", "horse_policy.json"], ["goat", "goat_policy.json"]]) {
    const p = path.join(ROOT, "public/models", file);
    if (existsSync(p)) copyFileSync(p, path.join(OUT, `${LABEL}-${name}-policy.json`));
  }

  const horses = ranchState.find((p) => p.id === "horses");
  const ok =
    !!pupState.hasPolicy && pupState.tall > 0.25 &&
    (horses?.creatures?.length ?? 0) > 0 &&
    (goats?.creatures?.length ?? 0) > 0;
  const verdict = { label: LABEL, at: new Date().toISOString(), pup: pupState, ranch: ranchState, ok, pageErrors: pageErrors.slice(0, 12) };
  writeFileSync(path.join(OUT, `${LABEL}-state.json`), JSON.stringify(verdict, null, 2));
  console.log(`[probe] ${ok ? "PASS" : "CHECK"} pup gen=${pupState.gen} horses gen=${horses?.gen} goats gen=${goats?.gen}`);
  cleanup();
  process.exit(ok ? 0 : 2);
}

main().catch((e) => { console.error("[probe] FAIL:", e.message); cleanup(); process.exit(1); });
