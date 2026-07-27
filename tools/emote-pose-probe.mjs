// Drives the WebGPU emote contact sheet in emote-pose-probe.html: one rig per
// emote, sampled across the gesture so a pose can be judged (and fixed) without
// booting the world.
//
//   node tools/emote-pose-probe.mjs
// Env: SF_PROBE_OUT (default .data/emote-pose-probe), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/emote-pose-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5198";
const FIXTURE = "/tools/emote-pose-probe.html";
const W = 2400, H = 800;
// Sample points chosen to catch the three things that go wrong: the entry blend
// (0.15 s), the gesture at full weight (0.5 / 0.9 / 1.4 s), and the exit blend
// on the short one-shots (2.2 s).
const SAMPLES = [0.15, 0.5, 0.9, 1.4, 2.2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {}
    await sleep(300);
  }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDevIfNeeded() {
  try { await waitHttp(SERVER_URL, 2500, "existing vite"); return null; } catch {}
  const vitePort = Number(new URL(SERVER_URL).port);
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}

class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => {
      this.#ws.addEventListener("open", res, { once: true });
      this.#ws.addEventListener("error", rej, { once: true });
    });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) { this.onEvent?.(m); return; }
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { res, rej, method }));
  }
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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

async function shot(c, name) {
  const png = await c.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(png.data, "base64"));
  console.log(`[probe] ${file}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  chromeProc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    `--window-size=${W},${H}`, "--hide-scrollbars", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chromeProc.stderr.on("data", (d) => {
    const s = String(d);
    if (/error|fail/i.test(s) && !/DevTools listening/.test(s)) process.stderr.write(`[chrome] ${s}`);
  });

  let wsUrl = "";
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(200); }
  }
  if (!wsUrl) throw new Error("chrome devtools never came up");

  const browser = new Cdp(wsUrl);
  await browser.open();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const pageWs = `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
  const c = new Cdp(pageWs);
  activeCdp = c;
  await c.open();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Log.enable");
  c.onEvent = (m) => {
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      console.error(`[page] ${m.params.entry.text}`);
    }
  };
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url: `${SERVER_URL}${FIXTURE}` });

  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 60000 && !ready) {
    ready = await ev(c, "!!(window.__emote && window.__emote.ready)").catch(() => false);
    if (!ready) await sleep(300);
  }
  if (!ready) throw new Error("fixture never signalled ready (check [page] errors above)");
  console.log(`[probe] ${await ev(c, "window.__emote.count")} emotes on the sheet`);

  for (const t of SAMPLES) {
    await ev(c, `window.__emote.render(${t}, { camera: "front" })`);
    await shot(c, `front-t${String(t).replace(".", "_")}`);
    console.log(`[feet t=${t}] ${JSON.stringify(await ev(c, "window.__emote.feetReport()"))}`);
  }
  // Depth of a reach and forward lean are invisible head-on; foot contact is
  // invisible from eye height; crossed legs only read from above.
  await ev(c, "window.__emote.reset()");
  await ev(c, 'window.__emote.render(0.9, { camera: "front", yaw: 0.9 })');
  await shot(c, "yaw-t0_9");
  await ev(c, 'window.__emote.render(1.4, { camera: "feet", yaw: 0.5 })');
  await shot(c, "feet-t1_4");
  await ev(c, 'window.__emote.render(1.9, { camera: "high", yaw: 0.35 })');
  await shot(c, "high-t1_9");

  // Close-ups for the two that a row of eight cannot settle: a loop needs a
  // whole cycle sampled, and crossed legs need to be seen from more than one
  // height. The dance cycle is ~1 s (see EMOTES). Square viewport — the 3:1
  // contact-sheet aspect would drag the neighbours into every close-up.
  const CW = 900, CH = 900;
  await c.send("Emulation.setDeviceMetricsOverride", { width: CW, height: CH, deviceScaleFactor: 1, mobile: false });
  await ev(c, `window.__emote.resize(${CW}, ${CH})`);
  await ev(c, "window.__emote.reset()");
  for (const [i, t] of [0.35, 0.47, 0.6, 0.72, 0.85, 0.97].entries()) {
    await ev(c, `window.__emote.render(${t}, { camera: "front", yaw: 0.5, focus: "dance" })`);
    await shot(c, `dance-${i}`);
  }
  await ev(c, "window.__emote.reset()");
  for (const [name, opts] of [
    ["front", '{ camera: "front", focus: "sit" }'],
    ["yaw", '{ camera: "front", yaw: 0.8, focus: "sit" }'],
    ["high", '{ camera: "high", yaw: 0.5, focus: "sit" }']
  ]) {
    await ev(c, `window.__emote.render(1.6, ${opts})`);
    await shot(c, `sit-${name}`);
  }
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => { console.error(err); cleanup(); process.exit(1); });
