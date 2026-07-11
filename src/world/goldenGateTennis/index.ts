import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import type { GroundTopOverlay, WorldMap } from "../heightmap";
import {
  DEFAULT_GAMEPLAY_COURT_REF,
  GOLDMAN_CLUBHOUSE_OUTLINE,
  GOLDMAN_COURTS,
  GOLDMAN_NORTHEAST_POD_OUTLINE,
  GOLDMAN_PATHS,
  GOLDMAN_SITE_OUTLINE,
  HIPPIE_HILL_OUTLINE,
  inGoldmanTennisSite,
  type GoldmanCourtRef,
  type GoldmanCourtSpec,
  type GoldmanPathSpec,
  type GoldmanPickleballCourtRef,
  type GoldmanXZ
} from "./layout";

export * from "./layout";

export type GoldmanCourtAnchor = {
  ref: GoldmanCourtRef;
  kind: GoldmanCourtSpec["kind"];
  name: string;
  x: number;
  y: number;
  z: number;
  /** Long-axis heading from world +Z toward +X. */
  yaw: number;
  playWidth: number;
  playLength: number;
  padWidth: number;
  padLength: number;
};

export type GoldenGateTennisSiteOptions = {
  /**
   * The playable layer owns this court, so the static pad, paint and net are
   * omitted. `undefined` reserves 14B; `null` renders every decorative court.
   */
  reservedCourtRef?: GoldmanPickleballCourtRef | null;
  includeTrees?: boolean;
  /** Optional stepped/query physics for perimeter fences and court nets. */
  physics?: Physics;
};

// The real center is terraced into a slope. A deep foundation lets every flat
// surveyed pad sit above the baked terrain without floating side gaps.
const COURT_PAD_THICKNESS = 1.75;
const COURT_PAD_TOP = 0.03;
const COURT_PAINT_LIFT = 0.05;
const COURT_SURFACE_LIFT = COURT_PAINT_LIFT + 0.035 / 2;
const LINE_LIFT = 0.073;
const PATH_LIFT = 0.055;
const FENCE_HEIGHT = 3.05; // the city operations plan specifies a 10 ft perimeter fence
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function localPoint(court: GoldmanCourtSpec, lateral: number, along: number): { x: number; z: number } {
  const c = Math.cos(court.yaw);
  const s = Math.sin(court.yaw);
  return {
    x: court.x + c * lateral + s * along,
    z: court.z - s * lateral + c * along
  };
}

/** Terrace each pad above the highest host-terrain sample under its footprint. */
function courtGrade(map: WorldMap, court: GoldmanCourtSpec): number {
  const hx = court.padWidth * 0.5;
  const hz = court.padLength * 0.5;
  let highest = -Infinity;
  for (let iz = 0; iz <= 8; iz++) {
    const along = THREE.MathUtils.lerp(-hz, hz, iz / 8);
    for (let ix = 0; ix <= 5; ix++) {
      const lateral = THREE.MathUtils.lerp(-hx, hx, ix / 5);
      const p = localPoint(court, lateral, along);
      highest = Math.max(highest, map.baseGroundTop(p.x, p.z));
    }
  }
  return highest + 0.025;
}

function courtLocal(court: GoldmanCourtSpec, x: number, z: number): { lateral: number; along: number } {
  const dx = x - court.x;
  const dz = z - court.z;
  const c = Math.cos(court.yaw);
  const s = Math.sin(court.yaw);
  return { lateral: dx * c - dz * s, along: dx * s + dz * c };
}

/** Physics/player grounding that exactly matches the visible terraced pads. */
function installCourtGrounding(map: WorldMap, grades: ReadonlyMap<GoldmanCourtRef, number>) {
  const overlay: GroundTopOverlay = (x, z, base) => {
    for (const court of GOLDMAN_COURTS) {
      const local = courtLocal(court, x, z);
      if (Math.abs(local.lateral) > court.padWidth / 2 || Math.abs(local.along) > court.padLength / 2) continue;
      const grade = grades.get(court.ref)!;
      const onPaint =
        Math.abs(local.lateral) <= court.playWidth / 2 && Math.abs(local.along) <= court.playLength / 2;
      return grade + (onPaint ? COURT_SURFACE_LIFT : COURT_PAD_TOP);
    }
    return base;
  };
  map.setGroundTopOverlay(overlay);
  return overlay;
}

