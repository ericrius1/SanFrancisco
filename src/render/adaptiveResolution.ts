// Adaptive resolution governor — protects frame rate on slower GPUs (M1/M2
// laptops) by easing a single quality LEVEL down when sustained frame time runs
// hot, and restoring it when there is headroom.
//
// One driver, one ladder. The frame-time EMA / hysteresis / cooldown mechanics
// are unchanged; they now step an integer LEVEL (0..4) instead of a bare scale,
// and each level names a bundle of cheap, pipeline-free effects other systems
// read through governorEffects():
//   L0  factor 1.0   (default)
//   L1  factor 0.9
//   L2  factor 0.8
//   L3  factor 0.8   + hero-shadow half-rate + tighter contact-shadow scale + FFT economy
//   L4  factor 0.7   + foliage scatter 0.7
//
// WHICH resolution that factor degrades depends on whether a temporal UPSAMPLE
// is running underneath (post/temporal — BRIEF §4.5):
//   • No temporal resolve, or TRAA (which resolves one input sample per output
//     pixel and therefore cannot upscale) → the factor multiplies the DRAWING
//     BUFFER, exactly as it always has. The presented image gets smaller and is
//     stretched back up: a straight blur.
//   • TAAU running → the factor multiplies the BEAUTY-PASS scale instead
//     (`temporalScale`, consumed by postInputScale() in post/tuning.ts) and the
//     drawing buffer stays at the tuned ceiling. The beauty pass lands on
//     exactly the same pixel count either way — that is arithmetic, not a
//     measurement: (ratio·factor · artistScale)² == (ratio · artistScale·factor)²
//     — so the fragment work the ladder was protecting is still gone, while the
//     presented image keeps its full resolution and TAAU reconstructs it. What
//     is no longer saved is the ~54% of the post chain that runs at OUTPUT
//     resolution. That is a real gap and splitting the ladder to close it was
//     measured and did not pay — see the note on computeEffects(). The trade is
//     deliberate: the ladder stops being a blur and becomes a quality setting.
//
// Behavior contract:
//   • The tweakpane pixel-ratio value stays the CEILING, and this file stays the
//     SINGLE OWNER of the drawing buffer — nothing else may call setPixelRatio.
//     The governor only ever renders at or below the ceiling (factor 1 → the
//     tuned value, floor 0.7×).
//   • The same is true one level down: the artist's post.temporal.scale is the
//     ceiling on the beauty pass and `temporalScale` may only go BELOW it.
//     postInputScale() enforces that with Math.min; publishing 1 here means
//     "no cap", never "render bigger".
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
import { pocketRenderScale, temporalResolveLive } from "./pocketQuality";
import { TEMPORAL_TUNING } from "./post/temporal/tuning";

// Per-level degradation factor. Index = level. It multiplies EITHER the tuned
// pixel-ratio ceiling or the beauty-pass scale — never both, see the header.
const SCALE_BY_LEVEL = [1, 0.9, 0.8, 0.8, 0.7] as const;
const LEVEL_MAX = SCALE_BY_LEVEL.length - 1; // 4
// postInputScale() clamps the composed beauty scale to this band; matching it
// here keeps the published value honest about what will actually be applied.
const TEMPORAL_SCALE_MIN = 0.4;

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
  /**
   * The governor's allowance for the BEAUTY-PASS scale, as a fraction of the
   * drawing buffer. 1 = "no cap, the artist's post.temporal.scale stands".
   *
   * Purely additive: it is only meaningful to postInputScale(), which composes
   * it as a CEILING with `Math.min` exactly the way contactShadows.ts:306-318
   * composes contactShadowScale. Every pre-existing consumer of this object
   * ignores the field and is unaffected.
   *
   * It is 1 at L0 and 1 whenever no temporal UPSAMPLE is running — in that case
   * the ladder is carried by `renderScale` instead, so exactly one of the two
   * axes is ever degrading and they can never compound.
   */
  temporalScale: number;
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

/**
 * True when the ladder can degrade the INTERNAL resolution instead of the
 * output. Both halves matter: with the temporal resolve off (or the whole post
 * chain bypassed, which is what the reporter in pocketQuality.ts exists to
 * tell us) nothing would consume a smaller beauty pass, and in TRAA mode
 * postInputScale() pins the beauty scale to 1 — publishing a cap either way
 * would silently disarm the governor's only per-pixel lever.
 */
function upscaleAvailable(): boolean {
  return temporalResolveLive() && String(TEMPORAL_TUNING.values.mode) !== "traa";
}

