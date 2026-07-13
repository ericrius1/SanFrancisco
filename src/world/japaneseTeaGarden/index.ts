import * as THREE from "three/webgpu";
import type { NatureSoundscape } from "../../audio";
import type { Physics } from "../../core/physics";
import type { VoiceOutput } from "../../gameplay/agents/dialogue";
import type { GardenRakeMotion, GardenRakeTool } from "../../player/gardenRake";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import { createTeaGardenArchitecture } from "./architecture";
import {
  createDryLandscape,
  type DryLandscapeDebugState
} from "./dryLandscape";
import type { TeaGardenDialogueSource } from "./dialogue";
import {
  createTeaGardenGuide,
  type TeaGardenGuideDebugState,
  type TeaGardenPlayerPosition
} from "./guide";
import {
  JAPANESE_TEA_GARDEN_CENTER,
  type TeaGardenTerrain
} from "./layout";
import { createTeaGardenVegetation } from "./vegetation";
import {
  JapaneseTeaGardenStreamAudio,
  TEA_GARDEN_STREAM_AUDIO_TUNING
} from "./streamAudio";
import {
  createTeaGardenWaterSimulation,
  type TeaGardenWaterDebugState
} from "./waterSimulation";

export {
  JAPANESE_TEA_GARDEN_CENTER,
  JAPANESE_TEA_GARDEN_ENTRANCE,
  TEA_GARDEN_BOUNDS,
  TEA_GARDEN_OUTLINE,
  TEA_GARDEN_SUPPRESSED_BUILDINGS,
  TEA_GARDEN_TOUR_STOPS,
  isTeaGardenBuilding,
  inJapaneseTeaGarden
} from "./layout";
export {
  TEA_MASTER_SPEAKER,
  TEA_GARDEN_SCRIPT,
  ScriptedTeaGardenDialogueSource,
  createScriptedTeaGardenDialogueSource,
  type TeaGardenDialogueChapter,
  type TeaGardenDialogueSource
} from "./dialogue";

export type JapaneseTeaGardenStats = {
  architectureMeshes: number;
  ponds: number;
  koi: number;
  physicsBodies: number;
  trees: number;
  shrubs: number;
  grassClusters: number;
  rocks: number;
  waterCells: number;
  waterTriangles: number;
  streamRocks: number;
};

export type JapaneseTeaGardenDebugState = {
  awake: boolean;
  foliageVisible: boolean;
  distanceToGarden: number;
  water: TeaGardenWaterDebugState;
  streamAudio: JapaneseTeaGardenStreamAudio["debugState"];
  dryLandscape: DryLandscapeDebugState;
  guide: TeaGardenGuideDebugState;
};

export type JapaneseTeaGarden = {
  group: THREE.Group;
  ready: Promise<void>;
  setFoliageVisible(visible: boolean): void;
  update(dt: number, time: number, player: TeaGardenPlayerPosition, camera: THREE.Camera, mode?: string): void;
  project(camera: THREE.Camera): void;
  interact(player: TeaGardenPlayerPosition, mode: string): boolean;
  tuningDescriptor(): DebugFeatureTuningRegistration;
  dispose(): void;
  stats: JapaneseTeaGardenStats;
  debugState(): JapaneseTeaGardenDebugState;
};

export type JapaneseTeaGardenOptions = {
  renderer: THREE.WebGPURenderer;
  nature: NatureSoundscape;
  physics?: Physics;
  dialogueSource?: TeaGardenDialogueSource;
  voiceOutput?: VoiceOutput;
  dialogueParent?: HTMLElement;
  /** Show/hide a tea bowl in the player's own hand when Hiro hands off the tea. */
  onCarryCup?: (holding: boolean) => void;
  /** Attach/detach the activity-owned rake without eagerly importing it into Player. */
  onCarryRake?: (rake: GardenRakeTool | null) => void;
  /** One exact world contact drives both the granular brush and the avatar pose. */
  onRakeMotion?: (motion: Readonly<GardenRakeMotion> | null) => void;
  notify?: (message: string, seconds?: number) => void;
};

const WAKE_DISTANCE = 720;
const SLEEP_DISTANCE = 860;

/**
 * Complete, self-owned Tea Garden feature. `ready` joins the streamed hero
 * architecture textures and authored vegetation before deferred compilation.
 */