function composeBoxMatrix(
  matrix: THREE.Matrix4,
  x: number,
  y: number,
  z: number,
  yaw: number,
  sx: number,
  sy: number,
  sz: number
) {
  const position = new THREE.Vector3(x, y, z);
  const rotation = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw);
  matrix.compose(position, rotation, new THREE.Vector3(sx, sy, sz));
}

function makeCourtBoxes(
  specs: readonly GoldmanCourtSpec[],
  grades: ReadonlyMap<GoldmanCourtRef, number>,
  playingArea: boolean
): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: playingArea ? 0x285b46 : 0x668b6e,
    roughness: 0.9,
    metalness: 0
  });
  const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
  mesh.name = playingArea ? "goldman_court_playing_surfaces" : "goldman_court_runoff_pads";
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < specs.length; i++) {
    const court = specs[i];
    const y = grades.get(court.ref)!;
    composeBoxMatrix(
      matrix,
      court.x,
      playingArea ? y + COURT_PAINT_LIFT : y + COURT_PAD_TOP - COURT_PAD_THICKNESS / 2,
      court.z,
      court.yaw,
      playingArea ? court.playWidth : court.padWidth,
      playingArea ? 0.035 : COURT_PAD_THICKNESS,
      playingArea ? court.playLength : court.padLength
    );
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  return mesh;
}

type LineBox = { x: number; z: number; yaw: number; sx: number; sz: number; y: number };

function addCourtLine(
  out: LineBox[],
  court: GoldmanCourtSpec,
  y: number,
  lateral: number,
  along: number,
  sx: number,
  sz: number
) {
  const p = localPoint(court, lateral, along);
  out.push({ x: p.x, z: p.z, yaw: court.yaw, sx, sz, y });
}

function courtLines(court: GoldmanCourtSpec, y: number, out: LineBox[]) {
  const w = court.playWidth;
  const l = court.playLength;
  const lw = 0.055;
  // perimeter
  addCourtLine(out, court, y, -w / 2, 0, lw, l);
  addCourtLine(out, court, y, w / 2, 0, lw, l);
  addCourtLine(out, court, y, 0, -l / 2, w, lw);
  addCourtLine(out, court, y, 0, l / 2, w, lw);
  if (court.kind === "tennis") {
    const singlesHalf = 4.115;
    const service = 6.4;
    addCourtLine(out, court, y, -singlesHalf, 0, lw, l);
    addCourtLine(out, court, y, singlesHalf, 0, lw, l);
    addCourtLine(out, court, y, 0, -service, singlesHalf * 2, lw);
    addCourtLine(out, court, y, 0, service, singlesHalf * 2, lw);
    addCourtLine(out, court, y, 0, 0, lw, service * 2);
  } else {
    const kitchen = 2.134;
    addCourtLine(out, court, y, 0, -kitchen, w, lw);
    addCourtLine(out, court, y, 0, kitchen, w, lw);
    addCourtLine(out, court, y, 0, (-l / 2 - kitchen) / 2, lw, l / 2 - kitchen);
    addCourtLine(out, court, y, 0, (l / 2 + kitchen) / 2, lw, l / 2 - kitchen);
  }
}

function makeCourtLines(specs: readonly GoldmanCourtSpec[], grades: ReadonlyMap<GoldmanCourtRef, number>) {
  const boxes: LineBox[] = [];
  for (const court of specs) courtLines(court, grades.get(court.ref)! + LINE_LIFT, boxes);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xf5f1dc, roughness: 0.72, metalness: 0 }),
    boxes.length
  );
  mesh.name = "goldman_court_lines";
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < boxes.length; i++) {
    const line = boxes[i];
    composeBoxMatrix(matrix, line.x, line.y, line.z, line.yaw, line.sx, 0.018, line.sz);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  return mesh;
}

