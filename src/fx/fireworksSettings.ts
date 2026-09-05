import { tunables } from "../core/persist";

// Show tuning ("/" panel, F folder), persisted to localStorage. Defaults live
// inline with their slider ranges. airAltSpread = total vertical spread (m)
// around player altitude in fly/drone; holdRate/autoRate in volleys/s.
export const FIREWORKS_TUNING = tunables("fireworks", {
  rockets: { v: 6, min: 1, max: 200, step: 1, label: "rockets/volley" },
  sparks: { v: 1800, min: 64, max: 8192, step: 32, label: "sparks/burst" },
  crackle: { v: 320, min: 0, max: 2048, step: 16, label: "crackle/burst" },
  trail: { v: 64, min: 0, max: 160, step: 4, label: "trail sparks" },
  distance: { v: 140, min: 20, max: 500, step: 5, label: "launch distance" },
  lateralSpread: { v: 90, min: 0, max: 400, step: 5, label: "lateral spread" },
  depthSpread: { v: 110, min: 0, max: 500, step: 5, label: "depth spread" },
  burstHeight: { v: 120, min: 30, max: 300, step: 5, label: "burst height" },
  airAltSpread: { v: 80, min: 10, max: 400, step: 5, label: "air alt spread" },
  flightTime: { v: 1.9, min: 0.8, max: 3, step: 0.05, label: "flight time (s)" },
  burstSpeed: { v: 30, min: 8, max: 60, step: 1, label: "burst speed" },
  shells: { v: 4, min: 1, max: 6, step: 1, label: "shells" },
  sparkSize: { v: 0.9, min: 0.2, max: 3, step: 0.05, label: "spark size" },
  intensity: { v: 1.2, min: 0.1, max: 4, step: 0.05, label: "intensity" },
  gravity: { v: 9.8, min: 0, max: 25, step: 0.1, label: "gravity" },
  drag: { v: 1.1, min: 0.2, max: 3, step: 0.05, label: "drag" },
  holdRate: { v: 4, min: 1, max: 30, step: 1, label: "hold rate (/s)" },
  auto: { v: false, label: "auto show" },
  autoRate: { v: 3, min: 0.5, max: 20, step: 0.5, label: "auto rate (/s)" }
});

