import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import type { Input } from "../../core/input";
import type { ModeController, ModeFrame, PlayerCtx } from "../../player/types";
import { SKATE_DECK_DROP, SKATE_RIDE_HEIGHT } from "./mesh";
import { findGrindRail, type GrindHit, type GrindRail } from "./rails";
import { SKATE_TUNING } from "./tuning";
import { spinName, TRICK_POINTS, TrickBook } from "./tricks";

const RAD2DEG = 180 / Math.PI;
const TAU = Math.PI * 2;
/** How far off the bar's line the deck can be pointing and still 50-50 it. */
const BOARDSLIDE_COS = 0.64; // ≈ 50°
const LAND_GRACE = 0.22; // seconds after touchdown you may still start a manual

const V = {
  fwd: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  localX: new THREE.Vector3(1, 0, 0),
  localZ: new THREE.Vector3(0, 0, 1),
  quat: new THREE.Quaternion()
};

/** Move `v` toward `target` by at most `step`. */
const toward = (v: number, target: number, step: number) =>
  v > target ? Math.max(target, v - step) : Math.min(target, v + step);

/** A deck rotation that runs on a clock and always finishes where it started. */
type DeckTrick = {
  name: string;
  points: number;
  roll: number; // total radians about the deck's long axis
  shove: number; // total radians about the deck's up axis
  t: number;
  dur: number;
};

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Street skating.
 *
 * Three ideas do all the work:
 *
 * 1. **Gravity is the throttle.** A push is a discrete kick that tops out well
 *    short of the real limit; everything past that comes from pointing the
 *    thing down a San Francisco hill. Coast drag is tiny, so the speed a hill
 *    gives you survives the flat at the bottom.
 * 2. **The deck rotates separately from the skater.** Flips and shove-its run
 *    on `visual`, applied to the mesh's trick pivot, so the board spins under
 *    the feet and always lands where it started. Only spins (yaw) and
 *    front/back flips (pitch) move the BODY — which is why only those can put
 *    you on your back at touchdown.
 * 3. **The combo is the game.** Nothing scores until you roll away clean;
 *    grinds and manuals hold the chain open in between. See tricks.ts.
 *
 * Grinds lock onto registered rail segments (rails.ts) whenever the deck comes
 * down onto one travelling roughly along it — no button, because hunting for a
 * grind button mid-air is not the fun part.
 */
export class SkateController implements ModeController {
  readonly spawnLift = SKATE_RIDE_HEIGHT + 0.05;

  // --- attitude (drives the physics quaternion) ---------------------------
  yaw = 0;
  lean = 0; // roll about the deck's long axis
  pitch = 0; // + = nose up

  // --- render-facing state (scalars only: no allocation from the frame loop)
  /** Deck-only trick rotation + wheel spin, handed straight to animateSkate. */
  visual = { flipRoll: 0, shove: 0, grindSparks: 0, speed: 0 };
  grounded = true;
  grinding = false;
  manualing = false;
  grabbing = false;
  bailing = false;
  /** 0..1 ollie crouch / landing squash — the pose reads this. */
  crouch = 0;
  /** One push stroke: 1 at the kick, easing to 0 as the foot returns to the
   *  tail. Zero means both feet are on the board — no perpetual jogging. */
  pushKick = 0;
  /** Smoothed steer, −1..1, so the rider's shoulders lead the turn. */
  carve = 0;
  /** 0..1 powerslide intensity, for skid audio + marks. */
  slide = 0;
  /** Signed balance meter, ±1 = eating it. */
  balance = 0;
  horizontalSpeed = 0;
  airTime = 0;
  grindName = "";
  /** Last thing that scored, for a HUD ticker. */
  book = new TrickBook();

