import * as THREE from "three/webgpu";
import type { WorldMap } from "./heightmap";

type Bridge = WorldMap["meta"]["bridges"][number];
type BridgePoint = Bridge["line"][number];

type Sample = {
  x: number;
  y: number;
  z: number;
  u: number;
  yaw: number;
  dirX: number;
  dirZ: number;
  perpX: number;
  perpZ: number;
};

type Rod = {
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
};

type BoxInstance = {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  length: number;
  yaw: number;
};

const INTERNATIONAL_ORANGE = 0xf04a2d;
const BRIDGE_SHADOW = 0x7d160f;
const CONCRETE = 0x8f8174;
const LANE_YELLOW = 0xffd05a;
const LANE_WHITE = 0xe8ece8;

const bridgeMat = new THREE.MeshStandardMaterial({
  color: INTERNATIONAL_ORANGE,
  roughness: 0.66,
  metalness: 0.14
});
const bridgeDarkMat = new THREE.MeshStandardMaterial({
  color: BRIDGE_SHADOW,
  roughness: 0.82,
  metalness: 0.04
});
const concreteMat = new THREE.MeshStandardMaterial({
  color: CONCRETE,
  roughness: 0.94,
  metalness: 0
});
const laneYellowMat = new THREE.MeshStandardMaterial({
  color: LANE_YELLOW,
  roughness: 0.78,
  metalness: 0
});
const laneWhiteMat = new THREE.MeshStandardMaterial({
  color: LANE_WHITE,
  roughness: 0.8,
  metalness: 0
});

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Visual-only path for the authored Golden Gate model.
 *
 * The metadata includes a low north-side road ramp used by the heightfield and
 * spawn logic. In the cinematic camera it reads as a second road on the water,
 * so the rendered bridge terminates at the north anchorage instead.
 */
export function goldenGateBridgeVisualLine(br: Bridge): BridgePoint[] {
  return br.name === "Golden Gate Bridge" ? br.line.slice(0, 4) : br.line;
}

function setBridgeShadows(mesh: THREE.Object3D) {
  const m = mesh as THREE.Mesh;
  if (m.isMesh) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  mesh.frustumCulled = false;
}

function addBox(
  group: THREE.Group,
  material: THREE.Material,
  name: string,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  length: number,
  yaw = 0
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), material);
  mesh.name = name;
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  setBridgeShadows(mesh);
  group.add(mesh);
  return mesh;
}

function pushBox(
  boxes: BoxInstance[],
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  length: number,
  yaw = 0
) {
  boxes.push({ x, y, z, width, height, length, yaw });
}

function addBoxBatch(group: THREE.Group, name: string, boxes: BoxInstance[], material: THREE.Material) {
  if (boxes.length === 0) return;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
  mesh.name = name;
  setBridgeShadows(mesh);

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    quat.setFromAxisAngle(UP, box.yaw);
    pos.set(box.x, box.y, box.z);
    scale.set(box.width, box.height, box.length);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
}

function addRoadSurface(group: THREE.Group, name: string, positions: number[], indices: number[], material: THREE.Material) {
  if (positions.length === 0) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  group.add(mesh);
}

function addDeckSideFascia(group: THREE.Group, name: string, samples: Sample[], halfWidth: number, material: THREE.Material) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const side of [-1, 1]) {
    const base = positions.length / 3;
    for (const p of samples) {
      const lateral = (halfWidth + 0.34) * side;
      positions.push(
        p.x + p.perpX * lateral, p.y + 0.36, p.z + p.perpZ * lateral,
        p.x + p.perpX * lateral, p.y - 0.95, p.z + p.perpZ * lateral
      );
    }
    for (let i = 0; i < samples.length - 1; i++) {
      const a = base + i * 2;
      indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }
  addRoadSurface(group, name, positions, indices, material);
}

function addCurbRibbon(group: THREE.Group, name: string, samples: Sample[], halfWidth: number, material: THREE.Material) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const side of [-1, 1]) {
    const base = positions.length / 3;
    const inner = (halfWidth - 0.32) * side;
    const outer = (halfWidth + 0.42) * side;
    for (const p of samples) {
      positions.push(
        p.x + p.perpX * inner, p.y + 1.08, p.z + p.perpZ * inner,
        p.x + p.perpX * outer, p.y + 1.08, p.z + p.perpZ * outer,
        p.x + p.perpX * outer, p.y + 0.18, p.z + p.perpZ * outer,
        p.x + p.perpX * inner, p.y + 0.18, p.z + p.perpZ * inner
      );
    }
    for (let i = 0; i < samples.length - 1; i++) {
      const a = base + i * 4;
      const b = a + 4;
      // top, outer wall, and inner wall. The bottom remains open so the curb
      // cannot read as another broad road slab from low water angles.
      indices.push(a, b, b + 1, a, b + 1, a + 1);
      indices.push(a + 1, b + 1, b + 2, a + 1, b + 2, a + 2);
      indices.push(a + 3, b + 3, b, a + 3, b, a);
    }
  }
  addRoadSurface(group, name, positions, indices, material);
}

