// Shared kinematic ball sim for Corona Heights — one pure module so the park's
// autonomous ball and the player's thrown ball roll and bounce with the SAME
// feel. Extracted verbatim from CoronaHeightsPark's old #stepBall/#collideBallFence:
// ballistic flight, restitution bounces, then woodchip rolling with a terrain
// downhill drift, plus fence push-out+reflect when the caller supplies segments.
//
// Substepped at 1/90 so a frame hitch can't tunnel a fast ball through the fence:
// 1/90 keeps a ≤22 m/s throw under one ball radius per step. Callers must keep
// their launch speed under that ceiling or the ball can skip the rail.

import type { FenceSegment2D } from "./dogParkFence";

const FENCE_PAD = 0.1; // fence rail half-thickness for ball rebounds

export interface BallSimState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
}

/** Optional per-call impact report so callers can voice ground contacts. */
export interface BallStepImpact {
  /** Peak downward contact speed (m/s) of the hardest ground hit this call. */
  groundSpeed: number;
}

export interface BallSimCtx {
  /** Caller supplies map.groundTop; the sim never touches the world directly. */
  groundTop(x: number, z: number): number;
  /** DOG_SURFACE_LIFT (0.04) inside the park woodchips, 0 on open terrain. */
  lift: number;
  /** BALL_R (0.16). */
  radius: number;
  // Fence rebound is opt-in: omit segs to get pure terrain roll (no rebound).
  segs?: FenceSegment2D[];
  segTop?: Float64Array;
  fenceTopMax?: number;
}

/** Advance the ball one frame (mutates `state` in place). g = -9.8, restitution
 *  0.55, woodchip friction 1.6, terrain-gradient drift 4.9, fence reflect 1.6·vn. */
export function stepBall(state: BallSimState, ctx: BallSimCtx, dt: number, impact?: BallStepImpact): void {
  const { lift, radius } = ctx;
  if (impact) impact.groundSpeed = 0;
  let remaining = Math.min(dt, 0.1);
  while (remaining > 1e-5) {
    const h = Math.min(remaining, 1 / 90);
    remaining -= h;
    if (!state.grounded) {
      state.vy -= 9.8 * h;
      state.x += state.vx * h;
      state.y += state.vy * h;
      state.z += state.vz * h;
      const gy = ctx.groundTop(state.x, state.z) + lift + radius;
      if (state.y <= gy && state.vy < 0) {
        state.y = gy;
        if (impact) impact.groundSpeed = Math.max(impact.groundSpeed, -state.vy);
        state.vy = -state.vy * 0.55;
        state.vx *= 0.85;
        state.vz *= 0.85;
        if (state.vy < 1.5) {
          state.vy = 0;
          state.grounded = true;
        }
      }
    } else {
      const speed = Math.hypot(state.vx, state.vz);
      if (speed > 1e-4) {
        const k = Math.max(0, speed - 1.6 * h) / speed; // woodchip friction
        state.vx *= k;
        state.vz *= k;
      }
      const gx = (ctx.groundTop(state.x + 0.6, state.z) - ctx.groundTop(state.x - 0.6, state.z)) / 1.2;
      const gz = (ctx.groundTop(state.x, state.z + 0.6) - ctx.groundTop(state.x, state.z - 0.6)) / 1.2;
      state.vx -= 4.9 * gx * h;
      state.vz -= 4.9 * gz * h;
      state.x += state.vx * h;
      state.z += state.vz * h;
      state.y = ctx.groundTop(state.x, state.z) + lift + radius;
    }
    if (ctx.segs && ctx.segTop) collideBallFence(state, ctx.segs, ctx.segTop, ctx.fenceTopMax, radius);
  }
}

function collideBallFence(
  state: BallSimState,
  segs: FenceSegment2D[],
  segTop: Float64Array,
  fenceTopMax: number | undefined,
  radius: number
): void {
  if (fenceTopMax !== undefined && state.y > fenceTopMax) return;
  const rad = radius + FENCE_PAD;
  // two sequential passes settle corner hits without a solver
  for (let iter = 0; iter < 2; iter++) {
    let hit = false;
    for (let i = 0; i < segs.length; i++) {
      if (state.y > segTop[i]) continue;
      const seg = segs[i];
      const ex = seg.bx - seg.ax;
      const ez = seg.bz - seg.az;
      const t = clamp01(((state.x - seg.ax) * ex + (state.z - seg.az) * ez) / (ex * ex + ez * ez));
      const cx = seg.ax + ex * t;
      const cz = seg.az + ez * t;
      let nx = state.x - cx;
      let nz = state.z - cz;
      const d = Math.hypot(nx, nz);
      if (d >= rad) continue;
      if (d > 1e-4 && nx * seg.nx + nz * seg.nz > 0) {
        nx /= d;
        nz /= d;
      } else {
        // tunnelled past the line: recover along the inward normal
        nx = seg.nx;
        nz = seg.nz;
      }
      state.x = cx + nx * rad;
      state.z = cz + nz * rad;
      const vn = state.vx * nx + state.vz * nz;
      if (vn < 0) {
        state.vx -= 1.6 * vn * nx;
        state.vz -= 1.6 * vn * nz;
      }
      hit = true;
    }
    if (!hit) break;
  }
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}
