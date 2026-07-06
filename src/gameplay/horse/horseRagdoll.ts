import { BodyType } from "box3d-wasm";
import {
  advancePhase,
  decode,
  actDim,
  scaledSpec,
  setTuning,
  DEFAULT_TUNING,
  qRot,
  type CreatureSpec,
  type CreatureState,
  type Link,
  type LegLinks,
  type Torque,
  type V3
} from "../../creatures/quadruped.ts";

/**
 * One quadruped ragdoll living in the browser, driven by a procedural CPG gait
 * every frame. It runs in its OWN private box3d world (a flat ground plane)
 * stepped at a fixed rate. The game renders it at a roaming world position and
 * lifts it onto the terrain; the private sim just needs "the ground is here".
 */
const IDENT: [number, number, number, number] = [0, 0, 0, 1];
const SIM_DT = 1 / 120;
const SUBSTEPS = 8;
const mkLink = (): Link => ({ pos: [0, 0, 0], quat: [0, 0, 0, 1], vel: [0, 0, 0], angVel: [0, 0, 0] });

type LegBodies = { thigh: number; shank: number; thighCenter: V3; shankCenter: V3 };

export class HorseRagdoll {
  readonly spec: CreatureSpec;
  private world: any;
  private torso = 0;
  private legBodies: LegBodies[] = [];
  private all: number[] = [];
  private state: CreatureState;
  private phase = 0;
  private torques: Torque[] = [];
  private acc = 0;
  private spawnY: number;
  private neutralAction: Float32Array;

  constructor(box3d: any, spec: CreatureSpec, scale = 1) {
    setTuning(DEFAULT_TUNING);
    spec = scaledSpec(spec, scale);
    this.spec = spec;
    this.neutralAction = new Float32Array(actDim(spec));
    this.world = box3d.createWorld([0, -9.81, 0]);
    this.world.createBox({ type: BodyType.Static, position: [0, -20, 0], halfExtents: [60, 20, 60], friction: 1.0 });

    const l0 = spec.legs[0];
    const legLen = 2 * l0.thigh.halfHeight + 2 * l0.shank.halfHeight;
    this.spawnY = legLen + l0.shank.radius - l0.hip[1];

    this.torso = this.world.createBox({ type: BodyType.Dynamic, position: [0, this.spawnY, 0], halfExtents: spec.torso.half, density: spec.torso.density, friction: 0.7, bullet: true });
    for (const leg of spec.legs) {
      const hip: V3 = [leg.hip[0], this.spawnY + leg.hip[1], leg.hip[2]];
      const knee: V3 = [hip[0], hip[1] - 2 * leg.thigh.halfHeight, hip[2]];
      const thighCenter: V3 = [hip[0], hip[1] - leg.thigh.halfHeight, hip[2]];
      const shankCenter: V3 = [hip[0], knee[1] - leg.shank.halfHeight, hip[2]];
      const thigh = this.world.createCapsule({ type: BodyType.Dynamic, position: thighCenter, halfHeight: leg.thigh.halfHeight, radius: leg.thigh.radius, density: leg.thigh.density, friction: 0.8, bullet: true });
      const shank = this.world.createCapsule({ type: BodyType.Dynamic, position: shankCenter, halfHeight: leg.shank.halfHeight, radius: leg.shank.radius, density: leg.shank.density, friction: 1.3, bullet: true });
      this.world.createSphericalJoint(this.torso, thigh, hip, { hertz: 0, dampingRatio: 1.0 });
      this.world.createSphericalJoint(thigh, shank, knee, { hertz: 0, dampingRatio: 1.0 });
      this.legBodies.push({ thigh, shank, thighCenter, shankCenter });
    }
    this.all = [this.torso];
    for (const lb of this.legBodies) this.all.push(lb.thigh, lb.shank);

    this.state = { torso: mkLink(), legs: spec.legs.map(() => ({ thigh: mkLink(), shank: mkLink() }) as LegLinks), groundY: 0, goal: [0, 1], targetSpeed: 0.3 * Math.sqrt(9.81 * spec.standHeight) };
    this.syncState();
    this.settle(14);
  }

  setGoal(dx: number, dz: number): void {
    const m = Math.hypot(dx, dz) || 1;
    this.state.goal[0] = dx / m;
    this.state.goal[1] = dz / m;
  }

  setSpeed(nonDim: number): void {
    this.state.targetSpeed = nonDim * Math.sqrt(9.81 * this.spec.standHeight);
  }

  get speedUnit(): number { return Math.sqrt(9.81 * this.spec.standHeight); }

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

  private downed = false;
  setDowned(b: boolean): void { this.downed = b; }

  private stepOnce(): void {
    if (this.downed) {
      this.world.step(SIM_DT, SUBSTEPS);
      this.syncState();
      return;
    }
    this.phase = advancePhase(this.spec, this.state, this.phase, this.neutralAction, SIM_DT);
    decode(this.spec, this.neutralAction, this.state, this.phase, this.torques);
    this.applyTorques();
    this.world.step(SIM_DT, SUBSTEPS);
    this.syncState();
  }

  private applyTorques(): void {
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
  }

  private settle(steps: number): void {
    for (let i = 0; i < steps; i++) {
      decode(this.spec, this.neutralAction, this.state, this.phase, this.torques);
      this.applyTorques();
      this.world.step(SIM_DT, SUBSTEPS);
      this.syncState();
    }
  }

  update(dt: number): void {
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
    this.acc += Math.min(dt, 0.1);
    let n = 0;
    while (this.acc >= SIM_DT && n < 6) {
      this.stepOnce();
      this.acc -= SIM_DT;
      n++;
    }
  }

  get torsoLink(): Link { return this.state.torso; }
  get legLinks(): LegLinks[] { return this.state.legs; }
  get standY(): number { return this.spawnY; }
  get fallen(): boolean {
    const q = this.state.torso.quat;
    const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
    return upY < 0.3 || this.state.torso.pos[1] < this.spawnY * 0.34;
  }

  shove(vx: number, vz: number): void {
    const m = this.world.getBodyMass(this.torso);
    this.world.applyImpulse(this.torso, [vx * m, 0, vz * m]);
  }

  private jumpCooldown = 0;
  private _nose: V3 = [0, 0, 0];
  jump(): void {
    if (this.downed || this.jumpCooldown > 0) return;
    if (this.state.torso.pos[1] > this.spawnY * 1.25) return;
    const vUp = 0.95 * this.speedUnit;
    qRot(this.state.torso.quat, [0, 0, 1], this._nose);
    for (const h of this.all) {
      const m = this.world.getBodyMass(h);
      this.world.applyImpulse(h, [this._nose[0] * 0.25 * vUp * m, vUp * m, this._nose[2] * 0.25 * vUp * m]);
      this.world.setBodyAwake(h, true);
    }
    this.jumpCooldown = 0.8;
  }
  get grounded(): boolean { return this.state.torso.pos[1] < this.spawnY * 1.2; }

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
    this.settle(10);
  }

  dispose(): void {
    this.world.dispose?.();
  }
}
