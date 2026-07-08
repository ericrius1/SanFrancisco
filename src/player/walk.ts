import * as THREE from "three/webgpu";
import { BodyType } from "../core/physics";
import { tunables } from "../core/persist";
import { waterHeight } from "../world/heightmap";
import type { Input } from "../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "./types";
import { enterOnLand } from "../vehicles/shared";

export const WALK_TUNING = tunables("movement.walk", {
  speed: { v: 5.2, min: 1, max: 20, step: 0.1, label: "walk speed" },
  runSpeed: { v: 10, min: 2, max: 30, step: 0.1, label: "run speed" },
  jump: { v: 7.2, min: 2, max: 20, step: 0.1, label: "jump" },
  swimFactor: { v: 0.45, min: 0.1, max: 1, step: 0.05, label: "swim speed ×" },
  swimBoost: { v: 2, min: 0, max: 8, step: 0.1, label: "swim boost" },
  climbSpeed: { v: 4.2, min: 1, max: 12, step: 0.1, label: "wall climb" }
});

// jump feel, same trick as the board: buffer an early press so it survives
// render frames that ran no physics step (high-refresh drops the edge before
// walk.update sees it), and keep footing warm briefly after leaving the ground
// so grounded-flicker while standing can't eat a jump.
const JUMP_BUFFER_TIME = 0.18;
const COYOTE_TIME = 0.12;

// How deep the capsule bottom rests below the surface while swimming idle. The
// capsule is ~1.8 m tall (centre = bottom + 0.9), so a 1.4 m rest sink puts the
// waterline at the chest/shoulders — swimming *in* the water, not standing on it.
const SWIM_REST_DEPTH = 1.4;

const V = {
  tmp: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0)
};

/** On foot: walking, running, swimming, and climbing any building face. */
export class WalkController implements ModeController {
  readonly spawnLift = 0.8;

  // read by the walker-pose animation
  grounded = false;
  swimming = false;
  climbing = false;
  #jumpBuf = 0; // seconds a Space press stays pending
  #coyote = 0; // seconds after losing footing a jump still fires

  spawnBody(ctx: PlayerCtx, _facing: number): number {
    const p = ctx.position;
    ctx.body = ctx.physics.world.createCapsule({
      type: BodyType.Dynamic,
      position: [p.x, p.y + 0.4, p.z],
      halfHeight: 0.55,
      radius: 0.35,
      density: 160,
      friction: 0.05,
      restitution: 0
    });
    return p.y + 0.8;
  }

  enter(ctx: PlayerCtx) {
    if (ctx.swimEnter) {
      ctx.swimEnter = false;
      // drop in already at the swim waterline (centre a touch under the surface)
      // so buoyancy holds instead of dropping you in from a hop above the water
      const y = waterHeight(ctx.position.x, ctx.position.z, ctx.time);
      ctx.position.y = y - 0.2;
      return;
    }
    enterOnLand(ctx); // need land under us
  }

