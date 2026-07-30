#!/usr/bin/env node
// Splice the surf stem library out of the vetted PD/CC0 field recordings in
// .data/audio/surf-src/. Repeatable end to end: the exact source timecodes are
// frozen in CUTS below, crash onsets are refined deterministically from the
// decoded envelope (never by hand), and every output is re-cut from the raw
// download on each run.
//
//   node tools/audio/splice-surf-stems.mjs               everything
//   node tools/audio/splice-surf-stems.mjs --only <id>   one stem
//   node tools/audio/splice-surf-stems.mjs --masters-only  skip the public/ MP3s
//
// Outputs:
//   assets-src/audio/surf/<id>.flac  48 kHz stereo 16-bit masters + manifest.json
//   public/audio/surf/<id>.mp3       160k runtime subset + manifest.json
//
// Sources (downloaded by the commands in DOWNLOADS below; all verified live
// 2026-07-29, all PD-mark or CC0 — no attribution legally required, item pages
// kept as the provenance record):

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FFMPEG = process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN ?? process.env.FFPROBE_PATH ?? "ffprobe";
const SRC_DIR = path.join(ROOT, ".data/audio/surf-src");
const MASTER_DIR = path.join(ROOT, "assets-src/audio/surf");
const RUNTIME_DIR = path.join(ROOT, "public/audio/surf");

export const DOWNLOADS = [
  ["la-jolla-marine-st.ogg", "https://archive.org/download/Freesound-263995/Crashing_Ocean_Waves_3_hours_To_Relax_Sleep_or_Meditate-263995.ogg"],
  ["boca-do-inferno.wav", "https://archive.org/download/aporee_38915_44443/BOCADOINFERNO.WAV"],
  ["isla-vista.wav", "https://archive.org/download/aporee_46560_52875/STE00020191024054441.wav"],
  ["santa-monica.wav", "https://archive.org/download/aporee_71004_82809/1711290313meralosangeles.wav"],
  ["silver-strand.mp3", "https://archive.org/download/aporee_15707_18266/StrandNov2712.mp3"],
  ["alki-01.flac", "https://opengameart.org/sites/default/files/wave_01_cc0-18363__jasinski__alkaibeach.flac"],
  ["alki-02.flac", "https://opengameart.org/sites/default/files/wave_02_cc0-18363__jasinski__alkaibeach.flac"],
  ["alki-03.flac", "https://opengameart.org/sites/default/files/wave_03_cc0-18363__jasinski__alkaibeach.flac"],
  ["alki-04.flac", "https://opengameart.org/sites/default/files/wave_04_cc0-18363__jasinski__alkaibeach.flac"]
];

const SOURCES = {
  "la-jolla": {
    file: "la-jolla-marine-st.ogg",
    source: "Crashing Ocean Waves, Marine St Beach, La Jolla CA — Freesound #263995 (hansende), archive.org mirror",
    sourcePage: "https://archive.org/details/Freesound-263995",
    license: "CC0"
  },
  boca: {
    file: "boca-do-inferno.wav",
    source: "Boca do Inferno, Cascais, Portugal — radio aporee #38915",
    sourcePage: "https://archive.org/details/aporee_38915_44443",
    license: "Public Domain Mark 1.0"
  },
  "isla-vista": {
    file: "isla-vista.wav",
    source: "Isla Vista cliff crash, Goleta CA — radio aporee #46560",
    sourcePage: "https://archive.org/details/aporee_46560_52875",
    license: "Public Domain Mark 1.0"
  },
  "santa-monica": {
    file: "santa-monica.wav",
    source: "Santa Monica beach, just waves — radio aporee #71004",
    sourcePage: "https://archive.org/details/aporee_71004_82809",
    license: "Public Domain Mark 1.0"
  },
  "silver-strand": {
    file: "silver-strand.mp3",
    source: "Glassy Winter Surf, Silver Strand, Coronado CA — radio aporee #15707",
    sourcePage: "https://archive.org/details/aporee_15707_18266",
    license: "Public Domain Mark 1.0"
  },
  "alki-01": { file: "alki-01.flac", source: "Alki Beach wave crash 1 — Freesound #18363 (jasinski) via OpenGameArt", sourcePage: "https://opengameart.org/content/beach-ocean-waves", license: "CC0" },
  "alki-02": { file: "alki-02.flac", source: "Alki Beach wave crash 2 — Freesound #18363 (jasinski) via OpenGameArt", sourcePage: "https://opengameart.org/content/beach-ocean-waves", license: "CC0" },
  "alki-03": { file: "alki-03.flac", source: "Alki Beach wave crash 3 — Freesound #18363 (jasinski) via OpenGameArt", sourcePage: "https://opengameart.org/content/beach-ocean-waves", license: "CC0" },
  "alki-04": { file: "alki-04.flac", source: "Alki Beach wave crash 4 — Freesound #18363 (jasinski) via OpenGameArt", sourcePage: "https://opengameart.org/content/beach-ocean-waves", license: "CC0" }
};

