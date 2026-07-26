// Offline renderer for the generative score.
//
// Drives LofiMusicDirector against an OfflineAudioContext inside headless
// Chrome, stepping the render with ctx.suspend()/resume() so the per-frame
// update() lands on the audio clock. No world boot, no WebGPU, no realtime
// wait — a 60 s capture renders in a few seconds, which is what makes it
// practical to audition every region after a change.
//
//   node tools/music-render.mjs                       # the default tour
//   node tools/music-render.mjs --seconds 45
//   node tools/music-render.mjs --only mission,fidi
//   node tools/music-render.mjs --night               # 23:00 instead of 13:00
//
// Output: .data/music-render/<id>-<day|night>.mp3 (+ .wav when ffmpeg is absent)
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/music-render");
const FFMPEG = path.resolve(
  ROOT,
  ".data/music-python/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1"
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where to stand. Coordinates are game-space (x, z); each should sit well
// inside its region so the capture hears that place and not a blend.
const STOPS = [
  { id: "city", label: "generic city", x: 2100, z: 600 },
  { id: "fidi", label: "Financial District", x: 3900, z: 0 },
  { id: "chinatown", label: "Chinatown", x: 3250, z: -550 },
  { id: "northbeach", label: "North Beach", x: 3000, z: -1400 },
  { id: "mission", label: "The Mission", x: 1800, z: 3400 },
  { id: "soma", label: "SoMa", x: 3600, z: 1450 },
  { id: "haight", label: "Haight-Ashbury", x: 200, z: 1900 },
  { id: "marina", label: "The Marina", x: 150, z: -1700 },
  { id: "sunset", label: "The Sunset", x: -4000, z: 3700 },
  { id: "ggpark", label: "Golden Gate Park", x: -3800, z: 2400 },
  { id: "marin", label: "Marin Headlands", x: -4450, z: -6250 },
  { id: "landsend", label: "Lands End", x: -5950, z: 900 },
  { id: "oceanbeach", label: "Ocean Beach", x: -6000, z: 3100 },
  { id: "goldengate", label: "Golden Gate Bridge", x: -3000, z: -3300 },
  { id: "gracecathedral", label: "Grace Cathedral", x: 2687, z: -205 },
  { id: "teagarden", label: "Japanese Tea Garden", x: -2298, z: 2182 },
  { id: "alcatraz", label: "Alcatraz", x: 1848, z: -4058 }
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const HAS = (name) => process.argv.includes(`--${name}`);

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
    const s = createNetServer();
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
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`timeout ${label}: ${url}`);
}

