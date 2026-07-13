import {
  TrafficSignalSystem,
  chooseSignalNodes,
  signalCandidateScore,
  type SignalApproachSeed,
  type SignalNodeSeed,
  type TrafficSignalSystemSnapshot
} from "./trafficSignals.ts";

export type RoadSegmentJson = {
  p: number[];
  w: number;
  l?: number;
  d?: number;
  k?: number;
  f?: number;
  b?: number;
};

export type RoadsJson = {
  v: number;
  segs: RoadSegmentJson[];
};

export type PackedRoadCellIndex = {
  minCx: number;
  minCz: number;
  width: number;
  height: number;
  slots: Int16Array | Int32Array;
  starts: Uint32Array;
  members: Uint32Array;
};

/** Fully preprocessed, read-only road-network state. All O(points/edges)
 * construction happens before this snapshot crosses the worker boundary. */
export type RoadGraphSnapshot = {
  version: 1;
  segCount: number;
  px: Float32Array;
  pz: Float32Array;
  ptSeg: Int32Array;
  cum: Float32Array;
  segStart: Int32Array;
  segNum: Int32Array;
  segTotal: Float32Array;
  segW: Float32Array;
  segLanes: Int8Array;
  segForwardLanes: Int8Array;
  segBackwardLanes: Int8Array;
  segDir: Int8Array;
  segClass: Int8Array;
  edgeCells: PackedRoadCellIndex;
  endCells: PackedRoadCellIndex;
  endX: Float32Array;
  endZ: Float32Array;
  endSeg: Int32Array;
  endWhich: Int8Array;
  signalSystem: TrafficSignalSystemSnapshot;
};

export const ROAD_GRAPH_CELL = 64;
const SIGNAL_CELL = 12;
const ARM_EPS = Math.PI * 0.16;

export function roadGraphCellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}

export function packedRoadCellSlot(index: PackedRoadCellIndex, cx: number, cz: number): number {
  const x = cx - index.minCx;
  const z = cz - index.minCz;
  if (x < 0 || z < 0 || x >= index.width || z >= index.height) return -1;
  return index.slots[z * index.width + x];
}

function signalKey(x: number, z: number): number {
  return (Math.round(x / SIGNAL_CELL) + 4096) * 8192 + (Math.round(z / SIGNAL_CELL) + 4096);
}

function angleDiff(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function packCellIndex(cells: Map<number, number[]>): PackedRoadCellIndex {
  const entries = [...cells.entries()].sort((a, b) => a[0] - b[0]);
  const starts = new Uint32Array(entries.length + 1);
  let minCx = Infinity;
  let maxCx = -Infinity;
  let minCz = Infinity;
  let maxCz = -Infinity;
  let memberCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    const cx = Math.floor(key / 8192) - 4096;
    const cz = key % 8192 - 4096;
    minCx = Math.min(minCx, cx);
    maxCx = Math.max(maxCx, cx);
    minCz = Math.min(minCz, cz);
    maxCz = Math.max(maxCz, cz);
    starts[i] = memberCount;
    memberCount += entries[i][1].length;
  }
  starts[entries.length] = memberCount;
  if (entries.length === 0) {
    return {
      minCx: 0,
      minCz: 0,
      width: 0,
      height: 0,
      slots: new Int16Array(0),
      starts,
      members: new Uint32Array(0)
    };
  }

  const width = maxCx - minCx + 1;
  const height = maxCz - minCz + 1;
  const slots = entries.length <= 0x7fff
    ? new Int16Array(width * height)
    : new Int32Array(width * height);
  slots.fill(-1);
  const members = new Uint32Array(memberCount);
  let cursor = 0;
  for (let slot = 0; slot < entries.length; slot++) {
    const [key, list] = entries[slot];
    const cx = Math.floor(key / 8192) - 4096;
    const cz = key % 8192 - 4096;
    slots[(cz - minCz) * width + cx - minCx] = slot;
    members.set(list, cursor);
    cursor += list.length;
  }
  return { minCx, minCz, width, height, slots, starts, members };
}

