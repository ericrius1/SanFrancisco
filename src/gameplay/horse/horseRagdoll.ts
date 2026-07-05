import { BodyType } from "box3d-wasm";
import { Policy } from "../../creatures/policy";
import {
  advancePhase,
  decode,
  observe,
  obsDim,
  type CreatureSpec,
  type CreatureState,
  type Link,
  type LegLinks,
  type Torque,
  type V3
} from "../../creatures/quadruped";

/**
 * One RL creature living in the browser, driven by its trained policy every
 * frame. It runs in its OWN private box3d world (a flat ground plane) stepped at
 * exactly the rate it was trained at — so the walk it learned in Node reproduces
 * here bit-for-bit. The game renders it at a roaming world position and lifts it
 * onto the terrain; the private sim just needs "the ground is here".
 *
 * The body build + torque application mirror rl/core/box3dEnv.ts — keep them in
 * sync (the shared brain lives in src/creatures/quadruped.ts).
 */
const IDENT: [number, number, number, number] = [0, 0, 0, 1];
const SIM_DT = 1 / 120; // must match the trainer's dt
const SUBSTEPS = 8;
const mkLink = (): Link => ({ pos: [0, 0, 0], quat: [0, 0, 0, 1], vel: [0, 0, 0], angVel: [0, 0, 0] });

type LegBodies = { thigh: number; shank: number; thighCenter: V3; shankCenter: V3 };

export class HorseRagdoll {
  readonly spec: CreatureSpec;
  private world: any;
  private torso = 0;
  private legBodies: LegBodies[] = [];
  private all: number[] = [];
  private policy: Policy;
  private state: CreatureState;
  private obsBuf: Float32Array;
  private phase = 0;
  private torques: Torque[] = [];
  private acc = 0;
  private spawnY: number;
  /** last policy hidden activations, for the over-head brain bubble. */
  hidden: Float32Array = new Float32Array(0);

  constructor(box3d: any, spec: CreatureSpec, policy: Policy) {
    this.spec = spec;
    this.policy = policy;
    this.world = box3d.createWorld([0, -9.81, 0]);
    this.world.createBox({ type: BodyType.Static, position: [0, -0.5, 0], halfExtents: [40, 0.5, 40], friction: 1.0 });

    const l0 = spec.legs[0];
    const legLen = 2 * l0.thigh.halfHeight + 2 * l0.shank.halfHeight;
    this.spawnY = legLen + l0.shank.radius - l0.hip[1];

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
      this.legBodies.push({ thigh, shank, thighCenter, shankCenter });
    }
    this.all = [this.torso];
    for (const lb of this.legBodies) this.all.push(lb.thigh, lb.shank);

    this.state = { torso: mkLink(), legs: spec.legs.map(() => ({ thigh: mkLink(), shank: mkLink() }) as LegLinks), groundY: 0, goal: [0, 1] };
    this.obsBuf = new Float32Array(obsDim(spec));
    this.syncState();
  }

  setGoal(dx: number, dz: number): void {
    const m = Math.hypot(dx, dz) || 1;
    this.state.goal[0] = dx / m;
    this.state.goal[1] = dz / m;
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

  private stepOnce(): void {
    const { action, hidden } = this.policy.forward(this.obsBuf);
    this.hidden = hidden;
    this.phase = advancePhase(this.spec, this.phase, action, SIM_DT);
    decode(this.spec, action, this.state, this.phase, this.torques);
    const R = this.spec.pd.reaction;
    for (const q of this.torques) {
      const lb = this.legBodies[q.leg];
      const child = q.seg === 0 ? lb.thigh : lb.shank;
      const parent = q.seg === 0 ? this.torso : lb.thigh;
      const tx = q.t[0] * SIM_DT, ty = q.t[1] * SIM_DT, tz = q.t[2] * SIM_DT;
      this.world.applyAngularImpulse(child, [tx, ty, tz]);
      this.world.applyAngularImpulse(parent, [-tx * R, -ty * R, -tz * R]);
    }
    for (const h of this.all) this.world.setBodyAwake(h, true);
    this.world.step(SIM_DT, SUBSTEPS);
    this.syncState();
    observe(this.spec, this.state, this.phase, this.obsBuf);
  }

  /** Advance the private sim by real dt, always in trained-size sub-steps. */
  update(dt: number): void {
    this.acc += Math.min(dt, 0.1);
    let n = 0;
    while (this.acc >= SIM_DT && n < 6) {
      this.stepOnce();
      this.acc -= SIM_DT;
      n++;
    }
  }

  /** Torso pose in the private sim (caller adds the roaming world offset). */
  get torsoLink(): Link { return this.state.torso; }
  get legLinks(): LegLinks[] { return this.state.legs; }
  /** Standing height reference (sim-space torso Y when upright). */
  get standY(): number { return this.spawnY; }
  /** Is it still on its feet? (fell if torso up-axis tips or it sinks) */
  get fallen(): boolean {
    const q = this.state.torso.quat;
    const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]); // world-up . body-up
    return upY < 0.4 || this.state.torso.pos[1] < this.spawnY * 0.5;
  }

  /** Reset to a clean stand (after a fall). */
  reset(): void {
    this.world.setBodyTransform(this.torso, [0, this.spawnY, 0], IDENT);
    this.world.setBodyVelocity(this.torso, [0, 0, 0], [0, 0, 0]);
    for (const lb of this.legBodies) {
      this.world.setBodyTransform(lb.thigh, lb.thighCenter, IDENT);
      this.world.setBodyVelocity(lb.thigh, [0, 0, 0], [0, 0, 0]);
      this.world.setBodyTransform(lb.shank, lb.shankCenter, IDENT);
      this.world.setBodyVelocity(lb.shank, [0, 0, 0], [0, 0, 0]);
    }
    this.phase = 0;
    this.acc = 0;
    this.syncState();
  }

  dispose(): void {
    this.world.dispose?.();
  }
}
