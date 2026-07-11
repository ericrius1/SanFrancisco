import type { BuskerId, NoteEvent } from "./types";

/**
 * "Corona Wind" — the trio's one song. A simple, warm folk riff in D minor at
 * 76 bpm, built so the three parts interlock rather than compete:
 *
 *   bars  1-4    handpan alone — sparse ostinato states the pulse
 *   bars  5-8    ukulele joins — calypso strum carries the harmony
 *   bars  9-12   flute enters — phrase A (answering rise)
 *   bars 13-16   flute phrase A' — same opening, climbing resolution
 *   bars 17-20   interlude — flute rests; the uke drops to a picked
 *                arpeggio over a sparse handpan, then both build back up
 *   bars 21-24   flute phrase B — higher, searching (the folky verse)
 *   bars 25-28   flute phrase B' — winds the search back down home
 *   bars 29-32   reprise — phrase A' again, everyone at full sail
 *   bar   33     landing — one long D minor: ding + slow roll + fading D5
 *
 * Harmony is a four-bar cycle Dm | Bb | F | C (i-VI-III-VII) that runs
 * unbroken through every section, every pitch inside the D Kurd handpan
 * scale (D3 A3 Bb3 C4 D4 E4 F4 G4 A4) or the ukulele's re-entrant gCEA
 * voicings, so any simultaneity is consonant by construction. After the song
 * the three rest in the wind (REST_SECONDS), the handpan player nods a
 * silent four-beat count-in, and it loops.
 *
 * All authored times are in BEATS from song start; the transport owns the
 * mapping onto real time.
 */

export const TEMPO_BPM = 76;
export const SEC_PER_BEAT = 60 / TEMPO_BPM;
export const BEATS_PER_BAR = 4;
export const SONG_BARS = 33;
export const SONG_BEATS = SONG_BARS * BEATS_PER_BAR;
export const REST_SECONDS = 12;
export const COUNTIN_BEATS = 4;

/** 1-indexed bar of the final landing chord (everything rings out here). */
export const LANDING_BAR = 33;

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

/* --------------------------------------------------------------- handpan */

/** One authored handpan bar: [note, beatInBar, vel] triplets. The first hit
 * of each bar is the low "ding" (played on the drum's centre dome). */
type PanHit = readonly [note: string, beat: number, vel: number];

// intro bars — sparse, lets the instrument ring
const PAN_INTRO: Record<string, readonly PanHit[]> = {
  Dm: [["D3", 0, 1], ["A3", 1, 0.55], ["D4", 1.75, 0.6], ["F4", 2.5, 0.65], ["A3", 3, 0.5]],
  Bb: [["Bb3", 0, 0.95], ["D4", 1, 0.55], ["F4", 1.75, 0.6], ["D4", 2.5, 0.55], ["Bb3", 3, 0.5]],
  F: [["A3", 0, 0.9], ["C4", 1, 0.55], ["F4", 1.75, 0.6], ["A4", 2.5, 0.65], ["F4", 3, 0.5]],
  C: [["C4", 0, 0.95], ["E4", 1, 0.55], ["G4", 1.75, 0.6], ["A4", 2.5, 0.65], ["G4", 3, 0.5]]
};

// groove bars — flowing eighths with the handpan's signature 1.75 syncopation
const PAN_GROOVE: Record<string, readonly PanHit[]> = {
  Dm: [["D3", 0, 1], ["A3", 0.5, 0.5], ["D4", 1, 0.7], ["F4", 1.75, 0.6], ["A4", 2, 0.75], ["D4", 2.5, 0.5], ["F4", 3, 0.65], ["A3", 3.5, 0.45]],
  Bb: [["Bb3", 0, 0.95], ["D4", 0.5, 0.5], ["F4", 1, 0.7], ["Bb3", 1.75, 0.55], ["D4", 2, 0.75], ["F4", 2.5, 0.5], ["G4", 3, 0.65], ["D4", 3.5, 0.45]],
  F: [["A3", 0, 0.9], ["C4", 0.5, 0.5], ["F4", 1, 0.7], ["A4", 1.75, 0.6], ["C4", 2, 0.7], ["F4", 2.5, 0.5], ["A4", 3, 0.65], ["C4", 3.5, 0.45]],
  C: [["C4", 0, 0.95], ["E4", 0.5, 0.5], ["G4", 1, 0.7], ["A4", 1.75, 0.6], ["E4", 2, 0.7], ["G4", 2.5, 0.5], ["A4", 3, 0.65], ["G4", 3.5, 0.45]]
};

