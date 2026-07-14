// Facade over box3d.js (isaac-mason/box3d.js) that reproduces the exact public
// surface the app previously consumed from the vendored `box3d-wasm` wrapper.
//
// box3d.js mirrors the box3d C API 1:1 through an embind module, so its handles
// are value objects ({index1, world0, generation}) rather than the integer
// handles the rest of the app keys Maps/Sets/arrays on. This module bridges the
// two: every body/joint gets a small integer handle, and a reverse index maps a
// body id back to its handle so contact-hit events can name the bodies involved.
//
// Behaviour, units, defaults, quaternion convention ([x,y,z,w] arrays at the
// facade boundary; box3d's internal {v,s} form stays inside), the 1/60 fixed
// step and the ragdoll bone layout are all kept identical to the old wrapper.

import { tracer } from "./hitchTracer";
import type {
  Box3DModule,
  b3BodyId,
  b3JointId,
  b3WorldId,
  b3ShapeId,
  b3MeshData,
  b3Quat,
  b3Vec3,
  b3BodyType,
  b3QueryFilter
} from "box3d.js";

// 64-bit "all categories" mask — the default query reach when a cast doesn't
// restrict which proxy categories it may strike.
const ALL_MASK = 0xffffffffffffffffn;

export const BodyType = {
  Static: 0,
  Kinematic: 1,
  Dynamic: 2
} as const;
export type BodyTypeValue = (typeof BodyType)[keyof typeof BodyType];

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
export type Transform = {
  position: [number, number, number];
  rotation: [number, number, number, number];
};
export type BodyVelocity = {
  linear: [number, number, number];
  angular: [number, number, number];
};

export type BoxOptions = {
  type: BodyTypeValue;
  position: Vec3;
  halfExtents: Vec3;
  density?: number;
  friction?: number;
  restitution?: number;
  rollingResistance?: number;
  bullet?: boolean;
  /** Collision/query category bits for this shape (default 1). Lets query-only
   * worlds tag proxies so a cast's maskBits can include/exclude them. */
  categoryBits?: bigint;
};
export type StaticMeshOptions = {
  /** World transform of the mesh's local-space vertices. */
  position: Vec3;
  /** Flat local-space xyz triples. */
  vertices: ArrayLike<number>;
  /** Flat triangle indices. */
  indices: ArrayLike<number>;
  friction?: number;
  restitution?: number;
  categoryBits?: bigint;
};
export type SphereOptions = {
  type: BodyTypeValue;
  position: Vec3;
  radius: number;
  density?: number;
  friction?: number;
  restitution?: number;
  rollingResistance?: number;
  bullet?: boolean;
  categoryBits?: bigint;
};
export type CapsuleOptions = {
  type: BodyTypeValue;
  position: Vec3;
  halfHeight: number;
  radius: number;
  density?: number;
  friction?: number;
  restitution?: number;
  rollingResistance?: number;
  bullet?: boolean;
  categoryBits?: bigint;
};

/** One closest-hit result from PhysicsWorld.castRayClosest, in scalar form to
 * avoid per-cast allocations. `handle` is the app body handle that was struck. */
export type RayCastHit = {
  handle: number;
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
  distance: number;
};
export type JointSpringOptions = { hertz?: number; dampingRatio?: number };
export type DistanceJointOptions = JointSpringOptions & { length?: number };
export type CapsuleShape = {
  center1: [number, number, number];
  center2: [number, number, number];
  radius: number;
};
export type HumanRagdoll = { human: number; bones: number[] };
export type HumanOptions = { frictionTorque?: number; hertz?: number; dampingRatio?: number };

/** Floats per body in a TransformBatch read: px py pz qx qy qz qw awake. */
export const TRANSFORM_STRIDE = 8;

const IDENTITY_QUAT: b3Quat = { v: { x: 0, y: 0, z: 0 }, s: 1 };

function bodyKey(id: b3BodyId): string {
  return `${id.index1}:${id.world0}:${id.generation}`;
}

function normQuat(x: number, y: number, z: number, w: number): b3Quat {
  const len = Math.hypot(x, y, z, w) || 1;
  return { v: { x: x / len, y: y / len, z: z / len }, s: w / len };
}

/**
 * Reads transforms for a fixed set of bodies. The old wrapper did this in a
 * single WASM call; box3d.js has no batched reader, so this loops the per-body
 * getter into an owned buffer. Layout is identical: px py pz qx qy qz qw awake.
 */
export class TransformBatch {
  readonly count: number;
  #world: PhysicsWorld;
  #handles: number[];
  #buffer: Float32Array;
  #disposed = false;

  constructor(world: PhysicsWorld, handles: ArrayLike<number>) {
    this.#world = world;
    this.#handles = Array.from(handles);
    this.count = this.#handles.length;
    this.#buffer = new Float32Array(Math.max(1, this.count) * TRANSFORM_STRIDE);
  }

