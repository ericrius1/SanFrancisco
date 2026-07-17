import type { NoteEvent } from "../../gameplay/buskers/types";

/**
 * The eye-walker's songbook — solo ukulele pieces for the rider on the
 * creature's shoulders, written for the twilight labyrinth: modal, patient,
 * a little uncanny. Same beat grid as the busker trio (76 bpm — the strum
 * animation in ukulelist.ts converts beats→seconds with the trio's
 * SEC_PER_BEAT), same NoteEvent contract, but a different harmonic accent:
 * D minor leaning dorian (B♮ for Dm6) with a raised-third A-major cadence
 * out of D harmonic minor, slow rolled chords with long ringing decays, and
 * campanella single-string lines threaded over open-string drones.
 *
 * Each piece runs well past a minute; between pieces the transport rests in
 * the sea wind (the silence is part of the set), then the next tune starts.
 *
 * All times are BEATS from song start. "arpeggio" events get the long 2.5 s
 * pluck decay in ukulelist.ts — the mystical ring lives there.
 */

export type WalkerSong = {
  name: string;
  /** total beats including the final ring-out bar(s) */
  beats: number;
  part: NoteEvent[];
};

/* ------------------------------------------------------------- pitch table */

const NOTE_MIDI: Record<string, number> = {
  C4: 60, Cs4: 61, D4: 62, E4: 64, F4: 65, G4: 67, A4: 69, Bb4: 70, B4: 71,
  C5: 72, D5: 74, E5: 76, F5: 77
};

function n(name: string): number {
  const m = NOTE_MIDI[name];
  if (m === undefined) throw new Error(`unknown note ${name}`);
  return m;
}

/** Re-entrant gCEA voicings in physical down-strum order (g-string first).
 * The colour chords are the point: BbMaj7 instead of plain Bb, Dm6 with the
 * dorian B♮, and the A-major "eye opens" cadence chord. */
const CHORDS: Record<string, readonly string[]> = {
  Dm: ["A4", "D4", "F4", "A4"], // 2210
  Dm6: ["A4", "D4", "F4", "B4"], // 2212 — dorian shimmer
  Dmadd9: ["A4", "D4", "F4", "E5"], // 2217-ish reach — used only as a roll
  BbM7: ["Bb4", "D4", "F4", "A4"], // 3210
  F: ["A4", "C4", "F4", "A4"], // 2010
  C: ["G4", "C4", "E4", "C5"], // 0003
  Am: ["A4", "C4", "E4", "A4"], // 2000
  Gm: ["G4", "D4", "G4", "Bb4"], // 0231
  A: ["A4", "Cs4", "E4", "A4"] // 2100 — harmonic-minor V
} as const;

type ChordId = keyof typeof CHORDS;

/* --------------------------------------------------------------- builders */

function ev(out: NoteEvent[], beat: number, midis: number[], vel: number, dur = 1, tag?: string) {
  out.push(tag ? { beat, dur, midis, vel, tag } : { beat, dur, midis, vel });
}

/** Slow rolled chord (down-strum order), long ring. */
function roll(out: NoteEvent[], beat: number, chord: ChordId, vel: number) {
  ev(out, beat, CHORDS[chord].map(n), vel, 4, "arpeggio");
}

/** Single campanella pluck. */
function pluck(out: NoteEvent[], beat: number, note: string, vel: number, dur = 1.5) {
  ev(out, beat, [n(note)], vel, dur);
}

/** One fingerpicked bar (4 beats): thumb states the chord's low string on the
 * beat, fingers thread the upper strings — the campfire pattern slowed into
 * something more tidal. `lift` raises the last off-beat to a melody note. */
function pickBar(out: NoteEvent[], barBeat: number, chord: ChordId, vel: number, lift?: string) {
  const v = CHORDS[chord];
  pluck(out, barBeat, v[1], vel); // low anchor (C-string voice)
  pluck(out, barBeat + 0.5, v[2], vel * 0.62, 1);
  pluck(out, barBeat + 1, v[0], vel * 0.72, 1);
  pluck(out, barBeat + 1.5, v[3], vel * 0.6, 1);
  pluck(out, barBeat + 2, v[1], vel * 0.82, 1);
  pluck(out, barBeat + 2.5, v[2], vel * 0.6, 1);
  pluck(out, barBeat + 3, v[3], vel * 0.7, 1);
  if (lift) pluck(out, barBeat + 3.5, lift, vel * 0.66, 1.2);
  else pluck(out, barBeat + 3.5, v[0], vel * 0.5, 1);
}

