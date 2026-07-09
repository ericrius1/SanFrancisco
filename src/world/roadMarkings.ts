import * as THREE from "three/webgpu";
import type { WorldMap } from "./heightmap";

type RoadsJson = {
  v: number;
  segs: RoadSegmentJson[];
};

type RoadSegmentJson = {
  p: number[];
  w: number;
  l?: number;
  d?: number;
  k?: number;
  f?: number;
  b?: number;
};

const ROAD_MARKING_VERSION = 3;
const Y_OFFSET = 0.45;
const EDGE_INSET = 0.55;
const DASH_M = 4.6;
const GAP_M = 6.4;
const MIN_EDGE_M = 0.4;
const WHITE_W = 0.52;
const YELLOW_W = 0.62;

const whiteMat = new THREE.MeshBasicNodeMaterial({
  color: 0xffffff,
  depthWrite: false,
  opacity: 0.96,
  side: THREE.DoubleSide
});

const yellowMat = new THREE.MeshBasicNodeMaterial({
  color: 0xffcc33,
  depthWrite: false,
  opacity: 0.98,
  side: THREE.DoubleSide
});

whiteMat.transparent = true;
yellowMat.transparent = true;
whiteMat.toneMapped = false;
yellowMat.toneMapped = false;

function clampLaneCount(n: number, fallback: number): number {
  return Math.max(1, Math.min(8, Math.round(Number.isFinite(n) ? n : fallback)));
}

function pushStrip(
  out: number[],
  map: WorldMap,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  offset: number,
  width: number
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < MIN_EDGE_M) return;
  const nx = -dz / len;
  const nz = dx / len;

  const aCx = ax + nx * offset;
  const aCz = az + nz * offset;
  const bCx = bx + nx * offset;
  const bCz = bz + nz * offset;
  const ay = map.effectiveGround(aCx, aCz) + Y_OFFSET;
  const by = map.effectiveGround(bCx, bCz) + Y_OFFSET;
  const wx = nx * width * 0.5;
  const wz = nz * width * 0.5;

  out.push(
    aCx - wx, ay, aCz - wz,
    bCx - wx, by, bCz - wz,
    bCx + wx, by, bCz + wz,
    aCx - wx, ay, aCz - wz,
    bCx + wx, by, bCz + wz,
    aCx + wx, ay, aCz + wz
  );
}

function pushDashedLine(
  out: number[],
  map: WorldMap,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  offset: number,
  phase: number,
  width: number
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < MIN_EDGE_M) return phase;
  const cycle = DASH_M + GAP_M;
  const startPhase = ((phase % cycle) + cycle) % cycle;
  const emitDash = (from: number, to: number) => {
    if (to - from < MIN_EDGE_M) return;
    const t0 = from / len;
    const t1 = to / len;
    pushStrip(
      out,
      map,
      ax + dx * t0,
      az + dz * t0,
      ax + dx * t1,
      az + dz * t1,
      offset,
      width
    );
  };

  let d: number;
  if (startPhase < DASH_M) {
    const firstEnd = Math.min(DASH_M - startPhase, len);
    emitDash(0, firstEnd);
    d = firstEnd + GAP_M;
  } else {
    d = cycle - startPhase;
  }

  for (; d < len; d += cycle) {
    emitDash(d, Math.min(d + DASH_M, len));
  }
  return ((phase + len) % cycle + cycle) % cycle;
}

function addRoadLines(seg: RoadSegmentJson, map: WorldMap, white: number[], yellow: number[]): void {
  const points = seg.p;
  if (points.length < 4) return;
  const laneCount = clampLaneCount(seg.l ?? seg.w / 4, Math.max(1, seg.w / 4));
  const oneWay = seg.d === 1 || seg.d === -1;
  const usableW = Math.max(3.2, seg.w - EDGE_INSET * 2);
  const whiteOffsets: number[] = [];
  let drawYellow = false;

  if (oneWay) {
    if (laneCount <= 1) {
      whiteOffsets.push(0);
    } else {
      const laneW = usableW / laneCount;
      for (let i = 1; i < laneCount; i++) whiteOffsets.push(-usableW * 0.5 + laneW * i);
    }
  } else {
    drawYellow = true;
    const forward = clampLaneCount(seg.f ?? Math.ceil(laneCount / 2), Math.ceil(laneCount / 2));
    const backward = clampLaneCount(seg.b ?? Math.max(1, laneCount - forward), Math.max(1, laneCount - forward));
    const total = Math.max(2, forward + backward);
    const laneW = usableW / total;
    for (let i = 1; i < forward; i++) whiteOffsets.push(-laneW * i);
    for (let i = 1; i < backward; i++) whiteOffsets.push(laneW * i);
  }

  const phases = whiteOffsets.map((_, i) => (i * 3.7) % (DASH_M + GAP_M));
  for (let i = 0; i < points.length - 2; i += 2) {
    const ax = points[i] / 10;
    const az = points[i + 1] / 10;
    const bx = points[i + 2] / 10;
    const bz = points[i + 3] / 10;
    if (drawYellow) pushStrip(yellow, map, ax, az, bx, bz, 0, YELLOW_W);
    for (let j = 0; j < whiteOffsets.length; j++) {
      phases[j] = pushDashedLine(white, map, ax, az, bx, bz, whiteOffsets[j], phases[j], WHITE_W);
    }
  }
}

function meshFromPositions(name: string, positions: number[], mat: THREE.Material): THREE.Mesh | null {
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.renderOrder = 20;
  mesh.frustumCulled = true;
  return mesh;
}

export async function createRoadMarkings(scene: THREE.Scene, map: WorldMap, url = "/data/roads.json"): Promise<THREE.Group> {
  const existing = scene.getObjectByName("RoadMarkings");
  if (existing instanceof THREE.Group) return existing;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`RoadMarkings: failed to load ${url} (${res.status})`);
  const json = (await res.json()) as RoadsJson;
  if (json.v !== ROAD_MARKING_VERSION) {
    throw new Error(`RoadMarkings: expected roads schema v${ROAD_MARKING_VERSION}, got v${json.v}`);
  }

  const white: number[] = [];
  const yellow: number[] = [];
  for (const seg of json.segs) addRoadLines(seg, map, white, yellow);

  const group = new THREE.Group();
  group.name = "RoadMarkings";
  const yellowMesh = meshFromPositions("RoadMarkingsYellow", yellow, yellowMat);
  const whiteMesh = meshFromPositions("RoadMarkingsWhite", white, whiteMat);
  if (yellowMesh) group.add(yellowMesh);
  if (whiteMesh) group.add(whiteMesh);
  scene.add(group);
  return group;
}
