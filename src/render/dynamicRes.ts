import { RENDER_MODE } from "../config";

/**
 * Dynamic-resolution governor.
 *
 * Watches the real rAF frame cadence and steps the renderer's drawing-buffer
 * pixel ratio up and down to hold the display's frame budget on weaker GPUs.
 * The scene is fragment-bound (see RENDER_MODE.pixelRatioCap), so pixel ratio
 * is the cheapest, most linear lever on frame time.
 *
 *   ceiling  = the boot cap  min(devicePixelRatio, RENDER_MODE.pixelRatioCap)
 *   floor    = RENDER_MODE.minPixelRatio (clamped to never exceed the ceiling)
 *   ladder   = ceiling → intermediate stops → floor (see STEP_STOPS)
 *
 * DOWN is fast (drop one rung after ~45 pressured frames); UP is slow
 * (~240 relaxed frames) with a ≥2 s cooldown between any two steps, so a
 * framebuffer realloc never thrashes and the ratio never oscillates.
 *
 * The apply path is identical to boot / window-resize: setPixelRatio + setSize.
 * The WebGPU post pipeline's pass targets re-derive their size from the
 * drawing-buffer on the next render, so no explicit pipeline resize is needed
 * (same reason the plain resize handler only calls setSize).
 */

// Candidate intermediate rungs between floor and ceiling. The live ladder is
// [ceiling, ...(stops strictly inside (floor, ceiling)), floor], deduped and
// sorted descending — so the 1.5 ceiling gives 1.5 → 1.35 → 1.2 → 1.1 → 1.0.
// A dpr-1 display collapses the ladder to a single rung: nothing to govern.
const STEP_STOPS = [1.5, 1.35, 1.2, 1.1, 1.0];

const EMA_ALPHA = 0.1; // smoothing on the frame-delta signal
const SPIKE_MS = 100; // deltas above this are tab-switches/GC — ignored entirely
const WARMUP_MS = 5000; // no stepping for the first 5 s (tile-streaming warmup)
const DOWN_FACTOR = 1.15; // EMA above budget×this = under pressure
const UP_FACTOR = 0.7; // EMA below budget×this = comfortable headroom
const DOWN_FRAMES = 45; // sustained pressured frames before a down-step
const UP_FRAMES = 240; // sustained relaxed frames before an up-step (slower up)
const COOLDOWN_MS = 2000; // minimum gap between any two steps
const CADENCE_SAMPLES = 60; // frames sampled at boot to detect the refresh period

// Common refresh periods (ms). The measured boot cadence snaps to the nearest
// so the budget is a clean 8.33 (120 Hz) / 16.67 (60 Hz) etc. rather than noisy.
const REFRESH_PERIODS = [1000 / 240, 1000 / 144, 1000 / 120, 1000 / 90, 1000 / 60, 1000 / 48, 1000 / 30];

export type DynResState = {
  ratio: number;
  ema: number;
  budget: number;
  cap: number;
  min: number;
  cadenceLocked: boolean;
};

export type DynamicResolution = {
  /** Feed one real rAF frame delta (milliseconds). Call once per rendered frame. */
  sample(dtMs: number): void;
  /** Current applied pixel ratio. */
  readonly ratio: number;
  /** Smoothed frame delta (ms). */
  readonly ema: number;
  /** Detected frame budget (ms) = display refresh period. */
  readonly budget: number;
  /** Snapshot for probes / a debug readout. */
  state(): DynResState;
  /** Re-apply the ceiling ratio (used by the "." tweaks reset). */
  syncToCap(): void;
  /** Probe-only hooks (exposed on __sf.dynRes, DEV/profile builds only). */
  _test: {
    skipWarmup(): void;
    setBudget(ms: number): void;
    pump(dtMs: number, count: number): void;
    stepDown(): boolean;
    stepUp(): boolean;
  };
};

