// Player fetch-ball tool + the whole dog-fetch/pet loop.
//
// Hold-to-throw: the ball appears and winds up as soon as you hold. Release
// before 1s stows it (no throw); hold ≥1s then release to toss (min power at
// the 1s mark, full power after another 1.5s). A center meter shows fill vs
// the throw-threshold notch. After the ball leaves the hand, hands stay empty
// until the next hold — a dog can bring a thrown ball back; take it with E.
//
// Free kinematic balls fly/bounce/roll via the shared ballSim. The player-side
// fetch state machine (throw → a free dog chases, bites, carries it back and
// waits → the player takes it with E) and the pet-follow driver once a dog has
// been adopted live here too.
//
// main.ts constructs one instance and calls update() EVERY frame (tool-agnostic,
// so balls already in flight keep simulating even after the player switches
// tools), driveThrow() while the ball tool is selected, and tryPickup() on E.
// The park exposes the dog-driving primitives (steer/hold/jaw/mouth/claim/adopt)
// so the choreography reuses the park's exact locomotion.

import * as THREE from "three/webgpu";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";
import { stepBall, type BallSimCtx, type BallSimState, type BallStepImpact } from "../world/coronaHeights/ballSim";
import type { CoronaHeightsPark, ParkDog } from "../world/coronaHeights";
import { dogParkFenceSegments } from "../world/coronaHeights/dogParkFence";
import {
  applyBallGlow,
  BALL_GLOW_NIGHT,
  prepareBallGlowMaterial,
  TENNIS_BALL_COLOR
} from "../fx/ballGlow";

const BALL_R = 0.16; // matches the park's tennis ball
const DOG_SURFACE_LIFT = 0.04; // woodchip lift inside the park; 0 on open terrain
const FENCE_TOP_LIFT = 1.55; // fence height added over ground for the rebound cap
const THROW_SPEED_MIN = 7; // m/s at the 1s throw threshold
const THROW_SPEED_MAX = 22; // m/s at full windup (under the ~22 m/s anti-tunnel ceiling)
const MIN_HOLD = 1.0; // must hold this long to throw; release earlier stows the ball
const WINDUP_TIME = 1.5; // seconds after MIN_HOLD to reach max power (2.5s total)
const FULL_HOLD = MIN_HOLD + WINDUP_TIME;
const WINDUP_T = 0.4; // throw-anim t at full cock-back (matches Player.#applyThrowSwing)
const LAUNCH_T = 0.55; // leaves from the straight, overhead slot just before follow-through
const RELEASE_DURATION = 0.42; // seconds to play windup→follow-through after release
const MIN_HOLD_PCT = (MIN_HOLD / FULL_HOLD) * 100; // meter notch at the throw threshold
const TAKE_FROM_DOG_RANGE = 2.0; // E-to-take reach while a dog waits
const TAKE_RESTING_RANGE = 1.5; // E-to-pick-up reach for a free ball
const ABANDON_RANGE = 60; // a claimed (un-adopted) dog gives up if the player strays this far
// Free balls are pooled and bounded: without a cap every throw left a live
// simulated mesh in the scene forever (monotonic fps decay + memory leak).
const MAX_FREE_BALLS = 16;
const BALL_TTL = 120; // s a resting ball survives once the player has moved on
const BALL_TTL_RANGE = 15; // …but never TTL one the player is standing near
const FAR_DESPAWN = 150; // m — out of sight (and out of tool range) = gone
// Centroid of CORONA_DOG_PARK (layout.ts) — used to tell "just outside the fence
// for a handoff" from "dragged well out of the run" during a committed fetch.
const PARK_CX = 373;
const PARK_CZ = 2704;
const LEASH_MARGIN = 8; // a fetching dog this far outside the run = abandon back to wander
const PET_TRAIL = 1.8; // pet trots this far behind the player
const PICKUP_SPEED = 2.4; // dog grabs once the ball has slowed to this
const PICKUP_RANGE = 0.55;
const GROUND_SFX_MIN_SPEED = 1.2; // below this a bounce is an inaudible settle

export interface PlayerBallView {
  /** Show/hide the tennis-ball prop clasped in the player's hand. */
  setBallHeld(held: boolean): void;
  /** 0..1 windup→release arm swing; 0 resets to idle. */
  setThrowAnim(t: number): void;
  /** World position of the throwing hand (rigHandWorld under the hood). */
  handWorldPos(out: THREE.Vector3): THREE.Vector3;
}

export interface FetchHud {
  message(text: string, secs?: number): void;
}