// The cut list. `at` is the coarse crash time found by scan-surf-sources.mjs;
// stems with `refine: true` walk the decoded envelope backwards from the peak
// to the true onset and cut 10 ms before it. Beds/swashes cut at `at` exactly.
const FADES = {
  crash: { in: 0.008, out: 0.35 },
  sub: { in: 0.012, out: 0.5 },
  swash: { in: 0.12, out: 0.6 },
  bed: { in: 1, out: 1 }
};

const SUB_FILTER = "lowpass=f=170:p=2,lowpass=f=170:p=2"; // ≤180 Hz deep-thump layer
const FAR_FILTER = "lowpass=f=1500:p=1"; // gentle air absorption for the distant bed

const CUTS = [
  // -- crash one-shots: big (sandy, thunderous — La Jolla shorebreak) --------
  { id: "crash-big-01", kind: "crash-big", src: "la-jolla", at: 3462.35, refine: true, seconds: 6.2, notes: "heaviest single detonation of the first hour; long wash tail" },
  { id: "crash-big-02", kind: "crash-big", src: "la-jolla", at: 3076.3, refine: true, seconds: 5.8, notes: "deep dump with a fast throw" },
  { id: "crash-big-03", kind: "crash-big", src: "la-jolla", at: 606.2, refine: true, seconds: 6.0, notes: "wide slam, ~3 s roar tail" },
  { id: "crash-big-04", kind: "crash-big", src: "la-jolla", at: 769.9, refine: true, seconds: 6.4, notes: "double-stage break, longest tail of the big set" },
  { id: "crash-big-05", kind: "crash-big", src: "la-jolla", at: 3868.1, refine: true, seconds: 5.6, notes: "clean single impact" },
  // -- crash one-shots: mid ---------------------------------------------------
  { id: "crash-mid-01", kind: "crash-mid", src: "alki-01", at: 0, refine: true, seconds: 3.5, notes: "isolated single break, whole take" },
  { id: "crash-mid-02", kind: "crash-mid", src: "silver-strand", at: 30.05, refine: true, seconds: 4.5, notes: "glassy punchy shorebreak hit" },
  { id: "crash-mid-03", kind: "crash-mid", src: "la-jolla", at: 758.15, refine: true, seconds: 4.8, notes: "medium sandy break inside a set" },
  { id: "crash-mid-04", kind: "crash-mid", src: "silver-strand", at: 76.95, refine: true, seconds: 4.5, notes: "hard windless slap" },
  { id: "crash-mid-05", kind: "crash-mid", src: "alki-04", at: 0, refine: true, seconds: 3.0, notes: "isolated single break, whole take" },
  // -- crash one-shots: small -------------------------------------------------
  { id: "crash-small-01", kind: "crash-small", src: "alki-02", at: 0, refine: true, seconds: 2.0, notes: "small close break" },
  { id: "crash-small-02", kind: "crash-small", src: "alki-03", at: 0, refine: true, seconds: 1.75, notes: "smallest of the Alki takes" },
  { id: "crash-small-03", kind: "crash-small", src: "isla-vista", at: 28.5, refine: true, seconds: 4.0, notes: "cliff-base hit held over the edge, minimal background" },
  { id: "crash-small-04", kind: "crash-small", src: "silver-strand", at: 45.3, refine: true, seconds: 3.2, notes: "light glassy break" },
  // -- sub layers: Boca do Inferno lowpassed ≤180 Hz, stacked under big sand crashes
  { id: "sub-01", kind: "sub", src: "boca", at: 12.55, refine: true, seconds: 3.2, filter: SUB_FILTER, notes: "plunging rock-inlet thump, lowpassed 170 Hz" },
  { id: "sub-02", kind: "sub", src: "boca", at: 210.4, refine: true, seconds: 3.4, filter: SUB_FILTER, notes: "biggest rise over background in the take, lowpassed 170 Hz" },
  { id: "sub-03", kind: "sub", src: "boca", at: 282.7, refine: true, seconds: 3.0, filter: SUB_FILTER, notes: "short heavy body blow, lowpassed 170 Hz" },
  // -- swash / washback sheets ------------------------------------------------
  { id: "swash-01", kind: "swash", src: "santa-monica", at: 196.5, seconds: 4.5, notes: "sheet of bubbles raking up clean sand" },
  { id: "swash-02", kind: "swash", src: "santa-monica", at: 61.0, seconds: 4.2, notes: "wide hissy run-up and drain" },
  { id: "swash-03", kind: "swash", src: "la-jolla", at: 3749.0, seconds: 4.6, notes: "coarser shorebreak washback" },
  { id: "swash-04", kind: "swash", src: "santa-monica", at: 109.5, seconds: 4.4, notes: "gentle spent-wave arrival" },
  { id: "swash-05", kind: "swash", src: "la-jolla", at: 3701.3, seconds: 4.8, notes: "long draining sheet after a big set" },
  // -- beds: three characters, loudness-matched -------------------------------
  { id: "bed-close", kind: "bed", src: "la-jolla", at: 1485.0, seconds: 55, notes: "close hissy shorebreak bed with real distant breaks inside it" },
  { id: "bed-mid", kind: "bed", src: "santa-monica", at: 253.0, seconds: 60, notes: "clean mid-distance sandy surf, steadiest stretch of the take" },
  { id: "bed-far", kind: "bed", src: "la-jolla", at: 8200.0, seconds: 65, filter: FAR_FILTER, notes: "distant roar: hour-three stretch, gentle 1.5 kHz air rolloff" }
];

