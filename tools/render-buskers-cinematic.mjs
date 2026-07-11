// Renders the 30s "buskers" cinematic to a finished mp4 WITH the trio's live
// WebAudio music, plus a poster and a contact sheet for review.
//
// Two passes, deliberately separate because they need different clocks:
//
//   Pass 1 (video, deterministic): stop the wall-clock (window.__sfManual), then
//   advance the reel one exact dt per frame — __sfReelStep(t) sets virtual time,
//   __sf.tick(1/FPS) renders that single frame, then we screenshot it. GPU speed
//   only changes how long the capture takes, never smoothness. Frames stream to
//   .data/buskers-cine/<take>/raw/frame_%05d.jpg.
//
//   Pass 2 (audio, realtime): a SECOND fresh Chrome (un-muted) plays the demo in
//   real time and MediaRecorder taps __sf.buskers.captureStream() — the trio's
//   final HRTF-mixed output. The music is positional (listener = orbiting camera)
//   so it MUST run the real timeline; that's why it can't be baked frame-by-frame.
//
//   Mux: ffmpeg stitches the JPEG sequence with audio.webm into an H.264 mp4.
//
// One command:  node tools/render-buskers-cinematic.mjs
//
// Env (all optional):
//   SF_W (1920)  SF_H (1080)  SF_FPS (60)  SF_SECONDS (30)  SF_TAKE (take1)
//   SF_OUT (renders/buskers-cinematic-<take>-<W>x<H>.mp4)
//   SF_JPEG_Q (92)   SF_FX_VOL (0.9  — seeded effects volume for a hot, clean take)
//   SF_SKIP_AUDIO=1   video only, silent AAC track
//   SF_SKIP_CAPTURE=1 reuse existing frames + audio, re-encode/remux only (seconds)
//   SF_AUDIO_ONLY=1   re-record just the audio then remux (reuse existing frames)
//   SF_KEEP_FRAMES=1  never auto-wipe the raw frame dir (default already keeps them;
//                     the tool only wipes when a fresh capture uses a new W/H/FPS/len)
//   SF_CAPTURE_FROM / SF_CAPTURE_TO   partial re-shoot of a frame range [FROM,TO)
//   SF_SETTLE (55)    tick(0) settle iterations before frame 0 (tiles / shader warmup)
//   CHROME_BIN        override the Chrome binary path
//
// Output under renders/:  <out>.mp4  <out>.poster.jpg  <out>.contact.jpg

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  rm,
  readdir,
  writeFile,
  readFile,
  stat
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── config ──────────────────────────────────────────────────────────────────
const W = Number(process.env.SF_W ?? 1920);
const H = Number(process.env.SF_H ?? 1080);
const FPS = Number(process.env.SF_FPS ?? 60);
const SECONDS = Number(process.env.SF_SECONDS ?? 30);
const TAKE = process.env.SF_TAKE ?? "take1";
const JPEG_Q = Number(process.env.SF_JPEG_Q ?? 92);
const FX_VOL = Number(process.env.SF_FX_VOL ?? 0.9);
const SETTLE = Number(process.env.SF_SETTLE ?? 55);

const SKIP_AUDIO = process.env.SF_SKIP_AUDIO === "1";
const SKIP_CAPTURE = process.env.SF_SKIP_CAPTURE === "1";
const AUDIO_ONLY = process.env.SF_AUDIO_ONLY === "1";
const KEEP_FRAMES = process.env.SF_KEEP_FRAMES === "1";

const TOTAL = Math.round(FPS * SECONDS);
const DT = 1 / FPS;

const WORK_DIR = path.join(ROOT, ".data", "buskers-cine", TAKE);
const RAW_DIR = path.join(WORK_DIR, "raw");
const AUDIO_FILE = path.join(WORK_DIR, "audio.webm");
const META_FILE = path.join(WORK_DIR, "meta.json");
const CHROME_PROFILE_V = path.join(WORK_DIR, "chrome-video");
const CHROME_PROFILE_A = path.join(WORK_DIR, "chrome-audio");

const OUT_DIR = path.join(ROOT, "renders");
const OUT_MP4 = process.env.SF_OUT
  ? path.resolve(ROOT, process.env.SF_OUT)
  : path.join(OUT_DIR, `buskers-cinematic-${TAKE}-${W}x${H}.mp4`);
const OUT_POSTER = OUT_MP4.replace(/\.mp4$/i, ".poster.jpg");
const OUT_CONTACT = OUT_MP4.replace(/\.mp4$/i, ".contact.jpg");

