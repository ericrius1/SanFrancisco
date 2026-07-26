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
import { createSutroParlour } from "./parlour";
import { createSutroPavilionClock } from "./pavilionClock";
import type { SutroBathsSteam } from "./steam";
import {
  createSutroBathsStaticWater,
  type SutroBathsStaticWater
} from "./staticWater";
import { createSutroStaticAmbience } from "./staticAmbience";
import {
  createSutroTwilight,
  type SutroSkyClock,
  type SutroTwilightState
} from "./twilight";

const WAKE_DISTANCE = 760;
const SLEEP_DISTANCE = 900;
const STEAM_LOAD_DISTANCE = 170;

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
  flowers: number;
  bathers: number;
  conversations: number;
  parlourTables: number;
  parlourLamps: number;
};

export type SutroBathsDebugState = {
  awake: boolean;
  disposed: boolean;
  foliageVisible: boolean;
  distanceToBaths: number;
  nearEffectsLoading: boolean;
  nearEffectsLoaded: boolean;
  nearEffectsFailed: boolean;
  water: ReturnType<SutroBathsStaticWater["debugState"]>;
  steam: SutroBathsSteam["stats"] | null;
  twilight: SutroTwilightState;
  /** Decimal hour the pavilion clock's hands are actually showing. */
  clockHour: number;
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
  /**
   * The world clock. Handed in (rather than imported) so the out-of-time pocket
   * can take the sky over while the visitor is inside and hand it straight back
   * on the way out. Omit it and the hall simply keeps the world's own light.
   */
  sky?: SutroSkyClock | null;
  /**
   * Called when the interior gets deep enough that the outside world is no
   * longer observable through the glass. The compose layer owns the actual
   * levers (tile radii, city detail, the fog cull edge); the site only knows
   * when nobody can see out.
   */
  onExteriorThinned?: (thinned: boolean) => void;
};