export function createDynamicResolution(opts: {
  /** Apply a pixel ratio the same way boot does (setPixelRatio + setSize). */
  apply: (ratio: number) => void;
  /** Read the renderer's current pixel ratio, so external setters are adopted. */
  readRatio: () => number;
}): DynamicResolution {
  const { apply, readRatio } = opts;

  const cap = () => Math.min(window.devicePixelRatio || 1, RENDER_MODE.pixelRatioCap);
  const floor = () => Math.min(RENDER_MODE.minPixelRatio, cap());

  let ratio = readRatio(); // boot already applied the ceiling
  let ema = 0;
  let started = false;
  let budget = 1000 / 60; // safe default until the cadence is measured
  let bootTime = performance.now();
  let downFrames = 0;
  let upFrames = 0;
  let lastStep = 0; // performance.now() of the last ratio change (0 = never)

  const cadence: number[] = [];
  let cadenceLocked = false;

  const ladder = (): number[] => {
    const c = cap();
    const f = floor();
    const stops = STEP_STOPS.filter((s) => s > f + 1e-3 && s < c - 1e-3);
    const rungs = [c, ...stops, f];
    return [...new Set(rungs.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => b - a);
  };

  const nearestRung = (l: number[], v: number): number => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < l.length; i++) {
      const d = Math.abs(l[i] - v);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  };

  const snapRefresh = (ms: number): number => {
    let best = REFRESH_PERIODS[0];
    let bd = Infinity;
    for (const p of REFRESH_PERIODS) {
      const d = Math.abs(p - ms);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };

  const setRatio = (next: number): boolean => {
    if (Math.abs(next - ratio) < 1e-3) return false;
    ratio = next;
    apply(ratio);
    lastStep = performance.now();
    downFrames = 0;
    upFrames = 0;
    return true;
  };

  const stepDown = (): boolean => {
    const l = ladder();
    const i = nearestRung(l, ratio);
    return i < l.length - 1 ? setRatio(l[i + 1]) : false;
  };

  const stepUp = (): boolean => {
    const l = ladder();
    const i = nearestRung(l, ratio);
    return i > 0 ? setRatio(l[i - 1]) : false;
  };

  const syncToCap = () => {
    ratio = cap();
    apply(ratio);
    lastStep = performance.now();
    downFrames = 0;
    upFrames = 0;
  };

  const sample = (dtMs: number) => {
    // Adopt any external pixel-ratio change as the new baseline so the governor
    // steps from there instead of fighting whoever set it.
    const applied = readRatio();
    if (Math.abs(applied - ratio) > 1e-3) ratio = applied;

    // Boot cadence detection: median of the first ~60 clean deltas → refresh period.
    if (!cadenceLocked && dtMs > 1 && dtMs < SPIKE_MS) {
      cadence.push(dtMs);
      if (cadence.length >= CADENCE_SAMPLES) {
        const sorted = [...cadence].sort((a, b) => a - b);
        budget = snapRefresh(sorted[sorted.length >> 1]);
        cadenceLocked = true;
      }
    }

    if (dtMs > SPIKE_MS) return; // tab-switch/GC spike — don't pollute the EMA
    ema = started ? ema + EMA_ALPHA * (dtMs - ema) : dtMs;
    started = true;

    if (!RENDER_MODE.dynamicRes) return;
    if (performance.now() - bootTime < WARMUP_MS) return; // streaming warmup

    if (ema > budget * DOWN_FACTOR) {
      downFrames++;
      upFrames = 0;
    } else if (ema < budget * UP_FACTOR) {
      upFrames++;
      downFrames = 0;
    } else {
      downFrames = 0;
      upFrames = 0;
    }

    const cooled = performance.now() - lastStep >= COOLDOWN_MS;
    if (!cooled) return;
    if (downFrames >= DOWN_FRAMES) stepDown();
    else if (upFrames >= UP_FRAMES) stepUp();
  };

  return {
    sample,
    get ratio() {
      return ratio;
    },
    get ema() {
      return ema;
    },
    get budget() {
      return budget;
    },
    state: () => ({ ratio, ema, budget, cap: cap(), min: floor(), cadenceLocked }),
    syncToCap,
    _test: {
      skipWarmup() {
        bootTime = -1e12; // pretend boot was long ago, so stepping is unblocked
      },
      setBudget(ms: number) {
        budget = ms;
        cadenceLocked = true;
      },
      pump(dtMs: number, count: number) {
        for (let i = 0; i < count; i++) sample(dtMs);
      },
      stepDown,
      stepUp
    }
  };
}
