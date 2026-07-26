// The score's mix knobs, split out from the director on purpose.
//
// The director chunk is deferred until the first gesture (docs/LAZY_LOADING.md),
// so anything that wants to *bind* these controls — the debug pane, which rides
// the boot bundle — cannot import that module without dragging the whole music
// engine into boot. This file holds only the tunables declaration and depends on
// nothing but core/persist, which boot already pays for.

import { tunables } from "../../core/persist";

export const LOFI_MUSIC_TUNING = tunables("lofiMusic", {
  enabled: { v: true, label: "enabled" },
  master: { v: 0.85, min: 0, max: 1, step: 0.01, label: "master" },
  keys: { v: 0.9, min: 0, max: 1, step: 0.01, label: "keys" },
  pads: { v: 0.85, min: 0, max: 1, step: 0.01, label: "pads" },
  bass: { v: 0.8, min: 0, max: 1, step: 0.01, label: "bass" },
  sparkle: { v: 0.9, min: 0, max: 1, step: 0.01, label: "sparkle" },
  crackle: { v: 0.75, min: 0, max: 1, step: 0.01, label: "vinyl" },
  beats: { v: 0.85, min: 0, max: 1, step: 0.01, label: "beats" },
  dust: { v: 0.75, min: 0, max: 1, step: 0.01, label: "dust bed" },
  phrases: { v: 0.85, min: 0, max: 1, step: 0.01, label: "phrases" },
  wobble: { v: 0.8, min: 0, max: 1, step: 0.01, label: "tape wow" },
  reverb: { v: 0.9, min: 0, max: 1, step: 0.01, label: "reverb" },
  pace: { v: 1, min: 0.4, max: 2, step: 0.05, label: "pace ×" },
  dayCheer: { v: 1, min: 0, max: 1.5, step: 0.05, label: "day adventure" },
  arrivals: { v: 1, min: 0, max: 1, step: 0.05, label: "arrival cues" }
});
