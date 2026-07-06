/**
 * The box3d training environment for a two-segment active-ragdoll quadruped.
 *
 * Node-only. Builds the creature ONCE (torso box + per-leg thigh/shank capsules
 * + hip/knee spherical joints) and reuses it across every rollout via reset().
 * The identical box3d wrapper runs in the browser, so a policy trained here
 * transfers with zero sim-to-real gap. Run under `node --experimental-strip-types`.
 */
import { BodyType } from "box3d-wasm";
import {
  advancePhase,
  decode,
  observe,
  reward,
  obsDim,
  actDim,
  scaledSpec,
  type CreatureSpec,
  type CreatureState,
  type Link,
  type LegLinks,
  type Torque,
  type V3
} from "../../src/creatures/quadruped.ts";

const IDENT: [number, number, number, number] = [0, 0, 0, 1];
const mkLink = (): Link => ({ pos: [0, 0, 0], quat: [0, 0, 0, 1], vel: [0, 0, 0], angVel: [0, 0, 0] });

export type StepResult = { obs: Float32Array; reward: number; done: boolean };

type LegBodies = { thigh: number; shank: number; hip: V3; knee: V3; thighCenter: V3; shankCenter: V3 };

export class Box3DEnv {
  readonly spec: CreatureSpec;
  readonly dt: number;
  readonly substeps: number;
  private world: any;
  private torso = 0;
  private legBodies: LegBodies[] = [];
  private all: number[] = [];
  state: CreatureState;
  private obsBuf: Float32Array;
  private phase = 0;
  private goalAngle = 0;
  private goalTarget = 0;
  private rng: () => number = Math.random;
  private stepCount = 0;
  private torques: Torque[] = [];
  private groundY = 0;
  private spawnY: number;

  constructor(box3d: any, spec: CreatureSpec, opts: { dt?: number; substeps?: number; scale?: number } = {}) {
    spec = scaledSpec(spec, opts.scale ?? 1); // build (and observe/decode/reward) at this body size
    this.spec = spec;
    this.dt = opts.dt ?? 1 / 120;
    this.substeps = opts.substeps ?? 8;
    this.world = box3d.createWorld([0, -9.81, 0]);
    this.world.createBox({ type: BodyType.Static, position: [0, this.groundY - 0.5, 0], halfExtents: [60, 0.5, 60], friction: 1.0 });

    const l0 = spec.legs[0];
    const legLen = 2 * l0.thigh.halfHeight + 2 * l0.shank.halfHeight;
    this.spawnY = this.groundY + legLen + l0.shank.radius - l0.hip[1];

    this.torso = this.world.createBox({ type: BodyType.Dynamic, position: [0, this.spawnY, 0], halfExtents: spec.torso.half, density: spec.torso.density, friction: 0.7 });

    for (const leg of spec.legs) {
      const hip: V3 = [leg.hip[0], this.spawnY + leg.hip[1], leg.hip[2]];
      const knee: V3 = [hip[0], hip[1] - 2 * leg.thigh.halfHeight, hip[2]];
      const thighCenter: V3 = [hip[0], hip[1] - leg.thigh.halfHeight, hip[2]];
      const shankCenter: V3 = [hip[0], knee[1] - leg.shank.halfHeight, hip[2]];
      const thigh = this.world.createCapsule({ type: BodyType.Dynamic, position: thighCenter, halfHeight: leg.thigh.halfHeight, radius: leg.thigh.radius, density: leg.thigh.density, friction: 0.8 });
      const shank = this.world.createCapsule({ type: BodyType.Dynamic, position: shankCenter, halfHeight: leg.shank.halfHeight, radius: leg.shank.radius, density: leg.shank.density, friction: 1.3 });
      this.world.createSphericalJoint(this.torso, thigh, hip, { hertz: 0, dampingRatio: 1.0 });
      this.world.createSphericalJoint(thigh, shank, knee, { hertz: 0, dampingRatio: 1.0 });
      this.legBodies.push({ thigh, shank, hip, knee, thighCenter, shankCenter });
    }
    this.all = [this.torso];
    for (const lb of this.legBodies) this.all.push(lb.thigh, lb.shank);

    const legs: LegLinks[] = spec.legs.map(() => ({ thigh: mkLink(), shank: mkLink() }));
    this.state = { torso: mkLink(), legs, groundY: this.groundY, goal: [0, 1] };
    this.obsBuf = new Float32Array(obsDim(spec));
  }

