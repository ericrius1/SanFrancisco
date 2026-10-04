#!/usr/bin/env node
// Record a reel of short showcase clips from the live app on THIS machine's GPU.
//
//   npm run clips                         # all clips → .data/clips/*.mp4
//   npm run clips -- --only cars,swell    # substring filter on clip ids
//   npm run clips -- --seconds 6          # shorter takes
//   npm run clips -- --publish            # also copy MP4s to SF_CLIPS_PUBLISH_DIR
//
// How it works: starts its own Vite dev server (HMR off) on a free port, opens
// one Chrome page at 1920×1080, and for each clip teleports, sets the hour,
// waits for streaming to settle, then captures deterministically like the
// cinematic renderer: the live loop parks, the sim steps at exactly 1/60 s,
// each final post-FX frame is read back (?fastcapture=1) and encoded to H.264
// with WebCodecs while scripted inputs (input driver rail) and a per-frame
// camera path run on the sim clock. The HUD is DOM, so clips come out clean.
// The raw stream is wrapped into MP4 with ffmpeg when it is on PATH.
//
// Needs a real WebGPU GPU (run it on the Mac, not in a cloud container).
// Env: CHROME_BIN, SF_CLIPS_URL (reuse a running dev server instead of
// starting one), SF_CLIPS_OUT (default .data/clips), SF_CLIPS_PUBLISH_DIR,
// SF_CLIPS_EXTRA_ARGS (extra Chrome flags), SF_CLIPS_INIT (init-script path).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_CLIPS_OUT ?? ".data/clips");
const PUBLISH_DIR = process.env.SF_CLIPS_PUBLISH_DIR ?? "/Users/eric/videos/my creations/sf/renders/cinematics";
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SECONDS = Number(opt("seconds", "10"));
const FPS = Number(opt("fps", "60"));
const ONLY = opt("only", "").split(",").map((s) => s.trim()).filter(Boolean);
const W = Number(opt("width", "1920"));
const H = Number(opt("height", "1080"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[clips] ${m}`);

// ---------------------------------------------------------------- the reel
// `setup` runs in the page (async, gets `sf` = window.__sf). `camera` is the
// body of a function (t, sf) => [eye, target] evaluated every frame, or null
// for the regular chase camera. `inputs` are [atSeconds, "down"|"up", code].
const CLIPS = [
  {
    id: "cars-downtown-cruise",
    title: "Lofted cars with live suspension, cruising downtown",
    hour: 18.1,
    setup: `async (sf) => {
      const x = 4117, z = 300;
      await sf.player.teleportTo({ x, y: sf.map.rideGround(x, z, 60) + sf.player.driveSpec.rideHeight, z, facing: 0, mode: "drive" });
    }`,
    camera: null,
    inputs: [[0, "down", "KeyW"], [2.2, "down", "KeyA"], [3.4, "up", "KeyA"], [4.6, "down", "KeyD"], [5.8, "up", "KeyD"], [7.2, "down", "KeyA"], [8.0, "up", "KeyA"]]
  },
  {
    id: "cars-showroom-orbit",
    title: "Four body styles, orbit",
    hour: 17.2,
    setup: `async (sf) => {
      const x = 4117, z = 130;
      await sf.player.teleportTo({ x, y: sf.map.rideGround(x, z, 60) + sf.player.driveSpec.rideHeight, z, facing: 0.6, mode: "drive" });
      const forms = ["coast-coupe", "apex-wedge", "trail-box", "mission-gt"];
      const base = sf.getCarConfig();
      let i = 0;
      window.__clipTimers.push(setInterval(() => { i = (i + 1) % forms.length; sf.player.setCarConfig({ ...base, form: forms[i], paint: i }); }, 2500));
    }`,
    camera: `(t, sf) => { const p = sf.player.position; const a = t * 0.45; return [[p.x + Math.cos(a) * 7, p.y + 1.6 + Math.sin(t * 0.6) * 0.4, p.z + Math.sin(a) * 7], [p.x, p.y + 0.2, p.z]]; }`,
    inputs: []
  },
  {
    id: "swell-sailing-golden-gate",
    title: "Sailing the new Pacific ground swell outside the Golden Gate",
    hour: 18.65,
    setup: `async (sf) => {
      const x = -4700, z = -3300;
      await sf.player.teleportTo({ x, y: 1, z, facing: -1.35, mode: "boat" });
    }`,
    camera: null,
    inputs: [[0, "down", "KeyW"], [4, "down", "KeyA"], [5.5, "up", "KeyA"]]
  },
  {
    id: "swell-skim-to-bridge",
    title: "Skimming the swell toward the Golden Gate",
    hour: 18.75,
    setup: `async (sf) => {
      await sf.player.teleportTo({ x: -5200, y: 1, z: -3500, facing: -1.5, mode: "boat" });
    }`,
    camera: `(t) => { const x = -6200 + t * 42; return [[x, 7 + Math.sin(t * 0.7) * 1.2, -3520], [x + 120, 4, -3420]]; }`,
    inputs: []
  },
  {
    id: "angel-island-woods",
    title: "Angel Island, newly wooded",
    hour: 17.6,
    setup: `async (sf) => {
      const x = 1080, z = -7700;
      await sf.player.teleportTo({ x, y: sf.map.groundTop(x, z) + 1.5, z, facing: 0, mode: "walk" });
    }`,
    settle: 30000,
    camera: `(t) => { const a = -1.9 + t * 0.05; return [[1080 + Math.cos(a) * 1450, 260, -7920 + Math.sin(a) * 1450], [1080, 60, -7920]]; }`,
    inputs: []
  },
  {
    id: "lincoln-park-cypress",
    title: "Cypress forest over Lincoln Park and Lands End",
    hour: 18.2,
    setup: `async (sf) => {
      const x = -4794, z = 608;
      await sf.player.teleportTo({ x, y: sf.map.groundTop(x, z) + 1.5, z, facing: 0, mode: "walk" });
    }`,
    settle: 25000,
    camera: `(t, sf) => { const x = -4300 - t * 38; const z = 980 - t * 18; return [[x, sf.map.groundTop(x, z) + 55, z], [x - 160, sf.map.groundTop(x - 160, z - 120), z - 120]]; }`,
    inputs: []
  },
  {
    id: "alamo-square-grove",
    title: "Alamo Square, planted",
    hour: 17.4,
    setup: `async (sf) => {
      const x = 827, z = 1640;
      await sf.player.teleportTo({ x, y: sf.map.groundTop(x, z) + 1.5, z, facing: 0, mode: "walk" });
    }`,
    settle: 25000,
    camera: `(t, sf) => { const a = 1.2 + t * 0.07; const g = sf.map.groundTop(827, 1526); return [[827 + Math.cos(a) * 190, g + 62, 1526 + Math.sin(a) * 190], [827, g + 6, 1526]]; }`,
    inputs: []
  },
  {
    id: "dolores-park-palms",
    title: "Dolores Park palms at golden hour",
    hour: 18.35,
    setup: `async (sf) => {
      const x = 1504, z = 3361;
      await sf.player.teleportTo({ x, y: sf.map.groundTop(x, z) + 1.5, z, facing: 0, mode: "walk" });
    }`,
    settle: 25000,
    camera: `(t, sf) => { const x = 1380 + t * 18; const z = 3480; const g = sf.map.groundTop(x, z); return [[x, g + 24, z], [1520, sf.map.groundTop(1520, 3330) + 4, 3330]]; }`,
    inputs: []
  },
  {
    id: "emotes-twirl-dance",
    title: "Softer avatars: twirl, then dance",
    hour: 17.8,
    setup: `async (sf) => {
      const x = 827, z = 1540;
      await sf.player.teleportTo({ x, y: sf.map.groundTop(x, z) + 1.5, z, facing: 0, mode: "walk" });
      window.__clipTimers.push(setTimeout(() => sf.player.playEmote("twirl"), 600));
      window.__clipTimers.push(setTimeout(() => sf.player.playEmote("dance"), 3200));
      window.__clipTimers.push(setTimeout(() => sf.player.playEmote("twirl"), 8000));
    }`,
    camera: `(t, sf) => { const p = sf.player.position; const a = 0.4 + t * 0.32; return [[p.x + Math.cos(a) * 3.4, p.y + 0.9, p.z + Math.sin(a) * 3.4], [p.x, p.y + 0.35, p.z]]; }`,
    inputs: []
  },
  {
    id: "multiplayer-high-five",
    title: "Multiplayer high five",
    hour: 17.5,
    friend: true,
    setup: `async (sf) => {
      const x = 840, z = 1560;
      await sf.player.teleportTo({ x, y: sf.map.groundTop(x, z) + 1.5, z, facing: 0, mode: "walk" });
      window.__clipTimers.push(setTimeout(() => sf.player.playEmote("highfive"), 2000));
      window.__clipTimers.push(setTimeout(() => sf.player.playEmote("highfive"), 6000));
    }`,
    friendSetup: `async (sf) => {
      const x = 840, z = 1558.5;
      await sf.player.teleportTo({ x, y: sf.map.groundTop(x, z) + 1.5, z, facing: Math.PI, mode: "walk" });
    }`,
    friendEmotes: [[2.05, "highfive"], [6.05, "highfive"], [8.3, "twirl"]],
    camera: `(t, sf) => { const p = sf.player.position; return [[p.x + 4.2, p.y + 1.1, p.z - 0.75 + Math.sin(t * 0.3) * 0.6], [p.x, p.y + 0.6, p.z - 0.75]]; }`,
    inputs: []
  }
];

// ---------------------------------------------------------------- plumbing
async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
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

async function waitHttp(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function startVite() {
  if (process.env.SF_CLIPS_URL) return { url: process.env.SF_CLIPS_URL, stop: () => {} };
  const port = await freePort();
  const relay = await freePort();
  const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, SF_HMR: "0", SF_RELAY_PORT: String(relay) },
    stdio: "ignore"
  });
  const url = `http://localhost:${port}`;
  await waitHttp(url, 60000);
  return { url, stop: () => child.kill("SIGTERM") };
}

async function bootPage(browser, url, name) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  if (process.env.SF_CLIPS_INIT) await page.addInitScript({ path: process.env.SF_CLIPS_INIT });
  page.on("pageerror", (e) => log(`${name} page error: ${e.message.slice(0, 300)}`));
  await page.goto(`${url}/?autostart=1&fullfps=1&fastcapture=1&name=${encodeURIComponent(name)}`);
  await page.waitForFunction(() => window.__sf && /ready/.test(document.getElementById("loading")?.className ?? ""), null, { timeout: 240000, polling: 500 });
  await page.evaluate(() => { window.__clipTimers = []; });
  // Immersive: every scrap of UI goes away (the canvas recording never sees
  // DOM anyway, but the friend page and review screenshots stay clean).
  await page.keyboard.press("KeyI");
  return page;
}

