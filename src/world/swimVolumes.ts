/**
 * Authored bodies of water that are NOT the bay.
 *
 * The swim/underwater stack keys off two global queries — `map.isWater(x, z)`
 * for "is there water in this column" and `waterHeight(x, z, t)` for the sea
 * surface. Both are correct for the ocean and useless for an indoor pool five
 * metres above sea level whose surface is authored, whose floor is a built
 * basin, and whose footprint is deliberately dry land as far as the terrain
 * (and the flora exclusion, the boat spawner, the golf hazards and the minimap)
 * are concerned.
 *
 * Rather than teach `isWater` about pools — which would flood every one of
 * those unrelated consumers — a site registers its own volumes here, and only
 * the handful of systems that actually put a body in water consult the
 * registry: the walk controller, the underwater post-FX rig, the DOM
 * underwater overlay, the splash emitter, and the chase camera.
 *
 * Registration is deliberately a runtime call rather than a static table, so a
 * pool costs nothing until its lazily-loaded site is actually built (see
 * docs/LAZY_LOADING.md) and disappears again when that site is disposed.
 */

import { waterHeight } from "./heightmap";
import { inInteriorVolume } from "./interiorVolumes";

export type SwimVolume = {
  readonly id: string;
  /** Still surface height (m). These bodies do not swell. */
  readonly surfaceY: number;
  /** Built floor under the water (m) — the basin, not the terrain below it. */
  readonly floorY: number;
  /** World-space AABB, used as the cheap reject before `contains`. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /**
   * Lowest point this body of water actually reaches. Below it the column is
   * not this water — it is whatever the site built down there.
   *
   * `contains` is deliberately a 2D test, which for the bay and for an ordinary
   * pool is exactly right: everything under a pool is rock. It stops being
   * right the moment a site puts a ROOM under one. The sunken gallery beneath
   * the Sutro plunge sits inside the plunge's own footprint, 31 m down and full
   * of air; without a floor to the water, its visitors are classified as
   * swimmers and buoyancy hurls them at a ceiling.
   *
   * Only consulted when the caller supplies a `y`. Callers that cannot (a
   * splash particle asking "what is the water height in this column") keep the
   * old, column-shaped answer, which is correct for every one of them.
   */
  readonly bottomY?: number;
  /** Exact footprint test for a world-space column. */
  contains(x: number, z: number): boolean;
  /**
   * Height of the walkable rim a swimmer can haul out onto at a column just
   * OUTSIDE the water, or null where there is nothing to climb. Only asked
   * about columns `contains` has already rejected, so a site can answer with
   * its ordinary walk-surface query.
   *
   * Optional, because it is a contract only a *contained* body needs: you wade
   * out of the bay wherever the beach is, but a pool whose coping stands above
   * the float line is a room with no door until something can lift you over it
   * (see the haul-out in player/walk.ts).
   */
  climbOutY?(x: number, z: number): number | null;
};

/** Just `isWater`, so callers can pass a WorldMap without importing its type. */
type WaterColumnSource = { isWater(x: number, z: number): boolean };

const volumes: SwimVolume[] = [];

/** Register a body of water; call the returned function to remove it again. */
export function registerSwimVolume(volume: SwimVolume): () => void {
  if (!volumes.includes(volume)) volumes.push(volume);
  return () => {
    const index = volumes.indexOf(volume);
    if (index >= 0) volumes.splice(index, 1);
  };
}

/**
 * The authored body of water over (x, z), or null. Costs one empty loop check
 * everywhere in the world that has no registered pool, which is everywhere the
 * player usually is.
 *
 * Pass `y` — the point you are actually asking about — whenever you have it.
 * That is what lets a volume declare a floor (`bottomY`) and stop claiming the
 * air beneath it. Omitting it keeps the original column-shaped answer.
 */
export function swimVolumeAt(x: number, z: number, y?: number): SwimVolume | null {
  for (let i = 0; i < volumes.length; i++) {
    const volume = volumes[i];
    if (x < volume.minX || x > volume.maxX || z < volume.minZ || z > volume.maxZ) continue;
    if (y !== undefined && volume.bottomY !== undefined && y < volume.bottomY) continue;
    if (volume.contains(x, z)) return volume;
  }
  return null;
}

/**
 * Height of whatever water surface covers (x, y, z) — an authored pool first,
 * then the live bay surface — or NaN when the point is dry. One call replaces
 * the `isWater` + `waterHeight` pair every submersion test used to do by hand.
 */
export function submergibleWaterY(
  map: WaterColumnSource,
  x: number,
  z: number,
  time: number,
  y?: number
): number {
  const volume = swimVolumeAt(x, z, y);
  if (volume) return volume.surfaceY;
  /**
   * An authored room below the terrain is DRY, and nothing about a 2D water
   * query can know that.
   *
   * This is the answer four separate submersion consumers act on — the DOM
   * waterline veil, the GPU Beer-Lambert package, the underwater volume and the
   * splash emitter — and each of them decides for itself, from its own eased
   * state, whether to paint. One of them getting a "yes" down here is a sheet
   * of water hanging in a timber gallery thirty-one metres under the deck, and
   * chasing which one is the wrong shape of fix: the QUESTION is what is wrong.
   *
   * Registered swim volumes still answer first, so the basin inside such a room
   * is real water you can dive in and be shaded for. Everything else in it is
   * air, unconditionally.
   */
  if (y !== undefined && inInteriorVolume(x, y, z)) return Number.NaN;
  return map.isWater(x, z) ? waterHeight(x, z, time) : Number.NaN;
}
