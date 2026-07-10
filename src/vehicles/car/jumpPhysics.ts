/**
 * CPU-side jump helpers for the arcade car. Kept independent from Three/Box3D so
 * the transition hysteresis and attitude controller can be regression-tested
 * without booting the renderer.
 */

export type Vec3Like = readonly [number, number, number] | readonly number[];
export type MutableVec3 = [number, number, number];

export type JumpTransition = "none" | "takeoff" | "landing";

export type JumpStateParams = {
  takeoffClearance: number;
  takeoffMinVerticalSpeed: number;
  minimumAirTime: number;
  landingClearance: number;
  landingMaxVerticalSpeed: number;
  landingMaxFallSpeed: number;
  landingConfirmSteps: number;
};

export type JumpSample = {
  /** Chassis centre above the current ride/suspension target, in metres. */
  supportClearance: number;
  verticalSpeed: number;
  yaw: number;
};

/**
 * A jump is an event, not a height predicate. Once takeoff commits, ramp seams
 * cannot re-enable road grip/tilt until a descending car has stayed near support
 * for a few consecutive fixed steps.
 */
export class CarJumpState {
  airborne = false;
  airTime = 0;
  launchYaw = 0;
  landingSteps = 0;
  readyForTakeoff = false;

  reset(facing = 0): void {
    this.airborne = false;
    this.airTime = 0;
    this.launchYaw = facing;
    this.landingSteps = 0;
    // A newly spawned car starts above its ride target. It must settle onto the
    // suspension once before that spawn drop can ever count as a jump.
    this.readyForTakeoff = false;
  }

  forceAir(yaw: number): void {
    if (this.airborne) return;
    this.airborne = true;
    this.airTime = 0;
    this.launchYaw = yaw;
    this.landingSteps = 0;
  }

  update(sample: JumpSample, dt: number, p: JumpStateParams): JumpTransition {
    if (!this.airborne) {
      if (sample.supportClearance <= p.landingClearance) this.readyForTakeoff = true;
      if (!this.readyForTakeoff) return "none";
      const departed =
        sample.supportClearance >= p.takeoffClearance &&
        Math.abs(sample.verticalSpeed) >= p.takeoffMinVerticalSpeed;
      if (!departed) return "none";
      this.forceAir(sample.yaw);
      return "takeoff";
    }

    this.airTime += dt;
    const landingCandidate =
      this.airTime >= p.minimumAirTime &&
      sample.verticalSpeed <= p.landingMaxVerticalSpeed &&
      sample.verticalSpeed >= -p.landingMaxFallSpeed &&
      sample.supportClearance <= p.landingClearance;
    this.landingSteps = landingCandidate ? this.landingSteps + 1 : 0;
    if (this.landingSteps < p.landingConfirmSteps) return "none";

    this.airborne = false;
    this.airTime = 0;
    this.landingSteps = 0;
    this.readyForTakeoff = true;
    return "landing";
  }
}

export type AirAttitudeParams = {
  /** Proportional attitude gain, in s^-2. */
  kp: number;
  /** Angular damping gain, in s^-1; 2*sqrt(kp) is critically damped. */
  kd: number;
  maxAcceleration: number;
  yawDamping: number;
  yawAcceleration: number;
};

/**
 * Dimensionally-correct airborne PD assist. Unlike the old controller, every
 * angular-acceleration term is integrated with dt. It levels pitch/roll toward
 * targetUp, gently damps yaw spin, and permits subtle A/D yaw control.
 */
export function stepAirAttitude(
  currentUp: Vec3Like,
  targetUp: Vec3Like,
  angular: Vec3Like,
  steer: number,
  assist: number,
  dt: number,
  p: AirAttitudeParams,
  out: MutableVec3
): MutableVec3 {
  const tx0 = targetUp[0];
  const ty0 = targetUp[1];
  const tz0 = targetUp[2];
  const targetLen = Math.hypot(tx0, ty0, tz0) || 1;
  const tx = tx0 / targetLen;
  const ty = ty0 / targetLen;
  const tz = tz0 / targetLen;

  // World-space shortest tilt error: currentUp × targetUp.
  const ex = currentUp[1] * tz - currentUp[2] * ty;
  const ey = currentUp[2] * tx - currentUp[0] * tz;
  const ez = currentUp[0] * ty - currentUp[1] * tx;

  const wx = angular[0];
  const wy = angular[1];
  const wz = angular[2];
  const yawRate = wx * tx + wy * ty + wz * tz;
  const tiltX = wx - tx * yawRate;
  const tiltY = wy - ty * yawRate;
  const tiltZ = wz - tz * yawRate;

  const a = Math.max(0, Math.min(1, assist));
  // sqrt keeps the damping ratio approximately constant while the assist fades
  // in after takeoff (kp scales with a, critical kd scales with sqrt(a)).
  const dampScale = Math.sqrt(a);
  let ax = ex * p.kp * a - tiltX * p.kd * dampScale;
  let ay = ey * p.kp * a - tiltY * p.kd * dampScale;
  let az = ez * p.kp * a - tiltZ * p.kd * dampScale;

  const yawAccel = (steer * p.yawAcceleration - yawRate * p.yawDamping) * a;
  ax += tx * yawAccel;
  ay += ty * yawAccel;
  az += tz * yawAccel;

  const accel = Math.hypot(ax, ay, az);
  if (accel > p.maxAcceleration && accel > 0) {
    const s = p.maxAcceleration / accel;
    ax *= s;
    ay *= s;
    az *= s;
  }

  // Never hard-clamp the existing spin: that would bypass maxAcceleration and
  // visibly snap a wild launch in one frame. The bounded PD damping bleeds it
  // down over time, so |delta omega| can never exceed maxAcceleration * dt.
  out[0] = wx + ax * dt;
  out[1] = wy + ay * dt;
  out[2] = wz + az * dt;
  return out;
}

export function smoothstep01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}
