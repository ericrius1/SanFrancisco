// Baked note timeline: the transcribed notes of a recording, decoded from a
// public/audio/pianist/song-*.notes.json file into flat typed arrays so the
// per-frame hand/finger tracking never allocates. The file is trusted (see the
// feature spec); we only clamp and sort-guard on ingest.
//
//   file: { v, durationMs, notes: [[startMs, durMs, midi, vel, hand], ...] }

export type NoteTimeline = {
  durationMs: number;
  count: number;
  startMs: Float32Array;
  endMs: Float32Array;
  midi: Uint8Array;
  vel: Uint8Array;
  /** 0 = left hand, 1 = right hand. */
  hand: Uint8Array;
  /** Pianist finger: 0 = thumb through 4 = pinky. */
  finger: Uint8Array;
};

type RawTimeline = { v?: number; durationMs?: number; notes?: number[][] };

export const PIANO_FINGER_COUNT = 5;

const CHORD_WINDOW_MS = 45;
const FINGER_REUSE_MS = 220;
const MAX_ONE_HAND_SPAN = 12;
// Natural semitone offsets around the middle of each hand. The left hand is
// mirrored: its thumb reaches toward higher notes while its pinky covers bass.
const NATURAL_OFFSETS = [
  [7, 3, 0, -3, -7],
  [-7, -3, 0, 3, 7]
] as const;
const PC_BLACK = [false, true, false, true, false, false, true, false, true, false, true, false] as const;

function isBlack(midi: number): boolean {
  return PC_BLACK[((midi % 12) + 12) % 12];
}

function bitCount(value: number): number {
  let count = 0;
  for (let bits = value; bits !== 0; bits &= bits - 1) count++;
  return count;
}

/**
 * The transcription's coarse hand label occasionally puts both ends of a
 * 10th/12th in one hand even when the other hand is free. Partition each onset
 * at the keyboard midpoint so neither hand is asked to exceed an octave. This
 * is both the playable choice and the one that prevents a wrist from chasing a
 * mathematically unreachable average between two distant keys.
 */
function rebalanceWideChords(startMs: Float32Array, midi: Uint8Array, hand: Uint8Array): void {
  for (let cursor = 0; cursor < midi.length;) {
    const groupStart = startMs[cursor];
    let end = cursor + 1;
    while (end < midi.length && startMs[end] - groupStart <= CHORD_WINDOW_MS) end++;
    const group: number[] = [];
    for (let index = cursor; index < end; index++) group.push(index);

    for (const handId of [0, 1] as const) {
      for (;;) {
        const own = group.filter((index) => hand[index] === handId).sort((a, b) => midi[a] - midi[b]);
        if (own.length < 2 || midi[own[own.length - 1]] - midi[own[0]] <= MAX_ONE_HAND_SPAN) break;
        // Move the note nearest the other hand: highest from left, lowest from right.
        const candidate = handId === 0 ? own[own.length - 1] : own[0];
        const other = group.filter((index) => hand[index] !== handId);
        let otherLo = midi[candidate];
        let otherHi = midi[candidate];
        for (const index of other) {
          otherLo = Math.min(otherLo, midi[index]);
          otherHi = Math.max(otherHi, midi[index]);
        }
        if (otherHi - otherLo > MAX_ONE_HAND_SPAN) break;
        hand[candidate] = handId === 0 ? 1 : 0;
      }
    }
    cursor = end;
  }
}

/**
 * Assign a playable finger to every note. Chords preserve anatomical order,
 * thumb-on-black-key use is discouraged, overlapping notes cannot reuse a
 * finger, and short melodic runs prefer a neighbouring digit in their travel
 * direction. This is deliberately baked once at timeline ingest rather than
 * solved in the render loop.
 */