/**
 * The beauty-pass scale the ladder degrades DOWN FROM: the artist's value,
 * always, and deliberately NOT the pocket's raised request.
 *
 * Proportional rather than an absolute ladder of scales, because the factors
 * above were tuned as fractions of whatever was being asked for. An absolute
 * rung ("L1 = 0.6") would be a cliff for someone running native and — worse —
 * a NO-OP against the 0.667 default, since postInputScale() composes with
 * Math.min and a cap above the artist value does nothing at all.
 *
 * That last trap is exactly why the pocket's floor is excluded. Degrading from
 * the pocket's native 1.0 would publish 0.9 / 0.8 / 0.7, every one of them
 * ABOVE the 0.667 default — so if postInputScale() ever stopped honouring the
 * pocket floor, the governor's only per-pixel lever would go silently inert
 * indoors while still reporting a level. Degrading from the artist value can
 * only ever be the same or more aggressive, which is the right way for a
 * frame-rate protection to be wrong. The cost is a hard first step inside a
 * pocket (native → 0.6), and that is acceptable: the frame driver scales the
 * EMA by refresh/cap, so a 30 fps-capped interior only reaches the hot gate
 * below ~20 fps real, where a big step is what you want anyway.
 */
function temporalCeiling(): number {
  const artist = Number(TEMPORAL_TUNING.values.scale);
  return Math.min(1, Math.max(TEMPORAL_SCALE_MIN, Number.isFinite(artist) ? artist : 1));
}

/**
 * EXACTLY ONE AXIS CARRIES THE LADDER, AND SPLITTING IT WAS TRIED AND MEASURED
 * AND DOES NOT PAY. Recorded here because the argument for splitting is a good
 * one on paper and will be made again.
 *
 * THE ARGUMENT. With a temporal upsample running, the whole ladder rides
 * `temporalScale`, so the drawing buffer never shrinks at any level — and the
 * temporal resolve, bloom and the display tail all run at OUTPUT resolution and
 * do not scale with it at all (2.27 ms of a 4.23 ms chain at downtown FiDi,
 * .data/postfx/wave3-perf.md §3). So at L4 — the rung that exists because the
 * machine is in real trouble — the ladder removes ~51% of the beauty pass and 0%
 * of ~2.3 ms of chain, where the pre-TAAU ladder removed 51% of both.
 *
 * THE PROPOSED FIX, which is arithmetically sound: let the deepest rungs put a
 * share `r` on the drawing buffer and divide the internal scale by it, so the
 * beauty pass lands on an IDENTICAL pixel count —
 *     (ratio·r · ceiling·f/r)²  ==  (ratio · ceiling·f)²
 * — while the output-resolution tail shrinks by r². r = 0.85 at L4 gives back a
 * predicted ~0.5-0.6 ms and costs far less sharpness than the 0.7 the pre-TAAU
 * ladder applied to the whole image.
 *
 * THE MACHINE DISAGREES. Both halves of L4 measured directly, round-robin in one
 * session, with the beauty pass at the same 815 px wide either way
 * (`.data/postfx/final-totals-*.json`, rows `L4-internal` / `L4-split`):
 *
 *     downtown FiDi   internal 4.728 ms   split 4.990 ms   split is 0.26 SLOWER
 *     Ocean Beach     internal 8.657 ms   split 8.627 ms   a wash (0.03)
 *
 * FiDi is the stop with the largest output-resolution share, i.e. the one where
 * the predicted saving is biggest — and it is where the split lost. Nothing here
 * is worth a softer presented image at the two rungs that are already giving up
 * hero shadows, contact-shadow scale, FFT detail and foliage. So: unsplit, and
 * do not re-derive it from the ms table alone.
 */
function computeEffects(level: number, upscale: boolean, ceiling: number): GovernorEffects {
  const factor = SCALE_BY_LEVEL[level];
  return Object.freeze({
    level,
    // Exactly one axis carries the ladder. Degrading both would compound to
    // 0.49x output AND 0.49x internal at L4 — a quarter of the fragment work
    // the frame was tuned for, which is a far bigger step than the ladder ever
    // meant to take. See the note above for the exactly-compensating variant
    // that avoids the compounding and still did not pay.
    renderScale: upscale ? 1 : factor,
    temporalScale:
      upscale && level > 0
        ? Math.min(1, Math.max(TEMPORAL_SCALE_MIN, ceiling * factor))
        : 1,
    heroShadowHalfRate: level >= 3,
    contactShadowScale: level >= 3 ? 0.35 : 0.5,
    fftEconomy: level >= 3,
    foliageScale: level >= 4 ? 0.7 : 1
  });
}

