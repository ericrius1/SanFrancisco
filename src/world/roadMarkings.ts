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
// MUST match build_tile_roads in tools/blender_city.py. Asphalt is baked from
// raw terrain at <=12m centerline samples, lifted 30cm, and held flat across
// the road width. It is not the runtime groundTop grid.
const ROAD_LIFT_M = 0.3;
const ROAD_MIN_H = 0.15;
const ROAD_SUBSTEP_M = 12;
// prepare-city splits long OSM edges before the Blender bake. Repeating that
// split preserves the exact sample cadence and piecewise-linear road profile.
const ROAD_BAKE_SPLIT_M = 200;
const MARKING_LIFT_M = 0.025;
const EDGE_INSET = 0.55;
const DASH_M = 4.6;
const GAP_M = 6.4;
const MIN_EDGE_M = 0.4;
const WHITE_W = 0.52;
const YELLOW_W = 0.62;

function makeMarkingMaterial(colorHex: number, opacity: number): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    color: colorHex,
    side: THREE.DoubleSide
  });
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
  // Preserve the old slightly weathered value in the colour itself. Nearly
  // opaque blending made the paint depend on transparent-pass ordering; opaque
  // depth writes make every accepted marking pixel stable.
  mat.color.multiplyScalar(EXPOSURE_REBASE * opacity);
  return mat;
}

const whiteMat = makeMarkingMaterial(0xffffff, 0.96);
const yellowMat = makeMarkingMaterial(0xffcc33, 0.98);

function clampLaneCount(n: number, fallback: number): number {
  return Math.max(1, Math.min(8, Math.round(Number.isFinite(n) ? n : fallback)));
}

type RoadProfileNode = { d: number; y: number };
type RoadProfile = {
  ax: number;
  az: number;
  ux: number;
  uz: number;
  nx: number;
  nz: number;
  len: number;
  nodes: RoadProfileNode[];
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

function bakedRoadY(map: WorldMap, x: number, z: number): number {
  return Math.max(map.groundHeight(x, z), ROAD_MIN_H) + ROAD_LIFT_M;
}

/** Reconstruct the longitudinal height samples used by the asphalt bake. */
function buildRoadProfile(map: WorldMap, ax: number, az: number, bx: number, bz: number): RoadProfile | null {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < MIN_EDGE_M) return null;
  const ux = dx / len, uz = dz / len;
  const nodes: RoadProfileNode[] = [];
  const bakeSplits = Math.max(1, Math.ceil(len / ROAD_BAKE_SPLIT_M));

  for (let split = 0; split < bakeSplits; split++) {
    const t0 = split / bakeSplits;
    const t1 = (split + 1) / bakeSplits;
    const sax = round1(ax + dx * t0), saz = round1(az + dz * t0);
    const sbx = round1(ax + dx * t1), sbz = round1(az + dz * t1);
    const sdx = sbx - sax, sdz = sbz - saz;
    const substeps = Math.max(1, Math.ceil(Math.hypot(sdx, sdz) / ROAD_SUBSTEP_M));
    for (let step = split === 0 ? 0 : 1; step <= substeps; step++) {
      const t = step / substeps;
      const x = sax + sdx * t;
      const z = saz + sdz * t;
      const d = THREE.MathUtils.clamp((x - ax) * ux + (z - az) * uz, 0, len);
      const y = bakedRoadY(map, x, z);
      const prev = nodes[nodes.length - 1];
      if (prev && d - prev.d < 1e-5) prev.y = y;
      else nodes.push({ d, y });
    }
  }
  nodes[0].d = 0;
  nodes[nodes.length - 1].d = len;
  return { ax, az, ux, uz, nx: -uz, nz: ux, len, nodes };
}

function profilePoint(profile: RoadProfile, d: number): { x: number; y: number; z: number } {
  d = THREE.MathUtils.clamp(d, 0, profile.len);
  const nodes = profile.nodes;
  let hi = 1;
  while (hi < nodes.length && nodes[hi].d < d) hi++;
  if (hi >= nodes.length) hi = nodes.length - 1;
  const lo = Math.max(0, hi - 1);
  const span = nodes[hi].d - nodes[lo].d;
  const t = span > 1e-6 ? (d - nodes[lo].d) / span : 0;
  return {
    x: profile.ax + profile.ux * d,
    y: THREE.MathUtils.lerp(nodes[lo].y, nodes[hi].y, t) + MARKING_LIFT_M,
    z: profile.az + profile.uz * d
  };
}