  read(): Float32Array {
    if (this.#disposed) throw new Error("TransformBatch has been disposed");
    this.#world._fillTransforms(this.#handles, this.#buffer);
    return this.#buffer.subarray(0, this.count * TRANSFORM_STRIDE);
  }

  dispose(): void {
    this.#disposed = true;
  }
}

export class Box3D {
  readonly module: Box3DModule;
  constructor(module: Box3DModule) {
    this.module = module;
  }
  createWorld(gravity: Vec3 = [0, -10, 0]): PhysicsWorld {
    const def = this.module.b3DefaultWorldDef();
    def.gravity = { x: gravity[0], y: gravity[1], z: gravity[2] };
    def.workerCount = 1;
    const worldId = this.module.b3CreateWorld(def);
    return new PhysicsWorld(this.module, worldId);
  }
  getWorldCount(): number {
    return this.module.b3GetWorldCount();
  }
}

export class PhysicsWorld {
  readonly fixedTimeStep = 1 / 60;
  readonly substeps = 4;

  #m: Box3DModule;
  #world: b3WorldId;
  #types: [b3BodyType, b3BodyType, b3BodyType];
  #bodies = new Map<number, b3BodyId>();
  // Triangle-mesh shapes retain their b3MeshData pointer for their whole
  // lifetime. Keep it beside the owning body and free it immediately after the
  // body/shape is destroyed (hull data, by contrast, is copied at creation).
  #meshes = new Map<number, b3MeshData>();
  #joints = new Map<number, b3JointId>();
  #keyToHandle = new Map<string, number>();
  #handleKey = new Map<number, string>();
  #next = 1;
  #humanGroup = 0;

  // reused scratch for castRayClosest — one query filter + two vec3s, mutated
  // per call so casting many rays a frame allocates nothing on our side
  #queryFilter?: b3QueryFilter;
  #rayOrigin: b3Vec3 = { x: 0, y: 0, z: 0 };
  #rayEnd: b3Vec3 = { x: 0, y: 0, z: 0 };

  constructor(module: Box3DModule, world: b3WorldId) {
    this.#m = module;
    this.#world = world;
    this.#types = [
      module.b3BodyType.b3_staticBody,
      module.b3BodyType.b3_kinematicBody,
      module.b3BodyType.b3_dynamicBody
    ];
  }

  // -- handle bookkeeping ---------------------------------------------------

