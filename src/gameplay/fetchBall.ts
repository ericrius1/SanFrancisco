// Player fetch-ball tool + the whole dog-fetch/pet loop.
//
// This module owns the player's free tennis ball (a kinematic mesh that flies,
// bounces and rolls with the SAME feel as the park's autonomous ball, via the
// shared ballSim), the player-side fetch state machine (throw → a free dog
// chases, bites, carries it back and waits → the player takes it back), and the
// pet-follow driver once a dog has been adopted.
//
// main.ts constructs one instance and calls update() EVERY frame (tool-agnostic,
// so a ball already in flight keeps simulating even after the player switches
// tools) plus click() when the ball tool fires. The park exposes the dog-driving
// primitives (steer/hold/jaw/mouth/claim/adopt) so the choreography reuses the
// park's exact locomotion.

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
const TAKE_FROM_DOG_RANGE = 2.0; // click-to-take reach while a dog waits
const TAKE_RESTING_RANGE = 1.5; // click-to-take reach for a ball at rest, no dog
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
  scene: THREE.Object3D; // free ball mesh + reparented pet live here
  map: WorldMap;
  physics: Physics;
  park: () => CoronaHeightsPark | null; // getter (park is null until the hill is built)
  playerView: PlayerBallView;
  hud: FetchHud;
}

type Phase = "held" | "flying" | "dogChasing" | "dogReturning" | "dogWaiting";

export class FetchBall {
  #deps: FetchBallDeps;
  #ball: THREE.Mesh;
  #state: BallSimState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };
  #ctxPark: BallSimCtx; // inside the fence: rebound + woodchip lift
  #ctxOpen: BallSimCtx; // open terrain: pure roll, no lift
  #phase: Phase = "held";
  #active = false;

  #dog: ParkDog | null = null; // the fetching dog (claimed) — becomes a pet on adoption
  #pets: ParkDog[] = []; // adopted followers
  #reactTimer = 0; // dog reads the throw before bolting

