import { tunables } from "../core/persist";

// Persisted mix tuning; lives in the fireworks folder of the "/" panel.
export const AUDIO_TUNING = tunables("fireworksAudio", {
  volume: { v: 0.6, min: 0, max: 1, step: 0.05, label: "boom volume" },
  bass: { v: 1, min: 0, max: 2, step: 0.05, label: "boom bass" },
  echo: { v: 0.55, min: 0, max: 1, step: 0.05, label: "sky echo" },
  muted: { v: false, label: "mute booms" }
});

