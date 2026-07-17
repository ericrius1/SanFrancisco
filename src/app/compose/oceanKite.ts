// Kid-with-a-kite ambient encounter gate. Extracted from main.ts per
// docs/MAIN_DECOMPOSITION.md: the same lazy first-approach contract — resolve
// the waterline anchor cheaply at boot, defer the person/cloth/behavior chunk
// until a post-reveal approach so detached WebGPU compilation has runway.
import * as THREE from "three/webgpu";
import { windGustValue } from "../../world/vegetation/runtime";
import type { WorldMap } from "../../world/heightmap";
import type { Player } from "../../player/player";
import type { DebugPanel } from "../../ui/debug";

type OceanBeachKiteEncounter = import("../../world/oceanBeachKite").OceanBeachKiteEncounter;

const KITE_BEACH_Z = 1650;
const OCEAN_KITE_LOAD_DISTANCE = 650;

/**
 * The kid stands on the sandy NW-headland beach just south of Sutro Baths
 * (roughly between Sutro Baths and the Archery Range), where the player
 * trolley passes. `update` runs once per live frame: it requests the split
 * chunk on approach (post-reveal only) and advances a resident encounter.
 */
export function createOceanKiteGate({
  map,
  scene,
  renderer,
  camera,
  player,
  debugPanel
}: {
  map: WorldMap;
  scene: THREE.Scene;
  renderer: THREE.WebGPURenderer;
  camera: THREE.Camera;
  player: Player;
  debugPanel: DebugPanel;
}): {
  site: Readonly<{ x: number; z: number }>;
  ensure: () => Promise<void>;
  dispose: () => void;
  current: () => OceanBeachKiteEncounter | null;
  update: (dt: number, elapsed: number, revealed: boolean) => void;
} {
  // Resolve the waterline X now (cheap); everything else waits for approach.
  let kiteShoreX = -6160;
  for (let x = -6260; x < -6040; x += 2) {
    if (!map.isWater(x, KITE_BEACH_Z)) {
      kiteShoreX = x;
      break;
    }
  }
  const oceanKiteSite = { x: kiteShoreX, z: KITE_BEACH_Z };
  let oceanBeachKite: OceanBeachKiteEncounter | null = null;
  let oceanBeachKiteLoading: Promise<void> | null = null;
  let unregisterOceanKiteTuning: (() => void) | null = null;
  let oceanKiteGeneration = 0;
  const refreshOceanKiteDebug = () => {
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (hooks) Object.assign(hooks, { oceanBeachKite, ensureOceanBeachKite });
  };
  const ensureOceanBeachKite = () => {
    if (oceanBeachKite || oceanBeachKiteLoading) return oceanBeachKiteLoading ?? Promise.resolve();
    const generation = oceanKiteGeneration;
    const loading = import("../../world/oceanBeachKite")
      .then(async ({ createOceanBeachKiteEncounter }) => {
        if (generation !== oceanKiteGeneration) return;
        const distance = Math.hypot(
          player.position.x - oceanKiteSite.x,
          player.position.z - oceanKiteSite.z
        );
        // The player can teleport away while the split chunk is in flight.
        if (distance > OCEAN_KITE_LOAD_DISTANCE) return;
        const encounter = createOceanBeachKiteEncounter(map, oceanKiteSite);
        // compileAsync skips invisible roots. Prepare the feature while detached,
        // and temporarily un-cull its descendants so an approach from outside
        // the current camera frustum still warms the rig and node cloth.
        encounter.group.visible = true;
        const culling = new Map<THREE.Object3D, boolean>();
        encounter.group.traverse((object) => {
          culling.set(object, object.frustumCulled);
          object.frustumCulled = false;
        });
        try {
          await renderer.compileAsync(encounter.group, camera, scene);
        } catch (error) {
          console.warn("[ocean kite] detached shader warmup failed", error);
        } finally {
          for (const [object, frustumCulled] of culling) object.frustumCulled = frustumCulled;
        }
        if (generation !== oceanKiteGeneration) {
          encounter.dispose();
          return;
        }
        const stillNear = Math.hypot(
          player.position.x - oceanKiteSite.x,
          player.position.z - oceanKiteSite.z
        ) <= OCEAN_KITE_LOAD_DISTANCE;
        if (!stillNear) {
          encounter.dispose();
          return;
        }
        encounter.group.visible = false;
        scene.add(encounter.group);
        oceanBeachKite = encounter;
        unregisterOceanKiteTuning = debugPanel.registerFeatureTuning(encounter.tuningDescriptor());
        refreshOceanKiteDebug();
      })
      .catch((error) => console.warn("[ocean kite] encounter failed to load", error))
      .finally(() => {
        if (oceanBeachKiteLoading === loading) oceanBeachKiteLoading = null;
      });
    oceanBeachKiteLoading = loading;
    return loading;
  };
  const disposeOceanBeachKite = () => {
    oceanKiteGeneration++;
    unregisterOceanKiteTuning?.();
    unregisterOceanKiteTuning = null;
    oceanBeachKite?.dispose();
    oceanBeachKite = null;
    refreshOceanKiteDebug();
  };
  const update = (dt: number, elapsed: number, revealed: boolean) => {
    const oceanKiteDx = player.position.x - oceanKiteSite.x;
    const oceanKiteDz = player.position.z - oceanKiteSite.z;
    if (
      revealed &&
      !oceanBeachKite &&
      !oceanBeachKiteLoading &&
      oceanKiteDx * oceanKiteDx + oceanKiteDz * oceanKiteDz <
        OCEAN_KITE_LOAD_DISTANCE * OCEAN_KITE_LOAD_DISTANCE
    ) {
      void ensureOceanBeachKite();
    }
    oceanBeachKite?.update(dt, elapsed, player.renderPosition, windGustValue());
  };
  return {
    site: oceanKiteSite,
    ensure: ensureOceanBeachKite,
    dispose: disposeOceanBeachKite,
    current: () => oceanBeachKite,
    update
  };
}