// The app builds exactly one governor (main.ts). Its live effects + listeners
// live at module scope so any system can read/subscribe through the exported
// helpers below without threading the instance handle through its constructor.
// L0 publishes 1 on both axes whatever the temporal stage is doing, so the
// module-scope seed needs no tunable read at import time.
let currentEffects: GovernorEffects = computeEffects(0, false, 1);
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
  // Which axis the ladder is on, and what it degrades down from. Both are read
  // off live tunables, so they are sampled once per tick rather than per call.
  let upscale = false;
  let ceiling = 1;
  // apply() reads the MODULE-scope effects (so the two axes are described in
  // exactly one place), and this instance starts at L0 — re-seed them, or a
  // governor rebuilt while the module state survives (HMR) would drive the
  // drawing buffer from the previous instance's level until its first step.
  currentEffects = computeEffects(0, false, 1);

  const apply = () => {
    // The pocket boost multiplies the tuned ceiling rather than replacing it, so
    // this stays the single owner of the drawing buffer and the governor keeps
    // its authority: an interior that turns out to be too heavy is walked back
    // down the same ladder as anything else, instead of stuttering at a pinned
    // resolution.
    const target =
      RENDER_TUNING.values.pixelRatio * currentEffects.renderScale * pocketRenderScale();
    if (Math.abs(renderer.getPixelRatio() - target) > 1e-3) renderer.setPixelRatio(target);
  };

  /**
   * Re-read the temporal axis. Deliberately does NOT notify listeners: nothing
   * a listener consumes (hero shadows, contact-shadow scale, FFT economy,
   * foliage scatter) depends on it, and waking the foliage subscribers because
   * an artist dragged a resolution slider would re-scatter three grass fields
   * for nothing. postInputScale() polls this every frame from the frame driver
   * (pipeline.ts:249), which is also what invalidates the temporal history when
   * the value moves, so a push would buy nothing.
   */
  const refreshTemporalAxis = () => {
    const nextUpscale = upscaleAvailable();
    const nextCeiling = temporalCeiling();
    if (nextUpscale === upscale && nextCeiling === ceiling) return;
    upscale = nextUpscale;
    ceiling = nextCeiling;
    currentEffects = computeEffects(level, upscale, ceiling);
    // Switching axes moves the drawing buffer back to (or off) the tuned
    // ceiling; apply() below re-lands it on the same tick.
  };

  const setLevel = (next: number, now: number) => {
    if (next === level) return;
    level = next;
    lastChange = now;
    currentEffects = computeEffects(level, upscale, ceiling);
    apply();
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
      // Before apply(): the temporal stage toggling moves the ladder between the
      // two axes, and the drawing buffer must land on the new answer this frame
      // rather than one tick late.
      refreshTemporalAxis();
      // A resize or manual tweak may have re-applied the raw tuned value —
      // keep the governed value in force without waiting out the cooldown.
      apply();
      if (emaMs > hotMs && level < LEVEL_MAX) {
        // Entering L4 re-scatters foliage; require the longer sustained window.
        const hold = level + 1 === LEVEL_MAX ? LEVEL4_HOLD_MS : DOWN_COOLDOWN_MS;
        if (now - lastChange >= hold) {
          setLevel(level + 1, now);
          tracer.count("govDown");
        }
      } else if (emaMs < coolMs && level > 0) {
        // Leaving L4 re-scatters foliage; require the longer sustained window.
        const hold = level === LEVEL_MAX ? LEVEL4_HOLD_MS : UP_COOLDOWN_MS;
        if (now - lastChange >= hold) {
          setLevel(level - 1, now);
          // Directional counters: the probe has to be able to assert the
          // governor RECOVERS, not just that it moved at all.
          tracer.count("govUp");
        }
      }
    },
    get scale() {
      // The DRAWING-BUFFER axis, which is what this getter has always meant and
      // what `setEnabled(false)` pins to 1. With a temporal upsample running it
      // stays 1 at every level and the ladder shows up in
      // governorEffects().temporalScale instead — read both when reporting.
      return currentEffects.renderScale;
    },
    setEnabled(on: boolean) {
      enabled = on;
      if (!on) setLevel(0, performance.now()); // pin L0 (no-op if already there)
    },
    governorEffects,
    onGovernorChange
  };
}
