// Bounded-interior quality trade.
//
// Some places in this world are pockets: fully enclosed, with the city hidden
// behind them. The Sutro Baths hall is the first — once the visitor is far
// enough inside that nobody can see out, `onExteriorThinned` hides citygen, the
// tile batches, the traffic rigs, golf, the palace lagoon and the shadow
// proxies. What is left is one building.
//
// That is a completely different rendering problem from the open world, and it
// deserves different settings. The city is draw-call bound and its materials are
// fat (procedural fog noise in every fogged shader, at every overdraw layer), so
// per-pixel spending is expensive there. A thinned pocket is neither: it is a
// small scene with room to spare, and the thing most worth buying with that room
// is coverage. The hall is a barrel roof of thin iron members read against a
// bright sky, which is the worst case for a single-sampled buffer and the best
// case for MSAA — it supersamples EDGES without multiplying shading cost.
//
// HOW that coverage is bought has now changed once. MSAA is unusable in this
// renderer (multisampling the beauty pass multisamples its depth attachment,
// which two other passes bind as a texture), so the pocket bought coverage with
// raw resolution instead: 1.5x pixel ratio, 2.25x the fragment work. With the
// cinematic chain's temporal resolve running that is the wrong purchase — TAA
// accumulates a different sub-pixel sample every frame, which is real coverage
// rather than an edge filter, and it is nearly free. The pocket therefore asks
// for a NATIVE beauty pass (pocketTemporalScale) rather than a supersampled
// output, and pocketRenderScale() falls back to 1.0. The 1.5x path is still
// here and still correct for a session with the resolve, or the whole post
// chain, switched off.
//
// The frame cap is what pays for it, and it is deliberately a trade rather than
// a saving. A room built for standing still and watching light move does not
// need 60; at 30 there is twice the per-frame budget, and on a fanless machine
// the sustained thermal load matters more than the peak rate anyway. The cap is
// unchanged by the temporal resolve — a cheaper frame in a room built for
// standing still is budget for the room, not a reason to run it faster.
//
// Two things this is careful about:
//
//  - The cap is WALL CLOCK, not rAF parity. `quietMode` renders every second
//    rAF, which is exactly 30 on a 60 Hz panel and exactly 60 on a 120 Hz one —
//    the pocket's budget must not depend on the display it is shown on.
//  - Entering and leaving are driven by an already-hysteretic signal (the
//    exterior-thinning latch, 12 m in / 8 m out), because changing the beauty
//    pass's sample count reallocates its render target — and so does changing
//    its resolution, which is what the trade does now. Nothing here may
//    oscillate on a visitor standing in a doorway.

import { RENDER_TUNING } from "../config";
import { tunables } from "../core/persist";
import { TEMPORAL_TUNING } from "./post/temporal/tuning";

export const POCKET_QUALITY_TUNING = tunables("pocketQuality", {
  enabled: { v: true, label: "interior quality boost" },
  /**
   * INERT while a temporal resolve is running — pocketRenderScale() returns 1.0
   * there and the pocket asks for a native beauty pass instead. The label is
   * deliberately not renamed to say so: `label` is part of the group's schema
   * fingerprint (persist.ts:46-62), so editing it would discard every persisted
   * `pocketQuality.*` override, including the visitor's chosen frame cap.
   */
  renderScale: {
    v: 1.5,
    min: 1,
    max: 2,
    step: 0.05,
    label: "· indoor render scale"
  },
  frameCap: {
    v: 30,
    options: { "30 fps (cinematic)": 30, "40 fps": 40, "uncapped": 0 },
    label: "· indoor frame cap"
  }
});

type Listener = (active: boolean) => void;

let committed = false;
let active = false;
const listeners = new Set<Listener>();

let temporalResolveReporter: (() => boolean) | null = null;

/**
 * Let the post chain answer "is a temporal resolve actually running?" itself.
 *
 * The stage toggle alone is not the whole answer: `post.enabled` is a master
 * bypass, and with it off the chain never renders a stage, so the beauty pass
 * goes to the display un-antialiased no matter what `post.temporal.enabled`
 * says. Two things hang off getting that right — this file's supersample trade
 * and the governor's choice of which resolution its ladder degrades — and both
 * fail QUIETLY in the wrong direction (no AA indoors; a governor whose
 * resolution lever does nothing).
 *
 * It is a reporter rather than an import because post/tuning.ts already imports
 * adaptiveResolution.ts, which imports this module: reading POST_TUNING from
 * here would close that cycle. Unset, the default below reads the stage toggle,
 * which is correct for every state except the master bypass.
 */
export function setTemporalResolveReporter(read: (() => boolean) | null): void {
  temporalResolveReporter = read;
}

/** True when a temporal resolve will run this frame (see the reporter above). */
export function temporalResolveLive(): boolean {
  if (temporalResolveReporter) return temporalResolveReporter() === true;
  return TEMPORAL_TUNING.values.enabled === true;
}

/** True while the interior trade is in force. */
export function pocketQualityActive(): boolean {
  return active;
}

/**
 * Minimum milliseconds between presented frames, or 0 for uncapped.
 *
 * Read live by the frame driver. Returns 0 whenever the pocket is not active, so
 * the open world is never capped by this.
 */
