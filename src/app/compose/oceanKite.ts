// Kid-with-a-kite ambient encounter gate. Extracted from main.ts per
// docs/MAIN_DECOMPOSITION.md: the same lazy first-approach contract — resolve
// the waterline anchor cheaply at boot, defer the person/cloth/behavior chunk
// until a post-reveal approach so detached WebGPU compilation has runway.
import * as THREE from "three/webgpu";
import { windGustValue } from "../../world/vegetation/runtime";
import type { WorldMap } from "../../world/heightmap";
import type { Player } from "../../player/player";
import type { DebugPanel } from "../../ui/debug";
import type { KiteConfig } from "../../world/oceanBeachKite/kiteConfig";
import type { SandPrintSink } from "../../fx/sandPrints";

type OceanBeachKiteEncounter = import("../../world/oceanBeachKite").OceanBeachKiteEncounter;

const KITE_BEACH_Z = 1650;
const OCEAN_KITE_LOAD_DISTANCE = 650;
/**
 * Close enough that a kite atelier is a thing you would open. Hysteresis so
 * pacing the boundary does not strobe the HUD's customizer slot.
 */
const KITE_ATELIER_DISTANCE = 190;
const KITE_ATELIER_EXIT_DISTANCE = 230;
/**
 * Where the line leaves you, above the capsule centre. Not a solved hand — the
 * tether's lower end reads as "held" anywhere around chest height, and slaving
 * it to a rig joint would tie the kite to walk-mode rig internals for nothing.
 */
const PILOT_HAND_LIFT = 0.55;

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
  debugPanel,
  sandPrints,
  onAtelierRangeChange
}: {
  map: WorldMap;
  scene: THREE.Scene;
  renderer: THREE.WebGPURenderer;
  camera: THREE.Camera;
  player: Player;
  debugPanel: DebugPanel;
  /** Shared footprint runtime — the beach runners leave prints in the sand. */
  sandPrints?: SandPrintSink;
  /** Fired when the kite atelier's HUD slot should appear or disappear. */
  onAtelierRangeChange?: (inRange: boolean) => void;
}): {
  site: Readonly<{ x: number; z: number }>;
  ensure: () => Promise<void>;
  dispose: () => void;
  current: () => OceanBeachKiteEncounter | null;
  update: (dt: number, elapsed: number, revealed: boolean) => void;
  /** Sunset god-ray request for the shared raymarch pipeline; null when idle. */
  godRayArea: () => { active: boolean; center: THREE.Vector3 } | null;
  /** True while the player is close enough to own a kite here. */
  inAtelierRange: () => boolean;
  /** The player's kite. Held until the encounter is resident, then applied. */
  setKiteConfig: (config: KiteConfig) => void;
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
  let kiteConfig: KiteConfig | null = null;
  let inAtelierRange = false;
  // Whether the player's kite SHOULD be up: they asked for it, and they are on
  // their own feet. Boarding a car with a kite on the line is not a feature.
  let kiteAloft = false;
  const pilotHand = new THREE.Vector3();
  const pilotVelocity = new THREE.Vector3();
  const pilot = { hand: pilotHand, velocity: pilotVelocity };
  const wantsKiteAloft = () =>
    Boolean(kiteConfig?.flying) && player.mode === "walk";
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
        const encounter = createOceanBeachKiteEncounter(map, oceanKiteSite, {
          // The atelier rebuilds the sail on a design change; the encounter has
          // no renderer, so hand it the same detached-compile lane this gate
          // uses for the whole feature.
          warmup: async (object) => {
            await renderer.compileAsync(object, camera, scene);
          },
          sandPrints
        });
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
        // The player may have dyed a kite long before this chunk arrived.
        kiteAloft = wantsKiteAloft();
        encounter.setPlayerKite(kiteAloft ? kiteConfig : null);
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
    const distanceSq = oceanKiteDx * oceanKiteDx + oceanKiteDz * oceanKiteDz;
    if (
      revealed &&
      !oceanBeachKite &&
      !oceanBeachKiteLoading &&
      distanceSq < OCEAN_KITE_LOAD_DISTANCE * OCEAN_KITE_LOAD_DISTANCE
    ) {
      void ensureOceanBeachKite();
    }
    // Atelier slot. Hysteresis on the radius, and the callback only fires on a
    // real edge — it re-syncs the single top-right customizer slot.
    const atelierRadius = inAtelierRange ? KITE_ATELIER_EXIT_DISTANCE : KITE_ATELIER_DISTANCE;
    const nowInRange = revealed && distanceSq < atelierRadius * atelierRadius;
    if (nowInRange !== inAtelierRange) {
      inAtelierRange = nowInRange;
      onAtelierRangeChange?.(nowInRange);
    }
    if (!oceanBeachKite) return;
    // Walking away from your own kite (into a car, onto a board) packs it away;
    // coming back on foot puts it up again.
    const aloft = wantsKiteAloft();
    if (aloft !== kiteAloft) {
      kiteAloft = aloft;
      oceanBeachKite.setPlayerKite(aloft ? kiteConfig : null);
    }
    pilotHand.copy(player.renderPosition);
    pilotHand.y += PILOT_HAND_LIFT;
    pilotVelocity.copy(player.velocity);
    oceanBeachKite.update(
      dt,
      elapsed,
      player.renderPosition,
      windGustValue(),
      camera.position,
      pilot
    );
  };
  const setKiteConfig = (config: KiteConfig) => {
    kiteConfig = config;
    kiteAloft = wantsKiteAloft();
    oceanBeachKite?.setPlayerKite(kiteAloft ? config : null);
  };
  return {
    site: oceanKiteSite,
    ensure: ensureOceanBeachKite,
    dispose: disposeOceanBeachKite,
    current: () => oceanBeachKite,
    update,
    godRayArea: () => oceanBeachKite?.godRayRequest() ?? null,
    inAtelierRange: () => inAtelierRange,
    setKiteConfig
  };
}
