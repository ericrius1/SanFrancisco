import * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import type { GroundTopOverlay } from "../heightmap";
import type { TileStreamer } from "../tiles";
import { createSutroBathsArchitecture } from "./architecture";
import {
  SUTRO_BATHS,
  SUTRO_TERRAIN_CUTOUTS,
  distanceToSutroBaths,
  distanceToSutroWater,
  inSutroBathsHall,
  sutroRestoredGroundTop
} from "./layout";
import { SUTRO_BATHS_TUNING, SUTRO_TUNING_FOLDERS } from "./tuning";
import { createSutroBathsVegetation } from "./vegetation";
import type { SutroBathsSteam } from "./steam";
import type { SutroBathsWaterSimulation } from "./waterSimulation";

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
  tuningDescriptor(): DebugFeatureTuningRegistration;
  readonly stats: SutroBathsStats;
  debugState(): SutroBathsDebugState;
  dispose(): void;
};

export type SutroBathsOptions = {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  physics?: Physics;
  tiles?: TileStreamer;
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
 * Self-owned restored site. Architecture and foliage cross the site-level code
 * gate together; the storage-buffer water and instanced steam cross a second,
 * close-approach gate so a distant Lands End visit allocates neither system.
 */
export function createSutroBaths(options: SutroBathsOptions): SutroBaths {
  const group = new THREE.Group();
  group.name = "sutro_baths_restored_1896";
  group.visible = false;

  const architecture = createSutroBathsArchitecture({ physics: options.physics });
  const vegetation = createSutroBathsVegetation();
  group.add(architecture.group, vegetation.group);

  // The authored hall replaces the pre-fire heightfield inside its shell. The
  // visual discard and CPU/collision overlay are installed together and remain
  // owned by this feature, including the failed-load/dispose path.
  const groundOverlay: GroundTopOverlay = sutroRestoredGroundTop;
  const claimedTerrainCutouts: string[] = [];
  try {
    for (const cutout of SUTRO_TERRAIN_CUTOUTS) {
      options.tiles?.setTerrainCutout(cutout.id, cutout);
      if (options.tiles) claimedTerrainCutouts.push(cutout.id);
    }
    options.physics?.map.setGroundTopOverlay(groundOverlay);
  } catch (error) {
    for (const id of claimedTerrainCutouts) options.tiles?.clearTerrainCutout(id);
    vegetation.dispose();
    architecture.dispose();
    throw error;
  }

  const stats: SutroBathsStats = {
    architectureMeshes: architecture.stats.meshes,
    architectureInstances: architecture.stats.instances,
    roofRibs: architecture.stats.roofRibs,
    glassPanels: architecture.stats.glassPanels,
    lamps: architecture.stats.lamps,
    physicsBodies: architecture.stats.physicsBodies,
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
  let nearEffectsLoading: Promise<void> | null = null;
  let nearEffectsFailed = false;
  let awake = false;
  let foliageVisible = true;
  let distanceToBaths = Number.POSITIVE_INFINITY;
  let disposed = false;

  const syncTuning = () => {
    architecture.applyTuning(SUTRO_BATHS_TUNING.values);
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
    ready: Promise.all([architecture.ready, vegetation.ready]).then(() => undefined),
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

      architecture.update(time, SUTRO_BATHS_TUNING.values);
      if (foliageVisible) vegetation.update(player);
      water?.update(dt, time, player);
      steam?.update(dt, time, player, camera, gust);

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
      water?.dispose();
      steam?.dispose();
      options.physics?.map.clearGroundTopOverlay(groundOverlay);
      for (const id of claimedTerrainCutouts) options.tiles?.clearTerrainCutout(id);
      claimedTerrainCutouts.length = 0;
      vegetation.dispose();
      architecture.dispose();
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
