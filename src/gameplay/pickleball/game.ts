import * as THREE from "three/webgpu";
import { PICKLEBALL_COURT as C, PICKLEBALL_TUNING as T } from "./constants";
import { PickleballCourtView } from "./court";
import {
  PickleballBallPhysics,
  type PickleballPaddleSweep,
  type PickleballPhysicsEvent
} from "./physics";
import { PickleballPlayerRig } from "./playerRig";
import {
  applyBallGlow,
  PICKLE_BALL_COLOR,
  prepareBallGlowMaterial
} from "../../fx/ballGlow";
import {
  otherSide,
  type PickleballController,
  type PickleballDiagnostics,
  type PickleballEvent,
  type PickleballFault,
  type PickleballFrameResult,
  type PickleballInputIntent,
  type PickleballInteraction,
  type PickleballLocalPose,
  type PickleballOptions,
  type PickleballPhase,
  type PickleballSide,
  type PickleballSnapshot
} from "./types";

const PHASES: readonly PickleballPhase[] = ["serveDelay", "rally", "pointDelay", "gameOver"];
const FAULTS: readonly PickleballFault[] = [
  "out",
  "doubleBounce",
  "doubleHit",
  "serveBox",
  "twoBounceRule",
  "kitchenVolley",
  "stalled"
];
const SNAPSHOT_VERSION = 1;
const PLAYER_FOOT_LIFT = 0.32;
const PLAYER_X_LIMIT = C.halfWidth - 0.3;
// Athletes receive from behind the painted baseline. Keeping this real spacing
// also gives a legal serve time to rise after its mandatory first bounce before
// the procedural swing reaches contact.
const PLAYER_BASELINE_Z = C.halfLength + 0.72;
const PLAYER_Z_MARGIN = 1.15;
const tmpForward = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

type Athlete = {
  side: PickleballSide;
  rig: PickleballPlayerRig;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  swingTime: number;
  swingCooldown: number;
  swingHeld: boolean;
  aimX: number;
  aimZ: number;
  power: number;
  sweep: PickleballPaddleSweep;
};

const EMPTY_INPUT: Readonly<PickleballInputIntent> = Object.freeze({});

function clampIntent(value: number | undefined): number {
  return THREE.MathUtils.clamp(Number.isFinite(value) ? value! : 0, -1, 1);
}

function moveToward(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  return Math.max(target, current - maxDelta);
}

/**
 * One regulation court, two articulated athletes, owner/AI control, rules and
 * one deterministic fixed-step ball. All simulation coordinates are local to
 * `root`; moving/rotating the whole game never changes physics determinism.
 */
export class PickleballGame {
  readonly root = new THREE.Group();
  readonly court = new PickleballCourtView();
  readonly ballPhysics = new PickleballBallPhysics();

  onEvent: (event: PickleballEvent) => void = () => {};

  #players: [Athlete, Athlete];
  #owners: [string | null, string | null] = [null, null];
  #remoteInputs: [PickleballInputIntent, PickleballInputIntent] = [{}, {}];
  #localSide: PickleballSide | null = null;
  #authoritative: boolean;
  #interactionRadius: number;
  #seed: number;
  /** When false, AI/physics/scoring halt and the court root is hidden. */
  #active = true;

  #phase: PickleballPhase = "serveDelay";
  #phaseTimer: number = T.serveDelay;
  #score: [number, number] = [0, 0];
  #server: PickleballSide = 0;
  #lastHitter: PickleballSide | null = null;
  #lastFault: PickleballFault | null = null;
  #rallyHits = 0;
  #rallyAge = 0;
  #bouncesSinceHit = 0;
  #twoBounceStage = 0;
  #serveExpectedSign = 1;
  #pointNumber = 0;

  #ballGeometry: THREE.SphereGeometry;
  #ballMaterial: THREE.MeshStandardNodeMaterial;
  #ballMesh: THREE.Mesh;
  #wantVisible: boolean;

