// One-shot renderer for the 14s Golden Gate "Freedom Truck" cinematic — the same
// on-rails shot the "]" key rolls live (dev/demo.ts case "bridge"), now with the
// "-" flyover (planes + phoenixes) sweeping the strait into the barrage.
//
// Pipeline:
//   1. capture-frames.mjs renders the deterministic silent 1080p60 mp4 (its own
//      Vite on a fresh port, mute-audio headless Chrome, fixed-dt frame capture).
//   2. We synthesize a firework-burst audio bed (pure Node, no deps) whose booms
//      land exactly when the on-screen barrage detonates (~11.1–12.2s).
//   3. ffmpeg mixes "rockin" (full, from the top) with that bed — the song stays
//      dominant, the booms sit clearly under it — and muxes onto the video.
//
//   node tools/render-bridge-flyover.mjs
//
// Env: SF_SKIP_CAPTURE=1 reuses the last silent render (re-mux audio only).
//      SF_FX_VOL (default 0.62) firework-bed level; SF_SONG_VOL (default 0.95).

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, ".data", "bridge-flyover");
const SILENT = path.join(WORK, "silent.mp4");
const FX_WAV = path.join(WORK, "fireworks-bed.wav");
const OUT = path.resolve(ROOT, process.env.SF_OUT ?? "renders/golden-gate-flyover-15s.mp4");
const SONG = path.join(ROOT, "public", "audio", "rockin.mp3");
const SECONDS = Number(process.env.SF_SECONDS ?? 15);
const FPS = 60;
const WIDTH = Number(process.env.SF_WIDTH ?? 2560); // QHD — between 1080p and 4K
const HEIGHT = Number(process.env.SF_HEIGHT ?? 1440);
const SONG_VOL = process.env.SF_SONG_VOL ?? "0.95"; // song stays put; only the booms get louder
const FX_VOL = process.env.SF_FX_VOL ?? "2.6";

const run = (cmd, args, env) =>
  new Promise((res, rej) => {
    const c = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
    c.once("error", rej);
    c.once("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

// ── deterministic firework-bed synthesis ───────────────────────────────────
const SR = 48000;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sum one explosion into the L/R float buffers at time t0 (seconds). Built to
 * HIT: a hard transient slam, two sub-bass sweeps (the chest punch + a deep
 * sustaining rumble), a mid thump so it reads on small speakers, a lowpassed
 * noise body, and a sparse crackle tail. A beefed port of fx/fireworksAudio.ts,
 * scheduled at absolute time so it lines up with the on-screen bursts.
 * Equal-power panned.
 */
function addBoom(L, R, t0, power, pan, rng) {
  const n0 = Math.floor(t0 * SR);
  const len = Math.floor(2.8 * SR);
  const panL = Math.cos(((pan + 1) * Math.PI) / 4);
  const panR = Math.sin(((pan + 1) * Math.PI) / 4);
  let subPhase = 0;
  let sub2Phase = 0;
  let lp = 0; // one-pole lowpass state for the noise body
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // sub sweep 54→24 Hz — the chest punch, fast attack + long decay
    const f = 54 * Math.pow(24 / 54, Math.min(1, t / 0.8));
    subPhase += (2 * Math.PI * f) / SR;
    const subEnv = t < 0.008 ? t / 0.008 : Math.exp(-(t - 0.008) / 0.62);
    let s = Math.sin(subPhase) * subEnv * 2.1;
    // deep sub 40→17 Hz — the felt rumble, slower decay for weight
    const f2 = 40 * Math.pow(17 / 40, Math.min(1, t / 0.9));
    sub2Phase += (2 * Math.PI * f2) / SR;
    const sub2Env = t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) / 0.95);
    s += Math.sin(sub2Phase) * sub2Env * 1.5;
    // mid thump 120→46 Hz — the depth small speakers can reproduce
    const ft = 120 * Math.pow(46 / 120, Math.min(1, t / 0.5));
    const thEnv = t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) / 0.32);
    s += Math.sin(2 * Math.PI * ft * t) * thEnv * 1.05;
    // transient slam — a sharp ~2ms hit so the boom cracks, not just swells
    if (t < 0.03) {
      const slam = Math.exp(-t / 0.006);
      s += (rng() * 2 - 1) * slam * 1.4;
    }
    // noise body, lowpass sweeping shut
    const cutoff = 150 + 1000 * (1 - Math.min(1, t / 1.6));
    const a = Math.exp((-2 * Math.PI * cutoff) / SR);
    lp = a * lp + (1 - a) * (rng() * 2 - 1);
    const bodyEnv = t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) / 0.6);
    s += lp * bodyEnv * 1.3;
    // crackle tail
    if (t > 0.1 && t < 1.5) {
      const k = (t - 0.1) / 1.4;
      if (rng() < 0.0045 * (1 - k)) s += (rng() * 2 - 1) * 0.55 * (1 - k);
    }
    s *= power;
    const idx = n0 + i;
    if (idx >= 0 && idx < L.length) {
      L[idx] += s * panL;
      R[idx] += s * panR;
    }
  }
}

