/**
 * The shared "body + brain wiring" for an active-ragdoll quadruped, two-segment
 * legs (thigh + shank + actuated knee) so the foot actually lifts during swing
 * and bears load through stance — a real stepping gait, not a shuffle.
 *
 * Imported by BOTH the Node trainer (`rl/`) and the browser game, so — like
 * policy.ts — it stays dependency-free (no `three`, no box3d, no relative
 * imports). It knows nothing about a physics engine: the caller feeds it link
 * transforms/velocities as plain arrays and gets back an observation vector and
 * a list of joint torques to apply.
 *
 * Actuation (validated against box3d): capsule bones held by rigid spherical
 * joints; hips and knees driven by PD torque toward a Central-Pattern-Generator
 * gait that the policy modulates. The CPG supplies the walking rhythm, so ES
 * only learns to shape and balance it — cheap to train, natural to watch.
 */

// ------------------------------------------------------------------ quat math
// box3d quaternion order is [x, y, z, w].
export type V3 = [number, number, number];
export type Quat = [number, number, number, number];

export function qRot(q: Quat, v: V3, out: V3 = [0, 0, 0]): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  out[0] = v[0] + w * tx + (y * tz - z * ty);
  out[1] = v[1] + w * ty + (z * tx - x * tz);
  out[2] = v[2] + w * tz + (x * ty - y * tx);
  return out;
}
export function qRotInv(q: Quat, v: V3, out: V3 = [0, 0, 0]): V3 {
  return qRot([-q[0], -q[1], -q[2], q[3]], v, out);
}
const qConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
function qMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}
/** quaternion from a unit axis and angle. */
function qAxis(axis: V3, angle: number): Quat {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

// -------------------------------------------------------------- creature spec
export type SegSpec = { halfHeight: number; radius: number; density: number };
export type LegSpec = {
  /** hip offset in torso-local space (x = right, y = up, z = forward). */
  hip: V3;
  thigh: SegSpec;
  shank: SegSpec;
  /** gait phase offset (radians) — the walk sequence. */
  phase: number;
};

export type CreatureSpec = {
  name: string;
  torso: { half: V3; density: number };
  legs: LegSpec[];
  standHeight: number;
  cpg: { baseFreq: number; hipAmp: number; kneeAmp: number; kneeRest: number; kneeLag: number };
  pd: { hipKp: number; hipKd: number; latKp: number; latKd: number; kneeKp: number; kneeKd: number; maxTorque: number; reaction: number };
  reward: { forward: number; upright: number; alive: number; height: number; energy: number; spin: number; heading: number };
  fall: { minUp: number; minHeight: number };
};

// A horse, sim-scaled. Torso box (unambiguous body axes) + four two-segment
// capsule legs. Lateral-sequence WALK (HL -> FL -> HR -> FR, a quarter cycle
// apart) keeps three feet down: easy for a fresh policy to balance.
function leg(hip: V3, phase: number): LegSpec {
  return {
    hip,
    thigh: { halfHeight: 0.16, radius: 0.09, density: 250 }, // longer legs: taller stance, room to bound
    shank: { halfHeight: 0.16, radius: 0.075, density: 230 },
    phase
  };
}
export const HORSE: CreatureSpec = {
  name: "horse",
  torso: { half: [0.22, 0.13, 0.52], density: 120 },
  legs: [
    leg([-0.2, -0.07, 0.42], Math.PI * 0.5), // FL
    leg([0.2, -0.07, 0.42], Math.PI * 1.5), // FR
    leg([-0.2, -0.07, -0.42], 0), // HL
    leg([0.2, -0.07, -0.42], Math.PI) // HR
  ],
  standHeight: 0.72,
  // faster base rhythm + bigger stride so a run/gallop is reachable; the policy
  // widens or slows it from here. kneeLag ~pi/2: foot lifts on the forward swing,
  // plants to push back through stance -> net thrust.
  cpg: { baseFreq: 2.0, hipAmp: 0.5, kneeAmp: 0.8, kneeRest: 0.04, kneeLag: 1.57 },
  // strong, snappy "muscles" (quaternion servo) so the legs can drive a dynamic
  // gait, not just hold a slow shuffle.
  pd: { hipKp: 72, hipKd: 3.0, latKp: 26, latKd: 1.6, kneeKp: 72, kneeKd: 3.0, maxTorque: 95, reaction: 0.2 },
  // RUN: forward speed dominates, staying TALL is strongly rewarded (kills the
  // crouch-shuffle), alive bonus tiny. Speed only pays while upright (in reward()).
  reward: { forward: 5.5, upright: 0.25, alive: 0.02, height: 0.35, energy: 0.0012, spin: 0.03, heading: 0.4 },
  fall: { minUp: 0.4, minHeight: 0.32 }
};

function dogLeg(hip: V3, phase: number): LegSpec {
  return {
    hip,
    thigh: { halfHeight: 0.12, radius: 0.085, density: 240 },
    shank: { halfHeight: 0.12, radius: 0.07, density: 230 },
    phase
  };
}
export const DOG: CreatureSpec = {
  name: "dog",
  torso: { half: [0.18, 0.1, 0.4], density: 65 },
  legs: [
    dogLeg([-0.16, -0.06, 0.32], Math.PI * 0.5), // FL
    dogLeg([0.16, -0.06, 0.32], Math.PI * 1.5), // FR
    dogLeg([-0.16, -0.06, -0.32], 0), // HL
    dogLeg([0.16, -0.06, -0.32], Math.PI) // HR
  ],
  standHeight: 0.59,
  cpg: { baseFreq: 2.05, hipAmp: 0.42, kneeAmp: 0.68, kneeRest: 0.03, kneeLag: 1.57 },
  pd: { hipKp: 60, hipKd: 2.8, latKp: 30, latKd: 1.7, kneeKp: 60, kneeKd: 2.8, maxTorque: 58, reaction: 0.18 },
  reward: { forward: 4.0, upright: 0.14, alive: 0.04, height: 0.34, energy: 0.002, spin: 0.035, heading: 0.5 },
  fall: { minUp: 0.4, minHeight: 0.32 }
};

// ---------------------------------------------------------------- dims
/** obs = up(3) goalXZ(2) velBody(3) angVel(3) height(1) cpg(2) thighPitch(nLeg) kneeAngle(nLeg). */
export function obsDim(spec: CreatureSpec): number {
  return 3 + 2 + 3 + 3 + 1 + 2 + spec.legs.length * 2;
}
/**
 * action = freqMod(1) hipAmpMod(1) kneeAmpMod(1) perLegHipBias(nLeg)
 *          perLegPhase(nLeg) turn(1) pitchGain(1) rollGain(1).
 * The per-leg phase offsets are what let the policy discover a gait (walk vs
 * trot vs gallop) instead of being locked to the hand-set walk sequence.
 */
export function actDim(spec: CreatureSpec): number {
  return 3 + 2 * spec.legs.length + 3;
}

// ---------------------------------------------------------------- link state
export type Link = { pos: V3; quat: Quat; vel: V3; angVel: V3 };
export type LegLinks = { thigh: Link; shank: Link };
export type CreatureState = {
  torso: Link;
  legs: LegLinks[];
  groundY: number;
  goal: [number, number]; // unit heading in world XZ the creature should walk toward
};

// scratch (module-level; single-threaded per worker)
const _up: V3 = [0, 0, 0];
const _fwd: V3 = [0, 0, 0];
const _velB: V3 = [0, 0, 0];
const _dw: V3 = [0, 0, 0];
const _dt: V3 = [0, 0, 0];

/** Thigh swing angle in the torso sagittal plane (0 = straight down, + = forward). */
export function thighPitch(state: CreatureState, i: number): number {
  qRot(state.legs[i].thigh.quat, [0, -1, 0], _dw);
  qRotInv(state.torso.quat, _dw, _dt);
  return Math.atan2(_dt[2], -_dt[1]);
}
/** Knee flex angle: shank direction measured in the thigh frame (0 = straight leg). */
export function kneeAngle(state: CreatureState, i: number): number {
  qRot(state.legs[i].shank.quat, [0, -1, 0], _dw);
  qRotInv(state.legs[i].thigh.quat, _dw, _dt);
  return Math.atan2(_dt[2], -_dt[1]);
}

export function observe(spec: CreatureSpec, state: CreatureState, phase: number, out: Float32Array): Float32Array {
  const t = state.torso;
  qRot(t.quat, [0, 1, 0], _up);
  qRot(t.quat, [0, 0, 1], _fwd);
  qRotInv(t.quat, t.vel, _velB);
  let k = 0;
  out[k++] = _up[0];
  out[k++] = _up[1];
  out[k++] = _up[2];
  out[k++] = state.goal[0] * _fwd[0] + state.goal[1] * _fwd[2]; // facing goal (cos)
  out[k++] = state.goal[0] * _fwd[2] - state.goal[1] * _fwd[0]; // turn error (sin)
  out[k++] = _velB[0] * 0.4;
  out[k++] = _velB[1] * 0.4;
  out[k++] = _velB[2] * 0.4;
  out[k++] = t.angVel[0] * 0.25;
  out[k++] = t.angVel[1] * 0.25;
  out[k++] = t.angVel[2] * 0.25;
  out[k++] = (t.pos[1] - state.groundY - spec.standHeight) * 2;
  out[k++] = Math.sin(phase);
  out[k++] = Math.cos(phase);
  for (let i = 0; i < spec.legs.length; i++) out[k++] = thighPitch(state, i) * 0.6;
  for (let i = 0; i < spec.legs.length; i++) out[k++] = kneeAngle(state, i) * 0.5;
  return out;
}

// ---------------------------------------------------------------- actuation
/** seg 0 = hip (torque on thigh, reaction torso), seg 1 = knee (torque on shank, reaction thigh). */
export type Torque = { leg: number; seg: 0 | 1; t: V3 };

const _err: V3 = [0, 0, 0];
const _tw: V3 = [0, 0, 0];
const RIGHT: V3 = [1, 0, 0];

/**
 * Quaternion PD servo on one joint: drive the child's orientation relative to
 * the parent toward `qTargetLocal` (expressed in the parent's local frame),
 * controlling ALL THREE rotational DOFs at once so the ball joint can't splay
 * or twist its way into a buckle. Returns a world-frame torque, clamped.
 */
function jointServo(parent: Link, child: Link, qTargetLocal: Quat, kp: number, kd: number, maxT: number, out: V3): void {
  // relative orientation of child in parent frame
  const qRel = qMul(qConj(parent.quat), child.quat);
  // error rotation (target * rel^-1) in parent-local frame
  let e = qMul(qTargetLocal, qConj(qRel));
  const s = e[3] < 0 ? -1 : 1; // shortest arc
  _err[0] = s * e[0];
  _err[1] = s * e[1];
  _err[2] = s * e[2]; // ~= (angle/2)*axis in parent-local frame
  // spring torque in world frame + velocity damping (child relative to parent)
  qRot(parent.quat, _err, _tw);
  let tx = kp * 2 * _tw[0] - kd * (child.angVel[0] - parent.angVel[0]);
  let ty = kp * 2 * _tw[1] - kd * (child.angVel[1] - parent.angVel[1]);
  let tz = kp * 2 * _tw[2] - kd * (child.angVel[2] - parent.angVel[2]);
  const m = Math.hypot(tx, ty, tz);
  if (m > maxT) {
    const k = maxT / m;
    tx *= k;
    ty *= k;
    tz *= k;
  }
  out[0] = tx;
  out[1] = ty;
  out[2] = tz;
}

export function decode(spec: CreatureSpec, action: ArrayLike<number>, state: CreatureState, phase: number, outTorques: Torque[]): void {
  const nLeg = spec.legs.length;
  const hipAmp = spec.cpg.hipAmp * (1 + action[1]); // wider stride range for running
  const kneeAmp = spec.cpg.kneeAmp * (1 + action[2]);
  const turn = action[3 + 2 * nLeg];
  const pitchGain = action[4 + 2 * nLeg];

  qRot(state.torso.quat, [0, 1, 0], _up);
  const tipFwd = _up[2]; // + = nose down
  outTorques.length = 0;

  for (let i = 0; i < nLeg; i++) {
    const spc = spec.legs[i];
    const isRight = spc.hip[0] > 0;
    const bias = 0.5 * action[3 + i] + (isRight ? -turn : turn) * 0.4;
    // per-leg phase offset lets the policy re-time each leg -> discover gaits
    const gaitPhase = phase + spc.phase + action[3 + nLeg + i] * Math.PI;

    // hip: swing the thigh fore-aft (about local right); zero roll/yaw target
    // keeps the leg in the sagittal plane (no splay). Pitch-balance leans all legs.
    const hipSwing = hipAmp * Math.sin(gaitPhase) + bias - pitchGain * tipFwd * 0.8;
    const t0: V3 = [0, 0, 0];
    jointServo(state.torso, state.legs[i].thigh, qAxis(RIGHT, hipSwing), spec.pd.hipKp, spec.pd.hipKd, spec.pd.maxTorque, t0);
    outTorques.push({ leg: i, seg: 0, t: t0 });

    // knee: flex about thigh's local right during swing (lift foot), straight in stance
    const flex = Math.max(0, Math.sin(gaitPhase + spec.cpg.kneeLag));
    const kneeTarget = spec.cpg.kneeRest + kneeAmp * flex;
    const t1: V3 = [0, 0, 0];
    jointServo(state.legs[i].thigh, state.legs[i].shank, qAxis(RIGHT, kneeTarget), spec.pd.kneeKp, spec.pd.kneeKd, spec.pd.maxTorque, t1);
    outTorques.push({ leg: i, seg: 1, t: t1 });
  }
}

export function advancePhase(spec: CreatureSpec, phase: number, action: ArrayLike<number>, dt: number): number {
  // exponential mapping: action[0] in [-1,1] -> ~0.37x..2.7x the base frequency,
  // so the policy can slow to a walk or wind up to a gallop.
  const f = spec.cpg.baseFreq * Math.exp(action[0]);
  let p = phase + 2 * Math.PI * f * dt;
  if (p > 2 * Math.PI) p -= 2 * Math.PI;
  return p;
}

// ---------------------------------------------------------------- reward
export function reward(spec: CreatureSpec, state: CreatureState, action: ArrayLike<number>, dt: number): { r: number; done: boolean } {
  const t = state.torso;
  qRot(t.quat, [0, 1, 0], _up);
  qRot(t.quat, [0, 0, 1], _fwd);
  const height = t.pos[1] - state.groundY;
  const upright = _up[1];
  const done = upright < spec.fall.minUp || height < spec.fall.minHeight;

  const fwdSpeed = t.vel[0] * state.goal[0] + t.vel[2] * state.goal[1];
  const facing = _fwd[0] * state.goal[0] + _fwd[2] * state.goal[1];
  let energy = 0;
  for (let i = 0; i < action.length; i++) energy += action[i] * action[i];
  const spin = t.angVel[0] * t.angVel[0] + t.angVel[1] * t.angVel[1] + t.angVel[2] * t.angVel[2];
  // reward staying TALL: full credit at/above standing height, scaled when
  // crouched, NO penalty for bouncing higher (so a gallop's float is fine)
  const tall = height >= spec.standHeight ? 1 : Math.max(0, height / spec.standHeight);

  // clamp so ES can't reward-hack a numerical blow-up; 6 m/s is a full gallop
  const speed = fwdSpeed < -1.5 ? -1.5 : fwdSpeed > 6 ? 6 : fwdSpeed;
  const w = spec.reward;
  let r = 0;
  // the ONLY way to bank big reward is to run while UPRIGHT and TALL — this is
  // what forces a real running gait instead of "stand tall" or "crawl low".
  const gate = Math.max(0, upright) * (0.3 + 0.7 * tall);
  r += w.forward * speed * gate;
  // super-linear bonus above walking pace: the faster it runs, the better —
  // this is what pulls the gait off the "stable trot" plateau toward a gallop.
  r += w.forward * 1.1 * Math.max(0, speed - 0.7) * gate;
  r += w.upright * upright;
  r += w.alive;
  r += w.heading * Math.max(0, facing);
  r += w.height * tall; // small anti-crouch floor so it doesn't sink when slow
  r -= w.energy * energy;
  r -= w.spin * spin;
  r *= dt * 60;
  if (done) r -= 3;
  return { r, done };
}
