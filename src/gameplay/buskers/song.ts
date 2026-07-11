import type { BuskerId, NoteEvent } from "./types";

/**
 * The trio's songbook — authored songs sharing one harmonic vocabulary,
 * cycled with Q (BuskerTrio.cycleSong). Live playlist is Fog Rolls Home only;
 * Corona Wind stays authored below but is not in SONGS for now.
 *
 * 1. "Fog Rolls Home" — a shorter, brighter folk tune with real verse/chorus
 *    form. The ukulele opens jamming on driving eighths, the handpan falls in
 *    two bars later, the flute two bars after that; the harmony changes per
 *    section instead of looping one cycle.
 *
 *      bars  1-4    intro — uke jam alone over Dm C Bb C; handpan slips in
 *                   sparse at bar 3, feeling for the pocket
 *      bars  5-12   verse — flute states the motif (D-E-F..A) and answers it,
 *                   resolving up to D5; uke settles to the folk strum,
 *                   handpan stomps the straight-eighth folk groove
 *      bars 13-16   chorus — lifts to the relative major (F C Gm Bb), flute
 *                   up high, uke back to driving eighths, walk-up handoff
 *      bars 17-20   turn — flute tacet; uke picks Dm Bb Gm Am over a sparse
 *                   handpan, Am pulling the ear back home
 *      bars 21-24   chorus' — F C Dm Am, the same lift winding back down
 *      bars 25-28   reprise verse — everyone driving, flute ends on a held E5
 *      bar   29     landing — one long D minor, rung out together
 *
 * 2. "Corona Wind" (disabled) — warm folk riff in D minor. Handpan states the
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
 * construction. After a song the three rest in the wind (REST_SECONDS), the
 * handpan player nods a silent four-beat count-in, and the same song loops
 * (Q advances to the next one).
 *
 * All authored times are in BEATS from song start; the transport owns the
 * mapping onto real time.
 */

export const TEMPO_BPM = 76;
export const SEC_PER_BEAT = 60 / TEMPO_BPM;
export const BEATS_PER_BAR = 4;
export const REST_SECONDS = 12;
export const COUNTIN_BEATS = 4;

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

const FOG_LANDING = 29;

// Per-section harmony (bar 1 → 29). Verses walk Dm C Bb C; the chorus lifts
// to the relative major (F C Gm Bb); the turn borrows Gm and lands on Am — the
// minor dominant — to pull the ear home; the second chorus resolves F C Dm Am.
const FOG_CHORDS: readonly ChordName[] = [
  "Dm", "C", "Bb", "C", // intro (uke jam; pan slips in bar 3)
  "Dm", "C", "Bb", "C", // verse — flute phrase A
  "Dm", "C", "Bb", "C", // verse — flute phrase A'
  "F", "C", "Gm", "Bb", // chorus — flute phrase B
  "Dm", "Bb", "Gm", "Am", // turn — flute tacet, uke picks
  "F", "C", "Dm", "Am", // chorus' — flute phrase B'
  "Dm", "C", "Bb", "C", // reprise verse — phrase A''
  "Dm" // landing
];

