/** Slow, deterministic weather fronts. Pure data math: no shaders or assets. */
export interface CloudClimate {
  evolving: boolean; cycleMinutes: number; variation: number; coverage: number;
  density: number; scale: number; billow: number; wisps: number; thickness: number;
}
// coverage, density, size, billow, wisps, depth. One cycle includes a clear spell.
const fronts = [
  [.56, 1, 1, .65, .35, 1],
  [.72, 1.25, 1.4, .95, .15, 1.35],
  [.84, 1.1, 1.8, .25, .55, .6],
  [.38, .7, .8, .35, .9, .65],
  [.08, .45, .6, .2, .8, .55],
  [.32, .85, .75, .85, .25, .9],
] as const;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export function sampleCloudClimate(seconds: number, settings: CloudClimate) {
  const phase = Math.max(0, seconds) / (Math.max(2, settings.cycleMinutes) * 60) * fronts.length;
  const index = Math.floor(phase) % fronts.length;
  const f = phase - Math.floor(phase), blend = f * f * f * (f * (f * 6 - 15) + 10);
  const a = fronts[index], b = fronts[(index + 1) % fronts.length];
  const amount = settings.evolving ? settings.variation : 0;
  const value = (i: number) => a[i] + (b[i] - a[i]) * blend;
  return {
    coverage: clamp(settings.coverage + (value(0) - .56) * amount, 0, .95),
    density: settings.density * (1 + (value(1) - 1) * amount),
    scale: settings.scale * (1 + (value(2) - 1) * amount),
    billow: clamp(settings.billow + (value(3) - .65) * amount, 0, 1),
    wisps: clamp(settings.wisps + (value(4) - .35) * amount, 0, 1),
    thickness: settings.thickness * (1 + (value(5) - 1) * amount),
  };
}