// Runtime subset shipped to public/audio/surf (MP3 160k, beds trimmed to 45 s).
const RUNTIME = {
  "bed-close": { seconds: 45 },
  "bed-mid": { seconds: 45 },
  "crash-big-01": {},
  "crash-big-03": {},
  "crash-mid-01": {},
  "crash-mid-02": {},
  "crash-mid-03": {},
  "crash-small-01": {},
  "crash-small-03": {},
  "swash-01": {},
  "swash-02": {},
  "swash-03": {},
  "swash-04": {},
  "sub-01": {},
  "sub-02": {}
};

function run(bin, args, allowStderr = false) {
  const res = spawnSync(bin, args, { encoding: null, maxBuffer: 1 << 30 });
  if (res.error) throw new Error(`${bin} unavailable: ${res.error.message}`);
  if (res.status !== 0 && !allowStderr) {
    throw new Error(`${bin} ${args.join(" ")}\n${res.stderr?.toString("utf8")}`);
  }
  return res;
}

/**
 * Deterministic onset refinement: decode a mono envelope around the coarse
 * time, find the peak, walk back to where the envelope was still at the local
 * floor, and cut 10 ms before that. 5 ms resolution.
 */
function refineOnset(sourcePath, coarseAt) {
  const RATE = 4000;
  const WIN = 0.005;
  const from = Math.max(0, coarseAt - 1.5);
  const span = coarseAt - from + 0.6;
  const res = run(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-ss", from.toFixed(3), "-i", sourcePath, "-t", span.toFixed(3),
    "-ac", "1", "-ar", String(RATE), "-f", "f32le", "pipe:1"
  ]);
  const bytes = res.stdout.byteLength - (res.stdout.byteLength % 4);
  const mono = new Float32Array(res.stdout.buffer.slice(res.stdout.byteOffset, res.stdout.byteOffset + bytes));
  const step = Math.round(WIN * RATE);
  const env = new Float32Array(Math.floor(mono.length / step));
  for (let w = 0; w < env.length; w += 1) {
    let sum = 0;
    for (let i = w * step; i < (w + 1) * step; i += 1) sum += mono[i] * mono[i];
    env[w] = Math.sqrt(sum / step);
  }
  let peakIdx = 0;
  for (let i = 1; i < env.length; i += 1) if (env[i] > env[peakIdx]) peakIdx = i;
  // Local floor: median of the stretch before the coarse time.
  const floorSpan = env.slice(0, Math.max(4, Math.min(peakIdx, Math.round(1.0 / WIN))));
  const sorted = Array.from(floorSpan).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length / 2)] || 1e-4;
  let onsetIdx = peakIdx;
  while (onsetIdx > 0 && env[onsetIdx - 1] > floor * 1.6) onsetIdx -= 1;
  return Math.max(0, from + onsetIdx * WIN - 0.01);
}

