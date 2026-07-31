#!/usr/bin/env node
// Render a 20 s audition of the spliced surf stem library so the director can
// listen before wiring the real films: two beds under two crash sets (with
// Boca sub layers under the big hits) and swash arrivals at plausible beach
// timing. Uses the exact offline primitives the cinematic scores use
// (createMix / mixNatureBed / mixStem / masterAndLimit), so this doubles as an
// end-to-end test of mixStem.
//
//   FFMPEG_BIN=... node tools/audio/render-surf-audition.mjs
//   -> .data/audio/surf-audition.wav

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMix,
  encodePcm16Wav,
  masterAndLimit,
  mixNatureBed,
  mixStem
} from "../cinematic/audio.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, ".data/audio/surf-audition.wav");
const STEM = (id) => `assets-src/audio/surf/${id}.flac`;

const mix = createMix(20, 20260729);
const reports = [];

// Beds: close hissy shorebreak carrying the shot, distant roar filling behind.
reports.push(mixNatureBed(mix, { path: STEM("bed-close"), volume: 0.3, offset: 6 }, 0));
reports.push(mixNatureBed(mix, { path: STEM("bed-far"), volume: 0.16, offset: 21 }, 1));

// Set one: a big detonation left of frame, its sub thump, a mid answer right,
// then the water arriving at the sand a few seconds later.
reports.push(mixStem(mix, { path: STEM("crash-big-01"), at: 1.8, volume: 0.62, pan: -0.35 }, 0));
reports.push(mixStem(mix, { path: STEM("sub-01"), at: 1.8, volume: 0.5, pan: -0.2 }, 1));
reports.push(mixStem(mix, { path: STEM("crash-mid-02"), at: 3.4, volume: 0.42, pan: 0.4 }, 2));
reports.push(mixStem(mix, { path: STEM("swash-01"), at: 5.9, volume: 0.4, pan: -0.15 }, 3));
reports.push(mixStem(mix, { path: STEM("swash-03"), at: 8.1, volume: 0.34, pan: 0.3 }, 4));

// A far small break in the lull — lowpassed and quiet, the distance test.
reports.push(mixStem(mix, { path: STEM("crash-small-03"), at: 9.6, volume: 0.22, pan: 0.6, lowpassHz: 1600 }, 5));

// Set two, bigger: stacked big + sub dead ahead, a second big far right
// lowpassed by distance, mid follow-up, then two washes to the resolve.
reports.push(mixStem(mix, { path: STEM("crash-big-04"), at: 11.6, volume: 0.68, pan: 0.1 }, 6));
reports.push(mixStem(mix, { path: STEM("sub-02"), at: 11.6, volume: 0.58, pan: 0 }, 7));
reports.push(mixStem(mix, { path: STEM("crash-big-03"), at: 12.9, volume: 0.3, pan: 0.65, lowpassHz: 2400 }, 8));
reports.push(mixStem(mix, { path: STEM("crash-mid-01"), at: 14.4, volume: 0.4, pan: -0.45 }, 9));
reports.push(mixStem(mix, { path: STEM("swash-02"), at: 15.9, volume: 0.4, pan: 0.1 }, 10));
reports.push(mixStem(mix, { path: STEM("swash-04"), at: 17.8, volume: 0.32, pan: -0.3 }, 11));

const levels = masterAndLimit(mix, 1.5);
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, encodePcm16Wav(mix.left, mix.right, 48_000));

let failures = 0;
for (const report of reports) {
  const status = report.mixed ? "ok " : "FAIL";
  if (!report.mixed) failures += 1;
  const when = report.at !== undefined ? ` @ ${report.at}s` : "";
  console.log(`${status} ${path.basename(report.path)}${when} vol ${report.volume}${report.reason ? ` — ${report.reason}` : ""}`);
}
console.log(`\n${OUT}`);
console.log(`peak ${levels.peakDb} dBFS, rms ${levels.rmsDb} dBFS${failures ? `, ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
