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
  inTeaGardenWater,
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
  waterInteractions: JapaneseTeaGardenWaterInteractions;
  streamAudio: JapaneseTeaGardenStreamAudio["debugState"];
  dryLandscape: DryLandscapeDebugState;
  guide: TeaGardenGuideDebugState;
};

export type JapaneseTeaGardenWaterInteractions = {
  player: number;
  balls: number;
  koi: number;
  rejected: number;
  playerInWater: boolean;
  trackedBalls: number;
  surfaceKoi: number;
};

export type TeaGardenPlayerVelocity = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

export type TeaGardenBallWorldState = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly grounded: boolean;
};

export type TeaGardenBallSource = {
  visitFreeBalls(
    visitor: (id: number, state: TeaGardenBallWorldState, radius: number) => void
  ): void;
};

export type JapaneseTeaGarden = {
  group: THREE.Group;
  ready: Promise<void>;
  setFoliageVisible(visible: boolean): void;
  update(
    dt: number,
    time: number,
    player: TeaGardenPlayerPosition,
    camera: THREE.Camera,
    mode?: string,
    velocity?: TeaGardenPlayerVelocity
  ): void;
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
  /** Boot-resident ball state is sampled only while this lazy world feature is awake. */
  ballSource?: TeaGardenBallSource;
  notify?: (message: string, seconds?: number) => void;
};

const WAKE_DISTANCE = 720;
const SLEEP_DISTANCE = 860;
const PLAYER_FOOT_BELOW_CENTER = 0.9;
const PLAYER_STEP_DISTANCE = 0.42;
const PLAYER_FOOT_SPREAD = 0.17;
const PLAYER_MAX_INTERACTION_SPEED = 9;
const KOI_SURFACE_DEPTH = 0.13;

type BallWaterTrack = {
  x: number;
  z: number;
  surfaceDelta: number;
  inWater: boolean;
  lastWakeX: number;
  lastWakeZ: number;
  seenFrame: number;
};

