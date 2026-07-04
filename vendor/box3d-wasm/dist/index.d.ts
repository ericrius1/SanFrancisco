export declare const BodyType: {
    readonly Static: 0;
    readonly Kinematic: 1;
    readonly Dynamic: 2;
};
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
export type Box3DEmscriptenModule = {
    HEAPF32: Float32Array;
    HEAP32: Int32Array;
    _malloc(byteLength: number): number;
    _free(ptr: number): void;
    _b3w_create_world(gx: number, gy: number, gz: number): number;
    _b3w_destroy_world(worldHandle: number): void;
    _b3w_step_world(worldHandle: number, timeStep: number, subStepCount: number): void;
    _b3w_create_box(worldHandle: number, bodyType: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, density: number, friction: number, restitution: number, rollingResistance: number, isBullet: number): number;
    _b3w_create_sphere(worldHandle: number, bodyType: number, x: number, y: number, z: number, radius: number, density: number, friction: number, restitution: number, rollingResistance: number, isBullet: number): number;
    _b3w_create_capsule(worldHandle: number, bodyType: number, x: number, y: number, z: number, halfHeight: number, radius: number, density: number, friction: number, restitution: number, rollingResistance: number, isBullet: number): number;
    _b3w_destroy_body(bodyHandle: number): void;
    _b3w_set_body_transform(bodyHandle: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void;
    _b3w_set_body_velocity(bodyHandle: number, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number): void;
    _b3w_apply_impulse(bodyHandle: number, ix: number, iy: number, iz: number): void;
    _b3w_apply_angular_impulse(bodyHandle: number, ix: number, iy: number, iz: number): void;
    _b3w_apply_impulse_at_point(bodyHandle: number, ix: number, iy: number, iz: number, px: number, py: number, pz: number): void;
    _b3w_apply_force(bodyHandle: number, fx: number, fy: number, fz: number): void;
    _b3w_explode(worldHandle: number, x: number, y: number, z: number, radius: number, falloff: number, impulsePerArea: number): void;
    _b3w_get_body_transform(bodyHandle: number, outPtr: number): void;
    _b3w_get_body_transforms(handlesPtr: number, count: number, outPtr: number): void;
    _b3w_get_body_transform_component(bodyHandle: number, component: number): number;
    _b3w_get_body_velocity(bodyHandle: number, outPtr: number): void;
    _b3w_get_body_speed(bodyHandle: number): number;
    _b3w_get_body_mass(bodyHandle: number): number;
    _b3w_set_body_awake(bodyHandle: number, awake: number): void;
    _b3w_body_is_awake(bodyHandle: number): number;
    _b3w_create_spherical_joint(worldHandle: number, bodyHandleA: number, bodyHandleB: number, ax: number, ay: number, az: number, hertz: number, dampingRatio: number): number;
    _b3w_create_distance_joint(worldHandle: number, bodyHandleA: number, bodyHandleB: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, length: number, hertz: number, dampingRatio: number): number;
    _b3w_destroy_joint(jointHandle: number): void;
    _b3w_set_body_gravity_scale(bodyHandle: number, scale: number): void;
    _b3w_get_body_capsule(bodyHandle: number, outPtr: number): number;
    _b3w_spawn_human(worldHandle: number, x: number, y: number, z: number, frictionTorque: number, hertz: number, dampingRatio: number, outBodyHandlesPtr: number): number;
    _b3w_human_bone_count(): number;
    _b3w_human_set_velocity(humanHandle: number, vx: number, vy: number, vz: number): void;
    _b3w_human_apply_random_impulse(humanHandle: number, magnitude: number): void;
    _b3w_set_hit_event_threshold(worldHandle: number, value: number): void;
    _b3w_body_enable_hit_events(bodyHandle: number, enable: number): void;
    _b3w_get_hit_events(worldHandle: number, outPtr: number, maxEvents: number): number;
    _b3w_get_world_count(): number;
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
};
export type CapsuleOptions = {
    type: BodyTypeValue;
    position: Vec3;
    /** Half the distance between the two hemisphere centers (along local Y). */
    halfHeight: number;
    radius: number;
    density?: number;
    friction?: number;
    restitution?: number;
    rollingResistance?: number;
    bullet?: boolean;
};
export type JointSpringOptions = {
    /** Spring stiffness in Hz. Omit or pass 0 for a rigid joint. */
    hertz?: number;
    dampingRatio?: number;
};
export type DistanceJointOptions = JointSpringOptions & {
    /** Rest length. Omit or pass 0 to use the current anchor separation. */
    length?: number;
};
export type CapsuleShape = {
    /** Local center of the first hemisphere. */
    center1: [number, number, number];
    /** Local center of the second hemisphere. */
    center2: [number, number, number];
    radius: number;
};
export type HumanRagdoll = {
    /** Handle for human-level operations (velocity, random impulse). */
    human: number;
    /** One body handle per bone, in upstream bone order (pelvis first). */
    bones: number[];
};
export type HumanOptions = {
    /** Joint motor friction torque. Upstream default 5. */
    frictionTorque?: number;
    /** Joint spring stiffness in Hz. Upstream default 1. */
    hertz?: number;
    /** Joint spring damping ratio. Upstream default 0.7. */
    dampingRatio?: number;
};
/**
 * A high-speed collision reported by the engine. Generated when two shapes
 * collide faster than the world's hit event threshold and at least one body
 * has hit events enabled.
 */
export type ContactHitEvent = {
    /** Handle of the first body. 0 when the body is unknown to the wrapper. */
    bodyA: number;
    /** Handle of the second body. 0 when the body is unknown to the wrapper. */
    bodyB: number;
    /** Approximate world-space contact point. */
    point: [number, number, number];
    /** Contact normal pointing from bodyA to bodyB. */
    normal: [number, number, number];
    /** Speed the shapes approached at, in m/s. Always positive. */
    approachSpeed: number;
};
/** Floats per body in a TransformBatch read: px py pz qx qy qz qw awake. */
export declare const TRANSFORM_STRIDE = 8;
/**
 * Reads transforms for a fixed set of bodies in one WASM call per frame.
 * Dramatically cheaper than per-body getters once body counts grow.
 */
export declare class TransformBatch {
    #private;
    readonly count: number;
    constructor(module: Box3DEmscriptenModule, handles: ArrayLike<number>);
    /**
     * Fills the batch buffer and returns a view over it.
     * The view is only valid until the next WASM allocation; copy if you need to keep it.
     */
    read(): Float32Array;
    dispose(): void;
}
export declare class Box3D {
    readonly module: Box3DEmscriptenModule;
    constructor(module: Box3DEmscriptenModule);
    createWorld(gravity?: Vec3): PhysicsWorld;
    getWorldCount(): number;
}
export declare class PhysicsWorld {
    #private;
    readonly handle: number;
    readonly fixedTimeStep: number;
    readonly substeps = 4;
    constructor(module: Box3DEmscriptenModule, handle: number);
    createBox(options: BoxOptions): number;
    createSphere(options: SphereOptions): number;
    createCapsule(options: CapsuleOptions): number;
    step(timeStep?: number, substeps?: number): void;
    destroyBody(bodyHandle: number): void;
    setBodyTransform(bodyHandle: number, position: Vec3, rotation?: Quat): void;
    setBodyVelocity(bodyHandle: number, linear: Vec3, angular?: Vec3): void;
    applyImpulse(bodyHandle: number, impulse: Vec3): void;
    applyImpulseAtPoint(bodyHandle: number, impulse: Vec3, worldPoint: Vec3): void;
    applyAngularImpulse(bodyHandle: number, impulse: Vec3): void;
    applyForce(bodyHandle: number, force: Vec3): void;
    explode(position: Vec3, radius: number, falloff: number, impulsePerArea: number): void;
    getBodySpeed(bodyHandle: number): number;
    getBodyMass(bodyHandle: number): number;
    setBodyAwake(bodyHandle: number, awake: boolean): void;
    /** 0 disables gravity for the body, 1 is normal. */
    setBodyGravityScale(bodyHandle: number, scale: number): void;
    /** Collision speed (m/s) required before hit events are generated. */
    setHitEventThreshold(value: number): void;
    /** Opt a body into ContactHitEvent generation (off by default upstream). */
    setBodyHitEvents(bodyHandle: number, enabled: boolean): void;
    /**
     * Hit events from the most recent step. Call between step() and the next
     * step; each step replaces the previous buffer.
     */
    readHitEvents(maxEvents?: number): ContactHitEvent[];
    /** Local capsule shape of the body, or undefined when it has none. */
    getBodyCapsule(bodyHandle: number): CapsuleShape | undefined;
    /** Spawns the official Box3D samples ragdoll (14 capsule bones + joints). */
    spawnHuman(position: Vec3, options?: HumanOptions): HumanRagdoll;
    humanSetVelocity(humanHandle: number, velocity: Vec3): void;
    humanApplyRandomImpulse(humanHandle: number, magnitude: number): void;
    isBodyAwake(bodyHandle: number): boolean;
    getBodyTransform(bodyHandle: number, target?: Transform): Transform;
    getBodyVelocity(bodyHandle: number, target?: BodyVelocity): BodyVelocity;
    /** Batched transform reader for a fixed set of bodies. Dispose when done. */
    createTransformBatch(handles: ArrayLike<number>): TransformBatch;
    createSphericalJoint(bodyHandleA: number, bodyHandleB: number, worldAnchor: Vec3, options?: JointSpringOptions): number;
    createDistanceJoint(bodyHandleA: number, bodyHandleB: number, worldAnchorA: Vec3, worldAnchorB: Vec3, options?: DistanceJointOptions): number;
    destroyJoint(jointHandle: number): void;
    dispose(): void;
}
export declare function createBox3D(): Promise<Box3D>;
//# sourceMappingURL=index.d.ts.map