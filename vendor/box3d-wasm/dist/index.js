export const BodyType = {
    Static: 0,
    Kinematic: 1,
    Dynamic: 2
};
/** Floats per hit event: bodyA bodyB px py pz nx ny nz approachSpeed. */
const HIT_EVENT_STRIDE = 9;
/** Floats per body in a TransformBatch read: px py pz qx qy qz qw awake. */
export const TRANSFORM_STRIDE = 8;
/**
 * Reads transforms for a fixed set of bodies in one WASM call per frame.
 * Dramatically cheaper than per-body getters once body counts grow.
 */
export class TransformBatch {
    count;
    #module;
    #handlesPtr;
    #outPtr;
    #disposed = false;
    constructor(module, handles) {
        this.#module = module;
        this.count = handles.length;
        this.#handlesPtr = module._malloc(Math.max(4, this.count * 4));
        this.#outPtr = module._malloc(Math.max(4, this.count * TRANSFORM_STRIDE * 4));
        module.HEAP32.set(Array.from(handles), this.#handlesPtr >> 2);
    }
    /**
     * Fills the batch buffer and returns a view over it.
     * The view is only valid until the next WASM allocation; copy if you need to keep it.
     */
    read() {
        if (this.#disposed) {
            throw new Error("TransformBatch has been disposed");
        }
        this.#module._b3w_get_body_transforms(this.#handlesPtr, this.count, this.#outPtr);
        const base = this.#outPtr >> 2;
        return this.#module.HEAPF32.subarray(base, base + this.count * TRANSFORM_STRIDE);
    }
    dispose() {
        if (this.#disposed) {
            return;
        }
        this.#module._free(this.#handlesPtr);
        this.#module._free(this.#outPtr);
        this.#disposed = true;
    }
}
export class Box3D {
    module;
    constructor(module) {
        this.module = module;
    }
    createWorld(gravity = [0, -10, 0]) {
        const handle = this.module._b3w_create_world(gravity[0], gravity[1], gravity[2]);
        if (handle === 0) {
            throw new Error("Box3D failed to create a world");
        }
        return new PhysicsWorld(this.module, handle);
    }
    getWorldCount() {
        return this.module._b3w_get_world_count();
    }
}
export class PhysicsWorld {
    handle;
    fixedTimeStep = 1 / 60;
    substeps = 4;
    #module;
    #disposed = false;
    #scratchPtr = 0;
    #hitEventsPtr = 0;
    #hitEventsCapacity = 0;
    constructor(module, handle) {
        this.#module = module;
        this.handle = handle;
    }
    createBox(options) {
        this.#assertLive();
        const density = options.density ?? (options.type === BodyType.Dynamic ? 1 : 0);
        const friction = options.friction ?? 0.55;
        const restitution = options.restitution ?? 0.05;
        const p = options.position;
        const h = options.halfExtents;
        const handle = this.#module._b3w_create_box(this.handle, options.type, p[0], p[1], p[2], h[0], h[1], h[2], density, friction, restitution, options.rollingResistance ?? 0, options.bullet ? 1 : 0);
        if (handle === 0) {
            throw new Error("Box3D failed to create a box body");
        }
        return handle;
    }
    createSphere(options) {
        this.#assertLive();
        const density = options.density ?? (options.type === BodyType.Dynamic ? 1 : 0);
        const friction = options.friction ?? 0.35;
        const restitution = options.restitution ?? 0.25;
        const rollingResistance = options.rollingResistance ?? 0.02;
        const p = options.position;
        const handle = this.#module._b3w_create_sphere(this.handle, options.type, p[0], p[1], p[2], options.radius, density, friction, restitution, rollingResistance, options.bullet ? 1 : 0);
        if (handle === 0) {
            throw new Error("Box3D failed to create a sphere body");
        }
        return handle;
    }
    createCapsule(options) {
        this.#assertLive();
        const density = options.density ?? (options.type === BodyType.Dynamic ? 1 : 0);
        const friction = options.friction ?? 0.45;
        const restitution = options.restitution ?? 0.1;
        const rollingResistance = options.rollingResistance ?? 0.02;
        const p = options.position;
        const handle = this.#module._b3w_create_capsule(this.handle, options.type, p[0], p[1], p[2], options.halfHeight, options.radius, density, friction, restitution, rollingResistance, options.bullet ? 1 : 0);
        if (handle === 0) {
            throw new Error("Box3D failed to create a capsule body");
        }
        return handle;
    }
    step(timeStep = this.fixedTimeStep, substeps = this.substeps) {
        this.#assertLive();
        this.#module._b3w_step_world(this.handle, timeStep, substeps);
    }
    destroyBody(bodyHandle) {
        this.#module._b3w_destroy_body(bodyHandle);
    }
    setBodyTransform(bodyHandle, position, rotation = [0, 0, 0, 1]) {
        this.#module._b3w_set_body_transform(bodyHandle, position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], rotation[3]);
    }
    setBodyVelocity(bodyHandle, linear, angular = [0, 0, 0]) {
        this.#module._b3w_set_body_velocity(bodyHandle, linear[0], linear[1], linear[2], angular[0], angular[1], angular[2]);
    }
    applyImpulse(bodyHandle, impulse) {
        this.#module._b3w_apply_impulse(bodyHandle, impulse[0], impulse[1], impulse[2]);
    }
    applyImpulseAtPoint(bodyHandle, impulse, worldPoint) {
        this.#module._b3w_apply_impulse_at_point(bodyHandle, impulse[0], impulse[1], impulse[2], worldPoint[0], worldPoint[1], worldPoint[2]);
    }
    applyAngularImpulse(bodyHandle, impulse) {
        this.#module._b3w_apply_angular_impulse(bodyHandle, impulse[0], impulse[1], impulse[2]);
    }
    applyForce(bodyHandle, force) {
        this.#module._b3w_apply_force(bodyHandle, force[0], force[1], force[2]);
    }
    explode(position, radius, falloff, impulsePerArea) {
        this.#module._b3w_explode(this.handle, position[0], position[1], position[2], radius, falloff, impulsePerArea);
    }
    getBodySpeed(bodyHandle) {
        return this.#module._b3w_get_body_speed(bodyHandle);
    }
    getBodyMass(bodyHandle) {
        return this.#module._b3w_get_body_mass(bodyHandle);
    }
    setBodyAwake(bodyHandle, awake) {
        this.#module._b3w_set_body_awake(bodyHandle, awake ? 1 : 0);
    }
    /** 0 disables gravity for the body, 1 is normal. */
    setBodyGravityScale(bodyHandle, scale) {
        this.#module._b3w_set_body_gravity_scale(bodyHandle, scale);
    }
    /** Collision speed (m/s) required before hit events are generated. */
    setHitEventThreshold(value) {
        this.#module._b3w_set_hit_event_threshold(this.handle, value);
    }
    /** Opt a body into ContactHitEvent generation (off by default upstream). */
    setBodyHitEvents(bodyHandle, enabled) {
        this.#module._b3w_body_enable_hit_events(bodyHandle, enabled ? 1 : 0);
    }
    /**
     * Hit events from the most recent step. Call between step() and the next
     * step; each step replaces the previous buffer.
     */
    readHitEvents(maxEvents = 64) {
        this.#assertLive();
        if (this.#hitEventsCapacity < maxEvents) {
            if (this.#hitEventsPtr !== 0) {
                this.#module._free(this.#hitEventsPtr);
            }
            this.#hitEventsPtr = this.#module._malloc(maxEvents * HIT_EVENT_STRIDE * 4);
            this.#hitEventsCapacity = maxEvents;
        }
        const count = this.#module._b3w_get_hit_events(this.handle, this.#hitEventsPtr, maxEvents);
        const base = this.#hitEventsPtr >> 2;
        const heap = this.#module.HEAPF32;
        const events = [];
        for (let i = 0; i < count; i += 1) {
            const offset = base + i * HIT_EVENT_STRIDE;
            events.push({
                bodyA: heap[offset],
                bodyB: heap[offset + 1],
                point: [heap[offset + 2], heap[offset + 3], heap[offset + 4]],
                normal: [heap[offset + 5], heap[offset + 6], heap[offset + 7]],
                approachSpeed: heap[offset + 8]
            });
        }
        return events;
    }
    /** Local capsule shape of the body, or undefined when it has none. */
    getBodyCapsule(bodyHandle) {
        const ptr = this.#scratch();
        if (this.#module._b3w_get_body_capsule(bodyHandle, ptr) === 0) {
            return undefined;
        }
        const base = ptr >> 2;
        const heap = this.#module.HEAPF32;
        return {
            center1: [heap[base], heap[base + 1], heap[base + 2]],
            center2: [heap[base + 3], heap[base + 4], heap[base + 5]],
            radius: heap[base + 6]
        };
    }
    /** Spawns the official Box3D samples ragdoll (14 capsule bones + joints). */
    spawnHuman(position, options = {}) {
        this.#assertLive();
        const boneCount = this.#module._b3w_human_bone_count();
        const bonesPtr = this.#module._malloc(boneCount * 4);
        try {
            const human = this.#module._b3w_spawn_human(this.handle, position[0], position[1], position[2], options.frictionTorque ?? 5, options.hertz ?? 1, options.dampingRatio ?? 0.7, bonesPtr);
            if (human === 0) {
                throw new Error("Box3D failed to spawn a human ragdoll");
            }
            const base = bonesPtr >> 2;
            const bones = Array.from(this.#module.HEAP32.subarray(base, base + boneCount));
            return { human, bones };
        }
        finally {
            this.#module._free(bonesPtr);
        }
    }
    humanSetVelocity(humanHandle, velocity) {
        this.#module._b3w_human_set_velocity(humanHandle, velocity[0], velocity[1], velocity[2]);
    }
    humanApplyRandomImpulse(humanHandle, magnitude) {
        this.#module._b3w_human_apply_random_impulse(humanHandle, magnitude);
    }
    isBodyAwake(bodyHandle) {
        return this.#module._b3w_body_is_awake(bodyHandle) !== 0;
    }
    getBodyTransform(bodyHandle, target) {
        const result = target ??
            {
                position: [0, 0, 0],
                rotation: [0, 0, 0, 1]
            };
        const ptr = this.#scratch();
        this.#module._b3w_get_body_transform(bodyHandle, ptr);
        const base = ptr >> 2;
        const heap = this.#module.HEAPF32;
        result.position[0] = heap[base];
        result.position[1] = heap[base + 1];
        result.position[2] = heap[base + 2];
        result.rotation[0] = heap[base + 3];
        result.rotation[1] = heap[base + 4];
        result.rotation[2] = heap[base + 5];
        result.rotation[3] = heap[base + 6];
        return result;
    }
    getBodyVelocity(bodyHandle, target) {
        const result = target ??
            {
                linear: [0, 0, 0],
                angular: [0, 0, 0]
            };
        const ptr = this.#scratch();
        this.#module._b3w_get_body_velocity(bodyHandle, ptr);
        const base = ptr >> 2;
        const heap = this.#module.HEAPF32;
        result.linear[0] = heap[base];
        result.linear[1] = heap[base + 1];
        result.linear[2] = heap[base + 2];
        result.angular[0] = heap[base + 3];
        result.angular[1] = heap[base + 4];
        result.angular[2] = heap[base + 5];
        return result;
    }
    /** Batched transform reader for a fixed set of bodies. Dispose when done. */
    createTransformBatch(handles) {
        this.#assertLive();
        return new TransformBatch(this.#module, handles);
    }
    createSphericalJoint(bodyHandleA, bodyHandleB, worldAnchor, options = {}) {
        this.#assertLive();
        const handle = this.#module._b3w_create_spherical_joint(this.handle, bodyHandleA, bodyHandleB, worldAnchor[0], worldAnchor[1], worldAnchor[2], options.hertz ?? 0, options.dampingRatio ?? 0);
        if (handle === 0) {
            throw new Error("Box3D failed to create a spherical joint");
        }
        return handle;
    }
    createDistanceJoint(bodyHandleA, bodyHandleB, worldAnchorA, worldAnchorB, options = {}) {
        this.#assertLive();
        const handle = this.#module._b3w_create_distance_joint(this.handle, bodyHandleA, bodyHandleB, worldAnchorA[0], worldAnchorA[1], worldAnchorA[2], worldAnchorB[0], worldAnchorB[1], worldAnchorB[2], options.length ?? 0, options.hertz ?? 0, options.dampingRatio ?? 0);
        if (handle === 0) {
            throw new Error("Box3D failed to create a distance joint");
        }
        return handle;
    }
    destroyJoint(jointHandle) {
        this.#module._b3w_destroy_joint(jointHandle);
    }
    dispose() {
        if (this.#disposed) {
            return;
        }
        if (this.#scratchPtr !== 0) {
            this.#module._free(this.#scratchPtr);
            this.#scratchPtr = 0;
        }
        if (this.#hitEventsPtr !== 0) {
            this.#module._free(this.#hitEventsPtr);
            this.#hitEventsPtr = 0;
            this.#hitEventsCapacity = 0;
        }
        this.#module._b3w_destroy_world(this.handle);
        this.#disposed = true;
    }
    #scratch() {
        if (this.#scratchPtr === 0) {
            this.#scratchPtr = this.#module._malloc(TRANSFORM_STRIDE * 4);
        }
        return this.#scratchPtr;
    }
    #assertLive() {
        if (this.#disposed) {
            throw new Error("PhysicsWorld has been disposed");
        }
    }
}
let modulePromise;
export function createBox3D() {
    modulePromise ??= import("../dist/box3d.mjs").then(({ default: createBox3DModule }) => createBox3DModule().then((module) => new Box3D(module)));
    return modulePromise;
}
//# sourceMappingURL=index.js.map