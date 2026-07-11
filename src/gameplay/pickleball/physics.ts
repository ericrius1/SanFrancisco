import * as THREE from "three/webgpu";
import { PICKLEBALL_COURT as C, PICKLEBALL_TUNING as T } from "./constants";
import type { PickleballSide } from "./types";

export type PickleballPaddleSweep = {
  side: PickleballSide;
  previousCenter: THREE.Vector3;
  currentCenter: THREE.Vector3;
  normal: THREE.Vector3;
  active: boolean;
  target: THREE.Vector3;
  power: number;
};

export type PickleballPhysicsEvent =
  | { kind: "ground"; side: PickleballSide; inCourt: boolean; position: THREE.Vector3 }
  | { kind: "net"; position: THREE.Vector3 }
  | { kind: "paddle"; side: PickleballSide; position: THREE.Vector3 };

type Collision = {
  kind: "ground" | "net" | "paddle";
  t: number;
  side?: PickleballSide;
  paddle?: PickleballPaddleSweep;
};

const _start = new THREE.Vector3();
const _next = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _padStart = new THREE.Vector3();
const _padEnd = new THREE.Vector3();
const _relativeStart = new THREE.Vector3();
const _relativeDelta = new THREE.Vector3();
const _targetDelta = new THREE.Vector3();
const _magnus = new THREE.Vector3();

function sideAtZ(z: number): PickleballSide {
  return z < 0 ? 0 : 1;
}

function netHeightAt(x: number): number {
  const t = THREE.MathUtils.clamp(Math.abs(x) / C.halfWidth, 0, 1);
  return THREE.MathUtils.lerp(C.netCentreHeight, C.netSidelineHeight, t * t);
}

/**
 * Deterministic one-ball simulation. It uses a 120 Hz accumulator, swept
 * sphere tests for moving paddles and the net plane, and swept ground contact.
 */
export class PickleballBallPhysics {
  readonly position = new THREE.Vector3(0, C.ballRadius, 0);
  readonly velocity = new THREE.Vector3();
  readonly angularVelocity = new THREE.Vector3();
  readonly collisionCounts = { ground: 0, net: 0, paddle: 0 };

  active = false;
  accumulator = 0;
  simulationTime = 0;

  #lastPaddleAt: [number, number] = [-Infinity, -Infinity];

  launch(position: THREE.Vector3, velocity: THREE.Vector3, spin?: THREE.Vector3): void {
    this.position.copy(position);
    this.velocity.copy(velocity);
    this.angularVelocity.copy(spin ?? _magnus.set(0, 0, 0));
    this.active = true;
    this.accumulator = 0;
    this.#lastPaddleAt[0] = -Infinity;
    this.#lastPaddleAt[1] = -Infinity;
  }

  launchTo(position: THREE.Vector3, target: THREE.Vector3, flightSeconds: number, spinSign = 1): void {
    const flight = Math.max(0.18, flightSeconds);
    this.position.copy(position);
    this.velocity.set(
      (target.x - position.x) / flight,
      (target.y - position.y + 0.5 * T.gravity * flight * flight) / flight,
      (target.z - position.z) / flight
    );
    this.angularVelocity.set(16 * spinSign, 2.5 * spinSign, -4 * spinSign);
    this.active = true;
    this.accumulator = 0;
    this.#clampSpeed();
  }

  stop(): void {
    this.active = false;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.accumulator = 0;
  }

  setState(active: boolean, position: THREE.Vector3, velocity: THREE.Vector3, angularVelocity: THREE.Vector3): void {
    this.active = active;
    this.position.copy(position);
    this.velocity.copy(velocity);
    this.angularVelocity.copy(angularVelocity);
    this.accumulator = 0;
  }

  update(
    deltaSeconds: number,
    paddles: readonly PickleballPaddleSweep[],
    onEvent: (event: PickleballPhysicsEvent) => void
  ): void {
    if (!this.active) return;
    const frameDelta = Math.min(Math.max(deltaSeconds, 0), T.maxFrameDelta);
    this.accumulator += frameDelta;
    const stepCount = Math.floor(this.accumulator / T.fixedStep);
    if (stepCount <= 0) return;

    for (let step = 0; step < stepCount && this.active; step++) {
      const frameT0 = step / stepCount;
      const frameT1 = (step + 1) / stepCount;
      this.#fixedStep(T.fixedStep, frameT0, frameT1, paddles, onEvent);
      this.simulationTime += T.fixedStep;
      this.accumulator -= T.fixedStep;
    }
  }

