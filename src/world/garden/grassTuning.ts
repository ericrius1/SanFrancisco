// Source defaults for the Botanical Garden's static procedural grass scatter.
// These values are intentionally simple: one current schema, no migration, and
// no coupling to the old vendored dynamic grass field.

import { tunables } from "../../core/persist";

export const BOTANICAL_GRASS_TUNING = tunables("botanicalGrass", {
  // Dense defaults are affordable because the base uses 1/2-segment clusters,
  // compact 36-byte instances, and the detail ring streams stable LOD tiles.
  spacing: { v: 1.3, min: 0.75, max: 4.5, step: 0.05, label: "base spacing (m)" },
  nearSpacing: { v: 0.44, min: 0.24, max: 1.8, step: 0.02, label: "near spacing (m)" },
  nearRadius: { v: 44, min: 0, max: 180, step: 2, label: "near detail radius (m)" },
  baseViewDistance: { v: 140, min: 80, max: 600, step: 10, label: "base view distance (m)" },
  nearDensity: { v: 0.9, min: 0, max: 1, step: 0.01, label: "near detail density" },
  nearRebuildStep: { v: 10, min: 2, max: 30, step: 1, label: "near rebuild step (m)" },
  meadowKeep: { v: 0.99, min: 0, max: 1, step: 0.01, label: "meadow density" },
  collectionKeep: { v: 0.9, min: 0, max: 1, step: 0.01, label: "collection density" },
  pathEdgeKeep: { v: 0.78, min: 0, max: 1, step: 0.01, label: "path edge density" },
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
  showTall: { v: true, label: "tall clumps visible" }
});
