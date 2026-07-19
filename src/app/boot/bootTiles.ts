// Boot stage: tile + authored-region streaming (docs/MAIN_DECOMPOSITION.md step 5).
//
// Brings up the TileStreamer (with its shadow-invalidation + parallel-compile
// callbacks) and the AuthoredRegionStreamer, awaiting both inits. main.ts calls
// bootMark("tiles") immediately after this resolves.
import * as THREE from "three/webgpu";
import { TileStreamer } from "../../world/tiles";
import { AuthoredRegionStreamer } from "../../world/authoredRegions";
import { warmStaticRegion, warmUnseenMeshSignatures } from "../../render/warmStaticRegion";
import type { WorldMap } from "../../world/heightmap";
import type { Sky } from "../../world/sky";

export interface BootTilesDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGPURenderer;
  map: WorldMap;
  sky: Sky;
}

export interface BootTilesResult {
  tiles: TileStreamer;
  authoredRegions: AuthoredRegionStreamer;
}

export async function bootTiles({ scene, camera, renderer, map, sky }: BootTilesDeps): Promise<BootTilesResult> {
  const tiles = new TileStreamer(scene);
  tiles.onShadowCastersChanged = (scope) => sky.invalidateStaticShadows(scope);
  // Tile batches (buildings/roads/parks) are created lazily on first fold-in;
  // compile their pipelines on the parallel async path the moment they exist so
  // the first live frame that draws them never pays a serial compile (this was
  // a measured ~0.8s of covered settle when left to the sync path).
  tiles.onBatchCreated = (mesh) => {
    void renderer.compileAsync(mesh, camera, scene).catch(() => {});
  };
  // M10: compile first-seen tile bundle material signatures (facade near/far,
  // road/park/plain/landmark sets) before the first part draws live. After the
  // first tile or two every signature is covered and this is a no-op string
  // sweep per finalize.
  // Only the first couple of tiles matter: per-tile material INSTANCES carry
  // instance-specific program cache keys, so the signature set never saturates
  // across tiles — but the Dawn-level pipelines DO dedupe, so tiles 3..N pay
  // only cheap node builds on first draw. Warming every tile through the gate
  // was measured as a 30-55 ms compile-window carpet; two tiles cover the
  // whole material family (near + far facade variants, road/park/plain sets).
  const seenTileSignatures = new Set<string>();
  let tileWarmFinalizes = 0;
  tiles.onTileFinalized = (meshes) => {
    if (tileWarmFinalizes >= 2) return;
    tileWarmFinalizes += 1;
    void warmUnseenMeshSignatures(renderer, camera, scene, meshes, seenTileSignatures)
      .catch(() => {});
  };
  await tiles.init(map);
  const authoredRegions = new AuthoredRegionStreamer({
    scene,
    map,
    tiles,
    prepareRoot: async (label, root) => {
      try {
        const warmup = await warmStaticRegion(renderer, camera, scene, root);
        console.info(
          `[authored-region] ${label} warmed ${warmup.representatives}/${warmup.meshes} meshes ` +
          `(${warmup.renderSignatures} render paths) in ${(warmup.durationMs / 1000).toFixed(2)}s`
        );
      } catch (error) {
        // Compilation is a covered presentation optimization. The parsed
        // Blender visual remains valid and can compile on its first live frame.
        console.warn(`[authored-region] ${label} covered compile failed`, error);
      }
    }
  });
  await authoredRegions.init();
  import.meta.hot?.dispose(() => authoredRegions.dispose());
  return { tiles, authoredRegions };
}