  constructor(options: PickleballOptions = {}) {
    this.root.name = "pickleball-game";
    const origin = options.origin ?? { x: 0, y: 0, z: 0 };
    this.root.position.set(origin.x, origin.y, origin.z);
    this.root.rotation.y = options.yaw ?? 0;
    this.#wantVisible = options.visible ?? true;
    this.root.visible = this.#wantVisible;
    this.#authoritative = options.authoritative ?? true;
    this.#interactionRadius = options.interactionRadius ?? T.interactionRadius;
    this.#seed = options.seed ?? 2407;

    this.root.add(this.court.group);
    this.#players = [this.#makeAthlete(0), this.#makeAthlete(1)];
    for (const player of this.#players) this.root.add(player.rig.group);

    this.#ballGeometry = new THREE.SphereGeometry(C.ballRadius, 14, 10);
    this.#ballMaterial = new THREE.MeshStandardNodeMaterial({
      color: PICKLE_BALL_COLOR,
      roughness: 0.72,
      metalness: 0
    });
    prepareBallGlowMaterial(this.#ballMaterial, PICKLE_BALL_COLOR);
    this.#ballMesh = new THREE.Mesh(this.#ballGeometry, this.#ballMaterial);
    this.#ballMesh.name = "pickleball-ball";
    this.#ballMesh.castShadow = true;
    this.root.add(this.#ballMesh);

    this.#posePlayers(0);
    for (const player of this.#players) player.sweep.previousCenter.copy(player.sweep.currentCenter);
    this.#syncBallMesh(0);
  }

  get authoritative(): boolean {
    return this.#authoritative;
  }

  get active(): boolean {
    return this.#active;
  }

  get localSide(): PickleballSide | null {
    return this.#localSide;
  }

  get phase(): PickleballPhase {
    return this.#phase;
  }

  get score(): readonly [number, number] {
    return this.#score;
  }

  get server(): PickleballSide {
    return this.#server;
  }

  setAuthoritative(authoritative: boolean): void {
    this.#authoritative = authoritative;
  }

  /**
   * Sleep the ambient AI match when the local player is far from the courts.
   * A live local seat always stays awake. Deactivating mid-rally freezes the
   * score and queues a fresh serve so resume never auto-awards a stalled point.
   */
  setActive(active: boolean): void {
    if (this.#active === active) return;
    this.#active = active;
    this.root.visible = active && this.#wantVisible;
    if (active) return;
    this.ballPhysics.stop();
    if (this.#phase === "rally") this.#beginPoint();
    this.#syncBallMesh(0);
  }

  setLocalSide(side: PickleballSide | null): void {
    if (side !== null && side !== 0 && side !== 1) return;
    this.#localSide = side;
  }

  setSlotOwner(side: PickleballSide, ownerId: string | null): void {
    this.#owners[side] = ownerId;
    if (ownerId === null) this.#remoteInputs[side] = {};
  }

  setRemoteInput(side: PickleballSide, input: PickleballInputIntent): void {
    this.#remoteInputs[side] = {
      moveX: clampIntent(input.moveX),
      moveZ: clampIntent(input.moveZ),
      aimX: clampIntent(input.aimX),
      aimZ: clampIntent(input.aimZ),
      swing: Boolean(input.swing),
      sprint: Boolean(input.sprint)
    };
  }

  enterSide(side: PickleballSide, ownerId = "Local player"): boolean {
    const owner = this.#owners[side];
    if (owner !== null && owner !== ownerId) return false;
    if (this.#localSide !== null && this.#localSide !== side) this.exitSide(this.#localSide);
    this.#owners[side] = ownerId;
    this.#localSide = side;
    return true;
  }

  exitSide(side: PickleballSide): void {
    if (this.#localSide === side) this.#localSide = null;
    this.#owners[side] = null;
    this.#remoteInputs[side] = {};
  }

  getInteraction(worldPosition: THREE.Vector3): PickleballInteraction | null {
    this.root.updateWorldMatrix(true, true);
    let nearest: PickleballInteraction | null = null;
    for (const side of [0, 1] as const) {
      const at = this.#players[side].rig.worldPosition(new THREE.Vector3());
      const distance = Math.hypot(at.x - worldPosition.x, at.z - worldPosition.z);
      if (distance > this.#interactionRadius || (nearest && distance >= nearest.distance)) continue;
      const owner = this.#owners[side];
      const local = this.#localSide === side;
      nearest = {
        side,
        distance,
        available: owner === null || local,
        prompt: local
          ? "E — leave pickleball"
          : owner === null
            ? `E — take over ${side === 0 ? "near" : "far"} player`
            : `${owner} is playing this side`,
        worldPosition: at
      };
    }
    return nearest;
  }

  update(
    deltaSeconds: number,
    elapsed: number,
    localWorldPosition: THREE.Vector3 | null,
    input: PickleballInputIntent = EMPTY_INPUT
  ): PickleballFrameResult {
    if (!this.#active) {
      return {
        interaction: null,
        requestedSide: null,
        requestedRelease: null,
        localPose: this.#localSide === null ? null : this.#localPose(this.#localSide),
        phase: this.#phase,
        score: [this.#score[0], this.#score[1]],
        server: this.#server
      };
    }

    const dt = Math.min(Math.max(deltaSeconds, 0), T.maxFrameDelta);
    let interaction = localWorldPosition ? this.getInteraction(localWorldPosition) : null;
    let requestedSide: PickleballSide | null = null;
    let requestedRelease: PickleballSide | null = null;

    if ((input.exit || input.interact) && this.#localSide !== null) {
      requestedRelease = this.#localSide;
      this.onEvent({ kind: "releaseRequested", side: requestedRelease });
    } else if (input.interact && interaction?.available) {
      requestedSide = interaction.side;
      this.onEvent({ kind: "takeoverRequested", side: requestedSide });
    }

    this.#advancePhaseTimer(dt);

    if (this.#authoritative) {
      for (const side of [0, 1] as const) {
        const intent = this.#intentFor(side, side === this.#localSide ? input : undefined);
        this.#advanceAthlete(this.#players[side], intent, dt);
      }
    } else if (this.#localSide !== null) {
      // Client-side paddle prediction makes the non-authority side responsive;
      // the next authority snapshot gently corrects its court-local pose.
      this.#advanceAthlete(this.#players[this.#localSide], input, dt);
    }

    this.#posePlayers(elapsed);

    if (this.#authoritative) {
      if (this.#phase === "serveDelay" && this.#phaseTimer <= 0) this.#launchServe();
      if (this.#phase === "rally") {
        this.#rallyAge += dt;
        const sweeps = [this.#players[0].sweep, this.#players[1].sweep] as const;
        this.ballPhysics.update(dt, sweeps, (event) => this.#handlePhysicsEvent(event));
        for (const sweep of sweeps) {
          if (this.#phase !== "rally") break;
          const assistedReach = this.#controllerFor(sweep.side) === "ai" ? 0.74 : 0.52;
          this.ballPhysics.tryPaddleStrike(sweep, (event) => this.#handlePhysicsEvent(event), assistedReach);
        }
        if (this.#phase === "rally" && (!this.ballPhysics.active || this.#rallyAge > 16)) {
          this.#awardPoint(this.#winnerAfterMiss(), "stalled");
        }
      }
    }

    this.#syncBallMesh(dt);
    interaction = localWorldPosition ? this.getInteraction(localWorldPosition) : interaction;
    const localPose = this.#localSide === null ? null : this.#localPose(this.#localSide);
    return {
      interaction,
      requestedSide,
      requestedRelease,
      localPose,
      phase: this.#phase,
      score: [this.#score[0], this.#score[1]],
      server: this.#server
    };
  }

  serializeState(): number[] {
    const ball = this.ballPhysics;
    const out = [
      SNAPSHOT_VERSION,
      PHASES.indexOf(this.#phase),
      this.#phaseTimer,
      this.#score[0],
      this.#score[1],
      this.#server,
      this.#rallyHits,
      this.#lastHitter ?? -1,
      this.#twoBounceStage,
      this.#bouncesSinceHit,
      ball.active ? 1 : 0,
      ball.position.x,
      ball.position.y,
      ball.position.z,
      ball.velocity.x,
      ball.velocity.y,
      ball.velocity.z,
      ball.angularVelocity.x,
      ball.angularVelocity.y,
      ball.angularVelocity.z
    ];
    for (const player of this.#players) {
      out.push(
        player.position.x,
        player.position.z,
        player.velocity.x,
        player.velocity.z,
        player.swingTime,
        player.swingCooldown
      );
    }
    out.push(
      this.#lastFault === null ? -1 : FAULTS.indexOf(this.#lastFault),
      this.#pointNumber,
      this.#serveExpectedSign,
      this.#rallyAge
    );
    return out;
  }

  applyState(snapshot: PickleballSnapshot): boolean {
    if (!Array.isArray(snapshot) || snapshot.length < 36 || snapshot.some((n) => !Number.isFinite(n))) return false;
    let i = 0;
    if (snapshot[i++] !== SNAPSHOT_VERSION) return false;
    const phase = PHASES[Math.round(snapshot[i++])];
    if (!phase) return false;
    this.#phase = phase;
    this.#phaseTimer = Math.max(0, snapshot[i++]);
    this.#score[0] = THREE.MathUtils.clamp(Math.round(snapshot[i++]), 0, 99);
    this.#score[1] = THREE.MathUtils.clamp(Math.round(snapshot[i++]), 0, 99);
    this.#server = snapshot[i++] >= 0.5 ? 1 : 0;
    this.#rallyHits = Math.max(0, Math.round(snapshot[i++]));
    const lastHitter = Math.round(snapshot[i++]);
    this.#lastHitter = lastHitter === 0 || lastHitter === 1 ? lastHitter : null;
    this.#twoBounceStage = THREE.MathUtils.clamp(Math.round(snapshot[i++]), 0, 2);
    this.#bouncesSinceHit = Math.max(0, Math.round(snapshot[i++]));
    const active = snapshot[i++] >= 0.5;
    const position = new THREE.Vector3(snapshot[i++], snapshot[i++], snapshot[i++]);
    const velocity = new THREE.Vector3(snapshot[i++], snapshot[i++], snapshot[i++]);
    const spin = new THREE.Vector3(snapshot[i++], snapshot[i++], snapshot[i++]);
    this.ballPhysics.setState(active, position, velocity, spin);
    for (const player of this.#players) {
      player.position.x = THREE.MathUtils.clamp(snapshot[i++], -PLAYER_X_LIMIT, PLAYER_X_LIMIT);
      player.position.z = this.#clampPlayerZ(player.side, snapshot[i++]);
      player.velocity.x = THREE.MathUtils.clamp(snapshot[i++], -T.playerSprintSpeed, T.playerSprintSpeed);
      player.velocity.z = THREE.MathUtils.clamp(snapshot[i++], -T.playerSprintSpeed, T.playerSprintSpeed);
      player.swingTime = THREE.MathUtils.clamp(snapshot[i++], -1, T.swingDuration + 0.05);
      player.swingCooldown = THREE.MathUtils.clamp(snapshot[i++], 0, T.swingCooldown);
      player.swingHeld = false;
    }
    const faultIndex = Math.round(snapshot[i++]);
    this.#lastFault = faultIndex >= 0 ? FAULTS[faultIndex] ?? null : null;
    this.#pointNumber = Math.max(0, Math.round(snapshot[i++]));
    this.#serveExpectedSign = snapshot[i++] < 0 ? -1 : 1;
    this.#rallyAge = Math.max(0, snapshot[i++] ?? 0);
    this.#posePlayers(0);
    this.#syncBallMesh(0);
    return true;
  }

  get diagnostics(): PickleballDiagnostics {
    const ball = this.ballPhysics;
    return {
      authoritative: this.#authoritative,
      physicsEngine: "custom-fixed-step",
      fixedStepSeconds: T.fixedStep,
      accumulatorSeconds: ball.accumulator,
      activeBodies: ball.active ? 1 : 0,
      colliderCount: 5,
      sweptCollision: true,
      phase: this.#phase,
      phaseTimer: this.#phaseTimer,
      score: [this.#score[0], this.#score[1]],
      server: this.#server,
      rallyHits: this.#rallyHits,
      ballActive: ball.active,
      ballPosition: [ball.position.x, ball.position.y, ball.position.z],
      ballVelocity: [ball.velocity.x, ball.velocity.y, ball.velocity.z],
      controllers: [this.#controllerFor(0), this.#controllerFor(1)],
      owners: [this.#owners[0], this.#owners[1]],
      localSide: this.#localSide,
      lastFault: this.#lastFault,
      collisionCounts: { ...ball.collisionCounts }
    };
  }

  dispose(): void {
    this.court.dispose();
    for (const player of this.#players) player.rig.dispose();
    this.#ballGeometry.dispose();
    this.#ballMaterial.dispose();
    this.root.removeFromParent();
  }

  #makeAthlete(side: PickleballSide): Athlete {
    const rig = new PickleballPlayerRig(side);
    const position = new THREE.Vector3(side === 0 ? -0.8 : 0.8, PLAYER_FOOT_LIFT, side === 0 ? -PLAYER_BASELINE_Z : PLAYER_BASELINE_Z);
    const currentCenter = new THREE.Vector3();
    return {
      side,
      rig,
      position,
      velocity: new THREE.Vector3(),
      swingTime: -1,
      swingCooldown: 0,
      swingHeld: false,
      aimX: 0,
      aimZ: 0.65,
      power: 0.82,
      sweep: {
        side,
        previousCenter: new THREE.Vector3(),
        currentCenter,
        normal: new THREE.Vector3(0, 0, side === 0 ? 1 : -1),
        active: false,
        target: new THREE.Vector3(),
        power: 0.82
      }
    };
  }

  #controllerFor(side: PickleballSide): PickleballController {
    if (this.#localSide === side) return "local";
    if (!this.#authoritative) return "replica";
    return this.#owners[side] === null ? "ai" : "remote";
  }

  #intentFor(side: PickleballSide, localInput?: PickleballInputIntent): PickleballInputIntent {
    if (localInput) return localInput;
    if (this.#owners[side] !== null) return this.#remoteInputs[side];
    return this.#aiIntent(side);
  }

  #aiIntent(side: PickleballSide): PickleballInputIntent {
    const player = this.#players[side];
    let targetX = side === 0 ? -0.65 : 0.65;
    let targetZ = side === 0 ? -PLAYER_BASELINE_Z : PLAYER_BASELINE_Z;
    let swing = false;

    if (this.#phase === "serveDelay" && side === this.#server) {
      const parity = this.#score[side] & 1;
      targetX = (parity === 0 ? 1.45 : -1.45) * (side === 0 ? 1 : -1);
    } else if (this.#phase === "rally" && this.ballPhysics.active) {
      const ball = this.ballPhysics.position;
      const velocity = this.ballPhysics.velocity;
      const approaching = side === 0 ? velocity.z < -0.1 : velocity.z > 0.1;
      const receiver = otherSide(this.#server);
      const legalReturn =
        this.#lastHitter !== side &&
        (side === receiver ? this.#twoBounceStage >= 1 : this.#twoBounceStage >= 2);
      const paddleLine = player.position.z + (side === 0 ? 0.34 : -0.34);
      const interceptSeconds = approaching
        ? THREE.MathUtils.clamp((paddleLine - ball.z) / velocity.z, 0, 0.55)
        : 0;
      const movementLead = THREE.MathUtils.clamp(interceptSeconds || 0.2, 0.12, 0.36);
      const predictedX = ball.x + velocity.x * movementLead;
      const predictedZ = ball.z + velocity.z * movementLead;
      // Hold behind the baseline until the mandatory bounce makes a return
      // legal; lateral anticipation is still allowed so diagonal serves are
      // reachable without stepping into the court early.
      if (approaching) targetX = THREE.MathUtils.clamp(predictedX, -PLAYER_X_LIMIT, PLAYER_X_LIMIT);
      if (legalReturn) {
        targetZ = side === 0
          ? THREE.MathUtils.clamp(predictedZ - 0.52, -PLAYER_BASELINE_Z - 0.6, -0.7)
          : THREE.MathUtils.clamp(predictedZ + 0.52, 0.7, PLAYER_BASELINE_Z + 0.6);
      }
      const onSide = side === 0 ? ball.z < 0.35 : ball.z > -0.35;
      const contactTime = approaching ? (paddleLine - ball.z) / velocity.z : Infinity;
      const contactX = ball.x + velocity.x * contactTime;
      const contactY = ball.y + velocity.y * contactTime - 0.5 * T.gravity * contactTime * contactTime;
      swing =
        legalReturn &&
        approaching &&
        onSide &&
        contactTime >= 0.12 &&
        contactTime <= 0.36 &&
        contactY > 0.16 &&
        contactY < 1.72 &&
        Math.abs(contactX - player.position.x) < 1.05 &&
        player.swingCooldown <= 0;
    }

    const dx = targetX - player.position.x;
    const dz = targetZ - player.position.z;
    const length = Math.hypot(dx, dz) || 1;
    const variation = Math.sin(this.#seed * 0.013 + this.#pointNumber * 1.71 + this.#rallyHits * 0.83 + side * 2.2);
    return {
      moveX: THREE.MathUtils.clamp(dx / length, -1, 1),
      moveZ: THREE.MathUtils.clamp(dz / length, -1, 1),
      swing,
      aimX: variation * 0.78,
      aimZ: 0.42 + Math.sin(variation * 3.1) * 0.22,
      sprint: Math.hypot(dx, dz) > 2.1
    };
  }

  #advanceAthlete(player: Athlete, input: PickleballInputIntent, dt: number): void {
    const mx = clampIntent(input.moveX);
    const mz = clampIntent(input.moveZ);
    const magnitude = Math.hypot(mx, mz);
    const speed = input.sprint ? T.playerSprintSpeed : this.#controllerFor(player.side) === "ai" ? T.aiSpeed : T.playerSpeed;
    const desiredX = magnitude > 1 ? (mx / magnitude) * speed : mx * speed;
    const desiredZ = magnitude > 1 ? (mz / magnitude) * speed : mz * speed;
    const accel = T.playerAcceleration * dt;
    player.velocity.x = moveToward(player.velocity.x, desiredX, accel);
    player.velocity.z = moveToward(player.velocity.z, desiredZ, accel);
    player.position.x = THREE.MathUtils.clamp(player.position.x + player.velocity.x * dt, -PLAYER_X_LIMIT, PLAYER_X_LIMIT);
    player.position.z = this.#clampPlayerZ(player.side, player.position.z + player.velocity.z * dt);

    player.swingCooldown = Math.max(0, player.swingCooldown - dt);
    if (player.swingTime >= 0) {
      player.swingTime += dt;
      if (player.swingTime > T.swingDuration) player.swingTime = -1;
    }
    const held = Boolean(input.swing);
    if (held && !player.swingHeld && player.swingCooldown <= 0) {
      player.swingTime = 0;
      player.swingCooldown = T.swingCooldown;
    }
    player.swingHeld = held;
    player.aimX = clampIntent(input.aimX);
    player.aimZ = clampIntent(input.aimZ);
    player.power = input.sprint ? 1.04 : 0.82;
  }

  #clampPlayerZ(side: PickleballSide, z: number): number {
    return side === 0
      ? THREE.MathUtils.clamp(z, -C.halfLength - PLAYER_Z_MARGIN, -0.42)
      : THREE.MathUtils.clamp(z, 0.42, C.halfLength + PLAYER_Z_MARGIN);
  }

  #posePlayers(elapsed: number): void {
    for (const player of this.#players) {
      player.sweep.previousCenter.copy(player.sweep.currentCenter);
      player.rig.group.position.copy(player.position);
      const dx = this.ballPhysics.position.x - player.position.x;
      const dy = this.ballPhysics.position.y - 1.35;
      player.rig.pose({
        speed: Math.hypot(player.velocity.x, player.velocity.z),
        swingTime: player.swingTime,
        elapsed,
        lookX: THREE.MathUtils.clamp(dx / 4, -1, 1),
        lookY: THREE.MathUtils.clamp(dy / 3, -1, 1)
      });
    }
    this.root.updateWorldMatrix(true, true);
    for (const player of this.#players) {
      player.rig.readPaddlePose(this.root, player.sweep.currentCenter, player.sweep.normal);
      player.sweep.active =
        player.swingTime >= T.swingContactStart && player.swingTime <= T.swingContactEnd;
      const depthT = (player.aimZ + 1) * 0.5;
      const targetDepth = THREE.MathUtils.lerp(C.nonVolleyLine + 0.45, C.halfLength - 0.72, depthT);
      player.sweep.target.set(
        player.aimX * (C.halfWidth - 0.36),
        C.ballRadius,
        player.side === 0 ? targetDepth : -targetDepth
      );
      player.sweep.power = player.power;
    }
  }

  #advancePhaseTimer(dt: number): void {
    if (!this.#authoritative || this.#phase === "rally") return;
    this.#phaseTimer -= dt;
    if (this.#phase === "pointDelay" && this.#phaseTimer <= 0) this.#beginPoint();
    else if (this.#phase === "gameOver" && this.#phaseTimer <= 0) this.#resetMatch();
  }

  #launchServe(): void {
    const server = this.#players[this.#server];
    const parity = this.#score[this.#server] & 1;
    const serviceX = (parity === 0 ? 1.45 : -1.45) * (this.#server === 0 ? 1 : -1);
    server.position.x = THREE.MathUtils.lerp(server.position.x, serviceX, 0.5);
    server.swingTime = 0;
    server.swingCooldown = T.swingCooldown;
    this.#posePlayers(0);

    const launch = server.sweep.currentCenter.clone();
    launch.y = Math.max(0.75, launch.y);
    const targetX = -serviceX * 0.9;
    const targetZ = (this.#server === 0 ? 1 : -1) * THREE.MathUtils.lerp(C.nonVolleyLine, C.halfLength, 0.58);
    this.#serveExpectedSign = targetX < 0 ? -1 : 1;
    this.ballPhysics.launchTo(launch, new THREE.Vector3(targetX, C.ballRadius, targetZ), 0.88, this.#server === 0 ? 1 : -1);
    this.#phase = "rally";
    this.#phaseTimer = 0;
    this.#lastHitter = this.#server;
    this.#lastFault = null;
    this.#rallyHits = 0;
    this.#rallyAge = 0;
    this.#bouncesSinceHit = 0;
    this.#twoBounceStage = 0;
    this.onEvent({ kind: "serve", server: this.#server });
  }

  #handlePhysicsEvent(event: PickleballPhysicsEvent): void {
    if (this.#phase !== "rally") return;
    if (event.kind === "net") {
      const worldPosition = this.root.localToWorld(event.position.clone());
      this.onEvent({ kind: "net", worldPosition });
      return;
    }
    if (event.kind === "ground") {
      const worldPosition = this.root.localToWorld(event.position.clone());
      this.onEvent({ kind: "bounce", side: event.side, inCourt: event.inCourt, worldPosition });
      if (!event.inCourt) {
        this.#awardPoint(this.#winnerAfterMiss(), "out");
        return;
      }
      this.#bouncesSinceHit++;
      if (this.#twoBounceStage === 0) {
        const receiver = otherSide(this.#server);
        const correctBox =
          event.side === receiver &&
          Math.abs(event.position.z) > C.nonVolleyLine &&
          Math.sign(event.position.x || this.#serveExpectedSign) === this.#serveExpectedSign;
        if (!correctBox) {
          this.#awardPoint(receiver, "serveBox");
          return;
        }
        this.#twoBounceStage = 1;
      } else if (this.#twoBounceStage === 1 && this.#rallyHits > 0 && event.side === this.#server) {
        this.#twoBounceStage = 2;
      }
      if (this.#bouncesSinceHit >= 2) this.#awardPoint(otherSide(event.side), "doubleBounce");
      return;
    }

    const side = event.side;
    const worldPosition = this.root.localToWorld(event.position.clone());
    if (this.#lastHitter === side) {
      this.#awardPoint(otherSide(side), "doubleHit");
      return;
    }
    const receiver = otherSide(this.#server);
    if ((side === receiver && this.#twoBounceStage < 1) || (side === this.#server && this.#rallyHits > 0 && this.#twoBounceStage < 2)) {
      this.#awardPoint(otherSide(side), "twoBounceRule");
      return;
    }
    const z = this.#players[side].position.z;
    const inKitchen = side === 0 ? z > -C.nonVolleyLine : z < C.nonVolleyLine;
    if (inKitchen && this.#bouncesSinceHit === 0 && this.#rallyHits > 0) {
      this.#awardPoint(otherSide(side), "kitchenVolley");
      return;
    }
    this.#lastHitter = side;
    this.#bouncesSinceHit = 0;
    this.#rallyHits++;
    this.onEvent({ kind: "paddle", side, rallyHits: this.#rallyHits, worldPosition });
  }

  #awardPoint(winner: PickleballSide, reason: PickleballFault): void {
    if (this.#phase !== "rally") return;
    const loser = otherSide(winner);
    let scoringSide: PickleballSide | null = null;
    if (winner === this.#server) {
      this.#score[winner]++;
      scoringSide = winner;
    } else {
      this.#server = winner;
    }
    this.#lastFault = reason;
    this.#pointNumber++;
    this.ballPhysics.stop();
    const score = [this.#score[0], this.#score[1]] as const;
    this.onEvent({ kind: "point", winner, loser, scoringSide, reason, score });
    if (this.#score[winner] >= 11 && this.#score[winner] - this.#score[loser] >= 2) {
      this.#phase = "gameOver";
      this.#phaseTimer = T.gameResetDelay;
      this.onEvent({ kind: "game", winner, score });
    } else {
      this.#phase = "pointDelay";
      this.#phaseTimer = T.pointDelay;
    }
  }

  /** First bounce out faults the hitter; a later miss is won by that hitter. */
  #winnerAfterMiss(): PickleballSide {
    const hitter = this.#lastHitter ?? this.#server;
    return this.#bouncesSinceHit > 0 ? hitter : otherSide(hitter);
  }

  #beginPoint(): void {
    this.#phase = "serveDelay";
    this.#phaseTimer = T.serveDelay;
    this.#lastHitter = null;
    this.#rallyHits = 0;
    this.#rallyAge = 0;
    this.#bouncesSinceHit = 0;
    this.#twoBounceStage = 0;
    this.ballPhysics.stop();
  }

  #resetMatch(): void {
    this.#score[0] = 0;
    this.#score[1] = 0;
    this.#server = otherSide(this.#server);
    this.#lastFault = null;
    this.#beginPoint();
  }

  #syncBallMesh(dt: number): void {
    this.#ballMesh.visible = this.ballPhysics.active;
    this.#ballMesh.position.copy(this.ballPhysics.position);
    if (dt > 0) {
      this.#ballMesh.rotation.x += this.ballPhysics.angularVelocity.x * dt;
      this.#ballMesh.rotation.y += this.ballPhysics.angularVelocity.y * dt;
      this.#ballMesh.rotation.z += this.ballPhysics.angularVelocity.z * dt;
    }
    applyBallGlow(this.#ballMaterial, this.ballPhysics.active ? undefined : 0);
  }

  #localPose(side: PickleballSide): PickleballLocalPose {
    const rig = this.#players[side].rig;
    const worldPosition = rig.worldPosition(new THREE.Vector3());
    rig.group.getWorldQuaternion(tmpQuat);
    tmpForward.set(0, 0, -1).applyQuaternion(tmpQuat);
    return {
      side,
      worldPosition,
      worldHeading: Math.atan2(-tmpForward.x, -tmpForward.z)
    };
  }
}