type MonitorState = {
  steamLoaded: boolean;
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

  // Water is an essential part of the authored pools, not a close-range effect.
  // Construct it with the lazy site root so prepareOptionalRoot prewarms its
  // WebGPU pipeline before the root can become visible. Steam stays behind the
  // tighter proximity gate below.
  const water = createSutroBathsStaticWater({ renderer: options.renderer });
  const ambience = createSutroStaticAmbience(options.authoredRegions);
  const vegetation = createSutroBathsVegetation();
  const bathers = createSutroBathers();
  const parlour = createSutroParlour();
  parlour.setLampGlow(0);
  const pavilionClock = createSutroPavilionClock({
    sky: options.sky,
    authoredRegions: options.authoredRegions
  });
  pavilionClock.setTwilight(0);
  const twilight = createSutroTwilight({
    sky: options.sky,
    onExteriorThinned: options.onExteriorThinned
  });
  group.add(
    ambience.group,
    vegetation.group,
    parlour.group,
    pavilionClock.group,
    bathers.group,
    water.group
  );

  const stats: SutroBathsStats = {
    architectureMeshes: 57,
    architectureInstances: 2004,
    roofRibs: 306,
    glassPanels: 304,
    lamps: 28,
    physicsBodies: 179,
    trees: vegetation.stats.trees,
    shrubs: vegetation.stats.shrubs,
    planters: vegetation.stats.planters,
    flowers: vegetation.stats.flowers,
    // The cast hydrates across frames, so these two are refreshed on read
    // rather than frozen at construction (when exactly one bather exists).
    bathers: bathers.stats.bathers,
    conversations: bathers.stats.talkGroups,
    parlourTables: parlour.stats.tables,
    parlourLamps: parlour.stats.lamps
  };
  const liveStats = (): SutroBathsStats => {
    stats.bathers = bathers.stats.bathers;
    stats.conversations = bathers.stats.talkGroups;
    return stats;
  };

  const monitors: MonitorState = {
    steamLoaded: false,
    backend: "sleeping · not allocated",
    triangles: 0,
    computeDispatches: 0,
    simulated: false,
    playerDistance: Number.POSITIVE_INFINITY,
    steamVisible: 0
  };

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
    water.syncTuning();
  };

  const loadNearEffects = (camera: THREE.Camera): void => {
    if (steam || nearEffectsLoading || nearEffectsFailed || disposed) return;
    nearEffectsLoading = import("./steam")
      .then(async (steamModule) => {
        try {
          let nextSteam: SutroBathsSteam | null = null;
          try {
            nextSteam = steamModule.createSutroBathsSteam();
            if (disposed) return;
            syncTuning();
            try {
              // WebGPURenderer compilation can encode render passes while it
              // builds async pipelines. Reveal the detached steam root so
              // Three actually traverses it.
              nextSteam.group.visible = true;
              await options.renderer.compileAsync(nextSteam.group, camera, options.scene);
            } catch (error) {
              console.warn("[sutro-baths] steam render warmup failed:", error);
            } finally {
              nextSteam.group.visible = false;
            }
            if (disposed) return;
            steam = nextSteam;
            nextSteam = null;
            group.add(steam.group);
            steam.setEnabled(awake);
            monitors.steamLoaded = true;
          } finally {
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
        console.warn("[sutro-baths] steam unavailable:", error);
      })
      .finally(() => {
        nearEffectsLoading = null;
      });
  };

  // Staged wake. Revealing the whole site in one frame makes that frame pay the
  // first-draw cost of every part at once — render lists, bind groups and buffer
  // uploads for the pools, the cast, the furniture and the planting together —
  // which is a ~300 ms freeze the instant a visitor arrives. Each layer instead
  // joins on its own frame, in the order that matters: the water IS the hall, so
  // it goes first; the people, the parlour and the planting follow over the next
  // three frames, by which point nobody has looked away from the pools yet.
  const wakeStages: readonly (() => boolean)[] = [
    () => {
      water.group.visible = true;
      return false;
    },
    () => {
      parlour.group.visible = true;
      return false;
    },
    // The cast comes out a handful at a time — 38 skinned meshes on one frame is
    // 38 first-draw bind-group builds.
    () => bathers.revealSome(5),
    () => {
      if (foliageVisible) vegetation.setVisible(true);
      return false;
    }
  ];
  let wakeStage = 0;

  const setAwake = (next: boolean) => {
    if (awake === next) return;
    awake = next;
    if (next) {
      wakeStage = 0;
      water.group.visible = false;
      parlour.group.visible = false;
      vegetation.setVisible(false);
    }
    group.visible = next;
    water.setEnabled(next);
    steam?.setEnabled(next);
    // A sleeping site must never keep holding the world's clock or the city
    // culled: releasing here covers streaming-out, perf suppression and the
    // debug panel's A/B toggle in one place. The pavilion clock releases with
    // it so the next arrival finds its hands already on the hour rather than
    // winding to it from wherever the last visit left them.
    if (!next) {
      twilight.release();
      pavilionClock.release();
    }
  };

  let perfSuppressed = false;

  syncTuning();

  // The site is "ready" for the covered warm once its unified foliage has
  // compiled AND the cast is fully built. Both are sliced across frames, so this
  // adds no frozen time — it only means the warm sees every signature once.
  const ready = Promise.all([
    vegetation.ready,
    bathers.hydrate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  ]).then(() => undefined);

  return {
    group,
    ready,
    setFoliageVisible(visible) {
      foliageVisible = visible;
      // While the staged wake is still walking down its list, leave the reveal
      // to it: flipping the group on here would hand one frame the very cost
      // the staging exists to spread out.
      if (wakeStage >= wakeStages.length || !visible) vegetation.setVisible(visible);
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
        else twilight.release();
        return;
      }
      distanceToBaths = distanceToSutroBaths(player.x, player.z);
      if (!awake && distanceToBaths <= WAKE_DISTANCE) setAwake(true);
      else if (awake && distanceToBaths >= SLEEP_DISTANCE) setAwake(false);

      const waterDistance = distanceToSutroWater(player.x, player.z);
      if (waterDistance <= STEAM_LOAD_DISTANCE) loadNearEffects(camera);
      if (!awake) return;

      twilight.update(dt, player);
      // One layer per frame until the site is fully present (see wakeStages).
      // A stage that returns true has more to hand out and keeps its turn.
      if (wakeStage < wakeStages.length && !wakeStages[wakeStage]()) wakeStage++;
      ambience.setTwilight(twilight.depth);
      parlour.setLampGlow(twilight.lampGlow);
      // After twilight.update: the pocket has just written the hour the sky is
      // rendering, and the clock's whole job is to agree with it.
      pavilionClock.setTwilight(twilight.depth);
      pavilionClock.update(dt);
      bathers.setTwilight(twilight.depth);
      water.setTwilight(twilight.depth);
      ambience.update(time, SUTRO_BATHS_TUNING.values);
      if (foliageVisible) vegetation.update(player);

      const py = player.y ?? SUTRO_BATHS.waterY;
      batherPlayer.position.set(player.x, py, player.z);
      bathers.update(dt, time, batherPlayer);
      water.update(dt, time, player);
      steam?.update(dt, time, player, camera, gust);

      monitors.backend = water.stats.backend;
      monitors.triangles = water.stats.triangles;
      monitors.computeDispatches = water.stats.computeDispatches;
      monitors.simulated = water.stats.simulated;
      monitors.playerDistance = water.stats.playerDistance;
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
              debug.addBinding(monitors, "steamLoaded", { readonly: true, label: "steam loaded" }),
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
    get stats() {
      return liveStats();
    },
    debugState() {
      return {
        awake,
        disposed,
        foliageVisible,
        distanceToBaths,
        nearEffectsLoading: nearEffectsLoading !== null,
        nearEffectsLoaded: steam !== null,
        nearEffectsFailed,
        water: water.debugState(),
        steam: steam?.stats ?? null,
        twilight: twilight.debugState(),
        clockHour: pavilionClock.displayHour
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      twilight.release();
      water.dispose();
      steam?.dispose();
      bathers.dispose();
      parlour.dispose();
      pavilionClock.dispose();
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
