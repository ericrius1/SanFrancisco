#!/usr/bin/env node
// Envelope scanner for the raw surf field recordings in .data/audio/surf-src/.
// Used to CHOOSE the source timecodes that are then frozen into
// splice-surf-stems.mjs — this tool never writes stems itself.
//
//   node tools/audio/scan-surf-sources.mjs crashes <file> [--from s] [--to s] [--top n]
//   node tools/audio/scan-surf-sources.mjs beds    <file> [--from s] [--to s] [--len s]
//   node tools/audio/scan-surf-sources.mjs swash   <file> [--from s] [--to s] [--top n]
//
// crashes: windows where broadband RMS jumps well above the running background
//          after a relative lull — candidate one-shot starts.
// beds:    the steadiest (lowest RMS variance) stretches of the requested
//          length — candidate bed regions.
// swash:   moderate-level windows dominated by high-band hiss with little
//          low-frequency slam — candidate washback textures.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const FFMPEG = process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg";
const RATE = 8000; // analysis rate; envelopes only, never audio output

function args() {
  const [mode, file, ...rest] = process.argv.slice(2);
  const opt = { from: 0, to: 0, top: 24, len: 50 };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (key in opt) opt[key] = Number(rest[i + 1]);
  }
  return { mode, file, ...opt };
}

function decodeMono(file, from, to, filter) {
  const cliArgs = ["-hide_banner", "-loglevel", "error"];
  if (from > 0) cliArgs.push("-ss", String(from));
  cliArgs.push("-i", file);
  if (to > from) cliArgs.push("-t", String(to - from));
  if (filter) cliArgs.push("-af", filter);
  cliArgs.push("-ac", "1", "-ar", String(RATE), "-f", "f32le", "pipe:1");
  const res = spawnSync(FFMPEG, cliArgs, { encoding: null, maxBuffer: 1 << 30 });
  if (res.status !== 0) throw new Error(res.stderr?.toString("utf8") ?? "ffmpeg failed");
  const bytes = res.stdout.byteLength - (res.stdout.byteLength % 4);
  return new Float32Array(res.stdout.buffer.slice(res.stdout.byteOffset, res.stdout.byteOffset + bytes));
}

/** RMS per `win`-second window. */
function envelope(samples, win) {
  const step = Math.round(win * RATE);
  const out = new Float32Array(Math.floor(samples.length / step));
  for (let w = 0; w < out.length; w += 1) {
    let sum = 0;
    for (let i = w * step; i < (w + 1) * step; i += 1) sum += samples[i] * samples[i];
    out[w] = Math.sqrt(sum / step);
  }
  return out;
}

const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf");

function scanCrashes({ file, from, to, top }) {
  const WIN = 0.05;
  const env = envelope(decodeMono(file, from, to), WIN);
  // Running background: median-ish via slow follower over ~8 s.
  const bg = new Float32Array(env.length);
  let follow = env[0] ?? 0;
  for (let i = 0; i < env.length; i += 1) {
    follow += (env[i] - follow) * (env[i] > follow ? 0.004 : 0.02);
    bg[i] = follow;
  }
  const hits = [];
  let lastHit = -Infinity;
  for (let i = 20; i < env.length - 20; i += 1) {
    const t = from + i * WIN;
    if (t - lastHit < 4) continue;
    // sharp rise over ~0.4 s and clearly above background
    const before = Math.min(env[i - 6], env[i - 8]);
    const peak = Math.max(env[i], env[i + 1], env[i + 2]);
    if (peak > bg[i] * 1.9 && peak > before * 2.4 && peak > 0.01) {
      // measure the tail: seconds until the envelope falls to 1.25x background
      let tail = 0;
      for (let j = i + 3; j < Math.min(env.length, i + 200); j += 1) {
        if (env[j] < bg[j] * 1.25) { tail = (j - i) * WIN; break; }
        tail = (j - i) * WIN;
      }
      hits.push({ t, peakDb: db(peak), bgDb: db(bg[i]), tail: tail.toFixed(1) });
      lastHit = t;
      i += 40;
    }
  }
  hits.sort((a, b) => Number(b.peakDb) - Number(a.peakDb));
  for (const h of hits.slice(0, top)) {
    console.log(`crash @ ${h.t.toFixed(2).padStart(9)}s  peak ${h.peakDb} dB  bg ${h.bgDb} dB  tail ~${h.tail}s`);
  }
}

function scanBeds({ file, from, to, len }) {
  const WIN = 0.5;
  const env = envelope(decodeMono(file, from, to), WIN);
  const winCount = Math.round(len / WIN);
  const scored = [];
  for (let i = 0; i + winCount < env.length; i += Math.round(5 / WIN)) {
    let sum = 0;
    for (let j = i; j < i + winCount; j += 1) sum += env[j];
    const mean = sum / winCount;
    let varSum = 0;
    for (let j = i; j < i + winCount; j += 1) varSum += (env[j] - mean) ** 2;
    const cv = Math.sqrt(varSum / winCount) / (mean || 1);
    scored.push({ t: from + i * WIN, meanDb: db(mean), cv });
  }
  scored.sort((a, b) => a.cv - b.cv);
  for (const s of scored.slice(0, 12)) {
    console.log(`bed ${len}s @ ${s.t.toFixed(1).padStart(9)}s  mean ${s.meanDb} dB  cv ${s.cv.toFixed(3)}`);
  }
}

function scanSwash({ file, from, to, top }) {
  const WIN = 0.25;
  const hi = envelope(decodeMono(file, from, to, "highpass=f=1400"), WIN);
  const lo = envelope(decodeMono(file, from, to, "lowpass=f=250"), WIN);
  const n = Math.min(hi.length, lo.length);
  const spans = [];
  let start = -1;
  for (let i = 0; i < n; i += 1) {
    const hissy = hi[i] > 0.004 && hi[i] > lo[i] * 0.75;
    if (hissy && start < 0) start = i;
    if ((!hissy || i === n - 1) && start >= 0) {
      const seconds = (i - start) * WIN;
      if (seconds >= 2) spans.push({ t: from + start * WIN, seconds, hiDb: db(hi[start + 1] ?? hi[start]) });
      start = -1;
    }
  }
  spans.sort((a, b) => b.seconds - a.seconds);
  for (const s of spans.slice(0, top)) {
    console.log(`swash @ ${s.t.toFixed(2).padStart(9)}s  ${s.seconds.toFixed(1)}s  hi ${s.hiDb} dB`);
  }
}

const opts = args();
if (!opts.mode || !opts.file || !existsSync(opts.file)) {
  console.error("usage: scan-surf-sources.mjs crashes|beds|swash <file> [--from s] [--to s] [--top n] [--len s]");
  process.exit(2);
}
if (opts.mode === "crashes") scanCrashes(opts);
else if (opts.mode === "beds") scanBeds(opts);
else if (opts.mode === "swash") scanSwash(opts);
else { console.error(`unknown mode ${opts.mode}`); process.exit(2); }