const CHORD_CYCLE = ["Dm", "Bb", "F", "C"] as const;
const chordName = (b: number) => CHORD_CYCLE[(b - 1) % 4];

function buildHandpan(): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (let b = 1; b < LANDING_BAR; b++) {
    // sparse for the solo intro AND the first half of the interlude (the
    // breath in the middle of the song), grooving everywhere else
    const sparse = b <= 4 || b === 17 || b === 18;
    const hits = sparse ? PAN_INTRO[chordName(b)] : PAN_GROOVE[chordName(b)];
    for (const [note, beat, vel] of hits) {
      out.push({
        beat: bar(b) + beat,
        dur: 1.5,
        midis: [n(note)],
        vel,
        tag: beat === 0 ? "ding" : "tone"
      });
    }
  }
  // landing bar — the ding, then two dying echoes
  out.push({ beat: bar(LANDING_BAR), dur: 4, midis: [n("D3")], vel: 1, tag: "ding" });
  out.push({ beat: bar(LANDING_BAR) + 2, dur: 2, midis: [n("A3")], vel: 0.45, tag: "tone" });
  out.push({ beat: bar(LANDING_BAR) + 3, dur: 1, midis: [n("D4")], vel: 0.3, tag: "tone" });
  return out;
}

/* --------------------------------------------------------------- ukulele */

/** Re-entrant gCEA voicings, listed in physical down-strum order
 * (g-string first). Up-strums reverse this order. */
const UKE_CHORDS: Record<string, readonly string[]> = {
  Dm: ["A4", "D4", "F4", "A4"], // 2210
  Bb: ["Bb4", "D4", "F4", "Bb4"], // 3211
  F: ["A4", "C4", "F4", "A4"], // 2010
  C: ["G4", "C4", "E4", "C5"] // 0003
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

/** interlude fingerpicking — steady eighths rolling through the voicing
 * (string indices into the chord's down-strum order), thumb-heavy on the
 * beat like a campfire folk pattern */
const PICK_PATTERN: readonly (readonly [beat: number, str: number, vel: number])[] = [
  [0, 1, 0.62], [0.5, 2, 0.42], [1, 0, 0.5], [1.5, 2, 0.42],
  [2, 3, 0.55], [2.5, 2, 0.42], [3, 0, 0.5], [3.5, 2, 0.45]
];

function buildUkulele(): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (let b = 5; b < LANDING_BAR; b++) {
    const chord = UKE_CHORDS[chordName(b)];
    if (b >= 17 && b <= 20) {
      // interlude: picked arpeggio, alternating gentle down/up motion
      for (let i = 0; i < PICK_PATTERN.length; i++) {
        const [beat, str, vel] = PICK_PATTERN[i];
        out.push({
          beat: bar(b) + beat,
          dur: 0.9,
          midis: [n(chord[str])],
          vel,
          tag: i % 2 === 0 ? "down" : "up"
        });
      }
    } else {
      for (const [beat, dir, vel] of STRUM_PATTERN) {
        const midis = chord.map(n);
        if (dir === "up") midis.reverse();
        out.push({ beat: bar(b) + beat, dur: 0.5, midis, vel, tag: dir });
      }
    }
  }
  // landing — one slow rolled Dm, left ringing
  out.push({ beat: bar(LANDING_BAR), dur: 4, midis: UKE_CHORDS.Dm.map(n), vel: 0.7, tag: "arpeggio" });
  return out;
}

/* ----------------------------------------------------------------- flute */

type FluteNote = readonly [note: string, beat: number, dur: number, vel: number];

const FLUTE_BARS: readonly (readonly [barNo: number, notes: readonly FluteNote[]])[] = [
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

function buildFlute(): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const [barNo, notes] of FLUTE_BARS) {
    for (const [note, beat, dur, vel] of notes) {
      out.push({ beat: bar(barNo) + beat, dur, midis: [n(note)], vel });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ song */

export const SONG: Record<BuskerId, NoteEvent[]> = {
  handpan: buildHandpan(),
  ukulele: buildUkulele(),
  flute: buildFlute()
};

// The transport relies on each part being onset-sorted.
for (const part of Object.values(SONG)) part.sort((a, b) => a.beat - b.beat);