  #register(id: b3BodyId): number {
    const handle = this.#next++;
    this.#bodies.set(handle, id);
    const key = bodyKey(id);
    this.#keyToHandle.set(key, handle);
    this.#handleKey.set(handle, key);
    return handle;
  }

  #body(handle: number): b3BodyId | undefined {
    return this.#bodies.get(handle);
  }

  // -- body creation --------------------------------------------------------

  createBox(options: BoxOptions): number {
    const m = this.#m;
    const dynamic = options.type === BodyType.Dynamic;
    const bd = m.b3DefaultBodyDef();
    bd.type = this.#types[options.type];
    bd.position = { x: options.position[0], y: options.position[1], z: options.position[2] };
    bd.isBullet = !!options.bullet;
    const id = m.b3CreateBody(this.#world, bd);
    const sd = m.b3DefaultShapeDef();
    sd.density = options.density ?? (dynamic ? 1 : 0);
    sd.baseMaterial.friction = options.friction ?? 0.55;
    sd.baseMaterial.restitution = options.restitution ?? 0.05;
    sd.baseMaterial.rollingResistance = options.rollingResistance ?? 0;
    if (options.categoryBits !== undefined) sd.filter.categoryBits = options.categoryBits;
    m.b3CreateBoxShape(id, sd, options.halfExtents[0], options.halfExtents[1], options.halfExtents[2]);
    tracer.count("bodyCreate"); // spike attribution: body churn shows on hitch frames
    return this.#register(id);
  }

  /** Create a static triangle mesh. Intended for footprint-faithful level
   * geometry (roofs/terrain), not moving bodies. The mesh data must outlive the
   * shape, so this facade owns and releases it with the returned body handle. */
  createStaticMesh(options: StaticMeshOptions): number {
    const m = this.#m;
    const vertices = Float32Array.from(options.vertices);
    const indices = Uint32Array.from(options.indices);
    if (vertices.length < 9 || vertices.length % 3 !== 0 || indices.length < 3 || indices.length % 3 !== 0) {
      throw new Error("Static mesh needs xyz vertices and triangle indices");
    }

    const mesh = m.b3CreateMesh(vertices, indices);
    if (!mesh) throw new Error("Box3D rejected static mesh geometry");

    const bd = m.b3DefaultBodyDef();
    bd.type = this.#types[BodyType.Static];
    bd.position = { x: options.position[0], y: options.position[1], z: options.position[2] };
    const id = m.b3CreateBody(this.#world, bd);
    const sd = m.b3DefaultShapeDef();
    sd.baseMaterial.friction = options.friction ?? 0.55;
    sd.baseMaterial.restitution = options.restitution ?? 0.05;
    if (options.categoryBits !== undefined) sd.filter.categoryBits = options.categoryBits;

    try {
      m.b3CreateMeshShape(id, sd, mesh, { x: 1, y: 1, z: 1 });
    } catch (error) {
      m.b3DestroyBody(id);
      m.b3DestroyMesh(mesh);
      throw error;
    }

    tracer.count("bodyCreate");
    const handle = this.#register(id);
    this.#meshes.set(handle, mesh);
    return handle;
  }

  createSphere(options: SphereOptions): number {
    const m = this.#m;
    const dynamic = options.type === BodyType.Dynamic;
    const bd = m.b3DefaultBodyDef();
    bd.type = this.#types[options.type];
    bd.position = { x: options.position[0], y: options.position[1], z: options.position[2] };
    bd.isBullet = !!options.bullet;
    bd.allowFastRotation = true;
    const id = m.b3CreateBody(this.#world, bd);
    const sd = m.b3DefaultShapeDef();
    sd.density = options.density ?? (dynamic ? 1 : 0);
    sd.baseMaterial.friction = options.friction ?? 0.35;
    sd.baseMaterial.restitution = options.restitution ?? 0.25;
    sd.baseMaterial.rollingResistance = options.rollingResistance ?? 0.02;
    if (options.categoryBits !== undefined) sd.filter.categoryBits = options.categoryBits;
    m.b3CreateSphereShape(id, sd, { center: { x: 0, y: 0, z: 0 }, radius: options.radius });
    return this.#register(id);
  }

  createCapsule(options: CapsuleOptions): number {
    const m = this.#m;
    const dynamic = options.type === BodyType.Dynamic;
    const bd = m.b3DefaultBodyDef();
    bd.type = this.#types[options.type];
    bd.position = { x: options.position[0], y: options.position[1], z: options.position[2] };
    bd.isBullet = !!options.bullet;
    const id = m.b3CreateBody(this.#world, bd);
    const sd = m.b3DefaultShapeDef();
    sd.density = options.density ?? (dynamic ? 1 : 0);
    sd.baseMaterial.friction = options.friction ?? 0.45;
    sd.baseMaterial.restitution = options.restitution ?? 0.1;
    sd.baseMaterial.rollingResistance = options.rollingResistance ?? 0.02;
    if (options.categoryBits !== undefined) sd.filter.categoryBits = options.categoryBits;
    const hh = options.halfHeight;
    m.b3CreateCapsuleShape(id, sd, {
      center1: { x: 0, y: -hh, z: 0 },
      center2: { x: 0, y: hh, z: 0 },
      radius: options.radius
    });
    return this.#register(id);
  }

  destroyBody(bodyHandle: number): void {
    const id = this.#body(bodyHandle);
    if (!id) return;
    // box3d destroys joints attached to a body automatically; the app's own
    // notify-before-remove / joints-before-bodies ordering is preserved by
    // callers, and destroyJoint below guards against already-freed joints.
    tracer.count("bodyDestroy");
    this.#m.b3DestroyBody(id);
    const mesh = this.#meshes.get(bodyHandle);
    if (mesh) {
      this.#m.b3DestroyMesh(mesh);
      this.#meshes.delete(bodyHandle);
    }
    this.#bodies.delete(bodyHandle);
    const key = this.#handleKey.get(bodyHandle);
    if (key !== undefined) {
      this.#handleKey.delete(bodyHandle);
      if (this.#keyToHandle.get(key) === bodyHandle) this.#keyToHandle.delete(key);
    }
  }

  // -- stepping -------------------------------------------------------------

  step(timeStep: number = this.fixedTimeStep, substeps: number = this.substeps): void {
    this.#m.b3World_Step(this.#world, timeStep, substeps);
  }

  // -- spatial queries ------------------------------------------------------

  /**
   * Closest-hit ray cast through the broadphase (box3d's "Cast Ray"): from
   * `origin` along the unit `dir` for up to `maxDist` metres. `maskBits` selects
   * which shape categories are eligible (default: all). Returns the struck app
   * body handle plus the world hit point/normal, or null on a miss.
   *
   * Broadphase-accelerated and narrow-phased against the real shapes, so a
   * query-only world (never stepped) still answers correctly — b3Body_SetTransform
   * moves each proxy's broadphase AABB immediately (vendor box3d body.c).
   */
  castRayClosest(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    maskBits?: bigint,
    out?: RayCastHit
  ): RayCastHit | null {
    const m = this.#m;
    const filter = (this.#queryFilter ??= m.b3DefaultQueryFilter());
    filter.maskBits = maskBits ?? ALL_MASK;
    this.#rayOrigin.x = ox;
    this.#rayOrigin.y = oy;
    this.#rayOrigin.z = oz;
    this.#rayEnd.x = dx * maxDist;
    this.#rayEnd.y = dy * maxDist;
    this.#rayEnd.z = dz * maxDist;
    const res = m.b3World_CastRayClosest(this.#world, this.#rayOrigin, this.#rayEnd, filter);
    if (!res.hit) return null;
    const hit = out ?? { handle: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, distance: 0 };
    hit.handle = this.#handleForShapeBody(res.shapeId);
    hit.px = res.point.x;
    hit.py = res.point.y;
    hit.pz = res.point.z;
    hit.nx = res.normal.x;
    hit.ny = res.normal.y;
    hit.nz = res.normal.z;
    hit.distance = res.fraction * maxDist;
    return hit;
  }

  // -- transforms & velocity ------------------------------------------------

  setBodyTransform(bodyHandle: number, position: Vec3, rotation: Quat = [0, 0, 0, 1]): void {
    const id = this.#body(bodyHandle);
    if (!id) return;
    this.#m.b3Body_SetTransform(
      id,
      { x: position[0], y: position[1], z: position[2] },
      { v: { x: rotation[0], y: rotation[1], z: rotation[2] }, s: rotation[3] }
    );
  }

  setBodyVelocity(bodyHandle: number, linear: Vec3, angular: Vec3 = [0, 0, 0]): void {
    const id = this.#body(bodyHandle);
    if (!id) return;
    this.#m.b3Body_SetLinearVelocity(id, { x: linear[0], y: linear[1], z: linear[2] });
    this.#m.b3Body_SetAngularVelocity(id, { x: angular[0], y: angular[1], z: angular[2] });
  }

  getBodyTransform(bodyHandle: number, target?: Transform): Transform {
    const result = target ?? { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
    const id = this.#body(bodyHandle);
    if (!id) {
      result.position[0] = result.position[1] = result.position[2] = 0;
      result.rotation[0] = result.rotation[1] = result.rotation[2] = 0;
      result.rotation[3] = 1;
      return result;
    }
    const t = this.#m.b3Body_GetTransform(id);
    result.position[0] = t.p.x;
    result.position[1] = t.p.y;
    result.position[2] = t.p.z;
    result.rotation[0] = t.q.v.x;
    result.rotation[1] = t.q.v.y;
    result.rotation[2] = t.q.v.z;
    result.rotation[3] = t.q.s;
    return result;
  }

  getBodyVelocity(bodyHandle: number, target?: BodyVelocity): BodyVelocity {
    const result = target ?? { linear: [0, 0, 0], angular: [0, 0, 0] };
    const id = this.#body(bodyHandle);
    if (!id) {
      result.linear[0] = result.linear[1] = result.linear[2] = 0;
      result.angular[0] = result.angular[1] = result.angular[2] = 0;
      return result;
    }
    const v = this.#m.b3Body_GetLinearVelocity(id);
    const w = this.#m.b3Body_GetAngularVelocity(id);
    result.linear[0] = v.x;
    result.linear[1] = v.y;
    result.linear[2] = v.z;
    result.angular[0] = w.x;
    result.angular[1] = w.y;
    result.angular[2] = w.z;
    return result;
  }

  /**
   * Internal: fill a stride-8 buffer for a set of handles (TransformBatch).
   * Only px..qw (indices 0..6) are written; index 7 (the old awake flag) is
   * unused by every consumer, so it is left at the buffer's zero-init value
   * rather than paying a b3Body_IsAwake call per body every frame.
   */
  _fillTransforms(handles: number[], out: Float32Array): void {
    const m = this.#m;
    for (let i = 0; i < handles.length; i++) {
      const o = i * TRANSFORM_STRIDE;
      const id = this.#bodies.get(handles[i]);
      if (!id) {
        out[o] = out[o + 1] = out[o + 2] = 0;
        out[o + 3] = out[o + 4] = out[o + 5] = 0;
        out[o + 6] = 1;
        continue;
      }
      const t = m.b3Body_GetTransform(id);
      out[o] = t.p.x;
      out[o + 1] = t.p.y;
      out[o + 2] = t.p.z;
      out[o + 3] = t.q.v.x;
      out[o + 4] = t.q.v.y;
      out[o + 5] = t.q.v.z;
      out[o + 6] = t.q.s;
    }
  }

  createTransformBatch(handles: ArrayLike<number>): TransformBatch {
    return new TransformBatch(this, handles);
  }

  // -- forces / impulses ----------------------------------------------------

  applyImpulse(bodyHandle: number, impulse: Vec3): void {
    const id = this.#body(bodyHandle);
    if (!id) return;
    this.#m.b3Body_ApplyLinearImpulseToCenter(id, { x: impulse[0], y: impulse[1], z: impulse[2] }, true);
  }

  applyImpulseAtPoint(bodyHandle: number, impulse: Vec3, worldPoint: Vec3): void {
    const id = this.#body(bodyHandle);
    if (!id) return;
    this.#m.b3Body_ApplyLinearImpulse(
      id,
      { x: impulse[0], y: impulse[1], z: impulse[2] },
      { x: worldPoint[0], y: worldPoint[1], z: worldPoint[2] },
      true
    );
  }

  applyAngularImpulse(bodyHandle: number, impulse: Vec3): void {
    const id = this.#body(bodyHandle);
    if (!id) return;
    this.#m.b3Body_ApplyAngularImpulse(id, { x: impulse[0], y: impulse[1], z: impulse[2] }, true);
  }

  applyForce(bodyHandle: number, force: Vec3): void {
    const id = this.#body(bodyHandle);
    if (!id) return;
    this.#m.b3Body_ApplyForceToCenter(id, { x: force[0], y: force[1], z: force[2] }, true);
  }

  explode(position: Vec3, radius: number, falloff: number, impulsePerArea: number): void {
    const def = this.#m.b3DefaultExplosionDef();
    def.position = { x: position[0], y: position[1], z: position[2] };
    def.radius = radius;
    def.falloff = falloff;
    def.impulsePerArea = impulsePerArea;
    this.#m.b3World_Explode(this.#world, def);
  }

  // -- body queries / state -------------------------------------------------

  getBodySpeed(bodyHandle: number): number {
    const id = this.#body(bodyHandle);
    if (!id) return 0;
    const v = this.#m.b3Body_GetLinearVelocity(id);
    return Math.hypot(v.x, v.y, v.z);
  }

  getBodyMass(bodyHandle: number): number {
    const id = this.#body(bodyHandle);
    if (!id) return 0;
    return this.#m.b3Body_GetMass(id);
  }

  setBodyAwake(bodyHandle: number, awake: boolean): void {
    const id = this.#body(bodyHandle);
    if (!id) return;
    this.#m.b3Body_SetAwake(id, awake);
  }

  isBodyAwake(bodyHandle: number): boolean {
    const id = this.#body(bodyHandle);
    if (!id) return false;
    return this.#m.b3Body_IsAwake(id);
  }

  setBodyGravityScale(bodyHandle: number, scale: number): void {
    const id = this.#body(bodyHandle);
    if (!id) return;
    this.#m.b3Body_SetGravityScale(id, scale);
  }

  #handleForShapeBody(shapeId: b3ShapeId): number {
    const body = this.#m.b3Shape_GetBody(shapeId);
    return this.#keyToHandle.get(bodyKey(body)) ?? 0;
  }

  // -- capsule readback -----------------------------------------------------

  getBodyCapsule(bodyHandle: number): CapsuleShape | undefined {
    const id = this.#body(bodyHandle);
    if (!id) return undefined;
    const shapes = this.#m.b3Body_GetShapes(id);
    try {
      if (shapes.size() < 1) return undefined;
      const shape = shapes.get(0);
      if (!shape) return undefined;
      if (this.#m.b3Shape_GetType(shape).value !== this.#m.b3ShapeType.b3_capsuleShape.value) return undefined;
      const c = this.#m.b3Shape_GetCapsule(shape);
      return {
        center1: [c.center1.x, c.center1.y, c.center1.z],
        center2: [c.center2.x, c.center2.y, c.center2.z],
        radius: c.radius
      };
    } finally {
      shapes.delete();
    }
  }

  // -- joints ---------------------------------------------------------------

  #localFrame(bodyId: b3BodyId, ax: number, ay: number, az: number) {
    return { p: this.#m.b3Body_GetLocalPoint(bodyId, { x: ax, y: ay, z: az }), q: IDENTITY_QUAT };
  }

  createSphericalJoint(
    bodyHandleA: number,
    bodyHandleB: number,
    worldAnchor: Vec3,
    options: JointSpringOptions = {}
  ): number {
    const a = this.#body(bodyHandleA);
    const b = this.#body(bodyHandleB);
    if (!a || !b) return 0;
    const def = this.#m.b3DefaultSphericalJointDef();
    def.base.bodyIdA = a;
    def.base.bodyIdB = b;
    def.base.localFrameA = this.#localFrame(a, worldAnchor[0], worldAnchor[1], worldAnchor[2]);
    def.base.localFrameB = this.#localFrame(b, worldAnchor[0], worldAnchor[1], worldAnchor[2]);
    const hertz = options.hertz ?? 0;
    if (hertz > 0) {
      def.enableSpring = true;
      def.hertz = hertz;
      def.dampingRatio = options.dampingRatio ?? 0;
    }
    const jointId = this.#m.b3CreateSphericalJoint(this.#world, def);
    const handle = this.#next++;
    this.#joints.set(handle, jointId);
    return handle;
  }

  createDistanceJoint(
    bodyHandleA: number,
    bodyHandleB: number,
    worldAnchorA: Vec3,
    worldAnchorB: Vec3,
    options: DistanceJointOptions = {}
  ): number {
    const a = this.#body(bodyHandleA);
    const b = this.#body(bodyHandleB);
    if (!a || !b) return 0;
    const def = this.#m.b3DefaultDistanceJointDef();
    def.base.bodyIdA = a;
    def.base.bodyIdB = b;
    def.base.localFrameA = this.#localFrame(a, worldAnchorA[0], worldAnchorA[1], worldAnchorA[2]);
    def.base.localFrameB = this.#localFrame(b, worldAnchorB[0], worldAnchorB[1], worldAnchorB[2]);
    const dx = worldAnchorB[0] - worldAnchorA[0];
    const dy = worldAnchorB[1] - worldAnchorA[1];
    const dz = worldAnchorB[2] - worldAnchorA[2];
    const length = options.length ?? 0;
    def.length = length > 0 ? length : Math.hypot(dx, dy, dz);
    const hertz = options.hertz ?? 0;
    if (hertz > 0) {
      def.enableSpring = true;
      def.hertz = hertz;
      def.dampingRatio = options.dampingRatio ?? 0;
    }
    const jointId = this.#m.b3CreateDistanceJoint(this.#world, def);
    const handle = this.#next++;
    this.#joints.set(handle, jointId);
    return handle;
  }

  destroyJoint(jointHandle: number): void {
    const id = this.#joints.get(jointHandle);
    if (!id) return;
    if (this.#m.b3Joint_IsValid(id)) this.#m.b3DestroyJoint(id, true);
    this.#joints.delete(jointHandle);
  }

  // -- ragdoll (ports native/human.c CreateHuman) ---------------------------

  spawnHuman(position: Vec3, options: HumanOptions = {}): HumanRagdoll {
    const m = this.#m;
    const frictionTorque = options.frictionTorque ?? 5;
    const hertz = options.hertz ?? 1;
    const dampingRatio = options.dampingRatio ?? 0.7;
    const group = ++this.#humanGroup;

    const bodyIds: b3BodyId[] = [];
    const bones: number[] = [];

    for (const bone of HUMAN_BONES) {
      const bd = m.b3DefaultBodyDef();
      bd.type = this.#types[BodyType.Dynamic];
      bd.position = {
        x: position[0] + bone.ref[0],
        y: position[1] + bone.ref[1],
        z: position[2] + bone.ref[2]
      };
      bd.rotation = { v: { x: bone.refQ[0], y: bone.refQ[1], z: bone.refQ[2] }, s: bone.refQ[3] };
      const id = m.b3CreateBody(this.#world, bd);

      const sd = m.b3DefaultShapeDef();
      sd.baseMaterial.rollingResistance = 0.2;
      sd.filter.groupIndex = bone.groupNeg ? -group : 0;
      m.b3CreateCapsuleShape(id, sd, {
        center1: { x: bone.c1[0], y: bone.c1[1], z: bone.c1[2] },
        center2: { x: bone.c2[0], y: bone.c2[1], z: bone.c2[2] },
        radius: bone.r
      });

      bodyIds.push(id);
      bones.push(this.#register(id));
    }

    for (let i = 1; i < HUMAN_BONES.length; i++) {
      const bone = HUMAN_BONES[i];
      const a = bodyIds[bone.parent];
      const b = bodyIds[i];
      const lfAp = { x: bone.lfA[0], y: bone.lfA[1], z: bone.lfA[2] };
      const lfAq = normQuat(bone.lfAq[0], bone.lfAq[1], bone.lfAq[2], bone.lfAq[3]);
      const lfBp = { x: bone.lfB[0], y: bone.lfB[1], z: bone.lfB[2] };
      const lfBq = normQuat(bone.lfBq[0], bone.lfBq[1], bone.lfBq[2], bone.lfBq[3]);
      const maxMotorTorque = bone.friction * frictionTorque;

      if (bone.revolute) {
        const jd = m.b3DefaultRevoluteJointDef();
        jd.base.bodyIdA = a;
        jd.base.bodyIdB = b;
        jd.base.localFrameA = { p: lfAp, q: lfAq };
        jd.base.localFrameB = { p: lfBp, q: lfBq };
        jd.enableLimit = true;
        jd.lowerAngle = bone.twist[0];
        jd.upperAngle = bone.twist[1];
        jd.enableSpring = hertz > 0;
        jd.hertz = hertz;
        jd.dampingRatio = dampingRatio;
        jd.enableMotor = true;
        jd.maxMotorTorque = maxMotorTorque;
        m.b3CreateRevoluteJoint(this.#world, jd);
      } else {
        const jd = m.b3DefaultSphericalJointDef();
        jd.base.bodyIdA = a;
        jd.base.bodyIdB = b;
        jd.base.localFrameA = { p: lfAp, q: lfAq };
        jd.base.localFrameB = { p: lfBp, q: lfBq };
        jd.enableConeLimit = true;
        jd.coneAngle = bone.swing;
        jd.enableTwistLimit = true;
        jd.lowerTwistAngle = bone.twist[0];
        jd.upperTwistAngle = bone.twist[1];
        jd.enableSpring = hertz > 0;
        jd.hertz = hertz;
        jd.dampingRatio = dampingRatio;
        jd.enableMotor = true;
        jd.maxMotorTorque = maxMotorTorque;
        m.b3CreateSphericalJoint(this.#world, jd);
      }
    }

    // disable thigh_l <-> thigh_r collision
    const filterDef = m.b3DefaultFilterJointDef();
    filterDef.base.bodyIdA = bodyIds[BONE_THIGH_L];
    filterDef.base.bodyIdB = bodyIds[BONE_THIGH_R];
    m.b3CreateFilterJoint(this.#world, filterDef);

    // The `human` handle exists only for velocity/impulse helpers the app never
    // calls; return a stable id so callers can store it opaquely.
    return { human: group, bones };
  }

  // humanSetVelocity / humanApplyRandomImpulse are unused by the app; the
  // ragdoll helpers above suffice. Omitted deliberately.

  dispose(): void {
    this.#m.b3DestroyWorld(this.#world);
    // Mesh shapes retain raw b3MeshData pointers; once the world has destroyed
    // every owning shape it is safe (and necessary) to release those buffers.
    for (const mesh of this.#meshes.values()) this.#m.b3DestroyMesh(mesh);
    this.#meshes.clear();
    this.#bodies.clear();
    this.#joints.clear();
    this.#keyToHandle.clear();
    this.#handleKey.clear();
  }
}

export async function createBox3D(): Promise<Box3D> {
  const module = await loadBox3DModule();
  return new Box3D(module);
}

// The inline package contains the physics WASM as a ~1 MB JavaScript literal.
// Keep it out of the entry chunk and initialize that shared Emscripten module
// only when the first authoritative physics world is actually requested.
let box3DModulePromise: Promise<Box3DModule> | null = null;

function loadBox3DModule(): Promise<Box3DModule> {
  box3DModulePromise ??= import("box3d.js/inline").then(({ default: Box3DFactory }) => Box3DFactory());
  return box3DModulePromise;
}

// ---------------------------------------------------------------------------
// Ragdoll bone table, ported verbatim from vendored native/human.c CreateHuman.
// Bone order (pelvis .. lower_arm_r) and index 5 == head are load-bearing:
// consumers color/shape by that ordering. Quats are [x,y,z,w].
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const BONE_THIGH_L = 6;
const BONE_THIGH_R = 8;

type BoneDef = {
  ref: readonly [number, number, number];
  refQ: readonly [number, number, number, number];
  c1: readonly [number, number, number];
  c2: readonly [number, number, number];
  r: number;
  parent: number;
  groupNeg: boolean;
  revolute: boolean;
  lfA: readonly [number, number, number];
  lfAq: readonly [number, number, number, number];
  lfB: readonly [number, number, number];
  lfBq: readonly [number, number, number, number];
  swing: number;
  twist: readonly [number, number];
  friction: number;
};

const HUMAN_BONES: readonly BoneDef[] = [
  // pelvis (parent frame unused)
  {
    ref: [0, 0.932087, -0.051708], refQ: [0.739169, 0, 0, 0.67352],
    c1: [0.07, 0, -0.08], c2: [-0.07, 0, -0.08], r: 0.13,
    parent: -1, groupNeg: false, revolute: false,
    lfA: [0, 0, 0], lfAq: [0, 0, 0, 1], lfB: [0, 0, 0], lfBq: [0, 0, 0, 1],
    swing: 0, twist: [0, 0], friction: 1
  },
  // spine_01
  {
    ref: [0, 1.113505, -0.03481], refQ: [0.739973, 0, 0, 0.672637],
    c1: [0.06, 0, -0.052264], c2: [-0.06, 0, -0.052264], r: 0.12,
    parent: 0, groupNeg: true, revolute: false,
    lfA: [0, 0, -0.182204], lfAq: [-0.999999, 0, 0, 0.001194],
    lfB: [0, 0, -0.007736], lfBq: [-1, 0, 0, 0],
    swing: 25 * DEG, twist: [-15 * DEG, 15 * DEG], friction: 1
  },
  // spine_02
  {
    ref: [0, 1.194336, -0.027087], refQ: [0.703611, 0, 0, 0.710586],
    c1: [0.08, -0.015133, -0.091801], c2: [-0.08, -0.015133, -0.091801], r: 0.1,
    parent: 1, groupNeg: false, revolute: false,
    lfA: [0, 0, -0.088935], lfAq: [-0.998619, 0, 0, -0.05254],
    lfB: [0, 0, -0.008199], lfBq: [-1, 0, 0, 0],
    swing: 25 * DEG, twist: [-15 * DEG, 15 * DEG], friction: 1
  },
  // spine_03
  {
    ref: [0, 1.31043, -0.028232], refQ: [0.669856, 0.000001, -0.000001, 0.742491],
    c1: [0.11, -0.039753, -0.13], c2: [-0.11, -0.039753, -0.13], r: 0.145,
    parent: 2, groupNeg: false, revolute: false,
    lfA: [0, 0, -0.124298], lfAq: [-0.998921, 0.000001, -0.000001, -0.046434],
    lfB: [0, 0, 0], lfBq: [-1, 0, -0.000001, 0],
    swing: 15 * DEG, twist: [-10 * DEG, 10 * DEG], friction: 1
  },
  // neck
  {
    ref: [0, 1.575582, -0.055837], refQ: [0.879922, 0, 0, 0.475118],
    c1: [-0.000001, 0, -0.02], c2: [0, -0.005, -0.08], r: 0.07,
    parent: 3, groupNeg: false, revolute: false,
    lfA: [0.000001, -0.000259, -0.266585], lfAq: [-0.942192, -0.000001, 0, 0.335074],
    lfB: [0, 0, 0], lfBq: [-1, 0, -0.000001, 0],
    swing: 45 * DEG, twist: [-15 * DEG, 15 * DEG], friction: 0.8
  },
  // head (index 5)
  {
    ref: [0, 1.653348, -0.003241], refQ: [0.750288, 0, 0, 0.661111],
    c1: [-0.000001, 0.016892, -0.05869], c2: [0, -0.003629, -0.115072], r: 0.0975,
    parent: 4, groupNeg: false, revolute: false,
    lfA: [0, 0.001321, -0.093873], lfAq: [-0.974301, 0, 0, -0.225251],
    lfB: [0, 0.001268, -0.005104], lfBq: [-1, 0, 0, 0],
    swing: 15 * DEG, twist: [-15 * DEG, 15 * DEG], friction: 0.4
  },
  // thigh_l (index 6)
  {
    ref: [0.090416, 0.986104, -0.03509], refQ: [-0.703287, -0.070715, 0.053866, 0.705327],
    c1: [0.023719, 0.006008, -0.039068], c2: [-0.064492, -0.004664, -0.424718], r: 0.09,
    parent: 0, groupNeg: true, revolute: false,
    lfA: [0.05, 0.011537, -0.055325], lfAq: [-0.714896, -0.022305, -0.698361, -0.02679],
    lfB: [0, 0, 0], lfBq: [-0.002064, 0.758987, 0.017046, 0.65088],
    swing: 10 * DEG, twist: [-60 * DEG, 40 * DEG], friction: 1
  },
  // calf_l
  {
    ref: [0.101198, 0.527027, -0.037374], refQ: [-0.653328, -0.06686, 0.058582, 0.751838],
    c1: [0.001778, 0, 0.009841], c2: [-0.078577, 0.014707, -0.41816], r: 0.075,
    parent: 6, groupNeg: false, revolute: true,
    lfA: [-0.069989, 0.000253, -0.453844], lfAq: [-0.000677, 0.760087, 0.105674, 0.641171],
    lfB: [0, 0, 0], lfBq: [-0.044589, 0.76554, 0.053368, 0.639619],
    swing: 0, twist: [-5 * DEG, 45 * DEG], friction: 1
  },
  // thigh_r (index 8)
  {
    ref: [-0.090416, 0.986104, -0.03509], refQ: [-0.703287, 0.070715, -0.053865, 0.705326],
    c1: [-0.023719, 0.006008, -0.039068], c2: [0.064492, -0.004664, -0.424718], r: 0.09,
    parent: 0, groupNeg: true, revolute: false,
    lfA: [-0.05, 0.011537, -0.055326], lfAq: [-0.039089, -0.714094, 0.043177, 0.697623],
    lfB: [0, 0, 0], lfBq: [0.758805, -0.019886, -0.651012, -0.001759],
    swing: 10 * DEG, twist: [-30 * DEG, 60 * DEG], friction: 1
  },
  // calf_r
  {
    ref: [-0.101198, 0.527027, -0.037373], refQ: [-0.653327, 0.06686, -0.058582, 0.751839],
    c1: [-0.00182, 0, 0.010071], c2: [0.077883, 0.014825, -0.418047], r: 0.075,
    parent: 8, groupNeg: false, revolute: true,
    lfA: [0.069988, 0.000253, -0.453844], lfAq: [0.760086, -0.000675, -0.641171, -0.105676],
    lfB: [0, 0, 0], lfBq: [0.76554, -0.044589, -0.639619, -0.053368],
    swing: 0, twist: [-45 * DEG, 5 * DEG], friction: 1
  },
  // upper_arm_l (index 10)
  {
    ref: [0.20378, 1.484275, -0.115897], refQ: [0.143082, 0.69598, -0.69013, 0.13733],
    c1: [0, 0, 0], c2: [-0.091118, 0.037775, 0.229719], r: 0.075,
    parent: 3, groupNeg: false, revolute: false,
    lfA: [0.20378, -0.069369, -0.181921], lfAq: [-0.278486, 0.4456, -0.097014, 0.845266],
    lfB: [0, 0, 0], lfBq: [-0.201396, -0.001586, 0.90185, 0.382234],
    swing: 60 * DEG, twist: [-5 * DEG, 5 * DEG], friction: 1
  },
  // lower_arm_l
  {
    ref: [0.305614, 1.242908, -0.117599], refQ: [0.165048, 0.563437, -0.802002, 0.109959],
    c1: [0, 0, 0], c2: [-0.142406, 0.039392, 0.261092], r: 0.05,
    parent: 10, groupNeg: false, revolute: true,
    lfA: [-0.095482, 0.039584, 0.240723], lfAq: [0.512487, -0.180629, 0.839474, 0.003742],
    lfB: [0, 0, 0], lfBq: [0.503803, -0.029831, 0.858168, 0.094017],
    swing: 0, twist: [-5 * DEG, 60 * DEG], friction: 1
  },
  // upper_arm_r (index 12)
  {
    ref: [-0.20378, 1.484276, -0.115899], refQ: [0.143083, -0.695978, 0.690132, 0.137329],
    c1: [0, 0, 0], c2: [0.091118, 0.037775, 0.229718], r: 0.075,
    parent: 3, groupNeg: false, revolute: false,
    lfA: [-0.203779, -0.069371, -0.181922], lfAq: [-0.253621, -0.414842, 0.106962, 0.867261],
    lfB: [0, 0, 0], lfBq: [-0.201397, 0.001587, -0.90185, 0.382233],
    swing: 60 * DEG, twist: [-5 * DEG, 5 * DEG], friction: 1
  },
  // lower_arm_r
  {
    ref: [-0.305614, 1.242907, -0.117599], refQ: [0.165048, -0.563437, 0.802002, 0.109959],
    c1: [0, 0, 0], c2: [0.142406, 0.039392, 0.261092], r: 0.05,
    parent: 12, groupNeg: false, revolute: true,
    lfA: [0.095484, 0.039585, 0.240723], lfAq: [-0.180627, 0.512487, -0.003744, -0.839474],
    lfB: [0, 0, 0], lfBq: [-0.029831, 0.503803, -0.094017, -0.858169],
    swing: 0, twist: [-60 * DEG, 5 * DEG], friction: 1
  }
];
