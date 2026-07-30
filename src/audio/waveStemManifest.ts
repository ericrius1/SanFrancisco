// Runtime surf-stem manifest — the contract between tools/audio/splice-surf-stems.mjs
// and the WaveStems player. Pure data: importing this module fetches nothing.
//
// All stems are spliced from PD-mark / CC0 field recordings (provenance in
// public/audio/surf/manifest.json). One-shots are peak-normalized to −3 dBFS,
// beds loudness-matched near −23 dBFS RMS, everything 48 kHz stereo MP3 160k.
// `seconds` is the encoded length (decoder padding included) and exists for
// scheduling and decoded-memory accounting, not for sample-exact looping —
// beds are overlap-scheduled segments, never source.loop.

export type WaveStemKind = "bed" | "crash-big" | "crash-mid" | "crash-small" | "swash" | "sub";

export type WaveStemDef = {
  id: string;
  url: string;
  kind: WaveStemKind;
  /** level trim into the wave mix, applied on top of WaveAudio's own gains. */
  gainTrim: number;
  /** encoded length in seconds. */
  seconds: number;
};

export const WAVE_STEM_DEFS: readonly WaveStemDef[] = [
  // Beds: the wash. Trims lift the −23 dBFS recordings to the level the old
  // white-noise loop sat at under WaveAudio's wash-gain curve.
  { id: "bed-close", url: "/audio/surf/bed-close.mp3", kind: "bed", gainTrim: 2.4, seconds: 45.024 },
  { id: "bed-mid", url: "/audio/surf/bed-mid.mp3", kind: "bed", gainTrim: 2.4, seconds: 45.024 },
  // Crash one-shots.
  { id: "crash-big-01", url: "/audio/surf/crash-big-01.mp3", kind: "crash-big", gainTrim: 1, seconds: 6.24 },
  { id: "crash-big-03", url: "/audio/surf/crash-big-03.mp3", kind: "crash-big", gainTrim: 1, seconds: 6.024 },
  { id: "crash-mid-01", url: "/audio/surf/crash-mid-01.mp3", kind: "crash-mid", gainTrim: 1, seconds: 3.528 },
  { id: "crash-mid-02", url: "/audio/surf/crash-mid-02.mp3", kind: "crash-mid", gainTrim: 0.9, seconds: 4.536 },
  { id: "crash-mid-03", url: "/audio/surf/crash-mid-03.mp3", kind: "crash-mid", gainTrim: 1, seconds: 4.824 },
  { id: "crash-small-01", url: "/audio/surf/crash-small-01.mp3", kind: "crash-small", gainTrim: 1, seconds: 2.04 },
  { id: "crash-small-03", url: "/audio/surf/crash-small-03.mp3", kind: "crash-small", gainTrim: 1, seconds: 4.032 },
  // Swash / washback sheets.
  { id: "swash-01", url: "/audio/surf/swash-01.mp3", kind: "swash", gainTrim: 1, seconds: 4.536 },
  { id: "swash-02", url: "/audio/surf/swash-02.mp3", kind: "swash", gainTrim: 1, seconds: 4.224 },
  { id: "swash-03", url: "/audio/surf/swash-03.mp3", kind: "swash", gainTrim: 1, seconds: 4.632 },
  { id: "swash-04", url: "/audio/surf/swash-04.mp3", kind: "swash", gainTrim: 1, seconds: 4.44 },
  // Boca do Inferno sub layers (≤180 Hz), stacked under big crashes.
  { id: "sub-01", url: "/audio/surf/sub-01.mp3", kind: "sub", gainTrim: 1, seconds: 3.24 },
  { id: "sub-02", url: "/audio/surf/sub-02.mp3", kind: "sub", gainTrim: 1, seconds: 3.432 }
];
