import * as THREE from "three/webgpu";
import { CONFIG, INPUT_TUNING } from "../config";
import type { Input } from "../core/input";
import {
  SKY_ISLANDS,
  getSkyIsland,
  sampleSkyGravity,
  type SkyIslandMetadata
} from "../world/skyIslands/metadata";
import { WALK_CAPSULE_HALF_EXTENT, WALK_CAPSULE_RADIUS, WALK_TUNING } from "./walk";
import type { ModeFrame, PlayerCtx } from "./types";

export const SKY_FLIGHT_SPEED = 22;
export const SKY_FLIGHT_BOOST_SPEED = 95;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_GRAVITY = new THREE.Vector3(...CONFIG.gravity);
const SUPPORT_REACH = WALK_CAPSULE_HALF_EXTENT + 0.18;
const SPHERE_CONTACT_SKIN = 0.035;
const WORLD_SWEEP_SKIN = 0.08;
const TAKEOFF_SPEED = 11;
const TAKEOFF_HOLD = 0.12;
const MOVE_RESPONSE = 11;
const UP_RESPONSE = 8;
const ORIENTATION_RESPONSE = 13;

type SkyGravityField = ReturnType<typeof sampleSkyGravity>;

const S = {
  desiredUp: new THREE.Vector3(),
  radial: new THREE.Vector3(),
  aim: new THREE.Vector3(),
  right: new THREE.Vector3(),
  forward: new THREE.Vector3(),
  moveForward: new THREE.Vector3(),
  desired: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  expectedVelocity: new THREE.Vector3(),
  gravity: new THREE.Vector3(),
  displacement: new THREE.Vector3(),
  relative: new THREE.Vector3(),
  sweepRight: new THREE.Vector3(),
  castOrigin: new THREE.Vector3(),
  castOffset: new THREE.Vector3(),
  bodyForward: new THREE.Vector3(),
  basisBack: new THREE.Vector3(),
  matrix: new THREE.Matrix4(),
  earthQuat: new THREE.Quaternion()
};

function expAlpha(response: number, dt: number): number {
  return 1 - Math.exp(-response * Math.max(0, Math.min(dt, 0.1)));
}

