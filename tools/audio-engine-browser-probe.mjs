// Single-AudioContext invariant probe for the consolidated audio engine.
//
// The app used to spin up ~10 AudioContexts (one per feature); they were folded
// into src/audio/engine.ts (`audioEngine`, one ctx, four group buses). This probe
// proves the invariant at RUNTIME in a real headless-Chrome/WebGPU boot:
//   - a counting proxy wraps window.AudioContext BEFORE any app code runs, so
//     every `new AudioContext()` anywhere in the app is tallied,
//   - OfflineAudioContext is wrapped separately (allowed, but 0 in normal play),
//   - exactly ONE ctx exists at boot and it sits SUSPENDED (no gesture yet),
//   - a real (trusted) CDP key gesture + a short walk unlocks it to RUNNING with
//     the effects group climbing above zero, still exactly one ctx,
//   - muting via the HUD creates no new ctx,
//   - final tally is still exactly 1 AudioContext, 0 OfflineAudioContexts.
//
// Self-contained: launches its OWN vite on a fresh free port (never reuses 5179)
// and tears it down. No external server needed.
//
//   node tools/audio-engine-browser-probe.mjs
// Env: CHROME_BIN (chrome/chromium path override).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/audio-engine-probe");
const W = 1280, H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
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
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
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
      if (!m.id) { if (this.onEvent) this.onEvent(m); return; }
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

async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

async function setKey(c, down, code, key, vk) {
  await c.send("Input.dispatchKeyEvent", {
    type: down ? "keyDown" : "keyUp",
    code,
    key,
    windowsVirtualKeyCode: vk
  });
}