// What to actually do this run:
//   wantVideo  — capture frames    wantAudio — record a fresh audio take
const wantVideo = !SKIP_CAPTURE && !AUDIO_ONLY;
const wantAudio = !SKIP_AUDIO && (AUDIO_ONLY || !SKIP_CAPTURE);

const FROM = Math.max(0, Number(process.env.SF_CAPTURE_FROM ?? 0));
const TO = Math.min(TOTAL, Number(process.env.SF_CAPTURE_TO ?? TOTAL));
const partial = FROM > 0 || TO < TOTAL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[cine] ${m}`);
const rel = (p) => path.relative(ROOT, p);

// ── process/cleanup bookkeeping ───────────────────────────────────────────────
const kids = new Set();
function track(child) {
  kids.add(child);
  child.once("exit", () => kids.delete(child));
  return child;
}
function killAll() {
  for (const c of kids) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
  kids.clear();
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killAll();
    process.exit(1);
  });
}

// ── small utils ───────────────────────────────────────────────────────────────
async function isFile(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
async function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
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
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`timeout ${label}: ${url}`);
}
function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const c = track(spawn(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts }));
    c.once("error", rej);
    c.once("exit", (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))
    );
  });
}
// run capturing stderr (ffmpeg prints its summaries there)
function runCapture(cmd, args) {
  return new Promise((res) => {
    let out = "";
    const c = track(spawn(cmd, args, { cwd: ROOT }));
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.once("exit", (code) => res({ code, out }));
    c.once("error", (e) => res({ code: -1, out: out + String(e) }));
  });
}

// ── CDP over WebSocket (no puppeteer) ─────────────────────────────────────────
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
      m.error
        ? p.rej(new Error(`${p.method}: ${m.error.message}`))
        : p.res(m.result ?? {});
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
    } catch {}
  }
}
async function ev(c, expr, awaitPromise = true) {
  const r = await c.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise,
    returnByValue: true
  });
  if (r.exceptionDetails)
    throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result?.value;
}
async function waitEv(c, expr, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if (await ev(c, expr)) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timeout ${label}`);
}

// render one frame at fixed dt, then wait for it to be presented (double rAF)
const frameExpr = (dt) =>
  `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) {
  await ev(c, frameExpr(dt));
}
async function settle(c, iters, gapMs) {
  for (let i = 0; i < iters; i++) {
    await ev(c, frameExpr(0));
    await sleep(gapMs);
  }
}

// Launch Chrome + attach a CDP client to a fresh tab sized to WxH.
async function launchChrome({ profile, width, height, extraFlags = [] }) {
  const chromePath = await findChrome();
  const dport = await freePort();
  const chrome = track(
    spawn(
      chromePath,
      [
        `--remote-debugging-port=${dport}`,
        `--user-data-dir=${profile}`,
        "--headless=new",
        "--no-first-run",
        "--enable-unsafe-webgpu",
        "--enable-features=WebGPUDeveloperFeatures",
        "--use-angle=metal",
        `--window-size=${width},${height}`,
        "--force-device-scale-factor=1",
        ...extraFlags,
        "about:blank"
      ],
      { stdio: "ignore" }
    )
  );
  let ver;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!ver) throw new Error("no CDP endpoint");
  const page = await (
    await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, {
      method: "PUT"
    })
  ).json();
  const client = new Cdp(page.webSocketDebuggerUrl);
  await client.open();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  return { chrome, client, dport };
}

// Seed a hot effects volume BEFORE any page script runs, so the trio's master
// gain (audio.ts reads effectsAudioLevel()) records at a clean, audible level
// even on a fresh Chrome profile with no saved prefs. effectsAudioLevel returns
// volume², so FX_VOL 0.9 -> ~0.81 mix (loud, with headroom).
async function seedAudioPrefs(client, vol) {
  const prefs = JSON.stringify({
    effectsVolume: vol,
    voiceVolume: 0.62,
    enabled: true
  });
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try{localStorage.setItem('sf-audio',${JSON.stringify(prefs)});}catch(e){}`
  });
}