function buildSignalNodes(snapshot: {
  segCount: number;
  px: Float32Array;
  pz: Float32Array;
  cum: Float32Array;
  segStart: Int32Array;
  segNum: Int32Array;
  segW: Float32Array;
  segLanes: Int8Array;
  segDir: Int8Array;
  segClass: Int8Array;
}): SignalNodeSeed[] {
  const groups = new Map<number, { sx: number; sz: number; n: number; approaches: SignalApproachSeed[] }>();
  const add = (x: number, z: number, app: SignalApproachSeed) => {
    const key = signalKey(x, z);
    let group = groups.get(key);
    if (!group) {
      group = { sx: 0, sz: 0, n: 0, approaches: [] };
      groups.set(key, group);
    }
    group.sx += x;
    group.sz += z;
    group.n++;
    group.approaches.push(app);
  };

  for (let seg = 0; seg < snapshot.segCount; seg++) {
    if (snapshot.segClass[seg] >= 5) continue;
    const g0 = snapshot.segStart[seg];
    const n = snapshot.segNum[seg];
    const oneWay = snapshot.segDir[seg];
    for (let i = 0; i < n; i++) {
      const g = g0 + i;
      const x = snapshot.px[g];
      const z = snapshot.pz[g];
      const s = snapshot.cum[g];
      if (i > 0 && oneWay !== -1) {
        const pg = g - 1;
        let tx = snapshot.px[g] - snapshot.px[pg];
        let tz = snapshot.pz[g] - snapshot.pz[pg];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        add(x, z, {
          segId: seg,
          s,
          dir: 1,
          x,
          z,
          tangentX: tx,
          tangentZ: tz,
          roadClass: snapshot.segClass[seg],
          lanes: snapshot.segLanes[seg],
          halfWidth: snapshot.segW[seg] * 0.5
        });
      }
      if (i < n - 1 && oneWay !== 1) {
        const ng = g + 1;
        let tx = snapshot.px[g] - snapshot.px[ng];
        let tz = snapshot.pz[g] - snapshot.pz[ng];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        add(x, z, {
          segId: seg,
          s,
          dir: -1,
          x,
          z,
          tangentX: tx,
          tangentZ: tz,
          roadClass: snapshot.segClass[seg],
          lanes: snapshot.segLanes[seg],
          halfWidth: snapshot.segW[seg] * 0.5
        });
      }
    }
  }

  const candidates: SignalNodeSeed[] = [];
  for (const group of groups.values()) {
    if (group.approaches.length < 3) continue;
    const angles: number[] = [];
    let maxClass = 0;
    let maxLanes = 1;
    const seen = new Set<string>();
    const approaches: SignalApproachSeed[] = [];
    for (const app of group.approaches) {
      const id = `${app.segId}:${app.dir}`;
      if (seen.has(id)) continue;
      seen.add(id);
      approaches.push(app);
      maxClass = Math.max(maxClass, app.roadClass);
      maxLanes = Math.max(maxLanes, app.lanes);
      const angle = Math.atan2(app.tangentX, app.tangentZ);
      let fresh = true;
      for (const previous of angles) {
        if (angleDiff(angle, previous) < ARM_EPS) {
          fresh = false;
          break;
        }
      }
      if (fresh) angles.push(angle);
    }
    if (angles.length < 3) continue;
    const x = group.sx / group.n;
    const z = group.sz / group.n;
    const score = signalCandidateScore(x, z, angles.length, maxClass, maxLanes);
    if (score < 0) continue;
    candidates.push({ x, z, score, approaches });
  }
  return chooseSignalNodes(candidates);
}