type KoiWaterTrack = {
  x: number;
  z: number;
  pulse: number;
};

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

  const water = createTeaGardenWaterSimulation({ renderer: options.renderer, map });
  const architecture = createTeaGardenArchitecture(map, options.physics, water.surfaceY);
  const vegetation = createTeaGardenVegetation(map);
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
  let interactionFrame = 0;
  let playerTrackValid = false;
  let playerWasInWater = false;
  let playerLastX = 0;
  let playerLastZ = 0;
  let playerStepTravel = 0;
  let playerFootSide = 1;
  const ballWaterTracks = new Map<number, BallWaterTrack>();
  const koiWaterTracks = new Map<number, KoiWaterTrack>();
  const waterInteractions: JapaneseTeaGardenWaterInteractions = {
    player: 0,
    balls: 0,
    koi: 0,
    rejected: 0,
    playerInWater: false,
    trackedBalls: 0,
    surfaceKoi: 0
  };

  const queueInteraction = (
    source: "player" | "balls" | "koi",
    impulse: Parameters<typeof water.queueImpulse>[0]
  ): boolean => {
    const accepted = water.queueImpulse(impulse);
    if (accepted) waterInteractions[source]++;
    else waterInteractions.rejected++;
    return accepted;
  };

  const updatePlayerWaterInteraction = (
    player: TeaGardenPlayerPosition,
    mode: string,
    velocity?: TeaGardenPlayerVelocity
  ) => {
    const surface = water.surfaceY(player.x, player.z);
    const footY = player.y - PLAYER_FOOT_BELOW_CENTER;
    const inWater = mode === "walk"
      && inTeaGardenWater(player.x, player.z)
      && footY <= surface + 0.1
      && footY >= surface - 0.82;
    waterInteractions.playerInWater = inWater;

    if (!playerTrackValid) {
      playerTrackValid = true;
      playerLastX = player.x;
      playerLastZ = player.z;
      playerWasInWater = inWater;
      return;
    }

    const dx = player.x - playerLastX;
    const dz = player.z - playerLastZ;
    const travel = Math.hypot(dx, dz);
    const velocitySpeed = Math.min(
      PLAYER_MAX_INTERACTION_SPEED,
      Math.hypot(velocity?.x ?? 0, velocity?.z ?? 0)
    );
    const directionLength = velocitySpeed > 0.08 ? velocitySpeed : travel;
    const directionX = directionLength > 1e-4
      ? (velocitySpeed > 0.08 ? velocity!.x : dx) / directionLength
      : 0;
    const directionZ = directionLength > 1e-4
      ? (velocitySpeed > 0.08 ? velocity!.z : dz) / directionLength
      : 0;

    if (inWater && !playerWasInWater) {
      queueInteraction("player", {
        x: player.x,
        z: player.z,
        radius: 0.72,
        strength: -0.024,
        velocityX: directionX * velocitySpeed * 0.24,
        velocityZ: directionZ * velocitySpeed * 0.24,
        foam: 0.06
      });
      playerStepTravel = 0;
    }

    if (inWater && travel < 3) {
      playerStepTravel += travel;
      let emitted = 0;
      while (playerStepTravel >= PLAYER_STEP_DISTANCE && emitted < 3) {
        playerStepTravel -= PLAYER_STEP_DISTANCE;
        const sideX = -directionZ * PLAYER_FOOT_SPREAD * playerFootSide;
        const sideZ = directionX * PLAYER_FOOT_SPREAD * playerFootSide;
        queueInteraction("player", {
          x: player.x - directionX * 0.14 + sideX,
          z: player.z - directionZ * 0.14 + sideZ,
          radius: 0.38 + Math.min(0.18, velocitySpeed * 0.018),
          strength: -(0.014 + Math.min(0.018, velocitySpeed * 0.0024)),
          velocityX: directionX * velocitySpeed * 0.22,
          velocityZ: directionZ * velocitySpeed * 0.22,
          foam: 0.035 + Math.min(0.06, velocitySpeed * 0.006)
        });
        playerFootSide *= -1;
        emitted++;
      }
    } else if (!inWater) {
      playerStepTravel = 0;
    }

    if (!inWater && playerWasInWater) {
      queueInteraction("player", {
        x: playerLastX,
        z: playerLastZ,
        radius: 0.54,
        strength: -0.012,
        velocityX: directionX * velocitySpeed * 0.12,
        velocityZ: directionZ * velocitySpeed * 0.12,
        foam: 0.025
      });
    }

    playerLastX = player.x;
    playerLastZ = player.z;
    playerWasInWater = inWater;
  };

  const updateBallWaterInteractions = () => {
    interactionFrame++;
    let trackedBalls = 0;
    options.ballSource?.visitFreeBalls((id, state, radius) => {
      trackedBalls++;
      const surface = water.surfaceY(state.x, state.z);
      const surfaceDelta = state.y - radius - surface;
      const currentInWater = inTeaGardenWater(state.x, state.z, radius * 0.25);
      const track = ballWaterTracks.get(id);
      if (!track) {
        ballWaterTracks.set(id, {
          x: state.x,
          z: state.z,
          surfaceDelta,
          inWater: currentInWater,
          lastWakeX: state.x,
          lastWakeZ: state.z,
          seenFrame: interactionFrame
        });
        return;
      }

      const denominator = track.surfaceDelta - surfaceDelta;
      const crossingT = denominator > 1e-5 ? track.surfaceDelta / denominator : -1;
      const crossedSurface = track.surfaceDelta > 0
        && surfaceDelta <= 0
        && crossingT >= 0
        && crossingT <= 1;
      const impactX = crossedSurface
        ? THREE.MathUtils.lerp(track.x, state.x, crossingT)
        : state.x;
      const impactZ = crossedSurface
        ? THREE.MathUtils.lerp(track.z, state.z, crossingT)
        : state.z;
      const enteredBank = !track.inWater && currentInWater && surfaceDelta <= 0;
      const impactInWater = inTeaGardenWater(impactX, impactZ, radius * 0.2);
      const horizontalSpeed = Math.hypot(state.vx, state.vz);
      const totalSpeed = Math.hypot(horizontalSpeed, state.vy);

      if ((crossedSurface && impactInWater && state.vy < -0.05) || enteredBank) {
        queueInteraction("balls", {
          x: impactX,
          z: impactZ,
          radius: THREE.MathUtils.clamp(0.75 + totalSpeed * 0.045, 0.75, 1.55),
          strength: -THREE.MathUtils.clamp(0.045 + Math.abs(state.vy) * 0.008, 0.045, 0.11),
          velocityX: THREE.MathUtils.clamp(state.vx * 0.32, -3.2, 3.2),
          velocityZ: THREE.MathUtils.clamp(state.vz * 0.32, -3.2, 3.2),
          foam: THREE.MathUtils.clamp(0.18 + totalSpeed * 0.028, 0.18, 0.55)
        });
        track.lastWakeX = impactX;
        track.lastWakeZ = impactZ;
      } else if (currentInWater && surfaceDelta <= 0.04 && horizontalSpeed > 0.22) {
        const wakeTravel = Math.hypot(state.x - track.lastWakeX, state.z - track.lastWakeZ);
        if (wakeTravel >= Math.max(0.32, radius * 2.2)) {
          queueInteraction("balls", {
            x: state.x,
            z: state.z,
            radius: 0.34 + Math.min(0.24, horizontalSpeed * 0.025),
            strength: -0.009,
            velocityX: THREE.MathUtils.clamp(state.vx * 0.28, -2.4, 2.4),
            velocityZ: THREE.MathUtils.clamp(state.vz * 0.28, -2.4, 2.4),
            foam: 0.045
          });
          track.lastWakeX = state.x;
          track.lastWakeZ = state.z;
        }
      }

      track.x = state.x;
      track.z = state.z;
      track.surfaceDelta = surfaceDelta;
      track.inWater = currentInWater;
      track.seenFrame = interactionFrame;
    });
    for (const [id, track] of ballWaterTracks) {
      if (track.seenFrame !== interactionFrame) ballWaterTracks.delete(id);
    }
    waterInteractions.trackedBalls = trackedBalls;
  };

  const visitKoi = (
    id: number,
    x: number,
    _y: number,
    z: number,
    velocityX: number,
    velocityZ: number,
    depth: number
  ) => {
    if (depth > KOI_SURFACE_DEPTH || !inTeaGardenWater(x, z)) return;
    waterInteractions.surfaceKoi++;
    const track = koiWaterTracks.get(id);
    if (!track) {
      koiWaterTracks.set(id, { x, z, pulse: id & 1 });
      return;
    }
    if (Math.hypot(x - track.x, z - track.z) < 0.3) return;
    const speed = Math.hypot(velocityX, velocityZ);
    const directionX = speed > 1e-4 ? velocityX / speed : 0;
    const directionZ = speed > 1e-4 ? velocityZ / speed : 0;
    const side = track.pulse & 1 ? 1 : -1;
    queueInteraction("koi", {
      x: x - directionX * 0.2 - directionZ * side * 0.055,
      z: z - directionZ * 0.2 + directionX * side * 0.055,
      radius: 0.27,
      strength: side > 0 ? -0.011 : 0.008,
      velocityX: velocityX * 0.38,
      velocityZ: velocityZ * 0.38,
      foam: 0.015
    });
    track.x = x;
    track.z = z;
    track.pulse++;
  };

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
    playerTrackValid = false;
    playerWasInWater = false;
    playerStepTravel = 0;
    waterInteractions.playerInWater = false;
    waterInteractions.trackedBalls = 0;
    waterInteractions.surfaceKoi = 0;
    ballWaterTracks.clear();
    koiWaterTracks.clear();
  };

  return {
    group,
    ready: Promise.all([architecture.ready, vegetation.ready]).then(() => undefined),
    setFoliageVisible(visible: boolean) {
      foliageVisible = visible;
      vegetation.setVisible(visible);
    },
    update(
      dt: number,
      time: number,
      player: TeaGardenPlayerPosition,
      camera: THREE.Camera,
      mode = "walk",
      velocity?: TeaGardenPlayerVelocity
    ) {
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
      updatePlayerWaterInteraction(player, mode, velocity);
      updateBallWaterInteractions();
      waterInteractions.surfaceKoi = 0;
      architecture.update(time, visitKoi);
      water.update(dt, time, player);
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
        waterInteractions: { ...waterInteractions },
        streamAudio: streamAudio.debugState,
        dryLandscape: dryLandscape.debugState(),
        guide: guide.debugState()
      };
    }
  };
}
