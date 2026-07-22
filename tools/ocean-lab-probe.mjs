// Spectral-ocean lab probe: boots ?oceanlab=1 headless, captures the FFT
// correctness test mode and the JONSWAP mode, dumps the stats readout and any
// console errors/exceptions. Spawns its OWN vite on a free port (never 5179).
//
//   node tools/ocean-lab-probe.mjs
//
// Out: .data/ocean-lab-probe/{fft-test,jonswap}-<n>.png + stdout report.

import { spawn } from "node:child_process";
import { constants as fsConstants, mkdirSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/ocean-lab-probe");
const WIDTH = 1500;
const HEIGHT = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function executable(cands) {
  for (const c of cands.filter(Boolean)) {
    if (c.includes(path.sep)) { try { await access(c, fsConstants.X_OK); return c; } catch { continue; } }
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue; const full = path.join(dir, c);
      try { await access(full, fsConstants.X_OK); return full; } catch { /* keep looking */ }
    }
  }
  return null;
}
const findChrome = () => executable([
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome", "chromium"
]);
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => res(a.port)); });
  });
}
async function waitHttp(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* poll */ }
    await sleep(250);
  }
  throw new Error(`server never answered at ${url}`);
}
async function waitForCdp(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch { /* poll */ }
    await sleep(200);
  }
  throw new Error("CDP endpoint never opened");
}

class Cdp {
  #ws; #id = 1; #pending = new Map(); #listeners = new Map();
  constructor(url) { this.#ws = new WebSocket(url); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.id) { const p = this.#pending.get(m.id); if (!p) return; this.#pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result ?? {}); return; }
      for (const l of this.#listeners.get(m.method) ?? []) l(m.params ?? {});
    });
  }
  on(method, l) { const a = this.#listeners.get(method) ?? []; a.push(l); this.#listeners.set(method, a); }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#pending.set(id, { resolve: res, reject: rej })); }
}
async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function capture(cdp, name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const buf = Buffer.from(r.data, "base64");
  writeFileSync(path.join(OUT, `${name}.png`), buf);
  console.log(`[oceanlab] ${name}.png (${Math.round(buf.length / 1024)} KiB)`);
}

async function probeMode(cdp, url, name, settleMs) {
  const errors = [];
  const listener = ({ exceptionDetails: d }) => {
    errors.push((d?.exception?.description || d?.text || "").split("\n")[0]);
  };
  cdp.on("Runtime.exceptionThrown", listener);
  await cdp.send("Page.navigate", { url });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try {
      const txt = await evaluate(cdp, "document.querySelector('div')?.textContent ?? ''");
      if (txt.includes("frame")) break;
      if (txt.includes("FATAL")) throw new Error(txt);
    } catch (e) { if (String(e).includes("FATAL")) throw e; }
    await sleep(400);
  }
  await sleep(settleMs);
  await capture(cdp, `${name}-a`);
  await sleep(2500); // second still later in the orbit — waves must have MOVED
  await capture(cdp, `${name}-b`);
  const stats = await evaluate(cdp, "document.querySelector('div')?.textContent ?? '(no stats)'");
  console.log(`[oceanlab] ${name} stats:\n${stats.split("\n").map((l) => "    " + l).join("\n")}`);
  const consoleErrs = await evaluate(cdp, "JSON.stringify((window.__labErrs??[]).slice(0,8))");
  console.log(`[oceanlab] ${name} exceptions: ${errors.length ? errors.join(" | ") : "none"} pageErrs:${consoleErrs}`);
  return { stats, errors };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = await findChrome();
  if (!chrome) throw new Error("no chrome found");

  const vitePort = await freePort();
  const vite = spawn("npx", ["vite", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true
  });
  vite.stdout.on("data", () => {});
  vite.stderr.on("data", () => {});
  const cleanupVite = () => { try { process.kill(-vite.pid, "SIGTERM"); } catch { /* gone */ } };
  process.on("exit", cleanupVite);

  const debugPort = await freePort();
  const profile = path.join(tmpdir(), `sf-ocean-lab-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const proc = spawn(chrome, [
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--mute-audio",
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--enable-gpu", "--use-angle=metal",
    `--window-size=${WIDTH},${HEIGHT}`, "--force-device-scale-factor=1", "about:blank"
  ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const cleanupChrome = () => { try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ } };
  process.on("exit", cleanupChrome);

  try {
    await waitHttp(`http://localhost:${vitePort}/`);
    await waitForCdp(debugPort);
    const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

    const base = `http://localhost:${vitePort}/?oceanlab=1`;
    const test = await probeMode(cdp, `${base}&fft=test`, "fft-test", 4000);
    const sea = await probeMode(cdp, base, "jonswap", 5000);

    const bad = [...test.errors, ...sea.errors];
    console.log(bad.length ? `[oceanlab] FAIL — ${bad.length} exceptions` : "[oceanlab] PASS — no exceptions");
    process.exitCode = bad.length ? 1 : 0;
  } finally {
    cleanupChrome();
    cleanupVite();
  }
}

main().catch((err) => { console.error("[oceanlab] fatal:", err); process.exitCode = 1; });
