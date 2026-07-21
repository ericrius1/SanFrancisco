// Generative lo-fi music probe — real headless-Chrome/WebGPU boot.
//
// Verifies the three-phase lazy contract and the musical runtime:
//   1) clean boot: no music module requests, facade reports "unloaded",
//   2) first gesture: the director chunk loads, the score starts — presence
//      climbs, chords schedule, the vinyl/reverb worker buffers arrive,
//   3) pure-data sanity via the SAME vite-served modules: quiet zones duck to
//      zero at the busker pitch, region blending hands GG Park the key,
//   4) mute economy: zeroing the music slider releases the persistent engine
//      hold so the shared ctx can idle-suspend again.
//
// Self-contained: launches its OWN vite on a fresh free port and tears it down.
//   node tools/lofi-music-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/lofi-music-probe");
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = findChrome();
  const vitePort = await freePort();
  const relayPort = await freePort();
  const serverUrl = `http://127.0.0.1:${vitePort}`;
  console.log(`[probe] root=${ROOT} server=${serverUrl}`);

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
  const proc = spawn(chrome, [
    `--user-data-dir=${profileDir}`, "--headless=new", `--remote-debugging-port=${debugPort}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--hide-scrollbars", "--mute-audio",
    `--window-size=${W},${H}`, "about:blank"
  ], { cwd: ROOT, stdio: "ignore" });

  let cdp = null;
  const errors = [];
  const musicRequests = [];
  const stemRequests = [];
  const phraseRequests = [];
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
      } else if (m.method === "Network.requestWillBeSent") {
        const url = m.params.request?.url ?? "";
        if (url.includes("/src/audio/music/")) musicRequests.push(url);
        if (url.includes("/audio/music/stems/")) stemRequests.push(url);
        if (url.includes("/audio/music/phrases/")) phraseRequests.push(url);
      }
    };
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `${serverUrl}/?autostart=1&spawn=transamerica` });

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

    // ---- phase 1: clean boot — zero music module requests, facade dormant ----
    // The facade module itself rides the core bundle (it's tiny); the CONTRACT
    // is that director/theory/regions/worker never load pre-gesture.
    const bootRequests = musicRequests.filter((u) =>
      /director|theory|regions|musicBuffersWorker/.test(u)
    );
    assert.deepEqual(bootRequests, [], `music engine modules fetched at clean boot:\n${bootRequests.join("\n")}`);
    assert.deepEqual(stemRequests, [], `baked stems fetched at clean boot:\n${stemRequests.join("\n")}`);
    assert.deepEqual(phraseRequests, [], `baked phrases fetched at clean boot:\n${phraseRequests.join("\n")}`);
    const bootState = await ev(cdp, "window.__sf?.lofiMusic?.debugState ?? null");
    assert.equal(bootState?.ctx, "unloaded", `facade should be dormant pre-gesture, got ${JSON.stringify(bootState)}`);

    // ---- phase 2: first gesture — director loads, the score starts ----
    await setKey(cdp, true, "KeyW", "w", 87);
    await sleep(1600);
    await setKey(cdp, false, "KeyW", "w", 87);
    // give the worker + first chords a moment
    let live = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 15_000) {
      await sleep(600);
      live = await ev(cdp, "window.__sf?.lofiMusic?.debugState ?? null");
      if (live && live.ctx === "running" && live.chordCount >= 1 && live.vinylReady) break;
    }
    const activationRequests = musicRequests.filter((u) => /director/.test(u));
    assert(activationRequests.length >= 1, `gesture did not fetch the director chunk (saw: ${musicRequests.join(", ")})`);
    assert.equal(live?.ctx, "running", `music ctx should be running after gesture, got ${JSON.stringify(live)}`);
    assert(live.presence > 0.05, `presence should be fading in, got ${live.presence}`);
    assert(live.chordCount >= 1, `no chords scheduled: ${JSON.stringify(live)}`);
    assert.equal(live.vinylReady, true, `worker buffers (vinyl/reverb) never arrived: ${JSON.stringify(live)}`);
    assert.equal(live.keyOwner, "city", `downtown spawn should sit in the city key, got ${live.keyOwner}`);
    const engine = await ev(cdp, "window.__sf.audioEngine.debugState");
    assert(engine.levels.music > 0, `engine music group level should be up, got ${JSON.stringify(engine.levels)}`);
    assert(engine.persistent >= 1, `music should own a persistent hold while playing, got ${JSON.stringify(engine)}`);

    // baked stems load on demand once their targets rise (dust is always on)
    let stems = null;
    const tStems = Date.now();
    while (Date.now() - tStems < 12_000) {
      await sleep(600);
      stems = await ev(cdp, "window.__sf.lofiMusic.debugState.stems ?? []");
      if (stems.some((s) => s.loaded && s.activeSources > 0)) break;
    }
    assert(
      stems.some((s) => s.loaded && s.activeSources > 0),
      `no baked stem became audible after activation: ${JSON.stringify(stems)}`
    );
    assert(stemRequests.length >= 1, `no stem files were fetched after activation`);
    const failedStems = stems.filter((s) => s.failed);
    assert.deepEqual(failedStems, [], `stems failed to load: ${JSON.stringify(failedStems)}`);

    // hybrid conductor: the first baked phrase enters at a chord boundary
    // (~12 s establish + fetch-then-retry), transposed into the current key
    let phrases = null;
    const tPhrase = Date.now();
    while (Date.now() - tPhrase < 60_000) {
      await sleep(1500);
      phrases = await ev(cdp, "window.__sf.lofiMusic.debugState.phrases ?? null");
      if (phrases && phrases.played >= 1) break;
    }
    assert(phrases && phrases.played >= 1, `no baked phrase played within 60s: ${JSON.stringify(phrases)}`);
    assert(phraseRequests.length >= 1, "no phrase file was fetched after activation");
    assert.deepEqual(phrases.failed, [], `phrases failed to load: ${JSON.stringify(phrases)}`);

    // ---- phase 3: pure-data sanity via the same vite-served modules ----
    const pure = await ev(cdp, `(async () => {
      const R = await import("/src/audio/music/regions.ts");
      const T = await import("/src/audio/music/theory.ts");
      const gg = R.MUSIC_REGIONS.find((r) => r.id === "ggpark");
      const cx = (gg.bounds.minX + gg.bounds.maxX) / 2;
      const cz = (gg.bounds.minZ + gg.bounds.maxZ) / 2;
      const inf = R.MUSIC_REGIONS.map((r) => R.musicRegionInfluence(r, cx, cz));
      const blended = R.blendMusic(inf);
      const voicesA = T.leadVoices(null, T.degreeChordPcs(2, T.MODES.ionian, 0, 4), 50, 74);
      const voicesB = T.leadVoices(voicesA, T.degreeChordPcs(2, T.MODES.ionian, 5, 4), 50, 74);
      const motion = voicesA.map((v, i) => Math.abs((voicesB[i] ?? v) - v)).reduce((a, b) => a + b, 0);
      return {
        duckAtBuskers: R.quietZoneDuck(412, 2760),
        duckDowntown: R.quietZoneDuck(2600, -1200),
        ggDominant: blended.dominant?.id ?? null,
        ggRoot: blended.profile.root,
        voicesA, voicesB, motion
      };
    })()`);
    assert.equal(pure.duckAtBuskers, 0, `music must duck fully at the busker pitch, got ${pure.duckAtBuskers}`);
    assert.equal(pure.duckDowntown, 1, `no duck expected downtown, got ${pure.duckDowntown}`);
    assert.equal(pure.ggDominant, "ggpark", `GG Park centre should own the key, got ${pure.ggDominant}`);
    assert(pure.voicesA.length === 4 && pure.voicesB.length === 4, `voicings wrong size: ${JSON.stringify(pure)}`);
    assert(
      pure.motion <= 16,
      `voice-leading motion too large (${pure.motion} semitones total): ${JSON.stringify(pure)}`
    );

    // ---- phase 4: mute economy — zero slider releases the persistent hold ----
    await ev(cdp, `(() => {
      const btn = document.querySelector('#hud .mute-btn');
      if (btn) btn.click(); // full mute is the cleanest exported path
      return true;
    })()`);
    let after = null;
    const t2 = Date.now();
    while (Date.now() - t2 < 20_000) {
      await sleep(800);
      after = await ev(cdp, `({
        engine: window.__sf.audioEngine.debugState,
        music: window.__sf.lofiMusic.debugState
      })`);
      if (after.engine.persistent === 0) break;
    }
    assert.equal(
      after.engine.persistent, 0,
      `muting should release every persistent hold (music included), got ${JSON.stringify(after)}`
    );

    const musicErrors = errors.filter((e) => /lofi|music/i.test(e));
    assert.deepEqual(musicErrors, [], `music-related console errors:\n${musicErrors.join("\n")}`);

    console.log("\nlofi music probe: PASS");
    console.log(JSON.stringify({
      bootState,
      live,
      engineWhilePlaying: { levels: engine.levels, persistent: engine.persistent },
      pure,
      stems,
      phrases,
      afterMute: after,
      musicRequests,
      stemRequests,
      phraseRequests,
      totalConsoleErrors: errors.length
    }, null, 2));
  } finally {
    if (cdp) cdp.close();
    proc.kill("SIGKILL");
    try { process.kill(-vite.pid, "SIGKILL"); } catch { vite.kill("SIGKILL"); }
    await sleep(300);
  }
}

main().catch((err) => { console.error("lofi music probe: FAIL\n", err); process.exit(1); });
