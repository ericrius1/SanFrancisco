import type { BuskerId, NoteEvent } from "./types";

/**
 * The trio's songbook — original authored songs sharing one harmonic
 * vocabulary. The live transport advances through the book after every
 * performance.
 *
 * 1. "Fog Rolls Home" — a ~22-second folk refrain: staggered entrances, one
 *    pass of the motif, and out together. The long rest between plays reads
 *    as part of the piece — a tune the trio keeps returning to, not a set
 *    they're working through.
 *
 *      bar   1      uke jam alone on Dm, feeling for the pocket
 *      bar   2      handpan slips in sparse over C
 *      bars  3-6    the motif — flute rises D-E-F, turns back, and climbs
 *                   to D5 over Dm C Bb C; uke settles to the folk strum
 *                   (jam push in bar 6), handpan stomps the straight-eighth
 *                   folk groove with a fill run into the landing
 *      bar   7      landing — one long D minor, all rung out together
 *
 * 2. "Corona Wind" — warm folk riff in D minor. Handpan states the
 *    pulse alone, ukulele joins, flute carries the tune. Cycle Dm | Bb | F | C.
 *
 *      bars  1-4    handpan alone — sparse ostinato states the pulse
 *      bars  5-8    ukulele joins — calypso strum carries the harmony
 *      bars  9-12   flute enters — phrase A (answering rise)
 *      bars 13-16   flute phrase A' — same opening, climbing resolution
 *      bars 17-20   interlude — flute rests; the uke drops to a picked
 *                   arpeggio over a sparse handpan, then both build back up
 *      bars 21-24   flute phrase B — higher, searching (the folky verse)
 *      bars 25-28   flute phrase B' — winds the search back down home
 *      bars 29-32   reprise — phrase A' again, everyone at full sail
 *      bar   33     landing — one long D minor: ding + slow roll + fading D5
 *
 * Every pitch sits inside the D Kurd handpan scale (D3 A3 Bb3 C4 D4 E4 F4 G4
 * A4) or the ukulele's re-entrant gCEA voicings, and every chord (Dm Bb F C
 * Gm Am) is diatonic to D natural minor, so any simultaneity is consonant by
 * construction. After a song the three rest in the wind for a freshly sampled
 * interval, the handpan player nods a silent four-beat count-in, and the next
 * song begins. The complete quiet gap is intentionally allowed to breathe.
 *
 * All authored times are in BEATS from song start; the transport owns the
 * mapping onto real time.
 */

export const TEMPO_BPM = 76;
export const SEC_PER_BEAT = 60 / TEMPO_BPM;
export const BEATS_PER_BAR = 4;
export const COUNTIN_BEATS = 4;
/** Total silence from one song's ending to the next song's downbeat. */
export const SILENCE_SECONDS_MIN = 10;
export const SILENCE_SECONDS_MAX = 22;

/** Pick once per inter-song break, never once per frame. */
export function sampleSilenceSeconds(random: () => number = Math.random): number {
  const unit = Math.min(1, Math.max(0, random()));
  return SILENCE_SECONDS_MIN + unit * (SILENCE_SECONDS_MAX - SILENCE_SECONDS_MIN);
}

export type ChordName = "Dm" | "Bb" | "F" | "C" | "Gm" | "Am";

export type TrioSong = {
  name: string;
  /** total bars, landing bar included */
  bars: number;
  beats: number;
  /** 1-indexed bar of the final landing chord (everything rings out here) */
  landingBar: number;
  /** the harmony, one chord per bar (chords[bar-1]); the landing bar is Dm */
  chords: readonly ChordName[];
  parts: Record<BuskerId, NoteEvent[]>;
};

/* ------------------------------------------------------------ note names */

const NOTE_MIDI: Record<string, number> = {
  D3: 50, A3: 57, Bb3: 58,
  C4: 60, D4: 62, E4: 64, F4: 65, G4: 67, A4: 69, Bb4: 70,
  C5: 72, D5: 74, E5: 76
};

function n(name: string): number {
  const m = NOTE_MIDI[name];
  if (m === undefined) throw new Error(`unknown note ${name}`);
  return m;
}

