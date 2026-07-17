import * as THREE from "three/webgpu";
import type { NatureSoundscape } from "../../audio";
import type { Physics } from "../../core/physics";
import type { VoiceOutput } from "../../gameplay/agents/dialogue";
import type { PaintWaterSegment } from "../../fx/paintball";
import type { GardenRakeMotion, GardenRakeTool } from "../../player/gardenRake";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import { createTeaGardenArchitecture } from "./architecture";
import {
  createDryLandscape,
  DRY_LANDSCAPE_CENTER,
  type DryLandscapeDebugState
} from "./dryLandscape";
import type { SandRakeStamp } from "./sandSimulation";
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
import { TEA_GARDEN_RAKE_AUDIO_TUNING } from "./rakeAudio";
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
export { createGardenRakeTool } from "./dryLandscape";

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
  koi: {
    total: number;
    insideWater: number;
    submerged: number;
    minSubmersion: number;
    tailStrokes: number;
    wakeImpulses: number;
    cadenceLimited: number;
  };
  streamAudio: JapaneseTeaGardenStreamAudio["debugState"];
  dryLandscape: DryLandscapeDebugState;
  guide: TeaGardenGuideDebugState;
};

export type JapaneseTeaGardenWaterInteractions = {
  player: number;
  balls: number;
  koi: number;
  paint: number;
  rejected: number;
  playerInWater: boolean;
  trackedBalls: number;
  surfaceKoi: number;
  koiCadenceLimited: number;
};

export type TeaGardenPaintWaterImpact = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly velocityZ: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly shooter: number;
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
  /** Compile independent Tea-owned entrance roots concurrently. */
  prepareEssential(prepare: (group: THREE.Group) => Promise<void>): Promise<void>;
  /** Exclude native trees from the first destination-essential WebGPU compile. */
  deferOptionalFoliage(): void;
  /** Prepare deferred native trees without holding back architecture, Hiro, or grass. */
  prepareOptionalFoliage(prepare: (group: THREE.Group) => Promise<void>): Promise<void>;
  /** Keep the distant raked-sand activity out of the destination-critical compile. */
  deferOptionalDetails(): void;
  /** Warm and reveal the Tea-owned dry landscape after essential scenery. */
  prepareOptionalDetails(prepare: (group: THREE.Group) => Promise<void>): Promise<void>;
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
  isRaking(): boolean;
  /** Quiet teardown used by teleport and the shared minigame exit button. */
  releaseForNavigation(): boolean;
  /** Apply one canonical multiplayer stroke to the shared local GPU field. */
  queueRakeStamp(stamp: SandRakeStamp): boolean;
  /** Return to the authored pattern when the relay starts a fresh sand session. */
  resetSand(): void;
  /** True when (x, z) is over an authored water feature (pond/stream). Lets the
   *  ball tool suppress its dry ground thud for a bounce on the pond bottom. */
  containsWater(x: number, z: number): boolean;
  /** Turns a paintball surface crossing into a ripple plus advected GPU dye. */
  paintWater(impact: TeaGardenPaintWaterImpact): boolean;
  /** Finds and consumes the real water crossing before hidden terrain is hit. */
  paintWaterSegment(segment: Readonly<PaintWaterSegment>): boolean;
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
  /** Return true when the relay accepted the segment for ordered echo. */
  onRakeStamp?: (stamp: Readonly<SandRakeStamp>) => boolean;
  /** Boot-resident ball state is sampled only while this lazy world feature is awake. */
  ballSource?: TeaGardenBallSource;
  /** A thrown ball broke the tea water surface at `speed` m/s — voice a plonk +
   *  the fey-realm magic echo. Fires only while the garden is awake. */
  onBallWaterImpact?: (x: number, y: number, z: number, speed: number) => void;
  notify?: (message: string, seconds?: number) => void;
};

