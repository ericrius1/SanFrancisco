// Player fetch-ball tool + the whole dog-fetch/pet loop.
//
// This module owns the player's tennis balls: an always-available held prop
// (infinite throws while the 🎾 tool is active), any number of free kinematic
// balls that fly/bounce/roll via the shared ballSim, the player-side fetch
// state machine (throw → a free dog chases, bites, carries it back and waits →
// the player takes it with E), and the pet-follow driver once a dog has been
// adopted.
//
// main.ts constructs one instance and calls update() EVERY frame (tool-agnostic,
// so balls already in flight keep simulating even after the player switches
// tools) plus click() when the ball tool fires and tryPickup() on E. The park
// exposes the dog-driving primitives (steer/hold/jaw/mouth/claim/adopt) so the
// choreography reuses the park's exact locomotion.

import * as THREE from "three/webgpu";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";
import { stepBall, type BallSimCtx, type BallSimState } from "../world/coronaHeights/ballSim";
import type { CoronaHeightsPark, ParkDog } from "../world/coronaHeights";
import { dogParkFenceSegments } from "../world/coronaHeights/dogParkFence";

const BALL_R = 0.16; // matches the park's tennis ball
const DOG_SURFACE_LIFT = 0.04; // woodchip lift inside the park; 0 on open terrain
const FENCE_TOP_LIFT = 1.55; // fence height added over ground for the rebound cap
const THROW_SPEED = 15; // m/s launch; under the 1/90 substep's ~22 m/s anti-tunnel ceiling
const THROW_ANIM_LEN = 0.6; // full windup→release→follow-through of the arm swing
const THROW_RELEASE_T = 0.24; // seconds into the swing when the ball leaves the hand
const TAKE_FROM_DOG_RANGE = 2.0; // E-to-take reach while a dog waits
const TAKE_RESTING_RANGE = 1.5; // E-to-pick-up reach for a free ball
const ABANDON_RANGE = 60; // a claimed (un-adopted) dog gives up if the player strays this far
// Centroid of CORONA_DOG_PARK (layout.ts) — used to tell "just outside the fence
// for a handoff" from "dragged well out of the run" during a committed fetch.
const PARK_CX = 373;
const PARK_CZ = 2704;
const LEASH_MARGIN = 8; // a fetching dog this far outside the run = abandon back to wander
const PET_TRAIL = 1.8; // pet trots this far behind the player
const PICKUP_SPEED = 2.4; // dog grabs once the ball has slowed to this
const PICKUP_RANGE = 0.55;

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
}

type FreeBall = {
  mesh: THREE.Mesh;
  state: BallSimState;
};

type DogPhase =
  | { kind: "none" }
  | { kind: "chasing"; ball: FreeBall; dog: ParkDog; reactTimer: number }
  | { kind: "returning"; ball: FreeBall; dog: ParkDog }
  | { kind: "waiting"; ball: FreeBall; dog: ParkDog };

export class FetchBall {
  #deps: FetchBallDeps;
  #ctxPark: BallSimCtx; // inside the fence: rebound + woodchip lift
  #ctxOpen: BallSimCtx; // open terrain: pure roll, no lift
  #free: FreeBall[] = [];
  #dogPhase: DogPhase = { kind: "none" };
  #active = false;

  #dog: ParkDog | null = null; // the fetching dog (claimed) — becomes a pet on adoption
  #pets: ParkDog[] = []; // adopted followers

  // throw animation timeline: >= 0 while a swing plays
  #throwAnimT = -1;
  #throwPending = false; // next free ball still waiting for the release frame
  #aim = new THREE.Vector3(0, 0, -1);

  #lastPlayer = new THREE.Vector3();
  #prevPlayer = new THREE.Vector3();
  #petDirX = 0;
  #petDirZ = 1;
  #petInit = false;