  // throw animation timeline (independent of phase): >= 0 while a swing plays
  #throwAnimT = -1;
  #throwPending = false; // ball still in hand, waiting for the release frame
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
    this.#ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xb9ef31, roughness: 0.62 })
    );
    this.#ball.name = "player_tennis_ball";
    this.#ball.castShadow = true;
    this.#ball.visible = false;
    deps.scene.add(this.#ball);

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
    // The held prop only shows when the ball is actually in hand.
    this.#deps.playerView.setBallHeld(active && this.#phase === "held");
  }

  /** One entry point for the click: throws OR takes based on wantsTake(). */
  click(origin: THREE.Vector3, aim: THREE.Vector3): void {
    void origin; // the ball leaves the hand (handWorldPos), not the camera ray
    if (this.wantsTake()) {
      this.#take();
      return;
    }
    if (this.#phase === "held" && !this.#throwPending) {
      // commit the aim now; the ball actually launches at the release frame
      this.#aim.copy(aim);
      if (this.#aim.lengthSq() < 1e-6) this.#aim.set(0, 0.12, -1);
      this.#aim.normalize();
      this.#throwPending = true;
      this.#throwAnimT = 0;
      return;
    }
    // Recall a stranded FREE ball back to the hand: a ball that rolled out of
    // reach (never rested on a slope, or landed unreachable inside the enclosed
    // run when no free dog could fetch it) would otherwise leave the tool dead —
    // click() no-ops in every non-"held" phase and #take only fires in range.
    // Only "flying" (a loose ball) is recalled; an in-progress fetch
    // (dogChasing/dogReturning/dogWaiting) is never disturbed, and #dog stays
    // claimed so a heeling reused dog keeps its adoption progress.
    if (this.#phase === "flying" && !this.#throwPending) this.#rearm();
  }

  update(dt: number, elapsed: number, playerPos: THREE.Vector3): void {
    this.#lastPlayer.copy(playerPos);
    if (!this.#petInit) {
      this.#prevPlayer.copy(playerPos);
      this.#petInit = true;
    }
    const park = this.#deps.park();

    this.#advanceThrowAnim(dt);

    switch (this.#phase) {
      case "held":
        this.#updateHeld(dt, elapsed, playerPos, park);
        break;
      case "flying":
        this.#updateFlying(dt, elapsed, park);
        break;
      case "dogChasing":
        this.#updateChasing(dt, elapsed, park);
        break;
      case "dogReturning":
        this.#updateReturning(dt, playerPos, park);
        break;
      case "dogWaiting":
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

  verb(): string {
    if (this.wantsTake()) return "take the ball back";
    if (this.#phase === "held") return "throw the ball";
    // A loose ball can be recalled to hand (see click()); the dog carrying or
    // waiting-with the ball can't be thrown, so don't advertise a dead click.
    if (this.#phase === "flying") return "call the ball back";
    if (this.#phase === "dogWaiting") return "get closer to take the ball";
    return "wait for the dog"; // dogChasing / dogReturning
  }

  wantsTake(): boolean {
    if (this.#phase === "dogWaiting" && this.#dog) {
      return Math.hypot(this.#lastPlayer.x - this.#dog.x, this.#lastPlayer.z - this.#dog.z) < TAKE_FROM_DOG_RANGE;
    }
    // a free ball at rest, nobody fetching → pick it up
    if (this.#phase === "flying" && this.#state.grounded && Math.hypot(this.#state.vx, this.#state.vz) < 0.15) {
      return Math.hypot(this.#lastPlayer.x - this.#state.x, this.#lastPlayer.z - this.#state.z) < TAKE_RESTING_RANGE;
    }
    return false;
  }

  throwProgress(): number {
    return this.#throwAnimT < 0 ? -1 : Math.min(1, this.#throwAnimT / THROW_ANIM_LEN);
  }

  dispose(): void {
    this.#ball.removeFromParent();
    this.#ball.geometry.dispose();
    (this.#ball.material as THREE.Material).dispose();
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
    this.#state.x = hand.x;
    this.#state.y = hand.y;
    this.#state.z = hand.z;
    this.#state.vx = this.#aim.x * THROW_SPEED;
    this.#state.vy = this.#aim.y * THROW_SPEED;
    this.#state.vz = this.#aim.z * THROW_SPEED;
    this.#state.grounded = false;
    this.#ball.position.set(hand.x, hand.y, hand.z);
    this.#ball.visible = true;
    this.#deps.playerView.setBallHeld(false);
    this.#phase = "flying";
  }

  #stepFreeBall(dt: number, park: CoronaHeightsPark | null): void {
    const inPark = park?.isInsidePark(this.#state.x, this.#state.z) ?? false;
    const px = this.#state.x;
    const pz = this.#state.z;
    stepBall(this.#state, inPark ? this.#ctxPark : this.#ctxOpen, dt);
    this.#ball.position.set(this.#state.x, this.#state.y, this.#state.z);
    const dx = this.#state.x - px;
    const dz = this.#state.z - pz;
    const travelled = Math.hypot(dx, dz);
    if (travelled > 1e-6) {
      this.#spinAxis.set(-dz / travelled, 0, dx / travelled);
      this.#ball.rotateOnWorldAxis(this.#spinAxis, (travelled / BALL_R) * (this.#state.grounded ? 1 : 0.35));
    }
  }

  #updateHeld(dt: number, elapsed: number, playerPos: THREE.Vector3, park: CoronaHeightsPark | null): void {
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
  }

  #updateFlying(dt: number, elapsed: number, park: CoronaHeightsPark | null): void {
    this.#stepFreeBall(dt, park);
    if (!park) return;
    if (park.isInsidePark(this.#state.x, this.#state.z)) {
      // Ball is over the run — get a dog on it. Reuse the already-claimed dog
      // across fetch cycles (guarantees "same dog" for the adoption count).
      if (!this.#dog) {
        this.#dog = park.claimFreeDog(this.#state.x, this.#state.z);
        if (this.#dog) this.#reactTimer = 0.25;
      }
      if (this.#dog && this.#dog.controller === "player") {
        if (this.#reactTimer <= 0) this.#reactTimer = 0.25;
        this.#phase = "dogChasing";
        return;
      }
    }
    // No claim yet (ball outside, or both dogs busy): keep a reused dog at heel.
    if (this.#dog && this.#dog.controller === "player") {
      park.holdDog(this.#dog, this.#lastPlayer.x, this.#lastPlayer.z, elapsed, dt);
      park.setDogJaw(this.#dog, 0);
    }
  }

  #updateChasing(dt: number, elapsed: number, park: CoronaHeightsPark | null): void {
    this.#stepFreeBall(dt, park);
    const dog = this.#dog;
    if (!park || !dog) {
      this.#phase = "flying";
      return;
    }
    if (this.#maybeAbandon(park)) return;
    const bx = this.#state.x;
    const bz = this.#state.z;
    if (this.#reactTimer > 0) {
      this.#reactTimer -= dt;
      park.holdDog(dog, bx, bz, elapsed, dt); // read the throw
    } else {
      park.steerDog(dog, bx, bz, park.dogSprintSpeed(dog), dt);
    }
    const d = Math.hypot(bx - dog.x, bz - dog.z);
    park.setDogJaw(dog, d < 1.1 ? 1 : 0); // gape as it closes in
    const speed = Math.hypot(this.#state.vx, this.#state.vz);
    if (this.#state.grounded && speed < PICKUP_SPEED && d < PICKUP_RANGE) {
      park.setDogJaw(dog, 1);
      this.#phase = "dogReturning";
    }
  }

  #updateReturning(dt: number, playerPos: THREE.Vector3, park: CoronaHeightsPark | null): void {
    const dog = this.#dog;
    if (!park || !dog) {
      this.#phase = "flying";
      return;
    }
    if (this.#maybeAbandon(park)) return;
    // ball rides the mouth
    park.dogMouthWorld(dog, this.#tmp);
    this.#ball.position.copy(this.#tmp);
    this.#ball.visible = true;
    park.setDogJaw(dog, 0.15);
    const dx = dog.x - playerPos.x;
    const dz = dog.z - playerPos.z;
    const d = Math.hypot(dx, dz) || 1;
    park.steerDog(dog, playerPos.x + (dx / d) * 1.2, playerPos.z + (dz / d) * 1.2, park.dogSprintSpeed(dog) * 0.55, dt);
    if (d < 1.9 && dog.speed < 0.9) this.#phase = "dogWaiting";
  }

  #updateWaiting(dt: number, elapsed: number, playerPos: THREE.Vector3, park: CoronaHeightsPark | null): void {
    const dog = this.#dog;
    if (!park || !dog) {
      this.#phase = "flying";
      return;
    }
    if (this.#maybeAbandon(park)) return;
    park.dogMouthWorld(dog, this.#tmp);
    this.#ball.position.copy(this.#tmp);
    this.#ball.visible = true;
    park.holdDog(dog, playerPos.x, playerPos.z, elapsed, dt);
    park.setDogJaw(dog, 0.15);
  }

  #take(): void {
    const park = this.#deps.park();
    const fromDog = this.#phase === "dogWaiting" && this.#dog;
    if (fromDog && park && this.#dog) {
      const dog = this.#dog;
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
    this.#rearm();
  }

  /** Put the ball back in the player's hand (from a take or a recall). Leaves
   *  this.#dog untouched so a heeling reused dog stays claimed. */
  #rearm(): void {
    this.#ball.visible = false;
    this.#state.vx = this.#state.vy = this.#state.vz = 0;
    this.#state.grounded = false;
    this.#phase = "held";
    this.#deps.playerView.setBallHeld(this.#active);
  }

  /** Leash for a committed fetch: if the claimed dog has been dragged well out
   *  of the fenced run (the player walking off mid-return would otherwise pull
   *  it through the fence and across the map, never re-settling), hand it back
   *  to the wander pool and re-arm the ball. Keyed on the DOG's position, not
   *  the player-to-dog gap (which stays ~1.2 m forever during a return), and
   *  with a generous margin so a legit fence-line handoff is never abandoned.
   *  Returns true when it abandoned (caller should stop touching the dog). */
  #maybeAbandon(park: CoronaHeightsPark): boolean {
    const dog = this.#dog;
    if (!dog || dog.controller !== "player") return false;
    if (park.isInsidePark(dog.x, dog.z)) return false; // still in the run
    // Just outside for a handoff? A step toward the run's centre lands inside.
    const dx = PARK_CX - dog.x;
    const dz = PARK_CZ - dog.z;
    const d = Math.hypot(dx, dz) || 1;
    if (park.isInsidePark(dog.x + (dx / d) * LEASH_MARGIN, dog.z + (dz / d) * LEASH_MARGIN)) return false;
    park.releaseDog(dog);
    this.#dog = null;
    this.#rearm();
    return true;
  }
}

function dogLabel(dog: ParkDog): string {
  const name = dog.style.name.replaceAll("_", " ");
  return `The ${name}`;
}
