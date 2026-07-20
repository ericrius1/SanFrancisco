// Front visibility gate (M12, simplified by the M18 particle-scan rewrite:
// "nothing but void during the scan").
//
// While the ring coordinator is in its void phases (scan + morph), world
// fabric that becomes resident/attached/warmed stays HIDDEN — the player sees
// pure black + the terrain-scan particle field only. This module is
// visibility-only: loading, warming and residency keep running underneath
// exactly as before.
//
// Contract:
// - Systems ask `shouldHide(...)` at attach time; when true they hide their
//   chunk and register it via `hide(...)` with a `show()` callback.
// - While the gate is ACTIVE nothing is revealed — there is no admission
//   ring any more; the scan wave owns the whole screen.
// - `setActive(false)` (the coordinator leaving the morph, or a settle
//   escape) releases everything through `update()`'s budgeted nearest-first
//   flush — fabric then birth-fades in (plain dark→lit ramps) while the void
//   fog wall hides everything beyond the scanned bubble. No path may leave
//   content permanently hidden.
// - Steady state: with no registered entries and the gate inactive, both
//   `shouldHide` and `update` are trivial early-outs (zero settled cost).
import * as THREE from "three/webgpu";
import { materializeField } from "./materialize";
import { tracer } from "../core/hitchTracer";

// Per-frame unhide budget for the release flush: flipping visibility can
// force BundleGroup re-records, so reveals are metered (nearest-first).
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

  /** True while the void phases gate visibility (main drives this off the
   *  ring coordinator state each frame). */
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

  #nearestDist(x: number, z: number, r: number): number {
    const c = materializeField.frontCenter.value as THREE.Vector2;
    return Math.max(0, Math.hypot(x - c.x, z - c.y) - r);
  }

  /** Should a chunk with bounding circle (x, z, r) start hidden right now?
   *  M18: while the gate is active EVERYTHING starts hidden. */
  shouldHide(_x: number, _z: number, _r: number): boolean {
    return this.#active;
  }

  /** Rect variant kept for callers with exact bounds (citygen cells). The
   *  bounds and lead no longer matter — active means hidden. */
  shouldHideRect(
    _minX: number,
    _minZ: number,
    _maxX: number,
    _maxZ: number,
    _extraLead = 0
  ): boolean {
    return this.#active;
  }

  /** Register an already-hidden chunk. `show()` fires exactly once (from
   *  `update()`'s budgeted release flush) unless the handle is cancelled
   *  first (chunk unloaded / visibility ownership taken over). */
  hide(x: number, z: number, r: number, show: () => void): FrontGateHandle {
    const entry: Entry = { x, z, r, show, dist: 0 };
    this.#entries.add(entry);
    return {
      cancel: () => {
        this.#entries.delete(entry);
      }
    };
  }

  /** DEBUG/probe: distance (from the front centre) to the nearest still-hidden
   *  chunk; Infinity when nothing is hidden. */
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
  // while the gate is active the object hides and joins the budgeted release
  // flush, otherwise it shows. Zero steady-state cost.
  #statics: { obj: { visible: boolean }; x: number; z: number; r: number; handle?: FrontGateHandle }[] = [];

  /** Register a boot-resident scene prop for front gating (idempotent per
   *  object). Applies the current gate state immediately. */
  registerStatic(obj: { visible: boolean }, x: number, z: number, r: number): void {
    if (this.#statics.some((s) => s.obj === obj)) return;
    const entry = { obj, x, z, r, handle: undefined as FrontGateHandle | undefined };
    this.#statics.push(entry);
    this.#applyStaticEntry(entry);
  }

  /** Re-apply the gate to every registered static prop (gate arm / far-arrival
   *  cuts — the same moment tiles.applyFrontGate runs). */
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
   *  Inert while active; once released, flushes everything nearest-first
   *  under the budget (fabric birth-fades handle the appearance). */
  update(): void {
    if (this.#active || this.#entries.size === 0) return;
    let candidates: Entry[] | null = null;
    for (const e of this.#entries) {
      e.dist = this.#nearestDist(e.x, e.z, e.r);
      (candidates ??= []).push(e);
    }
    if (!candidates) return;
    candidates.sort((a, b) => a.dist - b.dist);
    const n = Math.min(candidates.length, FLUSH_UNHIDE_BUDGET);
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
