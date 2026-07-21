import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import {
  GHOST_SHIP_COLLIDER_SPECS,
  ghostShipLocalPointIsAboard,
  type GhostShipColliderActivation
} from "./collisionLayout";

export type GhostShipCollision = {
  readonly bodyCount: number;
  readonly walkerAboard: boolean;
  /** Root must already hold the current wall-clock pose. */
  sync(dt: number, walkerBody: number, landed: boolean): void;
  dispose(): void;
};

type CollisionBody = {
  handle: number;
  localPosition: THREE.Vector3;
  localQuaternion: THREE.Quaternion;
  worldPosition: THREE.Vector3;
  previousWorldPosition: THREE.Vector3;
  worldQuaternion: THREE.Quaternion;
  activation: GhostShipColliderActivation;
  active: boolean;
};

const PARK_Y = -12_000;
const MAX_VELOCITY_DELTA = 12;
const MAX_VELOCITY_DT = 0.2;

/** Moving Box3D deck/guard bodies plus the frame carry needed by an on-foot rider. */
export function createGhostShipCollision(
  physics: Physics,
  root: THREE.Object3D
): GhostShipCollision {
  const world = physics.world;
  const bodies: CollisionBody[] = GHOST_SHIP_COLLIDER_SPECS.map((spec, index) => ({
    handle: world.createBox({
      type: BodyType.Kinematic,
      position: [0, PARK_Y - index * 3, 0],
      halfExtents: [spec.hx, spec.hy, spec.hz],
      friction: spec.kind === "deck" || spec.kind === "stair" ? 1.25 : 0.75,
      restitution: 0
    }),
    localPosition: new THREE.Vector3(spec.x, spec.y, spec.z),
    localQuaternion: new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, spec.yaw ?? 0, spec.roll ?? 0, "YXZ")
    ),
    worldPosition: new THREE.Vector3(),
    previousWorldPosition: new THREE.Vector3(0, PARK_Y - index * 3, 0),
    worldQuaternion: new THREE.Quaternion(),
    activation: spec.activation ?? "always",
    active: false
  }));

  const previousRootMatrix = new THREE.Matrix4();
  const inversePreviousRootMatrix = new THREE.Matrix4();
  const rootQuaternion = new THREE.Quaternion();
  const previousRootQuaternion = new THREE.Quaternion();
  const inversePreviousRootQuaternion = new THREE.Quaternion();
  const deltaQuaternion = new THREE.Quaternion();
  const yawQuaternion = new THREE.Quaternion();
  const localWalker = new THREE.Vector3();
  const carriedWalker = new THREE.Vector3();
  const walkerQuaternion = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const walkerTransform = {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number]
  };
  const walkerVelocity = {
    linear: [0, 0, 0] as [number, number, number],
    angular: [0, 0, 0] as [number, number, number]
  };
  let previousRootYaw = 0;
  let ready = false;
  let disposed = false;
  let walkerAboard = false;

  const carryWalker = (walkerBody: number, dt: number, rootYaw: number) => {
    walkerAboard = false;
    if (!ready || walkerBody <= 0) return;
    const transform = world.getBodyTransform(walkerBody, walkerTransform);
    localWalker
      .set(transform.position[0], transform.position[1], transform.position[2])
      .applyMatrix4(inversePreviousRootMatrix.copy(previousRootMatrix).invert());
    if (!ghostShipLocalPointIsAboard(localWalker.x, localWalker.y, localWalker.z)) return;

    carriedWalker.copy(localWalker).applyMatrix4(root.matrixWorld);
    walkerQuaternion.set(
      transform.rotation[0],
      transform.rotation[1],
      transform.rotation[2],
      transform.rotation[3]
    );
    const yawDelta = Math.atan2(
      Math.sin(rootYaw - previousRootYaw),
      Math.cos(rootYaw - previousRootYaw)
    );
    yawQuaternion.setFromAxisAngle(axis.set(0, 1, 0), yawDelta);
    walkerQuaternion.premultiply(yawQuaternion).normalize();
    world.setBodyTransform(
      walkerBody,
      [carriedWalker.x, carriedWalker.y, carriedWalker.z],
      [walkerQuaternion.x, walkerQuaternion.y, walkerQuaternion.z, walkerQuaternion.w]
    );

    // The walk controller owns intentional X/Z velocity at the next fixed step.
    // Seeding the frame velocity here gives the contact solver the platform's
    // inherited motion on the first step after a seat dismount.
    if (dt > 0 && dt <= MAX_VELOCITY_DT) {
      const dx = carriedWalker.x - transform.position[0];
      const dy = carriedWalker.y - transform.position[1];
      const dz = carriedWalker.z - transform.position[2];
      if (Math.hypot(dx, dy, dz) <= MAX_VELOCITY_DELTA) {
        const velocity = world.getBodyVelocity(walkerBody, walkerVelocity);
        world.setBodyVelocity(
          walkerBody,
          [
            velocity.linear[0] + dx / dt,
            velocity.linear[1] + dy / dt,
            velocity.linear[2] + dz / dt
          ],
          [0, 0, 0]
        );
      }
    }
    world.setBodyAwake(walkerBody, true);
    walkerAboard = true;
  };

  return {
    bodyCount: bodies.length,
    get walkerAboard() {
      return walkerAboard;
    },
    sync(dt, walkerBody, landed) {
      if (disposed) return;
      root.updateMatrixWorld(true);
      root.getWorldQuaternion(rootQuaternion);
      const rootYaw = root.rotation.y;
      carryWalker(walkerBody, dt, rootYaw);

      let angularX = 0;
      let angularY = 0;
      let angularZ = 0;
      if (ready && dt > 0 && dt <= MAX_VELOCITY_DT) {
        inversePreviousRootQuaternion.copy(previousRootQuaternion).invert();
        deltaQuaternion.copy(rootQuaternion).multiply(inversePreviousRootQuaternion).normalize();
        if (deltaQuaternion.w < 0) {
          deltaQuaternion.x *= -1;
          deltaQuaternion.y *= -1;
          deltaQuaternion.z *= -1;
          deltaQuaternion.w *= -1;
        }
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(deltaQuaternion.w, -1, 1));
        const scale = Math.sqrt(Math.max(0, 1 - deltaQuaternion.w * deltaQuaternion.w));
        if (angle > 1e-7 && scale > 1e-7) {
          angularX = (deltaQuaternion.x / scale) * angle / dt;
          angularY = (deltaQuaternion.y / scale) * angle / dt;
          angularZ = (deltaQuaternion.z / scale) * angle / dt;
        }
      }

      for (let index = 0; index < bodies.length; index++) {
        const body = bodies[index];
        const shouldBeActive =
          body.activation === "always" ||
          (body.activation === "landed" && landed) ||
          (body.activation === "airborne" && !landed);
        if (!shouldBeActive) {
          if (body.active) {
            body.worldPosition.set(0, PARK_Y - index * 3, 0);
            world.setBodyTransform(body.handle, [0, body.worldPosition.y, 0]);
            world.setBodyVelocity(body.handle, [0, 0, 0], [0, 0, 0]);
            body.previousWorldPosition.copy(body.worldPosition);
            body.active = false;
          }
          continue;
        }
        body.worldPosition.copy(body.localPosition).applyMatrix4(root.matrixWorld);
        body.worldQuaternion.copy(rootQuaternion).multiply(body.localQuaternion);
        world.setBodyTransform(
          body.handle,
          [body.worldPosition.x, body.worldPosition.y, body.worldPosition.z],
          [body.worldQuaternion.x, body.worldQuaternion.y, body.worldQuaternion.z, body.worldQuaternion.w]
        );

        const dx = body.worldPosition.x - body.previousWorldPosition.x;
        const dy = body.worldPosition.y - body.previousWorldPosition.y;
        const dz = body.worldPosition.z - body.previousWorldPosition.z;
        const continuous =
          ready &&
          body.active &&
          dt > 0 &&
          dt <= MAX_VELOCITY_DT &&
          Math.hypot(dx, dy, dz) <= MAX_VELOCITY_DELTA;
        world.setBodyVelocity(
          body.handle,
          continuous ? [dx / dt, dy / dt, dz / dt] : [0, 0, 0],
          continuous ? [angularX, angularY, angularZ] : [0, 0, 0]
        );
        body.previousWorldPosition.copy(body.worldPosition);
        body.active = true;
      }

      previousRootMatrix.copy(root.matrixWorld);
      previousRootQuaternion.copy(rootQuaternion);
      previousRootYaw = rootYaw;
      ready = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const body of bodies) world.destroyBody(body.handle);
      bodies.length = 0;
      walkerAboard = false;
    }
  };
}