export function buildRoadGraphSnapshot(json: RoadsJson): RoadGraphSnapshot {
  const segs = json.segs;
  const segCount = segs.length;
  let pointCount = 0;
  for (const segment of segs) pointCount += segment.p.length / 2;

  const px = new Float32Array(pointCount);
  const pz = new Float32Array(pointCount);
  const ptSeg = new Int32Array(pointCount);
  const cum = new Float32Array(pointCount);
  const segStart = new Int32Array(segCount);
  const segNum = new Int32Array(segCount);
  const segTotal = new Float32Array(segCount);
  const segW = new Float32Array(segCount);
  const segLanes = new Int8Array(segCount);
  const segForwardLanes = new Int8Array(segCount);
  const segBackwardLanes = new Int8Array(segCount);
  const segDir = new Int8Array(segCount);
  const segClass = new Int8Array(segCount);
  const endX = new Float32Array(segCount * 2);
  const endZ = new Float32Array(segCount * 2);
  const endSeg = new Int32Array(segCount * 2);
  const endWhich = new Int8Array(segCount * 2);

  let g = 0;
  for (let seg = 0; seg < segCount; seg++) {
    const segment = segs[seg];
    const points = segment.p;
    const n = points.length / 2;
    segStart[seg] = g;
    segNum[seg] = n;
    segW[seg] = segment.w;
    const lanes = Math.max(1, Math.min(8, Math.round(segment.l ?? Math.max(1, segment.w / 4))));
    const dir = segment.d === 1 ? 1 : segment.d === -1 ? -1 : 0;
    segLanes[seg] = lanes;
    segDir[seg] = dir;
    if (dir === 1) {
      segForwardLanes[seg] = lanes;
      segBackwardLanes[seg] = 0;
    } else if (dir === -1) {
      segForwardLanes[seg] = 0;
      segBackwardLanes[seg] = lanes;
    } else {
      let forward = Math.max(1, Math.min(8, Math.round(segment.f ?? Math.ceil(lanes / 2))));
      let backward = Math.max(1, Math.min(8, Math.round(segment.b ?? Math.max(1, lanes - forward))));
      while (forward + backward < lanes) {
        if (forward <= backward) forward++;
        else backward++;
      }
      while (forward + backward > lanes) {
        if (forward >= backward && forward > 1) forward--;
        else if (backward > 1) backward--;
        else break;
      }
      segForwardLanes[seg] = forward;
      segBackwardLanes[seg] = backward;
    }
    segClass[seg] = Math.max(0, Math.min(5, Math.round(segment.k ?? (segment.w >= 14 ? 4 : segment.w >= 10 ? 3 : 1))));

    let acc = 0;
    for (let i = 0; i < n; i++) {
      const x = points[i * 2] / 10;
      const z = points[i * 2 + 1] / 10;
      px[g] = x;
      pz[g] = z;
      ptSeg[g] = seg;
      if (i > 0) acc += Math.hypot(x - px[g - 1], z - pz[g - 1]);
      cum[g] = acc;
      g++;
    }
    segTotal[seg] = acc;
    const g0 = segStart[seg];
    const g1 = g0 + n - 1;
    endX[seg * 2] = px[g0];
    endZ[seg * 2] = pz[g0];
    endSeg[seg * 2] = seg;
    endWhich[seg * 2] = 0;
    endX[seg * 2 + 1] = px[g1];
    endZ[seg * 2 + 1] = pz[g1];
    endSeg[seg * 2 + 1] = seg;
    endWhich[seg * 2 + 1] = 1;
  }

  const edgeCellLists = new Map<number, number[]>();
  for (let seg = 0; seg < segCount; seg++) {
    const g0 = segStart[seg];
    const n = segNum[seg];
    for (let i = 0; i < n - 1; i++) {
      const edge = g0 + i;
      const cxMin = Math.floor(Math.min(px[edge], px[edge + 1]) / ROAD_GRAPH_CELL);
      const cxMax = Math.floor(Math.max(px[edge], px[edge + 1]) / ROAD_GRAPH_CELL);
      const czMin = Math.floor(Math.min(pz[edge], pz[edge + 1]) / ROAD_GRAPH_CELL);
      const czMax = Math.floor(Math.max(pz[edge], pz[edge + 1]) / ROAD_GRAPH_CELL);
      for (let cx = cxMin; cx <= cxMax; cx++) {
        for (let cz = czMin; cz <= czMax; cz++) {
          const key = roadGraphCellKey(cx, cz);
          let list = edgeCellLists.get(key);
          if (!list) {
            list = [];
            edgeCellLists.set(key, list);
          }
          list.push(edge);
        }
      }
    }
  }

  const endCellLists = new Map<number, number[]>();
  for (let end = 0; end < endSeg.length; end++) {
    const cx = Math.floor(endX[end] / ROAD_GRAPH_CELL);
    const cz = Math.floor(endZ[end] / ROAD_GRAPH_CELL);
    const key = roadGraphCellKey(cx, cz);
    let list = endCellLists.get(key);
    if (!list) {
      list = [];
      endCellLists.set(key, list);
    }
    list.push(end);
  }

  const signalNodes = buildSignalNodes({
    segCount,
    px,
    pz,
    cum,
    segStart,
    segNum,
    segW,
    segLanes,
    segDir,
    segClass
  });
  const signalSystem = new TrafficSignalSystem(signalNodes).toSnapshot();

  return {
    version: 1,
    segCount,
    px,
    pz,
    ptSeg,
    cum,
    segStart,
    segNum,
    segTotal,
    segW,
    segLanes,
    segForwardLanes,
    segBackwardLanes,
    segDir,
    segClass,
    edgeCells: packCellIndex(edgeCellLists),
    endCells: packCellIndex(endCellLists),
    endX,
    endZ,
    endSeg,
    endWhich,
    signalSystem
  };
}

