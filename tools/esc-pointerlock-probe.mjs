// Background-browser probe: Escape must ALWAYS exit pointer lock.
// Regression tests for the ways Esc used to lose:
//   0. ordinary locked gameplay must unlock on the first trusted Escape
//   A. a direct programmatic unlock must remain unlocked after async handlers
//   B. stale free cursor + Escape keydown must NOT heal-and-relock (input.ts
//      keydown path used to call #endFreeCursor(true) for every key incl. Esc)
//   C. overlay open (expanded minimap) + locked — Esc still releases the lock
//      in the same press, whether or not Chrome delivers it onward to the modal
//   D. a focused tuning field that consumes Escape must not bypass the earlier
//      input-layer capture listener
//   E. Escape while primary fire is held must not let the trailing mouse-up
//      complete a canvas click that immediately captures the pointer again
//   F. Fullscreen and pointer lock together must still release pointer lock on
//      the first Escape, whichever browser-owned state Escape dismisses first
//   G. Escape normalization must honor event.key when event.code is absent, so
//      chat blur cannot request pointer lock again during the same Escape event
//   H. A delivered Escape keyup must release even when the browser reserved the
//      corresponding keydown while pointer lock was active
//   I. Escape's re-lock barrier must survive pointerlockchange until keyup
// Plus controls proving the lock plumbing itself works in background Chrome
// (click locks, exit+request relocks) so a pass is meaningful.
// Canvas scene clicks re-capture after unlock; HUD/UI clicks do not.
//
//   node tools/esc-pointerlock-probe.mjs
// Env: SF_PROBE_OUT (default scratchpad), CHROME_BIN,
//      SF_PROBE_PREVIEW=1 (serve an existing dist build instead of Vite dev)

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

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout(${ms}ms): ${label}`)), ms))]);
async function ev(c, expr) {
  const r = await withTimeout(c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: false }), 8000, expr.slice(0, 60));
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
// Same eval but with Chrome's user-activation bit set — for paths that need a gesture.
async function evGesture(c, expr) {
  const r = await withTimeout(c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }), 8000, "gesture:" + expr.slice(0, 50));
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
async function click(c, x, y) {
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function mouseDown(c, x, y) {
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
}
async function mouseUp(c, x, y) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function escapeDown(c) {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}
async function escapeUp(c) {
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}
async function pressEscape(c) {
  await escapeDown(c);
  await escapeUp(c);
}
async function pressL(c) {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "l", code: "KeyL", windowsVirtualKeyCode: 76, nativeVirtualKeyCode: 76 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "l", code: "KeyL", windowsVirtualKeyCode: 76, nativeVirtualKeyCode: 76 });
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
async function waitFor(c, expr, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await ev(c, expr)) return true;
    await sleep(100);
  }
  return Boolean(await ev(c, expr));
}

const results = [];
const push = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`); };

