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
// Decal lift: sit a hair above the asphalt only to defeat coincident-plane
// z-fighting. The heavy lifting is done by depthWrite:false + polygonOffset, so
// this can stay tiny — a couple of cm keeps the marking glued to the road and
// far below the avatar's body, so it can never plane through the player the way
// the old 45cm lift did (the quad floated up to shin height on slopes).
const LIFT_M = 0.025;
const EDGE_INSET = 0.55;
const DASH_M = 4.6;
const GAP_M = 6.4;
const MIN_EDGE_M = 0.4;
const WHITE_W = 0.52;
const YELLOW_W = 0.62;
// Re-drape long strips: sampling ground only at a strip's endpoints lets it
// float above convex hills or sink into valleys (the yellow centre line runs a
// whole OSM polyline segment, often tens of metres). Subdivide so every node
// re-samples effectiveGround and the quad hugs the terrain-conformed road.
const DRAPE_STEP_M = 2.5;

function makeMarkingMaterial(colorHex: number, opacity: number): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    color: colorHex,
    depthWrite: false,
    opacity,
    side: THREE.DoubleSide
  });
  mat.transparent = true;
  mat.toneMapped = false;
  // True decal: bias the depth test toward the camera so the marking wins
  // against the coincident road surface without any physical lift, and never
  // z-fights the asphalt on a slope.
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;
  return mat;
}

const whiteMat = makeMarkingMaterial(0xffffff, 0.96);
const yellowMat = makeMarkingMaterial(0xffcc33, 0.98);

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
  const wx = nx * width * 0.5;
  const wz = nz * width * 0.5;

  // Walk the offset centre line, re-sampling the road height at each node so the
  // ribbon conforms to sloped/curved streets instead of chording across them.
  // Both the left and right edge of every node are draped independently, so the
  // strip also follows the street's cross-camber and each corner sits exactly
  // LIFT_M above the road it covers (a single centre sample would let the edges
  // float or dip a few cm on a canted street).
  const steps = Math.max(1, Math.ceil(len / DRAPE_STEP_M));
  const cx = ax + nx * offset;
  const cz = az + nz * offset;
  let plx = cx - wx, plz = cz - wz;
  let prx = cx + wx, prz = cz + wz;
  let ply = map.effectiveGround(plx, plz) + LIFT_M;
  let pry = map.effectiveGround(prx, prz) + LIFT_M;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const ncx = ax + dx * t + nx * offset;
    const ncz = az + dz * t + nz * offset;
    const qlx = ncx - wx, qlz = ncz - wz;
    const qrx = ncx + wx, qrz = ncz + wz;
    const qly = map.effectiveGround(qlx, qlz) + LIFT_M;
    const qry = map.effectiveGround(qrx, qrz) + LIFT_M;

    out.push(
      plx, ply, plz,
      qlx, qly, qlz,
      qrx, qry, qrz,
      plx, ply, plz,
      qrx, qry, qrz,
      prx, pry, prz
    );

    plx = qlx; plz = qlz; ply = qly;
    prx = qrx; prz = qrz; pry = qry;
  }
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
  // Draw after the road surface (renderOrder 0) so the decal composites on top.
  mesh.renderOrder = 20;
  mesh.frustumCulled = true;
  // Paint should take the road's shadow but never cast one of its own. (The
  // MeshBasicNodeMaterial does not sample lighting, so receiveShadow is intent
  // only; if shadowed markings ever read too bright, switch to a Standard/lit
  // decal material — see report.)
  mesh.castShadow = false;
  mesh.receiveShadow = true;
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
