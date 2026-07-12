// Boot probe: measures REAL loading time headless (WebGPU/metal) with the
// settle gate active (`?startscreen=1` overrides dev auto-entry). Per run it records:
//   - the loading-cover label/percent timeline (polled at 40ms)
//   - the app's own [boot] console marks (core-up / settled / reveal reason)
//   - the full resource waterfall (performance resource timing): per-asset
//     transfer size + duration, module counts, totals
// Runs against ANY checkout (SF_PROBE_ROOT) so a worktree at HEAD and the
// working tree can be A/B'd with identical assets.
//
//   node tools/boot-probe.mjs
// Env: SF_PROBE_ROOT (default repo root), SF_PROBE_LABEL (default basename),
//      SF_RUNS (default 2, first run is a vite warmup hit that is ALSO
//      reported), SF_PROBE_OUT (default .data/boot-probe), CHROME_BIN
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(process.env.SF_PROBE_ROOT ?? SELF_ROOT);
const LABEL = process.env.SF_PROBE_LABEL ?? path.basename(ROOT);
const OUT = path.resolve(SELF_ROOT, process.env.SF_PROBE_OUT ?? ".data/boot-probe");
const RUNS = Number(process.env.SF_RUNS ?? 2);
const W = 1600, H = 1000;
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
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

const POLLER = `(() => {
  const marks = [];
  window.__bootMarks = marks;
  const read = () => {
    try {
      const label = document.querySelector('[data-loading-label]');
      const loading = document.getElementById('loading');
      if (!label || !loading) return;
      const bar = document.querySelector('[data-loading-bar]');
      const rec = { t: Math.round(performance.now()), label: label.textContent, w: bar ? bar.style.width : '', cls: loading.className };
      const last = marks[marks.length - 1];
      if (!last || last.label !== rec.label || last.cls !== rec.cls) marks.push(rec);
      if (!window.__bootReady && loading.classList.contains('ready')) window.__bootReady = Math.round(performance.now());
    } catch {}
  };
  setInterval(read, 40);
  window.addEventListener('error', (e) => marks.push({ t: Math.round(performance.now()), err: String(e.message).slice(0, 200) }));
})();`;

async function runOnce(chrome, serverUrl, runIdx) {
  const profileDir = path.join(OUT, `chrome-${LABEL}-${runIdx}`);
  rmSync(profileDir, { recursive: true, force: true });
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${profileDir}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, "about:blank"
  ], { cwd: ROOT, stdio: "ignore" });
  try {
    let page;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {}
      await sleep(300);
    }
    if (!page) throw new Error("no page target");
    const c = new Cdp(page.webSocketDebuggerUrl);
    const consoleLog = [];
    let timeOrigin = 0;
    c.onEvent = (m) => {
      if (m.method === "Runtime.consoleAPICalled") {
        const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
        consoleLog.push({ ts: m.params.timestamp, type: m.params.type, txt });
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        consoleLog.push({ ts: d.timestamp ?? 0, type: "exception", txt: ((d.exception && (d.exception.description || d.exception.value)) || d.text || "").slice(0, 300) });
      }
    };
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: POLLER });
    // fullfps: webdriver rAF throttle would slow the settle drain to 20fps
    await c.send("Page.navigate", { url: `${serverUrl}/?startscreen=1&fullfps` });

    const t0 = Date.now();
    let ready = null;
    while (Date.now() - t0 < 120000) {
      await sleep(500);
      try {
        ready = await ev(c, "window.__bootReady ?? null");
        if (ready) break;
        timeOrigin = timeOrigin || (await ev(c, "performance.timeOrigin"));
      } catch {}
    }
    timeOrigin = timeOrigin || (await ev(c, "performance.timeOrigin"));
    const marks = await ev(c, "window.__bootMarks ?? []");
    const resources = await ev(c, `performance.getEntriesByType('resource').map((r) => ({
      name: r.name.replace(location.origin, ''), type: r.initiatorType,
      start: Math.round(r.startTime), dur: Math.round(r.duration),
      xfer: r.transferSize, enc: r.encodedBodySize, dec: r.decodedBodySize
    }))`);
    const nav = await ev(c, `(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { ttfb: Math.round(n.responseStart), domInteractive: Math.round(n.domInteractive) } : null; })()`);
    const boots = consoleLog
      .filter((l) => l.txt.startsWith("[boot]"))
      .map((l) => ({ rel: timeOrigin ? Math.round(l.ts - timeOrigin) : null, txt: l.txt }));
    const errors = consoleLog.filter((l) => l.type === "error" || l.type === "exception").map((l) => l.txt);
    c.close();
    return { run: runIdx, readyMs: ready, marks, boots, resources, nav, errors };
  } finally {
    proc.kill("SIGKILL");
    await sleep(300);
  }
}

