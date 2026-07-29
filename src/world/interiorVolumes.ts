/**
 * Authored rooms that legitimately sit BELOW the ground.
 *
 * The walk controller's last-resort safety net respawns a walker who ends up
 * more than a dozen metres under the terrain, on the assumption that the only
 * way to be there is a missed streamed-surface handoff. That assumption held
 * for the whole world until a site built a room you are SUPPOSED to stand in
 * down there — the sunken gallery under the Sutro plunge is 31 m below a
 * groundTop of 2 m, and without this registry its visitors are hauled back to
 * the surface on the very first frame, every frame.
 *
 * Deliberately the same shape as world/swimVolumes.ts, and for the same reason:
 * a runtime registration costs nothing until a lazily-loaded site actually
 * builds the room, and disappears again when that site is disposed, so no
 * global rule has to carry a hard-coded list of holes in the map.
 *
 * This is a claim about GEOMETRY, not about collision: registering says "there
 * is authored floor down here, do not treat this as a fall-through", and the
 * site still owns the actual bodies that hold a capsule up.
 */

export type InteriorVolume = {
  readonly id: string;
  /** World-space AABB — the cheap reject in front of `contains`. */
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Exact test for a world-space point. */
  contains(x: number, y: number, z: number): boolean;
};

const volumes: InteriorVolume[] = [];

/** Register an authored below-ground room; call the result to remove it. */
export function registerInteriorVolume(volume: InteriorVolume): () => void {
  if (!volumes.includes(volume)) volumes.push(volume);
  return () => {
    const index = volumes.indexOf(volume);
    if (index >= 0) volumes.splice(index, 1);
  };
}

/**
 * Is this point inside an authored room that is below the terrain? Costs one
 * empty loop check everywhere in the world with no such room, which is
 * everywhere the player normally is.
 */
export function inInteriorVolume(x: number, y: number, z: number): boolean {
  for (let i = 0; i < volumes.length; i++) {
    const volume = volumes[i];
    if (
      x < volume.minX || x > volume.maxX ||
      y < volume.minY || y > volume.maxY ||
      z < volume.minZ || z > volume.maxZ
    ) continue;
    if (volume.contains(x, y, z)) return true;
  }
  return false;
}
