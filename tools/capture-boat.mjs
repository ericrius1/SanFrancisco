// Deterministic frame-by-frame render of the Golden Gate "Freedom Boat" hero
// shot (dev/demo.ts case "ggboat"), muxed with music AND a firework-boom audio
// bed so the barrage is heard as well as seen.
//
// Like capture-frames.mjs it stops the wall-clock loop (window.__sfManual) and
// advances the sim by exactly one fixed dt per frame: __sfReelStep(t) sets the
// cinematic to virtual time t, then __sf.tick(1/FPS) renders that single frame,
// then we screenshot it. GPU speed only changes how long the capture takes,
// never the smoothness. It is one continuous shot (no cuts), so tiles are only
// streamed in once, up front.
//
//   node tools/capture-boat.mjs
//
// Env: SF_CAPTURE_FPS (60), SF_CAPTURE_SECONDS (14), SF_CAPTURE_DEMO (ggboat),
// SF_CAPTURE_OUT (renders/golden-gate-boat-cinematic-14s.mp4),
// SF_CAPTURE_WIDTH/HEIGHT, CHROME_BIN. Music: public/audio/rockin.mp3.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { access, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = Number(process.env.SF_CAPTURE_WIDTH ?? 1920);
const HEIGHT = Number(process.env.SF_CAPTURE_HEIGHT ?? 1080);
const FPS = Number(process.env.SF_CAPTURE_FPS ?? 60);
const DURATION = Number(process.env.SF_CAPTURE_SECONDS ?? 14);
const DEMO = process.env.SF_CAPTURE_DEMO ?? "ggboat";
const TOTAL = Math.round(FPS * DURATION);
const DT = 1 / FPS;
// own port so we never reuse a human's dev server (which would run the wrong demo)
const SERVER_URL = process.env.SF_CAPTURE_URL ?? "http://127.0.0.1:5212";
const MUSIC = path.join(ROOT, "public", "audio", "rockin.mp3");
const OUT_MP4 = process.env.SF_CAPTURE_OUT
  ? path.resolve(ROOT, process.env.SF_CAPTURE_OUT)
  : path.join(ROOT, "renders", "golden-gate-boat-cinematic-14s.mp4");
const OUT_POSTER = OUT_MP4.replace(/\.mp4$/i, "-poster.jpg");
const WORK_DIR = path.join(ROOT, ".data", `${DEMO}-frames`);
const RAW_DIR = path.join(WORK_DIR, "raw");
const BOOM_WAV = path.join(WORK_DIR, "boom.wav");
const BED_WAV = path.join(WORK_DIR, "firework-bed.wav");
const CHROME_PROFILE = path.join(WORK_DIR, "chrome");