async function main() {
  mkdirSync(OUT, { recursive: true });

  const vitePort = await freePort();
  const relayPort = 8788;
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  const preview = process.env.SF_PROBE_PREVIEW === "1";
  console.log(`[probe] starting Vite ${preview ? "preview" : "dev"} at ${SERVER_URL}`);
  const viteArgs = preview
    ? ["vite", "preview", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"]
    : ["vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"];
  ownedDev = spawn("npx", viteArgs, {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "pipe", "pipe"], detached: true
  });
  ownedDev.stdout.on("data", () => {});
  ownedDev.stderr.on("data", (d) => { const s = String(d); if (/error/i.test(s)) console.error("[vite]", s.slice(0, 300)); });
  await waitHttp(SERVER_URL, 60000, "vite");

  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, `chrome-${Date.now()}`);
  // HEADED: headless=new rejects requestPointerLock outright (WrongDocumentError),
  // so this probe runs a real (offscreen-positioned) window. It self-kills at exit.
  chromeProc = spawn(chrome, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, "--window-position=40,40",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    `${SERVER_URL}/?fullfps&profile=1${preview ? "&autostart=1" : ""}`
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
  // NOTE: no Emulation.setDeviceMetricsOverride here — device emulation makes
  // requestPointerLock reject with WrongDocumentError. --window-size suffices.
  // An unfocused window also rejects pointer lock — front it first.
  await c.send("Page.bringToFront");

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false, lastErr = null;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.input&&window.__sf.minimap&&window.__sf.player)`)) { ready = true; break; } } catch (e) { lastErr = e; } await sleep(600); }
  if (!ready) {
    if (lastErr) console.log("[probe] last eval error:", String(lastErr).slice(0, 300));
    try {
      const shot = await c.send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(OUT, "stall.png"), Buffer.from(shot.data, "base64"));
      console.log("[probe] stall screenshot:", path.join(OUT, "stall.png"));
      console.log("[probe] page url:", await ev(c, "location.href"), "readyState:", await ev(c, "document.readyState"));
    } catch (e) { console.log("[probe] stall diag failed:", String(e).slice(0, 200)); }
  }
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

  // Headed CDP lock is focus-sensitive — front + retry a few times before giving up.
  const lockViaClick = async () => {
    let st = { el: false, locked: false };
    for (let i = 0; i < 5 && !st.el; i++) {
      await c.send("Page.bringToFront");
      // Drop sticky free-cursor so a scene click is allowed to re-capture.
      await ev(c, `(()=>{const i=window.__sf.input;if(i.freeCursor){i.freeCursor=false;i.onFreeCursorChange(false);}return true;})()`);
      await click(c, W / 2, H / 2);
      st = await waitLock(c, true, 2000);
      if (!st.el) { await pressEscape(c); await sleep(400); }
    }
    return st;
  };

  // ---- control: trusted scene click locks the pointer (proves lock plumbing)
  let s = await lockViaClick();
  push("control-click-locks", s.el && s.locked, `after canvas click: pointerLockElement=${s.el} input.locked=${s.locked}`);
  if (!s.el) {
    const diag = await evGesture(c, `(async()=>{try{await (document.querySelector('canvas')||document.body).requestPointerLock();return "granted:"+!!document.pointerLockElement;}catch(e){return "rejected:"+e.name+":"+e.message;}})()`);
    console.log(`[probe] direct requestPointerLock: ${diag}; hasFocus=${await ev(c, "document.hasFocus()")}`);
    if (!String(diag).startsWith("granted")) {
      console.log("[probe] Chrome refused pointer lock — remaining tests meaningless, aborting");
      return finish();
    }
    s = await waitLock(c, true);
    push("control-direct-lock", s.el && s.locked, `direct gesture lock: el=${s.el} locked=${s.locked}`);
    if (!s.el) return finish();
  }

  // ---- 0. Real broken path: one trusted Escape from ordinary gameplay must
  // release pointer lock and stay released after async lock-change handlers run.
  console.log("[probe] test 0: first Escape unlocks gameplay");
  const focusBeforeEscape = await ev(c, `(()=>{window.__esc0Trace={start:performance.now(),blurAt:null,unlockAt:null};window.__escBlurWatch=()=>{window.__esc0Trace.blurAt??=performance.now()-window.__esc0Trace.start};window.__escLockWatch=()=>{if(!document.pointerLockElement)window.__esc0Trace.unlockAt??=performance.now()-window.__esc0Trace.start};window.addEventListener('blur',window.__escBlurWatch);document.addEventListener('pointerlockchange',window.__escLockWatch);return document.hasFocus();})()`);
  await pressEscape(c);
  const promptlyUnlocked = await waitLock(c, false, 500);
  await sleep(700);
  s = await ev(c, lockState);
  const escapeTrace = await ev(c, `(()=>{window.removeEventListener('blur',window.__escBlurWatch);document.removeEventListener('pointerlockchange',window.__escLockWatch);const r={focused:document.hasFocus(),...window.__esc0Trace};delete window.__escBlurWatch;delete window.__escLockWatch;delete window.__esc0Trace;return r;})()`);
  const unlockedBeforeBlur = escapeTrace.unlockAt !== null && (escapeTrace.blurAt === null || escapeTrace.unlockAt <= escapeTrace.blurAt);
  push(
    "0-first-esc-unlocks",
    focusBeforeEscape && unlockedBeforeBlur && !promptlyUnlocked.el && !promptlyUnlocked.locked && !s.el && !s.locked,
    `after one Esc: promptEl=${promptlyUnlocked.el} promptLocked=${promptlyUnlocked.locked}; finalEl=${s.el} finalLocked=${s.locked}; unlockAt=${escapeTrace.unlockAt}ms blurAt=${escapeTrace.blurAt}ms focused=${escapeTrace.focused}`
  );

  // ---- A. ISOLATION: bare exitPointerLock() then sample. Proves whether the app
  // re-locks on its own (which would explain "Esc sometimes doesn't unlock").
  console.log("[probe] test A: bare exitPointerLock isolation");
  try {
    const beforeExit = await lockViaClick();
    if (!beforeExit.el || !beforeExit.locked) {
      push("A-bare-exit-stays-unlocked", false, `lock precondition failed: el=${beforeExit.el} locked=${beforeExit.locked}`);
    } else {
      // install a pointerlockchange tracer to see every transition
      await ev(c, `(()=>{window.__lc=[];window.__lcHandler=()=>window.__lc.push(!!document.pointerLockElement);document.addEventListener('pointerlockchange',window.__lcHandler);return true;})()`);
      await ev(c, `(()=>{document.exitPointerLock();return true;})()`);
      const samples = [];
      for (const ms of [0, 150, 400, 900, 1600]) { await sleep(ms === 0 ? 30 : ms - (samples.length ? [0,150,400,900,1600][samples.length-1] : 0)); samples.push((await ev(c, lockState)).el); }
      const trace = await ev(c, `window.__lc`);
      s = await ev(c, lockState);
      push("A-bare-exit-stays-unlocked", !s.el && !s.locked, `bare exitPointerLock: final el=${s.el} locked=${s.locked}; samples=[${samples}]; lockchange-trace=[${trace}]`);
      await ev(c, `document.removeEventListener('pointerlockchange',window.__lcHandler)`);
    }
  } catch (e) { push("A-bare-exit-stays-unlocked", false, `errored: ${String(e).slice(0, 120)}`); }

  // ---- B. stale free cursor + Escape must stay unlocked (no heal-and-relock)
  console.log("[probe] test B: stale free cursor + Esc");
  try {
    await ev(c, `(()=>{const i=window.__sf.input;i.freeCursor=true;i.onFreeCursorChange(true);document.exitPointerLock();return true;})()`);
    await sleep(300);
    await pressEscape(c);
    await sleep(1200);
    s = await ev(c, lockState);
    push("B-esc-stale-freecursor", !s.el && !s.locked, `after Esc w/ stale freeCursor: el=${s.el} locked=${s.locked} freeCursor=${s.free}`);
    // clean the flag for later tests
    await ev(c, `(()=>{window.__sf.input.freeCursor=false;window.__sf.input.onFreeCursorChange(false);return true;})()`);
  } catch (e) { push("B-esc-stale-freecursor", false, `errored: ${String(e).slice(0, 120)}`); }

  // ---- C. overlay open + locked: one Esc still unlocks. Chrome may reserve
  // that keydown for native pointer-lock exit instead of delivering it onward
  // to the minimap's dismissal handler; modal state is logged but not asserted.
  console.log("[probe] test C: overlay + Esc unlocks");
  try {
    s = await lockViaClick(); // re-lock (trusted gesture, retried)
    if (!s.el) { push("C-esc-overlay-unlocks", false, "could not re-lock for overlay test"); }
    else {
      await ev(c, `(()=>{window.__lc2=[];window.__lch=()=>window.__lc2.push((document.pointerLockElement?'L':'U'));document.addEventListener('pointerlockchange',window.__lch);return true;})()`);
      await ev(c, `(()=>{window.__sf.minimap.setExpanded(true);return true;})()`);
      // Opening normally releases lock. Re-grant it explicitly so this really
      // exercises the otherwise-racy modal + locked state from the bug report.
      await evGesture(c, `(()=>{window.__sf.input.requestLock();return true;})()`);
      const afterOpen = await waitLock(c, true, 3000);
      if (!afterOpen.el) {
        push("C-esc-overlay-unlocks", false, "could not re-lock with minimap open");
      } else {
        await pressEscape(c);
        await sleep(1200);
        const exp = await ev(c, `window.__sf.minimap.expanded`);
        const trace = await ev(c, `window.__lc2`);
        s = await ev(c, lockState);
        // One Esc must BOTH release the lock AND close the overlay — even though
        // Chrome reserves the locked keydown for its native pointer-lock exit,
        // the keyup mirror in main.ts still closes the map on the same press.
        push("C-esc-overlay-unlocks", !s.el && !s.locked && exp === false, `open+relock→el=${afterOpen.el}; after Esc: expanded=${exp} el=${s.el} locked=${s.locked}; trace=[${trace}]`);
      }
      await ev(c, `document.removeEventListener('pointerlockchange',window.__lch)`);
    }
  } catch (e) { push("C-esc-overlay-unlocks", false, `errored: ${String(e).slice(0, 120)}`); }

  // ---- D. Focused UI fields own their local clear/blur behavior, but the
  // earlier input-layer capture listener must still release pointer lock first.
  console.log("[probe] test D: focused tuning field + Esc unlocks");
  try {
    const focusedSetup = await ev(c, `(()=>{const d=window.__sf.debugPanel;if(!d.visible)d.toggle();const q=document.querySelector('input[aria-label="Search tweaks"]');if(!q)return false;q.value='escape-regression';q.dispatchEvent(new Event('input',{bubbles:true}));q.focus();return document.activeElement===q;})()`);
    await c.send("Page.bringToFront");
    await evGesture(c, `(()=>{window.__sf.input.requestLock();return true;})()`);
    s = await waitLock(c, true, 3000);
    const focusedBefore = await ev(c, `document.activeElement?.getAttribute?.('aria-label')`);
    if (!focusedSetup || focusedBefore !== "Search tweaks") {
      push("D-focused-field-esc-unlocks", false, `tuning field focus precondition failed; active=${focusedBefore}`);
    } else if (!s.el) {
      push("D-focused-field-esc-unlocks", false, `could not lock with tuning field focused; active=${focusedBefore}`);
    } else {
      // Chrome may reserve a trusted Escape exclusively for native pointer-lock
      // exit, never delivering it to the focused field. Test 0 covers that path;
      // dispatch here so capture-before-field-consumption is deterministic.
      await ev(c, `(()=>{const q=document.querySelector('input[aria-label="Search tweaks"]');return q?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));})()`);
      await sleep(1200);
      const focusedAfter = await ev(c, `document.activeElement?.getAttribute?.('aria-label')`);
      const queryAfter = await ev(c, `document.querySelector('input[aria-label="Search tweaks"]')?.value`);
      s = await ev(c, lockState);
      push("D-focused-field-esc-unlocks", focusedAfter === "Search tweaks" && queryAfter === "" && !s.el && !s.locked, `active before=${focusedBefore}; after one Esc: active=${focusedAfter} query=${JSON.stringify(queryAfter)} el=${s.el} locked=${s.locked}`);
      await ev(c, `window.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`);
    }
    await ev(c, `(()=>{const d=window.__sf.debugPanel;if(d.visible)d.toggle();return true;})()`);
  } catch (e) { push("D-focused-field-esc-unlocks", false, `errored: ${String(e).slice(0, 120)}`); }

  // ---- E. A mouse-up after Escape still completes the click whose down event
  // began while locked. That old click must not be treated as a fresh intent to
  // capture the pointer again.
  console.log("[probe] test E: held primary + Esc stays unlocked after mouse-up");
  try {
    s = await lockViaClick();
    if (!s.el) {
      push("E-held-primary-esc-stays-unlocked", false, "could not re-lock for held-primary test");
    } else {
      await ev(c, `(()=>{const i=window.__sf.input;const canvas=document.querySelector('canvas');window.__escEOriginalRequestLock=i.requestLock;window.__escERequestLockCalls=0;window.__escEClickEvents=0;window.__escEClickHandler=()=>window.__escEClickEvents++;i.requestLock=function(...args){window.__escERequestLockCalls++;return window.__escEOriginalRequestLock.apply(this,args);};canvas.addEventListener('click',window.__escEClickHandler);return true;})()`);
      await mouseDown(c, W / 2, H / 2);
      await escapeDown(c);
      const afterEscape = await waitLock(c, false, 3000);
      await mouseUp(c, W / 2, H / 2);
      await ev(c, `document.querySelector('canvas').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}))`);
      const clickContract = await ev(c, `({clicks:window.__escEClickEvents,requests:window.__escERequestLockCalls})`);
      await escapeUp(c);
      await sleep(1200);
      s = await ev(c, lockState);
      push(
        "E-held-primary-esc-stays-unlocked",
        !afterEscape.el && !afterEscape.locked && clickContract.clicks >= 1 && clickContract.requests === 0 && !s.el && !s.locked,
        `after Esc: el=${afterEscape.el} locked=${afterEscape.locked}; clickEvents=${clickContract.clicks} requestLockCalls=${clickContract.requests}; after mouse-up: el=${s.el} locked=${s.locked}`
      );
      await ev(c, `(()=>{const i=window.__sf.input;const canvas=document.querySelector('canvas');if(window.__escEOriginalRequestLock)i.requestLock=window.__escEOriginalRequestLock;if(window.__escEClickHandler)canvas.removeEventListener('click',window.__escEClickHandler);delete window.__escEOriginalRequestLock;delete window.__escERequestLockCalls;delete window.__escEClickEvents;delete window.__escEClickHandler;return true;})()`);
    }
  } catch (e) {
    try { await ev(c, `(()=>{const i=window.__sf?.input;const canvas=document.querySelector('canvas');if(i&&window.__escEOriginalRequestLock)i.requestLock=window.__escEOriginalRequestLock;if(canvas&&window.__escEClickHandler)canvas.removeEventListener('click',window.__escEClickHandler);return true;})()`); } catch {}
    push("E-held-primary-esc-stays-unlocked", false, `errored: ${String(e).slice(0, 120)}`);
  }

  // ---- F. Chrome can arbitrate Escape between fullscreen and pointer lock.
  // The app's fullscreenchange safety net must make pointer release invariant.
  console.log("[probe] test F: fullscreen + Esc unlocks on first press");
  try {
    const entered = await evGesture(c, `(async()=>{try{await document.documentElement.requestFullscreen();return !!document.fullscreenElement;}catch(e){return false;}})()`);
    const fullscreen = entered && await waitFor(c, `!!document.fullscreenElement`, 3000);
    if (!fullscreen) {
      push("F-fullscreen-esc-unlocks", false, "could not enter Fullscreen API state");
    } else {
      s = await lockViaClick();
      if (!s.el) {
        push("F-fullscreen-esc-unlocks", false, "could not lock while fullscreen");
      } else {
        await pressEscape(c);
        await sleep(1200);
        s = await ev(c, lockState);
        const stillFullscreen = await ev(c, `!!document.fullscreenElement`);
        push(
          "F-fullscreen-esc-unlocks",
          !s.el && !s.locked,
          `after one Esc: fullscreen=${stillFullscreen} el=${s.el} locked=${s.locked}`
        );
      }
    }
    if (await ev(c, `!!document.fullscreenElement`)) {
      await ev(c, `document.exitFullscreen()`);
      await waitFor(c, `!document.fullscreenElement`, 3000);
    }
  } catch (e) { push("F-fullscreen-esc-unlocks", false, `errored: ${String(e).slice(0, 120)}`); }

  // ---- G. Some input paths provide key="Escape" without code="Escape".
  // Count requestLock calls directly because a synthetic event has no user
  // activation and Chrome could otherwise hide the bug by rejecting the grant.
  console.log("[probe] test G: code-less chat Escape never requests re-lock");
  try {
    await ev(c, `(()=>{const i=window.__sf.input;const q=document.querySelector('input[aria-label="Chat message"]');if(!q)return false;q.focus();window.__escOriginalRequestLock=i.requestLock;window.__escRequestLockCalls=0;i.requestLock=function(...args){window.__escRequestLockCalls++;return window.__escOriginalRequestLock.apply(this,args);};return document.activeElement===q;})()`);
    await c.send("Page.bringToFront");
    await evGesture(c, `(()=>{window.__sf.input.requestLock();return true;})()`);
    s = await waitLock(c, true, 3000);
    if (!s.el) {
      push("G-codeless-chat-esc-no-relock", false, "could not lock with chat focused");
    } else {
      await ev(c, `(()=>{window.__escRequestLockCalls=0;const q=document.querySelector('input[aria-label="Chat message"]');return q?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'',bubbles:true,cancelable:true}));})()`);
      const afterCodeLessEscape = await waitLock(c, false, 500);
      await sleep(500);
      const requestCalls = await ev(c, `window.__escRequestLockCalls`);
      const focused = await ev(c, `document.activeElement?.getAttribute?.('aria-label')`);
      s = await ev(c, lockState);
      push(
        "G-codeless-chat-esc-no-relock",
        requestCalls === 0 && !afterCodeLessEscape.el && !afterCodeLessEscape.locked && !s.el && !s.locked,
        `requestLock calls=${requestCalls}; active=${focused}; promptEl=${afterCodeLessEscape.el} promptLocked=${afterCodeLessEscape.locked}; finalEl=${s.el} finalLocked=${s.locked}`
      );
      await ev(c, `window.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'',bubbles:true,cancelable:true}))`);
    }
    await ev(c, `(()=>{const i=window.__sf.input;if(window.__escOriginalRequestLock)i.requestLock=window.__escOriginalRequestLock;delete window.__escOriginalRequestLock;delete window.__escRequestLockCalls;document.querySelector('input[aria-label="Chat message"]')?.blur();return true;})()`);
  } catch (e) {
    try { await ev(c, `(()=>{const i=window.__sf?.input;if(i&&window.__escOriginalRequestLock)i.requestLock=window.__escOriginalRequestLock;delete window.__escOriginalRequestLock;delete window.__escRequestLockCalls;return true;})()`); } catch {}
    push("G-codeless-chat-esc-no-relock", false, `errored: ${String(e).slice(0, 120)}`);
  }

  // ---- H. Chromium/Firefox may consume the locked keydown but later expose a
  // keyup. A synthetic keyup has no browser default, so this isolates the app's
  // fallback instead of passing on the UA's eventual native unlock.
  console.log("[probe] test H: keyup-only Escape releases pointer lock");
  try {
    s = await lockViaClick();
    if (!s.el) {
      push("H-keyup-only-esc-unlocks", false, "could not re-lock for keyup-only test");
    } else {
      await ev(c, `window.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`);
      const afterKeyup = await waitLock(c, false, 500);
      await sleep(800);
      s = await ev(c, lockState);
      push(
        "H-keyup-only-esc-unlocks",
        !afterKeyup.el && !afterKeyup.locked && !s.el && !s.locked,
        `after Escape keyup only: promptEl=${afterKeyup.el} promptLocked=${afterKeyup.locked}; finalEl=${s.el} finalLocked=${s.locked}`
      );
    }
  } catch (e) { push("H-keyup-only-esc-unlocks", false, `errored: ${String(e).slice(0, 120)}`); }

  // ---- I. pointerlockchange may arrive before keyup. It cancels old intent but
  // must not end the Escape transaction or let an async callback request again.
  console.log("[probe] test I: Escape barrier survives unlock until keyup");
  try {
    s = await lockViaClick();
    if (!s.el) {
      push("I-esc-barrier-survives-unlock", false, "could not re-lock for Escape barrier test");
    } else {
      await ev(c, `(()=>{const canvas=document.querySelector('canvas');window.__escIOriginalPointerLock=canvas.requestPointerLock;window.__escIPointerLockCalls=0;canvas.requestPointerLock=function(...args){window.__escIPointerLockCalls++;return window.__escIOriginalPointerLock.apply(this,args);};window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));return true;})()`);
      const afterDown = await waitLock(c, false, 500);
      await ev(c, `window.__sf.input.requestLock()`);
      await sleep(200);
      const requests = await ev(c, `window.__escIPointerLockCalls`);
      s = await ev(c, lockState);
      await ev(c, `window.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`);
      push(
        "I-esc-barrier-survives-unlock",
        !afterDown.el && !afterDown.locked && requests === 0 && !s.el && !s.locked,
        `after keydown: el=${afterDown.el} locked=${afterDown.locked}; requestPointerLock calls before keyup=${requests}; finalEl=${s.el} finalLocked=${s.locked}`
      );
      await ev(c, `(()=>{const canvas=document.querySelector('canvas');if(window.__escIOriginalPointerLock)canvas.requestPointerLock=window.__escIOriginalPointerLock;delete window.__escIOriginalPointerLock;delete window.__escIPointerLockCalls;return true;})()`);
    }
  } catch (e) {
    try { await ev(c, `(()=>{const canvas=document.querySelector('canvas');if(canvas&&window.__escIOriginalPointerLock)canvas.requestPointerLock=window.__escIOriginalPointerLock;return true;})()`); } catch {}
    push("I-esc-barrier-survives-unlock", false, `errored: ${String(e).slice(0, 120)}`);
  }

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
