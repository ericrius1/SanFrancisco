// Baked note timeline: the transcribed notes of a recording, decoded from
// public/audio/pianist/song-1.notes.json into flat typed arrays so the per-frame
// hand/finger tracking never allocates. The file is trusted (see the feature
// spec); we only clamp and sort-guard on ingest.
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
};

type RawTimeline = { v?: number; durationMs?: number; notes?: number[][] };

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
  const durationMs =
    typeof data.durationMs === "number" && data.durationMs > 0 ? data.durationMs : fallbackDurationMs;
  return { durationMs, count, startMs, endMs, midi, vel, hand };
}
