// Surf-entry freeze probe: boots Ocean Beach live (real rAF), presses E, and
// measures main-thread stalls (rAF gaps + longtasks) around surf activation,
// with a CPU profile to attribute the worst stall.
// Env: SF_PROBE_URL (required — point at a fresh vite), SF_PROBE_OUT.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/surf-entry-freeze");
const PROFILE = path.join(process.env.TMPDIR ?? "/tmp", `sf-freeze-probe-${Date.now()}`);
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5241";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`HTTP timeout: ${url}`);
}

function findChrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (!candidate.includes("/") || existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}

class Cdp {
  #socket; #id = 1; #pending = new Map();
  errors = [];
  constructor(url) { this.#socket = new WebSocket(url); }
  async open() {
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", reject, { once: true });
    });
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params?.exceptionDetails?.exception?.description ?? "runtime exception");
      }
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 120_000);
      this.#pending.set(id, { resolve, reject, method, timeout });
    });
  }
  close() { this.#socket.close(); }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`evaluate: ${JSON.stringify(result.exceptionDetails).slice(0, 800)}`);
  return result.result?.value;
}

async function waitEval(cdp, expression, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await evaluate(cdp, expression)) return; } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Aggregate a CDP Profiler result into self-time per function (top 30).
function summarizeProfile(profile) {
  const nodes = new Map();
  for (const node of profile.nodes) nodes.set(node.id, node);
  const self = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = nodes.get(samples[i]);
    if (!node) continue;
    const f = node.callFrame;
    const key = `${f.functionName || "(anon)"} @ ${path.basename(f.url || "")}:${f.lineNumber ?? 0}`;
    self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0) / 1000);
  }
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([k, ms]) => ({ fn: k, selfMs: Number(ms.toFixed(1)) }));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  await waitHttp(SERVER_URL, 60_000);
  const pageUrl = `${SERVER_URL}/?autostart=1&fullfps=1&spawn=oceanBeach`;

  const chromePort = await freePort();
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${PROFILE}`,
    "--headless=new",
    "--no-first-run",
    "--mute-audio",
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--use-angle=metal",
    "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
    "--window-size=1280,800",
    "--force-device-scale-factor=1",
    "about:blank"
  ], { stdio: "ignore" });

  let cdp;
  try {
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      try { await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json(); break; } catch {}
      await sleep(200);
    }
    const page = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: pageUrl });
    await waitEval(cdp, "Boolean(document.body.classList.contains('started') && window.__sf?.player)", 180_000, "started Ocean Beach");
    // Bypass the deferred warmup pass like surf-probe does, then wait playable.
    await evaluate(cdp, `(()=>{const s=window.__sf; if(!s.renderIdle?.()) s.pipeline.warmup=async()=>{}; return true;})()`);
    await waitEval(cdp, "window.__sf.renderIdle?.()===true", 30_000, "playable frame loop");

    // Let the live loop settle 3s, measure baseline rAF gaps.
    await evaluate(cdp, `(()=>{
      window.__freeze={gaps:[],longtasks:[],phase:'baseline',events:[]};
      const rec=window.__freeze;
      let last=performance.now();
      const loop=(t)=>{rec.gaps.push({t, gap:t-last, phase:rec.phase}); last=t; requestAnimationFrame(loop);};
      requestAnimationFrame(loop);
      try{
        new PerformanceObserver((list)=>{for(const e of list.getEntries())rec.longtasks.push({start:e.startTime,dur:e.duration,phase:rec.phase});}).observe({entryTypes:['longtask']});
      }catch{}
      return true;})()`);
    await sleep(3000);

    // Start CPU profiler, press E, watch 10 s of live play.
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
    await cdp.send("Profiler.start");
    await evaluate(cdp, `(()=>{window.__freeze.phase='entry';window.__freeze.events.push({name:'pressE',t:performance.now()});return true})()`);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyE", key: "e", windowsVirtualKeyCode: 69 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyE", key: "e", windowsVirtualKeyCode: 69 });
    await waitEval(cdp, "window.__sf.player.mode==='surf'", 20_000, "surf mode");
    await evaluate(cdp, `(()=>{window.__freeze.events.push({name:'surfMode',t:performance.now()});return true})()`);
    await sleep(10_000);
    await evaluate(cdp, `(()=>{window.__freeze.phase='steady';return true})()`);
    await sleep(5_000);
    const { profile } = await cdp.send("Profiler.stop");

    const data = await evaluate(cdp, `(()=>{
      const r=window.__freeze;
      const byPhase={};
      for(const g of r.gaps){
        const p=byPhase[g.phase]??={count:0,max:0,over50:0,over250:0,worst:[]};
        p.count++;p.max=Math.max(p.max,g.gap);
        if(g.gap>50)p.over50++;
        if(g.gap>250)p.over250++;
        if(g.gap>120)p.worst.push({t:Math.round(g.t),gap:Math.round(g.gap)});
      }
      for(const k in byPhase)byPhase[k].worst=byPhase[k].worst.slice(0,20);
      return {byPhase,longtasks:r.longtasks.filter(l=>l.dur>100).slice(0,40),events:r.events,
        mode:window.__sf.player.mode,speed:window.__sf.player.surfTelemetry.speed};
    })()`);

    const summary = { url: pageUrl, data, hotFunctions: summarizeProfile(profile), errors: cdp.errors.slice(0, 10) };
    writeFileSync(path.join(OUT, "report.json"), JSON.stringify(summary, null, 2));
    writeFileSync(path.join(OUT, "profile.cpuprofile"), JSON.stringify(profile));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await sleep(300);
    try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 }); } catch {}
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