  #spinAxis = new THREE.Vector3();
  #tmp = new THREE.Vector3();

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
    // Infinite ammo: the held prop shows whenever the ball tool is selected.
    this.#deps.playerView.setBallHeld(active);
  }

  /** Click always throws a new ball (infinite supply while the tool is active). */
  click(origin: THREE.Vector3, aim: THREE.Vector3): void {
    void origin; // the ball leaves the hand (handWorldPos), not the camera ray
    if (!this.#active) return;
    if (this.#throwPending) return; // wait for the in-hand ball to leave first
    this.#aim.copy(aim);
    if (this.#aim.lengthSq() < 1e-6) this.#aim.set(0, 0.12, -1);
    this.#aim.normalize();
    this.#throwPending = true;
    this.#throwAnimT = 0;
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
    this.#removeFree(nearest.ball);
    return true;
  }

  update(dt: number, elapsed: number, playerPos: THREE.Vector3): void {
    this.#lastPlayer.copy(playerPos);
    if (!this.#petInit) {
      this.#prevPlayer.copy(playerPos);
      this.#petInit = true;
    }
    const park = this.#deps.park();

    this.#advanceThrowAnim(dt);

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
      for (const pet of this.#pets) park.updatePet(pet, tx, tz, dt, elapsed);
    }
    this.#prevPlayer.copy(playerPos);
  }

  /** Click-row verb — always throw; pickup is on E. */
  verb(): string {
    return "throw the ball";
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

  throwProgress(): number {
    return this.#throwAnimT < 0 ? -1 : Math.min(1, this.#throwAnimT / THROW_ANIM_LEN);
  }

  dispose(): void {
    for (const ball of this.#free) this.#disposeBall(ball);
    this.#free.length = 0;
  }

  /* -------------------------------------------------------------- internals */

  #advanceThrowAnim(dt: number): void {
    if (this.#throwAnimT < 0) return;
    this.#throwAnimT += dt;
    this.#deps.playerView.setThrowAnim(Math.min(1, this.#throwAnimT / THROW_ANIM_LEN));
    if (this.#throwPending && this.#throwAnimT >= THROW_RELEASE_T) this.#launch();
    if (this.#throwAnimT >= THROW_ANIM_LEN) {
      this.#throwAnimT = -1;
      this.#deps.playerView.setThrowAnim(0);
    }
  }

  #launch(): void {
    this.#throwPending = false;
    const hand = this.#deps.playerView.handWorldPos(this.#tmp);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xb9ef31, roughness: 0.62 })
    );
    mesh.name = "player_tennis_ball";
    mesh.castShadow = true;
    mesh.position.copy(hand);
    mesh.visible = true;
    this.#deps.scene.add(mesh);
    const ball: FreeBall = {
      mesh,
      state: {
        x: hand.x,
        y: hand.y,
        z: hand.z,
        vx: this.#aim.x * THROW_SPEED,
        vy: this.#aim.y * THROW_SPEED,
        vz: this.#aim.z * THROW_SPEED,
        grounded: false
      }
    };
    this.#free.push(ball);
    // Held prop stays — infinite ammo. A duplicate flies out of the hand.
    this.#deps.playerView.setBallHeld(this.#active);
  }

  #stepFreeBall(ball: FreeBall, dt: number, park: CoronaHeightsPark | null): void {
    const inPark = park?.isInsidePark(ball.state.x, ball.state.z) ?? false;
    const px = ball.state.x;
    const pz = ball.state.z;
    stepBall(ball.state, inPark ? this.#ctxPark : this.#ctxOpen, dt);
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
      if (!park.isInsidePark(ball.state.x, ball.state.z)) continue;
      if (!this.#dog) {
        this.#dog = park.claimFreeDog(ball.state.x, ball.state.z);
      }
      if (this.#dog && this.#dog.controller === "player") {
        this.#dogPhase = { kind: "chasing", ball, dog: this.#dog, reactTimer: 0.25 };
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
    if (d < 1.9 && dog.speed < 0.9) this.#dogPhase = { kind: "waiting", ball, dog };
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
    this.#removeFree(phase.ball);
    this.#dogPhase = { kind: "none" };
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
    ball.mesh.removeFromParent();
    ball.mesh.geometry.dispose();
    (ball.mesh.material as THREE.Material).dispose();
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