/* ---------------------------------------------------- 1. "Spiral of Eyes" */
// 28 bars of 4/4 ≈ 88 s. Rolled invocation, a picked spiral that keeps
// returning one turn higher, a high B-section over the sea, and a slow
// ring-out landing on the harmonic-minor cadence.

function buildSpiralOfEyes(): WalkerSong {
  const out: NoteEvent[] = [];
  const bar = (b: number) => (b - 1) * 4;

  // bars 1–4 — invocation: slow rolls, each answered by a lone high echo
  roll(out, bar(1), "Dm", 0.62);
  pluck(out, bar(1) + 2.5, "A4", 0.34, 2);
  roll(out, bar(2), "BbM7", 0.56);
  pluck(out, bar(2) + 2.5, "F4", 0.32, 2);
  roll(out, bar(3), "Dm6", 0.58);
  pluck(out, bar(3) + 2.5, "B4", 0.36, 2);
  roll(out, bar(4), "A", 0.52);
  pluck(out, bar(4) + 3, "Cs4", 0.3, 1.5);

  // bars 5–12 — the picked spiral (two turns of Dm–BbM7–F–A)
  const turnA: [ChordId, string | undefined][] = [
    ["Dm", "E5"], ["BbM7", "D5"], ["F", "C5"], ["A", "E5"]
  ];
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i < 4; i++) {
      const [chord, lift] = turnA[i];
      pickBar(out, bar(5 + t * 4 + i), chord, 0.5 + t * 0.06, t === 1 ? lift : undefined);
    }
  }

  // bars 13–20 — B: the melody walks the rim, high and searching
  const line: [number, string, number][] = [
    // beat offset within the 8-bar span, note, velocity
    [0, "D5", 0.66], [1.5, "E5", 0.5], [2.5, "F5", 0.58], [4, "E5", 0.62],
    [6, "D5", 0.52], [7, "C5", 0.46], [8, "D5", 0.64], [10, "A4", 0.4],
    [12, "Bb4", 0.56], [13.5, "C5", 0.46], [14.5, "D5", 0.54], [16, "C5", 0.6],
    [18, "Bb4", 0.5], [19, "A4", 0.44], [20, "B4", 0.58], [22, "A4", 0.42],
    [24, "D5", 0.62], [25.5, "C5", 0.48], [26.5, "Bb4", 0.52], [28, "A4", 0.56],
    [30, "G4", 0.44], [31, "E4", 0.4]
  ];
  const bChords: ChordId[] = ["Dm", "C", "BbM7", "Gm", "Dm", "C", "Gm", "A"];
  for (let i = 0; i < 8; i++) {
    const v = CHORDS[bChords[i]];
    pluck(out, bar(13 + i), v[1], 0.46, 2); // low anchor under the line
    pluck(out, bar(13 + i) + 2, v[2], 0.36, 2);
  }
  for (const [off, note, vel] of line) pluck(out, bar(13) + off, note, vel, 1.6);

  // bars 21–26 — the spiral again, one turn, settling
  const turnB: [ChordId, string | undefined][] = [
    ["Dm", undefined], ["BbM7", "A4"], ["Dm6", "B4"], ["A", undefined],
    ["Dm", "E5"], ["BbM7", undefined]
  ];
  for (let i = 0; i < 6; i++) {
    const [chord, lift] = turnB[i];
    pickBar(out, bar(21 + i), chord, 0.52 - i * 0.015, lift);
  }

  // bars 27–28 — landing: the eye closes. A-major roll, then Dm rung out.
  roll(out, bar(27), "A", 0.5);
  roll(out, bar(28), "Dm", 0.6);
  pluck(out, bar(28) + 2.5, "D4", 0.4, 3);

  return { name: "Spiral of Eyes", beats: 28 * 4, part: out.sort((a, b) => a.beat - b.beat) };
}

/* ----------------------------------------------------- 2. "Lantern Tide" */
// A slow waltz — 32 bars of 3/4 ≈ 76 s. Bass roll on the downbeat, two soft
// plucks after, the tide going out and coming back. Dm–Am–BbM7–F, answered
// by Dm–Am–Gm–A.