  /** Buffer a jump (also latched at render-frame rate from the main loop, so
   * high-refresh displays can't drop the press between physics steps). */
  requestJump() {
    this.#jumpBuf = JUMP_BUFFER_TIME;
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const { camYaw, v } = frame;
    const w = ctx.physics.world;
    const ground = ctx.map.effectiveGround(ctx.position.x, ctx.position.z);
    const bottom = ctx.position.y - 0.9;
    // grounded on terrain, or resting on something the heightmap doesn't know
    // about (floating island, rubble pile): vertical speed ~0 means supported
    this.grounded = bottom - ground < 0.25 || Math.abs(v.linear[1]) < 0.02;

    // buffer the press early, keep footing warm after leaving the ground
    if (!input.suspended && input.pressed("Space")) this.requestJump();
    else this.#jumpBuf = Math.max(0, this.#jumpBuf - dt);
    if (this.grounded) this.#coyote = COYOTE_TIME;
    else this.#coyote = Math.max(0, this.#coyote - dt);

    const ix = input.axis("KeyA", "KeyD");
    const iz = input.axis("KeyS", "KeyW");
    const run = input.down("ShiftLeft") || input.down("ShiftRight");
    const tw = WALK_TUNING.values;
    const speed = run ? tw.runSpeed : tw.speed;

    const dir = V.tmp.set(ix, 0, -iz);
    if (dir.lengthSq() > 0) {
      dir.normalize().applyAxisAngle(V.up, camYaw);
      ctx.heading = Math.atan2(-dir.x, -dir.z) + Math.PI;
    }

    const waterY = waterHeight(ctx.position.x, ctx.position.z, ctx.time);
    const swimming = ground < waterY - 1.0 && bottom < waterY;
    this.swimming = swimming;

    // wall climbing: press into any building face and just walk straight up it.
    // Velocity-driven like everything else — the static building body keeps us
    // from phasing through; a gentle push into the face keeps us tracking it.
    this.climbing = false;
    let vx = dir.x * speed;
    let vz = dir.z * speed;
    let vy = v.linear[1];
    if (dir.lengthSq() > 0 && !swimming) {
      const wall = ctx.physics.wallAhead(ctx.position, dir.x, dir.z, 1.25);
      if (wall && dir.x * wall.nx + dir.z * wall.nz < -0.45 && wall.top > bottom + 0.3) {
        this.climbing = true;
        if (this.#jumpBuf > 0) {
          // kick off the wall (flag stays set this frame so the ground branch
          // below doesn't overwrite the leap velocities)
          const wallKick = 7; // m/s shove straight off the wall face
          vx = wall.nx * wallKick;
          vz = wall.nz * wallKick;
          vy = tw.jump * 0.9;
          this.#jumpBuf = 0;
        } else {
          const atLip = bottom > wall.top - 0.6;
          vy = atLip ? tw.jump * 0.75 : tw.climbSpeed; // pop over the parapet at the top
          vx = dir.x * (atLip ? 3.2 : 0.9);
          vz = dir.z * (atLip ? 3.2 : 0.9);
        }
      }
    }
    if (!this.climbing) {
      if (swimming) {
        // --- swimming: bob at the surface, dive when you look/press down ------
        // Horizontal glide (run key is repurposed as dive, so use base speed).
        const swimSpeed = tw.speed * tw.swimFactor;
        vx = dir.x * swimSpeed;
        vz = dir.z * swimSpeed;
        // Vertical command: look-pitch dive while swimming forward (nose down + W
        // = go under), plus explicit Space=up / Shift=down for fine control.
        let vSwim = frame.aim.y * swimSpeed * iz;
        if (input.down("Space")) vSwim += tw.swimBoost;
        if (run) vSwim -= tw.swimBoost;
        // Buoyancy floats you back to the waterline when idle; suppressed while
        // actively diving so you can get under and roam instead of popping up.
        const restBottom = waterY - SWIM_REST_DEPTH;
        let buoy = (restBottom - bottom) * 3;
        if (vSwim < 0) buoy = Math.min(buoy, 0);
        vy = buoy + vSwim - v.linear[1] * 0.5;
        // never burrow into the seabed
        const minBottom = ground + 0.25;
        if (bottom < minBottom) vy = Math.max(vy, (minBottom - bottom) * 4);
      } else {
        if (this.#jumpBuf > 0 && (this.grounded || this.#coyote > 0)) {
          vy = Math.max(vy, tw.jump);
          this.#jumpBuf = 0;
          this.#coyote = 0;
        }
        vx = dir.x * speed;
        vz = dir.z * speed;
      }
    }
    // velocity-only control: the solver owns position/contacts (teleporting the body
    // every step is what made walking jitter). Angular velocity pinned to zero keeps
    // the capsule from tumbling; if solver impulses still tilt it, right it once.
    w.setBodyVelocity(ctx.body, [vx, vy, vz], [0, 0, 0]);
    const bodyUpY = 1 - 2 * (ctx.quaternion.x * ctx.quaternion.x + ctx.quaternion.z * ctx.quaternion.z);
    if (bodyUpY < 0.94) {
      w.setBodyTransform(
        ctx.body,
        [ctx.position.x, ctx.position.y, ctx.position.z],
        [0, Math.sin(ctx.heading / 2), 0, Math.cos(ctx.heading / 2)]
      );
    }
  }
}
