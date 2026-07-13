// Source defaults for the Botanical Garden's static procedural grass scatter.
// These values are intentionally simple: one current schema, no migration, and
// no coupling to the old vendored dynamic grass field.

import { tunables } from "../../core/persist";
import { foliageBrightness } from "../vegetation/appearance";
import { windSpeed, windStrength } from "../vegetation/wind";

export const BOTANICAL_GRASS_TUNING = tunables("botanicalGrass", {
  // 2026-07 FPS pass: meadow probes hit ~4M garden tris / ~24 fps @ 2560×1600.
  // Wider spacing + shorter rings keep the lawn reading dense at the feet while
  // capping the live triangle budget (see botanicalGrass MAX_LIVE_*).
  spacing: { v: 1.65, min: 0.75, max: 4.5, step: 0.05, label: "base spacing (m)" },
  nearSpacing: { v: 0.48, min: 0.24, max: 1.8, step: 0.02, label: "near spacing (m)" },
  nearRadius: { v: 42, min: 0, max: 180, step: 2, label: "near detail radius (m)" },
  baseViewDistance: { v: 140, min: 80, max: 600, step: 10, label: "base view distance (m)" },
  nearDensity: { v: 0.55, min: 0, max: 1, step: 0.01, label: "near detail density" },
  nearRebuildStep: { v: 10, min: 2, max: 30, step: 1, label: "near rebuild step (m)" },
  meadowKeep: { v: 0.96, min: 0, max: 1, step: 0.01, label: "meadow density" },
  collectionKeep: { v: 0.78, min: 0, max: 1, step: 0.01, label: "collection density" },
  pathEdgeKeep: { v: 0.72, min: 0, max: 1, step: 0.01, label: "path edge density" },
  tallShare: { v: 0.24, min: 0, max: 0.6, step: 0.01, label: "tall clump share" },
  heightScale: { v: 1.05, min: 0.3, max: 1.5, step: 0.01, label: "height scale" },
  brightness: { v: 0.82, min: 0.3, max: 1.4, step: 0.01, label: "grass brightness" },
  greenBias: { v: 0.12, min: 0, max: 0.6, step: 0.01, label: "green bias" },
  pathMargin: { v: 2.3, min: 0, max: 6, step: 0.1, label: "path clear margin (m)" },
  pathFeather: { v: 5.2, min: 1, max: 12, step: 0.1, label: "path edge feather (m)" },
  treeClearance: { v: 0.45, min: 0, max: 2, step: 0.05, label: "trunk clear margin (m)" },
  groundSink: { v: 0.055, min: 0, max: 0.25, step: 0.005, label: "ground sink (m)" },
  slopeCull: { v: 0.62, min: 0.1, max: 2.5, step: 0.05, label: "slope cull (m rise)" },
  showLow: { v: true, label: "low clumps visible" },
  showTall: { v: true, label: "tall clumps visible" },
  windStrength: { v: 0.42, min: 0, max: 1, step: 0.01, label: "tree wind strength" },
  windSpeed: { v: 0.92, min: 0, max: 3, step: 0.05, label: "tree wind tempo" },
  trampleStrength: { v: 0.9, min: 0, max: 2, step: 0.05, label: "trample strength" },
  leafBrightness: { v: 0.44, min: 0.2, max: 1.2, step: 0.01, label: "tree leaf brightness" }
});

export const BOTANICAL_GRASS_SCATTER_KEYS = [
  "spacing",
  "nearSpacing",
  "nearRadius",
  "baseViewDistance",
  "nearDensity",
  "nearRebuildStep",
  "meadowKeep",
  "collectionKeep",
  "pathEdgeKeep",
  "tallShare",
  "heightScale",
  "brightness",
  "greenBias",
  "pathMargin",
  "pathFeather",
  "treeClearance",
  "groundSink",
  "slopeCull",
  "showLow",
  "showTall"
] as const;

export function applyGrassTuning() {
  const v = BOTANICAL_GRASS_TUNING.values;
  windStrength.value = v.windStrength;
  windSpeed.value = v.windSpeed;
  foliageBrightness.value = v.leafBrightness;
}
