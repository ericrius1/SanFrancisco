import * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { VoiceOutput } from "../../gameplay/agents/dialogue";
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
};

export type JapaneseTeaGardenDebugState = {
  awake: boolean;
  foliageVisible: boolean;
  distanceToGarden: number;
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
  dispose(): void;
  stats: JapaneseTeaGardenStats;
  debugState(): JapaneseTeaGardenDebugState;
};

export type JapaneseTeaGardenOptions = {
  physics?: Physics;
  dialogueSource?: TeaGardenDialogueSource;
  voiceOutput?: VoiceOutput;
  dialogueParent?: HTMLElement;
  /** Show/hide a tea bowl in the player's own hand when Iroh hands off the tea. */
  onCarryCup?: (holding: boolean) => void;
  /** Attach/detach the activity-owned rake without eagerly importing it into Player. */
  onCarryRake?: (rake: THREE.Group | null) => void;
  onRakingChange?: (raking: boolean) => void;
  notify?: (message: string, seconds?: number) => void;
};

const WAKE_DISTANCE = 720;
const SLEEP_DISTANCE = 860;

/**
 * Complete, self-owned Tea Garden feature. The content is synchronous today,
 * but `ready` leaves room for streamed architecture/NPC assets later.
 */
export function createJapaneseTeaGarden(
  map: TeaGardenTerrain,
  options: JapaneseTeaGardenOptions = {}
): JapaneseTeaGarden {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden";
  group.visible = false;

  const architecture = createTeaGardenArchitecture(map, options.physics);
  const vegetation = createTeaGardenVegetation(map);
  const dryLandscape = createDryLandscape(map, {
    onCarryRake: options.onCarryRake,
    onRakingChange: options.onRakingChange,
    notify: options.notify
  });
  const guide = createTeaGardenGuide(map, {
    dialogueSource: options.dialogueSource,
    voiceOutput: options.voiceOutput,
    dialogueParent: options.dialogueParent,
    onCarryCup: options.onCarryCup
  });
  guide.setWorldVisible(false);
  group.add(architecture.group, vegetation.group, dryLandscape.group, guide.group);

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
    rocks: vegetation.stats.rocks
  };

  const setAwake = (next: boolean) => {
    if (awake === next) return;
    awake = next;
    group.visible = next;
    guide.setWorldVisible(next);
  };

  return {
    group,
    ready: vegetation.ready,
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
      if (!awake) return;
      if (foliageVisible) vegetation.update(player);
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
    dispose() {
      if (disposed) return;
      disposed = true;
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
        dryLandscape: dryLandscape.debugState(),
        guide: guide.debugState()
      };
    }
  };
}
