import { tunables } from "../../../core/persist";

/**
 * One source of truth for lamp defaults and Tweakpane metadata. Kept separate
 * from lamp.ts so the boot-visible debug panel does not pull the actual optional
 * geometry generator across CityGen's first-use interior gate.
 *
 * Definition fingerprinting in core/persist resets stale saved values when this
 * shape or any range changes; there is intentionally no migration layer.
 */
export const PROCEDURAL_LAMP_TUNING = tunables("citygen.interiorLamp", {
  enabled: { v: true, label: "enabled" },
  coverage: {
    v: 0.82,
    min: 0,
    max: 1,
    step: 0.01,
    format: (v: number) => `${Math.round(v * 100)}%`,
    label: "home coverage",
  },
  rings: { v: 5, min: 2, max: 8, step: 1, label: "ribbon rings" },
  radius: { v: 0.86, min: 0.35, max: 1.45, step: 0.01, label: "radius (m)" },
  depth: { v: 1.02, min: 0.28, max: 1.8, step: 0.01, label: "cage depth (m)" },
  ceilingDrop: { v: 0.3, min: 0.12, max: 1.2, step: 0.01, label: "ceiling drop (m)" },
  maxTilt: { v: 24, min: 0, max: 58, step: 1, label: "ring tilt (deg)" },
  variation: { v: 0.72, min: 0, max: 1, step: 0.01, label: "shape variation" },
  ribbonWidth: { v: 0.064, min: 0.018, max: 0.16, step: 0.002, label: "ribbon width (m)" },
  ribbonThickness: { v: 0.018, min: 0.006, max: 0.055, step: 0.001, label: "ribbon depth (m)" },
  ribs: { v: 8, min: 0, max: 14, step: 1, label: "radial ribs" },
  cables: { v: 3, min: 1, max: 6, step: 1, label: "suspension cables" },
  glowSize: { v: 1, min: 0.35, max: 1.8, step: 0.01, label: "core glow size" },
  finish: {
    v: "brass",
    options: { "gilded brass": "brass", "aged brass": "aged", "champagne": "champagne" },
    label: "metal finish",
  },
  lightTone: {
    v: "warm",
    options: { "warm white": "warm", "candle amber": "amber", "pearl": "pearl" },
    label: "light tone",
  },
});
