import * as THREE from "three/webgpu";
import { isInsideSutroPool, poolWaterY, type SutroWaterImpulse } from "./waterSimulation";

/**
 * Gameplay injectors for the shared Sutro Baths shallow-water field.
 *
 * Nothing here touches the GPU directly: it samples the flat authored pool
 * surface on the CPU (via {@link poolWaterY}) and turns the local wader, thrown
 * balls, and remote bathers into bounded {@link SutroWaterImpulse}s. The water
 * simulation owns validation, clamping, and the zero-net-volume Mexican-hat
 * kernel — this module only decides *when* and *where* a wake should appear.
 *
 * The steady state allocates nothing: per-ball tracks live in a reused Map and
 * are mutated in place; every other value is a scalar on the closure.
 */

/** Minimal slice of the water simulation this module drives. */
export type SutroWaterInteractionsTarget = {
  queueImpulse(impulse: SutroWaterImpulse): boolean;
};

/** Free-ball world snapshot, matching `gameplay/fetchBall` FetchBallWorldState. */
export type SutroBallWorldState = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly grounded?: boolean;
};

/** Boot-resident ball roster, visited only while this feature is awake. */
export type SutroBallSource = {
  visitFreeBalls(
    visitor: (id: number, state: SutroBallWorldState, radius: number) => void
  ): void;
};

/** A remote bather. Velocity is optional; without it we cannot know motion. */
export type SutroRemoteState = {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vz?: number;
};

export type SutroWaterInteractionsOptions = {
  water: SutroWaterInteractionsTarget;
  /** Free balls (e.g. `fetchBall.visitFreeBalls`); omit to skip ball wakes. */
  ballSource?: SutroBallSource;
  /** Live remote bathers; omit to skip remote wakes. Should be cheap to call. */
  getRemotes?: () => Iterable<SutroRemoteState>;
};

export type SutroWaterInteractionsUpdateContext = {
  dt: number;
  player: {
    position: { x: number; y: number; z: number };
    velocity?: { x: number; y: number; z: number };
  };
};

export type SutroWaterInteractions = {
  update(ctx: SutroWaterInteractionsUpdateContext): void;
  readonly stats: SutroWaterInteractionsStats;
};

export type SutroWaterInteractionsStats = {
  playerInWater: boolean;
  playerWakes: number;
  ballWakes: number;
  remoteWakes: number;
  trackedBalls: number;
};

// The player center rides ~0.9m above the feet, matching the tea-garden wader.
const PLAYER_FOOT_BELOW_CENTER = 0.9;
// A wader counts as in the pool when the feet sit within this band of the flat
// surface: a touch above (splashing in) to roughly waist/chest submersion.
const WADE_BAND_ABOVE = 0.3;
const WADE_BAND_BELOW = 1.2;
const PLAYER_STEP_DISTANCE = 0.44;
const PLAYER_FOOT_SPREAD = 0.18;
const PLAYER_MAX_INTERACTION_SPEED = 9;
const REMOTE_WADE_BAND_ABOVE = 0.35;
const REMOTE_WADE_BAND_BELOW = 1.3;
const REMOTE_MIN_SPEED = 0.4;
const REMOTE_EMIT_INTERVAL = 0.12;
const MAX_REMOTE_WAKES = 12;

type BallWaterTrack = {
  x: number;
  z: number;
  surfaceDelta: number;
  inWater: boolean;
  lastWakeX: number;
  lastWakeZ: number;
  seenFrame: number;
};

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : fallback;
}