/** beat offset of a 1-indexed bar */
function bar(b: number): number {
  return (b - 1) * BEATS_PER_BAR;
}

/** expand a repeating cycle into a per-bar chord list (landing bar = Dm) */
function cycleChords(cycle: readonly ChordName[], bars: number): ChordName[] {
  const out: ChordName[] = [];
  for (let b = 1; b < bars; b++) out.push(cycle[(b - 1) % cycle.length]);
  out.push("Dm");
  return out;
}

/* --------------------------------------------------------------- handpan */

/** One authored handpan bar: [note, beatInBar, vel] triplets. The first hit
 * of each bar is the low "ding" (played on the drum's centre dome). */
type PanHit = readonly [note: string, beat: number, vel: number];

// intro bars — sparse, lets the instrument ring. (Gm has no root on the D
// Kurd drum, so its bars sit on the relative Bb bass.)
const PAN_INTRO: Record<ChordName, readonly PanHit[]> = {
  Dm: [["D3", 0, 1], ["A3", 1, 0.55], ["D4", 1.75, 0.6], ["F4", 2.5, 0.65], ["A3", 3, 0.5]],
  Bb: [["Bb3", 0, 0.95], ["D4", 1, 0.55], ["F4", 1.75, 0.6], ["D4", 2.5, 0.55], ["Bb3", 3, 0.5]],
  F: [["A3", 0, 0.9], ["C4", 1, 0.55], ["F4", 1.75, 0.6], ["A4", 2.5, 0.65], ["F4", 3, 0.5]],
  C: [["C4", 0, 0.95], ["E4", 1, 0.55], ["G4", 1.75, 0.6], ["A4", 2.5, 0.65], ["G4", 3, 0.5]],
  Gm: [["Bb3", 0, 0.95], ["D4", 1, 0.55], ["G4", 1.75, 0.6], ["D4", 2.5, 0.55], ["Bb3", 3, 0.5]],
  Am: [["A3", 0, 0.9], ["C4", 1, 0.55], ["E4", 1.75, 0.6], ["A4", 2.5, 0.65], ["E4", 3, 0.5]]
};

// groove bars — flowing eighths with the handpan's signature 1.75 syncopation
const PAN_GROOVE: Record<ChordName, readonly PanHit[]> = {
  Dm: [["D3", 0, 1], ["A3", 0.5, 0.5], ["D4", 1, 0.7], ["F4", 1.75, 0.6], ["A4", 2, 0.75], ["D4", 2.5, 0.5], ["F4", 3, 0.65], ["A3", 3.5, 0.45]],
  Bb: [["Bb3", 0, 0.95], ["D4", 0.5, 0.5], ["F4", 1, 0.7], ["Bb3", 1.75, 0.55], ["D4", 2, 0.75], ["F4", 2.5, 0.5], ["G4", 3, 0.65], ["D4", 3.5, 0.45]],
  F: [["A3", 0, 0.9], ["C4", 0.5, 0.5], ["F4", 1, 0.7], ["A4", 1.75, 0.6], ["C4", 2, 0.7], ["F4", 2.5, 0.5], ["A4", 3, 0.65], ["C4", 3.5, 0.45]],
  C: [["C4", 0, 0.95], ["E4", 0.5, 0.5], ["G4", 1, 0.7], ["A4", 1.75, 0.6], ["E4", 2, 0.7], ["G4", 2.5, 0.5], ["A4", 3, 0.65], ["G4", 3.5, 0.45]],
  Gm: [["Bb3", 0, 0.95], ["D4", 0.5, 0.5], ["G4", 1, 0.7], ["Bb3", 1.75, 0.55], ["D4", 2, 0.75], ["G4", 2.5, 0.5], ["A4", 3, 0.65], ["D4", 3.5, 0.45]],
  Am: [["A3", 0, 0.9], ["C4", 0.5, 0.5], ["E4", 1, 0.7], ["A4", 1.75, 0.6], ["C4", 2, 0.7], ["E4", 2.5, 0.5], ["A4", 3, 0.65], ["E4", 3.5, 0.45]]
};