/** Minimal IVF container for VP9 WebCodecs output (ffmpeg reads it directly). */
function ivf(chunks, width, height) {
  const header = Buffer.alloc(32);
  header.write("DKIF", 0, "ascii");
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(32, 6);
  header.write("VP90", 8, "ascii");
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header.writeUInt32LE(1_000_000, 16); // timebase: microseconds
  header.writeUInt32LE(1, 20);
  header.writeUInt32LE(chunks.length, 24);
  const parts = [header];
  for (const c of chunks) {
    const fh = Buffer.alloc(12);
    fh.writeUInt32LE(c.data.length, 0);
    fh.writeBigUInt64LE(BigInt(c.ts), 4);
    parts.push(fh, c.data);
  }
  return Buffer.concat(parts);
}

async function recordClip(page, clip, friend) {
  mkdirSync(OUT, { recursive: true });
  log(`▶ ${clip.id} — ${clip.title}`);
  await page.evaluate(({ hour }) => {
    for (const t of window.__clipTimers) { clearTimeout(t); clearInterval(t); }
    window.__clipTimers = [];
    window.__sfFreeCam?.(null);
    window.__sf.sky.setTimeOfDay(hour);
  }, { hour: clip.hour });
  await page.evaluate(`(${clip.setup})(window.__sf)`);
  if (friend && clip.friendSetup) await friend.evaluate(`(${clip.friendSetup})(window.__sf)`);
  await sleep(clip.settle ?? 12000);

  // Deterministic capture, same path as the cinematic renderer: park the live
  // loop, step the sim at exactly 1/FPS, read back each final post-FX frame
  // (?fastcapture=1 target) and feed it to a WebCodecs H.264 encoder. Takes
  // come out perfectly smooth whatever the real-time frame rate is.
  const chunks = [];
  const id = clip.id.replace(/\W/g, "_");
  await page.exposeFunction(`__clipChunk_${id}`, (json) => {
    const c = JSON.parse(json);
    chunks.push({ ts: c.ts, data: Buffer.from(c.data, "base64") });
  });
  await page.exposeFunction(`__clipEvent_${id}`, async (emote) => {
    if (friend) await friend.evaluate((e) => window.__sf.player.playEmote(e), emote);
  });
  const result = await page.evaluate(async ({ seconds, fps, camera, inputs, events, id }) => {
    const sf = window.__sf;
    const [w, h] = sf.pipeline.fastCaptureSize;
    const base = { width: w, height: h, bitrate: 28_000_000, framerate: fps };
    // H.264 (Annex-B) in Google Chrome; open-source Chromium builds ship no
    // H.264 encoder, so fall back to VP9 frames in an IVF container.
    const candidates = [
      ...["avc1.640033", "avc1.640028", "avc1.4D0033"].map((codec) => ({ ...base, codec, avc: { format: "annexb" } })),
      { ...base, codec: "vp09.00.41.08" },
      { ...base, codec: "vp09.00.10.08" }
    ];
    let config = null;
    for (const candidate of candidates) {
      for (const hardwareAcceleration of ["prefer-hardware", "prefer-software"]) {
        const support = await VideoEncoder.isConfigSupported({ ...candidate, hardwareAcceleration }).catch(() => null);
        if (support?.supported) { config = support.config; break; }
      }
      if (config) break;
    }
    if (!config) throw new Error("no H.264 or VP9 WebCodecs encoder available");
    const toB64 = (bytes) => {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const sends = [];
    let encodeError = null;
    const encoder = new VideoEncoder({
      output(chunk) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        sends.push(window[`__clipChunk_${id}`](JSON.stringify({ ts: chunk.timestamp, key: chunk.type === "key", data: toB64(bytes) })));
      },
      error(e) { encodeError = String(e?.message ?? e); }
    });
    encoder.configure(config);
    let encoded = 0;
    const encode = async (pixels, index) => {
      const frame = new VideoFrame(pixels, { format: "RGBA", codedWidth: w, codedHeight: h, timestamp: Math.round(index * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
      frame.close();
      encoded++;
      if (encoder.encodeQueueSize > 6) await encoder.flush();
    };
    // Scripted inputs ride the input module's driver rail on the SIM clock.
    const sched = inputs.slice().sort((a, b) => a[0] - b[0]);
    let k = 0;
    let simT = 0;
    sf.input.setDriver({
      update(_dt, c) {
        while (k < sched.length && sched[k][0] <= simT) {
          const [, kind, code] = sched[k++];
          if (kind === "down") c.hold(code); else c.release(code);
        }
      }
    });
    const path = camera ? (0, eval)(camera) : null;
    const pending = events.slice().sort((a, b) => a[0] - b[0]);
    const frames = Math.round(seconds * fps);
    window.__sfManual(true);
    try {
      await sf.pipeline.drainFastFrame();
      for (let i = 0; i <= frames; i++) {
        simT = i / fps;
        while (pending.length && pending[0][0] <= simT) await window[`__clipEvent_${id}`](pending.shift()[1]);
        if (path) {
          const [eye, target] = path(simT, sf);
          window.__sfFreeCam(eye, target);
        }
        sf.tick(1 / fps);
        // queueFastFrame returns the PREVIOUS frame's pixels (double-buffered).
        const pixels = await sf.pipeline.queueFastFrame();
        if (pixels && i > 0) await encode(pixels, i - 1);
      }
      const last = await sf.pipeline.drainFastFrame();
      if (last) await encode(last, frames);
      await encoder.flush();
      encoder.close();
      await Promise.all(sends);
    } finally {
      sf.input.setDriver(null);
      window.__sfManual(false);
      window.__sfFreeCam?.(null);
    }
    if (encodeError) throw new Error(encodeError);
    return { encoded, w, h, codec: config.codec };
  }, { seconds: SECONDS, fps: FPS, camera: clip.camera, inputs: clip.inputs, events: clip.friendEmotes ?? [], id });

  const isAvc = result.codec.startsWith("avc1");
  const raw = path.join(OUT, `${clip.id}.${isAvc ? "h264" : "ivf"}`);
  writeFileSync(raw, isAvc ? Buffer.concat(chunks.map((c) => c.data)) : ivf(chunks, result.w, result.h));
  let out = raw;
  const mp4 = path.join(OUT, `${clip.id}.mp4`);
  const ff = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", ...(isAvc ? ["-framerate", String(FPS)] : []), "-i", raw,
    ...(isAvc ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS)]),
    "-movflags", "+faststart", mp4
  ]);
  if (ff.status === 0) {
    out = mp4;
    rmSync(raw, { force: true });
  }
  log(`  saved ${path.relative(ROOT, out)} — ${result.encoded} frames at ${result.w}×${result.h}`);
  return out;
}