export function createJapaneseTeaGarden(
  map: TeaGardenTerrain,
  options: JapaneseTeaGardenOptions
): JapaneseTeaGarden {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden";
  group.visible = false;

  const architecture = createTeaGardenArchitecture(map, options.physics);
  const vegetation = createTeaGardenVegetation(map);
  const water = createTeaGardenWaterSimulation({ renderer: options.renderer, map });
  const streamAudio = new JapaneseTeaGardenStreamAudio(options.nature, {
    surfaceY: water.surfaceY
  });
  const dryLandscape = createDryLandscape(map, {
    renderer: options.renderer,
    onCarryRake: options.onCarryRake,
    onRakeMotion: options.onRakeMotion,
    notify: options.notify
  });
  const guide = createTeaGardenGuide(map, {
    dialogueSource: options.dialogueSource,
    voiceOutput: options.voiceOutput,
    dialogueParent: options.dialogueParent,
    onCarryCup: options.onCarryCup
  });
  guide.setWorldVisible(false);
  group.add(architecture.group, water.group, vegetation.group, dryLandscape.group, guide.group);

  let awake = false;
  let foliageVisible = true;
  let distanceToGarden = Number.POSITIVE_INFINITY;
  let disposed = false;

  const stats: JapaneseTeaGardenStats = {
    architectureMeshes: architecture.stats.meshes,
    ponds: architecture.stats.ponds,
    koi: architecture.stats.koi,
    physicsBodies: architecture.stats.physicsBodies,
    trees: vegetation.stats.trees,
    shrubs: vegetation.stats.shrubs,
    grassClusters: vegetation.stats.grassClusters,
    rocks: vegetation.stats.rocks,
    waterCells: water.stats.activeCells,
    waterTriangles: water.stats.triangles,
    streamRocks: water.stats.rocks
  };

  const setAwake = (next: boolean) => {
    if (awake === next) return;
    awake = next;
    group.visible = next;
    guide.setWorldVisible(next);
  };

  return {
    group,
    ready: Promise.all([architecture.ready, vegetation.ready]).then(() => undefined),
    setFoliageVisible(visible: boolean) {
      foliageVisible = visible;
      vegetation.setVisible(visible);
    },
    update(dt: number, time: number, player: TeaGardenPlayerPosition, camera: THREE.Camera, mode = "walk") {
      if (disposed) return;
      distanceToGarden = Math.hypot(
        player.x - JAPANESE_TEA_GARDEN_CENTER.x,
        player.z - JAPANESE_TEA_GARDEN_CENTER.z
      );
      if (!awake && distanceToGarden <= WAKE_DISTANCE) setAwake(true);
      else if (awake && distanceToGarden >= SLEEP_DISTANCE) setAwake(false);
      streamAudio.update(dt, { playerPos: player });
      if (!awake) return;
      if (foliageVisible) vegetation.update(player);
      water.update(dt, time, player);
      architecture.update(time);
      dryLandscape.update(dt, time, player, mode);
      guide.update(dt, time, player, camera);
    },
    project(camera: THREE.Camera) {
      if (disposed || !awake) return;
      guide.project(camera);
    },
    interact(player: TeaGardenPlayerPosition, mode: string): boolean {
      if (disposed || !awake) return false;
      if (dryLandscape.interact(player, mode)) return true;
      return guide.interact(player, mode);
    },
    tuningDescriptor() {
      return {
        id: "japanese-tea-garden-simulations",
        title: "Japanese Tea Garden · GPU simulations",
        build(folder) {
          const flowingWater = folder.addFolder({ title: "flowing water", expanded: true });
          const sand = folder.addFolder({ title: "raked sand" });
          const sound = folder.addFolder({ title: "stream sound" });
          TEA_GARDEN_STREAM_AUDIO_TUNING.bind(sound);
          return { monitors: [...water.addTuning(flowingWater), ...dryLandscape.addTuning(sand)] };
        },
        sync: () => {
          water.syncTuning();
          dryLandscape.syncTuning();
        }
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      streamAudio.dispose();
      water.dispose();
      guide.dispose();
      dryLandscape.dispose();
      vegetation.dispose();
      architecture.dispose();
      group.removeFromParent();
    },
    stats,
    debugState() {
      return {
        awake,
        foliageVisible,
        distanceToGarden,
        water: water.debugState(),
        streamAudio: streamAudio.debugState,
        dryLandscape: dryLandscape.debugState(),
        guide: guide.debugState()
      };
    }
  };
}