// folk groove bars — straighter eighths, stomping on 1 and 3 (no syncopation);
// the drum reads as a rhythm section under the strumming uke
const PAN_FOLK: Record<ChordName, readonly PanHit[]> = {
  Dm: [["D3", 0, 1], ["D4", 1, 0.6], ["A3", 1.5, 0.5], ["D3", 2, 0.85], ["F4", 2.5, 0.6], ["A4", 3, 0.65], ["D4", 3.5, 0.45]],
  Bb: [["Bb3", 0, 0.95], ["D4", 1, 0.6], ["F4", 1.5, 0.5], ["Bb3", 2, 0.8], ["G4", 2.5, 0.6], ["F4", 3, 0.6], ["D4", 3.5, 0.45]],
  F: [["A3", 0, 0.9], ["C4", 1, 0.6], ["F4", 1.5, 0.5], ["A3", 2, 0.8], ["A4", 2.5, 0.6], ["C4", 3, 0.6], ["F4", 3.5, 0.45]],
  C: [["C4", 0, 0.95], ["E4", 1, 0.6], ["G4", 1.5, 0.5], ["C4", 2, 0.8], ["A4", 2.5, 0.6], ["G4", 3, 0.6], ["E4", 3.5, 0.45]],
  Gm: [["Bb3", 0, 0.95], ["D4", 1, 0.6], ["G4", 1.5, 0.5], ["Bb3", 2, 0.8], ["G4", 2.5, 0.6], ["D4", 3, 0.6], ["G4", 3.5, 0.45]],
  Am: [["A3", 0, 0.9], ["C4", 1, 0.6], ["E4", 1.5, 0.5], ["A3", 2, 0.8], ["A4", 2.5, 0.6], ["E4", 3, 0.6], ["C4", 3.5, 0.45]]
};

function buildHandpanPart(opts: {
  chords: readonly ChordName[];
  landingBar: number;
  enterBar: number;
  /** bars that use the sparse intro vocabulary instead of the groove */
  sparse: (bar: number) => boolean;
  groove: Record<ChordName, readonly PanHit[]>;
  /** section-seam fills: bar → hits that replace that bar's tail (from the
   * fill's first beat onward). Little pickup runs into the next section. */
  fills?: Record<number, readonly PanHit[]>;
  /** per-bar dynamics 0..~1.1 — verses breathe, reprises push (clamped) */
  accent?: (bar: number) => number;
}): NoteEvent[] {
  const accent = opts.accent ?? (() => 1);
  const out: NoteEvent[] = [];
  for (let b = opts.enterBar; b < opts.landingBar; b++) {
    const chord = opts.chords[b - 1];
    let hits = opts.sparse(b) ? PAN_INTRO[chord] : opts.groove[chord];
    const fill = opts.fills?.[b];
    if (fill) {
      const from = Math.min(...fill.map(([, beat]) => beat));
      hits = [...hits.filter(([, beat]) => beat < from), ...fill];
    }
    const acc = accent(b);
    for (const [note, beat, vel] of hits) {
      out.push({
        beat: bar(b) + beat,
        dur: 1.5,
        midis: [n(note)],
        vel: Math.min(1, vel * acc),
        tag: beat === 0 ? "ding" : "tone"
      });
    }
  }
  // landing bar — the ding, then two dying echoes
  out.push({ beat: bar(opts.landingBar), dur: 4, midis: [n("D3")], vel: 1, tag: "ding" });
  out.push({ beat: bar(opts.landingBar) + 2, dur: 2, midis: [n("A3")], vel: 0.45, tag: "tone" });
  out.push({ beat: bar(opts.landingBar) + 3, dur: 1, midis: [n("D4")], vel: 0.3, tag: "tone" });
  return out;
}

/* --------------------------------------------------------------- ukulele */

/** Re-entrant gCEA voicings, listed in physical down-strum order
 * (g-string first). Up-strums reverse this order. */
const UKE_CHORDS: Record<ChordName, readonly string[]> = {
  Dm: ["A4", "D4", "F4", "A4"], // 2210
  Bb: ["Bb4", "D4", "F4", "Bb4"], // 3211
  F: ["A4", "C4", "F4", "A4"], // 2010
  C: ["G4", "C4", "E4", "C5"], // 0003
  Gm: ["G4", "D4", "G4", "Bb4"], // 0231
  Am: ["A4", "C4", "E4", "A4"] // 2000
};