  private readLink(handle: number, link: Link): void {
    const tr = this.world.getBodyTransform(handle);
    link.pos[0] = tr.position[0]; link.pos[1] = tr.position[1]; link.pos[2] = tr.position[2];
    link.quat[0] = tr.rotation[0]; link.quat[1] = tr.rotation[1]; link.quat[2] = tr.rotation[2]; link.quat[3] = tr.rotation[3];
    const v = this.world.getBodyVelocity(handle);
    link.vel[0] = v.linear[0]; link.vel[1] = v.linear[1]; link.vel[2] = v.linear[2];
    link.angVel[0] = v.angular[0]; link.angVel[1] = v.angular[1]; link.angVel[2] = v.angular[2];
  }

  private syncState(): void {
    this.readLink(this.torso, this.state.torso);
    for (let i = 0; i < this.legBodies.length; i++) {
      this.readLink(this.legBodies[i].thigh, this.state.legs[i].thigh);
      this.readLink(this.legBodies[i].shank, this.state.legs[i].shank);
    }
  }

  private keepAwake(): void {
    for (const h of this.all) this.world.setBodyAwake(h, true);
  }

  private applyTorques(): void {
    const dt = this.dt;
    const R = this.spec.pd.reaction;
    for (const q of this.torques) {
      const lb = this.legBodies[q.leg];
      const child = q.seg === 0 ? lb.thigh : lb.shank;
      const parent = q.seg === 0 ? this.torso : lb.thigh;
      const tx = q.t[0] * dt;
      const ty = q.t[1] * dt;
      const tz = q.t[2] * dt;
      this.world.applyAngularImpulse(child, [tx, ty, tz]);
      this.world.applyAngularImpulse(parent, [-tx * R, -ty * R, -tz * R]);
    }
  }

  private zeroAction: Float32Array = new Float32Array(0);

  reset(rng: () => number): Float32Array {
    if (this.zeroAction.length === 0) this.zeroAction = new Float32Array(actDim(this.spec));
    this.world.setBodyTransform(this.torso, [0, this.spawnY, 0], IDENT);
    this.world.setBodyVelocity(this.torso, [0, 0, 0], [0, 0, 0]);
    for (const lb of this.legBodies) {
      this.world.setBodyTransform(lb.thigh, lb.thighCenter, IDENT);
      this.world.setBodyVelocity(lb.thigh, [0, 0, 0], [0, 0, 0]);
      this.world.setBodyTransform(lb.shank, lb.shankCenter, IDENT);
      this.world.setBodyVelocity(lb.shank, [0, 0, 0], [0, 0, 0]);
    }
    this.rng = rng;
    this.stepCount = 0;
    this.goalAngle = rng() * Math.PI * 2;
    this.goalTarget = this.goalAngle;
    this.state.goal[0] = Math.sin(this.goalAngle);
    this.state.goal[1] = Math.cos(this.goalAngle);
    this.phase = rng() * Math.PI * 2;
    // settle with the stance HELD by control, so the legs don't fold before the
    // policy takes over. Freeze the CPG phase during the hold (neutral pose).
    this.syncState();
    for (let i = 0; i < 12; i++) {
      decode(this.spec, this.zeroAction, this.state, this.phase, this.torques);
      this.applyTorques();
      this.keepAwake();
      this.world.step(this.dt, this.substeps);
      this.syncState();
    }
    return observe(this.spec, this.state, this.phase, this.obsBuf);
  }

  step(action: ArrayLike<number>): StepResult {
    // wander the goal DURING the episode so the policy learns to TURN while
    // staying up (in-world the goal changes; a fixed-goal policy tips on turns)
    this.stepCount++;
    if (this.stepCount % 90 === 0) this.goalTarget = this.goalAngle + (this.rng() - 0.5) * 2.6;
    const da = this.goalTarget - this.goalAngle;
    this.goalAngle += da > 0.02 ? 0.02 : da < -0.02 ? -0.02 : da; // <= ~0.02 rad/step
    this.state.goal[0] = Math.sin(this.goalAngle);
    this.state.goal[1] = Math.cos(this.goalAngle);
    this.phase = advancePhase(this.spec, this.phase, action, this.dt);
    decode(this.spec, action, this.state, this.phase, this.torques);
    this.applyTorques();
    this.keepAwake();
    this.world.step(this.dt, this.substeps);
    this.syncState();
    const { r, done } = reward(this.spec, this.state, action, this.dt);
    const obs = observe(this.spec, this.state, this.phase, this.obsBuf);
    return { obs, reward: r, done };
  }

  /** World transforms of every link (torso, then thigh+shank per leg) — for recording/video. */
  snapshot(): { pos: V3; quat: [number, number, number, number] }[] {
    const links: Link[] = [this.state.torso];
    for (const l of this.state.legs) links.push(l.thigh, l.shank);
    return links.map((l) => ({ pos: [l.pos[0], l.pos[1], l.pos[2]], quat: [l.quat[0], l.quat[1], l.quat[2], l.quat[3]] }));
  }
}
