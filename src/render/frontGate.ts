// Front visibility gate (M12 — "nothing but void beyond the front").
//
// During the ring coordinator's sweep, world content whose nearest point lies
// beyond the materialize front (+ band + lead margin) stays HIDDEN even when it
// is resident/attached/warmed: beyond the dissolve edge the player sees pure
// void (terrain contour grid + sky only), and the city grows outward into the
// darkness. This module is visibility-only — loading, warming and residency
// keep running ahead of the front exactly as before (C2 depends on it).
//
// Contract:
// - Systems ask `shouldHide(x, z, r)` at attach time; when true they hide their
//   chunk and register it via `hide(...)` with a `show()` callback.
// - `update()` (one call per frame from the ring driver) reveals registered
//   chunks nearest-first under a small per-frame budget, triggered while the
//   chunk is still beyond the visible dissolve edge (inside the lead margin),
//   where the materialize shader renders it near-invisible — so the flip never
//   reads as a pop. Unhide work is tracer-counted (`frontUnhide`).
// - `clearedRadius()` reports the nearest still-hidden chunk; the ring
//   coordinator clamps the front's target to it (the front must never outpace
//   the unhide queue), exactly like it chases residency.
// - `setActive(false)` (settle / force-settle) releases everything under a
//   larger budget — no path may leave content permanently hidden.
// - Steady state: with no registered entries and the gate inactive, both
//   `shouldHide` and `update` are trivial early-outs (zero settled cost).
import * as THREE from "three/webgpu";
import { materializeField, MATERIALIZE_REVEALED_RADIUS } from "./materialize";
import { tracer } from "../core/hitchTracer";

/** How far beyond the dissolve edge (front + band) chunks un-hide, as a
 *  multiple of the CURRENT band. M15: the band scales with the front radius
 *  during the early bloom (ringCoordinator.bandFor), so the admission ring
 *  scales with it — at spawn (band 10) chunks flip visible only ~50 m out
 *  instead of ~250 m, so no black tile bodies silhouette against the sky at
 *  the void moment; at full band 48 this reproduces the M12 value (band +
 *  4·band = 240 ≈ the old 48 + 200). Must stay comfortably larger than the
 *  clamp margin below so admission and the front-clamp can never deadlock
 *  (admit at d ≤ front + 5·band while the front may reach d − margin:
 *  5·band > 3·band + 6 for any band ≥ 3). */
export const FRONT_GATE_LEAD_BANDS = 4;
/** Ring-coordinator clamp: front target ≤ nearestHidden − this. Keeps the
 *  visibility flip past the ~3-band edge-glow window (plus a small headroom),
 *  where the holo shader renders the chunk near-black — band 48 reproduces
 *  the M12 value (150). */
export function frontGateClampMargin(): number {
  return (materializeField.frontBand.value as number) * 3 + 6;
}
/** Current admission lead in metres (band-scaled — see FRONT_GATE_LEAD_BANDS). */
export function frontGateLead(): number {
  return (materializeField.frontBand.value as number) * FRONT_GATE_LEAD_BANDS;
}
// Per-frame unhide budgets: flipping visibility can force BundleGroup
// re-records, so reveals are metered (nearest-first). The flush budget applies
// once the gate deactivates (settle) so the world completes quickly without a
// single monster frame.
const SWEEP_UNHIDE_BUDGET = 6;
const FLUSH_UNHIDE_BUDGET = 16;

export type FrontGateHandle = { cancel(): void };

type Entry = {
  x: number;
  z: number;
  r: number;
  show: () => void;
  dist: number; // scratch, refreshed by update()
};

class FrontGate {
  #active = false;
  #entries = new Set<Entry>();

  /** True while a sweep gates visibility (main drives this off the ring
   *  coordinator state each frame — active unless settled). */
  get active(): boolean {
    return this.#active;
  }

  /** DEBUG/probe: how many chunks are currently front-hidden. */
  get hiddenCount(): number {
    return this.#entries.size;
  }

  setActive(active: boolean): void {
    this.#active = active;
  }