export function createSutroWaterInteractions(
  options: SutroWaterInteractionsOptions
): SutroWaterInteractions {
  const { water } = options;

  const stats: SutroWaterInteractionsStats = {
    playerInWater: false,
    playerWakes: 0,
    ballWakes: 0,
    remoteWakes: 0,
    trackedBalls: 0
  };

  // Local wader tracking.
  let playerTrackValid = false;
  let playerWasInWater = false;
  let playerLastX = 0;
  let playerLastZ = 0;
  let playerStepTravel = 0;
  let playerFootSide = 1;

  // Ball tracking. One track object per live ball, reused across frames.
  const ballTracks = new Map<number, BallWaterTrack>();
  let interactionFrame = 0;

  // Remote throttle so a crowd of moving bathers cannot flood the impulse queue.
  let remoteEmitTimer = 0;

  const updatePlayer = (ctx: SutroWaterInteractionsUpdateContext) => {
    const { position, velocity } = ctx.player;
    const surface = poolWaterY(position.x, position.z);
    const inPool = Number.isFinite(surface);
    const footY = position.y - PLAYER_FOOT_BELOW_CENTER;
    const inWater =
      inPool &&
      footY <= surface + WADE_BAND_ABOVE &&
      footY >= surface - WADE_BAND_BELOW;
    stats.playerInWater = inWater;

    if (!playerTrackValid) {
      playerTrackValid = true;
      playerLastX = position.x;
      playerLastZ = position.z;
      playerWasInWater = inWater;
      return;
    }

    const dx = position.x - playerLastX;
    const dz = position.z - playerLastZ;
    const travel = Math.hypot(dx, dz);
    const velocitySpeed = Math.min(
      PLAYER_MAX_INTERACTION_SPEED,
      Math.hypot(velocity?.x ?? 0, velocity?.z ?? 0)
    );
    const useVelocity = velocitySpeed > 0.08;
    const directionLength = useVelocity ? velocitySpeed : travel;
    const directionX =
      directionLength > 1e-4 ? (useVelocity ? velocity!.x : dx) / directionLength : 0;
    const directionZ =
      directionLength > 1e-4 ? (useVelocity ? velocity!.z : dz) / directionLength : 0;

    if (inWater && !playerWasInWater) {
      if (
        water.queueImpulse({
          x: position.x,
          z: position.z,
          radius: 0.72,
          strength: -0.024,
          velocityX: directionX * velocitySpeed * 0.24,
          velocityZ: directionZ * velocitySpeed * 0.24,
          foam: 0.06
        })
      ) {
        stats.playerWakes++;
      }
      playerStepTravel = 0;
    }

    if (inWater && travel < 3) {
      playerStepTravel += travel;
      let emitted = 0;
      while (playerStepTravel >= PLAYER_STEP_DISTANCE && emitted < 3) {
        playerStepTravel -= PLAYER_STEP_DISTANCE;
        const sideX = -directionZ * PLAYER_FOOT_SPREAD * playerFootSide;
        const sideZ = directionX * PLAYER_FOOT_SPREAD * playerFootSide;
        if (
          water.queueImpulse({
            x: position.x - directionX * 0.14 + sideX,
            z: position.z - directionZ * 0.14 + sideZ,
            radius: 0.38 + Math.min(0.18, velocitySpeed * 0.018),
            strength: -(0.014 + Math.min(0.018, velocitySpeed * 0.0024)),
            velocityX: directionX * velocitySpeed * 0.22,
            velocityZ: directionZ * velocitySpeed * 0.22,
            foam: 0.035 + Math.min(0.06, velocitySpeed * 0.006)
          })
        ) {
          stats.playerWakes++;
        }
        playerFootSide *= -1;
        emitted++;
      }
    } else if (!inWater) {
      playerStepTravel = 0;
    }

    if (!inWater && playerWasInWater) {
      if (
        water.queueImpulse({
          x: playerLastX,
          z: playerLastZ,
          radius: 0.54,
          strength: -0.012,
          velocityX: directionX * velocitySpeed * 0.12,
          velocityZ: directionZ * velocitySpeed * 0.12,
          foam: 0.025
        })
      ) {
        stats.playerWakes++;
      }
    }

    playerLastX = position.x;
    playerLastZ = position.z;
    playerWasInWater = inWater;
  };

  const updateBalls = () => {
    const source = options.ballSource;
    if (!source) {
      stats.trackedBalls = 0;
      return;
    }
    interactionFrame++;
    let tracked = 0;
    source.visitFreeBalls((id, state, radius) => {
      tracked++;
      const surface = poolWaterY(state.x, state.z);
      const inPool = Number.isFinite(surface);
      // Signed clearance of the ball's underside above the flat pool surface.
      const surfaceDelta = inPool ? state.y - radius - surface : Number.POSITIVE_INFINITY;
      const track = ballTracks.get(id);
      if (!track) {
        ballTracks.set(id, {
          x: state.x,
          z: state.z,
          surfaceDelta,
          inWater: inPool,
          lastWakeX: state.x,
          lastWakeZ: state.z,
          seenFrame: interactionFrame
        });
        return;
      }

      const denominator = track.surfaceDelta - surfaceDelta;
      const crossingT = denominator > 1e-5 ? track.surfaceDelta / denominator : -1;
      const crossedSurface =
        track.surfaceDelta > 0 && surfaceDelta <= 0 && crossingT >= 0 && crossingT <= 1;
      const impactX = crossedSurface
        ? THREE.MathUtils.lerp(track.x, state.x, crossingT)
        : state.x;
      const impactZ = crossedSurface
        ? THREE.MathUtils.lerp(track.z, state.z, crossingT)
        : state.z;
      const impactInPool = isInsideSutroPool(impactX, impactZ);
      const horizontalSpeed = Math.hypot(state.vx, state.vz);
      const totalSpeed = Math.hypot(horizontalSpeed, state.vy);

      if (crossedSurface && impactInPool && state.vy < -0.05) {
        if (
          water.queueImpulse({
            x: impactX,
            z: impactZ,
            radius: THREE.MathUtils.clamp(0.75 + totalSpeed * 0.045, 0.75, 1.55),
            strength: -THREE.MathUtils.clamp(0.045 + Math.abs(state.vy) * 0.008, 0.045, 0.11),
            velocityX: THREE.MathUtils.clamp(state.vx * 0.32, -3.2, 3.2),
            velocityZ: THREE.MathUtils.clamp(state.vz * 0.32, -3.2, 3.2),
            foam: THREE.MathUtils.clamp(0.18 + totalSpeed * 0.028, 0.18, 0.55)
          })
        ) {
          stats.ballWakes++;
        }
        track.lastWakeX = impactX;
        track.lastWakeZ = impactZ;
      } else if (inPool && surfaceDelta <= 0.04 && horizontalSpeed > 0.22) {
        // A ball skimming near the surface leaves a light travelling wake,
        // spaced by distance so a fast roll does not spam the queue.
        const wakeTravel = Math.hypot(state.x - track.lastWakeX, state.z - track.lastWakeZ);
        if (wakeTravel >= Math.max(0.32, radius * 2.2)) {
          if (
            water.queueImpulse({
              x: state.x,
              z: state.z,
              radius: 0.34 + Math.min(0.24, horizontalSpeed * 0.025),
              strength: -0.009,
              velocityX: THREE.MathUtils.clamp(state.vx * 0.28, -2.4, 2.4),
              velocityZ: THREE.MathUtils.clamp(state.vz * 0.28, -2.4, 2.4),
              foam: 0.045
            })
          ) {
            stats.ballWakes++;
          }
          track.lastWakeX = state.x;
          track.lastWakeZ = state.z;
        }
      }

      track.x = state.x;
      track.z = state.z;
      track.surfaceDelta = surfaceDelta;
      track.inWater = inPool;
      track.seenFrame = interactionFrame;
    });

    for (const [id, track] of ballTracks) {
      if (track.seenFrame !== interactionFrame) ballTracks.delete(id);
    }
    stats.trackedBalls = tracked;
  };

  const updateRemotes = (dt: number) => {
    const getRemotes = options.getRemotes;
    if (!getRemotes) return;
    remoteEmitTimer -= dt;
    if (remoteEmitTimer > 0) return;
    remoteEmitTimer = REMOTE_EMIT_INTERVAL;

    let emitted = 0;
    for (const remote of getRemotes()) {
      if (emitted >= MAX_REMOTE_WAKES) break;
      const vx = remote.vx ?? 0;
      const vz = remote.vz ?? 0;
      const speed = Math.hypot(vx, vz);
      if (speed < REMOTE_MIN_SPEED) continue;
      const surface = poolWaterY(remote.x, remote.z);
      if (!Number.isFinite(surface)) continue;
      const footY = remote.y - PLAYER_FOOT_BELOW_CENTER;
      if (footY > surface + REMOTE_WADE_BAND_ABOVE || footY < surface - REMOTE_WADE_BAND_BELOW) {
        continue;
      }
      const clampedSpeed = Math.min(PLAYER_MAX_INTERACTION_SPEED, speed);
      const invSpeed = 1 / Math.max(speed, 1e-4);
      if (
        water.queueImpulse({
          x: remote.x,
          z: remote.z,
          radius: 0.42 + Math.min(0.2, clampedSpeed * 0.02),
          strength: -0.01,
          velocityX: clampFinite(vx, -PLAYER_MAX_INTERACTION_SPEED, PLAYER_MAX_INTERACTION_SPEED, 0) *
            invSpeed *
            clampedSpeed *
            0.18,
          velocityZ: clampFinite(vz, -PLAYER_MAX_INTERACTION_SPEED, PLAYER_MAX_INTERACTION_SPEED, 0) *
            invSpeed *
            clampedSpeed *
            0.18,
          foam: 0.03
        })
      ) {
        stats.remoteWakes++;
        emitted++;
      }
    }
  };

  const update = (ctx: SutroWaterInteractionsUpdateContext) => {
    const dt = Number.isFinite(ctx.dt) ? Math.max(0, ctx.dt) : 0;
    updatePlayer(ctx);
    updateBalls();
    updateRemotes(dt);
  };

  return { update, stats };
}