function sampleLine(line: BridgePoint[], spacing: number): Sample[] {
  const segs: { a: BridgePoint; b: BridgePoint; len: number; u0: number }[] = [];
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len <= 0.001) continue;
    segs.push({ a, b, len, u0: total });
    total += len;
  }

  const out: Sample[] = [];
  for (const seg of segs) {
    const steps = Math.max(1, Math.ceil(seg.len / spacing));
    for (let i = 0; i <= steps; i++) {
      if (i === steps && seg !== segs[segs.length - 1]) continue;
      const t = i / steps;
      const x = seg.a[0] + (seg.b[0] - seg.a[0]) * t;
      const z = seg.a[1] + (seg.b[1] - seg.a[1]) * t;
      const y = seg.a[2] + (seg.b[2] - seg.a[2]) * t;
      const dx = seg.b[0] - seg.a[0];
      const dz = seg.b[1] - seg.a[1];
      const len = Math.hypot(dx, dz) || 1;
      const dirX = dx / len;
      const dirZ = dz / len;
      out.push({
        x,
        y,
        z,
        u: (seg.u0 + seg.len * t) / total,
        yaw: Math.atan2(dirX, dirZ),
        dirX,
        dirZ,
        perpX: dirZ,
        perpZ: -dirX
      });
    }
  }
  return out;
}

function nearestLinePose(line: BridgePoint[], x: number, z: number): Sample {
  let best: Sample | null = null;
  let bestD = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
    const px = a[0] + dx * t;
    const pz = a[1] + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestD) {
      const len = Math.sqrt(len2);
      const dirX = dx / len;
      const dirZ = dz / len;
      bestD = d;
      best = {
        x: px,
        z: pz,
        y: a[2] + (b[2] - a[2]) * t,
        u: 0,
        yaw: Math.atan2(dirX, dirZ),
        dirX,
        dirZ,
        perpX: dirZ,
        perpZ: -dirX
      };
    }
  }
  return best ?? {
    x,
    y: 66,
    z,
    u: 0,
    yaw: 0,
    dirX: 0,
    dirZ: 1,
    perpX: 1,
    perpZ: 0
  };
}

function offsetPoint(p: Sample, lateral: number, yOffset = 0) {
  return new THREE.Vector3(p.x + p.perpX * lateral, p.y + yOffset, p.z + p.perpZ * lateral);
}

