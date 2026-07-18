// The Beach Pianist's playlist, in dialogue/default-selection order. Each song
// pairs a mono AAC recording with a baked note timeline (see notes.ts) sorted by
// start time. Only the default song is armed on first approach; an alternate is
// fetched when the player actually chooses it.

export type PianistSong = {
  /** Stable runtime/debug identity. */
  id: string;
  /** Human-readable name exposed by debug state. */
  title: string;
  /** Reply shown in the pianist's arrow-key song picker. */
  choiceLabel: string;
  /** Public URL of the mono AAC recording. */
  audio: string;
  /** Public URL of the baked note timeline JSON. */
  notes: string;
  /** Recording length in milliseconds (authoritative; matches the timeline). */
  durationMs: number;
};

export const SONGS: readonly PianistSong[] = [
  {
    id: "sunset-jam",
    title: "Sunset Jam",
    choiceLabel: "Sunset Jam",
    audio: "/audio/pianist/song-2.m4a",
    notes: "/audio/pianist/song-2.notes.json",
    durationMs: 171200
  },
  {
    id: "fogline-nocturne",
    title: "Fogline Nocturne",
    choiceLabel: "Fogline Nocturne",
    audio: "/audio/pianist/song-1.m4a",
    notes: "/audio/pianist/song-1.notes.json",
    durationMs: 42538
  }
];
