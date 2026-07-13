// Structural audit of the busker trio's authored songbook (src/gameplay/buskers/song.ts).
// No audio: checks the things that make the three parts harmonize by
// construction — every pitch diatonic to D natural minor, handpan confined to
// the D Kurd scale, onsets sorted and inside the song, sane velocities and
// durations, and per-bar chord membership for the strummed ukulele voicings.
// Runs the same checks against every song in SONGS, using each song's own
// per-bar chord list and landing bar.
//
//   node --experimental-strip-types tools/buskers-song-probe.mjs

import {
  SONGS,
  BEATS_PER_BAR,
  SEC_PER_BEAT,
  SILENCE_SECONDS_MIN,
  SILENCE_SECONDS_MAX,
  sampleSilenceSeconds
} from "../src/gameplay/buskers/song.ts";

let failures = 0;

if (SONGS.length < 2) {
  failures++;
  console.error("FAIL [songbook]: rotation needs at least two songs");
}
if (new Set(SONGS.map((song) => song.name)).size !== SONGS.length) {
  failures++;
  console.error("FAIL [songbook]: song names must be unique");
}
if (sampleSilenceSeconds(() => 0) !== SILENCE_SECONDS_MIN) {
  failures++;
  console.error("FAIL [transport]: random silence lower bound is incorrect");
}
if (sampleSilenceSeconds(() => 1) !== SILENCE_SECONDS_MAX) {
  failures++;
  console.error("FAIL [transport]: random silence upper bound is incorrect");
}

const pc = (midi) => ((midi % 12) + 12) % 12;
const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

// D natural minor pitch classes: D E F G A Bb C
const D_MINOR = new Set([2, 4, 5, 7, 9, 10, 0]);
// D Kurd 9 handpan: D3 A3 Bb3 C4 D4 E4 F4 G4 A4
const KURD = new Set([50, 57, 58, 60, 62, 64, 65, 67, 69]);
const CHORDS = { Dm: [2, 5, 9], Bb: [10, 2, 5], F: [5, 9, 0], C: [0, 4, 7], Gm: [7, 10, 2], Am: [9, 0, 4] };
// melody colour tones allowed on sustained notes beyond the triad (6th/9th;
// Bb gets the maj7, Gm its 9th/11th/6th, Am the 11th and b7)
const COLOUR = { Dm: [4, 0], Bb: [7, 0, 9], F: [2, 7], C: [9, 2], Gm: [9, 0, 4], Am: [2, 7] };
// bar-opening handpan ding: chord root, or the drum's bass substitute where
// the root is missing from the D Kurd scale (F→A third-bass, C→C, Gm→Bb)
const DING_OK = { Dm: [2], Bb: [10], F: [5, 9], C: [0], Gm: [7, 10], Am: [9] };

for (const song of SONGS) {
  const fail = (msg) => {
    failures++;
    console.error(`FAIL [${song.name}]:`, msg);
  };

  if (song.chords.length !== song.bars) fail(`chords list has ${song.chords.length} entries for ${song.bars} bars`);
  if (song.chords[song.landingBar - 1] !== "Dm") fail(`landing bar chord is ${song.chords[song.landingBar - 1]}, must be Dm`);
  const chordAt = (bar) => song.chords[Math.min(bar, song.bars) - 1];

  for (const [part, events] of Object.entries(song.parts)) {
    if (!events.length) fail(`${part}: empty part`);
    let prev = -1;
    for (const e of events) {
      if (e.beat < prev) fail(`${part}: unsorted onset at beat ${e.beat}`);
      prev = e.beat;
      if (e.beat < 0 || e.beat >= song.beats) fail(`${part}: onset ${e.beat} outside song`);
      if (e.beat + e.dur > song.beats + 1e-6) fail(`${part}: event at ${e.beat} rings past song end`);
      if (!(e.dur > 0)) fail(`${part}: non-positive dur at beat ${e.beat}`);
      if (!(e.vel > 0 && e.vel <= 1)) fail(`${part}: vel ${e.vel} at beat ${e.beat}`);
      const bar = Math.floor(e.beat / BEATS_PER_BAR) + 1;
      for (const m of e.midis) {
        if (!D_MINOR.has(pc(m))) fail(`${part}: chromatic note ${NAMES[pc(m)]}${m} at bar ${bar} beat ${e.beat}`);
        if (part === "handpan" && !KURD.has(m)) fail(`handpan: ${m} not on the D Kurd drum (bar ${bar})`);
      }
      // strummed chords must be spelled from the bar's chord tones exactly
      if (part === "ukulele") {
        const tones = new Set(CHORDS[chordAt(bar)]);
        for (const m of e.midis) if (!tones.has(pc(m))) fail(`ukulele: ${NAMES[pc(m)]} not in ${chordAt(bar)} at bar ${bar}`);
      }
      // bar-opening handpan dings must be the chord root (or its bass substitute)
      if (part === "handpan" && e.tag === "ding") {
        const bass = pc(e.midis[0]);
        if (!DING_OK[chordAt(bar)].includes(bass)) fail(`handpan: bar ${bar} ding is ${NAMES[bass]}, chord ${chordAt(bar)}`);
      }
    }
  }

  // melody-vs-chord spot check: flute notes ≥ a quarter note long should be
  // consonant with the bar (chord tone, or the colour tones above).
  for (const e of song.parts.flute) {
    if (e.dur < 1) continue;
    const bar = Math.floor(e.beat / BEATS_PER_BAR) + 1;
    const chord = chordAt(bar);
    const allowed = new Set([...CHORDS[chord], ...COLOUR[chord]]);
    for (const m of e.midis) {
      if (!allowed.has(pc(m))) fail(`flute: sustained ${NAMES[pc(m)]} clashes with ${chord} at bar ${bar} beat ${e.beat}`);
    }
  }

  const counts = Object.fromEntries(Object.entries(song.parts).map(([k, v]) => [k, v.length]));
  console.log(`"${song.name}": ${song.beats} beats (${(song.beats * SEC_PER_BEAT).toFixed(1)}s), events:`, counts);
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log(`songbook audit clean — ${SONGS.length} song(s), all parts diatonic, sorted, in range, chord-true`);
