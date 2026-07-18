// Pure, deterministic pieces of the shared vegetation wind. Keeping the clock
// and envelope free of render/runtime state makes their temporal contract easy
// to probe without compiling the WebGPU material graph.

export const WIND_MAX_FRAME_STEP = 0.1;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function advanceWindPhase(phase: number, dt: number, speed: number): number {
  const safePhase = finiteOr(phase, 0);
  const step = Math.min(WIND_MAX_FRAME_STEP, Math.max(0, finiteOr(dt, 0)));
  const tempo = Math.max(0, finiteOr(speed, 0));
  return safePhase + step * tempo;
}

/** Smooth, bounded quasi-aperiodic gust envelope in [0, 1]. */
export function sampleWindGust(phase: number): number {
  const t = finiteOr(phase, 0);
  const slow = Math.sin(t * 0.089 - 0.7) * 0.55 + Math.sin(t * 0.047 + 1.2) * 0.45;
  const mid = Math.sin(t * 0.24 + 0.4) * 0.6 + Math.sin(t * 0.173 + 3.6) * 0.4;
  const texture = Math.sin(t * 0.73 + 2.3) * 0.55 + Math.sin(t * 0.49 + 0.4) * 0.45;
  const raw = Math.min(1, Math.max(0, 0.5 + slow * 0.23 + mid * 0.14 + texture * 0.045));
  return raw * raw * (3 - 2 * raw);
}

/** Frame-rate-independent easing for live wind-control changes. */
export function windResponseAlpha(dt: number, responseSeconds: number): number {
  const step = Math.min(WIND_MAX_FRAME_STEP, Math.max(0, finiteOr(dt, 0)));
  const response = Math.max(1e-3, finiteOr(responseSeconds, 1));
  return 1 - Math.exp(-step / response);
}
