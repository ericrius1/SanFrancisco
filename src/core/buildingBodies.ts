// Pure multi-anchor building-body selection — no THREE, no DOM, so it bundles
// straight into a Node probe (tools/collision-probe.mjs) and unit-tests without
// a physics world.
//
// The physics tick materialises box3d Static bodies for the buildings nearest a
// set of ANCHORS (the human player plus every AI car / vehicle that owns a
// kinematic body). Each anchor carries its own radius — a car needs only a few
// tens of metres of look-ahead while the player wants the full collider radius —
// and a building box counts as a candidate if it falls inside ANY anchor's
// radius, ranked by the smallest wall distance to any anchor so the closest
// walls win the global budget.

/** The minimal collider fields the geometry below reads (a footprint OBB). */
export interface ColliderOBB {
  i: number;
  s: number;
  x: number;
  z: number;
  hx: number;
  hz: number;
  cosYaw: number;
  sinYaw: number;
}

/** A point that pulls building bodies into existence around it, with its reach. */
export interface ColliderAnchor {
  x: number;
  /** Optional world altitude. Candidate ranking is planar, but body creation can
   * use this to distinguish an airborne rider over a roof from a body actually
   * embedded inside the building volume. */
  y?: number;
  z: number;
  r: number;
}

/** One tile of colliders plus its (precomputed) world-space centre for culling. */
export interface BodyTileSource<C extends ColliderOBB> {
  key: string;
  cx: number;
  cz: number;
  colliders: readonly C[];
}

/** Planar distance from (x, z) to a collider's footprint edge (0 when inside). */
export function obbPlanarDistance(c: ColliderOBB, x: number, z: number): number {
  const dx = x - c.x;
  const dz = z - c.z;
  const ex = Math.max(0, Math.abs(dx * c.cosYaw - dz * c.sinYaw) - c.hx);
  const ez = Math.max(0, Math.abs(dx * c.sinYaw + dz * c.cosYaw) - c.hz);
  return Math.hypot(ex, ez);
}

/** Is (x, z) inside the footprint OBB expanded by `margin` on both axes? */
export function obbContainsXZ(c: ColliderOBB, x: number, z: number, margin: number): boolean {
  const dx = x - c.x;
  const dz = z - c.z;
  const lx = dx * c.cosYaw - dz * c.sinYaw;
  const lz = dx * c.sinYaw + dz * c.cosYaw;
  return Math.abs(lx) < c.hx + margin && Math.abs(lz) < c.hz + margin;
}

/** Does an anchor overlap a building box closely enough that creating the box
 * now could trap its dynamic body? Altitude-less anchors stay conservative.
 * The lower bound keeps its safety margin, but the top face does not: an anchor
 * on a roof or bridge deck needs that box materialized as support, not deferred
 * as though it were embedded inside a wall. */
export function anchorInsideCollider(
  c: ColliderOBB & { y: number; hy: number },
  a: ColliderAnchor,
  margin: number
): boolean {
  if (!obbContainsXZ(c, a.x, a.z, margin)) return false;
  return a.y === undefined || (a.y > c.y - c.hy - margin && a.y < c.y + c.hy);
}

/**
 * Smallest wall distance from a collider to any anchor whose OUTER band (r ×
 * `outerScale`) still covers it — Infinity if the collider has left every
 * anchor's band. The body streamer uses this for eviction hysteresis so bodies
 * don't churn at the radius boundary.
 */
export function anchorHold(c: ColliderOBB, anchors: readonly ColliderAnchor[], outerScale: number): number {
  let best = Infinity;
  for (const a of anchors) {
    const d = obbPlanarDistance(c, a.x, a.z);
    if (d <= a.r * outerScale && d < best) best = d;
  }
  return best;
}

export interface BodyCandidate<C extends ColliderOBB> {
  key: string;
  c: C;
  d: number; // min wall distance to any anchor that claimed it
}

/**
 * Rank every alive building box within some anchor's radius by its min wall
 * distance to any anchor, dedup by "key:i:s", and cap at `budget`. Pure: the
 * caller supplies the tile source (visual + citywide-index tiles merged, keys
 * unique), the aliveness gate, and the tile-centre cull reach (manifest tile).
 */
export function selectBodyCandidates<C extends ColliderOBB>(
  anchors: readonly ColliderAnchor[],
  tiles: Iterable<BodyTileSource<C>>,
  budget: number,
  isAlive: (key: string, i: number) => boolean,
  tileReach: number
): BodyCandidate<C>[] {
  const byId = new Map<string, BodyCandidate<C>>();
  const cands: BodyCandidate<C>[] = [];
  for (const t of tiles) {
    // tile-centre cull: skip a whole tile no anchor can reach
    let near = false;
    for (const a of anchors) {
      const ddx = t.cx - a.x;
      const ddz = t.cz - a.z;
      const reach = a.r + tileReach;
      if (ddx * ddx + ddz * ddz <= reach * reach) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    for (const c of t.colliders) {
      let best = Infinity;
      for (const a of anchors) {
        const d = obbPlanarDistance(c, a.x, a.z);
        if (d <= a.r && d < best) best = d;
      }
      if (best === Infinity) continue;
      if (!isAlive(t.key, c.i)) continue;
      const id = `${t.key}:${c.i}:${c.s}`;
      const prev = byId.get(id);
      if (prev) {
        if (best < prev.d) prev.d = best;
        continue;
      }
      const rec: BodyCandidate<C> = { key: t.key, c, d: best };
      byId.set(id, rec);
      cands.push(rec);
    }
  }
  cands.sort((a, b) => a.d - b.d);
  return cands.length > budget ? cands.slice(0, budget) : cands;
}
