// Single-AudioContext invariant probe for the consolidated audio engine.
//
// The app used to spin up ~10 AudioContexts (one per feature); they were folded
// into src/audio/engine.ts (`audioEngine`, one ctx, four group buses). This probe
// proves the invariant at RUNTIME in a real headless-Chrome/WebGPU boot:
//   - a counting proxy wraps window.AudioContext BEFORE any app code runs, so
//     every `new AudioContext()` anywhere in the app is tallied,
//   - OfflineAudioContext is wrapped separately (allowed, but 0 in normal play),
//   - exactly ONE ctx exists at boot and it sits SUSPENDED (no gesture yet),
//   - a no-op unlock does not instantiate vehicle/swim/firework graphs and the
//     context returns to SUSPENDED when its explicit activity hold expires,
//   - a short walk unlocks it to RUNNING with the effects group above zero,
//   - overlapping external nature leases release independently,
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
  const webAudio = {
    nodes: new Set(),
    params: new Set(),
    peakNodes: 0,
    peakParams: 0,
    contextStates: []
  };
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
      } else if (m.method === "WebAudio.audioNodeCreated") {
        webAudio.nodes.add(m.params.node.nodeId);
        webAudio.peakNodes = Math.max(webAudio.peakNodes, webAudio.nodes.size);
      } else if (m.method === "WebAudio.audioNodeWillBeDestroyed") {
        webAudio.nodes.delete(m.params.nodeId);
      } else if (m.method === "WebAudio.audioParamCreated") {
        webAudio.params.add(m.params.param.paramId);
        webAudio.peakParams = Math.max(webAudio.peakParams, webAudio.params.size);
      } else if (m.method === "WebAudio.audioParamWillBeDestroyed") {
        webAudio.params.delete(m.params.paramId);
      } else if (m.method === "WebAudio.contextCreated" || m.method === "WebAudio.contextChanged") {
        webAudio.contextStates.push(m.params.context.contextState);
      }
    };
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("WebAudio.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    // Wrap the constructors before the very first document script runs.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE_INIT });
    await cdp.send("Page.navigate", { url: `${serverUrl}/?autostart=1&spawn=transamerica` });

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
      debug: window.__sf?.audioEngine?.debugState ?? null,
      featureGraphs: {
        vehicle: window.__sf?.vehicleAudio?.debugState?.ctx ?? "missing",
        swim: window.__sf?.swimAudio?.debugState?.ctx ?? "missing",
        fireworks: window.__sf?.fireworks?.audio?.debugState?.ctx ?? "missing"
      }
    }))()`);
    const bootErrors = errors.filter((e) => /audio\s*context|audiocontext|\baudio\b/i.test(e));

    assert.equal(boot.count, 1, `boot should construct exactly 1 AudioContext, got ${boot.count} (states ${JSON.stringify(boot.states)})`);
    assert.equal(boot.states[0], "suspended", `boot ctx should be suspended before any gesture, got ${boot.states[0]}`);
    assert.equal(boot.offline, 0, `no OfflineAudioContext expected at boot, got ${boot.offline}`);
    assert.equal(boot.debug?.unlocked, false, `engine should report locked before gesture, got ${JSON.stringify(boot.debug)}`);
    assert.deepEqual(
      boot.featureGraphs,
      { vehicle: "none", swim: "none", fireworks: "none" },
      `optional continuous graphs were built at clean boot: ${JSON.stringify(boot.featureGraphs)}`
    );
    assert.deepEqual(bootErrors, [], `audio-related console errors at boot:\n${bootErrors.join("\n")}`);
    const bootNodes = webAudio.nodes.size;
    const bootParams = webAudio.params.size;

    // ---- 4) no-op gesture: resume only for a real hold, then idle-suspend ----
    await setKey(cdp, true, "Slash", "/", 191);
    await setKey(cdp, false, "Slash", "/", 191);
    await ev(cdp, "window.__sf.audioEngine.touch(0.4)");
    await sleep(120);
    const held = await ev(cdp, `(() => ({
      state: window.__audioCtxProbe.states()[0],
      debug: window.__sf.audioEngine.debugState,
      featureGraphs: {
        vehicle: window.__sf.vehicleAudio.debugState.ctx,
        swim: window.__sf.swimAudio.debugState.ctx,
        fireworks: window.__sf.fireworks.audio.debugState.ctx
      }
    }))()`);
    assert.equal(held.state, "running", `explicit hold did not resume ctx: ${JSON.stringify(held)}`);
    assert.deepEqual(
      held.featureGraphs,
      { vehicle: "none", swim: "none", fireworks: "none" },
      `no-op unlock constructed optional graphs: ${JSON.stringify(held.featureGraphs)}`
    );
    assert.equal(webAudio.nodes.size, bootNodes, `no-op unlock added WebAudio nodes (${bootNodes} -> ${webAudio.nodes.size})`);
    assert.equal(webAudio.params.size, bootParams, `no-op unlock added AudioParams (${bootParams} -> ${webAudio.params.size})`);
    await sleep(1000);
    const idle = await ev(cdp, `(() => ({
      state: window.__audioCtxProbe.states()[0],
      debug: window.__sf.audioEngine.debugState
    }))()`);
    assert.equal(idle.debug.hold, 0, `timed hold did not expire: ${JSON.stringify(idle)}`);
    assert.equal(idle.debug.persistent, 0, `unexpected persistent hold: ${JSON.stringify(idle)}`);
    assert.equal(idle.state, "suspended", `idle ctx stayed on with no activity: ${JSON.stringify(idle)}`);

    // Leases are token-owned: releasing A must not cancel B.
    const leases = await ev(cdp, `(() => {
      const a = window.__sf.nature.acquireExternalHold("probe-a");
      const b = window.__sf.nature.acquireExternalHold("probe-b");
      const both = window.__sf.nature.debugState.externalHolds;
      a();
      const one = window.__sf.nature.debugState.externalHolds;
      a();
      const idempotent = window.__sf.nature.debugState.externalHolds;
      b();
      const zero = window.__sf.nature.debugState.externalHolds;
      return { both, one, idempotent, zero };
    })()`);
    assert.equal(leases.both.count, 2);
    assert.equal(leases.one.count, 1);
    assert.equal(leases.idempotent.count, 1);
    assert.equal(leases.zero.count, 0);

    // ---- 5) real movement + short walk uses the fundamental SFX graph ----
    // A CDP key event is trusted, so it satisfies the browser's user-activation
    // gate exactly like a human keypress. Hold W to actually walk a moment.
    await setKey(cdp, true, "KeyW", "w", 87);
    await sleep(2000);

    const live = await ev(cdp, `(() => ({
      count: window.__audioCtxProbe?.count ?? -1,
      states: window.__audioCtxProbe?.states?.() ?? [],
      offline: window.__offlineAudioCtxProbe?.count ?? -1,
      debug: window.__sf?.audioEngine?.debugState ?? null
    }))()`);
    await setKey(cdp, false, "KeyW", "w", 87);
    await sleep(400);

    assert.equal(live.count, 1, `still exactly 1 AudioContext after gesture, got ${live.count} (states ${JSON.stringify(live.states)})`);
    assert.equal(live.states[0], "running", `ctx should be running after gesture, got ${live.states[0]}`);
    assert.equal(live.debug?.unlocked, true, `engine should report unlocked after gesture, got ${JSON.stringify(live.debug)}`);
    assert(live.debug?.levels?.effects > 0, `effects group level should climb above 0 after unlock, got ${live.debug?.levels?.effects}`);

    // Walking must not create vehicle or swim graphs either.
    const walkingGraphs = await ev(cdp, `({
      vehicle: window.__sf.vehicleAudio.debugState.ctx,
      swim: window.__sf.swimAudio.debugState.ctx,
      fireworks: window.__sf.fireworks.audio.debugState.ctx
    })`);
    assert.deepEqual(walkingGraphs, { vehicle: "none", swim: "none", fireworks: "none" });

    await sleep(1400);
    const afterTail = await ev(cdp, `({
      state: window.__audioCtxProbe.states()[0],
      debug: window.__sf.audioEngine.debugState
    })`);
    assert.equal(afterTail.state, "suspended", `walk/foley tail did not idle-suspend: ${JSON.stringify(afterTail)}`);

    // First-use construction is incremental: board activation must not build
    // the seven other vehicle voices. Swim's continuous source must park after
    // its release envelope instead of looping forever at zero gain.
    const activation = await ev(cdp, `(() => {
      const board = { mode: "board", speed: 12, vspeed: 0, boost: false, grounded: true };
      window.__sf.vehicleAudio.update(1 / 60, board);
      const vehicle = window.__sf.vehicleAudio.debugState;
      window.__sf.swimAudio.update(1 / 60, { swimming: true, speed: 1.5, vspeed: -1 });
      const swimActive = window.__sf.swimAudio.debugState;
      for (let i = 0; i < 420; i++) {
        window.__sf.swimAudio.update(1 / 60, { swimming: false, speed: 0, vspeed: 0 });
      }
      const swimParked = window.__sf.swimAudio.debugState;
      return { vehicle, swimActive, swimParked };
    })()`);
    assert.deepEqual(
      activation.vehicle.voices.map((voice) => voice.mode),
      ["board"],
      `board first-use built unrelated vehicle voices: ${JSON.stringify(activation.vehicle.voices)}`
    );
    assert.equal(activation.swimActive.ambienceRunning, true, "swim source did not start on first water entry");
    assert.equal(activation.swimParked.ambienceRunning, false, `swim source did not park: ${JSON.stringify(activation.swimParked)}`);

    // A maximum one-second firework volley used to leave hundreds of ended
    // per-boom nodes connected forever. After the 2.9s direct tail and a GC,
    // only the one reusable echo graph may remain.
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(120);
    const fireworkNodesBefore = webAudio.nodes.size;
    await ev(cdp, `(() => {
      for (let i = 0; i < 18; i++) {
        window.__sf.fireworks.audio.boom(10 + i * 0.1, 20, 0, 0, 0, 0, 0, 1);
      }
      return window.__sf.fireworks.audio.debugState;
    })()`);
    await sleep(180);
    const fireworkNodesPeak = webAudio.nodes.size;
    assert(
      fireworkNodesPeak >= fireworkNodesBefore + 200,
      `firework stress did not instantiate the expected transient graph (${fireworkNodesBefore} -> ${fireworkNodesPeak})`
    );
    await sleep(3700);
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(180);
    const fireworkNodesAfter = webAudio.nodes.size;
    assert(
      fireworkNodesAfter <= fireworkNodesBefore + 16,
      `firework voices accumulated after their tails (${fireworkNodesBefore} -> peak ${fireworkNodesPeak} -> ${fireworkNodesAfter})`
    );
    const fireworkCleanup = {
      before: fireworkNodesBefore,
      peak: fireworkNodesPeak,
      after: fireworkNodesAfter,
      retainedReusableGraph: fireworkNodesAfter - fireworkNodesBefore
    };

    // ---- 6) mute via the HUD mute button — a real exported path from window ----
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

    // ---- 7) final tally: still exactly one ctx, zero offline ----
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
      boot: { count: boot.count, states: boot.states, offline: boot.offline, debug: boot.debug, featureGraphs: boot.featureGraphs, nodes: bootNodes, params: bootParams },
      noOpHeld: held,
      idleAfterNoOp: idle,
      leases,
      afterGesture: { count: live.count, states: live.states, offline: live.offline, debug: live.debug },
      walkingGraphs,
      idleAfterWalkTail: afterTail,
      firstUseActivation: activation,
      fireworkCleanup,
      afterMute: { clicked: muteInfo.clicked, debug: mutedDebug },
      final: { count: end.count, states: end.states, offline: end.offline, debug: end.debug },
      webAudio: { liveNodes: webAudio.nodes.size, liveParams: webAudio.params.size, peakNodes: webAudio.peakNodes, peakParams: webAudio.peakParams, contextStates: webAudio.contextStates },
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