  /** Reliable close-range fallback at the authored swing contact frame. */
  tryPaddleStrike(
    paddle: PickleballPaddleSweep,
    onEvent: (event: PickleballPhysicsEvent) => void,
    maxDistance = 0.48
  ): boolean {
    if (!this.active || !paddle.active || this.simulationTime - this.#lastPaddleAt[paddle.side] < 0.16) return false;
    if (this.position.distanceToSquared(paddle.currentCenter) > maxDistance * maxDistance) return false;
    this.position.lerp(paddle.currentCenter, 0.16);
    this.#applyPaddle(paddle);
    this.#lastPaddleAt[paddle.side] = this.simulationTime;
    this.collisionCounts.paddle++;
    onEvent({ kind: "paddle", side: paddle.side, position: this.position.clone() });
    return true;
  }

  #fixedStep(
    h: number,
    paddleT0: number,
    paddleT1: number,
    paddles: readonly PickleballPaddleSweep[],
    onEvent: (event: PickleballPhysicsEvent) => void
  ): void {
    const speed = this.velocity.length();
    const drag = Math.max(0, 1 - T.airDrag * speed * h);
    this.velocity.multiplyScalar(drag);
    _magnus.crossVectors(this.angularVelocity, this.velocity).multiplyScalar(T.magnus * h);
    this.velocity.add(_magnus);
    this.velocity.y -= T.gravity * h;
    this.angularVelocity.multiplyScalar(Math.max(0, 1 - 0.16 * h));
    this.#clampSpeed();

    let remaining = h;
    for (let iteration = 0; iteration < 3 && remaining > 1e-5 && this.active; iteration++) {
      _start.copy(this.position);
      _next.copy(this.position).addScaledVector(this.velocity, remaining);
      const collision = this.#earliestCollision(_start, _next, paddleT0, paddleT1, paddles);
      if (!collision) {
        this.position.copy(_next);
        break;
      }

      this.position.lerpVectors(_start, _next, collision.t);
      remaining *= 1 - collision.t;

      if (collision.kind === "paddle" && collision.paddle) {
        this.#applyPaddle(collision.paddle);
        this.#lastPaddleAt[collision.paddle.side] = this.simulationTime;
        this.collisionCounts.paddle++;
        onEvent({ kind: "paddle", side: collision.paddle.side, position: this.position.clone() });
        this.position.addScaledVector(this.velocity, 0.0008);
      } else if (collision.kind === "net") {
        const fromNear = _start.z < 0;
        this.velocity.z = (fromNear ? -1 : 1) * Math.abs(this.velocity.z) * T.netRestitution;
        this.velocity.x *= T.netGrip;
        this.velocity.y *= 0.76;
        const tape = netHeightAt(this.position.x);
        if (this.position.y > tape - 0.09) this.velocity.y = Math.max(this.velocity.y, 1.15);
        this.position.z = (fromNear ? -1 : 1) * (C.ballRadius + 0.001);
        this.collisionCounts.net++;
        onEvent({ kind: "net", position: this.position.clone() });
      } else {
        this.position.y = C.ballRadius + 0.0005;
        const incomingY = this.velocity.y;
        this.velocity.y = Math.abs(incomingY) * T.groundRestitution;
        this.velocity.x = this.velocity.x * T.groundGrip + this.angularVelocity.z * C.ballRadius * 0.035;
        this.velocity.z = this.velocity.z * T.groundGrip - this.angularVelocity.x * C.ballRadius * 0.035;
        this.angularVelocity.multiplyScalar(0.82);
        if (this.velocity.y < 0.34) this.velocity.y = 0.34;
        const side = collision.side ?? sideAtZ(this.position.z);
        const inCourt =
          Math.abs(this.position.x) <= C.halfWidth + C.lineWidth / 2 &&
          Math.abs(this.position.z) <= C.halfLength + C.lineWidth / 2;
        this.collisionCounts.ground++;
        onEvent({ kind: "ground", side, inCourt, position: this.position.clone() });
      }

      if (collision.t < 0.0001) remaining = Math.max(0, remaining - 0.0005);
    }

    if (Math.abs(this.position.x) > C.apronWidth || Math.abs(this.position.z) > C.apronLength) this.stop();
  }