function smoothstep01(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function finiteVector(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * Personal, on-foot flight layered over the walk body's existing capsule.
 *
 * Box3D's world gravity remains global. This controller writes a velocity that
 * pre-cancels that acceleration, then adds the player's requested Earth or
 * planetoid gravity. As a result the slider affects only this body and every
 * other vehicle, prop, ragdoll, and remote player stays in the ordinary world.
 */
export class SkyFlightController {
  enabled = true;
  active = false;
  /** -1 = inverse, 0 = hover, +1 = natural Earth/planetoid gravity. */
  gravity = 0;
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly orientation = new THREE.Quaternion();
  grounded = false;
  field: SkyGravityField = null;
  currentIsland: SkyIslandMetadata | null = null;

  #takeoffPending = false;
  #takeoffTime = 0;
  #lastForward = new THREE.Vector3(0, 0, -1);

  /** Latch the render-rate Space edge until the next fixed physics step. */
  requestTakeoff(): void {
    if (this.enabled) this.#takeoffPending = true;
  }

  /** G toggles active flight. Inactive players still respect a tiny world's surface. */
  toggle(ctx: PlayerCtx): boolean {
    if (this.active) {
      this.active = false;
      this.gravity = 1;
      this.#takeoffPending = false;
      this.#takeoffTime = 0;
      this.grounded = false;
      if (!sampleSkyGravity(ctx.position)) this.#restoreEarthOrientation(ctx);
      return false;
    }

    this.enabled = true;
    this.active = true;
    this.gravity = 0;
    this.#takeoffPending = true;
    return true;
  }

  /** Slider entry point. Setting any value deliberately enters flight handling. */
  setGravity(value: number): void {
    this.gravity = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    this.enabled = true;
    this.active = true;
  }

  /** Leave on-foot flight without changing the user's enabled/gravity setting. */
  suspend(ctx?: PlayerCtx): void {
    this.active = false;
    this.gravity = 1;
    this.#takeoffPending = false;
    this.#takeoffTime = 0;
    this.grounded = false;
    if (ctx && !sampleSkyGravity(ctx.position)) this.#restoreEarthOrientation(ctx);
  }

  /** Restore the default-available hover state, for respawns/new sessions. */
  reset(ctx?: PlayerCtx): void {
    this.enabled = true;
    this.active = false;
    this.gravity = 0;
    this.#takeoffPending = false;
    this.#takeoffTime = 0;
    this.field = null;
    this.currentIsland = null;
    this.grounded = false;
    this.up.copy(WORLD_UP);
    this.orientation.identity();
    this.#lastForward.set(0, 0, -1);
    if (ctx) this.#restoreEarthOrientation(ctx);
  }

  /**
   * Returns true when flight owns this on-foot physics step. A false result is
   * the parent's cue to run WalkController normally.
   */
  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame): boolean {
    const suspended = input.suspended;
    if (this.#takeoffPending && this.enabled && !suspended) {
      this.active = true;
      this.#takeoffPending = false;
      this.#takeoffTime = TAKEOFF_HOLD;
    }
    const step = Math.max(0, Math.min(dt, 0.1));
    this.#sampleFieldAndUp(ctx, step);
    // Flight-off still owns the step inside an island field, so its radial
    // gravity and analytic surface remain physical under an ordinary walker.
    const localWalk = !this.active && this.field !== null;
    if ((!this.enabled || !this.active) && !localWalk) return false;
    const nearSurface = this.#nearCurrentSurface(ctx, 3);
    this.#buildMovementFrame(frame, localWalk || nearSurface || this.grounded);

    const ix = suspended ? 0 : input.axis("KeyA", "KeyD");
    const iz = suspended ? 0 : input.axis("KeyS", "KeyW");
    const boost = !suspended && (input.down("ShiftLeft") || input.down("ShiftRight"));
    let ascent = suspended
      ? 0
      : Math.max(input.down("Space") || input.down("KeyU") ? 1 : 0, this.#takeoffTime > 0 ? 1 : 0) -
        (input.down("KeyQ") ? 1 : 0);
    if (localWalk) ascent = 0;
    this.#takeoffTime = Math.max(0, this.#takeoffTime - step);
    const surfaceWalk = localWalk || (nearSurface && this.grounded && Math.abs(ascent) < 1e-6);

    const inputMagnitude = Math.min(1, Math.hypot(ix, iz));
    S.desired
      .copy(S.moveForward)
      .multiplyScalar(iz)
      .addScaledVector(S.right, ix);
    if (S.desired.lengthSq() > 1e-8) S.desired.normalize().multiplyScalar(inputMagnitude);
    const speed = surfaceWalk
      ? (boost ? WALK_TUNING.values.runSpeed : WALK_TUNING.values.speed) * INPUT_TUNING.values.moveSpeedScale
      : (boost ? SKY_FLIGHT_BOOST_SPEED : SKY_FLIGHT_SPEED) * INPUT_TUNING.values.moveSpeedScale;
    S.desired.multiplyScalar(speed);

    S.velocity.set(frame.v.linear[0], frame.v.linear[1], frame.v.linear[2]);
    const currentVertical = S.velocity.dot(this.up);
    S.expectedVelocity.copy(S.velocity).addScaledVector(this.up, -currentVertical);
    const desiredVertical = ascent * speed;
    const moveAlpha = expAlpha(boost ? MOVE_RESPONSE * 1.4 : MOVE_RESPONSE, step);
    S.expectedVelocity.lerp(S.desired, moveAlpha);

    if (localWalk) {
      let vertical = currentVertical;
      if (!suspended && (this.grounded || nearSurface) && input.pressed("Space")) {
        vertical = Math.max(vertical, WALK_TUNING.values.jump);
      }
      S.expectedVelocity.addScaledVector(this.up, vertical);
    } else if (Math.abs(ascent) > 1e-6) {
      let vertical = currentVertical + (desiredVertical - currentVertical) * moveAlpha;
      if (this.#takeoffTime > 0 || (ascent > 0 && this.grounded)) vertical = Math.max(vertical, TAKEOFF_SPEED);
      S.expectedVelocity.addScaledVector(this.up, vertical);
    } else if (Math.abs(this.gravity) < 1e-4 && !this.field) {
      // Hover is a true settle: release the controls and motion fades to rest.
      S.expectedVelocity.addScaledVector(this.up, currentVertical * (1 - moveAlpha));
    } else {
      // Natural/inverse gravity is allowed to accumulate without a terminal-
      // velocity damper. Only the camera-plane steering component is damped.
      S.expectedVelocity.addScaledVector(this.up, currentVertical);
    }

    this.#desiredGravity(S.gravity, localWalk ? 1 : this.gravity);
    S.expectedVelocity.addScaledVector(S.gravity, step);
    if (!finiteVector(S.expectedVelocity)) S.expectedVelocity.set(0, 0, 0);

    this.grounded = false;
    this.#resolveIslandSurfaces(ctx, S.expectedVelocity, step);
    if (this.grounded && this.currentIsland && Math.abs(ascent) < 1e-6) {
      this.#adhereToIslandSurface(ctx, S.expectedVelocity, step);
    }
    this.#resolveWorldSweep(ctx, S.expectedVelocity, step);
    if (!this.currentIsland) {
      const support = ctx.physics.supportBelow(
        ctx.position.x,
        ctx.position.y,
        ctx.position.z,
        SUPPORT_REACH
      );
      if (support && S.expectedVelocity.dot(WORLD_UP) <= 0.35) this.grounded = true;
    }

    // Convert the desired post-step velocity into the pre-step write expected
    // by a world that will still apply CONFIG.gravity to every dynamic body.
    S.velocity.copy(S.expectedVelocity).addScaledVector(WORLD_GRAVITY, -step);
    ctx.physics.world.setBodyVelocity(
      ctx.body,
      [S.velocity.x, S.velocity.y, S.velocity.z],
      [0, 0, 0]
    );
    this.#updateOrientation(ctx, step);
    ctx.velocity.copy(S.expectedVelocity);
    ctx.speed = S.expectedVelocity.length();
    return true;
  }

  #sampleFieldAndUp(ctx: PlayerCtx, dt: number): void {
    this.field = sampleSkyGravity(ctx.position);
    this.currentIsland = this.field ? getSkyIsland(this.field.dominantIslandId) ?? null : null;

    S.desiredUp.copy(WORLD_UP);
    if (this.field && this.currentIsland) {
      S.radial.set(
        ctx.position.x - this.currentIsland.center.x,
        ctx.position.y - this.currentIsland.center.y,
        ctx.position.z - this.currentIsland.center.z
      );
      if (S.radial.lengthSq() > 1e-10) {
        S.radial.normalize();
        S.desiredUp.lerp(S.radial, smoothstep01(this.field.influence));
        if (S.desiredUp.lengthSq() > 1e-10) S.desiredUp.normalize();
      }

      const contactRadius = this.currentIsland.landingRadius + WALK_CAPSULE_HALF_EXTENT;
      const distance = ctx.position.distanceTo(S.castOrigin.set(
        this.currentIsland.center.x,
        this.currentIsland.center.y,
        this.currentIsland.center.z
      ));
      // Exact radial alignment at contact keeps the capsule's lower cap flush
      // with the little world's surface. Away from it, blend field boundaries.
      if (distance <= contactRadius + 1.5 && S.radial.lengthSq() > 0.5) this.up.copy(S.radial);
      else this.up.lerp(S.desiredUp, expAlpha(UP_RESPONSE, dt)).normalize();
    } else {
      this.up.lerp(WORLD_UP, expAlpha(UP_RESPONSE, dt)).normalize();
    }
    if (!finiteVector(this.up) || this.up.lengthSq() < 0.5) this.up.copy(WORLD_UP);
  }

  #desiredGravity(out: THREE.Vector3, scale: number): void {
    if (!this.field) {
      out.copy(WORLD_GRAVITY).multiplyScalar(scale);
      return;
    }
    // The local sample already contains its radial magnitude/falloff. Earth
    // fades back in over the same influence band. Local gravity remains natural
    // at hover/positive settings so islands can be landed on; inverse reflects it.
    const earthShare = 1 - smoothstep01(this.field.influence);
    // Keep the slider continuous across zero: a garden attracts at hover,
    // neutralises at -0.5, and reverses fully at -1.
    const localScale = 1 + Math.min(0, scale) * 2;
    out.set(this.field.x, this.field.y, this.field.z)
      .multiplyScalar(localScale)
      .addScaledVector(WORLD_GRAVITY, earthShare * scale);
  }

  #buildMovementFrame(frame: ModeFrame, tangentMovement: boolean): void {
    S.aim.copy(frame.aim);
    if (!finiteVector(S.aim) || S.aim.lengthSq() < 1e-8) {
      S.aim.set(-Math.sin(frame.camYaw), 0, -Math.cos(frame.camYaw));
    }
    S.aim.normalize();
    S.forward.copy(S.aim).addScaledVector(this.up, -S.aim.dot(this.up));
    if (S.forward.lengthSq() < 1e-6) {
      S.bodyForward.copy(this.#lastForward).addScaledVector(this.up, -this.#lastForward.dot(this.up));
      if (S.bodyForward.lengthSq() < 1e-6) {
        S.bodyForward.set(0, 0, -1).addScaledVector(this.up, this.up.z);
        if (S.bodyForward.lengthSq() < 1e-6) S.bodyForward.set(1, 0, 0);
      }
      S.forward.copy(S.bodyForward);
    }
    S.forward.normalize();
    S.right.crossVectors(S.forward, this.up).normalize();
    S.moveForward.copy(tangentMovement ? S.forward : S.aim);
    this.#lastForward.copy(S.forward);
  }

  #nearCurrentSurface(ctx: PlayerCtx, margin: number): boolean {
    const island = this.currentIsland;
    if (!island) return false;
    const dx = ctx.position.x - island.center.x;
    const dy = ctx.position.y - island.center.y;
    const dz = ctx.position.z - island.center.z;
    return Math.hypot(dx, dy, dz) <= island.landingRadius + WALK_CAPSULE_HALF_EXTENT + margin;
  }

  #resolveIslandSurfaces(ctx: PlayerCtx, velocity: THREE.Vector3, dt: number): void {
    const p = ctx.position;
    let correctedPosition = false;
    for (const island of SKY_ISLANDS) {
      const radius = island.landingRadius + WALK_CAPSULE_HALF_EXTENT;
      S.relative.set(
        p.x - island.center.x,
        p.y - island.center.y,
        p.z - island.center.z
      );
      let distance = S.relative.length();
      if (!Number.isFinite(distance)) continue;
      if (distance < 1e-6) {
        S.relative.copy(this.up);
        if (!finiteVector(S.relative) || S.relative.lengthSq() < 0.5) S.relative.copy(WORLD_UP);
        distance = 0;
      } else {
        S.relative.multiplyScalar(1 / distance);
      }

      if (distance < radius) {
        p.set(
          island.center.x + S.relative.x * (radius + SPHERE_CONTACT_SKIN),
          island.center.y + S.relative.y * (radius + SPHERE_CONTACT_SKIN),
          island.center.z + S.relative.z * (radius + SPHERE_CONTACT_SKIN)
        );
        correctedPosition = true;
        distance = radius + SPHERE_CONTACT_SKIN;
      }

      const inwardSpeed = velocity.dot(S.relative);
      if (distance <= radius + SPHERE_CONTACT_SKIN * 2 && inwardSpeed < 0) {
        velocity.addScaledVector(S.relative, -inwardSpeed);
        this.grounded = true;
        if (!this.currentIsland || this.currentIsland.id === island.id) this.up.copy(S.relative);
        continue;
      }

      S.displacement.copy(velocity).multiplyScalar(dt);
      const a = S.displacement.lengthSq();
      if (a < 1e-10) continue;
      S.relative.set(
        p.x - island.center.x,
        p.y - island.center.y,
        p.z - island.center.z
      );
      const b = 2 * S.relative.dot(S.displacement);
      const c = S.relative.lengthSq() - radius * radius;
      const discriminant = b * b - 4 * a * c;
      if (b >= 0 || discriminant < 0) continue;
      const fraction = (-b - Math.sqrt(discriminant)) / (2 * a);
      if (fraction < 0 || fraction > 1) continue;
      const travel = Math.sqrt(a);
      const safeFraction = Math.max(0, fraction - SPHERE_CONTACT_SKIN / travel);
      velocity.multiplyScalar(safeFraction);
      this.grounded = true;
    }

    if (correctedPosition) {
      ctx.physics.world.setBodyTransform(
        ctx.body,
        [p.x, p.y, p.z],
        [this.orientation.x, this.orientation.y, this.orientation.z, this.orientation.w]
      );
      ctx.snapRenderPose?.();
    }
  }

  /**
   * A tangent is a straight line while the island surface curves away beneath
   * it. Choose the tiny inward velocity whose next endpoint stays on the shell;
   * this supplies the centripetal component that an ordinary flat walk gets
   * from its floor contact, without teleporting around the sphere each frame.
   */
  #adhereToIslandSurface(ctx: PlayerCtx, velocity: THREE.Vector3, dt: number): void {
    const island = this.currentIsland;
    if (!island || dt <= 1e-6) return;
    S.relative.set(
      ctx.position.x - island.center.x,
      ctx.position.y - island.center.y,
      ctx.position.z - island.center.z
    );
    const distance = S.relative.length();
    if (!Number.isFinite(distance) || distance < 1e-6) return;
    S.relative.multiplyScalar(1 / distance);
    const radialSpeed = velocity.dot(S.relative);
    S.displacement.copy(velocity).addScaledVector(S.relative, -radialSpeed);
    const tangentStepSq = S.displacement.lengthSq() * dt * dt;
    const radius = island.landingRadius + WALK_CAPSULE_HALF_EXTENT + SPHERE_CONTACT_SKIN;
    const targetRadialDistance = Math.sqrt(Math.max(0, radius * radius - tangentStepSq));
    const neededRadialSpeed = (targetRadialDistance - distance) / dt;
    velocity.copy(S.displacement).addScaledVector(S.relative, neededRadialSpeed);
  }

  #resolveWorldSweep(ctx: PlayerCtx, velocity: THREE.Vector3, dt: number): void {
    const travel = velocity.length() * dt;
    if (travel < 0.12) return;
    S.displacement.copy(velocity).normalize();
    S.sweepRight.crossVectors(S.displacement, this.up);
    if (S.sweepRight.lengthSq() < 1e-6) S.sweepRight.crossVectors(S.displacement, S.forward);
    if (S.sweepRight.lengthSq() < 1e-6) S.sweepRight.set(1, 0, 0);
    else S.sweepRight.normalize();

    let available = travel;
    const cast = (alongUp: number, alongRight: number): void => {
      S.castOffset.copy(this.up).multiplyScalar(alongUp).addScaledVector(S.sweepRight, alongRight);
      S.castOrigin.copy(ctx.position).add(S.castOffset);
      const hit = ctx.physics.raycastWorld(S.castOrigin, S.displacement, travel + WALK_CAPSULE_RADIUS);
      if (!hit || hit.kind === "water") return;
      const distance = S.castOrigin.distanceTo(hit.point) - WALK_CAPSULE_RADIUS - WORLD_SWEEP_SKIN;
      if (distance < available) available = Math.max(0, distance);
    };
    cast(0, 0);
    cast(WALK_CAPSULE_HALF_EXTENT * 0.72, 0);
    cast(-WALK_CAPSULE_HALF_EXTENT * 0.72, 0);
    cast(0, WALK_CAPSULE_RADIUS * 0.82);
    cast(0, -WALK_CAPSULE_RADIUS * 0.82);
    if (available < travel) {
      velocity.multiplyScalar(available / travel);
      this.grounded = true;
    }
  }

  #updateOrientation(ctx: PlayerCtx, dt: number): void {
    S.basisBack.copy(S.forward).negate();
    S.matrix.makeBasis(S.right, this.up, S.basisBack);
    S.earthQuat.setFromRotationMatrix(S.matrix).normalize();
    if (!finiteVector(this.up) || !Number.isFinite(S.earthQuat.w)) S.earthQuat.identity();
    if (this.grounded && this.currentIsland) this.orientation.copy(S.earthQuat);
    else this.orientation.slerp(S.earthQuat, expAlpha(ORIENTATION_RESPONSE, dt)).normalize();
    ctx.quaternion.copy(this.orientation);
    ctx.physics.world.setBodyTransform(
      ctx.body,
      [ctx.position.x, ctx.position.y, ctx.position.z],
      [this.orientation.x, this.orientation.y, this.orientation.z, this.orientation.w]
    );
    if (Math.abs(this.up.y) > 0.8) ctx.heading = Math.atan2(-S.forward.x, -S.forward.z) + Math.PI;
  }

  #restoreEarthOrientation(ctx: PlayerCtx): void {
    this.field = null;
    this.currentIsland = null;
    this.up.copy(WORLD_UP);
    S.earthQuat.setFromAxisAngle(WORLD_UP, ctx.heading);
    this.orientation.copy(S.earthQuat);
    ctx.quaternion.copy(this.orientation);
    ctx.physics.world.setBodyTransform(
      ctx.body,
      [ctx.position.x, ctx.position.y, ctx.position.z],
      [this.orientation.x, this.orientation.y, this.orientation.z, this.orientation.w]
    );
  }
}