function synthFireworkBed() {
  const total = Math.floor((SECONDS + 0.5) * SR);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const rng = mulberry32(20260704);

  // The truck battery fires at BRIDGE_FIRE_AT (9.4s); its 7 shells have FLIGHT
  // 1.75 + i*0.1 stagger, so primaries detonate ~11.15–11.85s, each throwing a
  // secondary ring a beat later. Match that cascade.
  const N = 7;
  for (let i = 0; i < N; i++) {
    const t = 11.15 + i * 0.1 + rng() * 0.05;
    const pan = ((i - (N - 1) / 2) / ((N - 1) / 2)) * 0.7; // fan wide L→R
    addBoom(L, R, t, 1.15, pan, rng);
    addBoom(L, R, t + 0.28 + rng() * 0.12, 0.6, pan * 0.4, rng); // secondary ring
  }
  // a few big, deep concussions dead-centre to anchor the barrage with weight
  addBoom(L, R, 11.2, 1.4, 0.0, rng);
  addBoom(L, R, 11.7, 1.3, -0.15, rng);
  addBoom(L, R, 12.25, 1.35, 0.12, rng);

  // normalize to a safe peak so the ffmpeg gain stage is predictable
  let peak = 1e-6;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.9 / peak;

  // 16-bit PCM stereo WAV
  const bytes = total * 4;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); // byte rate
  buf.writeUInt16LE(4, 32); // block align
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(bytes, 40);
  let o = 44;
  for (let i = 0; i < total; i++) {
    const l = Math.max(-1, Math.min(1, L[i] * g));
    const r = Math.max(-1, Math.min(1, R[i] * g));
    buf.writeInt16LE((l * 32767) | 0, o);
    buf.writeInt16LE((r * 32767) | 0, o + 2);
    o += 4;
  }
  writeFileSync(FX_WAV, buf);
  console.log(`[bed] wrote ${path.relative(ROOT, FX_WAV)} (${N} shells + secondaries)`);
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(path.dirname(OUT), { recursive: true });

  if (process.env.SF_SKIP_CAPTURE === "1" && existsSync(SILENT)) {
    console.log(`[render] reusing ${path.relative(ROOT, SILENT)}`);
  } else {
    const relay = await freePort();
    const vitePort = await freePort();
    const url = `http://127.0.0.1:${vitePort}`;
    console.log(`[render] capturing ${SECONDS}s @ ${FPS}fps via ${url}`);
    await run("node", ["tools/capture-frames.mjs"], {
      SF_CAPTURE_DEMO: "bridge",
      SF_CAPTURE_SECONDS: String(SECONDS),
      SF_CAPTURE_FPS: String(FPS),
      SF_CAPTURE_WIDTH: String(WIDTH),
      SF_CAPTURE_HEIGHT: String(HEIGHT),
      SF_CAPTURE_CUTS: "", // one continuous shot, no clip settles
      SF_CAPTURE_URL: url,
      SF_RELAY_PORT: String(relay),
      SF_CAPTURE_OUT: SILENT
    });
  }

  synthFireworkBed();

  console.log(`[render] mixing song + firework bed → ${path.relative(ROOT, OUT)}`);
  await run("ffmpeg", [
    "-y",
    "-i", SILENT,
    "-i", SONG,
    "-i", FX_WAV,
    // song held flat; the fx bus gets a low-shelf boom-boost + hard drive, then
    // the sum is caught by a limiter so the booms slam without digital clipping
    "-filter_complex",
    `[1:a]volume=${SONG_VOL}[song];` +
      `[2:a]volume=${FX_VOL},bass=g=7:f=90:width_type=q:w=0.6[fx];` +
      `[song][fx]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.98:level=false[a]`,
    "-map", "0:v:0",
    "-map", "[a]",
    "-t", String(SECONDS),
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    OUT
  ]);

  await run("ffmpeg", ["-y", "-ss", "00:00:12", "-i", OUT, "-frames:v", "1", "-update", "1", "-q:v", "2", OUT.replace(/\.mp4$/i, "-poster.jpg")]);
  console.log(`[render] done → ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