function makeNets(specs: readonly GoldmanCourtSpec[], anchors: ReadonlyMap<GoldmanCourtRef, GoldmanCourtAnchor>) {
  const panels = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x1b2420,
      roughness: 0.82,
      metalness: 0.08,
      transparent: true,
      opacity: 0.58,
      depthWrite: false
    }),
    specs.length
  );
  panels.name = "goldman_court_nets";
  const posts = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.045, 0.045, 1, 6),
    new THREE.MeshStandardMaterial({ color: 0x1b211f, roughness: 0.6, metalness: 0.35 }),
    specs.length * 2
  );
  posts.name = "goldman_court_net_posts";
  const matrix = new THREE.Matrix4();
  let postIndex = 0;
  for (let i = 0; i < specs.length; i++) {
    const court = specs[i];
    const anchor = anchors.get(court.ref)!;
    const height = court.kind === "tennis" ? 0.96 : 0.88;
    composeBoxMatrix(matrix, court.x, anchor.y + height / 2, court.z, court.yaw, court.playWidth + 0.65, height, 0.035);
    panels.setMatrixAt(i, matrix);
    for (const side of [-1, 1]) {
      const p = localPoint(court, side * (court.playWidth / 2 + 0.32), 0);
      composeBoxMatrix(matrix, p.x, anchor.y + height / 2, p.z, 0, 1, height + 0.16, 1);
      posts.setMatrixAt(postIndex++, matrix);
    }
  }
  panels.instanceMatrix.needsUpdate = true;
  posts.instanceMatrix.needsUpdate = true;
  panels.computeBoundingSphere();
  posts.computeBoundingSphere();
  panels.castShadow = true;
  posts.castShadow = true;
  return [panels, posts] as const;
}

function densify(points: readonly GoldmanXZ[], spacing = 4): GoldmanXZ[] {
  const dense: GoldmanXZ[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing));
    for (let k = 0; k < n; k++) {
      if (i > 0 && k === 0) continue;
      const t = k / n;
      dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  dense.push(points[points.length - 1]);
  return dense;
}

function makePaths(map: WorldMap, paths: readonly GoldmanPathSpec[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const path of paths) {
    const pts = densify(path.points);
    const base = positions.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dz = next[1] - prev[1];
      const inv = 1 / (Math.hypot(dx, dz) || 1);
      const nx = -dz * inv * (path.width / 2);
      const nz = dx * inv * (path.width / 2);
      for (const side of [-1, 1]) {
        const x = pts[i][0] + nx * side;
        const z = pts[i][1] + nz * side;
        positions.push(x, map.groundTop(x, z) + PATH_LIFT, z);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x77746b, roughness: 0.96, metalness: 0 })
  );
  mesh.name = "goldman_paths";
  mesh.receiveShadow = true;
  return mesh;
}

function polygonShape(points: readonly GoldmanXZ[], anchor: GoldmanXZ) {
  const shape = new THREE.Shape();
  for (let i = 0; i < points.length; i++) {
    const x = points[i][0] - anchor[0];
    const y = -(points[i][1] - anchor[1]);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function makeClubhouse(map: WorldMap) {
  const group = new THREE.Group();
  group.name = "goldman_taube_family_clubhouse";
  const anchor = GOLDMAN_CLUBHOUSE_OUTLINE[0];
  let grade = -Infinity;
  for (const [x, z] of GOLDMAN_CLUBHOUSE_OUTLINE) grade = Math.max(grade, map.groundTop(x, z));
  const shell = new THREE.ExtrudeGeometry(polygonShape(GOLDMAN_CLUBHOUSE_OUTLINE, anchor), {
    depth: 5.7,
    bevelEnabled: false,
    steps: 1
  });
  shell.rotateX(-Math.PI / 2);
  shell.translate(anchor[0], grade - 2.25, anchor[1]);
  const walls = new THREE.Mesh(
    shell,
    new THREE.MeshStandardMaterial({ color: 0xd8d0bb, roughness: 0.82, metalness: 0 })
  );
  walls.name = "goldman_clubhouse_walls";
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  // The real pavilion is a low horizontal bar: solid park-facing wall, broad
  // flat roof, and an east-facing glass ribbon overlooking the courts.
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(11.8, 0.32, 61.5),
    new THREE.MeshStandardMaterial({ color: 0x5a5547, roughness: 0.88, metalness: 0 })
  );
  roof.name = "goldman_clubhouse_low_roof";
  roof.position.set(-1368.6, grade + 4.58, 2197.9);
  roof.rotation.y = degToRad(3.1);
  roof.castShadow = true;
  group.add(roof);

  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 3.15, 55),
    new THREE.MeshStandardMaterial({
      color: 0x71919a,
      roughness: 0.18,
      metalness: 0.12,
      transparent: true,
      opacity: 0.56,
      depthWrite: false
    })
  );
  glass.name = "goldman_clubhouse_court_facing_glass";
  glass.position.set(-1359.75, grade + 2.3, 2197.3);
  glass.rotation.y = degToRad(3.1);
  group.add(glass);
  return group;
}