export function pocketFrameIntervalMs(): number {
  if (!active) return 0;
  const fps = POCKET_QUALITY_TUNING.values.frameCap;
  if (!fps || fps <= 0) return 0;
  // A hair under the exact interval: frame times are vsync-quantised, so gating
  // on the exact period drops every other frame to the next vsync and yields
  // half the requested rate.
  return 1000 / fps - 2;
}

/**
 * Multiplier on the tuned pixel ratio while the pocket is active.
 *
 * Supersampling rather than MSAA, and that was a measured choice, not a
 * preference. Raising the beauty pass's sample count multisamples its DEPTH
 * attachment as well, and the contact-shadow complement and the underwater
 * package both bind that depth as an ordinary texture — WebGPU rejects the bind
 * group and the frame comes out as flat clear colour. Resolution costs only
 * fragment work, changes no attachment format, and on a lattice of thin members
 * against a bright sky it resolves sub-pixel geometry that no post-process AA
 * can recover, because the samples never existed.
 *
 * A temporal resolve retires that trade. It is not a post-process AA guessing
 * at edges from one sample: the jitter puts a DIFFERENT sub-pixel sample in the
 * buffer every frame and the history accumulates them, so the samples do exist
 * — gathered over time rather than over area. Supersampling the output on top of
 * that pays 2.25x the fragment cost (1.5x on each axis) for coverage already in
 * hand, and on a fanless M5 Air that is the trade least worth making, because
 * the cost is sustained rather than peak. So: 1.0 while a temporal resolve is
 * live, and the pocket asks for a NATIVE beauty pass instead
 * (pocketTemporalScale below). The 1.5x path stays intact for a session with
 * the resolve — or the whole chain — switched off, where it is still the only
 * anti-aliasing the hall has.
 *
 * Applied by the adaptive-resolution governor rather than by a direct
 * setPixelRatio, so there stays exactly ONE owner of the drawing buffer — and so
 * a pocket that turns out to be too heavy still gets walked back down the
 * governor's ladder instead of stuttering.
 */
export function pocketRenderScale(): number {
  if (!active) return 1;
  if (temporalResolveLive()) return 1;
  const scale = POCKET_QUALITY_TUNING.values.renderScale;
  return Number.isFinite(scale) && scale > 1 ? scale : 1;
}

/**
 * The beauty-pass scale the pocket asks for, or 0 when it is not asking.
 *
 * A thinned interior is a small scene with room to spare, and the thing most
 * worth buying with that room is still coverage — so the pocket spends it on a
 * NATIVE beauty pass (scale 1) resolved by TAA, rather than on an upscaled one.
 * On a barrel roof of thin iron members that is exactly where the difference
 * shows: reconstruction from 0.667 has no sub-pixel information to reconstruct
 * a one-pixel member from, while a native jittered pass does.
 *
 * A FLOOR under the artist's `post.temporal.scale`, not an override of the
 * governor: postInputScale() must raise its ceiling to this and then still take
 * the governor's cap below it, so an interior that turns out to be too heavy is
 * walked back down the ladder exactly like the pixel-ratio boost it replaces.
 * 0 means "no request" so the composition is a plain Math.max.
 */
export function pocketTemporalScale(): number {
  return active && temporalResolveLive() ? 1 : 0;
}

/**
 * Subscribe to activation changes (the MSAA owner listened here).
 *
 * The pocket's two live requests — `pocketRenderScale()` and
 * `pocketTemporalScale()` — are POLLED, not pushed: the governor re-applies the
 * pixel ratio every tick and pipeline.ts:249 re-reads postInputScale() every
 * frame, invalidating the temporal history whenever the beauty scale moves. A
 * subscriber that pushed the same values would be a second path to the same
 * state that can disagree with the first, which is the failure this file's
 * "one latch, owned by whoever owns the geometry" note already warns about.
 * The hook remains for a consumer that genuinely needs the EDGE (a fade, a
 * one-shot reallocation) rather than the value.
 */
export function onPocketQualityChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Feed the already-debounced "the exterior is not observable from here" latch.
 *
 * Deliberately takes a committed/not-committed boolean rather than a distance:
 * the hysteresis belongs to whoever owns the geometry, and duplicating it here
 * would give two latches that can disagree.
 */
export function setPocketCommitted(next: boolean): void {
  if (committed === next) return;
  committed = next;
  const wanted = committed && POCKET_QUALITY_TUNING.values.enabled === true;
  if (wanted === active) return;
  active = wanted;
  for (const listener of listeners) listener(active);
}

/**
 * Re-evaluate after a tunable change, so toggling the boost off in the panel
 * takes effect without walking out of the building and back in.
 */
export function refreshPocketQuality(): void {
  const wanted = committed && POCKET_QUALITY_TUNING.values.enabled === true;
  if (wanted === active) return;
  active = wanted;
  for (const listener of listeners) listener(active);
}

/** Probe-facing snapshot; allocation-free callers should read the getters. */
export function pocketQualityState() {
  return {
    committed,
    active,
    renderScale: pocketRenderScale(),
    // Which of the two coverage buys is in force is the thing a probe most
    // needs to see: renderScale 1.5 / temporalScale 0 is the supersampled
    // fallback, renderScale 1 / temporalScale 1 is native + TAA.
    temporalScale: pocketTemporalScale(),
    temporalResolveLive: temporalResolveLive(),
    frameIntervalMs: Number(pocketFrameIntervalMs().toFixed(2)),
    basePixelRatio: RENDER_TUNING.values.pixelRatio
  };
}