export interface FetchBallDeps {
  scene: THREE.Object3D; // free ball meshes + reparented pet live here
  map: WorldMap;
  physics: Physics;
  park: () => CoronaHeightsPark | null; // getter (park is null until the hill is built)
  playerView: PlayerBallView;
  hud: FetchHud;
  /** A free ball struck solid ground at `speed` m/s — voice a thud. Water
   *  landings are voiced by the owning water feature, so the caller suppresses
   *  this when the impact point is submerged. */
  onGroundImpact?: (x: number, y: number, z: number, speed: number) => void;
  /** A local throw committed its release pose. The multiplayer layer relays
   *  this compact origin + velocity event so peers can run the same ball sim. */
  onThrow?: (throwId: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) => void;
  /** Request one stable network ball id. The relay arbitrates racing pickups
   *  and echoes the accepted transfer to every client. */
  onPickupRequest?: (sourceId: number | null, throwId: number) => boolean;
}

/** Bottom-center charge bar: fill + threshold notch so the 1s throw gate reads. */
class ThrowMeter {
  #root: HTMLElement;
  #fill: HTMLElement;
  #label: HTMLElement;
  #visible = false;
  #lastPct = -1;
  #lastReady = false;

  constructor() {
    const hud = document.getElementById("hud");
    this.#root = document.createElement("div");
    this.#root.className = "throw-meter";
    this.#root.innerHTML =
      `<div class="tm-track">` +
      `<div class="tm-fill"></div>` +
      `<div class="tm-mark" style="left:${MIN_HOLD_PCT}%"></div>` +
      `</div>` +
      `<div class="tm-label">hold…</div>`;
    this.#fill = this.#root.querySelector(".tm-fill")!;
    this.#label = this.#root.querySelector(".tm-label")!;
    hud?.appendChild(this.#root);
  }

  set(progress: number, ready: boolean, visible: boolean): void {
    if (visible !== this.#visible) {
      this.#visible = visible;
      this.#root.classList.toggle("show", visible);
      if (!visible) {
        this.#lastPct = -1;
        this.#lastReady = false;
        this.#root.classList.remove("ready");
        this.#label.textContent = "hold…";
        return;
      }
    }
    if (!visible) return;
    const pct = Math.round(THREE.MathUtils.clamp(progress, 0, 1) * 100);
    if (pct !== this.#lastPct) {
      this.#lastPct = pct;
      this.#fill.style.width = `${pct}%`;
    }
    if (ready !== this.#lastReady) {
      this.#lastReady = ready;
      this.#root.classList.toggle("ready", ready);
      this.#label.textContent = ready ? "release!" : "hold…";
    }
  }
}

type FreeBall = {
  id: number;
  /** Null for this player's balls; otherwise the server-stamped peer id. */
  sourceId: number | null;
  /** Stable within the source player's connection; used to transfer pickup ownership. */
  throwId: number;
  pendingPickup: boolean;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  state: BallSimState;
  born: number; // elapsed at launch, drives the abandoned-ball TTL
};

/** Read-only, allocation-free world state for systems reacting to live throws. */
export type FetchBallWorldState = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly grounded: boolean;
};

type DogPhase =
  | { kind: "none" }
  | { kind: "chasing"; ball: FreeBall; dog: ParkDog; reactTimer: number }
  | { kind: "returning"; ball: FreeBall; dog: ParkDog }
  | { kind: "waiting"; ball: FreeBall; dog: ParkDog };

type ThrowPhase = "idle" | "charging" | "releasing";

export class FetchBall {
  #deps: FetchBallDeps;
  #ctxPark: BallSimCtx; // inside the fence: rebound + woodchip lift
  #ctxOpen: BallSimCtx; // open terrain: pure roll, no lift
  #free: FreeBall[] = [];
  #nextBallId = 1;
  #nextThrowId = 1;
  #dogPhase: DogPhase = { kind: "none" };
  #active = false;
  #elapsed = 0;

  // ONE geometry + ONE glow material for every ball, meshes recycled through a
  // pool — a throw allocates nothing once the pool is warm, and the night glow
  // is a single material write per frame instead of one per ball.
  #ballGeo: THREE.SphereGeometry | null = null;
  #ballMat: THREE.MeshStandardMaterial | null = null;
  #meshPool: THREE.Mesh[] = [];

  #dog: ParkDog | null = null; // the fetching dog (claimed) — becomes a pet on adoption
  #pets: ParkDog[] = []; // adopted followers
  #seatedPet: ParkDog | null = null;

  // hold-to-throw: ball spots immediately on hold; E pickup also leaves it held
  #held = false;
  #throwPhase: ThrowPhase = "idle";
  #holdElapsed = 0; // seconds the pointer has been held this charge
  #charge = 0; // 0..1 throw power (0 at MIN_HOLD, 1 after FULL_HOLD)
  #meterProgress = 0; // 0..1 fill across the whole hold (for the HUD bar)
  #throwAnimT = 0; // 0..1 arm-swing parameter fed to the player view
  #releaseElapsed = 0; // seconds since mouse-up
  #releaseStartT = 0; // anim t at the moment of release
  #throwSpeed = THROW_SPEED_MIN;
  #aim = new THREE.Vector3(0, 0, -1);
  #meter = new ThrowMeter();

  #lastPlayer = new THREE.Vector3();
  #prevPlayer = new THREE.Vector3();
  #petDirX = 0;
  #petDirZ = 1;
  #petInit = false;

