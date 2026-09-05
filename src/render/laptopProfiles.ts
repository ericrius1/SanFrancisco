import { RENDER_TUNING } from "../config";

export const LAPTOP_PROFILES = {
  balanced: { label: "Balanced", hz: 60, scale: 1, distantCoverage: 0.85, streamBudgetScale: 1, cityRadius: 3600 },
  quiet: { label: "Quiet", hz: 30, scale: 0.9, distantCoverage: 0.65, streamBudgetScale: 0.7, cityRadius: 2400 },
  high: { label: "High", hz: 0, scale: 1, distantCoverage: 1, streamBudgetScale: 1, cityRadius: 6000 }
} as const;
export function laptopProfile() {
  return LAPTOP_PROFILES[RENDER_TUNING.values.profile as keyof typeof LAPTOP_PROFILES] ?? LAPTOP_PROFILES.balanced;
}
/** Tolerate timer jitter without turning a 60 Hz cap into a 30 Hz cadence. */
export function laptopFrameIntervalMs() {
  const hz = RENDER_TUNING.values.quietMode ? 30 : laptopProfile().hz;
  return hz > 0 ? 1000 / hz - 1 : 0;
}