function measureVolumes(inputPath, start, seconds, filter) {
  const af = [filter, "volumedetect"].filter(Boolean).join(",");
  const res = run(FFMPEG, [
    "-hide_banner",
    "-ss", start.toFixed(3), "-i", inputPath, "-t", seconds.toFixed(3),
    "-af", af, "-ac", "2", "-ar", "48000", "-f", "null", "-"
  ], true);
  const text = res.stderr?.toString("utf8") ?? "";
  const max = Number(/max_volume:\s*(-?[\d.]+)\s*dB/.exec(text)?.[1]);
  const mean = Number(/mean_volume:\s*(-?[\d.]+)\s*dB/.exec(text)?.[1]);
  if (!Number.isFinite(max) || !Number.isFinite(mean)) {
    throw new Error(`volumedetect failed for ${inputPath} @ ${start}`);
  }
  return { max, mean };
}

function spliceOne(cut) {
  const meta = SOURCES[cut.src];
  const sourcePath = path.join(SRC_DIR, meta.file);
  if (!existsSync(sourcePath)) throw new Error(`missing source ${sourcePath} — see DOWNLOADS`);

  const start = cut.refine ? refineOnset(sourcePath, cut.at) : cut.at;
  const dcClean = "highpass=f=19:p=2";
  const shape = [dcClean, cut.filter].filter(Boolean).join(",");
  const { max, mean } = measureVolumes(sourcePath, start, cut.seconds, shape);

  // One-shots: peak-normalize to -3 dBFS. Beds: loudness-match to a -23 dBFS
  // mean, but never let the peak past -2 dBFS.
  const gainDb = cut.kind === "bed" ? Math.min(-23 - mean, -2 - max) : -3 - max;
  const fade = FADES[cut.kind.startsWith("crash") ? "crash" : cut.kind];
  const af = [
    shape,
    `volume=${gainDb.toFixed(2)}dB`,
    `afade=t=in:st=0:d=${fade.in}`,
    `afade=t=out:st=${(cut.seconds - fade.out).toFixed(3)}:d=${fade.out}`
  ].join(",");

  const outPath = path.join(MASTER_DIR, `${cut.id}.flac`);
  run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", start.toFixed(3), "-i", sourcePath, "-t", cut.seconds.toFixed(3),
    "-af", af, "-ac", "2", "-ar", "48000", "-sample_fmt", "s16",
    outPath
  ]);
  console.log(
    `${cut.id.padEnd(16)} ${cut.kind.padEnd(12)} src ${cut.src.padEnd(13)} @ ${start.toFixed(3).padStart(9)}s` +
    `  ${cut.seconds}s  gain ${gainDb.toFixed(1)} dB (peak ${max.toFixed(1)}, mean ${mean.toFixed(1)})`
  );
  return { start, outPath };
}