  // --- private ------------------------------------------------------------
  #speed = 0; // signed along-heading speed the ground model owns
  #vy = 0;
  #popLatch = false;
  #jumpLock = 0;
  #wasGrounded = true;
  #landGrace = 0;
  #pushTimer = 0;
  #deck: DeckTrick | null = null;
  #spinDeg = 0;
  #flipRad = 0;
  #flipLatchFwd = false;
  #flipLatchBack = false;
  #grabbedThisAir = false;
  #bailT = 0;
  #bailSpin = 0;
  #rail: GrindRail | null = null;
  #railT = 0;
  #railSign = 1;
  #railDirX = 0;
  #railDirZ = 1;
  #railGrade = 0;
  #railLength = 1;
  #railLift = 0;
  #grindKind: "5050" | "board" | "nose" | "5-0" = "5050";
  #grindLockout = 0;
  /** Set when a grind ended by running off the end of its segment. Street rails
   *  are POLYLINES — dozens of 7 m chords — so running out is almost always the
   *  next chord beginning, not the end of the rail. Without this the skater is
   *  ejected and locked out every seven metres. */
  #grindChain = false;
  #noise = 0.31;

  spawnBody(ctx: PlayerCtx, facing: number): number {
    const p = ctx.position;
    const w = ctx.physics.world;
    ctx.body = w.createBox({
      type: BodyType.Dynamic,
      position: [p.x, p.y + this.spawnLift, p.z],
      // Centred on the collider origin (shin height), sized so the box bottom
      // keeps MIN_DRIVE_GROUND_CLEARANCE above the road — a box wrapped around
      // the actual deck would sit buried in the terrain carpet and the contact
      // solver would eat every metre of push.
      halfExtents: [0.26, 0.27, 0.7],
      density: 45,
      friction: 0.1,
      restitution: 0.02
    });
    w.setBodyGravityScale(ctx.body, 0); // the ground model owns vertical
    this.yaw = facing;
    this.lean = 0;
    this.pitch = 0;
    this.visual.flipRoll = 0;
    this.visual.shove = 0;
    this.visual.grindSparks = 0;
    this.visual.speed = 0;
    this.grounded = true;
    this.grinding = false;
    this.manualing = false;
    this.grabbing = false;
    this.bailing = false;
    this.crouch = 0;
    this.pushKick = 0;
    this.carve = 0;
    this.slide = 0;
    this.balance = 0;
    this.horizontalSpeed = 0;
    this.airTime = 0;
    this.grindName = "";
    this.#speed = 0;
    this.#vy = 0;
    this.#popLatch = false;
    this.#jumpLock = 0;
    this.#wasGrounded = true;
    this.#landGrace = 0;
    this.#pushTimer = 0;
    this.#deck = null;
    this.#spinDeg = 0;
    this.#flipRad = 0;
    this.#grabbedThisAir = false;
    this.#bailT = 0;
    this.#rail = null;
    this.#grindLockout = 0;
    this.#grindChain = false;
    this.book.reset();
    return p.y + this.spawnLift;
  }

  enter(ctx: PlayerCtx) {
    const surface = ctx.map.rideGround(ctx.position.x, ctx.position.z, ctx.position.y);
    ctx.position.y = Math.max(ctx.position.y, surface + SKATE_RIDE_HEIGHT + 0.2);
  }

  /** Latch a Space edge at render rate — a 120 Hz tap must not fall between
   * two physics steps, and the ollie pops on RELEASE. */
  requestJump() {
    this.#popLatch = true;
  }