/** calypso strum: D . D U . U D U  → beats 0, 1, 1.5, 2.5, 3, 3.5 */
const STRUM_PATTERN: readonly (readonly [beat: number, dir: "down" | "up", vel: number])[] = [
  [0, "down", 0.9],
  [1, "down", 0.6],
  [1.5, "up", 0.5],
  [2.5, "up", 0.65],
  [3, "down", 0.7],
  [3.5, "up", 0.5]
];

/** jam strum: driving straight eighths, accents on 1 and 3 — the solo-uke
 * opening and choruses of "Fog Rolls Home" */
const JAM_PATTERN: readonly (readonly [beat: number, dir: "down" | "up", vel: number])[] = [
  [0, "down", 0.95],
  [0.5, "up", 0.5],
  [1, "down", 0.68],
  [1.5, "up", 0.52],
  [2, "down", 0.85],
  [2.5, "up", 0.5],
  [3, "down", 0.7],
  [3.5, "up", 0.55]
];

/** interlude fingerpicking — steady eighths rolling through the voicing
 * (string indices into the chord's down-strum order), thumb-heavy on the
 * beat like a campfire folk pattern */
const PICK_PATTERN: readonly (readonly [beat: number, str: number, vel: number])[] = [
  [0, 1, 0.62], [0.5, 2, 0.42], [1, 0, 0.5], [1.5, 2, 0.42],
  [2, 3, 0.55], [2.5, 2, 0.42], [3, 0, 0.5], [3.5, 2, 0.45]
];

type UkePattern = "strum" | "jam" | "pick";

function buildUkulelePart(opts: {
  chords: readonly ChordName[];
  landingBar: number;
  enterBar: number;
  patternAt: (bar: number) => UkePattern;
  /** per-bar dynamics — soft under the verse melody, driving in choruses */
  accent?: (bar: number) => number;
}): NoteEvent[] {
  const accent = opts.accent ?? (() => 1);
  const out: NoteEvent[] = [];
  for (let b = opts.enterBar; b < opts.landingBar; b++) {
    const chord = UKE_CHORDS[opts.chords[b - 1]];
    const pattern = opts.patternAt(b);
    const acc = accent(b);
    if (pattern === "pick") {
      // picked arpeggio, alternating gentle down/up motion
      for (let i = 0; i < PICK_PATTERN.length; i++) {
        const [beat, str, vel] = PICK_PATTERN[i];
        out.push({
          beat: bar(b) + beat,
          dur: 0.9,
          midis: [n(chord[str])],
          vel: Math.min(1, vel * acc),
          tag: i % 2 === 0 ? "down" : "up"
        });
      }
    } else {
      const strokes = pattern === "jam" ? JAM_PATTERN : STRUM_PATTERN;
      for (const [beat, dir, vel] of strokes) {
        const midis = chord.map(n);
        if (dir === "up") midis.reverse();
        out.push({ beat: bar(b) + beat, dur: 0.5, midis, vel: Math.min(1, vel * acc), tag: dir });
      }
    }
  }
  // landing — one slow rolled Dm, left ringing
  out.push({ beat: bar(opts.landingBar), dur: 4, midis: UKE_CHORDS.Dm.map(n), vel: 0.7, tag: "arpeggio" });
  return out;
}

/* ----------------------------------------------------------------- flute */

type FluteNote = readonly [note: string, beat: number, dur: number, vel: number];
type FluteBars = readonly (readonly [barNo: number, notes: readonly FluteNote[]])[];

function buildFlutePart(bars: FluteBars): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const [barNo, notes] of bars) {
    for (const [note, beat, dur, vel] of notes) {
      out.push({ beat: bar(barNo) + beat, dur, midis: [n(note)], vel });
    }
  }
  return out;
}

/* --------------------------------------------------- song 1: Corona Wind */

const WIND_LANDING = 33;
const WIND_CHORDS = cycleChords(["Dm", "Bb", "F", "C"], WIND_LANDING);