  #admitRadius(): number {
    const radius = materializeField.frontRadius.value as number;
    if (radius >= MATERIALIZE_REVEALED_RADIUS) return Infinity;
    return radius + (materializeField.frontBand.value as number) + frontGateLead();
  }

  #nearestDist(x: number, z: number, r: number): number {
    const c = materializeField.frontCenter.value as THREE.Vector2;
    return Math.max(0, Math.hypot(x - c.x, z - c.y) - r);
  }

  /** Should a chunk with bounding circle (x, z, r) start hidden right now? */
  shouldHide(x: number, z: number, r: number): boolean {
    if (!this.#active) return false;
    return this.#nearestDist(x, z, r) > this.#admitRadius();
  }

  /** Rect variant (exact bounds distance — large cells' bounding circles are
   *  too conservative): should content covering [minX..maxX]×[minZ..maxZ]
   *  stay deferred/hidden right now? `extraLead` widens the admission ring for
   *  consumers whose reveal has pipeline latency of its own (citygen's
   *  serialized cell prepare): anything past ~3 bands beyond the front renders
   *  near-black through the holo edge window, so a wider lead stays invisible
   *  while letting that latency overlap the front's progress. */
  shouldHideRect(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    extraLead = 0
  ): boolean {
    if (!this.#active) return false;
    const admit = this.#admitRadius();
    if (!Number.isFinite(admit)) return false;
    const c = materializeField.frontCenter.value as THREE.Vector2;
    const dx = Math.max(minX - c.x, 0, c.x - maxX);
    const dz = Math.max(minZ - c.y, 0, c.y - maxZ);
    return Math.hypot(dx, dz) > admit + extraLead;
  }

  /** Register an already-hidden chunk. `show()` fires exactly once (from
   *  `update()`'s budgeted reveal) unless the handle is cancelled first (chunk
   *  unloaded / visibility ownership taken over by another path). */
  hide(x: number, z: number, r: number, show: () => void): FrontGateHandle {
    const entry: Entry = { x, z, r, show, dist: 0 };
    this.#entries.add(entry);
    return {
      cancel: () => {
        this.#entries.delete(entry);
      }
    };
  }

  /** Distance (from the live front centre) to the nearest still-hidden chunk;
   *  Infinity when nothing is hidden. The ring coordinator min's this into its
   *  target so the front never outpaces the unhide queue. */
  clearedRadius(): number {
    let min = Infinity;
    for (const e of this.#entries) {
      const d = this.#nearestDist(e.x, e.z, e.r);
      if (d < min) min = d;
    }
    return min;
  }

  // ---- M15 static prop gates -------------------------------------------
  // A handful of boot-resident one-off scene props (surf shack, …) are not
  // owned by any streamer, so nothing re-applies a front test to them after a
  // front refocus. They register ONCE here with a fixed bounds circle; the
  // shared `applyStatic()` (called from main at gate arm + far-arrival cuts,
  // beside tiles/authoredRegions applyFrontGate) re-evaluates each entry:
  // beyond the admission ring the object hides and joins the normal budgeted
  // reveal queue, inside it the object shows. Zero steady-state cost — when
  // the gate is inactive every entry just stays/becomes visible.
  #statics: { obj: { visible: boolean }; x: number; z: number; r: number; handle?: FrontGateHandle }[] = [];

  /** Register a boot-resident scene prop for front gating (idempotent per
   *  object). Applies the current front test immediately. */
  registerStatic(obj: { visible: boolean }, x: number, z: number, r: number): void {
    if (this.#statics.some((s) => s.obj === obj)) return;
    const entry = { obj, x, z, r, handle: undefined as FrontGateHandle | undefined };
    this.#statics.push(entry);
    this.#applyStaticEntry(entry);
  }

  /** Re-apply the front test to every registered static prop (front refocus /
   *  gate arm — the same moment tiles.applyFrontGate runs). */
  applyStatic(): void {
    for (const entry of this.#statics) this.#applyStaticEntry(entry);
  }

  #applyStaticEntry(entry: { obj: { visible: boolean }; x: number; z: number; r: number; handle?: FrontGateHandle }): void {
    entry.handle?.cancel();
    entry.handle = undefined;
    if (this.shouldHide(entry.x, entry.z, entry.r)) {
      entry.obj.visible = false;
      entry.handle = this.hide(entry.x, entry.z, entry.r, () => {
        entry.handle = undefined;
        entry.obj.visible = true;
      });
    } else {
      entry.obj.visible = true;
    }
  }

  /** Per-frame driver (call once, right after the ring coordinator update).
   *  Reveals admitted chunks nearest-first under the budget; when inactive,
   *  flushes everything under the larger budget. */
  update(): void {
    if (this.#entries.size === 0) return;
    const flush = !this.#active;
    const admit = flush ? Infinity : this.#admitRadius();
    let candidates: Entry[] | null = null;
    for (const e of this.#entries) {
      e.dist = this.#nearestDist(e.x, e.z, e.r);
      if (e.dist <= admit) (candidates ??= []).push(e);
    }
    if (!candidates) return;
    candidates.sort((a, b) => a.dist - b.dist);
    const budget = flush ? FLUSH_UNHIDE_BUDGET : SWEEP_UNHIDE_BUDGET;
    const n = Math.min(candidates.length, budget);
    for (let i = 0; i < n; i++) {
      const e = candidates[i];
      this.#entries.delete(e);
      tracer.count("frontUnhide");
      e.show();
    }
  }
}

/** The one shared gate (mirrors the materializeField singleton pattern). */
export const frontGate = new FrontGate();
