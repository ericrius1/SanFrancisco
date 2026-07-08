import * as THREE from "three/webgpu";
import { BodyType, TRANSFORM_STRIDE } from "../core/physics";
import type { TransformBatch } from "../core/physics";
import type { Physics } from "../core/physics";

/**
 * Garry's-Mod-style physics toys, powered by box3d joints.
 *
 *  - Ropes: the rope click-tool ties any two things together — toys, traffic,
 *    debris-free walls, the ground. Each rope is a chain of capsule bodies
 *    linked by spherical joints, so it sags, swings, snags and tows for real.
 *    Tying a crate to a bus bumper does exactly what you hope it does.
 *  - Grabber: the grab click-tool is a tractor beam. Hold the button to yank
 *    whatever it lands on to a point in front of the camera, carry it around,
 *    and flick the view (or just let go) to throw it.
 *
 * Bodies owned by other systems can vanish under us (zones retire, traffic
 * despawns), and box3d frees a body's joints with it — destroying our stored
 * joint handle afterwards would double-free. Owners call severBody()/dropIf()
 * through their onWillRemoveBody hooks BEFORE destroying the body, so ropes
 * detach while every handle is still alive.
 */

/** Something the rope/grab ray can land on. `r` is a generous hit-sphere. */
export type PickCandidate = { handle: number; x: number; y: number; z: number; r: number };

type RopeEnd = {
  handle: number;
  /** static anchors are ours to destroy with the rope; body ends belong to others */
  ownedStatic: boolean;
};

type Rope = {
  ends: [RopeEnd, RopeEnd];
  segments: number[];
  joints: number[];
};

const MAX_ROPES = 10;
const MAX_TOTAL_SEGS = 170;
const SEG_LEN = 0.62;
const SEG_RADIUS = 0.055;
const ROPE_MIN = 0.9;
const ROPE_MAX = 42;
const ROPE_DROP = 300; // a rope this far behind the player quietly unties itself

const upAxis = new THREE.Vector3(0, 1, 0);
const segDir = new THREE.Vector3();
const segQuat = new THREE.Quaternion();
const scratch = new THREE.Vector3();

/** Nearest candidate hit along the ray (sphere test), or null. */
export function pickBody(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  candidates: PickCandidate[]
): { handle: number; point: THREE.Vector3; dist: number } | null {
  let best: { handle: number; point: THREE.Vector3; dist: number } | null = null;
  for (const c of candidates) {
    const ox = c.x - origin.x;
    const oy = c.y - origin.y;
    const oz = c.z - origin.z;
    const t = ox * dir.x + oy * dir.y + oz * dir.z; // closest approach along the ray
    if (t < 0 || t > maxDist) continue;
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    const miss = Math.hypot(px - c.x, py - c.y, pz - c.z);
    if (miss > c.r) continue;
    if (!best || t < best.dist) {
      // anchor on the body's near surface, not its centre — a rope tied to a
      // bus corner torques the bus like it should
      const point = new THREE.Vector3(px - c.x, py - c.y, pz - c.z);
      if (point.lengthSq() > 1e-6) point.clampLength(0, c.r * 0.6);
      point.add(scratch.set(c.x, c.y, c.z));
      best = { handle: c.handle, point, dist: t };
    }
  }
  return best;
}

export class Ropes {
  #physics: Physics;
  #ropes: Rope[] = [];
  #mesh: THREE.InstancedMesh;
  #batch: TransformBatch | null = null;
  #batchDirty = true;
  #zeroG = false;
  #dropTimer = 0;

  /** First click of the rope tool: where the pending end is tied. */
  #pending: { end: RopeEnd; point: THREE.Vector3 } | null = null;
  #pendingMarker: THREE.Mesh;

  #tmpMat = new THREE.Matrix4();
  #tmpPos = new THREE.Vector3();
  #tmpQuat = new THREE.Quaternion();
  #tmpScale = new THREE.Vector3();

