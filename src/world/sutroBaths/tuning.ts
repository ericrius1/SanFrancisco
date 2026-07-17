import { tunables } from "../../core/persist";

/**
 * One durable schema for the whole site. Defaults, ranges and labels live here
 * so changing the source automatically invalidates incompatible stored values.
 */
export const SUTRO_BATHS_TUNING = tunables("sutroBaths", {
  waterEnabled: { v: true, label: "close fluid simulation" },
  waterRadius: { v: 62, min: 28, max: 180, step: 1, label: "fluid wake radius" },
  waterPressure: { v: 2.3, min: 0.2, max: 8, step: 0.05, label: "surface pressure" },
  waterViscosity: { v: 2.75, min: 0, max: 8, step: 0.05, label: "viscosity" },
  waterDamping: { v: 1.35, min: 0.05, max: 4, step: 0.01, label: "damping" },
  waterSubsteps: { v: 1, min: 1, max: 4, step: 1, label: "solver substeps" },
  waterRelief: { v: 0.72, min: 0, max: 2.5, step: 0.02, label: "surface relief" },
  waterNormal: { v: 1.05, min: 0, max: 5, step: 0.05, label: "surface normal" },
  waterRipple: { v: 0.018, min: 0, max: 0.08, step: 0.001, label: "fine ripple" },
  waterClarity: { v: 1.5, min: 0.4, max: 6, step: 0.05, label: "clarity depth (m)" },
  waterRefraction: { v: 0.5, min: 0, max: 1.6, step: 0.01, label: "refraction bend" },
  waterBedTint: { v: 0.5, min: 0, max: 1, step: 0.01, label: "sandy bed tint" },
  waterCaustics: { v: 0.85, min: 0, max: 2, step: 0.01, label: "bed caustics" },
  waterSparkle: { v: 0.85, min: 0, max: 2, step: 0.01, label: "sun sparkles" },
  waterShoreFoam: { v: 0.5, min: 0, max: 1.5, step: 0.01, label: "edge foam rings" },
  waterDepth: { v: 1.35, min: 0.3, max: 3, step: 0.05, label: "pool depth (m)" },
  steamEnabled: { v: true, label: "thermal steam" },
  steamAmount: { v: 0.48, min: 0, max: 1, step: 0.01, label: "steam amount" },
  steamHeight: { v: 4.8, min: 1, max: 12, step: 0.1, label: "steam rise" },
  steamOpacity: { v: 0.22, min: 0, max: 0.85, step: 0.01, label: "steam opacity" },
  steamSteps: { v: 20, min: 12, max: 40, step: 1, label: "steam raymarch steps" },
  steamSunGain: { v: 0.9, min: 0, max: 2, step: 0.02, label: "steam sun glow" },
  steamCurl: { v: 0.6, min: 0, max: 2, step: 0.02, label: "steam curl" },
  glassOpacity: { v: 0.12, min: 0.04, max: 0.6, step: 0.01, label: "glass sheen" },
  lampIntensity: { v: 4.6, min: 0, max: 18, step: 0.1, label: "warm lamp intensity" }
});

export const SUTRO_TUNING_FOLDERS = [
  {
    title: "close-range water",
    expanded: true,
    keys: [
      "waterEnabled",
      "waterRadius",
      "waterPressure",
      "waterViscosity",
      "waterDamping",
      "waterSubsteps",
      "waterRelief",
      "waterNormal",
      "waterRipple"
    ]
  },
  {
    title: "sunlit clarity",
    expanded: true,
    keys: [
      "waterClarity",
      "waterRefraction",
      "waterBedTint",
      "waterCaustics",
      "waterSparkle",
      "waterShoreFoam",
      "waterDepth"
    ]
  },
  {
    title: "steam · glass · lamps",
    expanded: true,
    keys: [
      "steamEnabled",
      "steamAmount",
      "steamHeight",
      "steamOpacity",
      "steamSteps",
      "steamSunGain",
      "steamCurl",
      "glassOpacity",
      "lampIntensity"
    ]
  }
] as const;