function fmtBytes(b) { return b > 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${(b / 1024).toFixed(0)}KB`; }

function report(result) {
  const { run, readyMs, marks, boots, resources, nav, errors } = result;
  console.log(`\n=== [${LABEL}] run ${run} — reveal ${readyMs ? (readyMs / 1000).toFixed(1) + "s" : "TIMEOUT"} (ttfb ${nav?.ttfb}ms) ===`);
  for (const m of marks) console.log(`  ${String(m.t ?? "").padStart(6)}ms  ${m.err ? "ERR " + m.err : `${(m.w ?? "").padStart(4)} ${m.label}  [${m.cls}]`}`);
  for (const b of boots) console.log(`  boot> ${b.rel != null ? b.rel + "ms" : "?"}  ${b.txt}`);
  if (errors.length) console.log(`  page errors (${errors.length}):`, errors.slice(0, 5));
  const total = resources.reduce((s, r) => s + (r.xfer || 0), 0);
  const js = resources.filter((r) => /\.m?[tj]s(\?|$)|\/src\/|\/node_modules\//.test(r.name));
  console.log(`  resources: ${resources.length} reqs, ${fmtBytes(total)} transferred; js-ish: ${js.length} reqs`);
  const bySize = [...resources].sort((a, b) => (b.xfer || 0) - (a.xfer || 0)).slice(0, 12);
  console.log("  top by transfer:");
  for (const r of bySize) console.log(`    ${fmtBytes(r.xfer || 0).padStart(8)} enc=${fmtBytes(r.enc || 0).padStart(8)} dec=${fmtBytes(r.dec || 0).padStart(8)} ${String(r.dur).padStart(5)}ms @${String(r.start).padStart(6)}ms  ${r.name.slice(0, 90)}`);
  const byDur = [...resources].sort((a, b) => b.dur - a.dur).slice(0, 8);
  console.log("  top by duration:");
  for (const r of byDur) console.log(`    ${String(r.dur).padStart(6)}ms @${String(r.start).padStart(6)}ms ${fmtBytes(r.xfer || 0).padStart(8)}  ${r.name.slice(0, 90)}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = await findChrome();
  // SF_PROBE_URL: probe an already-running server (e.g. prod `node server/server.mjs`)
  const external = process.env.SF_PROBE_URL ?? null;
  const vitePort = await freePort();
  const relayPort = await freePort();
  const serverUrl = external ?? `http://127.0.0.1:${vitePort}`;
  console.log(`[probe] root=${ROOT} label=${LABEL} server=${serverUrl}${external ? " (external)" : ""}`);
  const vite = external ? null : spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "pipe", "pipe"], detached: true
  });
  vite?.stdout.on("data", () => {});
  vite?.stderr.on("data", (d) => { const s = String(d); if (/error/i.test(s)) console.error("[vite]", s.slice(0, 400)); });
  try {
    await waitHttp(serverUrl, 60000, "server");
    const results = [];
    for (let i = 1; i <= RUNS; i++) {
      const r = await runOnce(chrome, serverUrl, i);
      results.push(r);
      report(r);
    }
    writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(results, null, 1));
    console.log(`\n[probe] wrote ${path.join(OUT, `${LABEL}.json`)}`);
  } finally {
    // npx spawns vite as a child; kill the whole detached group or it orphans
    if (vite) { try { process.kill(-vite.pid, "SIGKILL"); } catch { vite.kill("SIGKILL"); } }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