function degToRad(degrees: number) {
  return (degrees * Math.PI) / 180;
}

type FenceRun = { points: readonly GoldmanXZ[]; closed: boolean };

function isFenceOpening(x: number, z: number): boolean {
  if (x < -1354 && z > 2160 && z < 2232) return true; // clubhouse/main west entrance
  if (Math.hypot(x + 1328.34, z - 2267.42) < 2.7) return true; // central-spine south gate
  if (Math.hypot(x + 1294.97, z - 2130.5) < 2.35) return true; // north mini-court approach
  return false;
}

function makeFences(map: WorldMap, runs: readonly FenceRun[]) {
  const cells: { x: number; y: number; z: number; yaw: number; length: number }[] = [];
  const posts: { x: number; y: number; z: number }[] = [];
  for (const run of runs) {
    const source = run.closed ? [...run.points, run.points[0]] : [...run.points];
    const pts = densify(source, 3.2);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const x = (a[0] + b[0]) / 2;
      const z = (a[1] + b[1]) / 2;
      // The clubhouse itself completes the west perimeter; do not fence through it.
      if (isFenceOpening(x, z)) continue;
      const ground = map.groundTop(x, z);
      cells.push({ x, y: ground + FENCE_HEIGHT / 2, z, yaw: -Math.atan2(dz, dx), length: Math.hypot(dx, dz) });
      posts.push({ x: a[0], y: map.groundTop(a[0], a[1]) + FENCE_HEIGHT / 2, z: a[1] });
    }
  }
  const panels = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x26362e,
      roughness: 0.68,
      metalness: 0.32,
      transparent: true,
      opacity: 0.3,
      depthWrite: false
    }),
    cells.length
  );
  panels.name = "goldman_perimeter_fence_mesh";
  const postMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.075, 1, 0.075),
    new THREE.MeshStandardMaterial({ color: 0x202b25, roughness: 0.58, metalness: 0.42 }),
    posts.length
  );
  postMesh.name = "goldman_perimeter_fence_posts";
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    composeBoxMatrix(matrix, cell.x, cell.y, cell.z, cell.yaw, cell.length, FENCE_HEIGHT, 0.025);
    panels.setMatrixAt(i, matrix);
  }
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    composeBoxMatrix(matrix, post.x, post.y, post.z, 0, 1, FENCE_HEIGHT + 0.12, 1);
    postMesh.setMatrixAt(i, matrix);
  }
  panels.instanceMatrix.needsUpdate = true;
  postMesh.instanceMatrix.needsUpdate = true;
  panels.computeBoundingSphere();
  postMesh.computeBoundingSphere();
  return [panels, postMesh] as const;
}

function registerStaticBox(
  physics: Physics,
  bodies: number[],
  box: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number }
) {
  const body = physics.world.createBox({
    type: BodyType.Static,
    position: [box.x, box.y, box.z],
    halfExtents: [box.hx, box.hy, box.hz],
    friction: 0.72
  });
  const quat: [number, number, number, number] = [0, Math.sin(box.yaw / 2), 0, Math.cos(box.yaw / 2)];
  physics.world.setBodyTransform(body, [box.x, box.y, box.z], quat);
  physics.addQuerySolid(body, box);
  bodies.push(body);
}

function registerSiteColliders(
  map: WorldMap,
  physics: Physics,
  anchors: ReadonlyMap<GoldmanCourtRef, GoldmanCourtAnchor>,
  bodies: number[]
) {
  // Short panels follow the terrain closely, matching the rendered 10-ft runs.
  for (const run of [
    { points: GOLDMAN_SITE_OUTLINE, closed: true },
    { points: GOLDMAN_NORTHEAST_POD_OUTLINE, closed: true }
  ] as const) {
    const source = run.closed ? [...run.points, run.points[0]] : [...run.points];
    const pts = densify(source, 3.2);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const x = (a[0] + b[0]) / 2;
      const z = (a[1] + b[1]) / 2;
      if (isFenceOpening(x, z)) continue;
      registerStaticBox(physics, bodies, {
        x,
        y: map.groundTop(x, z) + FENCE_HEIGHT / 2,
        z,
        hx: Math.hypot(dx, dz) / 2,
        hy: FENCE_HEIGHT / 2,
        hz: 0.055,
        yaw: -Math.atan2(dz, dx)
      });
    }
  }
  // Nets are real waist-high obstacles for an exploring avatar. The reserved
  // 14B net is included here even though its visual belongs to the game layer.
  for (const court of GOLDMAN_COURTS) {
    const anchor = anchors.get(court.ref)!;
    const height = court.kind === "tennis" ? 0.96 : 0.88;
    registerStaticBox(physics, bodies, {
      x: court.x,
      y: anchor.y + height / 2,
      z: court.z,
      hx: court.playWidth / 2 + 0.32,
      hy: height / 2,
      hz: 0.045,
      yaw: court.yaw
    });
  }
}