const WAKE_DISTANCE = 720;
const SLEEP_DISTANCE = 860;
const PLAYER_FOOT_BELOW_CENTER = 0.9;
const PLAYER_STEP_DISTANCE = 0.42;
const PLAYER_FOOT_SPREAD = 0.17;
const PLAYER_MAX_INTERACTION_SPEED = 9;
const KOI_SURFACE_DEPTH = 0.17;
const KOI_WAKE_MIN_INTERVAL = 0.1;
const WATER_ACTIVE_DISTANCE = 210;
const DRY_LANDSCAPE_REVEAL_DISTANCE = 48;

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
  tailStroke: number;
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
    nature: options.nature,
    onCarryRake: options.onCarryRake,
    onRakeMotion: options.onRakeMotion,
    onRakeStamp: options.onRakeStamp,
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
  let koiUpdateTime = 0;
  let nextKoiWakeTime = 0;
  let optionalDetailsDeferred = false;
  let optionalDetailsPrepared = false;
  let optionalDetailsPreparation: Promise<void> | null = null;
  const ballWaterTracks = new Map<number, BallWaterTrack>();
  const koiWaterTracks = new Map<number, KoiWaterTrack>();
  const waterInteractions: JapaneseTeaGardenWaterInteractions = {
    player: 0,
    balls: 0,
    koi: 0,
    paint: 0,
    rejected: 0,
    playerInWater: false,
    trackedBalls: 0,
    surfaceKoi: 0,
    koiCadenceLimited: 0
  };

  const queueInteraction = (
    source: "player" | "balls" | "koi" | "paint",
    impulse: Parameters<typeof water.queueImpulse>[0]
  ): boolean => {
    const accepted = water.queueImpulse(impulse);
    if (accepted) {
      waterInteractions[source]++;
      const horizontal = Math.hypot(impulse.velocityX ?? 0, impulse.velocityZ ?? 0);
      const motion = THREE.MathUtils.clamp(horizontal / 1.35, 0, 1);
      const foam = THREE.MathUtils.clamp((impulse.foam ?? 0) / 0.13, 0, 1);
      const displacement = THREE.MathUtils.clamp(Math.abs(impulse.strength ?? 0) / 0.11, 0, 1);
      const paintEnergy = THREE.MathUtils.clamp(((impulse.dye ?? 0.72) - 0.72) / 0.46, 0, 1);
      const energy = source === "paint"
        ? paintEnergy
        : source === "balls"
          ? THREE.MathUtils.clamp(0.18 + displacement * 0.55 + motion * 0.22, 0, 1)
          : source === "player"
            ? THREE.MathUtils.clamp(0.07 + displacement * 0.38 + motion * 0.18, 0, 0.72)
            : THREE.MathUtils.clamp(0.035 + motion * 0.14 + foam * 0.08, 0, 0.3);
      streamAudio.playRippleImpact({
        kind: source === "player" ? "foot" : source === "balls" ? "ball" : source,
        x: impulse.x,
        y: water.surfaceY(impulse.x, impulse.z),
        z: impulse.z,
        energy,
        rippleRadius: impulse.radius,
        dyeAmount: source === "paint" ? impulse.dye : undefined,
        dyeRadius: source === "paint" ? impulse.radius : undefined,
        color: source === "paint"
          ? { r: impulse.dyeR ?? 1, g: impulse.dyeG ?? 1, b: impulse.dyeB ?? 1 }
          : undefined,
        flow: motion,
        turbulence: source === "paint"
          ? energy * (0.55 + 0.45 * THREE.MathUtils.clamp((impulse.dye ?? 0) / 1.18, 0, 1))
          : foam
      });
    } else {
      waterInteractions.rejected++;
    }
    return accepted;
  };

  const queuePaintWater = (
    x: number,
    z: number,
    velocityX: number,
    velocityY: number,
    velocityZ: number,
    r: number,
    g: number,
    b: number
  ): boolean => {
    if (disposed || !awake || !inTeaGardenWater(x, z)) return false;
    const horizontalSpeed = Math.hypot(velocityX, velocityZ);
    const totalSpeed = Math.hypot(horizontalSpeed, velocityY);
    const energy = THREE.MathUtils.clamp(totalSpeed / 20, 0, 1);
    const directionScale = horizontalSpeed > 1e-4 ? 1 / horizontalSpeed : 0;
    queueInteraction("paint", {
      x,
      z,
      radius: 0.48 + energy * 0.34,
      strength: -(0.012 + energy * 0.024),
      velocityX: velocityX * directionScale * Math.min(1.35, horizontalSpeed * 0.045),
      velocityZ: velocityZ * directionScale * Math.min(1.35, horizontalSpeed * 0.045),
      foam: 0.035 + energy * 0.095,
      dyeR: r,
      dyeG: g,
      dyeB: b,
      dye: 0.72 + energy * 0.46
    });
    // The Tea Garden owns every paint/water response even if the bounded GPU
    // queue is saturated; never fall back to a decal on hidden terrain.
    return true;
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
        // A player wading through the coherent pond can release the ball with
        // its lower hemisphere already under the surface. There is no prior
        // sample to form a sign-changing crossing, so treat that first
        // downward in-water frame as the entry instead of silently losing it.
        if (currentInWater && surfaceDelta <= 0 && state.vy < -0.05) {
          const horizontalSpeed = Math.hypot(state.vx, state.vz);
          const totalSpeed = Math.hypot(horizontalSpeed, state.vy);
          queueInteraction("balls", {
            x: state.x,
            z: state.z,
            radius: THREE.MathUtils.clamp(0.75 + totalSpeed * 0.045, 0.75, 1.55),
            strength: -THREE.MathUtils.clamp(0.045 + Math.abs(state.vy) * 0.008, 0.045, 0.11),
            velocityX: THREE.MathUtils.clamp(state.vx * 0.32, -3.2, 3.2),
            velocityZ: THREE.MathUtils.clamp(state.vz * 0.32, -3.2, 3.2),
            foam: THREE.MathUtils.clamp(0.18 + totalSpeed * 0.028, 0.18, 0.55)
          });
          options.onBallWaterImpact?.(state.x, surface, state.z, totalSpeed);
        }
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
        // The magic zen river is the fey realm's water: voice the plonk + echo.
        options.onBallWaterImpact?.(impactX, water.surfaceY(impactX, impactZ), impactZ, totalSpeed);
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
    depth: number,
    tailStroke: number,
    tailSide: number
  ) => {
    if (depth > KOI_SURFACE_DEPTH || !inTeaGardenWater(x, z)) return;
    waterInteractions.surfaceKoi++;
    const track = koiWaterTracks.get(id);
    if (!track) {
      koiWaterTracks.set(id, { x, z, tailStroke });
      return;
    }
    track.x = x;
    track.z = z;
    if (track.tailStroke === tailStroke) return;
    track.tailStroke = tailStroke;
    if (koiUpdateTime < nextKoiWakeTime) {
      waterInteractions.koiCadenceLimited++;
      return;
    }
    const speed = Math.hypot(velocityX, velocityZ);
    const directionX = speed > 1e-4 ? velocityX / speed : 0;
    const directionZ = speed > 1e-4 ? velocityZ / speed : 0;
    const energy = THREE.MathUtils.clamp(speed / 1.2, 0, 1);
    let wakeX = x - directionX * 0.24 - directionZ * tailSide * 0.055;
    let wakeZ = z - directionZ * 0.24 + directionX * tailSide * 0.055;
    if (!inTeaGardenWater(wakeX, wakeZ)) {
      wakeX = x;
      wakeZ = z;
    }
    nextKoiWakeTime = koiUpdateTime + KOI_WAKE_MIN_INTERVAL;
    queueInteraction("koi", {
      x: wakeX,
      z: wakeZ,
      radius: 0.24 + energy * 0.06,
      strength: tailSide > 0 ? -(0.006 + energy * 0.003) : 0.004 + energy * 0.002,
      velocityX: velocityX * (0.38 + energy * 0.1),
      velocityZ: velocityZ * (0.38 + energy * 0.1),
      foam: 0.008 + energy * 0.004
    });
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
    nextKoiWakeTime = 0;
    ballWaterTracks.clear();
    koiWaterTracks.clear();
  };

  const syncOptionalDetailVisibility = (player?: TeaGardenPlayerPosition) => {
    const approaching = player
      ? Math.hypot(player.x - DRY_LANDSCAPE_CENTER.x, player.z - DRY_LANDSCAPE_CENTER.z) <= DRY_LANDSCAPE_REVEAL_DISTANCE
      : false;
    dryLandscape.group.visible = !optionalDetailsDeferred || optionalDetailsPrepared || approaching;
  };

  return {
    group,
    ready: Promise.all([architecture.ready, vegetation.ready]).then(() => undefined),
    async prepareEssential(prepare) {
      // WebGPU creates render pipelines asynchronously. Supplying independent
      // owners lets the driver compile architecture, water, foliage and Hiro
      // in parallel instead of serializing one monolithic scene traversal.
      await Promise.all([
        architecture.group,
        water.group,
        vegetation.group,
        guide.group
      ].filter((root) => root.visible).map(async (root) => {
        root.updateMatrixWorld(true);
        await prepare(root);
      }));
    },
    deferOptionalFoliage() {
      vegetation.deferTrees();
    },
    prepareOptionalFoliage(prepare) {
      return vegetation.prepareTrees(prepare);
    },
    deferOptionalDetails() {
      if (optionalDetailsPrepared) return;
      optionalDetailsDeferred = true;
      architecture.deferDistantDetails();
      syncOptionalDetailVisibility();
    },
    prepareOptionalDetails(prepare) {
      if (optionalDetailsPrepared) return Promise.resolve();
      if (optionalDetailsPreparation) return optionalDetailsPreparation;
      optionalDetailsPreparation = (async () => {
        await architecture.prepareDistantDetails(prepare);
        const parent = dryLandscape.group.parent;
        dryLandscape.group.removeFromParent();
        dryLandscape.group.visible = true;
        try {
          await prepare(dryLandscape.group);
        } finally {
          if (!disposed) parent?.add(dryLandscape.group);
          optionalDetailsPrepared = true;
          if (!disposed) syncOptionalDetailVisibility();
        }
      })();
      return optionalDetailsPreparation;
    },
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
      syncOptionalDetailVisibility(player);
      if (foliageVisible) vegetation.update(player);
      architecture.updateArt(player);
      architecture.updateDistantDetails(player);
      updatePlayerWaterInteraction(player, mode, velocity);
      updateBallWaterInteractions();
      waterInteractions.surfaceKoi = 0;
      koiUpdateTime = time;
      if (distanceToGarden <= WATER_ACTIVE_DISTANCE) {
        architecture.update(time, visitKoi);
        water.update(dt, time, player);
      }
      if (dryLandscape.group.visible) dryLandscape.update(dt, time, player, mode);
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
    isRaking(): boolean {
      return dryLandscape.isPlayerActive();
    },
    releaseForNavigation(): boolean {
      return dryLandscape.releaseForNavigation();
    },
    queueRakeStamp(stamp: SandRakeStamp): boolean {
      if (disposed) return false;
      dryLandscape.queueRakeStamp(stamp);
      return true;
    },
    resetSand() {
      if (!disposed) dryLandscape.resetSand();
    },
    containsWater(x: number, z: number): boolean {
      return inTeaGardenWater(x, z);
    },
    paintWater(impact: TeaGardenPaintWaterImpact): boolean {
      return queuePaintWater(
        impact.x,
        impact.z,
        impact.velocityX,
        impact.velocityY,
        impact.velocityZ,
        impact.r,
        impact.g,
        impact.b
      );
    },
    paintWaterSegment(segment: Readonly<PaintWaterSegment>): boolean {
      if (disposed || !awake) return false;
      const startSurface = water.surfaceY(segment.fromX, segment.fromZ);
      const endSurface = water.surfaceY(segment.toX, segment.toZ);
      const startWet = inTeaGardenWater(segment.fromX, segment.fromZ);
      const endWet = inTeaGardenWater(segment.toX, segment.toZ);
      const startDelta = segment.fromY - startSurface;
      const endDelta = segment.toY - endSurface;
      let crossingT = -1;

      if (startWet && startDelta <= 0) {
        crossingT = 0;
      } else if (startDelta > 0 && endDelta <= 0) {
        const candidate = THREE.MathUtils.clamp(startDelta / (startDelta - endDelta), 0, 1);
        const candidateX = THREE.MathUtils.lerp(segment.fromX, segment.toX, candidate);
        const candidateZ = THREE.MathUtils.lerp(segment.fromZ, segment.toZ, candidate);
        if (inTeaGardenWater(candidateX, candidateZ)) crossingT = candidate;
      }

      if (crossingT < 0 && endWet && endDelta <= 0) {
        // The step entered the horizontal mask after it was already beneath the
        // surface. Bisect the combined mask/height predicate so the response is
        // placed at the earliest wet point, not at the hidden terrain hit.
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) * 0.5;
          const x = THREE.MathUtils.lerp(segment.fromX, segment.toX, mid);
          const y = THREE.MathUtils.lerp(segment.fromY, segment.toY, mid);
          const z = THREE.MathUtils.lerp(segment.fromZ, segment.toZ, mid);
          if (inTeaGardenWater(x, z) && y <= water.surfaceY(x, z)) hi = mid;
          else lo = mid;
        }
        crossingT = hi;
      }

      if (crossingT < 0) return false;
      return queuePaintWater(
        THREE.MathUtils.lerp(segment.fromX, segment.toX, crossingT),
        THREE.MathUtils.lerp(segment.fromZ, segment.toZ, crossingT),
        segment.velocityX,
        segment.velocityY,
        segment.velocityZ,
        segment.r,
        segment.g,
        segment.b
      );
    },
    tuningDescriptor() {
      return {
        id: "japanese-tea-garden-simulations",
        title: "Japanese Tea Garden · GPU simulations",
        build(folder) {
          const flowingWater = folder.addFolder({ title: "flowing water", expanded: false });
          const sand = folder.addFolder({ title: "raked sand", expanded: false });
          const sound = folder.addFolder({ title: "stream sound", expanded: false });
          TEA_GARDEN_STREAM_AUDIO_TUNING.bind(sound);
          const rakeSound = folder.addFolder({ title: "rake sound", expanded: false });
          TEA_GARDEN_RAKE_AUDIO_TUNING.bind(rakeSound);
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
        koi: {
          total: architecture.stats.koi,
          insideWater: architecture.stats.koiInWater,
          submerged: architecture.stats.koiSubmerged,
          minSubmersion: architecture.stats.koiMinSubmersion,
          tailStrokes: architecture.stats.koiTailStrokes,
          wakeImpulses: waterInteractions.koi,
          cadenceLimited: waterInteractions.koiCadenceLimited
        },
        streamAudio: streamAudio.debugState,
        dryLandscape: dryLandscape.debugState(),
        guide: guide.debugState()
      };
    }
  };
}