// When the barrage is heard. The battery fires at T=9.4 (BOAT_FIRE_AT); each of
// the 7 rockets climbs ~1.75 s then detonates (staggered), and every burst
// throws a second "shell of shells" a beat later — so the booms roll from
// ~11.1 s to the end. Each entry is [seconds, gain]; gains taper as the show
// fades. The whole bed is mixed UNDER the music (noticeable, never overpowering).
const BOOMS = [
  [11.15, 0.95], // primary cluster — the 7 rockets all pop within a few frames
  [11.3, 0.9],
  [11.5, 0.85],
  [11.72, 0.8],
  [12.05, 0.82], // secondary shell-of-shells bursts, more spread out
  [12.4, 0.72],
  [12.75, 0.66],
  [13.15, 0.58],
  [13.55, 0.48]
];
const MUSIC_GAIN = 0.92; // the song plays full underneath
const BED_GAIN = 0.9; // punchy booms layered on top — the loudest transients in the mix,
// so they clearly read, but the song's body is untouched (noticeable, not overpowering)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(350);
  }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDevIfNeeded() {
  try {
    await waitHttp(SERVER_URL, 2500, "existing vite");
    return null;
  } catch {
    const relay = await freePort();
    const vitePort = Number(new URL(SERVER_URL).port || 5212);
    console.log(`[boat] starting Vite at ${SERVER_URL}`);
    const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relay) },
      stdio: ["ignore", "ignore", "ignore"]
    });
    await waitHttp(SERVER_URL, 45000, "vite");
    return child;
  }
}
function runProcess(cmd, args) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    c.once("error", rej);
    c.once("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

class Cdp {
  #ws;
  #id = 1;
  #p = new Map();
  onEvent = null; // (method, params) => void — CDP events (no id)
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
      if (!m.id) {
        this.onEvent?.(m.method, m.params);
        return;
      }
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
    this.#ws.close();
  }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
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

// A single firework "boom": a sharp broadband CRACK transient (so it pierces a
// dense rock mix) + a lowpassed brown-noise BODY thump you feel + a sub tone + a
// highpassed crackle tail, all exponentially decaying, then run hot into a
// limiter. Synthesised once, then stamped down at each burst time to build the bed.
async function synthBoom() {
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=1:duration=0.14:sample_rate=48000",
    "-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=1:duration=1.5:sample_rate=48000",
    "-f", "lavfi", "-i", "sine=frequency=48:duration=0.36:sample_rate=48000",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.6:duration=1.3:sample_rate=48000",
    "-filter_complex",
    "[0:a]highpass=f=700,volume='exp(-38*t)':eval=frame[crack];" +
      "[1:a]lowpass=f=260,volume='exp(-4.5*t)':eval=frame[body];" +
      "[2:a]volume='exp(-11*t)':eval=frame[sub];" +
      "[3:a]highpass=f=1800,volume='0.5*exp(-3*t)*(0.5+0.5*sin(2*PI*30*t))':eval=frame[crackle];" +
      "[crack][body][sub][crackle]amix=inputs=4:normalize=0,alimiter=limit=0.98,volume=2.2,alimiter=limit=0.99[out]",
    "-map", "[out]", "-ac", "2", "-ar", "48000", BOOM_WAV
  ]);
}

// Stamp the boom down at every BOOMS time (adelay, per-hit gain) and mix into
// one 14 s stereo bed.
async function synthBed() {
  const inputs = [];
  for (let i = 0; i < BOOMS.length; i++) inputs.push("-i", BOOM_WAV);
  const parts = BOOMS.map(([t, g], i) => `[${i}:a]adelay=${Math.round(t * 1000)}:all=1,volume=${g}[b${i}]`);
  const labels = BOOMS.map((_, i) => `[b${i}]`).join("");
  const filter =
    parts.join(";") +
    `;${labels}amix=inputs=${BOOMS.length}:normalize=0,atrim=0:${DURATION},alimiter=limit=0.97[out]`;
  await runProcess("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", filter,
    "-map", "[out]", "-t", String(DURATION), "-ac", "2", "-ar", "48000", BED_WAV
  ]);
}

async function encode() {
  await synthBoom();
  await synthBed();
  const haveMusic = await isFile(MUSIC);
  if (!haveMusic) console.warn(`[boat] no music at ${MUSIC} — encoding fireworks bed only`);
  // frames + (music ducked a touch) + firework bed, summed and limited
  const args = [
    "-y",
    "-framerate", String(FPS),
    "-i", path.join(RAW_DIR, "frame_%05d.jpg")
  ];
  if (haveMusic) args.push("-i", MUSIC);
  args.push("-i", BED_WAV);
  const musicIdx = 1;
  const bedIdx = haveMusic ? 2 : 1;
  const mix = haveMusic
    ? `[${musicIdx}:a]volume=${MUSIC_GAIN},atrim=0:${DURATION}[m];[${bedIdx}:a]volume=${BED_GAIN}[b];` +
      `[m][b]amix=inputs=2:normalize=0,alimiter=limit=0.98[a]`
    : `[${bedIdx}:a]volume=${BED_GAIN}[a]`;
  args.push(
    "-filter_complex", mix,
    "-map", "0:v",
    "-map", "[a]",
    "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "slow",
    "-crf", "16",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    "-r", String(FPS),
    "-t", String(DURATION),
    OUT_MP4
  );
  await runProcess("ffmpeg", args);
  await runProcess("ffmpeg", ["-y", "-ss", "00:00:02", "-i", OUT_MP4, "-frames:v", "1", "-update", "1", "-q:v", "2", OUT_POSTER]);
}

