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
// The frame cap is what pays for it, and it is deliberately a trade rather than
// a saving. A room built for standing still and watching light move does not
// need 60; at 30 there is twice the per-frame budget, and on a fanless machine
// the sustained thermal load matters more than the peak rate anyway.
//
// Two things this is careful about:
//
//  - The cap is WALL CLOCK, not rAF parity. `quietMode` renders every second
//    rAF, which is exactly 30 on a 60 Hz panel and exactly 60 on a 120 Hz one —
//    the pocket's budget must not depend on the display it is shown on.
//  - Entering and leaving are driven by an already-hysteretic signal (the
//    exterior-thinning latch, 12 m in / 8 m out), because changing the beauty
//    pass's sample count reallocates its render target. Nothing here may
//    oscillate on a visitor standing in a doorway.

import { RENDER_TUNING } from "../config";
import { tunables } from "../core/persist";

export const POCKET_QUALITY_TUNING = tunables("pocketQuality", {
  enabled: { v: true, label: "interior quality boost" },
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
 * Supersampling rather than MSAA, and that is a measured choice, not a
 * preference. Raising the beauty pass's sample count multisamples its DEPTH
 * attachment as well, and the contact-shadow complement and the underwater
 * package both bind that depth as an ordinary texture — WebGPU rejects the bind
 * group and the frame comes out as flat clear colour. Resolution costs only
 * fragment work, changes no attachment format, and on a lattice of thin members
 * against a bright sky it resolves sub-pixel geometry that no post-process AA
 * can recover, because the samples never existed.
 *
 * Applied by the adaptive-resolution governor rather than by a direct
 * setPixelRatio, so there stays exactly ONE owner of the drawing buffer — and so
 * a pocket that turns out to be too heavy still gets walked back down the
 * governor's ladder instead of stuttering.
 */
export function pocketRenderScale(): number {
  if (!active) return 1;
  const scale = POCKET_QUALITY_TUNING.values.renderScale;
  return Number.isFinite(scale) && scale > 1 ? scale : 1;
}

/** Subscribe to activation changes (the MSAA owner listens here). */
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
    frameIntervalMs: Number(pocketFrameIntervalMs().toFixed(2)),
    basePixelRatio: RENDER_TUNING.values.pixelRatio
  };
}
