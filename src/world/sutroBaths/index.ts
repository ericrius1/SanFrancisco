import * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import type { AuthoredRegionStreamer } from "../authoredRegions";
import {
  SUTRO_BATHS,
  distanceToSutroBaths,
  distanceToSutroWater,
  inSutroBathsHall,
  sutroWalkSurfaceY
} from "./layout";
import { SUTRO_BATHS_TUNING, SUTRO_TUNING_FOLDERS } from "./tuning";
import { createSutroBathsVegetation } from "./vegetation";
import { createSutroBathers } from "./bathers";
import type { SutroBathsSteam } from "./steam";
import type { SutroBathsStaticWater } from "./staticWater";
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
  water: ReturnType<SutroBathsStaticWater["debugState"]> | null;
  steam: SutroBathsSteam["stats"] | null;
};

export type SutroBaths = {
  group: THREE.Group;
  ready: Promise<void>;
  setFoliageVisible(visible: boolean): void;
  /** Debug streaming panel: force sleep and block proximity wake while on. */
  setPerfSuppressed(on: boolean): void;
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
};

type MonitorState = {
  nearEffectsLoaded: boolean;
  backend: string;
  triangles: number;
  computeDispatches: number;
  simulated: boolean;
  playerDistance: number;
  steamVisible: number;
};

/**
 * Dynamic controller for the Blender-authored restored site. The authored
 * region owns architecture while the local physics tile owns colliders; this lazy module owns only foliage,
 * bathers, lighting controls, lightweight visual water, and steam.
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
    architectureMeshes: 57,
    architectureInstances: 2004,
    roofRibs: 306,
    glassPanels: 304,
    lamps: 28,
    physicsBodies: 179,
    trees: vegetation.stats.trees,
    shrubs: vegetation.stats.shrubs,
    planters: vegetation.stats.planters
  };

  const monitors: MonitorState = {
    nearEffectsLoaded: false,
    backend: "sleeping · not allocated",
    triangles: 0,
    computeDispatches: 0,
    simulated: false,
    playerDistance: Number.POSITIVE_INFINITY,
    steamVisible: 0
  };

  let water: SutroBathsStaticWater | null = null;
  let steam: SutroBathsSteam | null = null;
  let nearEffectsLoading: Promise<void> | null = null;
  let nearEffectsFailed = false;
  let awake = false;
  let foliageVisible = true;
  let distanceToBaths = Number.POSITIVE_INFINITY;
  let disposed = false;
  // The authored region hands terrain ownership to the hall and publishes its
  // deck/basin bodies asynchronously. Keep a lightweight recovery contract
  // armed for the lifetime of the site: it covers both that handoff frame and
  // rare tunnelling through a thin floor, while pool footprints still resolve
  // to the lower basin so visitors can enter the water normally.
  const hasFloorRecovery = options.physics != null;

  // Bathers still move and animate independently; the visual water intentionally
  // has no gameplay wake contract.
  const batherPlayer = new THREE.Object3D();

  const syncTuning = () => {
    ambience.applyTuning(SUTRO_BATHS_TUNING.values);
    water?.syncTuning();
  };

  const loadNearEffects = (camera: THREE.Camera): void => {
    if (water || nearEffectsLoading || nearEffectsFailed || disposed) return;
    nearEffectsLoading = Promise.all([import("./staticWater"), import("./steam")])
      .then(async ([waterModule, steamModule]) => {
        try {
          let nextWater: SutroBathsStaticWater | null =
            waterModule.createSutroBathsStaticWater({ renderer: options.renderer });
          let nextSteam: SutroBathsSteam | null = null;
          try {
            nextSteam = steamModule.createSutroBathsSteam();
            if (disposed) return;
            syncTuning();
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
        console.warn("[sutro-baths] static water/steam unavailable:", error);
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

  let perfSuppressed = false;

  syncTuning();

  return {
    group,
    ready: vegetation.ready,
    setFoliageVisible(visible) {
      foliageVisible = visible;
      vegetation.setVisible(visible);
    },
    /** Debug perf gate: force sleep and block proximity wake while suppressed. */
    setPerfSuppressed(on: boolean) {
      if (perfSuppressed === on) return;
      perfSuppressed = on;
      if (on) setAwake(false);
    },
    update(dt, time, player, camera, gust) {
      if (disposed) return;
      if (perfSuppressed) {
        if (awake) setAwake(false);
        return;
      }
      distanceToBaths = distanceToSutroBaths(player.x, player.z);
      if (!awake && distanceToBaths <= WAKE_DISTANCE) setAwake(true);
      else if (awake && distanceToBaths >= SLEEP_DISTANCE) setAwake(false);

      const waterDistance = distanceToSutroWater(player.x, player.z);
      if (waterDistance <= NEAR_EFFECTS_LOAD_DISTANCE) loadNearEffects(camera);
      if (!awake) return;

      ambience.update(time, SUTRO_BATHS_TUNING.values);
      if (foliageVisible) vegetation.update(player);

      const py = player.y ?? SUTRO_BATHS.waterY;
      batherPlayer.position.set(player.x, py, player.z);
      bathers.update(dt, time, batherPlayer);
      water?.update(dt, time, player);
      steam?.update(dt, time, player, camera, gust);

      if (water) {
        monitors.backend = water.stats.backend;
        monitors.triangles = water.stats.triangles;
        monitors.computeDispatches = water.stats.computeDispatches;
        monitors.simulated = water.stats.simulated;
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
      if (!hasFloorRecovery || disposed || playerMode !== "walk") return null;
      return sutroWalkSurfaceY(player.x, player.z);
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
          const debug = folder.addFolder({ title: "WebGPU visual water · debug" });
          return {
            monitors: [
              debug.addBinding(monitors, "nearEffectsLoaded", { readonly: true, label: "near effects loaded" }),
              debug.addBinding(monitors, "backend", { readonly: true, label: "backend" }),
              debug.addBinding(monitors, "triangles", { readonly: true, label: "water triangles" }),
              debug.addBinding(monitors, "computeDispatches", { readonly: true, label: "compute dispatches" }),
              debug.addBinding(monitors, "simulated", { readonly: true, label: "fluid simulated" }),
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