// ── private Vite (never touches the shared 5179 / relay 8787) ─────────────────
async function startVite() {
  const vitePort = await freePort();
  const relayPort = await freePort();
  const url = `http://127.0.0.1:${vitePort}`;
  log(`starting private Vite at ${url} (relay ${relayPort})`);
  const child = track(
    spawn(
      "npx",
      [
        "vite",
        "--port",
        String(vitePort),
        "--strictPort",
        "--host",
        "127.0.0.1"
      ],
      {
        cwd: ROOT,
        env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
        stdio: ["ignore", "ignore", "ignore"]
      }
    )
  );
  await waitHttp(url, 60000, "vite");
  return { child, url };
}

// ── Pass 1: deterministic frame capture ───────────────────────────────────────
async function capturePass(viteUrl) {
  // Auto-wipe the raw dir only when a FULL fresh capture uses geometry/timing
  // different from what's on disk (otherwise stale high-index frames corrupt the
  // %05d sequence). SF_KEEP_FRAMES forces keep; partial re-shoots never wipe.
  if (!partial && !KEEP_FRAMES) {
    let meta = null;
    try {
      meta = JSON.parse(await readFile(META_FILE, "utf8"));
    } catch {}
    const mismatch =
      meta &&
      (meta.W !== W || meta.H !== H || meta.FPS !== FPS || meta.SECONDS !== SECONDS);
    if (mismatch) {
      log(
        `raw frames were ${meta.W}x${meta.H}@${meta.FPS} ${meta.SECONDS}s — wiping for fresh ${W}x${H}@${FPS} ${SECONDS}s`
      );
      await rm(RAW_DIR, { recursive: true, force: true });
    }
  }
  await mkdir(RAW_DIR, { recursive: true });

  const url = `${viteUrl}/?demo=buskers&hold=1&manual=1&fullfps=1&autostart=1`;
  log(`video: ${W}x${H} @ ${FPS}fps, ${TOTAL} frames -> ${url}`);
  const { client } = await launchChrome({
    profile: CHROME_PROFILE_V,
    width: W,
    height: H,
    extraFlags: ["--mute-audio"]
  });
  try {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.send("Page.navigate", { url });
    await waitEv(
      client,
      "Boolean(window.__sfReelArmed && window.__sf && window.__sfReelStep && window.__sfManual)",
      120000,
      "reel arm"
    );

    // hand us the clock, seek to the start frame, let that scene stream in
    await ev(client, "window.__sfManual(true); true");
    await ev(client, `window.__sfReelStep(${FROM * DT}); true`);
    await settle(client, partial ? Math.round(SETTLE * 0.62) : SETTLE, 55);

    log(`rendering frames ${FROM}..${TO}${partial ? " (partial)" : ""}…`);
    const tStart = Date.now();
    for (let i = FROM; i < TO; i++) {
      const t = i * DT;
      await ev(client, `window.__sfReelStep(${t}); true`);
      await tick(client, DT);
      const shot = await client.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: JPEG_Q,
        fromSurface: true
      });
      writeFileSync(
        path.join(RAW_DIR, `frame_${String(i).padStart(5, "0")}.jpg`),
        Buffer.from(shot.data, "base64")
      );
      if ((i - FROM) % 120 === 0 && i > FROM) {
        const done = i - FROM;
        const per = (Date.now() - tStart) / done;
        const etaS = Math.round((per * (TO - i)) / 1000);
        log(
          `  ${i}/${TO} (${t.toFixed(1)}s)  ${(per / 1000).toFixed(2)}s/frame  ETA ${etaS}s`
        );
      }
    }
    const per = (Date.now() - tStart) / Math.max(1, TO - FROM);
    log(`captured ${TO - FROM} frames  (${(per / 1000).toFixed(2)}s/frame)`);
  } finally {
    client.close();
  }

  if (!partial) {
    await writeFile(
      META_FILE,
      JSON.stringify({ W, H, FPS, SECONDS, total: TOTAL }, null, 2)
    );
  }
}