async function main() {
  const audioOnly = process.env.SF_CAPTURE_AUDIO_ONLY === "1";
  if (audioOnly) {
    // re-mux the existing frames with a freshly-tuned audio bed (fast iteration)
    console.log("[boat] audio-only re-mux of existing frames");
    await encode();
    console.log(`[boat] wrote ${path.relative(ROOT, OUT_MP4)}`);
    return;
  }

  const FROM = Math.max(0, Number(process.env.SF_CAPTURE_FROM ?? 0));
  const TO = Math.min(TOTAL, Number(process.env.SF_CAPTURE_TO ?? TOTAL));
  const partial = FROM > 0 || TO < TOTAL;
  if (!partial) await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(path.dirname(OUT_MP4), { recursive: true });
  const dev = await startDevIfNeeded();
  const chromePath = await findChrome();
  const dport = await freePort();
  const url = `${SERVER_URL}/?demo=${DEMO}&hold=1&manual=1&autostart=1&fullfps=1`;
  console.log(`[boat] ${WIDTH}x${HEIGHT} @ ${FPS}fps, ${TOTAL} frames -> ${url}`);
  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${dport}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      "--headless=new",
      "--no-first-run",
      "--mute-audio",
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--force-device-scale-factor=1",
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  let client;
  try {
    const t0 = Date.now();
    let ver;
    while (Date.now() - t0 < 15000) {
      try {
        ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json();
        break;
      } catch {
        await sleep(200);
      }
    }
    if (!ver) throw new Error("no CDP");
    const page = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    client = new Cdp(page.webSocketDebuggerUrl);
    // surface what actually kills a run: page reloads, JS exceptions, GPU/device
    // loss, tab crashes — otherwise all we see is "__sfReelStep is not a function"
    client.onEvent = (method, params) => {
      if (method === "Runtime.exceptionThrown") {
        const d = params?.exceptionDetails;
        console.warn(`[boat][page-exception] ${d?.exception?.description ?? d?.text ?? JSON.stringify(d).slice(0, 300)}`);
      } else if (method === "Log.entryAdded" && ["error", "warning"].includes(params?.entry?.level)) {
        console.warn(`[boat][page-${params.entry.level}] ${String(params.entry.text).slice(0, 300)}`);
      } else if (method === "Inspector.targetCrashed") {
        console.warn("[boat][TAB CRASHED] renderer gone (likely GPU/device loss)");
      } else if (method === "Page.frameStartedLoading") {
        console.warn("[boat][RELOAD] page started loading again mid-capture");
      }
    };
    await client.open();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Inspector.enable");
    await client.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await client.send("Page.navigate", { url });
    await waitEv(client, "Boolean(window.__sfReelArmed && window.__sf && window.__sfReelStep && window.__sfManual)", 120000, "cine arm");

    await ev(client, "window.__sfManual(true); true");
    await ev(client, `window.__sfReelStep(${FROM * DT}); true`);
    await settle(client, partial ? 40 : 70, 55); // one continuous shot: stream it all in up front

    console.log(`[boat] rendering ${FROM}..${TO}${partial ? " (partial)" : ""}…`);
    for (let i = FROM; i < TO; i++) {
      const t = i * DT;
      await ev(client, `window.__sfReelStep(${t}); true`);
      await tick(client, DT);
      const shot = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 92, fromSurface: true });
      writeFileSync(path.join(RAW_DIR, `frame_${String(i).padStart(5, "0")}.jpg`), Buffer.from(shot.data, "base64"));
      if (i % 60 === 0) console.log(`[boat]   ${i}/${TOTAL} (${t.toFixed(1)}s)`);
    }
  } finally {
    client?.close();
    chrome.kill("SIGTERM");
    dev?.kill("SIGTERM");
  }

  const n = (await readdir(RAW_DIR)).length;
  if (n < TOTAL * 0.9) throw new Error(`only ${n}/${TOTAL} frames`);
  console.log(`[boat] captured ${n} frames; encoding ${FPS}fps MP4 + audio`);
  await encode();
  console.log(`[boat] wrote ${path.relative(ROOT, OUT_MP4)}`);
  if (existsSync(OUT_POSTER)) console.log(`[boat] poster ${path.relative(ROOT, OUT_POSTER)}`);
  await writeFile(path.join(WORK_DIR, "done.txt"), `frames ${n}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
