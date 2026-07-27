import * as THREE from "three/webgpu";
import { BodyType } from "../core/physics";
import { tunables } from "../core/persist";
import { INPUT_TUNING } from "../config";
import { waterHeight } from "../world/heightmap";
import { swimVolumeAt } from "../world/swimVolumes";
import type { Input } from "../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "./types";
import { enterOnLand } from "../vehicles/shared";

export const WALK_TUNING = tunables("movement.walk", {
  speed: { v: 5.2, min: 1, max: 20, step: 0.1, label: "walk speed" },
  runSpeed: { v: 11.5, min: 2, max: 30, step: 0.1, label: "run speed" },
  // Interiors feel large at outdoor paces; keep foot speed ~60% while inside.
  indoorSpeed: { v: 0.6, min: 0.2, max: 1, step: 0.05, label: "indoor speed ×" },
  // Raking the zen garden is deliberate; halve foot speed at every tier.
  rakeSpeed: { v: 0.5, min: 0.2, max: 1, step: 0.05, label: "rake speed ×" },
  jump: { v: 7.2, min: 2, max: 20, step: 0.1, label: "jump" },
  swimFactor: { v: 0.45, min: 0.1, max: 1, step: 0.05, label: "swim speed ×" },
  swimBoost: { v: 2, min: 0, max: 8, step: 0.1, label: "swim boost" }
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
/**
 * …and how deep it rests in an authored pool, which is shallower.
 *
 * The swim pose lays the body flat, so the first-person eye ends up only ~0.3 m
 * above the capsule centre — at the bay's rest depth that puts the eye 0.1 m
 * UNDER the surface even while idling at the top. In open water nothing showed
 * it, because the ocean sheet is single-sided from below. A pool sheet is not
 * (it has an underside now), so a floating swimmer would sit staring at the
 * ceiling of a pool they are supposedly on top of. Float higher: eyes out,
 * shoulders awash, which is what treading water looks like anyway. The bay
 * keeps the deeper rest, where swell would otherwise heave the capsule clear of
 * the water on every trough.
 */
const POOL_SWIM_REST_DEPTH = 0.95;
/**
 * How close a diving capsule may get to a pool's tiles — and so, in 2.56 m of
 * water, the dive limit in the baths. Too generous and the eye never gets far
 * enough under for the underwater package to read; too tight and the floor
 * recovery contract (sutroBaths/index.ts's takeFloorHandoffHeight, which lifts
 * anything below basin + 0.84 m) starts fighting the swimmer for the capsule.
 */
const POOL_FLOOR_CLEARANCE = 0.2;
/**
 * Hauling out of an authored pool.
 *
 * Buoyancy owns the vertical axis while you swim and a swimmer has no jump, so
 * a bath you can walk into is a bath you cannot leave: the coping stands above
 * the float line, and pressing into it only holds you against the wall. Swim at
 * the side and the body climbs the edge instead — no key to learn, which is the
 * whole point, since the visitor discovering the problem is already mid-swim.
 *
 * The probe reaches a little past the capsule's own contact point, so the haul
 * arms while you are pressed against the wall rather than only once your centre
 * has crossed it. The rise cap spans a whole bath — floor to coping — because
 * the swimmer who most needs the ladder is the one down at the tiles: down
 * there the capsule sits BELOW the deck slab, with nothing but the recovery
 * contract between them and swimming clean through the wall to be snapped up
 * on the far side. Climbing the wall is the same exit, minus the teleport.
 */
const POOL_EXIT_PROBE = 0.9;
const POOL_EXIT_MAX_RISE = 3;
/** Bottom clearance over the rim before the haul counts as landed. */
const POOL_EXIT_CLEARANCE = 0.22;
/** Climb rate, and the press that carries you forward once you clear the edge. */
const POOL_EXIT_RISE_SPEED = 2.6;
const POOL_EXIT_PUSH = 2.6;
/** A haul that hasn't landed by now was aimed at something unclimbable. */
const POOL_EXIT_TIMEOUT = 2.5;
export const WALK_CAPSULE_HALF_HEIGHT = 0.55;
export const WALK_CAPSULE_RADIUS = 0.35;
export const WALK_CAPSULE_HALF_EXTENT = WALK_CAPSULE_HALF_HEIGHT + WALK_CAPSULE_RADIUS;

const V = {
  tmp: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0)
};

/** On foot: walking, running, and swimming. */
export class WalkController implements ModeController {
  readonly spawnLift = 0.8;

  // read by the walker-pose animation
  grounded = false;
  swimming = false;
  #jumpBuf = 0; // seconds a Space press stays pending
  #coyote = 0; // seconds after losing footing a jump still fires
  /** Active haul-out over a pool coping — see the POOL_EXIT_* contract. */
  #climbOut: { rimY: number; time: number } | null = null;

  spawnBody(ctx: PlayerCtx, _facing: number): number {
    const p = ctx.position;
    ctx.body = ctx.physics.world.createCapsule({
      type: BodyType.Dynamic,
      position: [p.x, p.y + 0.4, p.z],
      halfHeight: WALK_CAPSULE_HALF_HEIGHT,
      radius: WALK_CAPSULE_RADIUS,
      density: 160,
      friction: 0.05,
      restitution: 0
    });
    return p.y + 0.8;
  }

  enter(ctx: PlayerCtx) {
    this.#climbOut = null;
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
    const speedScale = INPUT_TUNING.values.moveSpeedScale;
    const indoorScale = ctx.indoor ? tw.indoorSpeed : 1;
    const rakeScale = ctx.raking ? tw.rakeSpeed : 1;
    // Stick magnitude (already deadzoned + curved in pollPad) scales speed so a
    // light press creeps and full deflection hits walk/run. Keyboard stays at 1.
    const dir = V.tmp.set(ix, 0, -iz);
    const intent = Math.min(1, Math.hypot(ix, iz));
    if (dir.lengthSq() > 0) {
      dir.normalize().applyAxisAngle(V.up, camYaw);
      ctx.heading = Math.atan2(-dir.x, -dir.z) + Math.PI;
    }
    const topSpeed = (run ? tw.runSpeed : tw.speed) * speedScale * indoorScale * rakeScale;
    const speed = topSpeed * intent;

    // An authored pool (the Sutro baths) wins over the bay: its surface is
    // fixed, and the bed you must not burrow into is its built basin rather
    // than the terrain, which down there sits well below the hall floor.
    const pool = swimVolumeAt(ctx.position.x, ctx.position.z);
    const waterY = pool ? pool.surfaceY : waterHeight(ctx.position.x, ctx.position.z, ctx.time);
    const bed = pool ? pool.floorY : ground;
    const swimming = bed < waterY - 1.0 && bottom < waterY;
    this.swimming = swimming;

    // Haul-out latch. Arm it when a swimmer presses into a coping within reach;
    // hold it — across the frame where the rising body stops counting as
    // swimming — until they are over the edge, they let go, or the rim turns
    // out to be something they cannot climb after all.
    if (this.#climbOut) {
      this.#climbOut.time += dt;
      // Released at the rim, not at the climb target: the target is approached
      // asymptotically and would leave the latch hovering the body a hand's
      // width over the deck until the timeout swatted it down. Above the rim
      // and over the slab IS out — let gravity settle the last few centimetres.
      const landed =
        bottom >= this.#climbOut.rimY &&
        (!pool || !pool.contains(ctx.position.x, ctx.position.z));
      if (landed || intent < 0.05 || this.#climbOut.time > POOL_EXIT_TIMEOUT) this.#climbOut = null;
    } else if (swimming && pool?.climbOutY && intent > 0.05) {
      const probeX = ctx.position.x + dir.x * POOL_EXIT_PROBE;
      const probeZ = ctx.position.z + dir.z * POOL_EXIT_PROBE;
      const rimY = pool.contains(probeX, probeZ) ? null : pool.climbOutY(probeX, probeZ);
      if (rimY !== null && rimY > bottom && rimY - bottom <= POOL_EXIT_MAX_RISE) {
        this.#climbOut = { rimY, time: 0 };
      }
    }

    let vx = dir.x * speed;
    let vz = dir.z * speed;
    let vy = v.linear[1];
    if (this.#climbOut) {
      // Up the wall first, over it second. Pushing forward the whole way would
      // be wrong below the coping: a capsule down at tile level has no slab in
      // front of it, so the press would carry it clean THROUGH the wall and
      // leave the recovery contract to teleport it out — the very snap this
      // climb exists to replace. Above the rim the press resumes and the arc
      // finishes onto the deck. Holding at the target rather than falling back
      // is safe: the target IS a walk surface, so nothing here can lift anyone
      // anywhere they could not have walked.
      const target = this.#climbOut.rimY + POOL_EXIT_CLEARANCE;
      const overTheEdge = bottom >= this.#climbOut.rimY;
      vx = overTheEdge ? dir.x * POOL_EXIT_PUSH : 0;
      vz = overTheEdge ? dir.z * POOL_EXIT_PUSH : 0;
      vy = Math.min(POOL_EXIT_RISE_SPEED, (target - bottom) * 6);
    } else if (swimming) {
      // --- swimming: bob at the surface, dive when you look/press down ------
      // Horizontal glide (run key is repurposed as dive, so use base speed).
      const swimSpeed = tw.speed * tw.swimFactor * speedScale * intent;
      vx = dir.x * swimSpeed;
      vz = dir.z * swimSpeed;
      // Vertical command: look-pitch dive while swimming forward (nose down + W
      // = go under), plus explicit Space=up / Shift=down for fine control.
      // Use unit forward (iz/intent) so dive strength tracks swim speed, not intent².
      const forward = intent > 1e-6 ? iz / intent : 0;
      let vSwim = frame.aim.y * swimSpeed * forward;
      if (input.down("Space")) vSwim += tw.swimBoost;
      if (run) vSwim -= tw.swimBoost;
      // Buoyancy floats you back to the waterline when idle; suppressed while
      // actively diving so you can get under and roam instead of popping up.
      const restBottom = pool
        ? // A bath is 2.6 m deep: rest high enough that the eye clears the
          // sheet, and never so low that the capsule parks on the tiles.
          Math.max(waterY - POOL_SWIM_REST_DEPTH, bed + POOL_FLOOR_CLEARANCE + 0.6)
        : waterY - SWIM_REST_DEPTH;
      let buoy = (restBottom - bottom) * 3;
      if (vSwim < 0) buoy = Math.min(buoy, 0);
      vy = buoy + vSwim - v.linear[1] * 0.5;
      // never burrow into the seabed (or the basin tiles)
      const minBottom = bed + (pool ? POOL_FLOOR_CLEARANCE : 0.25);
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
