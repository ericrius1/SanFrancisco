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
  // height is a modest stand-tall entry gradient; the tall-GATE (in reward())
  // already forces tallness, so keeping this small makes RUNNING the way to earn
  // real reward instead of just standing there.
  reward: { forward: 6.0, upright: 0.25, alive: 0.03, height: 0.9, energy: 0.0012, spin: 0.03, heading: 0.9 },
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

/**
 * Size-scaled copy of a creature spec. Lengths scale by s; density kept, so mass
 * ~ s^3. For dynamically-SIMILAR motion under fixed gravity (Froude scaling):
 * torque/gains ~ s^4, damping ~ s^3.5 (holds the damping ratio), stride
 * frequency ~ 1/sqrt(s). With the non-dimensional observations/reward in
 * observe()/reward(), ONE policy transfers across body sizes — and training
 * randomizes s so it's robust to any scale.
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
    reward: base.reward,
    fall: base.fall
  };
}

// ---------------------------------------------------------------- dims
/** obs = up(3) goalXZ(2) velBody(3) angVel(3) height(1) cpg(2) thighPitch(nLeg) kneeAngle(nLeg) targetSpeed(1). */
export function obsDim(spec: CreatureSpec): number {
  return 3 + 2 + 3 + 3 + 1 + 2 + spec.legs.length * 2 + 1;
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
  targetSpeed: number; // commanded NOSE-FIRST forward speed (m/s): walk vs trot vs gallop
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
  // NON-DIMENSIONAL (Froude) scaling so the policy sees the SAME numbers at any
  // body size: lengths / standHeight, velocities / sqrt(g*standHeight), angular
  // velocities * sqrt(standHeight/g). One policy then transfers across scales.
  const L = spec.standHeight;
  const invV = 1 / Math.sqrt(9.81 * L);
  const T = L * invV; // = sqrt(L/g)
  let k = 0;
  out[k++] = _up[0];
  out[k++] = _up[1];
  out[k++] = _up[2];
  out[k++] = state.goal[0] * _fwd[0] + state.goal[1] * _fwd[2]; // facing goal (cos)
  out[k++] = state.goal[0] * _fwd[2] - state.goal[1] * _fwd[0]; // turn error (sin)
  out[k++] = _velB[0] * invV;
  out[k++] = _velB[1] * invV;
  out[k++] = _velB[2] * invV;
  out[k++] = t.angVel[0] * T;
  out[k++] = t.angVel[1] * T;
  out[k++] = t.angVel[2] * T;
  out[k++] = (t.pos[1] - state.groundY - L) / L;
  out[k++] = Math.sin(phase);
  out[k++] = Math.cos(phase);
  for (let i = 0; i < spec.legs.length; i++) out[k++] = thighPitch(state, i) * 0.6;
  for (let i = 0; i < spec.legs.length; i++) out[k++] = kneeAngle(state, i) * 0.5;
  out[k++] = state.targetSpeed * invV; // commanded gait speed, non-dimensional (Froude)
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

/**
 * Searchable gait knobs — the outer training loop mutates these and saves the
 * winning set WITH the policy (PolicyDef.tuning) so the runtime replays the exact
 * gait it was trained under. Defaults reproduce the hand-tuned policy.
 */
export type GaitTuning = {
  freqBase: number; freqSpan: number; // cadence: speedFreq = freqBase + freqSpan*targetND
  strideBase: number; strideSpan: number; // stride: speedStride = strideBase + strideSpan*targetND
  actFreqAuth: number; actStrideAuth: number; actKneeAuth: number; // policy authority over CPG
  speedMatchA: number; progressW: number; // reward: speed-match sharpness + progress weight
  tallFloorSlope: number; doneFloorSlope: number; uprightSoften: number; // gate relax with speed
  maxTorqueScale: number; // multiplies joint torque limit (body power, searchable)
  gallopBlend: number; // 0..1: how far the FOOTFALL shifts from walk-sequence toward a gallop half-bound at high speed
  boundRewardW: number; // reward a forward BOUND (vertical torso motion while advancing) at gallop — trains the flight phase
};
export const DEFAULT_TUNING: GaitTuning = {
  freqBase: 0.78, freqSpan: 0.5, strideBase: 0.68, strideSpan: 1.05,
  actFreqAuth: 0.5, actStrideAuth: 0.5, actKneeAuth: 0.7,
  speedMatchA: 10, progressW: 0.55,
  tallFloorSlope: 0.13, doneFloorSlope: 0.12, uprightSoften: 0.4,
  maxTorqueScale: 1.0, gallopBlend: 0, boundRewardW: 0
};
let TUNING: GaitTuning = { ...DEFAULT_TUNING };
export function setTuning(t: Partial<GaitTuning> | null | undefined): void {
  TUNING = t ? { ...DEFAULT_TUNING, ...t } : { ...DEFAULT_TUNING };
}
export function getTuning(): GaitTuning { return TUNING; }

export function decode(spec: CreatureSpec, action: ArrayLike<number>, state: CreatureState, phase: number, outTorques: Torque[]): void {
  const nLeg = spec.legs.length;
  // stride length also scales with the commanded speed (short steps at a walk,
  // long reaching strides at a gallop); the policy modulates around it.
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
    // per-leg phase offset lets the policy re-time each leg -> discover gaits
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
  // The COMMANDED speed sets the step cadence directly (a walk steps slowly, a
  // gallop cycles fast); the policy only fine-tunes around it (±, ×0.5 authority).
  // Pure-RL speed conditioning refused to separate gaits — hard-wiring cadence to
  // the command is what makes a real walk and a real gallop distinct.
  const V = Math.sqrt(9.81 * spec.standHeight);
  const targetND = state.targetSpeed / V; // ~0.15 walk .. ~0.85 gallop
  const speedFreq = TUNING.freqBase + TUNING.freqSpan * targetND;
  const f = spec.cpg.baseFreq * speedFreq * Math.exp(action[0] * TUNING.actFreqAuth);
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
  const H = spec.standHeight;
  const Vg = Math.sqrt(9.81 * H);
  const spdCmd = Math.max(0, Math.min(1, state.targetSpeed / Vg)); // 0 walk .. ~1 gallop
  // A GALLOP is dynamic — the body pitches and bounds (height oscillates). Relax the
  // terminate/height/upright floors as the commanded speed rises, so a fast bounding
  // gait isn't punished into a speed cap; keep it strict for a clean upright walk.
  const doneFloor = 0.45 - TUNING.doneFloorSlope * spdCmd;
  const done = upright < spec.fall.minUp - 0.05 * spdCmd || height < doneFloor * H;

  // NOSE-FIRST speed: velocity along the body's own forward axis, NOT toward the
  // goal. Rewarding toward-goal velocity let it satisfy the goal by walking
  // BACKWARD; this makes it run face-first. The heading term turns it to face
  // the goal, so nose-first + facing-goal = running forward toward the goal.
  const fwdSpeed = t.vel[0] * _fwd[0] + t.vel[2] * _fwd[2];
  const facing = _fwd[0] * state.goal[0] + _fwd[2] * state.goal[1];
  let energy = 0;
  for (let i = 0; i < action.length; i++) energy += action[i] * action[i];
  const spin = t.angVel[0] * t.angVel[0] + t.angVel[1] * t.angVel[1] + t.angVel[2] * t.angVel[2];

  // STEEP tallness ramp: ~0 at 0.6*standing, 1 near standing. Every reward term
  // is multiplied by this, so a crouch earns almost nothing and ES is FORCED to
  // keep the legs extended and the body up (with a stand-tall bonus that gives a
  // gradient even at zero speed → learn to stand, then to run tall).
  const tallFloor = 0.5 - TUNING.tallFloorSlope * spdCmd; // let a gallop ride lower (bounding) without losing reward
  const tall = Math.max(0, Math.min(1, (height - tallFloor * H) / (0.9 * H - tallFloor * H)));
  // Froude speed: fwdSpeed / sqrt(g*standHeight) — dimensionless, so the same
  // COMMANDED gait scores the same at any body size (Fr~0.4 walk .. ~2.3 gallop).
  const V = Math.sqrt(9.81 * H);
  const target = state.targetSpeed; // commanded nose-first speed (m/s)
  const speedErr = (fwdSpeed - target) / V; // non-dimensional
  const speedMatch = Math.exp(-TUNING.speedMatchA * speedErr * speedErr); // pulls to the commanded speed at both ends
  const gate = Math.pow(Math.max(0, upright), 1 - TUNING.uprightSoften * spdCmd) * tall; // upright demand softens at gallop (the horse pitches into the run)
  const faceGate = 0.3 + 0.7 * Math.max(0, facing); // move more when FACING the goal
  const w = spec.reward;
  let r = 0;
  r += w.height * tall; // stand-tall bonus (the entry gradient)
  r += w.forward * speedMatch * gate * faceGate; // HIT the commanded gait speed (walk/trot/gallop), facing goal
  // progress bonus that saturates AT the target: gives a gradient to get moving
  // (so a commanded slow walk isn't satisfied by standing still), but pays nothing
  // for overshooting — the match term above penalizes going faster than asked.
  r += w.forward * TUNING.progressW * (Math.min(Math.max(0, fwdSpeed), target) / V) * gate * faceGate;
  r += w.upright * upright * tall;
  r += w.alive * tall;
  r += w.heading * Math.max(0, facing) * tall; // turn to face the goal
  // GALLOP SHAPE: reward a FORWARD bound (vertical torso motion while advancing) only
  // at high commanded speed — the training reward otherwise optimizes a flat shuffle
  // that speed-matches but never learns the gallop's flight. Gated so the walk stays flat.
  if (TUNING.boundRewardW > 0) {
    const gallopGate = Math.max(0, Math.min(1, (spdCmd - 0.5) / 0.3));
    const bound = Math.min(1, Math.abs(t.vel[1]) / V);
    const fwdFrac = target > 0.01 ? Math.max(0, Math.min(1, fwdSpeed / target)) : 0;
    r += w.forward * TUNING.boundRewardW * bound * fwdFrac * gallopGate * gate;
  }
  r -= w.energy * energy;
  r -= w.spin * spin;
  r *= dt * 60;
  if (done) r -= 3;
  return { r, done };
}