const WIND_FLUTE: FluteBars = [
  // phrase A — a breath, then an answering rise
  [9, [["A4", 0.5, 1, 0.7], ["F4", 1.5, 0.5, 0.6], ["G4", 2, 0.5, 0.6], ["A4", 2.5, 1.5, 0.75]]],
  [10, [["D5", 0, 1, 0.8], ["C5", 1, 0.5, 0.65], ["Bb4", 1.5, 1, 0.7], ["A4", 2.5, 1.5, 0.65]]],
  [11, [["C5", 0, 1.5, 0.75], ["A4", 1.5, 0.5, 0.6], ["F4", 2, 1, 0.65], ["G4", 3, 1, 0.6]]],
  [12, [["E4", 0, 1, 0.6], ["G4", 1, 1, 0.65], ["A4", 2, 2, 0.7]]],
  // phrase A' — same opening, climbing to the resolution
  [13, [["A4", 0.5, 1, 0.7], ["F4", 1.5, 0.5, 0.6], ["G4", 2, 0.5, 0.6], ["A4", 2.5, 1.5, 0.75]]],
  [14, [["D5", 0, 1, 0.8], ["C5", 1, 0.5, 0.65], ["Bb4", 1.5, 1, 0.7], ["C5", 2.5, 1.5, 0.7]]],
  [15, [["D5", 0, 1.5, 0.8], ["C5", 1.5, 0.5, 0.65], ["A4", 2, 1, 0.65], ["C5", 3, 1, 0.7]]],
  [16, [["D5", 0, 1.5, 0.75], ["C5", 1.5, 0.5, 0.6], ["E5", 2, 2, 0.8]]],
  // (bars 17-20: tacet — he lowers the flute and listens to the picking)
  // phrase B — higher, searching
  [21, [["F4", 0, 0.5, 0.6], ["G4", 0.5, 0.5, 0.6], ["A4", 1, 1, 0.72], ["D5", 2, 1.5, 0.8]]],
  [22, [["D5", 0, 1, 0.75], ["Bb4", 1, 1, 0.7], ["A4", 2, 1.5, 0.65]]],
  [23, [["C5", 0, 1, 0.7], ["A4", 1, 0.5, 0.6], ["C5", 1.5, 1, 0.7], ["F4", 2.5, 1.5, 0.6]]],
  [24, [["G4", 0, 1, 0.6], ["A4", 1, 1, 0.65], ["E5", 2, 2, 0.8]]],
  // phrase B' — winding the search back down home
  [25, [["F4", 0.5, 0.5, 0.6], ["G4", 1, 0.5, 0.6], ["A4", 1.5, 1, 0.7], ["C5", 2.5, 1.5, 0.75]]],
  [26, [["D5", 0, 1.5, 0.8], ["C5", 1.5, 0.5, 0.65], ["Bb4", 2, 2, 0.7]]],
  [27, [["A4", 0, 1, 0.7], ["C5", 1, 1, 0.7], ["D5", 2, 2, 0.78]]],
  [28, [["E5", 0, 1.5, 0.8], ["D5", 1.5, 0.5, 0.7], ["C5", 2, 1, 0.65], ["A4", 3, 1, 0.6]]],
  // reprise — phrase A' at full sail
  [29, [["A4", 0.5, 1, 0.72], ["F4", 1.5, 0.5, 0.62], ["G4", 2, 0.5, 0.62], ["A4", 2.5, 1.5, 0.78]]],
  [30, [["D5", 0, 1, 0.82], ["C5", 1, 0.5, 0.67], ["Bb4", 1.5, 1, 0.72], ["C5", 2.5, 1.5, 0.72]]],
  [31, [["D5", 0, 1.5, 0.82], ["C5", 1.5, 0.5, 0.67], ["A4", 2, 1, 0.67], ["C5", 3, 1, 0.72]]],
  [32, [["D5", 0, 1.5, 0.78], ["C5", 1.5, 0.5, 0.62], ["E5", 2, 2, 0.82]]],
  // landing — one long D, fading with the ding
  [33, [["D5", 0, 3.5, 0.7]]]
];

