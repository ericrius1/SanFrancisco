export type LightState = "green" | "yellow" | "red";

export type SignalApproachSeed = {
  segId: number;
  s: number;
  dir: 1 | -1;
  x: number;
  z: number;
  tangentX: number;
  tangentZ: number;
  roadClass: number;
  lanes: number;
  halfWidth: number;
};

export type SignalNodeSeed = {
  x: number;
  z: number;
  score: number;
  approaches: SignalApproachSeed[];
};

export type TrafficSignal = {
  id: number;
  x: number;
  z: number;
  phaseOffset: number;
  axisX: number;
  axisZ: number;
  approaches: SignalApproach[];
};

export type SignalApproach = SignalApproachSeed & {
  signalId: number;
  axis: 0 | 1;
};

export type SignalQuery = {
  hasSignal: boolean;
  signalId: number;
  distance: number;
  distanceN: number;
  state: LightState;
  red: number;
  yellow: number;
  green: number;
  stopRequired: boolean;
};

/**
 * Transfer-friendly runtime state produced after the expensive intersection
 * candidate pass. Signal and approach data stay packed until a nearby signal is
 * actually rendered; the hot query lookup is packed separately so restoring a
 * worker-built system does not rebuild maps or sort approach lists on main.
 */
export type TrafficSignalSystemSnapshot = {
  signalCount: number;
  signalValues: Float64Array;
  signalApproachStarts: Uint32Array;
  approachSegIds: Uint32Array;
  approachDirs: Int8Array;
  approachValues: Float64Array;
  approachRoadClasses: Uint8Array;
  approachLanes: Uint8Array;
  approachAxes: Uint8Array;
  approachKeys: Uint32Array;
  approachStarts: Uint32Array;
  approachS: Float32Array;
  approachSignalIds: Uint32Array;
  queryApproachAxes: Uint8Array;
};

const CYCLE_S = 60;
const HALF_CYCLE_S = CYCLE_S * 0.5;
const GREEN_S = 24;
const YELLOW_S = 4;

