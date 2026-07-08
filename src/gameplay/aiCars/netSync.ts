/**
 * Multiplayer sync for the AI-cars fleet.
 *
 * Only ONE client (the leader) runs the fleet sim + trainer; everyone else
 * renders the cars as *ghosts* driven by 8 Hz snapshots. This module holds the
 * protocol-level pieces the AiCars facade wires up:
 *
 *  - `isLeader(net)` — deterministic leader election (lowest live id wins;
 *    solo / disconnected clients are their own leader so single-player is
 *    unchanged).
 *  - `serializeCars(cars)` — leader → wire rows for the `cars` message.
 *  - `GhostStore` — non-leader side: ingest snapshot rows, interpolate pose,
 *    time out cars that stop appearing. Pure data (+ THREE vectors); the facade
 *    owns the actual meshes/overlays and just reads the ghost list.
 *
 * Wire row (one per alive car), length 8 + HIDDEN:
 *   [slot, kind, hue0-255, x·100, y·100, z·100, heading·1000, speed·10, ...12 hidden bytes]
 * Coordinates are rounded ints; hidden activations (tanh, [-1,1]) map to bytes
 * 0..255. Speed is now SIGNED (reverse gear, −4..14 m/s): `Math.round(speed·10)`
 * and the `speed/10` decode are symmetric across zero, so no special handling.
 * ~32 rows → a couple KB of JSON, well under the 16 KB relay cap.
 */

import * as THREE from "three/webgpu";
import { ACTOR_SIZES } from "./learner.ts";
import type { AiCar } from "./fleet.ts";

/** Hidden-layer width synced per car (ACTOR_SIZES = [obs, hidden, act]). */
export const HIDDEN = ACTOR_SIZES[1];
/** Numbers before the hidden bytes in a wire row. */
const HEAD_LEN = 8;
/** Total numbers per wire row. */
export const ROW_LEN = HEAD_LEN + HIDDEN;

const GHOST_TIMEOUT_MS = 1500; // stop drawing a ghost we stop hearing about
const LERP_RATE = 9; // pose interpolation stiffness (1/s)

/** Minimal shape of the Net client this module reads for leader election. */
export interface NetRoster {
  selfId: number;
  roster: Map<number, unknown>;
}

/**
 * Am I the training leader? True when solo/disconnected (selfId 0) so that
 * single-player keeps running the fleet, otherwise only the lowest live id.
 */
export function isLeader(net: NetRoster | null): boolean {
  if (!net || net.selfId === 0) return true; // offline / solo → run locally
  let min = net.selfId;
  for (const id of net.roster.keys()) if (id < min) min = id;
  return net.selfId <= min;
}

/** Quantise a tanh activation in [-1,1] to a byte 0..255. */
function actToByte(a: number): number {
  return Math.max(0, Math.min(255, Math.round((a + 1) * 127.5)));
}

/** Inverse of actToByte. */
function byteToAct(b: number): number {
  return b / 127.5 - 1;
}

/** Leader side: pack every alive car into a wire row. */
export function serializeCars(cars: AiCar[]): number[][] {
  const rows: number[][] = [];
  for (const c of cars) {
    if (!c.alive) continue;
    const hidden = c.policy.layerOut[0]; // first hidden layer's post-activations
    const row: number[] = [
      c.id,
      c.bodyKind & 255,
      Math.round(c.paintHue * 255) & 255,
      Math.round(c.pos.x * 100),
      Math.round(c.pos.y * 100),
      Math.round(c.pos.z * 100),
      Math.round(c.heading * 1000),
      Math.round(c.speed * 10)
    ];
    for (let i = 0; i < HIDDEN; i++) row.push(actToByte(hidden && i < hidden.length ? hidden[i] : 0));
    rows.push(row);
  }
  return rows;
}

/** One interpolated ghost car (non-leader render state). */
export type Ghost = {
  id: number;
  active: boolean;
  spawned: boolean; // has an initial pose been snapped?
  kind: number;
  hue: number; // 0..1
  pos: THREE.Vector3; // interpolated
  target: THREE.Vector3; // latest received
  heading: number;
  targetHeading: number;
  speed: number;
  hidden: Float32Array; // decoded hidden activations (HIDDEN)
  seen: number; // performance.now() of last snapshot touch
  mesh?: THREE.Group; // attached by the facade
};

/** Shortest-arc angle interpolation. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/**
 * Non-leader ghost bookkeeping: ingest snapshot rows, interpolate each frame,
 * expire cars that drop out of the snapshots. Slots line up 1:1 with the
 * leader's fleet ids (0..maxCars-1) so the shared BrainOverlay indexes by id.
 */
export class GhostStore {
  readonly cars: Ghost[] = [];

  constructor(maxCars: number) {
    for (let i = 0; i < maxCars; i++) {
      this.cars.push({
        id: i,
        active: false,
        spawned: false,
        kind: 0,
        hue: 0,
        pos: new THREE.Vector3(),
        target: new THREE.Vector3(),
        heading: 0,
        targetHeading: 0,
        speed: 0,
        hidden: new Float32Array(HIDDEN),
        seen: 0
      });
    }
  }

  /** Apply one `cars` snapshot (array of wire rows). Malformed rows ignored. */
  ingest(rows: number[][]): void {
    const now = performance.now();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== ROW_LEN) continue;
      const slot = row[0];
      if (!Number.isInteger(slot) || slot < 0 || slot >= this.cars.length) continue;
      const g = this.cars[slot];
      g.kind = row[1] | 0;
      g.hue = ((row[2] | 0) & 255) / 255;
      g.target.set(row[3] / 100, row[4] / 100, row[5] / 100);
      g.targetHeading = row[6] / 1000;
      g.speed = row[7] / 10;
      for (let i = 0; i < HIDDEN; i++) g.hidden[i] = byteToAct(row[HEAD_LEN + i] | 0);
      g.seen = now;
      if (!g.spawned || !g.active) {
        g.pos.copy(g.target);
        g.heading = g.targetHeading;
        g.spawned = true;
      }
      g.active = true;
    }
  }

  /** Advance interpolation; expire silent ghosts. Returns nothing. */
  advance(dt: number): void {
    const now = performance.now();
    const k = 1 - Math.exp(-dt * LERP_RATE);
    for (const g of this.cars) {
      if (!g.active) continue;
      if (now - g.seen > GHOST_TIMEOUT_MS) {
        g.active = false;
        g.spawned = false;
        continue;
      }
      g.pos.lerp(g.target, k);
      g.heading = lerpAngle(g.heading, g.targetHeading, k);
    }
  }

  /** Drop every ghost (used on demote/handoff — meshes cleared by the facade). */
  clear(): void {
    for (const g of this.cars) {
      g.active = false;
      g.spawned = false;
    }
  }
}