const clips = CLIPS.filter((c) => !ONLY.length || ONLY.some((o) => c.id.includes(o)));
if (!clips.length) throw new Error(`no clips match --only ${ONLY.join(",")}`);
const vite = await startVite();
log(`dev server ${vite.url}`);
const browser = await chromium.launch({
  executablePath: await findChrome(),
  headless: !flag("headed"),
  args: [
    "--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    // Escape hatch for unusual hosts (e.g. a software adapter in CI).
    ...(process.env.SF_CLIPS_EXTRA_ARGS ?? "").split(" ").filter(Boolean)
  ]
});
const made = [];
try {
  const page = await bootPage(browser, vite.url, "Director");
  const needsFriend = clips.some((c) => c.friend);
  const friend = needsFriend ? await bootPage(browser, vite.url, "Friend") : null;
  await page.bringToFront();
  for (const clip of clips) {
    try {
      made.push(await recordClip(page, clip, clip.friend ? friend : null));
    } catch (error) {
      log(`  ✗ ${clip.id} failed: ${error.message}`);
    }
  }
} finally {
  await browser.close().catch(() => {});
  vite.stop();
}
if (flag("publish") && made.length) {
  mkdirSync(PUBLISH_DIR, { recursive: true });
  for (const f of made.filter((f) => f.endsWith(".mp4"))) copyFileSync(f, path.join(PUBLISH_DIR, path.basename(f)));
  log(`published ${made.length} clip(s) to ${PUBLISH_DIR}`);
}
log(`done: ${made.length}/${clips.length} clips in ${path.relative(ROOT, OUT)}`);