function addRodBatch(group: THREE.Group, name: string, rods: Rod[], material: THREE.Material, radialSegments = 8) {
  if (rods.length === 0) return;
  const geometry = new THREE.CylinderGeometry(1, 1, 1, radialSegments, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, rods.length);
  mesh.name = name;
  setBridgeShadows(mesh);

  const matrix = new THREE.Matrix4();
  const mid = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (let i = 0; i < rods.length; i++) {
    const rod = rods[i];
    dir.subVectors(rod.b, rod.a);
    const len = dir.length();
    if (len <= 0.001) continue;
    mid.copy(rod.a).add(rod.b).multiplyScalar(0.5);
    quat.setFromUnitVectors(UP, dir.multiplyScalar(1 / len));
    scale.set(rod.radius, len, rod.radius);
    matrix.compose(mid, quat, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
}

function addDeck(
  group: THREE.Group,
  line: BridgePoint[],
  br: Bridge,
  roadMaterial: THREE.Material,
  trussRods: Rod[],
  railRods: Rod[]
) {
  const samples = sampleLine(line, 38);
  const deckSamples = sampleLine(line, 18);
  const halfWidth = br.width / 2;
  const roadWidth = br.width - 2.5;
  const trussEdge = halfWidth + 0.85;
  const roadPositions: number[] = [];
  const roadIndices: number[] = [];
  const centerDashBoxes: BoxInstance[] = [];
  const edgeDashBoxes: BoxInstance[] = [];

  for (const p of deckSamples) {
    const roadHalf = roadWidth * 0.5;
    roadPositions.push(
      p.x + p.perpX * roadHalf, p.y + 0.12, p.z + p.perpZ * roadHalf,
      p.x - p.perpX * roadHalf, p.y + 0.12, p.z - p.perpZ * roadHalf
    );
  }
  for (let i = 0; i < deckSamples.length - 1; i++) {
    const base = i * 2;
    roadIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    for (const side of [-1, 1]) {
      const topA = offsetPoint(a, trussEdge * side, -0.55);
      const topB = offsetPoint(b, trussEdge * side, -0.55);
      const lowA = offsetPoint(a, trussEdge * side, -5.2);
      const lowB = offsetPoint(b, trussEdge * side, -5.2);
      trussRods.push({ a: topA, b: topB, radius: 0.14 });
      if (i % 3 === 0) trussRods.push({ a: topA, b: lowB, radius: 0.075 });
      if (i % 6 === 0) trussRods.push({ a: lowA, b: topB, radius: 0.07 });
      railRods.push({ a: offsetPoint(a, halfWidth * side, 2.05), b: offsetPoint(b, halfWidth * side, 2.05), radius: 0.16 });
      railRods.push({ a: offsetPoint(a, (halfWidth - 1.3) * side, 1.45), b: offsetPoint(b, (halfWidth - 1.3) * side, 1.45), radius: 0.1 });
    }
  }

  for (let i = 1; i < samples.length - 1; i += 2) {
    const p = samples[i];
    pushBox(centerDashBoxes, p.x, p.y + 0.17, p.z, 0.34, 0.035, 11, p.yaw);
  }
  for (let i = 1; i < samples.length - 1; i += 4) {
    const p = samples[i];
    for (const side of [-1, 1]) {
      pushBox(
        edgeDashBoxes,
        p.x + p.perpX * (roadWidth * 0.39) * side,
        p.y + 0.18,
        p.z + p.perpZ * (roadWidth * 0.39) * side,
        0.2,
        0.03,
        8,
        p.yaw
      );
    }
  }

  addRoadSurface(group, "ggb_asphalt_surface", roadPositions, roadIndices, roadMaterial);
  addDeckSideFascia(group, "ggb_deck_side_fascia", deckSamples, halfWidth, bridgeMat);
  addCurbRibbon(group, "ggb_curb_ribbons", deckSamples, halfWidth, bridgeMat);
  addBoxBatch(group, "ggb_center_dashes", centerDashBoxes, laneYellowMat);
  addBoxBatch(group, "ggb_edge_dashes", edgeDashBoxes, laneWhiteMat);
}

function addTower(group: THREE.Group, line: BridgePoint[], br: Bridge, tx: number, tz: number) {
  const pose = nearestLinePose(line, tx, tz);
  const deckY = pose.y;
  const bottomY = -8;
  const towerTop = br.towerHeight;
  const legHeight = towerTop - bottomY;
  const legCenterY = (towerTop + bottomY) * 0.5;
  const halfWidth = br.width / 2;
  const legOffset = halfWidth + 5.2;
  const legWidth = 7.2;
  const legDepth = 14;
  const portalSpan = legOffset * 2 + legWidth;
  const dirX = pose.dirX;
  const dirZ = pose.dirZ;

  for (const side of [-1, 1]) {
    const x = tx + pose.perpX * legOffset * side;
    const z = tz + pose.perpZ * legOffset * side;
    addBox(group, bridgeMat, "ggb_tower_leg", x, legCenterY, z, legWidth, legHeight, legDepth, pose.yaw);
    addBox(group, bridgeDarkMat, "ggb_tower_inner_shadow", x - pose.perpX * side * 2.05, legCenterY + 8, z - pose.perpZ * side * 2.05, 1.1, legHeight * 0.78, legDepth + 0.35, pose.yaw);
    for (const face of [-1, 1]) {
      addBox(
        group,
        bridgeMat,
        "ggb_tower_rib",
        x + dirX * face * (legDepth * 0.5 + 0.22),
        legCenterY + 4,
        z + dirZ * face * (legDepth * 0.5 + 0.22),
        1.05,
        legHeight * 0.82,
        0.45,
        pose.yaw
      );
    }
    addBox(group, bridgeDarkMat, "ggb_tower_foot_shadow", x, deckY - 13.4, z, legWidth + 4.2, 9.5, legDepth + 4.2, pose.yaw);
  }

  const beamLevels = [
    { y: deckY + 27, h: 8.5 },
    { y: deckY + 79, h: 7.5 },
    { y: deckY + 132, h: 7.5 },
    { y: towerTop - 17, h: 9.5 }
  ];
  for (const level of beamLevels) {
    addBox(group, bridgeMat, "ggb_tower_crossbeam", tx, level.y, tz, portalSpan, level.h, legDepth + 2, pose.yaw);
    addBox(group, bridgeDarkMat, "ggb_tower_crossbeam_shadow", tx, level.y - level.h * 0.28, tz, portalSpan - 7, level.h * 0.38, legDepth + 2.4, pose.yaw);
  }

  addBox(group, bridgeMat, "ggb_tower_cap", tx, towerTop + 5.5, tz, portalSpan + 4.5, 7.5, legDepth + 5, pose.yaw);
  addBox(group, bridgeMat, "ggb_tower_crown", tx, towerTop + 12.8, tz, portalSpan * 0.42, 7.5, legDepth * 0.58, pose.yaw);
}

function addAnchors(group: THREE.Group, line: BridgePoint[], br: Bridge) {
  const first = nearestLinePose(line, line[0][0], line[0][1]);
  const lastRaw = line[line.length - 1];
  const last = nearestLinePose(line, lastRaw[0], lastRaw[1]);
  for (const p of [first, last]) {
    addBox(group, concreteMat, "ggb_anchor_block", p.x, p.y - 8.8, p.z, br.width + 20, 17, 28, p.yaw);
    addBox(group, bridgeMat, "ggb_anchor_trim", p.x, p.y + 3.5, p.z, br.width + 8, 5, 10, p.yaw);
  }
}

function addCables(
  group: THREE.Group,
  line: BridgePoint[],
  br: Bridge,
  map: WorldMap,
  cableRods: Rod[],
  suspenderRods: Rod[]
) {
  const halfWidth = br.width / 2;
  const cableOffset = halfWidth + 0.85;
  const first = line[0];
  const last = line[line.length - 1];
  const nodes = [
    { x: first[0], y: first[2] + 34, z: first[1] },
    ...br.towers.map(([x, z]) => ({ x, y: br.towerHeight + 2, z })),
    { x: last[0], y: last[2] + 34, z: last[1] }
  ];

  for (const side of [-1, 1]) {
    for (let spanIndex = 0; spanIndex < nodes.length - 1; spanIndex++) {
      const a = nodes[spanIndex];
      const b = nodes[spanIndex + 1];
      const pose = nearestLinePose(line, (a.x + b.x) * 0.5, (a.z + b.z) * 0.5);
      const ox = pose.perpX * cableOffset * side;
      const oz = pose.perpZ * cableOffset * side;
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      const sag = a.y > 120 && b.y > 120 ? Math.max(70, span * 0.092) : Math.max(24, span * 0.055);
      const steps = Math.max(12, Math.ceil(span / 34));
      let prev: THREE.Vector3 | null = null;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = a.x + (b.x - a.x) * t + ox;
        const z = a.z + (b.z - a.z) * t + oz;
        const y = a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t);
        const point = new THREE.Vector3(x, y, z);
        if (prev) cableRods.push({ a: prev, b: point, radius: 0.66 });
        prev = point;

        if (i > 0 && i < steps && i % 2 === 0) {
          const attachPose = nearestLinePose(line, x, z);
          const deckY = map.bridgeDeck(attachPose.x, attachPose.z);
          if (deckY > -Infinity && y > deckY + 13) {
            suspenderRods.push({
              a: offsetPoint(attachPose, (halfWidth + 0.42) * side, 1.92),
              b: new THREE.Vector3(x, y - 2.0, z),
              radius: 0.075
            });
          }
        }
      }
    }
  }
}

export function createGoldenGateBridge(map: WorldMap, roadMaterial: THREE.Material): THREE.Group | null {
  const br = map.meta.bridges.find((b) => b.name === "Golden Gate Bridge");
  if (!br) return null;

  const line = goldenGateBridgeVisualLine(br);
  const group = new THREE.Group();
  group.name = "golden_gate_bridge_clean";

  const trussRods: Rod[] = [];
  const railRods: Rod[] = [];
  const cableRods: Rod[] = [];
  const suspenderRods: Rod[] = [];

  addAnchors(group, line, br);
  addDeck(group, line, br, roadMaterial, trussRods, railRods);
  for (const [tx, tz] of br.towers) addTower(group, line, br, tx, tz);
  addCables(group, line, br, map, cableRods, suspenderRods);

  addRodBatch(group, "ggb_truss_rods", trussRods, bridgeMat, 6);
  addRodBatch(group, "ggb_rail_rods", railRods, bridgeMat, 6);
  addRodBatch(group, "ggb_main_cables", cableRods, bridgeMat, 10);
  addRodBatch(group, "ggb_suspenders", suspenderRods, bridgeDarkMat, 6);

  return group;
}