  update(ctx: PlayerCtx, dt: number, input: Input, frame: ModeFrame) {
    const t = SKATE_TUNING.values;
    const w = ctx.physics.world;
    void frame;
    const suspended = input.suspended;

    const steer = suspended ? 0 : input.axis("KeyD", "KeyA");
    const throttle = suspended ? 0 : input.axis("KeyS", "KeyW");
    const pushHeld = throttle > 0.15;
    const braking = throttle < -0.15;
    const modHeld = suspended ? false : input.down("ShiftLeft");
    const flipPressed = !suspended && input.pressed("KeyQ");
    const grabHeld = !suspended && input.down("KeyX");
    if (!suspended && input.pressed("Space")) this.#popLatch = true;
    const spaceHeld = !suspended && input.down("Space");

    this.book.update(dt);
    this.carve += (steer - this.carve) * Math.min(1, dt * 9);
    this.#jumpLock = Math.max(0, this.#jumpLock - dt);
    this.#grindLockout = Math.max(0, this.#grindLockout - dt);
    this.#pushTimer = Math.max(0, this.#pushTimer - dt);
    // The stroke lasts most of one cadence, so the foot is always back on the
    // tail before the next kick fires.
    this.pushKick = Math.max(0, this.pushKick - dt / (SKATE_TUNING.values.pushInterval * 0.86));
    this.#noise = (this.#noise * 9301 + 0.49297) % 1; // deterministic wobble

    const surface = ctx.map.rideGround(ctx.position.x, ctx.position.z, ctx.position.y);
    const rideY = surface + t.ride;
    const heightAbove = ctx.position.y - rideY;

    // ---- eating it -------------------------------------------------------
    if (this.#bailT > 0) {
      this.#bailT -= dt;
      this.bailing = this.#bailT > 0;
      this.grounded = heightAbove < 0.3;
      this.#speed *= Math.max(0, 1 - 5 * dt);
      this.#bailSpin += dt * 9;
      this.lean = Math.sin(this.#bailSpin) * 1.5;
      this.pitch = Math.cos(this.#bailSpin * 0.8) * 1.1;
      this.#vy = heightAbove > 0.04 ? this.#vy - t.gravity * dt : Math.max(0, (rideY - ctx.position.y) * 10);
      this.#applyMotion(ctx, w, dt);
      if (this.#bailT <= 0) {
        this.lean = 0;
        this.pitch = 0;
        this.#bailSpin = 0;
        this.#landGrace = LAND_GRACE;
      }
      return;
    }

    // ---- grinding --------------------------------------------------------
    if (this.grinding) {
      this.#updateGrind(ctx, w, dt, t, steer, throttle);
      return;
    }

    const grounded = heightAbove < 0.3 && this.#jumpLock <= 0;

    // ---- deck tricks (kickflips and friends run on their own clock) ------
    if (flipPressed && !grounded && !this.#deck) this.#startDeckTrick(steer, throttle);
    this.#advanceDeck(dt);

    if (grounded) {
      // ================= ON THE GROUND ==================================
      if (!this.#wasGrounded) this.#touchDown(ctx, t);

      this.airTime = 0;
      this.#flipLatchFwd = pushHeld;
      this.#flipLatchBack = braking;
      this.#grabbedThisAir = false;
      this.grabbing = false;
      this.#landGrace = Math.max(0, this.#landGrace - dt);

      // Manual: hold the modifier with speed on. Balances on W/S, which have
      // nothing else to do while both wheels are off the ground.
      const wantManual = modHeld && Math.abs(this.#speed) > 1.6;
      if (wantManual && !this.manualing) {
        this.manualing = true;
        this.balance = (this.#noise - 0.5) * 0.25;
        this.book.add("Manual", TRICK_POINTS.manual);
      } else if (!wantManual && this.manualing) {
        this.manualing = false;
      }
      if (this.manualing) {
        this.balance += this.balance * t.manualDrift * dt + (this.#noise - 0.5) * 0.5 * dt;
        this.balance -= throttle * t.manualCorrect * dt;
        this.book.hold(TRICK_POINTS.manualPerSecond * dt);
        if (Math.abs(this.balance) > 1) {
          this.manualing = false;
          this.balance = 0;
        }
      }

      // Push: a real kick, on a cadence, that tops out short of the good stuff.
      if (pushHeld && !this.manualing && this.#pushTimer <= 0 && this.#speed < t.pushSpeed) {
        this.#speed = Math.min(t.pushSpeed, this.#speed + t.pushKick);
        this.#pushTimer = t.pushInterval;
        this.pushKick = 1;
      }
      // Brake drags toward a standstill from either direction — S is a foot
      // down, not a reverse gear.
      if (braking && !this.manualing) this.#speed = toward(this.#speed, 0, t.brake * dt);

      // Gravity along the grade — the only road to top speed.
      const e = 1.6;
      V.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const ahead = ctx.map.rideGround(
        ctx.position.x + V.fwd.x * e,
        ctx.position.z + V.fwd.z * e,
        ctx.position.y
      );
      const behind = ctx.map.rideGround(
        ctx.position.x - V.fwd.x * e,
        ctx.position.z - V.fwd.z * e,
        ctx.position.y
      );
      const gradeAngle = Math.atan2(ahead - behind, 2 * e);
      this.#speed += -Math.sin(gradeAngle) * t.gravity * t.slopePull * dt;

      // Powerslide: drag the brake through a hard carve. Scrubs speed, kicks
      // the tail out, and paints a skid.
      const wantSlide = braking && Math.abs(steer) > 0.4 && this.#speed > 4;
      this.slide += ((wantSlide ? Math.min(1, this.#speed / 12) : 0) - this.slide) * Math.min(1, dt * 8);
      if (wantSlide) this.#speed -= t.slideScrub * dt;

      // Drag: urethane is fast, so this is small — but past what pushing can
      // reach, a second term keeps a bomb from running away forever.
      this.#speed -= this.#speed * t.rollDrag * dt;
      if (this.#speed > t.pushSpeed) {
        const over = (this.#speed - t.pushSpeed) / Math.max(1, t.maxSpeed - t.pushSpeed);
        this.#speed -= this.#speed * over * t.fastDrag * dt;
      }
      this.#speed -= Math.abs(steer) * t.carveScrub * this.#speed * 0.06 * dt;
      // Rolling backwards is allowed (and gravity will do it to you if you
      // stall facing up a hill), just never at bombing speed.
      this.#speed = THREE.MathUtils.clamp(this.#speed, -12, t.maxSpeed);

      // Carve. Authority is low at a crawl and full at speed; a powerslide
      // swings the board much harder than a carve ever could. Rolling switch
      // reverses which way the nose swings, same as steering in reverse.
      const grip = 0.4 + Math.min(1, Math.abs(this.#speed) / 8) * 0.6;
      const steerDir = this.#speed >= -0.2 ? 1 : -1;
      const steerRate = steer * steerDir * t.steerRate * grip * (wantSlide ? 2.1 : 1);
      this.yaw += steerRate * dt;

      // Ollie: crouch while held, pop on release (a tap pops immediately with
      // no charge, which is exactly what a tap should give you).
      if (spaceHeld) {
        this.crouch = Math.min(1, this.crouch + dt / t.ollieCharge);
      } else if (this.#popLatch) {
        this.#pop(ctx, t);
      } else {
        this.crouch = Math.max(0, this.crouch - dt * 5);
      }

      // Ride the surface: look a nose-length ahead so a kerb lifts the deck
      // before the front truck reaches it.
      if (this.#jumpLock <= 0) {
        const nose = 0.75;
        const aheadY = ctx.map.rideGround(
          ctx.position.x + V.fwd.x * nose,
          ctx.position.z + V.fwd.z * nose,
          ctx.position.y
        );
        const rideYnose = Math.max(surface, aheadY) + t.ride;
        const slopeRate = THREE.MathUtils.clamp(
          ((aheadY - surface) / nose) * Math.max(Math.abs(this.#speed), 2),
          -16,
          26
        );
        this.#vy = THREE.MathUtils.clamp((rideYnose - ctx.position.y) * 13, -14, 20) + slopeRate;
      } else {
        this.#vy -= t.gravity * dt;
      }

      // Attitude: follow the grade, lean into the carve, tip up for manuals.
      const targetPitch = this.manualing
        ? -gradeAngle * 0.4 + t.manualPitch + Math.abs(this.balance) * 0.12
        : -gradeAngle * 0.85;
      this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 9);
      const targetLean =
        THREE.MathUtils.clamp(steerRate * t.carveLean, -0.7, 0.7) + (this.manualing ? this.balance * 0.16 : 0);
      this.lean += (targetLean - this.lean) * Math.min(1, dt * 8);

      // A clean roll-away banks the chain — after a beat, so you can link a
      // manual out of a landing.
      if (!this.manualing && this.#landGrace <= 0 && this.book.active) this.book.land();
    } else {
      // ================= IN THE AIR =====================================
      this.airTime += dt;
      this.manualing = false;
      this.slide += (0 - this.slide) * Math.min(1, dt * 6);
      this.crouch = Math.max(0, this.crouch - dt * 4);

      // Spin: carving straight through a launch keeps spinning, exactly like
      // it does in real life.
      const spinRate = steer * t.airSpin;
      this.yaw += spinRate * dt;
      this.#spinDeg += spinRate * dt * RAD2DEG;

      // Front/back flips, but only from a key pressed AFTER take-off — nobody
      // wants a frontflip every time they ollie while pushing.
      if (!pushHeld) this.#flipLatchFwd = false;
      if (!braking) this.#flipLatchBack = false;
      let flipInput = 0;
      if (pushHeld && !this.#flipLatchFwd) flipInput += 1;
      if (braking && !this.#flipLatchBack) flipInput -= 1;
      if (flipInput !== 0) {
        const d = -flipInput * t.airFlip * dt; // W throws the nose down (frontflip)
        this.pitch += d;
        this.#flipRad += d;
      }

      // Grab: style, points, and a much better silhouette.
      this.grabbing = grabHeld;
      if (grabHeld) {
        if (!this.#grabbedThisAir) {
          this.#grabbedThisAir = true;
          this.book.add(this.#grabName(steer, throttle), TRICK_POINTS.grab);
        }
        this.book.hold(TRICK_POINTS.grabPerSecond * dt);
      }

      // Auto-level on the way down: this is what makes landing a 540 feel
      // achievable instead of a coin flip. It never fights a live flip input.
      this.#vy -= t.gravity * dt;
      if (this.#vy < 0 && flipInput === 0) {
        const nearness = 1 - THREE.MathUtils.smoothstep(heightAbove, 0.2, 2.4);
        const k = Math.min(1, dt * t.landingAssist * nearness);
        // Ease to the NEAREST upright, so a three-quarter flip rewinds rather
        // than forcing a bail. Scoring reads the integrated input, not this,
        // so the assist can never hand out a rotation you didn't earn.
        const upright = Math.round(this.pitch / TAU) * TAU;
        this.pitch += (upright - this.pitch) * k;
        this.lean -= this.lean * k;
      }
      if (this.#popLatch) this.#popLatch = false;
    }

    this.#wasGrounded = grounded;
    this.grounded = grounded;

    // ---- catch a rail ----------------------------------------------------
    if (!this.grinding && this.#grindLockout <= 0 && Math.abs(this.#speed) > t.grindMin) {
      V.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const hit = findGrindRail(
        ctx.position.x,
        ctx.position.y - SKATE_DECK_DROP, // rails are caught by the DECK, not the collider
        ctx.position.z,
        V.fwd.x * this.#speed,
        V.fwd.z * this.#speed,
        t.grindSnap,
        0.6,
        0.3,
        0.42
      );
      if (hit) this.#lockGrind(ctx, hit, this.#grindChain);
      else this.#grindChain = false;
    }

    this.#applyMotion(ctx, w, dt);
  }

  // ------------------------------------------------------------------ pop --
  #pop(ctx: PlayerCtx, t: typeof SKATE_TUNING.values) {
    const charge = this.crouch;
    const boost = 1 + Math.min(1, Math.abs(this.#speed) / t.maxSpeed) * t.ollieSpeedBoost;
    this.#vy = (t.ollieMin + charge * (t.ollieMax - t.ollieMin)) * boost;
    this.#jumpLock = 0.16;
    this.#popLatch = false;
    this.crouch = 0;
    this.manualing = false;
    this.#spinDeg = 0;
    this.#flipRad = 0;
    this.#grabbedThisAir = false;
    this.airTime = 0;
    ctx.position.y += 0.03; // clear the ride spring immediately
  }

  // --------------------------------------------------------------- landing --
  #touchDown(ctx: PlayerCtx, t: typeof SKATE_TUNING.values) {
    // Award whatever the air was worth before deciding whether it stuck.
    const spin = spinName(this.#spinDeg);
    if (spin) this.book.add(spin.name, spin.points);
    const flips = Math.floor(Math.abs(this.#flipRad) / TAU + 0.12);
    if (flips > 0) {
      const name = this.#flipRad > 0 ? "Backflip" : "Frontflip";
      for (let i = 0; i < flips; i++) this.book.add(name, TRICK_POINTS.flip);
    }
    if (this.airTime > 1.4) this.book.add("Big Air", TRICK_POINTS.bigAir);
    this.#spinDeg = 0;
    this.#flipRad = 0;

    // Unfinished deck trick = the board lands sideways under you.
    const deckOff = this.#deck ? Math.abs(Math.sin(this.visual.flipRoll)) > 0.55 : false;
    const tilted = Math.abs(wrapPi(this.pitch)) > t.bailAngle || Math.abs(this.lean) > t.bailAngle;
    if (tilted || deckOff) {
      this.#bail(t);
      return;
    }
    this.#deck = null;
    this.visual.flipRoll = 0;
    this.visual.shove = 0;
    this.pitch = wrapPi(this.pitch);
    this.crouch = Math.min(1, 0.35 + Math.min(1, Math.max(0, -this.#vy) / 12));
    this.#landGrace = LAND_GRACE;
    this.#vy = 0;
  }

  #bail(t: typeof SKATE_TUNING.values) {
    this.book.bail();
    this.#bailT = t.bailTime;
    this.bailing = true;
    this.grinding = false;
    this.manualing = false;
    this.grabbing = false;
    this.#rail = null;
    this.#deck = null;
    this.visual.flipRoll = 0;
    this.visual.shove = 0;
    this.visual.grindSparks = 0;
    this.#speed *= 0.35;
    this.#grindLockout = 0.5;
    this.crouch = 0;
  }

  // ------------------------------------------------------------ deck spins --
  #startDeckTrick(steer: number, throttle: number) {
    // Which flip you get is chosen by whatever you were already holding — the
    // stick is the modifier, so one button covers the whole vocabulary.
    if (throttle > 0.4) {
      this.#deck = { name: "360 Shove-it", points: TRICK_POINTS.shoveIt360, roll: 0, shove: TAU, t: 0, dur: 0.52 };
    } else if (throttle < -0.4) {
      this.#deck = { name: "Impossible", points: TRICK_POINTS.impossible, roll: 0, shove: -TAU, t: 0, dur: 0.46 };
    } else if (steer > 0.4) {
      this.#deck = { name: "Varial Kickflip", points: TRICK_POINTS.varial, roll: -TAU, shove: TAU, t: 0, dur: 0.5 };
    } else if (steer < -0.4) {
      this.#deck = { name: "Heelflip", points: TRICK_POINTS.heelflip, roll: TAU, shove: 0, t: 0, dur: 0.4 };
    } else {
      this.#deck = { name: "Kickflip", points: TRICK_POINTS.kickflip, roll: -TAU, shove: 0, t: 0, dur: 0.4 };
    }
  }

  #advanceDeck(dt: number) {
    const d = this.#deck;
    if (!d) {
      this.visual.flipRoll = 0;
      this.visual.shove = 0;
      return;
    }
    d.t = Math.min(d.dur, d.t + dt);
    // Ease-out so the deck snaps round early and settles level — that late
    // hang is what makes a flip read as "caught".
    const u = d.t / d.dur;
    const e = 1 - Math.pow(1 - u, 2.2);
    this.visual.flipRoll = d.roll * e;
    this.visual.shove = d.shove * e;
    if (d.t >= d.dur) {
      this.book.add(d.name, d.points);
      this.visual.flipRoll = 0;
      this.visual.shove = 0;
      this.#deck = null;
    }
  }

  #grabName(steer: number, throttle: number): string {
    if (throttle > 0.4) return "Nosegrab";
    if (throttle < -0.4) return "Tailgrab";
    if (steer > 0.4) return "Method";
    if (steer < -0.4) return "Melon";
    return "Indy";
  }

  // --------------------------------------------------------------- grinds --
  #lockGrind(ctx: PlayerCtx, hit: GrindHit, chained = false) {
    this.#rail = hit.rail;
    this.#railT = hit.t;
    this.#railSign = hit.sign;
    this.#railDirX = hit.dx;
    this.#railDirZ = hit.dz;
    this.#railGrade = hit.grade;
    this.#railLength = hit.length;
    this.#railLift = hit.rail.lift;
    this.grinding = true;
    this.manualing = false;
    this.grabbing = false;
    this.#deck = null;
    this.visual.flipRoll = 0;
    this.visual.shove = 0;
    this.airTime = 0;

    // 50-50 if you came in lined up with the bar; anything sideways is a
    // boardslide, and the deck locks square across it. A CHAINED lock is the
    // next chord of the same rail: keep the trick you were already doing and
    // score nothing new, or a 90 m handrail reads as "50-50 ×13".
    V.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const along = Math.abs(V.fwd.x * hit.dx + V.fwd.z * hit.dz);
    const railYaw = Math.atan2(-hit.dx * hit.sign, -hit.dz * hit.sign);
    if (chained) {
      this.yaw = this.#grindKind === "board" ? railYaw + Math.PI / 2 : railYaw;
    } else if (along < BOARDSLIDE_COS) {
      this.#grindKind = "board";
      this.grindName = "Boardslide";
      this.yaw = railYaw + Math.PI / 2;
      this.book.add("Boardslide", TRICK_POINTS.grindBoardslide);
    } else {
      this.#grindKind = "5050";
      this.grindName = hit.rail.kind === "coping" ? "Feeble Grind" : "50-50";
      this.yaw = railYaw;
      this.book.add(
        this.grindName,
        hit.rail.kind === "coping" ? TRICK_POINTS.grindCoping : TRICK_POINTS.grind5050
      );
    }
    this.#grindChain = false;
    this.#speed = Math.abs(this.#speed);
    if (!chained) this.balance = (this.#noise - 0.5) * 0.3;
    this.pitch = 0;
    this.lean = 0;
    this.#popLatch = false; // a press that put you here must not pop you off it
    // The lock can slide the deck up to a metre sideways; collapse the render
    // interpolation so it reads as a snap onto the bar, not a smear across it.
    ctx.snapRenderPose?.();
  }

  #updateGrind(
    ctx: PlayerCtx,
    w: PlayerCtx["physics"]["world"],
    dt: number,
    t: typeof SKATE_TUNING.values,
    steer: number,
    throttle: number
  ) {
    const rail = this.#rail!;
    this.grounded = true; // for camera/audio purposes you are on something

    // Nose grind / 5-0 — W and S have nothing else to do up here.
    if (throttle > 0.5 && this.#grindKind !== "nose" && this.#grindKind !== "board") {
      this.#grindKind = "nose";
      this.grindName = "Nosegrind";
      this.book.add("Nosegrind", TRICK_POINTS.grindNose);
    } else if (throttle < -0.5 && this.#grindKind !== "5-0" && this.#grindKind !== "board") {
      this.#grindKind = "5-0";
      this.grindName = "5-0 Grind";
      this.book.add("5-0 Grind", TRICK_POINTS.grind50);
    }

    // Speed along the bar: drag, plus gravity down its grade.
    this.#speed -= this.#speed * t.grindDrag * dt;
    this.#speed += -this.#railGrade * this.#railSign * t.gravity * 0.5 * dt;
    this.#speed = THREE.MathUtils.clamp(this.#speed, 0, t.maxSpeed);

    this.#railT += (this.#speed * this.#railSign * dt) / this.#railLength;
    this.book.hold(TRICK_POINTS.grindPerSecond * dt);

    // Balance: an inverted pendulum you keep upright with the carve keys.
    this.balance += this.balance * t.grindDrift * dt + (this.#noise - 0.5) * 0.9 * dt;
    this.balance -= steer * t.grindCorrect * dt;
    this.lean = this.balance * 0.4;
    this.pitch =
      this.#grindKind === "nose" ? -0.3 : this.#grindKind === "5-0" ? 0.34 : this.#grindKind === "board" ? 0 : 0.02;
    this.visual.grindSparks = rail.kind === "ledge" ? 0 : Math.min(1, this.#speed / 8);

    const ranOut = this.#railT < 0 || this.#railT > 1;
    const stalled = this.#speed < t.grindMin * 0.5;
    const lost = Math.abs(this.balance) > 1;
    const popping = this.#popLatch;
    this.#popLatch = false;

    // Ride the bar: position is authored, not simulated.
    const clamped = THREE.MathUtils.clamp(this.#railT, 0, 1);
    ctx.position.x = rail.ax + (rail.bx - rail.ax) * clamped;
    ctx.position.z = rail.az + (rail.bz - rail.az) * clamped;
    ctx.position.y = rail.ay + (rail.by - rail.ay) * clamped + this.#railLift + SKATE_DECK_DROP;
    this.horizontalSpeed = Math.abs(this.#speed);
    this.visual.speed = this.#speed * this.#railSign;
    const dirX = this.#railDirX * this.#railSign;
    const dirZ = this.#railDirZ * this.#railSign;
    const vx = dirX * this.#speed;
    const vz = dirZ * this.#speed;
    this.#vy = this.#railGrade * this.#speed;
    w.setBodyVelocity(ctx.body, [vx, this.#vy, vz], [0, 0, 0]);
    this.#writeTransform(ctx, w);
    ctx.heading = this.yaw + Math.PI;

    if (lost) {
      this.#bail(t);
      return;
    }
    if (popping || ranOut || stalled) {
      this.grinding = false;
      this.#rail = null;
      this.visual.grindSparks = 0;
      // Running off the end is usually the next chord of the same polyline, so
      // stay unlocked and keep the balance meter; a deliberate pop is a real
      // dismount and gets the lockout.
      this.#grindChain = ranOut && !popping && !stalled;
      if (!this.#grindChain) this.balance = 0;
      this.#grindLockout = this.#grindChain ? 0 : 0.4;
      // Popping out of a grind is an ollie; running off the end just lets go.
      this.#vy = popping ? t.grindPop : ranOut ? 1.2 : 0;
      if (popping) {
        this.#popLatch = false;
        this.#jumpLock = 0.14;
        this.#spinDeg = 0;
        this.#flipRad = 0;
        this.#grabbedThisAir = false;
      }
      // Face back down the direction of travel (a boardslide was sideways).
      this.yaw = Math.atan2(-dirX, -dirZ);
      this.pitch = 0;
      this.lean = 0;
      this.#wasGrounded = false;
      this.grounded = false;
      this.#landGrace = LAND_GRACE;
    }
  }

  // ---------------------------------------------------------------- motion --
  #applyMotion(ctx: PlayerCtx, w: PlayerCtx["physics"]["world"], dt: number) {
    void dt;
    V.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const vx = V.fwd.x * this.#speed;
    const vz = V.fwd.z * this.#speed;
    this.horizontalSpeed = Math.abs(this.#speed);
    this.visual.speed = this.#speed;
    this.visual.grindSparks = 0;
    w.setBodyVelocity(ctx.body, [vx, this.#vy, vz], [0, 0, 0]);
    this.#writeTransform(ctx, w);
    ctx.heading = this.yaw + Math.PI;
  }

  #writeTransform(ctx: PlayerCtx, w: PlayerCtx["physics"]["world"]) {
    // yaw (world Y) → pitch (local X) → lean (local Z), composed as local axes
    // so a flip past ±90° never gimbals.
    const q = ctx.quaternion.setFromAxisAngle(V.up, this.yaw);
    q.multiply(V.quat.setFromAxisAngle(V.localX, this.pitch));
    q.multiply(V.quat.setFromAxisAngle(V.localZ, this.lean));
    w.setBodyTransform(
      ctx.body,
      [ctx.position.x, ctx.position.y, ctx.position.z],
      [q.x, q.y, q.z, q.w]
    );
  }
}