// ── Pass 2: realtime live-audio capture ───────────────────────────────────────
// Returns { rms, headRms } (overall RMS dB + RMS of the first 0.8s, for the
// downbeat-alignment sanity check). Retries once with a hotter seed on silence.
async function audioPass(viteUrl) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const vol = attempt === 1 ? FX_VOL : 1.0;
    log(`audio: realtime take (attempt ${attempt}, fx seed ${vol})`);
    const { client } = await launchChrome({
      profile: CHROME_PROFILE_A + attempt, // clean profile per attempt
      width: 640,
      height: 360,
      extraFlags: ["--autoplay-policy=no-user-gesture-required"] // NB: NOT muted
    });
    try {
      await seedAudioPrefs(client, vol);
      const url = `${viteUrl}/?demo=buskers&hold=1&fullfps=1`;
      await client.send("Page.navigate", { url });
      await waitEv(
        client,
        "Boolean(window.__sfReelArmed && window.__sf && window.__sf.buskers && window.__sfStartShot)",
        120000,
        "reel arm (audio)"
      );

      // Fire-and-forget: start recorder, then start the timeline in the SAME
      // eval so recorder t≈0 lines up with reel T=0; stop after SECONDS+0.4s.
      const setup = `(()=>{
        try{
          const bk = window.__sf.buskers;
          const stream = bk.captureStream ? bk.captureStream() : null;
          if(!stream){ window.__sfAudioErr = "captureStream() returned null (no AudioContext?)"; return "no-stream"; }
          window.__sfAudioTracks = stream.getAudioTracks().length;
          window.__sfAudioDone = false; window.__sfAudioErr = "";
          const chunks = [];
          const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 192000 });
          rec.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
          rec.onstop = () => {
            const blob = new Blob(chunks, { type: "audio/webm" });
            const fr = new FileReader();
            fr.onloadend = () => { window.__sfAudioB64 = String(fr.result).split(",")[1] || ""; window.__sfAudioDone = true; };
            fr.readAsDataURL(blob);
          };
          rec.start(250);
          window.__sfStartShot();
          setTimeout(() => { try{ rec.stop(); }catch(e){ window.__sfAudioErr = String(e); window.__sfAudioDone = true; } }, ${(SECONDS + 0.4) * 1000});
          return "recording";
        }catch(e){ window.__sfAudioErr = String(e); return "error"; }
      })()`;
      const status = await ev(client, setup, false);
      if (status !== "recording") {
        const err = await ev(client, "window.__sfAudioErr || 'unknown'");
        throw new Error(`audio setup failed: ${err}`);
      }
      const tracks = await ev(client, "window.__sfAudioTracks ?? 0");
      log(`  recording ${tracks} audio track(s); waiting ${SECONDS + 2}s…`);

      // let the AudioContext resume (game auto-resumes when the cam is near) and
      // the take run out, then wait for the FileReader to finish the base64.
      await sleep((SECONDS + 2) * 1000);
      await waitEv(client, "window.__sfAudioDone === true", 15000, "audio done");

      // pull base64 in 1MB slices (returnByValue can choke on multi-MB strings)
      const len = await ev(client, "window.__sfAudioB64 ? window.__sfAudioB64.length : 0");
      if (!len) throw new Error("empty audio buffer");
      const CH = 1 << 20;
      let b64 = "";
      for (let off = 0; off < len; off += CH) {
        b64 += await ev(
          client,
          `window.__sfAudioB64.slice(${off},${off + CH})`
        );
      }
      await writeFile(AUDIO_FILE, Buffer.from(b64, "base64"));
      const kb = Math.round((await stat(AUDIO_FILE)).size / 1024);
      log(`  wrote ${rel(AUDIO_FILE)} (${kb} KB)`);

      // validate loudness — overall + first 0.8s (should be near-silent: downbeat T=1)
      const rms = await measureRms(AUDIO_FILE);
      const headRms = await measureRms(AUDIO_FILE, 0.8);
      log(`  RMS overall ${fmtDb(rms)}   first-0.8s ${fmtDb(headRms)}`);
      if (rms > -60) {
        if (headRms > -35) {
          log(
            `  WARN: first 0.8s is loud (${fmtDb(headRms)}) — downbeat should be at T=1; possible misalignment`
          );
        }
        return { rms, headRms };
      }
      log(`  essentially silent (${fmtDb(rms)}) — retrying with a hotter seed`);
    } finally {
      client.close();
    }
  }
  throw new Error(
    "audio take was silent after retries — AudioContext likely never resumed. " +
      "Inspect src/gameplay/buskers/audio.ts + core/audioSettings.ts (effectsAudioLevel)."
  );
}

function fmtDb(v) {
  return Number.isFinite(v) ? `${v.toFixed(1)} dB` : "-inf dB";
}
// Parse overall RMS from `ffmpeg -af astats`. Optional trimSec measures a lead window.
async function measureRms(file, trimSec) {
  const args = ["-hide_banner"];
  if (trimSec) args.push("-t", String(trimSec));
  args.push("-i", file, "-af", "astats=metadata=1", "-f", "null", "-");
  const { out } = await runCapture("ffmpeg", args);
  const matches = [...out.matchAll(/RMS level dB:\s*(-?[\d.]+|-?inf)/gi)];
  if (!matches.length) return -Infinity;
  const last = matches[matches.length - 1][1]; // Overall block is printed last
  return last.includes("inf") ? -Infinity : Number(last);
}

