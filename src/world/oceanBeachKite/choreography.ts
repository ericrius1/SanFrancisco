import * as THREE from "three/webgpu";

/**
 * What the flyer is doing right now. The five names the acceptance probe keys
 * off ("launch", "reel out", "slow down", "reel in", "sprint") are load-bearing
 * and must keep their meaning; the rest are the figures that turn a shuttle run
 * into a dance.
 */
export type KiteFigureName =
  | "launch"
  | "soar"
  | "reel out"
  | "carve"
  | "sprint"
  | "cruise"
  | "figure eight"
  | "slow down"
  | "reel in"
  | "spin"
  | "stroll";

export type KiteFigure = {
  name: KiteFigureName;
  seconds: number;
  /** 0..1, blended between the slow and fast run speeds. */
  speed: number;
  /** Signed ground turn rate, in multiples of the tuned base turn rate. */
  turn: number;
  /** Reverse `turn` at the halfway mark — the crossover of a figure eight. */
  alternate?: boolean;
  /** Deliberate steering the flyer hands to the kite's wind window. */
  steer?: number;
  /** A two-handed haul at the top of the figure; loads the line and the kite. */
  tug?: number;
  /** 0..1 — eyes and chest on the kite rather than on the sand ahead. */
  watch: number;
  /** Normalized target line length; only figures that reel may set it. */
  line?: number;
  reel: -1 | 0 | 1;
};

/**
 * One legible arc rather than a shuffle: arrive mid-launch, watch it settle,
 * pay line out, carve a slow circle under it, chase it down the beach, work it
 * through a figure eight, then haul it back in and walk it out again.
 *
 * The ordering is timed as much as choreographed — the probe drives 50 s of
 * deterministic frames and needs every reel/speed figure inside that window.
 */
export const KITE_FIGURES: readonly KiteFigure[] = [
  { name: "launch", seconds: 6, speed: 1, turn: 0.12, watch: 0.85, tug: 1, line: 0.22, reel: 1 },
  { name: "soar", seconds: 3.4, speed: 0.08, turn: 0.18, alternate: true, watch: 1, reel: 0 },
  { name: "reel out", seconds: 5, speed: 0.62, turn: -0.3, watch: 0.7, line: 1, reel: 1 },
  { name: "carve", seconds: 7, speed: 0.66, turn: 1, steer: 0.5, watch: 0.55, tug: 0.4, reel: 0 },
  { name: "sprint", seconds: 4.2, speed: 1, turn: -0.16, steer: -0.35, watch: 0.35, reel: 0 },
  { name: "cruise", seconds: 3.4, speed: 0.5, turn: 0.28, watch: 0.75, reel: 0 },
  { name: "figure eight", seconds: 6.6, speed: 0.72, turn: 0.92, alternate: true, steer: 0.8, watch: 0.5, tug: 0.7, reel: 0 },
  { name: "slow down", seconds: 3.2, speed: 0.04, turn: -0.22, watch: 1, reel: 0 },
  { name: "reel in", seconds: 5.4, speed: 0.3, turn: 0.34, watch: 0.95, tug: 0.9, line: 0.3, reel: -1 },
  { name: "spin", seconds: 3, speed: 0.06, turn: -2.1, steer: -0.9, watch: 0.9, tug: 0.5, reel: 0 },
  { name: "stroll", seconds: 4.4, speed: 0.3, turn: 0.2, alternate: true, watch: 0.8, reel: 0 }
];

/**
 * The launch is the arrival vignette. The ambient loop restarts at "reel out"
 * so an already-airborne kite never periodically dives back to the sand.
 */
export const KITE_LOOP_START = 2;

/** Ground state the rig, the reel and the wind window all read. */
export type GroundRunnerState = {
  x: number;
  z: number;
  /** Rig yaw — the flyer faces local -Z, so forward is (-sin yaw, -cos yaw). */
  yaw: number;
  speed: number;
  /** Signed rad/s actually turned this frame, after boundary steering. */
  turnRate: number;
  /** -1..1 body roll into the turn. */
  lean: number;
  vx: number;
  vz: number;
};

