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
//   L3  scale 0.8   + hero-shadow half-rate + tighter contact-shadow scale + FFT economy + foliage 0.85
//   L4  scale 0.7   + foliage scatter 0.7
//
// Behavior contract:
//   • The tweakpane pixel-ratio value stays the CEILING. The governor only
//     ever renders at or below it (level scale 1 → the tuned value, floor 0.7×).
//   • Steps are quantized and rate-limited: a resize reallocates every render
//     target, so at most one change per cooldown window, and only when the
//     EMA is clearly outside the hysteresis band (not on single-frame spikes).
//   • The band is REFRESH-RELATIVE, not absolute. The EMA fed in is built from
//     the vsync-clamped rAF interval, so a fixed millisecond gate only means
//     what it was tuned to mean on one panel — see the gate constants below.
//   • L4 entry AND exit require a LONGER sustained window — its foliage
//     re-scatter has real cost, so it must not churn on the normal cooldown.
//   • Manual pixel-ratio tweaks and window resizes write the raw tuned value;
//     the governor notices the mismatch on its next tick and reapplies.
//   • setEnabled(false) pins L0 / scale 1.0 (probe + capture contract).
import type * as THREE from "three/webgpu";
import { RENDER_TUNING } from "../config";
import { tracer } from "../core/hitchTracer";
import { pocketRenderScale } from "./pocketQuality";

// Per-level render scale (multiplies the tuned pixel-ratio ceiling). Index = level.
const SCALE_BY_LEVEL = [1, 0.9, 0.8, 0.8, 0.7] as const;
const LEVEL_MAX = SCALE_BY_LEVEL.length - 1; // 4

// Gates, expressed as multiples of the measured display interval. The governor's
// input is an EMA of the vsync-clamped rAF gap, so it physically cannot report
// less than one refresh period: the old absolute COOL of 15 ms sat BELOW the
// 16.67 ms floor of a 60 Hz panel, which made the up-step dead code and every
// step down permanent for the session. Both gates now scale off the refresh.
const HOT_RATIO = 1.55; // sustained worse than ~0.65x refresh → step down a level
const COOL_RATIO = 1.05; // sustained at refresh, plus vsync slack → step back up
const HOT_FLOOR_MS = 20; // never chase past ~50 fps on a high-refresh panel — that spends power, not smoothness
const COOL_FLOOR_MS = 17.5; // a locked 60 fps always reads as headroom, whatever the panel runs at
// The measured floor is only ever believed as "this panel is FASTER than 60 Hz".
// A slower observed floor is workload, not refresh rate, and trusting it would
// raise HOT until the governor stopped protecting anything.
const DISPLAY_MS_MIN = 6;
const DISPLAY_MS_MAX = 16.7;
const DISPLAY_WINDOW_MS = 2000; // window the display-interval minimum is taken over
const DOWN_COOLDOWN_MS = 2000; // min dwell before a step DOWN — a real throttle should settle fast
const UP_COOLDOWN_MS = 4000; // min dwell before a step UP — each one reallocates every render target
const LEVEL4_HOLD_MS = 8000; // L4 entry/exit dwell — foliage re-scatter, avoid churn
const WARMUP_MS = 8000; // ignore the settle churn right after boot

/** Cheap, pipeline-free quality effects other systems read off the current level. */
export interface GovernorEffects {
  level: number; // 0..4
  renderScale: number;
  heroShadowHalfRate: boolean; // true at level >= 3
  contactShadowScale: number; // 0.5 normally, 0.35 at level >= 3
  fftEconomy: boolean; // true at level >= 3
  foliageScale: number; // 1.0 normally, 0.85 at level >= 3, 0.7 at level 4
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

function foliageScaleFor(level: number): number {
  return level >= 4 ? 0.7 : level >= 3 ? 0.85 : 1;
}

function computeEffects(level: number): GovernorEffects {
  return Object.freeze({
    level,
    renderScale: SCALE_BY_LEVEL[level],
    heroShadowHalfRate: level >= 3,
    contactShadowScale: level >= 3 ? 0.35 : 0.5,
    fftEconomy: level >= 3,
    // Mild foliage trim arrives at L3 (before the floor) so a fragment-bound
    // meadow on a laptop starts shedding blades as soon as the frame is hot.
    foliageScale: foliageScaleFor(level)
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
  // Display-interval estimate, kept as a tumbling-window minimum of the real
  // update-to-update gap. Deliberately NOT derived from emaMs: quiet mode halves
  // that value before handing it over, which would read as a 120 Hz panel.
  let displayMs = 16.7;
  let windowMin = Infinity;
  let windowStart = performance.now();
  let lastUpdateAt = 0;

  const apply = () => {
    // The pocket boost multiplies the tuned ceiling rather than replacing it, so
    // this stays the single owner of the drawing buffer and the governor keeps
    // its authority: an interior that turns out to be too heavy is walked back
    // down the same ladder as anything else, instead of stuttering at a pinned
    // resolution.
    const target =
      RENDER_TUNING.values.pixelRatio * SCALE_BY_LEVEL[level] * pocketRenderScale();
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
      // Refresh estimate: frame gaps are vsync-quantized, so their minimum over a
      // couple of seconds is the refresh period. Hitches, a hidden tab and quiet
      // mode's doubled gap only push the minimum UP, where the clamp drops them.
      const gap = now - lastUpdateAt;
      lastUpdateAt = now;
      if (gap >= 1 && gap < windowMin) windowMin = gap;
      if (now - windowStart >= DISPLAY_WINDOW_MS) {
        if (windowMin < Infinity) {
          displayMs = Math.min(Math.max(windowMin, DISPLAY_MS_MIN), DISPLAY_MS_MAX);
        }
        windowMin = Infinity;
        windowStart = now;
      }
      const hotMs = Math.max(displayMs * HOT_RATIO, HOT_FLOOR_MS);
      const coolMs = Math.max(displayMs * COOL_RATIO, COOL_FLOOR_MS);
      // A resize or manual tweak may have re-applied the raw tuned value —
      // keep the governed value in force without waiting out the cooldown.
      apply();
      if (emaMs > hotMs && level < LEVEL_MAX) {
        // Foliage re-scatter has real cost — require the longer sustained window
        // whenever the next step changes foliageScale (L2↔L3 and L3↔L4).
        const hold =
          foliageScaleFor(level + 1) !== foliageScaleFor(level) ? LEVEL4_HOLD_MS : DOWN_COOLDOWN_MS;
        if (now - lastChange >= hold) {
          setLevel(level + 1, now);
          tracer.count("govDown");
        }
      } else if (emaMs < coolMs && level > 0) {
        const hold =
          foliageScaleFor(level - 1) !== foliageScaleFor(level) ? LEVEL4_HOLD_MS : UP_COOLDOWN_MS;
        if (now - lastChange >= hold) {
          setLevel(level - 1, now);
          // Directional counters: the probe has to be able to assert the
          // governor RECOVERS, not just that it moved at all.
          tracer.count("govUp");
        }
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