function buildLanternTide(): WalkerSong {
  const out: NoteEvent[] = [];
  const bar = (b: number) => (b - 1) * 3;

  const ebb: ChordId[] = ["Dm", "Am", "BbM7", "F"];
  const flow: ChordId[] = ["Dm", "Am", "Gm", "A"];
  // four 8-bar phrases: ebb, flow, ebb (lifted), flow (settling)
  const phrases: [ChordId[], number, (string | undefined)[]][] = [
    [ebb, 0.46, [undefined, undefined, undefined, undefined]],
    [flow, 0.5, [undefined, "E4", undefined, "Cs4"]],
    [ebb, 0.56, ["E5", "C5", "D5", "C5"]],
    [flow, 0.5, ["D5", undefined, "Bb4", undefined]]
  ];
  let b = 1;
  for (const [cycle, vel, lifts] of phrases) {
    for (let i = 0; i < 8; i++) {
      const chord = cycle[i % 4];
      const v = CHORDS[chord];
      const bb = bar(b);
      if (i % 4 === 0) {
        // downbeat roll opens each half-phrase
        ev(out, bb, v.map(n), vel + 0.08, 3, "arpeggio");
      } else {
        pluck(out, bb, v[1], vel, 1.5);
      }
      pluck(out, bb + 1, v[2], vel * 0.6, 1);
      const lift = lifts[i % 4];
      if (lift && i >= 4) pluck(out, bb + 2, lift, vel * 0.72, 1.4);
      else pluck(out, bb + 2, v[0], vel * 0.55, 1);
      b++;
    }
  }
  // final ring-out replaces the last authored bar's tail: Dm rolled, low D
  roll(out, bar(32), "Dm", 0.58);
  pluck(out, bar(32) + 1.5, "D4", 0.36, 3);

  return { name: "Lantern Tide", beats: 32 * 3, part: out.sort((a, b) => a.beat - b.beat) };
}

/* ------------------------------------------------- 3. "Six Hundred Eyes" */
// 24 bars of 4/4 ≈ 76 s. The sparse one — long silences, single high notes
// left hanging over open-string drones, rolls only where the spiral lights.
// This is the piece that sounds like the creature: patient, watching.

function buildSixHundredEyes(): WalkerSong {
  const out: NoteEvent[] = [];
  const bar = (b: number) => (b - 1) * 4;

  // bars 1–8 — drones and single watching notes
  const watch: [number, string, number][] = [
    [0, "D4", 0.55], [2, "A4", 0.4], [4, "D5", 0.52], [7, "E5", 0.44],
    [8, "F5", 0.5], [11, "E5", 0.4], [12, "D5", 0.46], [14, "B4", 0.5],
    [16, "D4", 0.55], [18, "A4", 0.38], [20, "Bb4", 0.5], [23, "A4", 0.36],
    [24, "G4", 0.44], [26, "F4", 0.4], [28, "E4", 0.46], [30, "Cs4", 0.42]
  ];
  for (const [off, note, vel] of watch) pluck(out, off, note, vel, 2.5);

  // bars 9–16 — the spiral lights: rolls travelling up, one per bar
  const lights: [ChordId, number][] = [
    ["Dm", 0.44], ["Dm6", 0.48], ["BbM7", 0.52], ["Gm", 0.5],
    ["Am", 0.54], ["BbM7", 0.58], ["Dm6", 0.6], ["A", 0.56]
  ];
  for (let i = 0; i < 8; i++) {
    roll(out, bar(9 + i), lights[i][0], lights[i][1]);
    if (i % 2 === 1) pluck(out, bar(9 + i) + 2.5, i < 4 ? "A4" : "D5", 0.38, 2);
  }

  // bars 17–22 — the watching line returns over a picked undertow
  for (let i = 0; i < 6; i++) {
    const chord: ChordId = i % 2 === 0 ? "Dm" : (i === 3 ? "Gm" : "BbM7");
    const v = CHORDS[chord];
    pluck(out, bar(17 + i), v[1], 0.44, 2);
    pluck(out, bar(17 + i) + 1.5, v[3], 0.36, 1.5);
    pluck(out, bar(17 + i) + 3, v[0], 0.32, 1.5);
  }
  pluck(out, bar(18) + 2, "D5", 0.5, 2);
  pluck(out, bar(20) + 2, "E5", 0.46, 2);
  pluck(out, bar(21) + 2, "F5", 0.5, 2.5);
  pluck(out, bar(22) + 2, "E5", 0.4, 2.5);

  // bars 23–24 — every eye closes at once
  roll(out, bar(23), "A", 0.46);
  roll(out, bar(24), "Dm", 0.58);
  pluck(out, bar(24) + 3, "D4", 0.34, 4);

  return { name: "Six Hundred Eyes", beats: 24 * 4, part: out.sort((a, b) => a.beat - b.beat) };
}

export const WALKER_SONGS: WalkerSong[] = [buildSpiralOfEyes(), buildLanternTide(), buildSixHundredEyes()];

/** Rest between pieces (seconds) — long enough to read as "waiting to play
 * again", short enough that a lingering player hears the next tune. */
export const WALKER_REST_MIN = 16;
export const WALKER_REST_MAX = 28;
