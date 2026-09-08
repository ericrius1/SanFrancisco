import { tunables } from "../core/persist";

/** Boot-safe settings; the enabled sky volume warms after arrival. */
export const CLOUD_TUNING = tunables("volumetricClouds", {
  enabled: { v: true, label: "volumetric clouds" },
  evolving: { v: true, label: "evolving weather" },
  cycleMinutes: { v: 12, min: 2, max: 60, step: 1, label: "weather cycle (min)" },
  variation: { v: 1, min: 0, max: 1, step: 0.01, label: "weather variety" },
  coverage: { v: 0.56, min: 0, max: 0.95, step: 0.01, label: "average coverage" },
  density: { v: 1, min: 0.15, max: 2.5, step: 0.05, label: "optical density" },
  scale: { v: 1, min: 0.35, max: 3, step: 0.05, label: "cloud size" },
  billow: { v: 0.65, min: 0, max: 1, step: 0.01, label: "billowy shapes" },
  wisps: { v: 0.35, min: 0, max: 1, step: 0.01, label: "wispy edges" },
  altitude: { v: 680, min: 350, max: 1800, step: 10, label: "cloud base (m)" },
  thickness: { v: 420, min: 100, max: 1000, step: 10, label: "layer depth (m)" },
  windSpeed: { v: 7, min: 0, max: 35, step: 0.5, label: "wind speed (m/s)" },
  windDirection: { v: 16, min: 0, max: 360, step: 1, label: "wind direction" },
  morphSpeed: { v: 1, min: 0, max: 4, step: 0.1, label: "shape evolution" },
});
