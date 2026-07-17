// Adaptive resolution governor — protects frame rate on slower GPUs (M1/M2
// laptops) by easing the render scale down when sustained frame time runs hot,
// and restoring it when there is headroom.
//
// Behavior contract:
//   • The tweakpane pixel-ratio value stays the CEILING. The governor only
//     ever renders at or below it (scale 1 → the tuned value, floor 0.7×).
//   • Steps are quantized and rate-limited: a resize reallocates every render
//     target, so at most one change per cooldown window, and only when the
//     EMA is clearly outside the hysteresis band (not on single-frame spikes).
//   • Manual pixel-ratio tweaks and window resizes write the raw tuned value;
//     the governor notices the mismatch on its next tick and reapplies.
import type * as THREE from "three/webgpu";
import { RENDER_TUNING } from "../config";

const SCALE_MIN = 0.7;
const SCALE_STEP = 0.1;
const HOT_MS = 26; // sustained worse than ~38 fps → step down
const COOL_MS = 15; // sustained better than ~66 fps → step back up
const COOLDOWN_MS = 4000;
const WARMUP_MS = 8000; // ignore the settle churn right after boot

export type AdaptiveResolution = {
  /** Call once per frame with the tracer's frame-dt EMA (ms). */
  update(emaMs: number): void;
  /** Current applied scale (1 = the tuned pixel ratio). */
  readonly scale: number;
  /** Pin scale to 1 and stop adapting (probes, capture). */
  setEnabled(on: boolean): void;
};

export function createAdaptiveResolution(renderer: THREE.WebGPURenderer): AdaptiveResolution {
  let scale = 1;
  let enabled = true;
  let lastChange = performance.now() + WARMUP_MS;

  const apply = () => {
    const target = RENDER_TUNING.values.pixelRatio * scale;
    if (Math.abs(renderer.getPixelRatio() - target) > 1e-3) renderer.setPixelRatio(target);
  };

  return {
    update(emaMs: number) {
      if (!enabled) return;
      const now = performance.now();
      // A resize or manual tweak may have re-applied the raw tuned value —
      // keep the governed value in force without waiting out the cooldown.
      apply();
      if (now - lastChange < COOLDOWN_MS) return;
      if (emaMs > HOT_MS && scale > SCALE_MIN + 1e-3) {
        scale = Math.max(SCALE_MIN, +(scale - SCALE_STEP).toFixed(2));
        lastChange = now;
        apply();
      } else if (emaMs < COOL_MS && scale < 1 - 1e-3) {
        scale = Math.min(1, +(scale + SCALE_STEP).toFixed(2));
        lastChange = now;
        apply();
      }
    },
    get scale() {
      return scale;
    },
    setEnabled(on: boolean) {
      enabled = on;
      if (!on && scale !== 1) {
        scale = 1;
        apply();
      }
    }
  };
}
