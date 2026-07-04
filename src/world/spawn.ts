import type { WorldMap } from "./heightmap";
import type { BuildingCollider } from "./tiles";

type SpawnPoint = { x: number; z: number; heading: number };
type ManifestLike = { tile: number; minX: number; minZ: number };

// signed distance (in the OBB's own frame, max-norm) from a point to the box edge;
// negative = inside the footprint
function obbClearance(c: BuildingCollider, x: number, z: number): number {
  const dx = x - c.x;
  const dz = z - c.z;
  const cos = Math.cos(c.yaw);
  const sin = Math.sin(c.yaw);
  const lx = Math.abs(dx * cos - dz * sin) - c.hx;
  const lz = Math.abs(dx * sin + dz * cos) - c.hz;
  return Math.max(lx, lz);
}

/**
 * Resolves a spawn onto open ground: the nearest spot to the requested point that
 * keeps `clearance` metres from every building footprint and stays off the water —
 * i.e. a street or plaza, never under (or inside) a tower. Building footprints come
 * from the same static collider JSON the physics streams, fetched here directly so
 * the answer is ready before any tile loads.
 */
export async function findOpenSpawn(
  map: WorldMap,
  manifest: ManifestLike,
  want: SpawnPoint,
  clearance = 12,
  maxRadius = 200
): Promise<SpawnPoint> {
  const ix = Math.floor((want.x - manifest.minX) / manifest.tile);
  const iz = Math.floor((want.z - manifest.minZ) / manifest.tile);

  const fetches: Promise<BuildingCollider[]>[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      fetches.push(
        fetch(`/data/colliders/tile_${ix + dx}_${iz + dz}.json`)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [])
      );
    }
  }
  const colliders = (await Promise.all(fetches)).flat();
  if (colliders.length === 0) return want;

  const open = (x: number, z: number): boolean => {
    if (map.isWater(x, z)) return false;
    for (const c of colliders) {
      if (obbClearance(c, x, z) < clearance) return false;
    }
    return true;
  };

  if (open(want.x, want.z)) return want;
  for (let r = 3; r <= maxRadius; r += 3) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const x = want.x + Math.cos(a) * r;
      const z = want.z + Math.sin(a) * r;
      if (open(x, z)) return { x, z, heading: want.heading };
    }
  }
  return want;
}
