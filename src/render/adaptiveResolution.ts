// Adaptive resolution governor — protects frame rate on slower GPUs (M1/M2
// laptops) by easing a single quality LEVEL down when sustained frame time runs
// hot, and restoring it when there is headroom.
//
// One driver, one ladder. The frame-time EMA / hysteresis / cooldown mechanics
// are unchanged; they now step an integer LEVEL (0..4) instead of a bare scale,
// and each level names a bundle of cheap, pipeline-free effects other systems
// read through governorEffects():
//   L0  scale 1.0   (default)
//   L1  scale 0.9
//   L2  scale 0.8
//   L3  scale 0.8   + hero-shadow half-rate + tighter contact-shadow scale + FFT economy
//   L4  scale 0.7   + foliage scatter 0.7
//
// Behavior contract:
//   • The tweakpane pixel-ratio value stays the CEILING. The governor only
//     ever renders at or below it (level scale 1 → the tuned value, floor 0.7×).
//   • Steps are quantized and rate-limited: a resize reallocates every render
//     target, so at most one change per cooldown window, and only when the
//     EMA is clearly outside the hysteresis band (not on single-frame spikes).
//   • L4 entry AND exit require a LONGER sustained window — its foliage
//     re-scatter has real cost, so it must not churn on the normal cooldown.
//   • Manual pixel-ratio tweaks and window resizes write the raw tuned value;
//     the governor notices the mismatch on its next tick and reapplies.
//   • setEnabled(false) pins L0 / scale 1.0 (probe + capture contract).
import type * as THREE from "three/webgpu";
import { RENDER_TUNING } from "../config";
import { tracer } from "../core/hitchTracer";

// Per-level render scale (multiplies the tuned pixel-ratio ceiling). Index = level.
const SCALE_BY_LEVEL = [1, 0.9, 0.8, 0.8, 0.7] as const;
const LEVEL_MAX = SCALE_BY_LEVEL.length - 1; // 4

const HOT_MS = 26; // sustained worse than ~38 fps → step down a level
const COOL_MS = 15; // sustained better than ~66 fps → step back up a level
const COOLDOWN_MS = 4000; // min dwell between ordinary level changes
const LEVEL4_HOLD_MS = 8000; // L4 entry/exit dwell — foliage re-scatter, avoid churn
const WARMUP_MS = 8000; // ignore the settle churn right after boot

/** Cheap, pipeline-free quality effects other systems read off the current level. */
export interface GovernorEffects {
  level: number; // 0..4
  renderScale: number;
  heroShadowHalfRate: boolean; // true at level >= 3
  contactShadowScale: number; // 0.5 normally, 0.35 at level >= 3
  fftEconomy: boolean; // true at level >= 3
  foliageScale: number; // 1.0 normally, 0.7 at level 4
}

type GovernorListener = (effects: GovernorEffects) => void;

export type AdaptiveResolution = {
  /** Call once per frame with the tracer's frame-dt EMA (ms). */
  update(emaMs: number): void;
  /** Current applied scale (1 = the tuned pixel ratio). */
  readonly scale: number;
  /** Pin to L0 / scale 1 and stop adapting (probes, capture). */
  setEnabled(on: boolean): void;
  /** Cheap snapshot of the current level's effects (stable frozen object). */
  governorEffects(): GovernorEffects;
  /** Subscribe to level transitions; returns an unsubscribe. */
  onGovernorChange(cb: GovernorListener): () => void;
};

function computeEffects(level: number): GovernorEffects {
  return Object.freeze({
    level,
    renderScale: SCALE_BY_LEVEL[level],
    heroShadowHalfRate: level >= 3,
    contactShadowScale: level >= 3 ? 0.35 : 0.5,
    fftEconomy: level >= 3,
    foliageScale: level >= 4 ? 0.7 : 1
  });
}

// The app builds exactly one governor (main.ts). Its live effects + listeners
// live at module scope so any system can read/subscribe through the exported
// helpers below without threading the instance handle through its constructor.
let currentEffects: GovernorEffects = computeEffects(0);
const changeListeners = new Set<GovernorListener>();

/** Cheap snapshot of the singleton governor's current effects. */
export function governorEffects(): GovernorEffects {
  return currentEffects;
}

/** Subscribe to the singleton governor's level transitions; returns an unsubscribe. */
export function onGovernorChange(cb: GovernorListener): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

export function createAdaptiveResolution(renderer: THREE.WebGPURenderer): AdaptiveResolution {
  let level = 0;
  let enabled = true;
  let lastChange = performance.now() + WARMUP_MS;

  const apply = () => {
    const target = RENDER_TUNING.values.pixelRatio * SCALE_BY_LEVEL[level];
    if (Math.abs(renderer.getPixelRatio() - target) > 1e-3) renderer.setPixelRatio(target);
  };

  const setLevel = (next: number, now: number) => {
    if (next === level) return;
    level = next;
    lastChange = now;
    apply();
    currentEffects = computeEffects(level);
    tracer.count("govLevel");
    for (const cb of changeListeners) cb(currentEffects);
  };

  return {
    update(emaMs: number) {
      if (!enabled) return;
      const now = performance.now();
      // A resize or manual tweak may have re-applied the raw tuned value —
      // keep the governed value in force without waiting out the cooldown.
      apply();
      if (emaMs > HOT_MS && level < LEVEL_MAX) {
        // Entering L4 re-scatters foliage; require the longer sustained window.
        const hold = level + 1 === LEVEL_MAX ? LEVEL4_HOLD_MS : COOLDOWN_MS;
        if (now - lastChange >= hold) setLevel(level + 1, now);
      } else if (emaMs < COOL_MS && level > 0) {
        // Leaving L4 re-scatters foliage; require the longer sustained window.
        const hold = level === LEVEL_MAX ? LEVEL4_HOLD_MS : COOLDOWN_MS;
        if (now - lastChange >= hold) setLevel(level - 1, now);
      }
    },
    get scale() {
      return SCALE_BY_LEVEL[level];
    },
    setEnabled(on: boolean) {
      enabled = on;
      if (!on) setLevel(0, performance.now()); // pin L0 (no-op if already there)
    },
    governorEffects,
    onGovernorChange
  };
}