// ── mux + review artifacts ────────────────────────────────────────────────────
async function mux() {
  await mkdir(OUT_DIR, { recursive: true });
  const haveAudio = !SKIP_AUDIO && (await isFile(AUDIO_FILE));
  if (!SKIP_AUDIO && !haveAudio) {
    throw new Error(
      `no ${rel(AUDIO_FILE)} to mux — run an audio pass (unset SF_SKIP_AUDIO / SF_SKIP_CAPTURE) or set SF_SKIP_AUDIO=1`
    );
  }

  const args = ["-y", "-framerate", String(FPS), "-i", path.join(RAW_DIR, "frame_%05d.jpg")];
  if (haveAudio) {
    args.push("-i", AUDIO_FILE);
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }
  args.push(
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-vf", `scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "slow",
    "-crf", "16",
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", String(SECONDS),
    "-movflags", "+faststart",
    "-shortest",
    OUT_MP4
  );
  log(`muxing -> ${rel(OUT_MP4)}${haveAudio ? " (with live audio)" : " (silent)"}`);
  await run("ffmpeg", args);

  // poster @ 2s
  await run("ffmpeg", [
    "-y", "-ss", "00:00:02", "-i", OUT_MP4,
    "-frames:v", "1", "-update", "1", "-q:v", "2", OUT_POSTER
  ]);
  // contact sheet: 1 thumb/second, 6x5 grid
  await run("ffmpeg", [
    "-y", "-i", OUT_MP4,
    "-vf", "fps=1,scale=320:-1,tile=6x5",
    "-frames:v", "1", "-update", "1", "-q:v", "3", OUT_CONTACT
  ]);
}

async function probeDuration(file) {
  const { out } = await runCapture("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file
  ]);
  return Number(out.trim());
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  let audioStats = null;

  if (wantVideo || wantAudio) {
    const vite = await startVite();
    try {
      if (wantVideo) await capturePass(vite.url);
      if (wantAudio) audioStats = await audioPass(vite.url);
    } finally {
      vite.child.kill("SIGTERM");
    }
  } else {
    log("skip-capture: reusing existing frames + audio, remux only");
  }

  // frame-count sanity before muxing
  let nFrames = 0;
  try {
    nFrames = (await readdir(RAW_DIR)).filter((f) => f.endsWith(".jpg")).length;
  } catch {}
  if (nFrames < TOTAL * 0.9) {
    throw new Error(`only ${nFrames}/${TOTAL} frames in ${rel(RAW_DIR)} — capture first`);
  }

  await mux();
  const dur = await probeDuration(OUT_MP4);
  const sizeMB = ((await stat(OUT_MP4)).size / 1e6).toFixed(1);

  // if audio wasn't (re)recorded this run but a file exists, report its loudness
  if (!audioStats && !SKIP_AUDIO && (await isFile(AUDIO_FILE))) {
    audioStats = { rms: await measureRms(AUDIO_FILE), headRms: await measureRms(AUDIO_FILE, 0.8) };
  }

  const wall = Math.round((Date.now() - t0) / 1000);
  console.log("\n" + "─".repeat(64));
  console.log("  BUSKERS CINEMATIC — done");
  console.log("─".repeat(64));
  console.log(`  output      ${rel(OUT_MP4)}`);
  console.log(`  poster      ${rel(OUT_POSTER)}`);
  console.log(`  contact     ${rel(OUT_CONTACT)}`);
  console.log(`  resolution  ${W}x${H} @ ${FPS}fps`);
  console.log(`  duration    ${dur.toFixed(2)}s   (${nFrames} frames)`);
  console.log(`  size        ${sizeMB} MB`);
  console.log(
    `  audio       ${SKIP_AUDIO ? "silent (SF_SKIP_AUDIO)" : audioStats ? `${fmtDb(audioStats.rms)} RMS (first-0.8s ${fmtDb(audioStats.headRms)})` : "n/a"}`
  );
  console.log(`  workdir     ${rel(WORK_DIR)}`);
  console.log(`  wall time   ${wall}s`);
  console.log("─".repeat(64) + "\n");
}

main()
  .catch((err) => {
    console.error(`[cine] ERROR: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => killAll());