function planFingering(
  startMs: Float32Array,
  endMs: Float32Array,
  midi: Uint8Array,
  hand: Uint8Array
): Uint8Array {
  const fingers = new Uint8Array(midi.length);

  for (const handId of [0, 1] as const) {
    const indices: number[] = [];
    for (let i = 0; i < midi.length; i++) if (hand[i] === handId) indices.push(i);

    const lastMidi = new Int16Array(PIANO_FINGER_COUNT).fill(-1);
    const busyUntil = new Float32Array(PIANO_FINGER_COUNT);
    let handCenter = handId === 0 ? 52 : 67;
    let previousFinger = 2;
    let previousMidi = handCenter;
    let previousStart = -Infinity;

    for (let cursor = 0; cursor < indices.length;) {
      const groupStart = startMs[indices[cursor]];
      let end = cursor + 1;
      while (end < indices.length && startMs[indices[end]] - groupStart <= CHORD_WINDOW_MS) end++;
      const chord = indices.slice(cursor, end).sort((a, b) => midi[a] - midi[b] || a - b);
      // The source performance never exceeds five same-hand notes in one onset
      // group. If a future transcription does, roll the excess as a new group.
      const playable = chord.slice(0, PIANO_FINGER_COUNT);
      let bestMask = 0;
      let bestScore = Infinity;

      for (let mask = 1; mask < 1 << PIANO_FINGER_COUNT; mask++) {
        if (bitCount(mask) !== playable.length) continue;
        const selected: number[] = [];
        for (let finger = 0; finger < PIANO_FINGER_COUNT; finger++) {
          if ((mask & (1 << finger)) !== 0) selected.push(finger);
        }
        if (handId === 0) selected.reverse();

        let score = 0;
        for (let noteIndex = 0; noteIndex < playable.length; noteIndex++) {
          const timelineIndex = playable[noteIndex];
          const finger = selected[noteIndex];
          const note = midi[timelineIndex];
          score += Math.abs(note - (handCenter + NATURAL_OFFSETS[handId][finger])) * 0.72;
          if (lastMidi[finger] >= 0) {
            score += Math.abs(note - lastMidi[finger]) * 0.24;
            if (note === lastMidi[finger]) score -= 1.1;
          }
          if (busyUntil[finger] > startMs[timelineIndex]) {
            score += 48 + (busyUntil[finger] - startMs[timelineIndex]) * 0.04;
          }
          if (finger === 0 && isBlack(note)) score += 1.8;
          if (finger === 3 && isBlack(note)) score += 0.18;

          if (playable.length === 1 && groupStart - previousStart < 680) {
            const noteDirection = Math.sign(note - previousMidi);
            const anatomicalDirection = Math.sign(finger - previousFinger) * (handId === 0 ? -1 : 1);
            if (noteDirection !== 0 && anatomicalDirection !== 0 && noteDirection !== anatomicalDirection) {
              score += 1.7;
            }
            if (note !== previousMidi && finger === previousFinger) score += 0.85;
          }
        }

        // Match the physical finger span to the interval instead of choosing a
        // needlessly cramped or stretched chord shape.
        if (playable.length > 1) {
          const noteSpan = midi[playable[playable.length - 1]] - midi[playable[0]];
          const firstFinger = selected[0];
          const lastFinger = selected[selected.length - 1];
          const naturalSpan = Math.abs(
            NATURAL_OFFSETS[handId][lastFinger] - NATURAL_OFFSETS[handId][firstFinger]
          );
          // Wide piano intervals belong on the outside digits. A weak span
          // preference lets recent-note continuity choose adjacent fingers
          // for an octave, which is both unplayable and visually crosses the
          // digit chains while the hand moves. Keep continuity as a tiebreaker
          // after the physical chord shape has been respected.
          score += Math.abs(noteSpan - naturalSpan) * 1.8;
        }

        if (score < bestScore) {
          bestScore = score;
          bestMask = mask;
        }
      }

      const chosen: number[] = [];
      for (let finger = 0; finger < PIANO_FINGER_COUNT; finger++) {
        if ((bestMask & (1 << finger)) !== 0) chosen.push(finger);
      }
      if (handId === 0) chosen.reverse();

      let desiredCenter = 0;
      for (let noteIndex = 0; noteIndex < playable.length; noteIndex++) {
        const timelineIndex = playable[noteIndex];
        const finger = chosen[noteIndex];
        fingers[timelineIndex] = finger;
        lastMidi[finger] = midi[timelineIndex];
        busyUntil[finger] = Math.min(endMs[timelineIndex], startMs[timelineIndex] + FINGER_REUSE_MS);
        desiredCenter += midi[timelineIndex] - NATURAL_OFFSETS[handId][finger];
      }
      desiredCenter /= Math.max(1, playable.length);
      handCenter += (desiredCenter - handCenter) * (playable.length > 1 ? 0.68 : 0.38);

      if (playable.length === 1) {
        previousFinger = chosen[0];
        previousMidi = midi[playable[0]];
        previousStart = groupStart;
      } else {
        previousFinger = 2;
        previousMidi = Math.round(desiredCenter);
        previousStart = groupStart;
      }

      // Defensive rolled assignment for a future >5-note transcription.
      for (let extra = PIANO_FINGER_COUNT; extra < chord.length; extra++) {
        const timelineIndex = chord[extra];
        fingers[timelineIndex] = handId === 0 ? 0 : 4;
      }
      cursor = end;
    }
  }

  return fingers;
}

export function parseNoteTimeline(raw: unknown, fallbackDurationMs: number): NoteTimeline {
  const data = (raw ?? {}) as RawTimeline;
  const rows = Array.isArray(data.notes) ? data.notes : [];
  // Guard the sort invariant the tracker relies on without trusting it blindly.
  const notes = rows
    .filter((n) => Array.isArray(n) && n.length >= 5)
    .slice()
    .sort((a, b) => a[0] - b[0]);
  const count = notes.length;
  const startMs = new Float32Array(count);
  const endMs = new Float32Array(count);
  const midi = new Uint8Array(count);
  const vel = new Uint8Array(count);
  const hand = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const n = notes[i];
    const s = Math.max(0, n[0] | 0);
    const d = Math.max(1, n[1] | 0);
    startMs[i] = s;
    endMs[i] = s + d;
    midi[i] = Math.min(127, Math.max(0, n[2] | 0));
    vel[i] = Math.min(127, Math.max(0, n[3] | 0));
    hand[i] = n[4] ? 1 : 0;
  }
  rebalanceWideChords(startMs, midi, hand);
  const finger = planFingering(startMs, endMs, midi, hand);
  const durationMs =
    typeof data.durationMs === "number" && data.durationMs > 0 ? data.durationMs : fallbackDurationMs;
  return { durationMs, count, startMs, endMs, midi, vel, hand, finger };
}