function encodeRuntime(cut, masterPath) {
  const spec = RUNTIME[cut.id];
  if (!spec) return null;
  const outPath = path.join(RUNTIME_DIR, `${cut.id}.mp3`);
  const seconds = spec.seconds ?? cut.seconds;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", masterPath];
  if (spec.seconds && spec.seconds < cut.seconds) {
    // trimmed bed needs its outgoing edge re-faded
    args.push("-t", String(seconds), "-af", `afade=t=out:st=${seconds - 1}:d=1`);
  }
  args.push("-c:a", "libmp3lame", "-b:a", "160k", "-ar", "48000", outPath);
  run(FFMPEG, args);
  return { outPath, seconds };
}

function probe(file) {
  const res = run(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration,size",
    "-show_entries", "stream=sample_rate,channels",
    "-of", "json", file
  ]);
  const info = JSON.parse(res.stdout.toString("utf8"));
  return {
    seconds: Number(info.format.duration),
    bytes: Number(info.format.size),
    rate: Number(info.streams[0]?.sample_rate),
    channels: Number(info.streams[0]?.channels)
  };
}

function main() {
  const only = process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1]
    : null;
  const mastersOnly = process.argv.includes("--masters-only");
  mkdirSync(MASTER_DIR, { recursive: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  const masterManifest = {};
  const runtimeManifest = {};
  for (const cut of CUTS) {
    if (only && cut.id !== only) continue;
    const { start, outPath } = spliceOne(cut);
    const stat = probe(outPath);
    if (stat.rate !== 48000 || stat.channels !== 2) {
      throw new Error(`${cut.id}: expected 48 kHz stereo, got ${stat.rate}/${stat.channels}`);
    }
    if (Math.abs(stat.seconds - cut.seconds) > 0.05) {
      // Short source: the cut ran off the end of the take, so the end fade
      // never applied. Shorten `seconds` until it fits.
      throw new Error(`${cut.id}: wanted ${cut.seconds}s but got ${stat.seconds}s from the source`);
    }
    const meta = SOURCES[cut.src];
    const entry = {
      id: cut.id,
      kind: cut.kind,
      file: `${cut.id}.flac`,
      source: meta.source,
      sourcePage: meta.sourcePage,
      license: meta.license,
      offsetInSource: Number(start.toFixed(3)),
      seconds: Number(stat.seconds.toFixed(3)),
      notes: cut.notes
    };
    masterManifest[cut.id] = entry;
    if (!mastersOnly) {
      const rt = encodeRuntime(cut, outPath);
      if (rt) {
        const rtStat = probe(rt.outPath);
        runtimeManifest[cut.id] = {
          ...entry,
          file: `${cut.id}.mp3`,
          seconds: Number(rtStat.seconds.toFixed(3)),
          notes: `${cut.notes} (160k runtime encode${rt.seconds !== cut.seconds ? `, trimmed to ${rt.seconds}s` : ""})`
        };
      }
    }
  }

  if (!only) {
    writeFileSync(path.join(MASTER_DIR, "manifest.json"), `${JSON.stringify(masterManifest, null, 2)}\n`);
    if (!mastersOnly) {
      writeFileSync(path.join(RUNTIME_DIR, "manifest.json"), `${JSON.stringify(runtimeManifest, null, 2)}\n`);
    }
    console.log(`\nwrote ${Object.keys(masterManifest).length} masters -> ${path.relative(ROOT, MASTER_DIR)}`);
    if (!mastersOnly) {
      console.log(`wrote ${Object.keys(runtimeManifest).length} runtime stems -> ${path.relative(ROOT, RUNTIME_DIR)}`);
    }
  }
}

main();