export type GroundRunnerCommand = {
  /** Metres per second the figure wants. */
  speed: number;
  /** Signed rad/s the figure wants. */
  turn: number;
  /** Along-shore half-extent of the playable sand. */
  halfSpan: number;
  /** Cross-shore depth of dry sand available east of the waterline. */
  beachDepth: number;
  /** Acceleration response, higher for the explosive figures. */
  response: number;
};

const TWO_PI = Math.PI * 2;

function wrapAngle(value: number): number {
  let delta = value;
  while (delta > Math.PI) delta -= TWO_PI;
  while (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * The flyer runs a free 2D path on the sand instead of shuttling along one
 * line, which is what lets a figure be a circle, a spin or a crossover. Nothing
 * here bounces off a wall: as the runner nears the edge of the usable beach the
 * figure's own turn rate is blended toward an inward heading, so leaving the
 * dry sand reads as "they curved back" rather than "they hit something".
 */
export function createGroundRunner(opts: {
  site: { x: number; z: number };
  /** Waterline-relative eastern edge of dry sand for a given z. */
  beachX: (z: number) => number;
  start: { x: number; z: number; yaw: number };
}): {
  state: GroundRunnerState;
  update(dt: number, command: GroundRunnerCommand): void;
} {
  const { site, beachX } = opts;
  const state: GroundRunnerState = {
    x: opts.start.x,
    z: opts.start.z,
    yaw: opts.start.yaw,
    speed: 0,
    turnRate: 0,
    lean: 0,
    vx: 0,
    vz: 0
  };

  return {
    state,
    update(dt, command) {
      const speedResponse = 1 - Math.exp(-dt * command.response);
      state.speed += (command.speed - state.speed) * speedResponse;

      // How far outside the comfortable middle of the beach we are, and which
      // way is back. Along-shore and cross-shore urgencies combine into one
      // inward heading so a corner pulls diagonally instead of fighting itself.
      const alongOffset = (state.z - site.z) / Math.max(1, command.halfSpan);
      const alongUrgency = smoothstep(0.58, 0.96, Math.abs(alongOffset));
      const crossLocal = state.x - beachX(state.z);
      const crossLow = smoothstep(2.5, 0.2, crossLocal);
      const crossHigh = smoothstep(command.beachDepth - 4, command.beachDepth, crossLocal);
      const inwardX = crossLow - crossHigh;
      const inwardZ = -Math.sign(alongOffset) * alongUrgency;
      const urgency = THREE.MathUtils.clamp(
        Math.max(alongUrgency, Math.max(crossLow, crossHigh)),
        0,
        1
      );

      let turn = command.turn;
      if (urgency > 0.001 && (inwardX !== 0 || inwardZ !== 0)) {
        const inwardYaw = Math.atan2(-inwardX, -inwardZ);
        const toInward = wrapAngle(inwardYaw - state.yaw);
        // Steering gain rises with urgency AND with how badly we are pointed
        // the wrong way; a runner already curving inland is left alone.
        const correction = toInward * (1.6 + urgency * 2.4) * urgency;
        turn = THREE.MathUtils.lerp(turn, correction, urgency * 0.85);
      }

      // A person cannot pivot at speed. Cap the turn by what the current
      // ground speed can carry, which is what makes a sprint arc wide and a
      // near-stopped spin tight.
      const turnCeiling = 2.6 / (1 + state.speed * 0.42);
      turn = THREE.MathUtils.clamp(turn, -turnCeiling, turnCeiling);
      state.turnRate += (turn - state.turnRate) * (1 - Math.exp(-dt * 5.5));
      state.yaw += state.turnRate * dt;
      if (state.yaw > Math.PI) state.yaw -= TWO_PI;
      else if (state.yaw < -Math.PI) state.yaw += TWO_PI;

      const forwardX = -Math.sin(state.yaw);
      const forwardZ = -Math.cos(state.yaw);
      state.vx = forwardX * state.speed;
      state.vz = forwardZ * state.speed;
      state.x += state.vx * dt;
      state.z += state.vz * dt;

      // Lean is centripetal: it needs both the turn and the speed to carry it.
      const targetLean = THREE.MathUtils.clamp(state.turnRate * state.speed * 0.13, -0.32, 0.32);
      state.lean += (targetLean - state.lean) * (1 - Math.exp(-dt * 4.5));
    }
  };
}
