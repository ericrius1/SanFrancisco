// Boot stage: physics (docs/MAIN_DECOMPOSITION.md step 5).
//
// Brings Box3D physics online in parallel with the initial-arrival resolution
// (the two are independent streams and must overlap, not serialize), then chains
// the far-occlusion field onto the tile-collider callbacks that physics owns.
// main.ts calls bootMark("physics") immediately after this resolves.
import { Physics } from "../../core/physics";
import type { TileStreamer } from "../../world/tiles";
import type { WorldMap } from "../../world/heightmap";
import type { FarOcclusionField } from "../../world/shadows/farOcclusionField";
import type { resolveInitialArrival } from "../compose/initialArrival";

type InitialArrival = Awaited<ReturnType<typeof resolveInitialArrival>>;

export interface BootPhysicsDeps {
  map: WorldMap;
  tiles: TileStreamer;
  farOcclusion: FarOcclusionField;
  initialArrivalPromise: Promise<InitialArrival>;
}

export interface BootPhysicsResult {
  physics: Physics;
  initialArrival: InitialArrival;
}

export async function bootPhysics(
  { map, tiles, farOcclusion, initialArrivalPromise }: BootPhysicsDeps
): Promise<BootPhysicsResult> {
  const [physics, initialArrival] = await Promise.all([
    Physics.create(map, tiles),
    initialArrivalPromise
  ]);
  // Physics owns the primary tile callbacks. Chain the far field after it so
  // streamed collider massing feeds both systems without changing ownership.
  const syncFarTile = (key: string, colliders = tiles.loaded.get(key)?.colliders) => {
    if (!colliders) return;
    farOcclusion.setBoxOccluders(
      `tile:${key}`,
      colliders.filter((collider) => tiles.isAlive(key, collider.i))
    );
  };
  const physicsTileColliders = tiles.onTileColliders;
  tiles.onTileColliders = (key, colliders) => {
    physicsTileColliders(key, colliders);
    syncFarTile(key, colliders);
  };
  const physicsTileUnload = tiles.onTileUnload;
  tiles.onTileUnload = (key) => {
    physicsTileUnload(key);
    farOcclusion.deleteOccluders(`tile:${key}`);
  };
  const physicsBuildingAlive = tiles.onBuildingAlive;
  tiles.onBuildingAlive = (key, index, alive) => {
    physicsBuildingAlive(key, index, alive);
    // Mesh-only CityGen swaps remain alive and retain canonical massing. Full
    // authored suppression/revival refreshes the atlas without ghost blockers.
    syncFarTile(key);
  };
  // Open-water bridge spans and landmark boxes do not belong to streamed
  // visual tiles. Feed their existing physics proxy set into the same field.
  void fetch("/data/landmark-colliders.json")
    .then((response) => response.ok ? response.json() : [])
    .then((colliders) => farOcclusion.setBoxOccluders("landmarks", colliders))
    .catch(() => {});
  return { physics, initialArrival };
}
