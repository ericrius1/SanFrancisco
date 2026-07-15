import * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import type { AuthoredRegionStreamer } from "../authoredRegions";
import {
  SUTRO_BATHS,
  distanceToSutroBaths,
  distanceToSutroWater,
  inSutroBathsHall
} from "./layout";
import { SUTRO_BATHS_TUNING, SUTRO_TUNING_FOLDERS } from "./tuning";
import { createSutroBathsVegetation } from "./vegetation";
import { createSutroBathers } from "./bathers";
import {
  createSutroWaterInteractions,
  type SutroBallSource,
  type SutroRemoteState,
  type SutroWaterInteractions
} from "./waterInteractions";
import type { SutroBathsSteam } from "./steam";
import type { SutroBathsWaterSimulation } from "./waterSimulation";
import { createSutroStaticAmbience } from "./staticAmbience";

const WAKE_DISTANCE = 760;
const SLEEP_DISTANCE = 900;
const NEAR_EFFECTS_LOAD_DISTANCE = 170;

export type SutroBathsPlayerPosition = { x: number; y?: number; z: number };

export type SutroBathsStats = {
  architectureMeshes: number;
  architectureInstances: number;
  roofRibs: number;
  glassPanels: number;
  lamps: number;
  physicsBodies: number;
  trees: number;
  shrubs: number;
  planters: number;
};

export type SutroBathsDebugState = {
  awake: boolean;
  disposed: boolean;
  foliageVisible: boolean;
  distanceToBaths: number;
  nearEffectsLoading: boolean;
  nearEffectsLoaded: boolean;
  nearEffectsFailed: boolean;
  water: ReturnType<SutroBathsWaterSimulation["debugState"]> | null;
  steam: SutroBathsSteam["stats"] | null;
};

export type SutroBaths = {
  group: THREE.Group;
  ready: Promise<void>;
  setFoliageVisible(visible: boolean): void;
  update(
    dt: number,
    time: number,
    player: SutroBathsPlayerPosition,
    camera: THREE.Camera,
    gust: number
  ): void;
  isPlayerInside(player: SutroBathsPlayerPosition): boolean;
  /**
   * One-shot lazy-build floor handoff. Returns the restored deck height the
   * first time a walking visitor is inside the hall footprint, so main can lift
   * a capsule that the terrain-burying overlay left stranded beneath the deck.
   * Returns null once consumed, when asleep, or for non-walking embodiments.
   */
  takeFloorHandoffHeight(player: SutroBathsPlayerPosition, playerMode: string): number | null;
  tuningDescriptor(): DebugFeatureTuningRegistration;
  readonly stats: SutroBathsStats;
  debugState(): SutroBathsDebugState;
  dispose(): void;
};

export type SutroBathsOptions = {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  physics?: Physics;
  authoredRegions?: AuthoredRegionStreamer;
  /** Thrown/rolling balls that should splash the pools (main wires fetchBall). */
  ballSource?: SutroBallSource;
  /** Remote bathers whose motion should ripple the pools. */
  getRemotes?: () => Iterable<SutroRemoteState>;
};

type MonitorState = {
  nearEffectsLoaded: boolean;
  backend: string;
  grid: string;
  activeCells: number;
  triangles: number;
  dispatches: number;
  ticks: number;
  running: boolean;
  playerDistance: number;
  steamVisible: number;
};

/**
 * Dynamic controller for the Blender-authored restored site. The authored
 * region owns architecture while the local physics tile owns colliders; this lazy module owns only foliage,
 * bathers, lighting controls, water, steam, and interactions.
 */