type TreePlacement = { x: number; z: number; scale: number; yaw: number; crown: number };

function hash(index: number, salt: number) {
  let h = Math.imul(index + salt * 1013, 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function ellipseTrees(
  out: TreePlacement[],
  cx: number,
  cz: number,
  rx: number,
  rz: number,
  count: number,
  salt: number,
  ring = false
) {
  for (let i = 0; i < count; i++) {
    const angle = hash(i, salt) * Math.PI * 2;
    const radial = ring ? 0.72 + hash(i, salt + 1) * 0.28 : Math.sqrt(hash(i, salt + 1));
    out.push({
      x: cx + Math.cos(angle) * rx * radial,
      z: cz + Math.sin(angle) * rz * radial,
      scale: 0.82 + hash(i, salt + 2) * 0.52,
      yaw: hash(i, salt + 3) * Math.PI * 2,
      crown: hash(i, salt + 4)
    });
  }
}

function makeTrees(map: WorldMap) {
  const candidates: TreePlacement[] = [];
  // Dense mature perimeter mass in the built aerial: strongest west + south,
  // sparse on the Pelosi Drive entry, then a loose ring preserving Hippie
  // Hill's open central lawn.
  ellipseTrees(candidates, -1411, 2192, 22, 65, 24, 11);
  ellipseTrees(candidates, -1335, 2283, 82, 12, 25, 23);
  ellipseTrees(candidates, -1271, 2203, 15, 58, 18, 37);
  ellipseTrees(candidates, -1227, 2228, 67, 54, 24, 51, true);
  // Cluster ellipses intentionally overlap the fence line so the canopy reads
  // continuous; reject their inward half so no trunk lands on a play surface.
  const placements = candidates.filter((tree) => {
    const surface = map.surfaceType(tree.x, tree.z);
    return surface !== 3 && surface !== 4 && !inGoldmanTennisSite(tree.x, tree.z, 3.5);
  });

  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.46, 0.34, 1, 6),
    new THREE.MeshStandardMaterial({ color: 0x594534, roughness: 1, metalness: 0 }),
    placements.length
  );
  trunks.name = "goldman_hill_tree_trunks";
  const crowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0 }),
    placements.length
  );
  crowns.name = "goldman_hill_tree_crowns";
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  for (let i = 0; i < placements.length; i++) {
    const tree = placements[i];
    const ground = map.groundTop(tree.x, tree.z);
    const height = (8.5 + hash(i, 71) * 5.5) * tree.scale;
    composeBoxMatrix(matrix, tree.x, ground + height * 0.37, tree.z, tree.yaw, tree.scale, height * 0.74, tree.scale);
    trunks.setMatrixAt(i, matrix);
    composeBoxMatrix(
      matrix,
      tree.x,
      ground + height * 0.78,
      tree.z,
      tree.yaw,
      height * (0.25 + tree.crown * 0.06),
      height * (0.34 + tree.crown * 0.08),
      height * (0.23 + tree.crown * 0.06)
    );
    crowns.setMatrixAt(i, matrix);
    color.setHSL(0.27 + tree.crown * 0.035, 0.32, 0.23 + tree.crown * 0.11);
    crowns.setColorAt(i, color);
  }
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  trunks.computeBoundingSphere();
  crowns.computeBoundingSphere();
  trunks.castShadow = true;
  crowns.castShadow = true;
  trunks.receiveShadow = true;
  crowns.receiveShadow = true;
  return [trunks, crowns] as const;
}

function makeHippieHillEdge(map: WorldMap) {
  const path: GoldmanPathSpec = {
    name: "Hippie Hill edge",
    width: 1.7,
    points: [...HIPPIE_HILL_OUTLINE, HIPPIE_HILL_OUTLINE[0]]
  };
  const mesh = makePaths(map, [path]);
  mesh.name = "goldman_hippie_hill_edge_path";
  return mesh;
}