function pushProfileSpan(
  out: number[],
  profile: RoadProfile,
  from: number,
  to: number,
  offset: number,
  width: number
): void {
  if (to - from < MIN_EDGE_M) return;
  const distances = [from];
  for (const node of profile.nodes) {
    if (node.d > from + 1e-5 && node.d < to - 1e-5) distances.push(node.d);
  }
  distances.push(to);
  const lateralL = offset - width * 0.5;
  const lateralR = offset + width * 0.5;
  let prev = profilePoint(profile, distances[0]);
  for (let n = 1; n < distances.length; n++) {
    const cur = profilePoint(profile, distances[n]);
    out.push(
      prev.x + profile.nx * lateralL, prev.y, prev.z + profile.nz * lateralL,
      cur.x + profile.nx * lateralL, cur.y, cur.z + profile.nz * lateralL,
      cur.x + profile.nx * lateralR, cur.y, cur.z + profile.nz * lateralR,
      prev.x + profile.nx * lateralL, prev.y, prev.z + profile.nz * lateralL,
      cur.x + profile.nx * lateralR, cur.y, cur.z + profile.nz * lateralR,
      prev.x + profile.nx * lateralR, prev.y, prev.z + profile.nz * lateralR
    );
    prev = cur;
  }
}

/** Fill the bevel at a polyline node. Solid yellow always joins; a dashed white
 * line joins only when its dash phase actually crosses the node. */
function pushJoin(
  out: number[],
  map: WorldMap,
  ax: number,
  az: number,
  px: number,
  pz: number,
  bx: number,
  bz: number,
  offset: number,
  width: number
): void {
  const adx = px - ax, adz = pz - az;
  const bdx = bx - px, bdz = bz - pz;
  const al = Math.hypot(adx, adz), bl = Math.hypot(bdx, bdz);
  if (al < MIN_EDGE_M || bl < MIN_EDGE_M) return;
  const anx = -adz / al, anz = adx / al;
  const bnx = -bdz / bl, bnz = bdx / bl;
  if (Math.hypot(anx - bnx, anz - bnz) < 1e-4 || (adx * bdx + adz * bdz) / (al * bl) < -0.9) return;
  const hw = width * 0.5;
  const alx = px + anx * (offset - hw), alz = pz + anz * (offset - hw);
  const arx = px + anx * (offset + hw), arz = pz + anz * (offset + hw);
  const blx = px + bnx * (offset - hw), blz = pz + bnz * (offset - hw);
  const brx = px + bnx * (offset + hw), brz = pz + bnz * (offset + hw);
  const y = bakedRoadY(map, px, pz) + MARKING_LIFT_M;
  out.push(
    alx, y, alz,
    blx, y, blz,
    brx, y, brz,
    alx, y, alz,
    brx, y, brz,
    arx, y, arz
  );
}

function pushDashedLine(
  out: number[],
  profile: RoadProfile,
  offset: number,
  phase: number,
  width: number
): number {
  const len = profile.len;
  const cycle = DASH_M + GAP_M;
  const startPhase = ((phase % cycle) + cycle) % cycle;
  const emitDash = (from: number, to: number) => {
    if (to - from < MIN_EDGE_M) return;
    pushProfileSpan(out, profile, from, to, offset, width);
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
    const profile = buildRoadProfile(map, ax, az, bx, bz);
    if (!profile) continue;
    if (drawYellow) pushProfileSpan(yellow, profile, 0, profile.len, 0, YELLOW_W);
    for (let j = 0; j < whiteOffsets.length; j++) {
      phases[j] = pushDashedLine(white, profile, whiteOffsets[j], phases[j], WHITE_W);
    }

    // The next OSM edge starts at (bx,bz). Fill only markings that continue
    // through that node; deliberate dash gaps remain untouched.
    if (i + 4 < points.length) {
      const nx = points[i + 4] / 10;
      const nz = points[i + 5] / 10;
      if (drawYellow) pushJoin(yellow, map, ax, az, bx, bz, nx, nz, 0, YELLOW_W);
      for (let j = 0; j < whiteOffsets.length; j++) {
        if (phases[j] > 1e-4 && phases[j] < DASH_M - 1e-4) {
          pushJoin(white, map, ax, az, bx, bz, nx, nz, whiteOffsets[j], WHITE_W);
        }
      }
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
