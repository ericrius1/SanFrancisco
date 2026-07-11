// Headless probe: Escape must ALWAYS exit pointer lock.
// Regression tests for the three ways Esc used to lose:
//   A. late-grant race — releaseLock() while a requestLock grant is in flight
//      must leave the pointer unlocked (the stale grant is dropped on arrival)
//   B. stale free cursor + Escape keydown must NOT heal-and-relock (input.ts
//      keydown path used to call #endFreeCursor(true) for every key incl. Esc)
//   C. overlay open (expanded minimap) + locked — Esc dismisses the overlay AND
//      releases the lock in the same press
// Plus controls proving the lock plumbing itself works headless (click locks,
// exit+request relocks) so a pass is meaningful.
//
//   node tools/esc-pointerlock-probe.mjs
// Env: SF_PROBE_OUT (default scratchpad), CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.env.SF_PROBE_OUT ?? "/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/a8749e70-9e3b-489b-9e8f-8b16540b59e8/scratchpad/esc-probe");
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
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: false });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
// Same eval but with Chrome's user-activation bit set — for paths that need a gesture.
async function evGesture(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
async function click(c, x, y) {
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function pressEscape(c) {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}
const lockState = `(()=>({el:!!document.pointerLockElement,locked:window.__sf.input.locked,free:window.__sf.input.freeCursor}))()`;
async function waitLock(c, want, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const s = await ev(c, lockState);
    if (s.el === want && s.locked === want) return s;
    await sleep(100);
  }
  return ev(c, lockState);
}

const results = [];
const push = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`); };

async function main() {
  mkdirSync(OUT, { recursive: true });

  const vitePort = await freePort();
  const relayPort = 8788;
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
  ownedDev = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "pipe", "pipe"], detached: true
  });
  ownedDev.stdout.on("data", () => {});
  ownedDev.stderr.on("data", (d) => { const s = String(d); if (/error/i.test(s)) console.error("[vite]", s.slice(0, 300)); });
  await waitHttp(SERVER_URL, 60000, "vite");

  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  // HEADED: headless=new rejects requestPointerLock outright (WrongDocumentError),
  // so this probe runs a real (offscreen-positioned) window. It self-kills at exit.
  chromeProc = spawn(chrome, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, "--window-position=40,40",
    `${SERVER_URL}/?fullfps`
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
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.input&&window.__sf.minimap&&window.__sf.player)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // enter the game through the real name gate (Start click is the lock gesture)
  const t1 = Date.now();
  let started = false;
  while (Date.now() - t1 < 60000) {
    const st = await ev(c, `(()=>{const b=document.querySelector('[data-start-form] button');const loading=document.getElementById('loading');
      if(loading&&loading.classList.contains('done')) return 'already';
      if(b&&!b.disabled){b.click();return 'clicked';}return b?'wait':'nobtn';})()`);
    if (st === "clicked" || st === "already") { started = true; break; }
    await sleep(500);
  }
  if (!started) throw new Error("Start never clickable");
  console.log("[probe] game entered");
  await sleep(1500);

  // ---- control: trusted click locks the pointer (proves lock works headless)
  await click(c, W / 2, H / 2);
  let s = await waitLock(c, true);
  push("control-click-locks", s.el && s.locked, `after canvas click: pointerLockElement=${s.el} input.locked=${s.locked}`);
  if (!s.el) {
    console.log("[probe] headless Chrome refused pointer lock — remaining tests meaningless, aborting");
    return finish();
  }

  // ---- A. late-grant race: exit + request (grant in flight) + releaseLock →
  // must settle UNLOCKED. First a control: exit+request alone re-locks.
  await evGesture(c, `(()=>{document.exitPointerLock();window.__sf.input.requestLock();return true;})()`);
  s = await waitLock(c, true);
  push("control-relock-works", s.el && s.locked, `exit+request alone re-locks: el=${s.el} locked=${s.locked}`);
  if (s.el) {
    await evGesture(c, `(()=>{document.exitPointerLock();window.__sf.input.requestLock();window.__sf.input.releaseLock();return true;})()`);
    await sleep(1200); // let any stale grant land and be dropped
    s = await ev(c, lockState);
    push("A-late-grant-dropped", !s.el && !s.locked, `exit+request+releaseLock settles unlocked: el=${s.el} locked=${s.locked}`);
  } else {
    push("A-late-grant-dropped", false, "skipped — relock control failed");
  }

  // ---- B. stale free cursor + Escape must stay unlocked (no heal-and-relock)
  await ev(c, `(()=>{const i=window.__sf.input;i.freeCursor=true;i.onFreeCursorChange(true);document.exitPointerLock();return true;})()`);
  await sleep(300);
  await pressEscape(c);
  await sleep(1200);
  s = await ev(c, lockState);
  push("B-esc-stale-freecursor", !s.el && !s.locked && !s.free, `after Esc w/ stale freeCursor: el=${s.el} locked=${s.locked} freeCursor=${s.free}`);

  // ---- C. overlay open + locked: one Esc closes the overlay AND unlocks
  await click(c, W / 2, H / 2); // re-lock (trusted gesture)
  s = await waitLock(c, true);
  if (!s.el) { push("C-esc-overlay-unlocks", false, "could not re-lock for overlay test"); return finish(); }
  await ev(c, `(()=>{window.__sf.minimap.setExpanded(true);return true;})()`);
  await sleep(200);
  await pressEscape(c);
  await sleep(1200);
  const exp = await ev(c, `window.__sf.minimap.expanded`);
  s = await ev(c, lockState);
  push("C-esc-overlay-unlocks", !exp && !s.el && !s.locked, `after one Esc: minimap.expanded=${exp} el=${s.el} locked=${s.locked}`);

  return finish();

  function finish() {
    const errs = pageErrors.filter((e) => !/favicon|SF_RELAY|WebSocket/i.test(e));
    push("no-page-errors", errs.length === 0, errs.length ? errs.slice(0, 3).join(" | ") : "clean console");
    const fails = results.filter((r) => !r.ok);
    console.log(`\n[probe] ${results.length - fails.length}/${results.length} passed`);
    process.exitCode = fails.length ? 1 : 0;
  }
}

main().catch((e) => { console.error("[probe] FATAL", e); process.exitCode = 1; }).finally(cleanup);
