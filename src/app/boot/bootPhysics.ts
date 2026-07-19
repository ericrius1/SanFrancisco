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
    Physics.createCore(map, tiles),
    initialArrivalPromise
  ]);
  // Collider services (landmark query mirrors + the canonical building
  // collider index) consume the already-resolved tiles manifest and complete
  // in the background — the void phase never waits on them; the boot collision
  // arrival converges once the index lands (docs/VOID_STREAM_REWRITE.md M3).
  // A failure here (typically the building-collider index fetch) would leave
  // the boot collision arrival un-ready forever — the player walking through
  // every building for the whole session. Heal with a bounded backoff before
  // giving up loudly; `initColliderServices` is idempotent under retry.
  const colliderRetryDelaysMs = [2_000, 8_000, 30_000];
  const startColliderServices = (attempt: number): void => {
    void physics.initColliderServices().catch((err) => {
      if (attempt < colliderRetryDelaysMs.length) {
        const delayMs = colliderRetryDelaysMs[attempt];
        console.warn(
          `[physics] collider services unavailable — retrying in ${delayMs / 1000}s ` +
            `(attempt ${attempt + 1}/${colliderRetryDelaysMs.length})`,
          err
        );
        setTimeout(() => startColliderServices(attempt + 1), delayMs);
      } else {
        console.error(
          "[physics] collider services unavailable after retries — building collision stays offline this session",
          err
        );
      }
    });
  };
  startColliderServices(0);
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