function hash01(x: number, z: number): number {
  let h = (Math.imul(Math.round(x * 10), 374761393) ^ Math.imul(Math.round(z * 10), 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function axisDiff(a: number, b: number): number {
  const d = Math.abs(wrapPi(a - b));
  return Math.min(d, Math.abs(Math.PI - d));
}

function approachKey(segId: number, dir: 1 | -1): number {
  return segId * 2 + (dir === 1 ? 1 : 0);
}

function packedKeySlot(keys: Uint32Array, key: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = keys[mid];
    if (value === key) return mid;
    if (value < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export class TrafficSignalSystem {
  #signalCount: number;
  #signalValues: Float64Array;
  #signalApproachStarts: Uint32Array;
  #approachSegIds: Uint32Array;
  #approachDirs: Int8Array;
  #approachValues: Float64Array;
  #approachRoadClasses: Uint8Array;
  #approachLanes: Uint8Array;
  #approachAxes: Uint8Array;
  #signalCache: Array<TrafficSignal | undefined>;
  #materializedSignals: TrafficSignal[] | null;
  #byApproach = new Map<number, SignalApproach[]>();
  #approachKeys: Uint32Array;
  #approachStarts: Uint32Array;
  #approachS: Float32Array;
  #approachSignalIds: Uint32Array;
  #queryApproachAxes: Uint8Array;

  constructor(nodes: SignalNodeSeed[], prepared?: TrafficSignalSystemSnapshot) {
    if (prepared) {
      this.#signalCount = prepared.signalCount;
      this.#signalValues = prepared.signalValues;
      this.#signalApproachStarts = prepared.signalApproachStarts;
      this.#approachSegIds = prepared.approachSegIds;
      this.#approachDirs = prepared.approachDirs;
      this.#approachValues = prepared.approachValues;
      this.#approachRoadClasses = prepared.approachRoadClasses;
      this.#approachLanes = prepared.approachLanes;
      this.#queryApproachAxes = prepared.queryApproachAxes;
      this.#signalCache = new Array(prepared.signalCount);
      this.#materializedSignals = null;
      this.#approachKeys = prepared.approachKeys;
      this.#approachStarts = prepared.approachStarts;
      this.#approachS = prepared.approachS;
      this.#approachSignalIds = prepared.approachSignalIds;
      this.#approachAxes = prepared.approachAxes;
      return;
    }

    const signals: TrafficSignal[] = [];
    for (const node of nodes) this.#addSignal(node, signals);
    for (const list of this.#byApproach.values()) {
      list.sort((a, b) => (a.dir === 1 ? a.s - b.s : b.s - a.s));
    }
    const packedSignals = this.#packSignals(signals);
    this.#signalCount = signals.length;
    this.#signalValues = packedSignals.signalValues;
    this.#signalApproachStarts = packedSignals.signalApproachStarts;
    this.#approachSegIds = packedSignals.approachSegIds;
    this.#approachDirs = packedSignals.approachDirs;
    this.#approachValues = packedSignals.approachValues;
    this.#approachRoadClasses = packedSignals.approachRoadClasses;
    this.#approachLanes = packedSignals.approachLanes;
    this.#approachAxes = packedSignals.approachAxes;
    this.#signalCache = signals;
    this.#materializedSignals = signals;
    const packed = this.#packApproaches();
    this.#approachKeys = packed.approachKeys;
    this.#approachStarts = packed.approachStarts;
    this.#approachS = packed.approachS;
    this.#approachSignalIds = packed.approachSignalIds;
    this.#queryApproachAxes = packed.queryApproachAxes;
    this.#byApproach.clear();
  }

  static fromSnapshot(snapshot: TrafficSignalSystemSnapshot): TrafficSignalSystem {
    return new TrafficSignalSystem([], snapshot);
  }

  toSnapshot(): TrafficSignalSystemSnapshot {
    return {
      signalCount: this.#signalCount,
      signalValues: this.#signalValues,
      signalApproachStarts: this.#signalApproachStarts,
      approachSegIds: this.#approachSegIds,
      approachDirs: this.#approachDirs,
      approachValues: this.#approachValues,
      approachRoadClasses: this.#approachRoadClasses,
      approachLanes: this.#approachLanes,
      approachAxes: this.#approachAxes,
      approachKeys: this.#approachKeys,
      approachStarts: this.#approachStarts,
      approachS: this.#approachS,
      approachSignalIds: this.#approachSignalIds,
      queryApproachAxes: this.#queryApproachAxes
    };
  }

  get signals(): TrafficSignal[] {
    if (!this.#materializedSignals) {
      const signals = new Array<TrafficSignal>(this.#signalCount);
      for (let id = 0; id < this.#signalCount; id++) signals[id] = this.#signalAt(id);
      this.#materializedSignals = signals;
    }
    return this.#materializedSignals;
  }

  query(segId: number, s: number, dir: 1 | -1, timeS: number, range: number): SignalQuery {
    const slot = packedKeySlot(this.#approachKeys, approachKey(segId, dir));
    let bestSignalId = -1;
    let bestAxis: 0 | 1 = 0;
    let bestD = range;
    if (slot >= 0) {
      const start = this.#approachStarts[slot];
      const end = this.#approachStarts[slot + 1];
      for (let i = start; i < end; i++) {
        const d = dir === 1 ? this.#approachS[i] - s : s - this.#approachS[i];
        if (d < -2) continue;
        if (d < bestD) {
          bestD = Math.max(0, d);
          bestSignalId = this.#approachSignalIds[i];
          bestAxis = this.#queryApproachAxes[i] as 0 | 1;
        }
        if (d > range) break;
      }
    }
    if (bestSignalId < 0) {
      return {
        hasSignal: false,
        signalId: -1,
        distance: range,
        distanceN: 1,
        state: "green",
        red: 0,
        yellow: 0,
        green: 1,
        stopRequired: false
      };
    }
    const signal = this.#signalAt(bestSignalId);
    const state = this.stateForAxis(signal, bestAxis, timeS);
    return {
      hasSignal: true,
      signalId: bestSignalId,
      distance: bestD,
      distanceN: Math.max(0, Math.min(1, bestD / range)),
      state,
      red: state === "red" ? 1 : 0,
      yellow: state === "yellow" ? 1 : 0,
      green: state === "green" ? 1 : 0,
      stopRequired: state !== "green"
    };
  }

  #packApproaches(): Pick<
    TrafficSignalSystemSnapshot,
    "approachKeys" | "approachStarts" | "approachS" | "approachSignalIds" | "queryApproachAxes"
  > {
    const entries = [...this.#byApproach.entries()].sort((a, b) => a[0] - b[0]);
    const approachKeys = new Uint32Array(entries.length);
    const approachStarts = new Uint32Array(entries.length + 1);
    let total = 0;
    for (let i = 0; i < entries.length; i++) {
      approachKeys[i] = entries[i][0];
      approachStarts[i] = total;
      total += entries[i][1].length;
    }
    approachStarts[entries.length] = total;

    const approachS = new Float32Array(total);
    const approachSignalIds = new Uint32Array(total);
    const queryApproachAxes = new Uint8Array(total);
    let cursor = 0;
    for (const [, approaches] of entries) {
      for (const approach of approaches) {
        approachS[cursor] = approach.s;
        approachSignalIds[cursor] = approach.signalId;
        queryApproachAxes[cursor] = approach.axis;
        cursor++;
      }
    }
    return { approachKeys, approachStarts, approachS, approachSignalIds, queryApproachAxes };
  }

  #packSignals(signals: TrafficSignal[]): Pick<
    TrafficSignalSystemSnapshot,
    | "signalValues"
    | "signalApproachStarts"
    | "approachSegIds"
    | "approachDirs"
    | "approachValues"
    | "approachRoadClasses"
    | "approachLanes"
    | "approachAxes"
  > {
    const signalValues = new Float64Array(signals.length * 5);
    const signalApproachStarts = new Uint32Array(signals.length + 1);
    let approachCount = 0;
    for (let id = 0; id < signals.length; id++) {
      const signal = signals[id];
      const base = id * 5;
      signalValues[base] = signal.x;
      signalValues[base + 1] = signal.z;
      signalValues[base + 2] = signal.phaseOffset;
      signalValues[base + 3] = signal.axisX;
      signalValues[base + 4] = signal.axisZ;
      signalApproachStarts[id] = approachCount;
      approachCount += signal.approaches.length;
    }
    signalApproachStarts[signals.length] = approachCount;

    const approachSegIds = new Uint32Array(approachCount);
    const approachDirs = new Int8Array(approachCount);
    const approachValues = new Float64Array(approachCount * 6);
    const approachRoadClasses = new Uint8Array(approachCount);
    const approachLanes = new Uint8Array(approachCount);
    const approachAxes = new Uint8Array(approachCount);
    let cursor = 0;
    for (const signal of signals) {
      for (const approach of signal.approaches) {
        const base = cursor * 6;
        approachSegIds[cursor] = approach.segId;
        approachDirs[cursor] = approach.dir;
        approachValues[base] = approach.s;
        approachValues[base + 1] = approach.x;
        approachValues[base + 2] = approach.z;
        approachValues[base + 3] = approach.tangentX;
        approachValues[base + 4] = approach.tangentZ;
        approachValues[base + 5] = approach.halfWidth;
        approachRoadClasses[cursor] = approach.roadClass;
        approachLanes[cursor] = approach.lanes;
        approachAxes[cursor] = approach.axis;
        cursor++;
      }
    }
    return {
      signalValues,
      signalApproachStarts,
      approachSegIds,
      approachDirs,
      approachValues,
      approachRoadClasses,
      approachLanes,
      approachAxes
    };
  }

  #signalAt(id: number): TrafficSignal {
    const cached = this.#signalCache[id];
    if (cached) return cached;
    const signalBase = id * 5;
    const approaches: SignalApproach[] = [];
    const start = this.#signalApproachStarts[id];
    const end = this.#signalApproachStarts[id + 1];
    for (let i = start; i < end; i++) {
      const base = i * 6;
      approaches.push({
        segId: this.#approachSegIds[i],
        s: this.#approachValues[base],
        dir: this.#approachDirs[i] as 1 | -1,
        x: this.#approachValues[base + 1],
        z: this.#approachValues[base + 2],
        tangentX: this.#approachValues[base + 3],
        tangentZ: this.#approachValues[base + 4],
        roadClass: this.#approachRoadClasses[i],
        lanes: this.#approachLanes[i],
        halfWidth: this.#approachValues[base + 5],
        signalId: id,
        axis: this.#approachAxes[i] as 0 | 1
      });
    }
    const signal: TrafficSignal = {
      id,
      x: this.#signalValues[signalBase],
      z: this.#signalValues[signalBase + 1],
      phaseOffset: this.#signalValues[signalBase + 2],
      axisX: this.#signalValues[signalBase + 3],
      axisZ: this.#signalValues[signalBase + 4],
      approaches
    };
    this.#signalCache[id] = signal;
    return signal;
  }

  stateForAxis(signal: TrafficSignal, axis: 0 | 1, timeS: number): LightState {
    const shifted = timeS + signal.phaseOffset - axis * HALF_CYCLE_S;
    const t = ((shifted % CYCLE_S) + CYCLE_S) % CYCLE_S;
    if (t < GREEN_S) return "green";
    if (t < GREEN_S + YELLOW_S) return "yellow";
    return "red";
  }

  nearest(x: number, z: number, radius: number, max: number, out: TrafficSignal[]): TrafficSignal[] {
    out.length = 0;
    const r2 = radius * radius;
    for (let id = 0; id < this.#signalCount; id++) {
      const base = id * 5;
      const dx = this.#signalValues[base] - x;
      const dz = this.#signalValues[base + 1] - z;
      if (dx * dx + dz * dz <= r2) out.push(this.#signalAt(id));
    }
    out.sort((a, b) => {
      const adx = a.x - x;
      const adz = a.z - z;
      const bdx = b.x - x;
      const bdz = b.z - z;
      return adx * adx + adz * adz - (bdx * bdx + bdz * bdz);
    });
    if (out.length > max) out.length = max;
    return out;
  }

  #addSignal(node: SignalNodeSeed, signals: TrafficSignal[]): void {
    if (node.approaches.length < 3) return;
    const id = signals.length;
    const first = node.approaches[0];
    const a0 = Math.atan2(first.tangentX, first.tangentZ);
    const signal: TrafficSignal = {
      id,
      x: node.x,
      z: node.z,
      phaseOffset: hash01(node.x, node.z) * CYCLE_S,
      axisX: Math.sin(a0),
      axisZ: Math.cos(a0),
      approaches: []
    };
    for (const app of node.approaches) {
      const a = Math.atan2(app.tangentX, app.tangentZ);
      const axis: 0 | 1 = axisDiff(a, a0) < Math.PI * 0.25 ? 0 : 1;
      const full: SignalApproach = { ...app, signalId: id, axis };
      signal.approaches.push(full);
      const key = approachKey(app.segId, app.dir);
      let list = this.#byApproach.get(key);
      if (!list) {
        list = [];
        this.#byApproach.set(key, list);
      }
      list.push(full);
    }
    signals.push(signal);
  }
}

export function chooseSignalNodes(candidates: SignalNodeSeed[]): SignalNodeSeed[] {
  candidates.sort((a, b) => b.score - a.score);
  const accepted: SignalNodeSeed[] = [];
  for (const c of candidates) {
    let blocked = false;
    const minDist = c.score > 0.8 ? 42 : 72;
    const minDist2 = minDist * minDist;
    for (const a of accepted) {
      const dx = a.x - c.x;
      const dz = a.z - c.z;
      if (dx * dx + dz * dz < minDist2) {
        blocked = true;
        break;
      }
    }
    if (!blocked) accepted.push(c);
  }
  return accepted;
}

export function signalCandidateScore(x: number, z: number, arms: number, maxClass: number, maxLanes: number): number {
  const downtown = x > 1700 && x < 5200 && z > -900 && z < 2600 ? 1 : 0;
  const somaMission = x > 1200 && x < 4300 && z >= 1800 && z < 4300 ? 0.55 : 0;
  const denseCore = Math.max(downtown, somaMission);
  const armScore = arms >= 4 ? 0.24 : 0.08;
  const classScore = Math.min(1, maxClass / 4) * 0.2;
  const laneScore = Math.min(1, maxLanes / 4) * 0.12;
  const base = 0.16 + denseCore * 0.44 + armScore + classScore + laneScore;
  const p = Math.max(0.18, Math.min(denseCore > 0.5 ? 0.94 : 0.62, base));
  if (hash01(x + 19.7, z - 41.3) > p) return -1;
  return p + arms * 0.03 + maxClass * 0.035 + denseCore * 0.25;
}
