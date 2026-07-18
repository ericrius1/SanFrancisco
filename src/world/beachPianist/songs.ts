// The Beach Pianist's playlist. One recording today; the site is written for an
// array so a future setlist just appends entries. Each song pairs a mono AAC
// recording with a baked note timeline (see notes.ts) sorted by start time.

export type PianistSong = {
  /** Public URL of the mono AAC recording. */
  audio: string;
  /** Public URL of the baked note timeline JSON. */
  notes: string;
  /** Recording length in milliseconds (authoritative; matches the timeline). */
  durationMs: number;
};

export const SONGS: readonly PianistSong[] = [
  {
    audio: "/audio/pianist/song-1.m4a",
    notes: "/audio/pianist/song-1.notes.json",
    durationMs: 42538
  }
];