class Cdp {
  #ws;
  #id = 1;
  #p = new Map();
  constructor(u) {
    this.#ws = new WebSocket(u);
  }
  async open() {
    await new Promise((res, rej) => {
      this.#ws.addEventListener("open", res, { once: true });
      this.#ws.addEventListener("error", rej, { once: true });
    });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id);
      if (!p) return;
      this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { res, rej, method }));
  }
  close() {
    try {
      this.#ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function ev(c, expr, timeoutMs = 180_000) {
  const r = await Promise.race([
    c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => {
      throw new Error("evaluate timed out");
    })
  ]);
  if (r.exceptionDetails) {
    throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 1200)}`);
  }
  return r.result?.value;
}

/* ------------------------------------------------------- in-page renderer */

// Runs inside the harness page. Builds one director per stop against a fresh
// OfflineAudioContext, steps it, and POSTs the WAV back to the driver.
const PAGE_RENDERER = `
window.__renderStop = async (opts) => {
  const { x, z, timeOfDay, seconds, leadIn, sampleRate, uploadUrl, name } = opts;
  const D = await import("/src/audio/music/director.ts");
  const E = await import("/src/audio/engine.ts");
  const A = await import("/src/core/audioSettings.ts");
  if (A.AUDIO_PREFS) { A.AUDIO_PREFS.enabled = true; A.AUDIO_PREFS.musicVolume = 1; }

  const total = leadIn + seconds;
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.ceil(sampleRate * total),
    sampleRate
  });
  // The director early-outs unless the context reports "running"; an offline
  // context is "suspended" at every suspend point by design, so shadow the JS
  // getter. startRendering() reads its own internal state, not this property.
  Object.defineProperty(ctx, "state", { get: () => "running", configurable: true });

  const group = ctx.createGain();
  group.gain.value = 1;
  group.connect(ctx.destination);
  E.audioEngine.bus = () => ({ ctx, input: group });
  E.audioEngine.prewarmBus = () => ({ ctx, input: group });
  E.audioEngine.acquireHold = () => () => {};
  Object.defineProperty(E.audioEngine, "unlocked", { value: true, configurable: true });

  const dir = new D.LofiMusicDirector();
  const frame = { playerPos: { x, y: 4, z }, timeOfDay };
  const step = 1 / 30;

  // build the graph + kick the worker/fetches off before the clock starts
  dir.update(step, frame);
  await new Promise((r) => setTimeout(r, 400));

  let warmed = false;
  for (let t = 0; t < total - step; t += step) {
    ctx.suspend(t).then(async () => {
      if (!warmed) {
        // Audio time is frozen here, so this costs the render nothing: give the
        // worker, the dust stem and the first phrases real wall-clock time to
        // land before anything is committed to the timeline.
        warmed = true;
        await new Promise((r) => setTimeout(r, 3000));
      }
      try { dir.update(step, frame); } catch (err) { window.__renderError = String(err); }
      ctx.resume();
    });
  }

  const buf = await ctx.startRendering();
  const dbg = JSON.parse(JSON.stringify(dir.debugState));
  try { dir.dispose(); } catch {}

  // trim the lead-in, interleave, int16 WAV
  const skip = Math.floor(leadIn * sampleRate);
  const n = buf.length - skip;
  const L = buf.getChannelData(0), R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0);
  let peak = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const l = L[skip + i], r = R[skip + i];
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    sumSq += l * l + r * r;
  }
  const rms = Math.sqrt(sumSq / (2 * n));

  const bytes = new ArrayBuffer(44 + n * 4);
  const dv = new DataView(bytes);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); dv.setUint32(4, 36 + n * 4, true); ascii(8, "WAVE");
  ascii(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  ascii(36, "data"); dv.setUint32(40, n * 4, true);
  const clamp = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, clamp(L[skip + i]), true);
    dv.setInt16(46 + i * 4, clamp(R[skip + i]), true);
  }
  await fetch(uploadUrl + "?name=" + encodeURIComponent(name), { method: "POST", body: bytes });
  return { peak: +peak.toFixed(4), rms: +rms.toFixed(5), debug: dbg, error: window.__renderError ?? null };
};
// Renders each instrument voice alone across the register it is actually played
// in, and reports whether it produced a finite signal. One NaN sample anywhere
// poisons the whole summed score, so isolating per voice is the only way to
// find the culprit.
window.__renderVoices = async (opts) => {
  const { sampleRate } = opts;
  const V = await import("/src/audio/music/voices/index.ts");
  const T = await import("/src/audio/music/voiceTypes.ts");
  const families = [
    ["keys", V.KEYS_VOICES, T.KEYS_VOICE_IDS, [48, 55, 62, 69, 76], 0.2, 4],
    ["pad", V.PAD_VOICES, T.PAD_VOICE_IDS, [48, 55, 62, 67], 0.11, 6],
    ["bass", V.BASS_VOICES, T.BASS_VOICE_IDS, [33, 38, 43, 48], 0.26, 5],
    ["sparkle", V.SPARKLE_VOICES, T.SPARKLE_VOICE_IDS, [67, 79, 84, 91], 0.12, 3]
  ];
  const out = [];
  for (const [family, registry, ids, midis, vel, dur] of families) {
    for (const id of ids) {
      for (const bright of [0, 1]) {
        const seconds = dur + 6;
        const ctx = new OfflineAudioContext({
          numberOfChannels: 2,
          length: Math.ceil(sampleRate * seconds),
          sampleRate
        });
        const bus = ctx.createGain();
        bus.connect(ctx.destination);
        const rev = ctx.createGain();
        rev.gain.value = 0.5;
        rev.connect(ctx.destination);
        let seed = 12345;
        const rng = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        const vctx = { ctx, out: bus, rev, rng };
        let threw = null;
        midis.forEach((midi, i) => {
          try {
            registry[id](vctx, { t: 0.05 + i * 0.9, midi, vel, dur, bright });
          } catch (err) { threw = String(err); }
        });
        const buf = await ctx.startRendering();
        let peak = 0, bad = 0, sumSq = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) {
            if (!Number.isFinite(d[i])) { bad++; continue; }
            const a = Math.abs(d[i]);
            if (a > peak) peak = a;
            sumSq += d[i] * d[i];
          }
        }
        out.push({
          family, id, bright,
          peak: +peak.toFixed(4),
          rms: +Math.sqrt(sumSq / (buf.length * buf.numberOfChannels)).toFixed(5),
          nonFinite: bad,
          threw
        });
      }
    }
  }
  return out;
};
true;
`;

/* ------------------------------------------------------------------ main */

async function main() {
  const seconds = Number(arg("seconds", "50"));
  const leadIn = Number(arg("lead", "14"));
  const sampleRate = Number(arg("rate", "44100"));
  const night = HAS("night");
  const timeOfDay = Number(arg("hour", night ? "23" : "13"));
  const tag = night ? "night" : "day";
  const only = arg("only", "");
  const stops = only
    ? STOPS.filter((s) => only.split(",").map((v) => v.trim()).includes(s.id))
    : STOPS;
  if (stops.length === 0) throw new Error(`no stops matched --only ${only}`);

  mkdirSync(OUT, { recursive: true });
  const chrome = findChrome();
  const vitePort = await freePort();
  const relayPort = await freePort();
  const uploadPort = await freePort();
  const serverUrl = `http://127.0.0.1:${vitePort}`;

  // upload sink: the page POSTs finished WAVs straight here
  const received = new Map();
  const sink = createHttpServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return res.end();
    const name = new URL(req.url, "http://x").searchParams.get("name") ?? "unnamed";
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.set(name, Buffer.concat(chunks));
      res.end("ok");
    });
  });
  await new Promise((r) => sink.listen(uploadPort, "127.0.0.1", r));

  const vite = spawn(
    "npx",
    ["vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    }
  );
  vite.stdout.on("data", () => {});
  vite.stderr.on("data", (d) => {
    const s = String(d);
    if (/error/i.test(s)) console.error("[vite]", s.slice(0, 400));
  });

  const profileDir = path.join(OUT, "chrome-profile");
  rmSync(profileDir, { recursive: true, force: true });
  const debugPort = await freePort();
  const proc = spawn(
    chrome,
    [
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--mute-audio",
      "about:blank"
    ],
    { cwd: ROOT, stdio: "ignore" }
  );

  let cdp = null;
  const results = [];
  try {
    await waitHttp(serverUrl, 60_000, "vite");

    let page;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
        page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {
        /* devtools not up yet */
      }
      await sleep(300);
    }
    if (!page) throw new Error("no devtools page");

    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: `${serverUrl}/tools/music-render.html` });
    for (let i = 0; i < 120; i++) {
      if (await ev(cdp, "Boolean(window.__musicRenderReady)")) break;
      await sleep(250);
    }
    await ev(cdp, PAGE_RENDERER);

    if (HAS("voices")) {
      const rows = await ev(cdp, `window.__renderVoices({ sampleRate: ${sampleRate} })`);
      let bad = 0;
      for (const r of rows) {
        const flag = r.nonFinite > 0 || r.threw ? "  <-- BROKEN" : r.peak < 0.001 ? "  <-- SILENT" : "";
        if (flag) bad++;
        console.log(
          `${r.family.padEnd(8)}${r.id.padEnd(11)}${r.bright ? "day  " : "night"} ` +
            `peak ${String(r.peak).padEnd(8)} rms ${String(r.rms).padEnd(9)}` +
            `${r.nonFinite ? ` nonFinite=${r.nonFinite}` : ""}${r.threw ? ` threw=${r.threw}` : ""}${flag}`
        );
      }
      console.log(bad === 0 ? "\nall voices finite and audible" : `\n${bad} BROKEN OR SILENT VOICES`);
      process.exitCode = bad === 0 ? 0 : 1;
      return;
    }

    for (const stop of stops) {
      const name = `${stop.id}-${tag}`;
      process.stdout.write(`[render] ${stop.label.padEnd(24)} `);
      const started = Date.now();
      const r = await ev(
        cdp,
        `window.__renderStop(${JSON.stringify({
          x: stop.x,
          z: stop.z,
          timeOfDay,
          seconds,
          leadIn,
          sampleRate,
          uploadUrl: `http://127.0.0.1:${uploadPort}/upload`,
          name
        })})`
      );
      const wav = received.get(name);
      if (!wav) throw new Error(`no audio came back for ${name}`);
      const wavPath = path.join(OUT, `${name}.wav`);
      writeFileSync(wavPath, wav);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `peak ${String(r.peak).padEnd(6)} rms ${String(r.rms).padEnd(7)} ` +
          `key=${r.debug.keyRoot} ${r.debug.voicing}/${r.debug.kit} ` +
          `keys=${r.debug.keysVoice} pad=${r.debug.padVoice} bass=${r.debug.bassVoice} (${secs}s)`
      );
      if (r.error) console.warn(`  ! in-page error: ${r.error}`);
      results.push({ stop, wavPath, ...r });
    }
  } finally {
    cdp?.close();
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      process.kill(-vite.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    sink.close();
  }

  // encode to mp3 when the bundled ffmpeg is present (it is what ships with the
  // vendored imageio-ffmpeg wheel); the wav stays either way
  if (existsSync(FFMPEG)) {
    for (const r of results) {
      const mp3 = r.wavPath.replace(/\.wav$/, ".mp3");
      // Drop any earlier take first: a failed encode that leaves a stale file
      // behind is far more confusing than a missing one.
      rmSync(mp3, { force: true });
      const code = await new Promise((res) => {
        const p = spawn(
          FFMPEG,
          ["-y", "-loglevel", "error", "-i", r.wavPath, "-codec:a", "libmp3lame", "-q:a", "3", mp3],
          { stdio: "inherit" }
        );
        p.on("exit", res);
      });
      if (code !== 0) throw new Error(`ffmpeg exited ${code} encoding ${mp3} (wav kept)`);
      rmSync(r.wavPath, { force: true });
    }
    console.log(`\n${results.length} clips → ${OUT}/*.mp3`);
  } else {
    console.log(`\n${results.length} clips → ${OUT}/*.wav (no ffmpeg at ${FFMPEG})`);
  }

  const silent = results.filter((r) => r.rms < 0.0005);
  if (silent.length > 0) {
    console.error(`\nSILENT CAPTURES: ${silent.map((r) => r.stop.id).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("music render failed:", err);
  process.exit(1);
});
