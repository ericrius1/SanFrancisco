/**
 * Shared body + gait wiring for an active-ragdoll quadruped: two-segment legs
 * (thigh + shank + actuated knee) so the foot lifts during swing and bears load
 * through stance. Dependency-free (no three, no box3d) — callers feed link
 * transforms/velocities as plain arrays and get back joint torques to apply.
 *
 * Hips and knees are driven by PD torque toward a central-pattern-generator
 * gait; commanded speed sets cadence and stride length.
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
  fall: { minUp: number; minHeight: number };
};

// Lateral-sequence WALK (HL -> FL -> HR -> FR, a quarter cycle apart).
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
  cpg: { baseFreq: 2.0, hipAmp: 0.5, kneeAmp: 0.8, kneeRest: 0.04, kneeLag: 1.57 },
  pd: { hipKp: 72, hipKd: 3.0, latKp: 26, latKd: 1.6, kneeKp: 72, kneeKd: 3.0, maxTorque: 95, reaction: 0.2 },
  fall: { minUp: 0.4, minHeight: 0.32 }
};

/**
 * Size-scaled copy of a creature spec. Lengths scale by s; density kept, so mass
 * ~ s^3. For dynamically-similar motion under fixed gravity (Froude scaling):
 * torque/gains ~ s^4, damping ~ s^3.5, stride frequency ~ 1/sqrt(s).
 */
export function scaledSpec(base: CreatureSpec, s: number): CreatureSpec {
  if (s === 1) return base;
  const g4 = s * s * s * s;
  const gd = Math.pow(s, 3.5);
  const sf = 1 / Math.sqrt(s);
  return {
    name: base.name,
    torso: { half: [base.torso.half[0] * s, base.torso.half[1] * s, base.torso.half[2] * s], density: base.torso.density },
    legs: base.legs.map((l) => ({
      hip: [l.hip[0] * s, l.hip[1] * s, l.hip[2] * s] as V3,
      thigh: { halfHeight: l.thigh.halfHeight * s, radius: l.thigh.radius * s, density: l.thigh.density },
      shank: { halfHeight: l.shank.halfHeight * s, radius: l.shank.radius * s, density: l.shank.density },
      phase: l.phase
    })),
    standHeight: base.standHeight * s,
    cpg: { baseFreq: base.cpg.baseFreq * sf, hipAmp: base.cpg.hipAmp, kneeAmp: base.cpg.kneeAmp, kneeRest: base.cpg.kneeRest, kneeLag: base.cpg.kneeLag },
    pd: {
      hipKp: base.pd.hipKp * g4, hipKd: base.pd.hipKd * gd,
      latKp: base.pd.latKp * g4, latKd: base.pd.latKd * gd,
      kneeKp: base.pd.kneeKp * g4, kneeKd: base.pd.kneeKd * gd,
      maxTorque: base.pd.maxTorque * g4, reaction: base.pd.reaction
    },
    fall: base.fall
  };
}

// ---------------------------------------------------------------- dims
/** action = freqMod(1) hipAmpMod(1) kneeAmpMod(1) perLegHipBias(nLeg) perLegPhase(nLeg) turn(1) pitchGain(1) rollGain(1). */
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
  targetSpeed: number; // commanded NOSE-FIRST forward speed (m/s): walk vs trot vs gallop
};

// scratch (module-level; single-threaded)
const _up: V3 = [0, 0, 0];
const RIGHT: V3 = [1, 0, 0];
/** seg 0 = hip (torque on thigh, reaction torso), seg 1 = knee (torque on shank, reaction thigh). */
export type Torque = { leg: number; seg: 0 | 1; t: V3 };

const _err: V3 = [0, 0, 0];
const _tw: V3 = [0, 0, 0];

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

/** Runtime gait knobs — cadence, stride, and optional action modulation. */
export type GaitTuning = {
  freqBase: number; freqSpan: number;
  strideBase: number; strideSpan: number;
  actFreqAuth: number; actStrideAuth: number; actKneeAuth: number;
  maxTorqueScale: number;
  gallopBlend: number;
};
export const DEFAULT_TUNING: GaitTuning = {
  freqBase: 0.7909, freqSpan: 0.5198,
  strideBase: 0.7459, strideSpan: 1.5651,
  actFreqAuth: 0.7188, actStrideAuth: 0.3095, actKneeAuth: 0.7839,
  maxTorqueScale: 1.1028, gallopBlend: 0
};
let TUNING: GaitTuning = { ...DEFAULT_TUNING };
export function setTuning(t: Partial<GaitTuning> | null | undefined): void {
  TUNING = t ? { ...DEFAULT_TUNING, ...t } : { ...DEFAULT_TUNING };
}
export function getTuning(): GaitTuning { return TUNING; }