export function createSutroBaths(options: SutroBathsOptions): SutroBaths {
  const group = new THREE.Group();
  group.name = "sutro_baths_restored_1896";
  group.visible = false;

  const ambience = createSutroStaticAmbience(options.authoredRegions);
  const vegetation = createSutroBathsVegetation();
  const bathers = createSutroBathers();
  group.add(ambience.group, vegetation.group, bathers.group);

  const stats: SutroBathsStats = {
    architectureMeshes: 53,
    architectureInstances: 1619,
    roofRibs: 306,
    glassPanels: 304,
    lamps: 28,
    physicsBodies: 68,
    trees: vegetation.stats.trees,
    shrubs: vegetation.stats.shrubs,
    planters: vegetation.stats.planters
  };

  const monitors: MonitorState = {
    nearEffectsLoaded: false,
    backend: "sleeping · not allocated",
    grid: "—",
    activeCells: 0,
    triangles: 0,
    dispatches: 0,
    ticks: 0,
    running: false,
    playerDistance: Number.POSITIVE_INFINITY,
    steamVisible: 0
  };

  let water: SutroBathsWaterSimulation | null = null;
  let steam: SutroBathsSteam | null = null;
  let waterInteractions: SutroWaterInteractions | null = null;
  let nearEffectsLoading: Promise<void> | null = null;
  let nearEffectsFailed = false;
  let awake = false;
  let foliageVisible = true;
  let distanceToBaths = Number.POSITIVE_INFINITY;
  let disposed = false;
  // The authored region has already handed terrain ownership to the hall
  // and published the deck/basin colliders. A walking capsule that was standing
  // on the old ground (near sea level on the ocean side) can be trapped beneath
  // the deck slab, which — being above it — can never lift it back out.
  // Arm a one-shot handoff so main lifts it onto the deck once, like the raised
  // Mission Dolores basilica floor. Only meaningful when physics is present.
  let floorHandoffPending = options.physics != null;

  // index.ts only receives a player POSITION each frame; derive velocity from
  // the frame-to-frame delta for directional wader wakes, and keep a dummy
  // Object3D so the bathers can glance toward the player.
  const prevPlayerPos = new THREE.Vector3();
  const playerVel = new THREE.Vector3();
  const batherPlayer = new THREE.Object3D();
  let havePrevPlayer = false;

  const syncTuning = () => {
    ambience.applyTuning(SUTRO_BATHS_TUNING.values);
    water?.syncTuning();
  };

  const loadNearEffects = (camera: THREE.Camera): void => {
    if (water || nearEffectsLoading || nearEffectsFailed || disposed) return;
    nearEffectsLoading = Promise.all([import("./waterSimulation"), import("./steam")])
      .then(async ([waterModule, steamModule]) => {
        try {
          let nextWater: SutroBathsWaterSimulation | null =
            waterModule.createSutroBathsWaterSimulation({ renderer: options.renderer });
          let nextSteam: SutroBathsSteam | null = null;
          try {
            nextSteam = steamModule.createSutroBathsSteam();
            if (disposed) return;
            syncTuning();
            try {
              await nextWater.warmup();
            } catch (error) {
              console.warn("[sutro-baths] close water compute warmup failed:", error);
            }
            try {
              // WebGPURenderer compilation can encode render passes while it
              // builds async pipelines. Keep those passes serialized, and
              // reveal the detached steam root so Three actually traverses it.
              await options.renderer.compileAsync(nextWater.group, camera, options.scene);
              nextSteam.group.visible = true;
              await options.renderer.compileAsync(nextSteam.group, camera, options.scene);
            } catch (error) {
              console.warn("[sutro-baths] near effects render warmup failed:", error);
            } finally {
              nextSteam.group.visible = false;
            }
            if (disposed) return;
            water = nextWater;
            steam = nextSteam;
            nextWater = null;
            nextSteam = null;
            group.add(water.group, steam.group);
            water.setEnabled(awake);
            steam.setEnabled(awake);
            waterInteractions = createSutroWaterInteractions({
              water,
              ballSource: options.ballSource,
              getRemotes: options.getRemotes
            });
            monitors.nearEffectsLoaded = true;
          } finally {
            nextWater?.dispose();
            nextSteam?.dispose();
          }
        } catch (error) {
          // Constructor/import failures are not made safer by allocating the
          // same GPU resources every frame. Rollback above, then latch until a
          // fresh page load can retry with a valid environment.
          nearEffectsFailed = true;
          throw error;
        }
      })
      .catch((error) => {
        console.warn("[sutro-baths] close water/steam unavailable:", error);
      })
      .finally(() => {
        nearEffectsLoading = null;
      });
  };

  const setAwake = (next: boolean) => {
    if (awake === next) return;
    awake = next;
    group.visible = next;
    water?.setEnabled(next);
    steam?.setEnabled(next);
  };

  syncTuning();

  return {
    group,
    ready: vegetation.ready,
    setFoliageVisible(visible) {
      foliageVisible = visible;
      vegetation.setVisible(visible);
    },
    update(dt, time, player, camera, gust) {
      if (disposed) return;
      distanceToBaths = distanceToSutroBaths(player.x, player.z);
      if (!awake && distanceToBaths <= WAKE_DISTANCE) setAwake(true);
      else if (awake && distanceToBaths >= SLEEP_DISTANCE) setAwake(false);

      const waterDistance = distanceToSutroWater(player.x, player.z);
      if (waterDistance <= NEAR_EFFECTS_LOAD_DISTANCE) loadNearEffects(camera);
      if (!awake) return;

      ambience.update(time, SUTRO_BATHS_TUNING.values);
      if (foliageVisible) vegetation.update(player);

      const py = player.y ?? SUTRO_BATHS.waterY;
      if (havePrevPlayer && dt > 1e-4) {
        playerVel.set(
          (player.x - prevPlayerPos.x) / dt,
          (py - prevPlayerPos.y) / dt,
          (player.z - prevPlayerPos.z) / dt
        );
      } else {
        playerVel.set(0, 0, 0);
      }
      prevPlayerPos.set(player.x, py, player.z);
      havePrevPlayer = true;

      // Inject wader/ball/remote wakes before the sim drains its queue so they
      // propagate this frame.
      waterInteractions?.update({
        dt,
        player: {
          position: { x: player.x, y: py, z: player.z },
          velocity: { x: playerVel.x, y: playerVel.y, z: playerVel.z }
        }
      });
      water?.update(dt, time, player);
      steam?.update(dt, time, player, camera, gust);

      batherPlayer.position.set(player.x, py, player.z);
      bathers.update(dt, time, batherPlayer);

      if (water) {
        monitors.backend = water.stats.backend;
        monitors.grid = water.stats.grid;
        monitors.activeCells = water.stats.activeCells;
        monitors.triangles = water.stats.triangles;
        monitors.dispatches = water.stats.dispatches;
        monitors.ticks = water.stats.ticks;
        monitors.running = water.stats.running;
        monitors.playerDistance = water.stats.playerDistance;
      } else {
        monitors.playerDistance = waterDistance;
      }
      monitors.steamVisible = steam?.stats.visible ?? 0;
    },
    isPlayerInside(player) {
      const y = player.y ?? SUTRO_BATHS.deckY;
      return (
        inSutroBathsHall(player.x, player.z, -1.2) &&
        y >= SUTRO_BATHS.basinY - 1.5 &&
        y <= SUTRO_BATHS.roofApexY + 4
      );
    },
    takeFloorHandoffHeight(player, playerMode) {
      if (!floorHandoffPending || disposed || playerMode !== "walk") return null;
      // Fire only once the walker is actually over the hall footprint. The entry
      // portal and grand stair sit just OUTSIDE it, so this consumes cleanly at
      // the deck rather than up on the cliff approach. recoverOntoWalkSurface is
      // lift-only, so a visitor who arrived correctly on the deck is untouched.
      if (!inSutroBathsHall(player.x, player.z)) return null;
      floorHandoffPending = false;
      return SUTRO_BATHS.deckY;
    },
    tuningDescriptor() {
      return {
        id: "sutro-baths-restoration",
        title: "Sutro Baths · restored 1896",
        build(folder) {
          for (const descriptor of SUTRO_TUNING_FOLDERS) {
            const child = folder.addFolder({ title: descriptor.title, expanded: descriptor.expanded });
            SUTRO_BATHS_TUNING.bind(child, {
              keys: [...descriptor.keys],
              onChange: () => syncTuning()
            });
          }
          folder.addButton({ title: "reset close water", label: "water" }).on("click", () => water?.reset());
          const debug = folder.addFolder({ title: "WebGPU water · debug" });
          return {
            monitors: [
              debug.addBinding(monitors, "nearEffectsLoaded", { readonly: true, label: "near effects loaded" }),
              debug.addBinding(monitors, "backend", { readonly: true, label: "backend" }),
              debug.addBinding(monitors, "grid", { readonly: true, label: "spatial grid" }),
              debug.addBinding(monitors, "activeCells", { readonly: true, label: "active cells" }),
              debug.addBinding(monitors, "triangles", { readonly: true, label: "water triangles" }),
              debug.addBinding(monitors, "dispatches", { readonly: true, label: "dispatches/frame" }),
              debug.addBinding(monitors, "ticks", { readonly: true, label: "fixed ticks/frame" }),
              debug.addBinding(monitors, "running", { readonly: true, label: "running" }),
              debug.addBinding(monitors, "steamVisible", { readonly: true, label: "steam puffs" }),
              debug.addBinding(monitors, "playerDistance", {
                readonly: true,
                label: "water distance",
                format: (value: number) => (Number.isFinite(value) ? value.toFixed(1) : "—")
              })
            ]
          };
        },
        sync: syncTuning
      };
    },
    stats,
    debugState() {
      return {
        awake,
        disposed,
        foliageVisible,
        distanceToBaths,
        nearEffectsLoading: nearEffectsLoading !== null,
        nearEffectsLoaded: water !== null,
        nearEffectsFailed,
        water: water?.debugState() ?? null,
        steam: steam?.stats ?? null
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      waterInteractions = null;
      water?.dispose();
      steam?.dispose();
      bathers.dispose();
      vegetation.dispose();
      ambience.dispose();
      group.removeFromParent();
    }
  };
}

export {
  SUTRO_BATHS,
  SUTRO_BATHS_ARRIVAL,
  SUTRO_POOLS,
  distanceToSutroBaths,
  distanceToSutroWater,
  inSutroBathsHall
} from "./layout";
