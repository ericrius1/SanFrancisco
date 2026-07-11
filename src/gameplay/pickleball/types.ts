import type * as THREE from "three/webgpu";

/** Court-local side: 0 is the -Z (near) end, 1 is the +Z (far) end. */
export type PickleballSide = 0 | 1;

export type PickleballController = "ai" | "local" | "remote" | "replica";

export type PickleballPhase = "serveDelay" | "rally" | "pointDelay" | "gameOver";

export type PickleballFault =
  | "out"
  | "doubleBounce"
  | "doubleHit"
  | "serveBox"
  | "twoBounceRule"
  | "kitchenVolley"
  | "stalled";

export type PickleballInputIntent = {
  /** Court-local strafe, -1 (left) to +1 (right). */
  moveX?: number;
  /** Court-local movement, -1 (near) to +1 (far). */
  moveZ?: number;
  /** Held or pulsed swing input; the game edge-detects it. */
  swing?: boolean;
  /** Desired cross-court placement, -1 (left) to +1 (right). */
  aimX?: number;
  /** Desired depth, -1 (short) to +1 (deep). */
  aimZ?: number;
  sprint?: boolean;
  /** Press-E intent while walking near an unclaimed NPC. */
  interact?: boolean;
  /** Leave intent while controlling a side. */
  exit?: boolean;
};

export type PickleballInteraction = {
  side: PickleballSide;
  distance: number;
  available: boolean;
  prompt: string;
  worldPosition: THREE.Vector3;
};

export type PickleballEvent =
  | { kind: "serve"; server: PickleballSide }
  | { kind: "paddle"; side: PickleballSide; rallyHits: number; worldPosition: THREE.Vector3 }
  | { kind: "bounce"; side: PickleballSide; inCourt: boolean; worldPosition: THREE.Vector3 }
  | { kind: "net"; worldPosition: THREE.Vector3 }
  | {
      kind: "point";
      winner: PickleballSide;
      loser: PickleballSide;
      scoringSide: PickleballSide | null;
      reason: PickleballFault;
      score: readonly [number, number];
    }
  | { kind: "game"; winner: PickleballSide; score: readonly [number, number] }
  | { kind: "takeoverRequested"; side: PickleballSide }
  | { kind: "releaseRequested"; side: PickleballSide };

export type PickleballLocalPose = {
  side: PickleballSide;
  worldPosition: THREE.Vector3;
  worldHeading: number;
};

export type PickleballFrameResult = {
  interaction: PickleballInteraction | null;
  requestedSide: PickleballSide | null;
  requestedRelease: PickleballSide | null;
  localPose: PickleballLocalPose | null;
  phase: PickleballPhase;
  score: readonly [number, number];
  server: PickleballSide;
};

export type PickleballDiagnostics = {
  authoritative: boolean;
  physicsEngine: "custom-fixed-step";
  fixedStepSeconds: number;
  accumulatorSeconds: number;
  activeBodies: number;
  colliderCount: number;
  sweptCollision: true;
  phase: PickleballPhase;
  phaseTimer: number;
  score: readonly [number, number];
  server: PickleballSide;
  rallyHits: number;
  ballActive: boolean;
  ballPosition: readonly [number, number, number];
  ballVelocity: readonly [number, number, number];
  controllers: readonly [PickleballController, PickleballController];
  owners: readonly [string | null, string | null];
  localSide: PickleballSide | null;
  lastFault: PickleballFault | null;
  collisionCounts: {
    ground: number;
    net: number;
    paddle: number;
  };
};

export type PickleballOptions = {
  /** World-space location of the centre mark at court surface height. */
  origin?: { x: number; y: number; z: number };
  /** Rotation around world +Y. Court length lies along local Z. */
  yaw?: number;
  authoritative?: boolean;
  seed?: number;
  interactionRadius?: number;
  visible?: boolean;
};

export type PickleballSnapshot = readonly number[];

export function otherSide(side: PickleballSide): PickleballSide {
  return side === 0 ? 1 : 0;
}

