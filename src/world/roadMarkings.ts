import * as THREE from "three/webgpu";
import { EXPOSURE_REBASE } from "../config";
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
// whole OSM polyline segment, often tens of metres). We PROBE the draped centre
// line finely (PROBE_STEP_M) but only KEEP a node where a straight chord across
// the terrain would drift from the ground by more than DRAPE_TOL_M — so flat
// streets collapse back to two nodes (one quad) while hills keep exactly the
// density the slope demands. Uniform 2.5m subdivision on every strip ballooned
// markings to ~1M tris for no visual gain.
//
// Probe step is decoupled from the (former, uniform) 2.5m emit step on purpose:
// a coarse 2.5m probe steps clean over sub-2.5m ground undulations (SF streets
// carry ~10cm bumps between hydro-flattened samples), leaving the chord to miss
// them. Probing at ~1.5m lets the greedy actually SEE those bends and drop a
// node on them, so the adaptive strip is flusher than the old dense one while
// still collapsing the long flat runs that dominate the triangle bill.
const PROBE_STEP_M = 1.0;
// Longitudinal chord tolerance for the adaptive keep-test: insert an interior
// node once the piecewise-linear reconstruction of the draped centre line would
// err past this. Kept well under the decal's own 2.5cm lift so the marking never
// visibly lifts off or sinks into a slope.
const DRAPE_TOL_M = 0.045;

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
  // Authored against the reference exposure (toneMapped=false is a no-op here —
  // the render pipeline tone-maps in its output pass, not per material), so the
  // paint rebases with the rest of the unlit world (config.EXPOSURE_REBASE).
  mat.color.multiplyScalar(EXPOSURE_REBASE);
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

  // Probe the offset centre line at PROBE_STEP_M resolution, then greedily keep
  // only the nodes the terrain actually needs: a node survives when a straight
  // chord from the previous kept node would miss the draped ground by more than
  // DRAPE_TOL_M at some sample in between (a Douglas-Peucker-style walk along the
  // strip). Flat streets keep just the two endpoints; hills keep their bends.
  const fine = Math.max(1, Math.ceil(len / PROBE_STEP_M));
  // Draped centre-line height at each fine probe — the curvature signal that
  // drives subdivision. (Edges are re-draped per kept node below for camber.)
  const h = new Float64Array(fine + 1);
  for (let k = 0; k <= fine; k++) {
    const t = k / fine;
    h[k] = map.effectiveGround(ax + dx * t + nx * offset, az + dz * t + nz * offset);
  }
  // Greedy chord simplification over the fine probes → indices to keep.
  const keep: number[] = [0];
  let anchor = 0;
  let cand = 2;
  while (cand <= fine) {
    let ok = true;
    const h0 = h[anchor];
    const slope = (h[cand] - h0) / (cand - anchor);
    for (let j = anchor + 1; j < cand; j++) {
      if (Math.abs(h0 + slope * (j - anchor) - h[j]) > DRAPE_TOL_M) { ok = false; break; }
    }
    if (ok) {
      cand++;
    } else {
      keep.push(cand - 1);
      anchor = cand - 1;
      cand = anchor + 2;
    }
  }
  if (keep[keep.length - 1] !== fine) keep.push(fine);

  // Emit one quad per kept span. Both edges of every kept node are draped
  // independently, so the strip still follows the street's cross-camber and each
  // corner sits exactly LIFT_M above the road it covers.
  const nodeAt = (idx: number) => {
    const t = idx / fine;
    const ncx = ax + dx * t + nx * offset;
    const ncz = az + dz * t + nz * offset;
    const lx = ncx - wx, lz = ncz - wz;
    const rx = ncx + wx, rz = ncz + wz;
    return { lx, lz, ly: map.effectiveGround(lx, lz) + LIFT_M, rx, rz, ry: map.effectiveGround(rx, rz) + LIFT_M };
  };
  let prev = nodeAt(keep[0]);
  for (let n = 1; n < keep.length; n++) {
    const cur = nodeAt(keep[n]);
    out.push(
      prev.lx, prev.ly, prev.lz,
      cur.lx, cur.ly, cur.lz,
      cur.rx, cur.ry, cur.rz,
      prev.lx, prev.ly, prev.lz,
      cur.rx, cur.ry, cur.rz,
      prev.rx, prev.ry, prev.rz
    );
    prev = cur;
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
