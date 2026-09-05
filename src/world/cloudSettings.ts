import { tunables } from "../core/persist";

/** Only settings are boot-safe. Shader code loads on explicit activation. */
export const CLOUD_TUNING = tunables("volumetricClouds", {
  enabled: { v: false, label: "volumetric clouds" },
  coverage: { v: 0.52, min: 0.15, max: 0.85, step: 0.01, label: "cloud coverage" },
  altitude: { v: 680, min: 350, max: 1800, step: 10, label: "cloud base (m)" },
});