const CORONA_WIND: TrioSong = {
  name: "Corona Wind",
  bars: WIND_LANDING,
  beats: WIND_LANDING * BEATS_PER_BAR,
  landingBar: WIND_LANDING,
  chords: WIND_CHORDS,
  parts: {
    handpan: buildHandpanPart({
      chords: WIND_CHORDS,
      landingBar: WIND_LANDING,
      enterBar: 1,
      // sparse for the solo intro AND the first half of the interlude (the
      // breath in the middle of the song), grooving everywhere else
      sparse: (b) => b <= 4 || b === 17 || b === 18,
      groove: PAN_GROOVE
    }),
    ukulele: buildUkulelePart({
      chords: WIND_CHORDS,
      landingBar: WIND_LANDING,
      enterBar: 5,
      patternAt: (b) => (b >= 17 && b <= 20 ? "pick" : "strum")
    }),
    flute: buildFlutePart(WIND_FLUTE)
  }
};

/* ------------------------------------------------ song 2: Fog Rolls Home */

const FOG_LANDING = 7;

// Two-bar assembling vamp (Dm C), one pass of the verse harmony (Dm C Bb C),
// landing home on Dm.
const FOG_CHORDS: readonly ChordName[] = [
  "Dm", "C", // vamp — uke alone, then handpan slips in
  "Dm", "C", "Bb", "C", // the motif — flute phrase A
  "Dm" // landing
];

const FOG_FLUTE: FluteBars = [
  // phrase A — the motif: rises D-E-F, turns back, then climbs to D5
  [3, [["D4", 0, 0.75, 0.7], ["E4", 0.75, 0.25, 0.6], ["F4", 1, 0.5, 0.64], ["E4", 1.5, 0.5, 0.6], ["A4", 2, 1.5, 0.77]]],
  [4, [["G4", 0, 1, 0.68], ["A4", 1, 1, 0.68], ["C5", 2, 2, 0.74]]],
  [5, [["D5", 0, 1, 0.78], ["C5", 1, 0.5, 0.66], ["Bb4", 1.5, 1, 0.72], ["A4", 2.5, 1.5, 0.66]]],
  [6, [["G4", 0, 0.5, 0.6], ["A4", 0.5, 0.5, 0.62], ["C5", 1, 1, 0.7], ["D5", 2, 2, 0.78]]],
  // landing — one long D, fading with the ding
  [7, [["D5", 0, 3.5, 0.72]]]
];

const FOG_ROLLS_HOME: TrioSong = {
  name: "Fog Rolls Home",
  bars: FOG_LANDING,
  beats: FOG_LANDING * BEATS_PER_BAR,
  landingBar: FOG_LANDING,
  chords: FOG_CHORDS,
  parts: {
    handpan: buildHandpanPart({
      chords: FOG_CHORDS,
      landingBar: FOG_LANDING,
      enterBar: 2,
      // slips in sparse under the uke vamp, then the folk stomp with the flute
      sparse: (b) => b === 2,
      groove: PAN_FOLK,
      // pickup run into the landing (replaces the bar's last beats)
      fills: {
        6: [["F4", 3, 0.6], ["A4", 3.25, 0.64], ["G4", 3.5, 0.6], ["A4", 3.75, 0.68]] // → landing
      },
      // swell gently toward the landing
      accent: (b) => (b <= 2 ? 0.92 : b <= 5 ? 1 : 1.06)
    }),
    ukulele: buildUkulelePart({
      chords: FOG_CHORDS,
      landingBar: FOG_LANDING,
      enterBar: 1,
      // solo jam vamp, folk strum under the motif, one driving jam bar
      // into the landing
      patternAt: (b) => (b <= 2 ? "jam" : b <= 5 ? "strum" : "jam"),
      accent: (b) => (b <= 2 ? 1 : b <= 5 ? 0.9 : 1.06)
    }),
    flute: buildFlutePart(FOG_FLUTE)
  }
};

/* ----------------------------------------------------------------- songs */

export const SONGS: readonly TrioSong[] = [FOG_ROLLS_HOME, CORONA_WIND];

// The transport relies on each part being onset-sorted.
for (const song of SONGS) {
  for (const part of Object.values(song.parts)) part.sort((a, b) => a.beat - b.beat);
}
