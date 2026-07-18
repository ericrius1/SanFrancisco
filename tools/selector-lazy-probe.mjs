// Functional check for the lazy SelectorHub (docs/MAIN_DECOMPOSITION.md step 3).
// Boots headless, asserts NO selector chunk is in the boot waterfall, then for
// each selector switches to its mode, clicks its placeholder launcher, and
// asserts (a) the selector's module chunk is now requested and (b) its panel
// mounted — proving the module dynamic-imports on FIRST OPEN. Screenshots the
// avatar panel. Modeled on tools/perf-shot-probe.mjs.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/selector-lazy");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5199";
const W = 1600, H = 1000;
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
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}
class Cdp {
  #ws; #id = 1; #p = new Map();
  netUrls = []; // every Network.requestWillBeSent URL
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.method === "Network.requestWillBeSent" && m.params?.request?.url) { this.netUrls.push(m.params.request.url); return; }
      if (!m.id) return;
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

// Each selector: the launcher to click, the module chunk name, and a DOM marker
// element that ONLY that module's constructor creates (definitive proof the
// specific module dynamic-imported and constructed on open).
const SELECTORS = [
  { id: "avatar", mode: "walk", launcher: ".avatar-launcher-ui .avatar-toggle", chunk: "avatarSelector", marker: ".avatar-name-input", shot: true },
  { id: "board", mode: "board", launcher: ".board-launcher-ui .board-toggle", chunk: "boardSelector", marker: ".board-picker-canvas" },
  { id: "scooter", mode: "scooter", launcher: ".scooter-launcher-ui .scooter-toggle", chunk: "scooterSelector", marker: ".scooter-color-input" },
  { id: "car", mode: "drive", launcher: ".car-launcher-ui .car-toggle", chunk: "carSelector", marker: ".car-panel" },
  { id: "surfboard", mode: "surf", launcher: ".surfboard-launcher-ui .surfboard-toggle", chunk: "surfboardSelector", marker: ".surfboard-color-input" }
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  try { rmSync(path.join(OUT, "chrome"), { recursive: true, force: true }); } catch {} // fresh session (no resumed mode)
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart=1`
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
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) {
    try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer?.backend?.device&&window.__sf.switchMode)`)) { ready = true; break; } } catch {}
    await sleep(600);
  }
  if (!ready) throw new Error("app never ready");

  const seen = (chunk) => c.netUrls.some((u) => new RegExp(`/${chunk}(\\.ts|-[A-Za-z0-9_-]+\\.js)`).test(u));

  // ---- boot invariant: no selector module requested before any open ----
  const bootLoaded = SELECTORS.filter((s) => seen(s.chunk)).map((s) => s.chunk);
  const results = [];
  const bootOk = bootLoaded.length === 0;
  console.log(`boot: ${bootOk ? "OK — no selector module requested" : "FAIL — requested at boot: " + bootLoaded.join(", ")}`);

  // ---- each selector: switch to its mode, open its launcher, assert the
  //      module network-requested AND its unique constructor marker mounted ----
  for (const s of SELECTORS) {
    const before = seen(s.chunk); // must be false at this point
    await ev(c, `window.__sf.switchMode(${JSON.stringify(s.mode)})`);
    const mt = Date.now();
    let switched = false;
    while (Date.now() - mt < 8000) {
      if (await ev(c, `window.__sf.player.mode===${JSON.stringify(s.mode)}`)) { switched = true; break; }
      await sleep(200);
    }
    // settle a few frames so syncCustomizerForMode reveals this mode's launcher
    await ev(c, `(async()=>{const d=window.__sf.renderer.backend.device;for(let i=0;i<6;i++){window.__sf.tick(1/60);await d.queue.onSubmittedWorkDone();}})()`);
    const mode = await ev(c, `window.__sf.player.mode`);
    const launcherVisible = await ev(c, `(()=>{const el=document.querySelector(${JSON.stringify(s.launcher)});return !!el && !el.closest('.avatar-ui')?.hidden;})()`);
    // Click the placeholder launcher → triggers the lazy import.
    const clicked = await ev(c, `(()=>{const el=document.querySelector(${JSON.stringify(s.launcher)});if(!el)return false;el.click();return true;})()`);
    // wait for the module request + the unique constructor marker in the DOM
    let requested = false, marker = false;
    const wt = Date.now();
    while (Date.now() - wt < 12000) {
      requested = seen(s.chunk);
      marker = await ev(c, `!!document.querySelector(${JSON.stringify(s.marker)})`);
      if (requested && marker) break;
      await sleep(250);
    }
    const lazyOpen = !before && requested; // was NOT loaded until this open
    const pass = lazyOpen && marker && clicked && (s.mode === "walk" ? mode === "walk" : switched);
    results.push({ id: s.id, mode, switched, launcherVisible, clicked, requestedOnOpen: lazyOpen, marker, pass });
    console.log(`${s.id.padEnd(9)} mode=${String(mode).padEnd(7)} launcherVisible=${launcherVisible} clicked=${clicked} moduleRequestedOnOpen=${lazyOpen} marker(${s.marker})=${marker} => ${pass ? "PASS" : "FAIL"}`);
    if (s.shot) {
      const { data } = await c.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(OUT, `${s.id}-open.png`), Buffer.from(data, "base64"));
      console.log(`  screenshot: ${path.join(OUT, `${s.id}-open.png`)}`);
    }
  }

  const allPass = bootOk && results.every((r) => r.pass);
  writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ bootOk, results, selectorNetUrls: c.netUrls.filter((u) => /[Ss]elector/.test(u)) }, null, 2));
  console.log(`\nSUMMARY: bootLazy=${bootOk} allSelectorsLazyOpen=${results.every((r) => r.pass)} => ${allPass ? "PASS" : "FAIL"}`);

  c.close();
  proc.kill("SIGKILL");
  if (dev) dev.kill("SIGKILL");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
