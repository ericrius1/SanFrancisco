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

function approachKey(segId: number, dir: 1 | -1): string {
  return `${segId}:${dir}`;
}

export class TrafficSignalSystem {
  readonly signals: TrafficSignal[] = [];
  #byApproach = new Map<string, SignalApproach[]>();

  constructor(nodes: SignalNodeSeed[]) {
    for (const node of nodes) this.#addSignal(node);
    for (const list of this.#byApproach.values()) {
      list.sort((a, b) => (a.dir === 1 ? a.s - b.s : b.s - a.s));
    }
  }

  query(segId: number, s: number, dir: 1 | -1, timeS: number, range: number): SignalQuery {
    const list = this.#byApproach.get(approachKey(segId, dir));
    let best: SignalApproach | null = null;
    let bestD = range;
    if (list) {
      for (const a of list) {
        const d = dir === 1 ? a.s - s : s - a.s;
        if (d < -2) continue;
        if (d < bestD) {
          bestD = Math.max(0, d);
          best = a;
        }
        if (d > range) break;
      }
    }
    if (!best) {
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
    const signal = this.signals[best.signalId];
    const state = this.stateForAxis(signal, best.axis, timeS);
    return {
      hasSignal: true,
      signalId: best.signalId,
      distance: bestD,
      distanceN: Math.max(0, Math.min(1, bestD / range)),
      state,
      red: state === "red" ? 1 : 0,
      yellow: state === "yellow" ? 1 : 0,
      green: state === "green" ? 1 : 0,
      stopRequired: state !== "green"
    };
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
    for (const s of this.signals) {
      const dx = s.x - x;
      const dz = s.z - z;
      if (dx * dx + dz * dz <= r2) out.push(s);
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

  #addSignal(node: SignalNodeSeed): void {
    if (node.approaches.length < 3) return;
    const id = this.signals.length;
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
    this.signals.push(signal);
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