export class GoldenGateTennisSite {
  readonly group = new THREE.Group();
  readonly vegetation = new THREE.Group();
  readonly courtAnchors: ReadonlyMap<GoldmanCourtRef, GoldmanCourtAnchor>;
  readonly gameplayAnchor: GoldmanCourtAnchor;
  readonly reservedCourtRef: GoldmanPickleballCourtRef | null;
  #physics?: Physics;
  #bodies: number[] = [];
  #map: WorldMap;
  #groundOverlay?: GroundTopOverlay;

  constructor(map: WorldMap, options: GoldenGateTennisSiteOptions = {}) {
    this.group.name = "goldman_tennis_center";
    this.vegetation.name = "goldman_tennis_vegetation";
    this.#map = map;
    this.reservedCourtRef = options.reservedCourtRef === undefined ? DEFAULT_GAMEPLAY_COURT_REF : options.reservedCourtRef;
    this.#physics = options.physics;

    const grades = new Map<GoldmanCourtRef, number>();
    const anchors = new Map<GoldmanCourtRef, GoldmanCourtAnchor>();
    for (const court of GOLDMAN_COURTS) {
      const grade = courtGrade(map, court);
      grades.set(court.ref, grade);
      anchors.set(court.ref, {
        ref: court.ref,
        kind: court.kind,
        name: court.name ?? `Goldman ${court.kind} court ${court.ref}`,
        x: court.x,
        y: grade + COURT_SURFACE_LIFT,
        z: court.z,
        yaw: court.yaw,
        playWidth: court.playWidth,
        playLength: court.playLength,
        padWidth: court.padWidth,
        padLength: court.padLength
      });
    }
    this.courtAnchors = anchors;
    this.gameplayAnchor = anchors.get(this.reservedCourtRef ?? DEFAULT_GAMEPLAY_COURT_REF)!;

    const visibleCourts = GOLDMAN_COURTS.filter((court) => court.ref !== this.reservedCourtRef);
    this.group.add(makeCourtBoxes(visibleCourts, grades, false));
    this.group.add(makeCourtBoxes(visibleCourts, grades, true));
    this.group.add(makeCourtLines(visibleCourts, grades));
    this.group.add(...makeNets(visibleCourts, anchors));
    this.group.add(makePaths(map, GOLDMAN_PATHS));
    this.group.add(makeClubhouse(map));
    this.group.add(
      ...makeFences(map, [
        { points: GOLDMAN_SITE_OUTLINE, closed: true },
        { points: GOLDMAN_NORTHEAST_POD_OUTLINE, closed: true }
      ])
    );
    this.group.add(makeHippieHillEdge(map));

    if (options.includeTrees !== false) this.vegetation.add(...makeTrees(map));
    this.group.add(this.vegetation);
    if (this.#physics) {
      try {
        registerSiteColliders(map, this.#physics, anchors, this.#bodies);
      } catch (error) {
        for (const body of this.#bodies) {
          this.#physics.removeQuerySolid(body);
          this.#physics.world.destroyBody(body);
        }
        this.#bodies.length = 0;
        throw error;
      }
    }
    this.#groundOverlay = installCourtGrounding(map, grades);
  }

  getCourtAnchor(ref: GoldmanCourtRef): GoldmanCourtAnchor {
    const anchor = this.courtAnchors.get(ref);
    if (!anchor) throw new Error(`[goldman tennis] unknown court ref ${ref}`);
    return anchor;
  }

  setFoliageVisible(visible: boolean) {
    this.vegetation.visible = visible;
  }

  addTo(scene: THREE.Scene): this {
    scene.add(this.group);
    return this;
  }

  dispose() {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    if (this.#physics) {
      for (const body of this.#bodies) {
        this.#physics.removeQuerySolid(body);
        this.#physics.world.destroyBody(body);
      }
      this.#bodies.length = 0;
    }
    if (this.#groundOverlay) this.#map.clearGroundTopOverlay(this.#groundOverlay);
    this.#groundOverlay = undefined;
    this.group.removeFromParent();
  }
}

export function createGoldenGateTennisSite(map: WorldMap, options?: GoldenGateTennisSiteOptions) {
  return new GoldenGateTennisSite(map, options);
}