export function roadGraphSnapshotTransferList(snapshot: RoadGraphSnapshot): ArrayBuffer[] {
  return [
    snapshot.px.buffer as ArrayBuffer,
    snapshot.pz.buffer as ArrayBuffer,
    snapshot.ptSeg.buffer as ArrayBuffer,
    snapshot.cum.buffer as ArrayBuffer,
    snapshot.segStart.buffer as ArrayBuffer,
    snapshot.segNum.buffer as ArrayBuffer,
    snapshot.segTotal.buffer as ArrayBuffer,
    snapshot.segW.buffer as ArrayBuffer,
    snapshot.segLanes.buffer as ArrayBuffer,
    snapshot.segForwardLanes.buffer as ArrayBuffer,
    snapshot.segBackwardLanes.buffer as ArrayBuffer,
    snapshot.segDir.buffer as ArrayBuffer,
    snapshot.segClass.buffer as ArrayBuffer,
    snapshot.edgeCells.slots.buffer as ArrayBuffer,
    snapshot.edgeCells.starts.buffer as ArrayBuffer,
    snapshot.edgeCells.members.buffer as ArrayBuffer,
    snapshot.endCells.slots.buffer as ArrayBuffer,
    snapshot.endCells.starts.buffer as ArrayBuffer,
    snapshot.endCells.members.buffer as ArrayBuffer,
    snapshot.endX.buffer as ArrayBuffer,
    snapshot.endZ.buffer as ArrayBuffer,
    snapshot.endSeg.buffer as ArrayBuffer,
    snapshot.endWhich.buffer as ArrayBuffer,
    snapshot.signalSystem.signalValues.buffer as ArrayBuffer,
    snapshot.signalSystem.signalApproachStarts.buffer as ArrayBuffer,
    snapshot.signalSystem.approachSegIds.buffer as ArrayBuffer,
    snapshot.signalSystem.approachDirs.buffer as ArrayBuffer,
    snapshot.signalSystem.approachValues.buffer as ArrayBuffer,
    snapshot.signalSystem.approachRoadClasses.buffer as ArrayBuffer,
    snapshot.signalSystem.approachLanes.buffer as ArrayBuffer,
    snapshot.signalSystem.approachAxes.buffer as ArrayBuffer,
    snapshot.signalSystem.approachKeys.buffer as ArrayBuffer,
    snapshot.signalSystem.approachStarts.buffer as ArrayBuffer,
    snapshot.signalSystem.approachS.buffer as ArrayBuffer,
    snapshot.signalSystem.approachSignalIds.buffer as ArrayBuffer,
    snapshot.signalSystem.queryApproachAxes.buffer as ArrayBuffer
  ];
}

export function roadGraphSnapshotTransferBytes(snapshot: RoadGraphSnapshot): number {
  return roadGraphSnapshotTransferList(snapshot).reduce((sum, buffer) => sum + buffer.byteLength, 0);
}
