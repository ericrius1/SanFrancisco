import { tunables } from "../../core/persist";

// Tee-beacon coverage and rim shape. Both are shader uniforms, so the "/"
// diagnostics pane can tune them live without rebuilding either material.
export const TEE_BEACON_TUNING = tunables("golf.teeBeacon", {
  alpha: { v: 0.55, min: 0, max: 1, step: 0.01, label: "web glow" },
  fresnelPower: { v: 1.6, min: 0.25, max: 6, step: 0.05, label: "edge focus" }
});