const FOG_FLUTE: FluteBars = [
  // phrase A — the motif: rises D-E-F, turns back, and settles on the fifth
  [5, [["D4", 0, 0.75, 0.68], ["E4", 0.75, 0.25, 0.58], ["F4", 1, 0.5, 0.62], ["E4", 1.5, 0.5, 0.58], ["A4", 2, 1.5, 0.75]]],
  [6, [["G4", 0, 1, 0.68], ["A4", 1, 0.5, 0.6], ["G4", 1.5, 0.5, 0.6], ["E4", 2, 1.5, 0.64]]],
  [7, [["F4", 0, 0.5, 0.62], ["G4", 0.5, 0.5, 0.6], ["A4", 1, 1, 0.68], ["Bb4", 2, 1.5, 0.7]]],
  [8, [["A4", 0, 0.5, 0.64], ["G4", 0.5, 1, 0.66], ["E4", 1.5, 0.5, 0.58], ["G4", 2, 1.5, 0.68]]],
  // phrase A' — same opening, the answer climbs to D5 instead of settling
  [9, [["D4", 0, 0.75, 0.7], ["E4", 0.75, 0.25, 0.6], ["F4", 1, 0.5, 0.64], ["E4", 1.5, 0.5, 0.6], ["A4", 2, 1.5, 0.77]]],
  [10, [["G4", 0, 1, 0.68], ["A4", 1, 1, 0.68], ["C5", 2, 2, 0.74]]],
  [11, [["D5", 0, 1, 0.78], ["C5", 1, 0.5, 0.66], ["Bb4", 1.5, 1, 0.72], ["A4", 2.5, 1.5, 0.66]]],
  [12, [["G4", 0, 0.5, 0.6], ["A4", 0.5, 0.5, 0.62], ["C5", 1, 1, 0.7], ["D5", 2, 2, 0.78]]],
  // phrase B — the chorus, up where the fog thins
  [13, [["A4", 0, 0.5, 0.7], ["C5", 0.5, 0.5, 0.7], ["D5", 1, 1, 0.78], ["C5", 2, 2, 0.74]]],
  [14, [["D5", 0, 1, 0.76], ["E5", 1, 1.5, 0.82], ["D5", 2.5, 1.5, 0.74]]],
  [15, [["D5", 0, 1, 0.76], ["C5", 1, 0.5, 0.66], ["Bb4", 1.5, 1, 0.72], ["G4", 2.5, 1.5, 0.66]]],
  [16, [["A4", 0, 1, 0.7], ["Bb4", 1, 1, 0.72], ["C5", 2, 1, 0.7], ["D5", 3, 1, 0.74]]],
  // (bars 17-20: tacet — the turn; he lowers the flute for the picking)
  // phrase B' — the same lift, winding back down home
  [21, [["C5", 0, 1, 0.74], ["D5", 1, 0.5, 0.68], ["C5", 1.5, 1, 0.72], ["A4", 2.5, 1.5, 0.68]]],
  [22, [["G4", 0, 1, 0.68], ["A4", 1, 0.5, 0.62], ["G4", 1.5, 1, 0.66], ["E4", 2.5, 1.5, 0.6]]],
  [23, [["F4", 0, 1, 0.64], ["G4", 1, 0.5, 0.6], ["A4", 1.5, 1.5, 0.7], ["C5", 3, 1, 0.68]]],
  [24, [["E5", 0, 1.5, 0.78], ["D5", 1.5, 0.5, 0.68], ["C5", 2, 1, 0.66], ["A4", 3, 1, 0.62]]],
  // reprise verse — phrase A'', everyone driving under it
  [25, [["D4", 0, 0.75, 0.74], ["E4", 0.75, 0.25, 0.62], ["F4", 1, 0.5, 0.66], ["E4", 1.5, 0.5, 0.6], ["A4", 2, 1.5, 0.8]]],
  [26, [["G4", 0, 1, 0.72], ["A4", 1, 1, 0.72], ["C5", 2, 2, 0.78]]],
  [27, [["D5", 0, 1, 0.8], ["C5", 1, 0.5, 0.68], ["Bb4", 1.5, 1, 0.74], ["A4", 2.5, 1.5, 0.68]]],
  [28, [["G4", 0, 0.5, 0.64], ["A4", 0.5, 0.5, 0.66], ["C5", 1, 1, 0.74], ["E5", 2, 2, 0.84]]],
  // landing — one long D, fading with the ding
  [29, [["D5", 0, 3.5, 0.72]]]
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
      enterBar: 3,
      // sparse entrance under the uke jam, and again for the turn's breath
      sparse: (b) => b <= 4 || b === 17 || b === 18,
      groove: PAN_FOLK,
      // pickup runs into each new section (replace the bar's last beats)
      fills: {
        12: [["E4", 3, 0.55], ["F4", 3.25, 0.58], ["G4", 3.5, 0.62], ["A4", 3.75, 0.68]], // → chorus
        16: [["D4", 3, 0.55], ["C4", 3.5, 0.5]], // settling into the turn
        24: [["D4", 3, 0.58], ["E4", 3.25, 0.6], ["G4", 3.5, 0.64], ["A4", 3.75, 0.7]], // → reprise
        28: [["F4", 3, 0.6], ["A4", 3.25, 0.64], ["G4", 3.5, 0.6], ["A4", 3.75, 0.68]] // → landing
      },
      // verses breathe, choruses sit full, the turn rebuilds, the reprise pushes
      accent: (b) => (b <= 12 ? 0.92 : b <= 16 ? 1 : b <= 20 ? 0.95 : b <= 24 ? 1 : 1.06)
    }),
    ukulele: buildUkulelePart({
      chords: FOG_CHORDS,
      landingBar: FOG_LANDING,
      enterBar: 1,
      // solo jam opening, folk strum under the verses, jam again for the
      // choruses' lift, picked turn, jam reprise
      patternAt: (b) => (b <= 4 ? "jam" : b <= 12 ? "strum" : b <= 16 ? "jam" : b <= 20 ? "pick" : b <= 24 ? "strum" : "jam"),
      accent: (b) => (b <= 4 ? 1 : b <= 12 ? 0.88 : b <= 16 ? 1 : b <= 20 ? 0.92 : b <= 24 ? 0.9 : 1.06)
    }),
    flute: buildFlutePart(FOG_FLUTE)
  }
};

/* ----------------------------------------------------------------- songs */

// Corona Wind stays authored above; drop it back into this array to re-enable.
export const SONGS: readonly TrioSong[] = [FOG_ROLLS_HOME];

// The transport relies on each part being onset-sorted. Sort Corona Wind too
// so re-enabling it is a one-line change.
for (const song of [FOG_ROLLS_HOME, CORONA_WIND]) {
  for (const part of Object.values(song.parts)) part.sort((a, b) => a.beat - b.beat);
}