// Installed via Page.addScriptToEvaluateOnNewDocument, so it runs BEFORE any app
// module. Wraps the constructors in place, preserving real construction, and
// stashes tallies on window. `new Orig(...)` inside a plain function called with
// `new` returns a genuine (Offline)AudioContext with the native prototype chain.
const PROBE_INIT = `(() => {
  const wrapCounting = (name) => {
    const Orig = window[name];
    if (typeof Orig !== "function") return;
    const probe = window.__audioCtxProbe || (window.__audioCtxProbe = {
      count: 0,
      instances: [],
      states: () => window.__audioCtxProbe.instances.map((c) => {
        try { return c.state; } catch { return "gone"; }
      })
    });
    function Wrapped(...args) {
      const inst = new Orig(...args);
      probe.count++;
      probe.instances.push(inst);
      return inst;
    }
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window[name] = Wrapped;
  };
  wrapCounting("AudioContext");
  wrapCounting("webkitAudioContext");

  const Offline = window.OfflineAudioContext;
  if (typeof Offline === "function") {
    window.__offlineAudioCtxProbe = { count: 0 };
    function WrappedOffline(...args) {
      window.__offlineAudioCtxProbe.count++;
      return new Offline(...args);
    }
    WrappedOffline.prototype = Offline.prototype;
    Object.setPrototypeOf(WrappedOffline, Offline);
    window.OfflineAudioContext = WrappedOffline;
    if (typeof window.webkitOfflineAudioContext === "function") {
      window.webkitOfflineAudioContext = WrappedOffline;
    }
  }
})();`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = findChrome();
  const vitePort = await freePort();
  const relayPort = await freePort();
  const serverUrl = `http://127.0.0.1:${vitePort}`;
  console.log(`[probe] root=${ROOT} server=${serverUrl}`);

  // Own vite on a FRESH free port with --strictPort so we never silently land on
  // (or collide with) a human's 5179 dev server. --host 127.0.0.1 keeps it local.
  const vite = spawn(
    "npx",
    ["vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  vite.stdout.on("data", () => {});
  vite.stderr.on("data", (d) => { const s = String(d); if (/error/i.test(s)) console.error("[vite]", s.slice(0, 400)); });

  const profileDir = path.join(OUT, "chrome-profile");
  rmSync(profileDir, { recursive: true, force: true });
  const debugPort = await freePort();
  // NOTE: deliberately NO --autoplay-policy=no-user-gesture-required — the whole
  // point is to observe the ctx staying suspended until a real gesture.
  const proc = spawn(chrome, [
    `--user-data-dir=${profileDir}`, "--headless=new", `--remote-debugging-port=${debugPort}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--hide-scrollbars", "--mute-audio",
    `--window-size=${W},${H}`, "about:blank"
  ], { cwd: ROOT, stdio: "ignore" });

  let cdp = null;
  const errors = [];
  try {
    await waitHttp(serverUrl, 60_000, "vite");

    let page;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
        page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {}
      await sleep(300);
    }
    if (!page) throw new Error("no page target");

    cdp = new Cdp(page.webSocketDebuggerUrl);
    cdp.onEvent = (m) => {
      if (m.method === "Runtime.consoleAPICalled") {
        if (m.params.type !== "error") return;
        errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push(((d.exception && (d.exception.description || d.exception.value)) || d.text || "").slice(0, 300));
      }
    };
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    // Wrap the constructors before the very first document script runs.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE_INIT });
    await cdp.send("Page.navigate", { url: `${serverUrl}/?autostart=1` });

    // ---- world-ready wait (mirrors the player-audio browser probe) ----
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 120_000) {
      await sleep(500);
      try {
        ready = await ev(cdp, "!!(window.__sf?.renderIdle?.() && window.__sf?.worldArrival?.active === false)");
        if (ready) break;
      } catch {}
    }
    if (!ready) throw new Error("world never became ready within 120s");
    await sleep(1200);

    // ---- 3) boot invariant: exactly one, suspended, no gesture ----
    const boot = await ev(cdp, `(() => ({
      count: window.__audioCtxProbe?.count ?? -1,
      states: window.__audioCtxProbe?.states?.() ?? [],
      offline: window.__offlineAudioCtxProbe?.count ?? -1,
      debug: window.__sf?.audioEngine?.debugState ?? null
    }))()`);
    const bootErrors = errors.filter((e) => /audio\s*context|audiocontext|\baudio\b/i.test(e));

    assert.equal(boot.count, 1, `boot should construct exactly 1 AudioContext, got ${boot.count} (states ${JSON.stringify(boot.states)})`);
    assert.equal(boot.states[0], "suspended", `boot ctx should be suspended before any gesture, got ${boot.states[0]}`);
    assert.equal(boot.offline, 0, `no OfflineAudioContext expected at boot, got ${boot.offline}`);
    assert.equal(boot.debug?.unlocked, false, `engine should report locked before gesture, got ${JSON.stringify(boot.debug)}`);
    assert.deepEqual(bootErrors, [], `audio-related console errors at boot:\n${bootErrors.join("\n")}`);

    // ---- 4) real gesture + short walk unlocks the single ctx ----
    // A CDP key event is trusted, so it satisfies the browser's user-activation
    // gate exactly like a human keypress. Hold W to actually walk a moment.
    await setKey(cdp, true, "KeyW", "w", 87);
    await sleep(2000);
    await setKey(cdp, false, "KeyW", "w", 87);
    await sleep(400);

    const live = await ev(cdp, `(() => ({
      count: window.__audioCtxProbe?.count ?? -1,
      states: window.__audioCtxProbe?.states?.() ?? [],
      offline: window.__offlineAudioCtxProbe?.count ?? -1,
      debug: window.__sf?.audioEngine?.debugState ?? null
    }))()`);

    assert.equal(live.count, 1, `still exactly 1 AudioContext after gesture, got ${live.count} (states ${JSON.stringify(live.states)})`);
    assert.equal(live.states[0], "running", `ctx should be running after gesture, got ${live.states[0]}`);
    assert.equal(live.debug?.unlocked, true, `engine should report unlocked after gesture, got ${JSON.stringify(live.debug)}`);
    assert(live.debug?.levels?.effects > 0, `effects group level should climb above 0 after unlock, got ${live.debug?.levels?.effects}`);

    // ---- 5) mute via the HUD mute button — a real exported path from window ----
    // AudioControls appends `#hud .mute-btn`; clicking it flips AUDIO_PREFS.enabled.
    const muteInfo = await ev(cdp, `(() => {
      const btn = document.querySelector('#hud .mute-btn');
      if (!btn) return { clicked: false };
      btn.click();
      return { clicked: true };
    })()`);
    let mutedDebug = null;
    if (muteInfo.clicked) {
      await sleep(1200);
      mutedDebug = await ev(cdp, "window.__sf?.audioEngine?.debugState ?? null");
    } else {
      console.warn("[probe] mute button not found; skipping mute assertion (no clean window path)");
    }

    // ---- 6) final tally: still exactly one ctx, zero offline ----
    const end = await ev(cdp, `(() => ({
      count: window.__audioCtxProbe?.count ?? -1,
      states: window.__audioCtxProbe?.states?.() ?? [],
      offline: window.__offlineAudioCtxProbe?.count ?? -1,
      debug: window.__sf?.audioEngine?.debugState ?? null
    }))()`);

    assert.equal(end.count, 1, `end: single-context invariant broken — ${end.count} AudioContexts (states ${JSON.stringify(end.states)})`);
    assert.equal(end.offline, 0, `end: OfflineAudioContext count should be 0, got ${end.offline}`);

    const audioErrors = errors.filter((e) => /audio\s*context|audiocontext|\baudio\b/i.test(e));
    assert.deepEqual(audioErrors, [], `audio-related console errors:\n${audioErrors.join("\n")}`);

    console.log("\naudio engine browser probe: PASS");
    console.log(JSON.stringify({
      boot: { count: boot.count, states: boot.states, offline: boot.offline, debug: boot.debug },
      afterGesture: { count: live.count, states: live.states, offline: live.offline, debug: live.debug },
      afterMute: { clicked: muteInfo.clicked, debug: mutedDebug },
      final: { count: end.count, states: end.states, offline: end.offline, debug: end.debug },
      totalConsoleErrors: errors.length
    }, null, 2));
  } finally {
    if (cdp) cdp.close();
    proc.kill("SIGKILL");
    // npx spawns vite as a child; kill the whole detached group so it can't orphan.
    try { process.kill(-vite.pid, "SIGKILL"); } catch { vite.kill("SIGKILL"); }
    await sleep(300);
  }
}

main().catch((err) => { console.error("audio engine browser probe: FAIL\n", err); process.exit(1); });