  constructor(physics: Physics, scene: THREE.Scene) {
    this.#physics = physics;
    // a unit-length cylinder: per-instance Y scale stretches it to SEG_LEN
    const geo = new THREE.CylinderGeometry(SEG_RADIUS * 1.35, SEG_RADIUS * 1.35, 1, 6, 1);
    const mat = new THREE.MeshStandardMaterial({ color: "#c9a86b", roughness: 0.85 });
    this.#mesh = new THREE.InstancedMesh(geo, mat, MAX_TOTAL_SEGS);
    this.#mesh.count = 0;
    this.#mesh.castShadow = true;
    this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh.frustumCulled = false;
    scene.add(this.#mesh);

    // pulsing knot where the first rope end is waiting for its partner
    this.#pendingMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      new THREE.MeshBasicMaterial({ color: "#ffd76a", transparent: true, opacity: 0.9 })
    );
    this.#pendingMarker.visible = false;
    scene.add(this.#pendingMarker);
  }

  get count() {
    return this.#ropes.length;
  }

  #totalSegs() {
    let n = 0;
    for (const r of this.#ropes) n += r.segments.length;
    return n;
  }

  /**
   * One rope-tool click. First click stakes an end (body under the ray, else
   * the wall/ground the world ray hits); the second click ties the rope.
   * Returns the HUD line describing what happened.
   */
  toolClick(origin: THREE.Vector3, dir: THREE.Vector3, candidates: PickCandidate[]): string {
    const end = this.#resolveEnd(origin, dir, candidates);
    if (!end) return this.#pending ? "Rope: no anchor there — try a toy, car or wall" : "Rope: nothing to tie there";
    if (!this.#pending) {
      this.#pending = end;
      this.#pendingMarker.position.copy(end.point);
      this.#pendingMarker.visible = true;
      return "Rope tied — now click the other end";
    }
    const a = this.#pending;
    this.#pending = null;
    this.#pendingMarker.visible = false;
    if (a.end.handle === end.end.handle) {
      this.#discardEnd(a.end);
      this.#discardEnd(end.end);
      return "Rope: both ends on the same thing — untied";
    }
    const msg = this.#createRope(a, end);
    if (msg) {
      // rope refused: give back any static anchors the two clicks conjured
      this.#discardEnd(a.end);
      this.#discardEnd(end.end);
      return msg;
    }
    return "Tied!";
  }

  /** A body (else the static world) under the ray, as a rope end. */
  #resolveEnd(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    candidates: PickCandidate[]
  ): { end: RopeEnd; point: THREE.Vector3 } | null {
    const body = pickBody(origin, dir, ROPE_MAX + 12, candidates);
    const world = this.#physics.raycastWorld(origin, dir, ROPE_MAX + 12);
    if (body && (!world || body.dist < world.point.distanceTo(origin))) {
      return { end: { handle: body.handle, ownedStatic: false }, point: body.point };
    }
    if (world && world.kind !== "water") {
      // a fist-sized static block just under the surface holds the rope end
      const p = world.point.clone().addScaledVector(world.normal, -0.06);
      const handle = this.#physics.world.createBox({
        type: BodyType.Static,
        position: [p.x, p.y, p.z],
        halfExtents: [0.12, 0.12, 0.12],
        friction: 0.6
      });
      return { end: { handle, ownedStatic: true }, point: world.point.clone() };
    }
    return null;
  }

  #discardEnd(end: RopeEnd) {
    if (end.ownedStatic) this.#physics.world.destroyBody(end.handle);
  }

  /** Chain capsules between the two anchors. Returns an error line, or null on success. */
  #createRope(a: { end: RopeEnd; point: THREE.Vector3 }, b: { end: RopeEnd; point: THREE.Vector3 }): string | null {
    if (this.#ropes.length >= MAX_ROPES) return "Rope: out of rope!";
    const dist = a.point.distanceTo(b.point);
    if (dist < ROPE_MIN) return "Rope: ends too close together";
    if (dist > ROPE_MAX) return "Rope: too far apart";
    const segs = Math.max(2, Math.round((dist * 1.04) / SEG_LEN)); // 4% slack so it hangs
    if (this.#totalSegs() + segs > MAX_TOTAL_SEGS) return "Rope: out of rope!";

    const w = this.#physics.world;
    const rope: Rope = { ends: [a.end, b.end], segments: [], joints: [] };
    const segLen = dist / segs; // spawn taut; the 4% extra length appears as joint slack
    segDir.copy(b.point).sub(a.point).divideScalar(dist);
    segQuat.setFromUnitVectors(upAxis, segDir).normalize(); // box3d traps on |q| != 1

    for (let i = 0; i < segs; i++) {
      const cx = a.point.x + segDir.x * segLen * (i + 0.5);
      const cy = a.point.y + segDir.y * segLen * (i + 0.5);
      const cz = a.point.z + segDir.z * segLen * (i + 0.5);
      const handle = w.createCapsule({
        type: BodyType.Dynamic,
        position: [cx, cy, cz],
        halfHeight: Math.max(0.02, segLen / 2 - SEG_RADIUS),
        radius: SEG_RADIUS,
        density: 0.6,
        friction: 0.5,
        restitution: 0.05
      });
      w.setBodyTransform(handle, [cx, cy, cz], [segQuat.x, segQuat.y, segQuat.z, segQuat.w]);
      if (this.#zeroG) w.setBodyGravityScale(handle, 0);
      rope.segments.push(handle);
    }
    // anchors: end bodies to the first/last segment, spherical links between the rest
    rope.joints.push(w.createSphericalJoint(a.end.handle, rope.segments[0], [a.point.x, a.point.y, a.point.z]));
    for (let i = 0; i < segs - 1; i++) {
      const jx = a.point.x + segDir.x * segLen * (i + 1);
      const jy = a.point.y + segDir.y * segLen * (i + 1);
      const jz = a.point.z + segDir.z * segLen * (i + 1);
      rope.joints.push(w.createSphericalJoint(rope.segments[i], rope.segments[i + 1], [jx, jy, jz]));
    }
    rope.joints.push(
      w.createSphericalJoint(rope.segments[segs - 1], b.end.handle, [b.point.x, b.point.y, b.point.z])
    );
    this.#ropes.push(rope);
    this.#batchDirty = true;
    return null;
  }

  #destroyRope(rope: Rope, skipHandle = -1) {
    const w = this.#physics.world;
    for (const j of rope.joints) w.destroyJoint(j); // always before any body they bind
    for (const s of rope.segments) w.destroyBody(s);
    for (const end of rope.ends) {
      if (end.ownedStatic && end.handle !== skipHandle) w.destroyBody(end.handle);
    }
    this.#batchDirty = true;
  }

  /** An external body is about to be destroyed: cut every rope tied to it, joints first. */
  severBody(handle: number) {
    for (let i = this.#ropes.length - 1; i >= 0; i--) {
      const rope = this.#ropes[i];
      if (rope.ends[0].handle === handle || rope.ends[1].handle === handle) {
        this.#destroyRope(rope, handle);
        this.#ropes.splice(i, 1);
      }
    }
    if (this.#pending?.end.handle === handle) {
      this.#pending = null;
      this.#pendingMarker.visible = false;
    }
  }

  clearAll() {
    for (const rope of this.#ropes) this.#destroyRope(rope);
    this.#ropes.length = 0;
    if (this.#pending) {
      this.#discardEnd(this.#pending.end);
      this.#pending = null;
    }
    this.#pendingMarker.visible = false;
  }

  setZeroG(on: boolean) {
    this.#zeroG = on;
    const w = this.#physics.world;
    for (const rope of this.#ropes) {
      for (const s of rope.segments) {
        w.setBodyGravityScale(s, on ? 0 : 1);
        w.setBodyAwake(s, true);
      }
    }
  }

  update(dt: number, playerPos: THREE.Vector3, elapsed: number) {
    this.#pendingMarker.visible = this.#pending !== null;
    if (this.#pending) {
      const s = 1 + Math.sin(elapsed * 8) * 0.25;
      this.#pendingMarker.scale.setScalar(s);
    }

    // untie ropes left far behind (their anchor bodies may be about to despawn anyway)
    this.#dropTimer -= dt;
    if (this.#dropTimer <= 0) {
      this.#dropTimer = 1.1;
      for (let i = this.#ropes.length - 1; i >= 0; i--) {
        const rope = this.#ropes[i];
        const mid = rope.segments[rope.segments.length >> 1];
        const t = this.#physics.world.getBodyTransform(mid);
        if (Math.hypot(t.position[0] - playerPos.x, t.position[2] - playerPos.z) > ROPE_DROP) {
          this.#destroyRope(rope);
          this.#ropes.splice(i, 1);
        }
      }
    }

    if (this.#batchDirty) {
      this.#batch?.dispose();
      const handles: number[] = [];
      for (const rope of this.#ropes) handles.push(...rope.segments);
      this.#batch = handles.length ? this.#physics.world.createTransformBatch(handles) : null;
      this.#batchDirty = false;
    }
    if (!this.#batch) {
      this.#mesh.count = 0;
      return;
    }
    const data = this.#batch.read();
    let i = 0;
    for (const rope of this.#ropes) {
      const segLen = SEG_LEN; // visual: slight overlap at joints hides the gaps
      for (let s = 0; s < rope.segments.length; s++) {
        const o = i * TRANSFORM_STRIDE;
        this.#tmpPos.set(data[o], data[o + 1], data[o + 2]);
        this.#tmpQuat.set(data[o + 3], data[o + 4], data[o + 5], data[o + 6]);
        this.#tmpMat.compose(this.#tmpPos, this.#tmpQuat, this.#tmpScale.set(1, segLen * 1.18, 1));
        this.#mesh.setMatrixAt(i, this.#tmpMat);
        i++;
      }
    }
    this.#mesh.count = i;
    this.#mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * The grab tool: hold the button to tractor-beam a body to a point in front
 * of the camera; release to drop it with whatever momentum the carry gave it
 * (flick the camera to throw). Velocity-servo, not a joint — it can't get
 * into a fight with the solver, and mass never matters, so a muni bus floats
 * over as happily as a crate.
 */
export class Grabber {
  #physics: Physics;
  #held = -1;
  #holdDist = 6;
  #beam: THREE.Line;
  #beamGeo: THREE.BufferGeometry;

  #target = new THREE.Vector3();
  #vel = new THREE.Vector3();

  constructor(physics: Physics, scene: THREE.Scene) {
    this.#physics = physics;
    this.#beamGeo = new THREE.BufferGeometry();
    this.#beamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    this.#beam = new THREE.Line(
      this.#beamGeo,
      new THREE.LineBasicMaterial({ color: 0x7df1ff, transparent: true, opacity: 0.75 })
    );
    this.#beam.frustumCulled = false;
    this.#beam.visible = false;
    scene.add(this.#beam);
  }

  get holding() {
    return this.#held !== -1;
  }

  /** Try to latch onto whatever the ray hits. Returns true if something was caught. */
  tryGrab(origin: THREE.Vector3, dir: THREE.Vector3, candidates: PickCandidate[]): boolean {
    const hit = pickBody(origin, dir, 46, candidates);
    if (!hit) return false;
    this.#held = hit.handle;
    this.#holdDist = THREE.MathUtils.clamp(hit.dist, 3.5, 11);
    return true;
  }

  /** Drop with the carry momentum plus a friendly toss along the view. */
  release(dir?: THREE.Vector3) {
    if (this.#held === -1) return;
    if (dir) {
      const v = this.#physics.world.getBodyVelocity(this.#held);
      this.#physics.world.setBodyVelocity(
        this.#held,
        [v.linear[0] + dir.x * 5, v.linear[1] + dir.y * 5 + 1.2, v.linear[2] + dir.z * 5],
        v.angular
      );
    }
    this.#held = -1;
    this.#beam.visible = false;
  }

  /** The held body is about to be destroyed elsewhere — let go without touching it. */
  dropIf(handle: number) {
    if (this.#held === handle) {
      this.#held = -1;
      this.#beam.visible = false;
    }
  }

  update(origin: THREE.Vector3, dir: THREE.Vector3) {
    if (this.#held === -1) return;
    const w = this.#physics.world;
    this.#target.copy(origin).addScaledVector(dir, this.#holdDist);
    const t = w.getBodyTransform(this.#held);
    this.#vel.set(
      this.#target.x - t.position[0],
      this.#target.y - t.position[1],
      this.#target.z - t.position[2]
    );
    // proportional servo with a speed ceiling: snappy carry, no orbiting
    this.#vel.multiplyScalar(10);
    const speed = this.#vel.length();
    if (speed > 32) this.#vel.multiplyScalar(32 / speed);
    const av = w.getBodyVelocity(this.#held).angular;
    w.setBodyVelocity(this.#held, [this.#vel.x, this.#vel.y, this.#vel.z], [av[0] * 0.92, av[1] * 0.92, av[2] * 0.92]);
    w.setBodyAwake(this.#held, true);

    const arr = (this.#beamGeo.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    arr[0] = origin.x + dir.x * 0.8;
    arr[1] = origin.y + dir.y * 0.8 - 0.25;
    arr[2] = origin.z + dir.z * 0.8;
    arr[3] = t.position[0];
    arr[4] = t.position[1];
    arr[5] = t.position[2];
    (this.#beamGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.#beam.visible = true;
  }
}