  #earliestCollision(
    start: THREE.Vector3,
    end: THREE.Vector3,
    paddleT0: number,
    paddleT1: number,
    paddles: readonly PickleballPaddleSweep[]
  ): Collision | null {
    _delta.subVectors(end, start);
    let hit: Collision | null = null;

    if (start.y >= C.ballRadius && end.y <= C.ballRadius && _delta.y < 0) {
      const t = (C.ballRadius - start.y) / _delta.y;
      hit = { kind: "ground", t, side: sideAtZ(THREE.MathUtils.lerp(start.z, end.z, t)) };
    }

    if (Math.abs(_delta.z) > 1e-8) {
      let netT = Infinity;
      if (start.z < -C.ballRadius && end.z >= -C.ballRadius) netT = (-C.ballRadius - start.z) / _delta.z;
      else if (start.z > C.ballRadius && end.z <= C.ballRadius) netT = (C.ballRadius - start.z) / _delta.z;
      if (netT >= 0 && netT <= 1 && (!hit || netT < hit.t)) {
        const x = THREE.MathUtils.lerp(start.x, end.x, netT);
        const y = THREE.MathUtils.lerp(start.y, end.y, netT);
        if (Math.abs(x) <= C.netPostX + C.ballRadius && y <= netHeightAt(x) + C.ballRadius && y >= 0) {
          hit = { kind: "net", t: netT };
        }
      }
    }

    for (const paddle of paddles) {
      if (!paddle.active || this.simulationTime - this.#lastPaddleAt[paddle.side] < 0.16) continue;
      if (sideAtZ(start.z) !== paddle.side && Math.abs(start.z) > C.ballRadius * 2) continue;
      _padStart.lerpVectors(paddle.previousCenter, paddle.currentCenter, paddleT0);
      _padEnd.lerpVectors(paddle.previousCenter, paddle.currentCenter, paddleT1);
      _relativeStart.subVectors(start, _padStart);
      _relativeDelta.subVectors(_delta, _padEnd.sub(_padStart));
      const radius = C.paddleRadius + C.ballRadius;
      const a = _relativeDelta.lengthSq();
      const b = 2 * _relativeStart.dot(_relativeDelta);
      const c = _relativeStart.lengthSq() - radius * radius;
      let paddleT = Infinity;
      if (c <= 0) paddleT = 0;
      else if (a > 1e-10) {
        const discriminant = b * b - 4 * a * c;
        if (discriminant >= 0) paddleT = (-b - Math.sqrt(discriminant)) / (2 * a);
      }
      if (paddleT >= 0 && paddleT <= 1 && (!hit || paddleT < hit.t)) {
        hit = { kind: "paddle", t: paddleT, side: paddle.side, paddle };
      }
    }

    return hit;
  }

  #applyPaddle(paddle: PickleballPaddleSweep): void {
    _targetDelta.subVectors(paddle.target, this.position);
    const horizontalDistance = Math.hypot(_targetDelta.x, _targetDelta.z);
    const power = THREE.MathUtils.clamp(paddle.power, 0.55, 1.15);
    const horizontalSpeed = THREE.MathUtils.lerp(7.8, 11.3, (power - 0.55) / 0.6);
    const flight = THREE.MathUtils.clamp(horizontalDistance / horizontalSpeed, 0.48, 1.05);
    this.velocity.set(
      _targetDelta.x / flight,
      (_targetDelta.y + 0.5 * T.gravity * flight * flight) / flight,
      _targetDelta.z / flight
    );
    // Paddle face contributes a small physical deflection without overriding placement.
    this.velocity.addScaledVector(paddle.normal, 0.45 * power);
    this.angularVelocity.set(paddle.side === 0 ? 22 : -22, -this.velocity.x * 1.4, -this.velocity.z * 0.7);
    this.#clampSpeed();
  }

  #clampSpeed(): void {
    const speedSq = this.velocity.lengthSq();
    if (speedSq > T.maxBallSpeed * T.maxBallSpeed) this.velocity.multiplyScalar(T.maxBallSpeed / Math.sqrt(speedSq));
  }
}