export function decode(spec: CreatureSpec, action: ArrayLike<number>, state: CreatureState, phase: number, outTorques: Torque[]): void {
  const nLeg = spec.legs.length;
  // stride length scales with commanded speed (short steps at a walk, long at gallop).
  const Vd = Math.sqrt(9.81 * spec.standHeight);
  const targetND = state.targetSpeed / Vd;
  const speedStride = TUNING.strideBase + TUNING.strideSpan * targetND;
  const maxT = spec.pd.maxTorque * TUNING.maxTorqueScale;
  const hipAmp = spec.cpg.hipAmp * speedStride * (1 + action[1] * TUNING.actStrideAuth);
  const kneeAmp = spec.cpg.kneeAmp * (1 + action[2] * TUNING.actKneeAuth);
  const turn = action[3 + 2 * nLeg];
  const pitchGain = action[4 + 2 * nLeg];

  qRot(state.torso.quat, [0, 1, 0], _up);
  const tipFwd = _up[2]; // + = nose down
  outTorques.length = 0;

  for (let i = 0; i < nLeg; i++) {
    const spc = spec.legs[i];
    const isRight = spc.hip[0] > 0;
    const bias = 0.5 * action[3 + i] + (isRight ? -turn : turn) * 0.4;
    // FOOTFALL: at low speed use the hand-set lateral WALK sequence; as commanded
    // speed rises, blend toward a GALLOP half-bound (hind pair fire ~together, then
    // the front pair ~half a cycle later) — a walk sequence can't gallop no matter
    // how fast it cycles. gallopBlend (0..1) is searched; 0 = pure walk sequence.
    const isFront = spc.hip[2] > 0;
    // TRUE transverse gallop: hind pair fire ~together, front pair ~together, π apart
    // (the previous 3.4+0.5 offsets made a pace-like vertical bounce, not a gallop).
    const gallopOffset = isFront ? Math.PI : 0;
    const gblend = TUNING.gallopBlend * Math.max(0, Math.min(1, (targetND - 0.58) / 0.27)); // ramp ABOVE trot so only the gallop gets the half-bound
    const footfall = spc.phase * (1 - gblend) + gallopOffset * gblend;
    const gaitPhase = phase + footfall + action[3 + nLeg + i] * Math.PI;

    // hip: swing the thigh fore-aft (about local right); zero roll/yaw target
    // keeps the leg in the sagittal plane (no splay). Pitch-balance leans all legs.
    const hipSwing = hipAmp * Math.sin(gaitPhase) + bias - pitchGain * tipFwd * 0.8;
    const t0: V3 = [0, 0, 0];
    jointServo(state.torso, state.legs[i].thigh, qAxis(RIGHT, hipSwing), spec.pd.hipKp, spec.pd.hipKd, maxT, t0);
    outTorques.push({ leg: i, seg: 0, t: t0 });

    // knee: flex about thigh's local right during swing (lift foot), straight in stance.
    // At gallop, drive the HIND legs to extend harder (propulsive push-off).
    const flex = Math.max(0, Math.sin(gaitPhase + spec.cpg.kneeLag));
    const kneeGaitBias = gblend * (isFront ? 0 : -0.25); // hind push at gallop
    const kneeTarget = spec.cpg.kneeRest + kneeAmp * flex + kneeGaitBias;
    const t1: V3 = [0, 0, 0];
    jointServo(state.legs[i].thigh, state.legs[i].shank, qAxis(RIGHT, kneeTarget), spec.pd.kneeKp, spec.pd.kneeKd, maxT, t1);
    outTorques.push({ leg: i, seg: 1, t: t1 });
  }
}

export function advancePhase(spec: CreatureSpec, state: CreatureState, phase: number, action: ArrayLike<number>, dt: number): number {
  const V = Math.sqrt(9.81 * spec.standHeight);
  const targetND = state.targetSpeed / V;
  const speedFreq = TUNING.freqBase + TUNING.freqSpan * targetND;
  const f = spec.cpg.baseFreq * speedFreq * Math.exp(action[0] * TUNING.actFreqAuth);
  let p = phase + 2 * Math.PI * f * dt;
  if (p > 2 * Math.PI) p -= 2 * Math.PI;
  return p;
}