  #spinAxis = new THREE.Vector3();
  #tmp = new THREE.Vector3();
  #stepImpact: BallStepImpact = { groundSpeed: 0 };

  constructor(deps: FetchBallDeps) {
    this.#deps = deps;

    // Own fence data so the sim decouples from the park instance (which is
    // null until the hill loads and could rebuild).
    const segs = dogParkFenceSegments();
    const segTop = new Float64Array(segs.length);
    let fenceTopMax = -Infinity;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const top = Math.max(deps.map.groundTop(seg.ax, seg.az), deps.map.groundTop(seg.bx, seg.bz)) + FENCE_TOP_LIFT;
      segTop[i] = top;
      fenceTopMax = Math.max(fenceTopMax, top);
    }
    const groundTop = (x: number, z: number) => deps.map.groundTop(x, z);
    this.#ctxPark = { groundTop, lift: DOG_SURFACE_LIFT, radius: BALL_R, segs, segTop, fenceTopMax };
    this.#ctxOpen = { groundTop, lift: 0, radius: BALL_R };
  }

  setActive(active: boolean): void {
    this.#active = active;
    if (!active) this.#cancelCharge();
    // Ball only shows when we actually have one (pickup or mid-throw).
    this.#deps.playerView.setBallHeld(active && this.#held);
    if (!active) this.#deps.playerView.setThrowAnim(0);
  }

  /**
   * Drive hold-to-throw while the ball tool is selected. `firing` is the mouse /
   * pad fire level; `aim` is the view direction (sampled on release). Pass
   * `cancelled` when pointer lock drops mid-charge so we don't accidental-toss.
   */
  driveThrow(dt: number, firing: boolean, aim: THREE.Vector3, cancelled = false): void {
    if (!this.#active) return;

    if (this.#throwPhase === "releasing") {
      this.#advanceRelease(dt);
      return;
    }

    if (this.#throwPhase === "charging") {
      if (cancelled) {
        this.#cancelCharge();
        return;
      }
      if (firing) {
        this.#holdElapsed += dt;
        this.#syncChargeFromHold();
        return;
      }
      // Release before the 1s gate — stow the ball, no throw.
      if (this.#holdElapsed < MIN_HOLD) {
        this.#cancelCharge();
        return;
      }
      // Past the gate — lock aim + power and whip the overhand release.
      this.#aim.copy(aim);
      if (this.#aim.lengthSq() < 1e-6) this.#aim.set(0, 0.12, -1);
      this.#aim.normalize();
      this.#throwSpeed = THREE.MathUtils.lerp(THROW_SPEED_MIN, THROW_SPEED_MAX, this.#charge);
      this.#releaseStartT = this.#throwAnimT;
      this.#releaseElapsed = 0;
      this.#throwPhase = "releasing";
      this.#meter.set(this.#meterProgress, true, false);
      return;
    }

    // idle
    if (firing && !cancelled) {
      this.#charge = 0;
      this.#meterProgress = 0;
      this.#throwAnimT = 0;
      this.#holdElapsed = 0;
      this.#throwPhase = "charging";
      this.#holdElapsed += dt;
      this.#syncChargeFromHold();
    }
  }

  /** Ball in hand + overhand cock + meter, driven by `#holdElapsed`. */
  #syncChargeFromHold(): void {
    this.#meterProgress = Math.min(1, this.#holdElapsed / FULL_HOLD);
    const pastGate = this.#holdElapsed >= MIN_HOLD;
    this.#charge = pastGate ? Math.min(1, (this.#holdElapsed - MIN_HOLD) / WINDUP_TIME) : 0;
    // Arm cocks through the full hold so the pitcher windup reads the whole time.
    this.#throwAnimT = this.#meterProgress * WINDUP_T;
    this.#held = true;
    this.#deps.playerView.setBallHeld(true);
    this.#deps.playerView.setThrowAnim(this.#throwAnimT);
    this.#meter.set(this.#meterProgress, pastGate, true);
  }

  /**
   * E-to-pick-up: take a ball from a waiting dog, or scoop up the nearest free
   * ball on the ground. Returns true when something was collected (so the E
   * handler can skip boarding / doors).
   */
  tryPickup(playerPos: THREE.Vector3): boolean {
    this.#lastPlayer.copy(playerPos);
    if (this.#dogPhase.kind === "waiting" && this.#dog) {
      const dog = this.#dog;
      if (Math.hypot(playerPos.x - dog.x, playerPos.z - dog.z) < TAKE_FROM_DOG_RANGE) {
        this.#takeFromDog();
        return true;
      }
    }
    const nearest = this.#nearestPickupBall(playerPos);
    if (!nearest) return false;
    const ball = nearest.ball;
    if (ball.sourceId !== null) {
      if (ball.pendingPickup) return true;
      if (!this.#deps.onPickupRequest?.(ball.sourceId, ball.throwId)) return false;
      ball.pendingPickup = true;
      return true;
    }
    this.#removeFree(ball);
    this.#receiveBall();
    this.#deps.onPickupRequest?.(null, ball.throwId);
    return true;
  }

  update(dt: number, elapsed: number, playerPos: THREE.Vector3, petSeat: THREE.Object3D | null = null): void {
    this.#lastPlayer.copy(playerPos);
    this.#elapsed = elapsed;
    if (!this.#petInit) {
      this.#prevPlayer.copy(playerPos);
      this.#petInit = true;
    }
    const park = this.#deps.park();
    this.#syncPetSeat(petSeat, elapsed);

    // Abandoned balls despawn (back to the mesh pool): instantly once far out
    // of tool range, on a generous TTL otherwise — never one a dog is working
    // or the player is standing beside.
    for (let i = this.#free.length - 1; i >= 0; i--) {
      const ball = this.#free[i];
      if (this.#dogWorking(ball)) continue;
      const dist = Math.hypot(playerPos.x - ball.state.x, playerPos.z - ball.state.z);
      if (dist > FAR_DESPAWN || (elapsed - ball.born > BALL_TTL && dist > BALL_TTL_RANGE)) {
        this.#removeFree(ball);
      }
    }

    // Every free ball keeps simulating; dog choreography rides one of them.
    for (const ball of this.#free) {
      if (this.#dogPhase.kind === "returning" || this.#dogPhase.kind === "waiting") {
        if (this.#dogPhase.ball === ball) continue; // mouth-carried — posed below
      }
      this.#stepFreeBall(ball, dt, park);
    }

    switch (this.#dogPhase.kind) {
      case "none":
        this.#updateIdle(dt, elapsed, playerPos, park);
        break;
      case "chasing":
        this.#updateChasing(dt, elapsed, park);
        break;
      case "returning":
        this.#updateReturning(dt, playerPos, park);
        break;
      case "waiting":
        this.#updateWaiting(dt, elapsed, playerPos, park);
        break;
    }

    // Pet follow runs independent of the ball phase.
    if (this.#pets.length && park) {
      const vx = playerPos.x - this.#prevPlayer.x;
      const vz = playerPos.z - this.#prevPlayer.z;
      const spd = Math.hypot(vx, vz);
      if (spd > 0.02) {
        this.#petDirX = vx / spd;
        this.#petDirZ = vz / spd;
      }
      const tx = playerPos.x - this.#petDirX * PET_TRAIL;
      const tz = playerPos.z - this.#petDirZ * PET_TRAIL;
      for (const pet of this.#pets) {
        if (pet !== this.#seatedPet) park.updatePet(pet, tx, tz, dt, elapsed);
      }
    }
    this.#prevPlayer.copy(playerPos);
    this.#syncGlow();
  }

  /** Click-row verb — hold ≥1s then release to throw; pickup is on E. */
  verb(): string {
    return "hold 1s to throw";
  }

  /** True when E would pick something up right now (dog handoff or free ball). */
  wantsTake(): boolean {
    if (this.#dogPhase.kind === "waiting" && this.#dog) {
      if (Math.hypot(this.#lastPlayer.x - this.#dog.x, this.#lastPlayer.z - this.#dog.z) < TAKE_FROM_DOG_RANGE) {
        return true;
      }
    }
    return this.#nearestPickupBall(this.#lastPlayer) !== null;
  }

  /** 0..1 while winding up / releasing (for chase zoom); −1 when idle. */
  throwProgress(): number {
    if (this.#throwPhase === "charging") return this.#meterProgress;
    if (this.#throwPhase === "releasing") {
      return Math.min(1, this.#releaseElapsed / RELEASE_DURATION);
    }
    return -1;
  }

  /**
   * Deterministic authored launch used by cinematics and gameplay probes. The
   * normal hold/windup interaction remains the player-facing path; this seam
   * only commits an already-authored world velocity from the actual hand so the
   * real ball physics and dog fetch state machine still own the result.
   */
  throwForCinematic(velocity: THREE.Vector3): boolean {
    const speed = velocity.length();
    if (!Number.isFinite(speed) || speed < 0.05) return false;
    const scale = Math.min(1, 22 / speed); // ballSim's documented no-tunnel cap
    const hand = this.#deps.playerView.handWorldPos(this.#tmp);
    this.#held = false;
    this.#throwPhase = "idle";
    this.#holdElapsed = 0;
    this.#charge = 0;
    this.#throwAnimT = 0;
    this.#deps.playerView.setBallHeld(false);
    this.#spawnBall(
      hand.x,
      hand.y,
      hand.z,
      velocity.x * scale,
      velocity.y * scale,
      velocity.z * scale
    );
    return true;
  }

  /** Replay a friend's release through the same bounded ball simulation. Peer
   *  balls remain visual/physical world effects but cannot be picked up and do
   *  not claim a local dog, keeping fetch ownership client-authoritative. */
  spawnRemote(
    sourceId: number,
    throwId: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number
  ): boolean {
    if (!Number.isInteger(sourceId) || sourceId <= 0) return false;
    if (!Number.isInteger(throwId) || throwId <= 0) return false;
    const values = [x, y, z, vx, vy, vz];
    if (!values.every(Number.isFinite)) return false;
    const speed = Math.hypot(vx, vy, vz);
    if (speed < 0.05) return false;
    const scale = Math.min(1, THROW_SPEED_MAX / speed);
    return this.#spawnBall(x, y, z, vx * scale, vy * scale, vz * scale, sourceId, throwId);
  }

  /** Apply the relay's one-winner pickup result. `sourceId` is null when this
   *  client originally threw the ball. Returns true when this client received it. */
  resolvePickup(pickerIsLocal: boolean, sourceId: number | null, throwId: number, accepted: boolean): boolean {
    const matches = this.#free.filter((ball) => ball.sourceId === sourceId && ball.throwId === throwId);
    for (const ball of matches) ball.pendingPickup = false;
    if (!accepted) return false;
    for (const ball of matches) this.#removeFree(ball);
    if (!pickerIsLocal) return false;
    this.#receiveBall();
    return true;
  }

  /** Drop only the departed player's cosmetic balls; local throws and other
   *  peers' balls keep their normal lifetime. */
  removeRemoteBalls(sourceId: number): void {
    for (const ball of [...this.#free]) {
      if (ball.sourceId === sourceId) this.#removeFree(ball);
    }
  }

  /** Read-only gameplay/test seam for confirming an accepted pickup transfer. */
  hasBallInHand(): boolean {
    return this.#held;
  }

  /** Latest live player ball, suitable as a camera focus point. */
  activeBallWorld(out: THREE.Vector3): boolean {
    let active: FreeBall | undefined;
    if (this.#dogPhase.kind === "none") {
      for (let i = this.#free.length - 1; i >= 0; i--) {
        if (this.#free[i].sourceId === null) {
          active = this.#free[i];
          break;
        }
      }
    } else {
      active = this.#dogPhase.ball;
    }
    if (!active) return false;
    out.copy(active.mesh.position);
    return true;
  }

  /**
   * Visits every physically free ball without allocating a snapshot array.
   * Mouth-carried balls are omitted because their simulation state is paused.
   */
  visitFreeBalls(
    visitor: (id: number, state: FetchBallWorldState, radius: number) => void
  ): void {
    for (const ball of this.#free) {
      if (
        (this.#dogPhase.kind === "returning" || this.#dogPhase.kind === "waiting") &&
        this.#dogPhase.ball === ball
      ) {
        continue;
      }
      visitor(ball.id, ball.state, BALL_R);
    }
  }

  /** Claimed fetch dog's chest-height camera target. */
  fetchDogWorld(out: THREE.Vector3): boolean {
    if (!this.#dog) return false;
    out.set(this.#dog.x, this.#dog.group.position.y + this.#dog.style.scale * 0.62, this.#dog.z);
    return true;
  }

  get fetchPhase(): DogPhase["kind"] {
    return this.#dogPhase.kind;
  }

  /** Fresh-take reset. Capture replays simulations from frame zero after this. */
  resetForCinematic(): void {
    const park = this.#deps.park();
    if (this.#dog && this.#dog.controller === "player") park?.releaseDog(this.#dog);
    this.#dog = null;
    this.#dogPhase = { kind: "none" };
    for (const ball of [...this.#free]) this.#removeFree(ball);
    this.#held = false;
    this.#throwPhase = "idle";
    this.#holdElapsed = 0;
    this.#charge = 0;
    this.#throwAnimT = 0;
    this.#deps.playerView.setBallHeld(false);
    this.#deps.playerView.setThrowAnim(0);
  }

  dispose(): void {
    for (const ball of this.#free) this.#disposeBall(ball);
    this.#free.length = 0;
    this.#meshPool.length = 0;
    this.#ballGeo?.dispose();
    this.#ballGeo = null;
    this.#ballMat?.dispose();
    this.#ballMat = null;
  }

  /* -------------------------------------------------------------- internals */

  /** First adopted dog rides the scooter's rear perch; leaving the scooter
   * reparents it to the world at the exact seat pose so follow resumes cleanly. */
  #syncPetSeat(seat: THREE.Object3D | null, elapsed: number): void {
    const dog = this.#pets[0] ?? null;
    if (seat && dog) {
      if (this.#seatedPet !== dog || dog.group.parent !== seat) {
        seat.add(dog.group);
        dog.group.position.set(0, 0, 0);
        dog.group.rotation.set(0, 0, 0);
        // A live scooter rebuild hides the old embodiment deeply before this
        // reparent. Restore the pet meshes when they move onto the new seat.
        dog.group.traverse((object) => {
          if ((object as THREE.Mesh).isMesh) object.visible = true;
        });
        this.#seatedPet = dog;
      }
      dog.group.position.y = Math.sin(elapsed * 4.2) * 0.012;
      dog.head.rotation.x = -0.08 + Math.sin(elapsed * 1.7) * 0.04;
      dog.tail.rotation.x = 0.6;
      dog.tail.rotation.y = Math.sin(elapsed * 7.5) * 0.75;
      dog.legs.forEach((leg, i) => leg.rotation.x = i < 2 ? 0.55 : -0.45);
      dog.group.getWorldPosition(this.#tmp);
      dog.x = this.#tmp.x;
      dog.z = this.#tmp.z;
      dog.speed = 0;
      return;
    }
    if (!this.#seatedPet) return;
    const leaving = this.#seatedPet;
    leaving.group.getWorldPosition(this.#tmp);
    this.#deps.scene.attach(leaving.group);
    leaving.group.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) object.visible = true;
    });
    leaving.x = this.#tmp.x;
    leaving.z = this.#tmp.z;
    leaving.heading = leaving.group.rotation.y;
    this.#seatedPet = null;
  }

  #syncGlow(): void {
    // one shared material → one write, however many balls are live
    if (this.#ballMat && this.#free.length) applyBallGlow(this.#ballMat, BALL_GLOW_NIGHT.value);
  }

  #advanceRelease(dt: number): void {
    this.#releaseElapsed += dt;
    const u = Math.min(1, this.#releaseElapsed / RELEASE_DURATION);
    // Ease from the cocked pose through the overhand whip and settle.
    this.#throwAnimT = THREE.MathUtils.lerp(this.#releaseStartT, 1, u);
    this.#deps.playerView.setThrowAnim(this.#throwAnimT);

    if (this.#held && this.#throwAnimT >= LAUNCH_T) this.#launch();

    if (u >= 1) {
      this.#throwPhase = "idle";
      this.#throwAnimT = 0;
      this.#deps.playerView.setThrowAnim(0);
      // Safety: if a tiny charge somehow skipped launch, clear the hand.
      if (this.#held) {
        this.#held = false;
        this.#deps.playerView.setBallHeld(false);
      }
    }
  }

  #launch(): void {
    this.#held = false;
    this.#deps.playerView.setBallHeld(false);

    const hand = this.#deps.playerView.handWorldPos(this.#tmp);
    const speed = this.#throwSpeed;
    this.#spawnBall(
      hand.x,
      hand.y,
      hand.z,
      this.#aim.x * speed,
      this.#aim.y * speed,
      this.#aim.z * speed
    );
  }

  #spawnBall(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    sourceId: number | null = null,
    remoteThrowId?: number
  ): boolean {
    // Cap: a peer can recycle another remote ball but never evict this player's
    // fetch state. A local throw prefers recycling a remote before an idle local.
    if (this.#free.length >= MAX_FREE_BALLS) {
      const recyclableRemote = this.#free.find((ball) => ball.sourceId !== null && !this.#dogWorking(ball));
      const recyclableLocal = sourceId === null
        ? this.#free.find((ball) => ball.sourceId === null && !this.#dogWorking(ball))
        : null;
      const recyclable = recyclableRemote ?? recyclableLocal;
      if (!recyclable) return false;
      this.#removeFree(recyclable);
    }

    const mesh = this.#acquireMesh();
    mesh.position.set(x, y, z);
    mesh.visible = true;
    this.#deps.scene.add(mesh);
    const ball: FreeBall = {
      id: this.#nextBallId++,
      sourceId,
      throwId: sourceId === null ? this.#nextThrowId++ : remoteThrowId!,
      pendingPickup: false,
      mesh,
      material: this.#ballMat!,
      born: this.#elapsed,
      state: {
        x,
        y,
        z,
        vx,
        vy,
        vz,
        grounded: false
      }
    };
    this.#free.push(ball);
    if (sourceId === null) this.#deps.onThrow?.(ball.throwId, x, y, z, vx, vy, vz);
    return true;
  }

  #dogWorking(ball: FreeBall): boolean {
    return this.#dogPhase.kind !== "none" && this.#dogPhase.ball === ball;
  }

  #acquireMesh(): THREE.Mesh {
    const pooled = this.#meshPool.pop();
    if (pooled) return pooled;
    if (!this.#ballGeo) this.#ballGeo = new THREE.SphereGeometry(BALL_R, 12, 8);
    if (!this.#ballMat) {
      this.#ballMat = new THREE.MeshStandardMaterial({ color: TENNIS_BALL_COLOR, roughness: 0.62 });
      prepareBallGlowMaterial(this.#ballMat);
    }
    const mesh = new THREE.Mesh(this.#ballGeo, this.#ballMat);
    mesh.name = "player_tennis_ball";
    // no cast: a 16 cm ball reads as a dot at CSM resolution, but every caster
    // re-encodes into each shadow cascade
    mesh.castShadow = false;
    return mesh;
  }

  #cancelCharge(): void {
    if (this.#throwPhase === "idle") return;
    // Don't cancel mid-release — the ball is already committed to leave the hand.
    if (this.#throwPhase === "releasing") return;
    this.#throwPhase = "idle";
    this.#holdElapsed = 0;
    this.#charge = 0;
    this.#meterProgress = 0;
    this.#throwAnimT = 0;
    this.#held = false; // early release / cancel always stows
    this.#deps.playerView.setThrowAnim(0);
    this.#deps.playerView.setBallHeld(false);
    this.#meter.set(0, false, false);
  }

  /** Put a collected ball in hand (dog handoff or ground scoop). */
  #receiveBall(): void {
    this.#held = true;
    if (this.#active && this.#throwPhase === "idle") {
      this.#deps.playerView.setBallHeld(true);
    }
  }

  #stepFreeBall(ball: FreeBall, dt: number, park: CoronaHeightsPark | null): void {
    const inPark = park?.isInsidePark(ball.state.x, ball.state.z) ?? false;
    const px = ball.state.x;
    const pz = ball.state.z;
    stepBall(ball.state, inPark ? this.#ctxPark : this.#ctxOpen, dt, this.#stepImpact);
    if (this.#stepImpact.groundSpeed >= GROUND_SFX_MIN_SPEED) {
      this.#deps.onGroundImpact?.(ball.state.x, ball.state.y, ball.state.z, this.#stepImpact.groundSpeed);
    }
    ball.mesh.position.set(ball.state.x, ball.state.y, ball.state.z);
    const dx = ball.state.x - px;
    const dz = ball.state.z - pz;
    const travelled = Math.hypot(dx, dz);
    if (travelled > 1e-6) {
      this.#spinAxis.set(-dz / travelled, 0, dx / travelled);
      ball.mesh.rotateOnWorldAxis(this.#spinAxis, (travelled / BALL_R) * (ball.state.grounded ? 1 : 0.35));
    }
  }

  #updateIdle(dt: number, elapsed: number, playerPos: THREE.Vector3, park: CoronaHeightsPark | null): void {
    // A claimed dog (mid-loop, between throws) waits at heel for the next throw.
    if (this.#dog && this.#dog.controller === "player" && park) {
      const d = Math.hypot(playerPos.x - this.#dog.x, playerPos.z - this.#dog.z);
      if (d > ABANDON_RANGE) {
        park.releaseDog(this.#dog);
        this.#dog = null;
      } else {
        park.holdDog(this.#dog, playerPos.x, playerPos.z, elapsed, dt);
        park.setDogJaw(this.#dog, 0);
      }
    }
    if (!park) return;
    // Start a fetch on the first free ball that lands inside the run.
    for (const ball of this.#free) {
      if (ball.sourceId !== null) continue;
      if (!park.isInsidePark(ball.state.x, ball.state.z)) continue;
      if (!this.#dog) {
        this.#dog = park.claimFreeDog(ball.state.x, ball.state.z);
      }
      if (this.#dog && this.#dog.controller === "player") {
        this.#dogPhase = { kind: "chasing", ball, dog: this.#dog, reactTimer: 0.25 };
        park.cueDogAudio(this.#dog, "chase");
        return;
      }
    }
  }

  #updateChasing(dt: number, elapsed: number, park: CoronaHeightsPark | null): void {
    const phase = this.#dogPhase;
    if (phase.kind !== "chasing") return;
    const { ball, dog } = phase;
    if (!park || !this.#free.includes(ball)) {
      this.#dogPhase = { kind: "none" };
      return;
    }
    if (this.#maybeAbandon(park)) return;
    const bx = ball.state.x;
    const bz = ball.state.z;
    if (phase.reactTimer > 0) {
      phase.reactTimer -= dt;
      park.holdDog(dog, bx, bz, elapsed, dt); // read the throw
    } else {
      park.steerDog(dog, bx, bz, park.dogSprintSpeed(dog), dt);
    }
    const d = Math.hypot(bx - dog.x, bz - dog.z);
    park.setDogJaw(dog, d < 1.1 ? 1 : 0); // gape as it closes in
    const speed = Math.hypot(ball.state.vx, ball.state.vz);
    if (ball.state.grounded && speed < PICKUP_SPEED && d < PICKUP_RANGE) {
      park.setDogJaw(dog, 1);
      this.#dogPhase = { kind: "returning", ball, dog };
      park.cueDogAudio(dog, "catch");
    }
  }

  #updateReturning(dt: number, playerPos: THREE.Vector3, park: CoronaHeightsPark | null): void {
    const phase = this.#dogPhase;
    if (phase.kind !== "returning") return;
    const { ball, dog } = phase;
    if (!park || !this.#free.includes(ball)) {
      this.#dogPhase = { kind: "none" };
      return;
    }
    if (this.#maybeAbandon(park)) return;
    park.dogMouthWorld(dog, this.#tmp);
    ball.mesh.position.copy(this.#tmp);
    ball.mesh.visible = true;
    park.setDogJaw(dog, 0.15);
    const dx = dog.x - playerPos.x;
    const dz = dog.z - playerPos.z;
    const d = Math.hypot(dx, dz) || 1;
    park.steerDog(dog, playerPos.x + (dx / d) * 1.2, playerPos.z + (dz / d) * 1.2, park.dogSprintSpeed(dog) * 0.55, dt);
    if (d < 1.9 && dog.speed < 0.9) {
      this.#dogPhase = { kind: "waiting", ball, dog };
      park.cueDogAudio(dog, "return");
      this.#deps.hud.message("Grab the ball back with E", 3.2);
    }
  }

  #updateWaiting(dt: number, elapsed: number, playerPos: THREE.Vector3, park: CoronaHeightsPark | null): void {
    const phase = this.#dogPhase;
    if (phase.kind !== "waiting") return;
    const { ball, dog } = phase;
    if (!park || !this.#free.includes(ball)) {
      this.#dogPhase = { kind: "none" };
      return;
    }
    if (this.#maybeAbandon(park)) return;
    park.dogMouthWorld(dog, this.#tmp);
    ball.mesh.position.copy(this.#tmp);
    ball.mesh.visible = true;
    park.holdDog(dog, playerPos.x, playerPos.z, elapsed, dt);
    park.setDogJaw(dog, 0.15);
  }

  #takeFromDog(): void {
    const phase = this.#dogPhase;
    if (phase.kind !== "waiting") return;
    const park = this.#deps.park();
    const dog = phase.dog;
    if (park) {
      park.setDogJaw(dog, 1); // open to release into the hand
      dog.playerFetchCount++;
      if (dog.playerFetchCount >= 2 && dog.controller !== "pet") {
        park.adoptDog(dog, this.#deps.scene);
        this.#pets.push(dog);
        this.#dog = null;
        this.#deps.hud.message(`${dogLabel(dog)} adopted you! It'll follow you home.`, 3.2);
      }
      // else: keep the dog claimed so the SAME dog runs the next fetch cycle.
    }
    const ball = phase.ball;
    this.#removeFree(ball);
    this.#dogPhase = { kind: "none" };
    this.#receiveBall();
    this.#deps.onPickupRequest?.(null, ball.throwId);
  }

  #nearestPickupBall(playerPos: THREE.Vector3): { ball: FreeBall; dist: number } | null {
    let best: { ball: FreeBall; dist: number } | null = null;
    for (const ball of this.#free) {
      // Skip the ball a dog is currently carrying / offering — that's the
      // dog-handoff path, not a ground scoop.
      if (
        (this.#dogPhase.kind === "returning" || this.#dogPhase.kind === "waiting") &&
        this.#dogPhase.ball === ball
      ) {
        continue;
      }
      if (!ball.state.grounded) continue;
      if (Math.hypot(ball.state.vx, ball.state.vz) >= 0.15) continue;
      const dist = Math.hypot(playerPos.x - ball.state.x, playerPos.z - ball.state.z);
      if (dist >= TAKE_RESTING_RANGE) continue;
      if (!best || dist < best.dist) best = { ball, dist };
    }
    return best;
  }

  #removeFree(ball: FreeBall): void {
    const i = this.#free.indexOf(ball);
    if (i >= 0) this.#free.splice(i, 1);
    if (
      (this.#dogPhase.kind === "chasing" ||
        this.#dogPhase.kind === "returning" ||
        this.#dogPhase.kind === "waiting") &&
      this.#dogPhase.ball === ball
    ) {
      this.#dogPhase = { kind: "none" };
    }
    this.#disposeBall(ball);
  }

  #disposeBall(ball: FreeBall): void {
    // geometry + material are shared — the mesh just goes back to the pool
    ball.mesh.removeFromParent();
    this.#meshPool.push(ball.mesh);
  }

  /** Leash for a committed fetch: if the claimed dog has been dragged well out
   *  of the fenced run (the player walking off mid-return would otherwise pull
   *  it through the fence and across the map, never re-settling), hand it back
   *  to the wander pool and leave the free ball where it is. Keyed on the DOG's
   *  position, not the player-to-dog gap (which stays ~1.2 m forever during a
   *  return), and with a generous margin so a legit fence-line handoff is never
   *  abandoned. Returns true when it abandoned. */
  #maybeAbandon(park: CoronaHeightsPark): boolean {
    const dog = this.#dog;
    if (!dog || dog.controller !== "player") return false;
    if (park.isInsidePark(dog.x, dog.z)) return false; // still in the run
    const dx = PARK_CX - dog.x;
    const dz = PARK_CZ - dog.z;
    const d = Math.hypot(dx, dz) || 1;
    if (park.isInsidePark(dog.x + (dx / d) * LEASH_MARGIN, dog.z + (dz / d) * LEASH_MARGIN)) return false;
    park.releaseDog(dog);
    this.#dog = null;
    this.#dogPhase = { kind: "none" };
    return true;
  }
}

function dogLabel(dog: ParkDog): string {
  const name = dog.style.name.replaceAll("_", " ");
  return `The ${name}`;
}
