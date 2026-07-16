import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BodyType, type Physics } from "../../core/physics";
import { lightAnchor, registerAmbientLightAnchor } from "../../player/lightPool";
import { loadTexture } from "../../render/textures";
import {
  TEA_GARDEN_BUILDINGS,
  TEA_GARDEN_PATHS,
  TEA_GARDEN_WATER_FEATURES,
  inTeaGardenWater,
  pointInTeaGardenPolygon,
  type TeaGardenBuildingSpec,
  type TeaGardenTerrain,
  type TeaGardenXZ
} from "./layout";

const COLORS = {
  vermilion: 0xb43a2e,
  vermilionDark: 0x7f241f,
  timber: 0x473126,
  timberDark: 0x261e1b,
  plaster: 0xe8dfcc,
  shoji: 0xf1ead9,
  roof: 0x353c43,
  roofEdge: 0x20262c,
  stone: 0x77766c,
  stoneDark: 0x4e504a,
  path: 0x8b8779,
  pathEdge: 0x5e5d54
} as const;

const WATER_EFFECTS_RENDER_ORDER = 12;

function alphaSurface<T extends THREE.Material>(value: T): T {
  value.transparent = true;
  value.depthWrite = false;
  return value;
}

type PhysicsBox = {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw?: number;
  quat?: readonly [number, number, number, number];
};

export type TeaGardenArchitecture = {
  group: THREE.Group;
  waterGroup: THREE.Group;
  ready: Promise<void>;
  update(time: number, visitKoi?: TeaGardenKoiVisitor): void;
  dispose(): void;
  stats: TeaGardenArchitectureStats;
};

export type TeaGardenArchitectureStats = {
  meshes: number;
  ponds: number;
  koi: number;
  physicsBodies: number;
  koiInWater: number;
  koiSubmerged: number;
  koiMinSubmersion: number;
  koiTailStrokes: number;
};

/** Allocation-free surface sample used to turn the visible koi into fluid wakes. */
export type TeaGardenKoiVisitor = (
  id: number,
  x: number,
  y: number,
  z: number,
  velocityX: number,
  velocityZ: number,
  depth: number,
  tailStroke: number,
  tailSide: number
) => void;

function material(color: number, roughness = 0.86, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function centroid(points: readonly TeaGardenXZ[]): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const point of points) {
    x += point[0];
    z += point[1];
  }
  return { x: x / points.length, z: z / points.length };
}

function highestGround(map: TeaGardenTerrain, points: readonly TeaGardenXZ[]): number {
  let y = -Infinity;
  for (const [x, z] of points) y = Math.max(y, map.groundTop(x, z));
  return y;
}

function lowestGround(map: TeaGardenTerrain, points: readonly TeaGardenXZ[]): number {
  let y = Infinity;
  for (const [x, z] of points) y = Math.min(y, map.groundTop(x, z));
  return y;
}

function makeBox(
  name: string,
  size: readonly [number, number, number],
  mat: THREE.Material,
  position: readonly [number, number, number],
  yaw = 0
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.y = yaw;
  // Tiny mullions, rail posts and individual bridge slats are already shadowed
  // by their parent wall/deck. Keeping them out of every CSM cascade avoids a
  // large multiplier in this detail-dense garden while preserving silhouettes.
  mesh.castShadow = size[0] * size[1] * size[2] >= 0.08;
  mesh.receiveShadow = true;
  return mesh;
}

function addPhysicsBox(physics: Physics | undefined, bodies: number[], box: PhysicsBox): void {
  if (!physics) return;
  const body = physics.world.createBox({
    type: BodyType.Static,
    position: [box.x, box.y, box.z],
    halfExtents: [box.hx, box.hy, box.hz],
    friction: 0.82
  });
  const q: readonly [number, number, number, number] =
    box.quat ?? [0, Math.sin((box.yaw ?? 0) / 2), 0, Math.cos((box.yaw ?? 0) / 2)];
  physics.world.setBodyTransform(body, [box.x, box.y, box.z], q);
  physics.addQuerySolid(body, { ...box, quat: q });
  bodies.push(body);
}

function addRoofTriangle(
  positions: number[],
  indices: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3
): void {
  const base = positions.length / 3;
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  // Roof callers describe their faces clockwise when viewed from above. Reverse
  // the index winding so normals point upward and FrontSide roofs remain visible.
  indices.push(base, base + 2, base + 1);
}

/** Low-poly irimoya-like roof with lifted corners and deep eaves. */
function roofGeometry(width: number, depth: number, rise: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const hw = width / 2;
  const hd = depth / 2;
  const corner = rise * 0.13;
  const ridgeA = new THREE.Vector3(-width * 0.23, rise, 0);
  const ridgeB = new THREE.Vector3(width * 0.23, rise, 0);
  const nw = new THREE.Vector3(-hw, corner, -hd);
  const ne = new THREE.Vector3(hw, corner, -hd);
  const sw = new THREE.Vector3(-hw, corner, hd);
  const se = new THREE.Vector3(hw, corner, hd);
  const n0 = new THREE.Vector3(-width * 0.2, 0, -hd * 1.03);
  const n1 = new THREE.Vector3(width * 0.2, 0, -hd * 1.03);
  const s0 = new THREE.Vector3(-width * 0.2, 0, hd * 1.03);
  const s1 = new THREE.Vector3(width * 0.2, 0, hd * 1.03);

  addRoofTriangle(positions, indices, nw, n0, ridgeA);
  addRoofTriangle(positions, indices, n0, n1, ridgeA);
  addRoofTriangle(positions, indices, n1, ridgeB, ridgeA);
  addRoofTriangle(positions, indices, n1, ne, ridgeB);
  addRoofTriangle(positions, indices, sw, ridgeA, s0);
  addRoofTriangle(positions, indices, s0, ridgeA, ridgeB);
  addRoofTriangle(positions, indices, s0, ridgeB, s1);
  addRoofTriangle(positions, indices, s1, ridgeB, se);
  addRoofTriangle(positions, indices, nw, ridgeA, sw);
  addRoofTriangle(positions, indices, ne, se, ridgeB);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeRoof(
  name: string,
  width: number,
  depth: number,
  rise: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  roofMat: THREE.Material,
  undersideMat: THREE.Material
): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(x, y, z);
  group.rotation.y = yaw;

  const roof = new THREE.Mesh(roofGeometry(width, depth, rise), roofMat);
  roof.castShadow = true;
  roof.receiveShadow = true;
  group.add(roof);

  const underside = makeBox(`${name}_eaves`, [width * 1.01, 0.13, depth * 1.01], undersideMat, [0, -0.05, 0]);
  group.add(underside);

  const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, width * 0.52, 8), roofMat);
  ridge.name = `${name}_ridge`;
  ridge.rotation.z = Math.PI / 2;
  ridge.position.y = rise + 0.04;
  ridge.castShadow = true;
  group.add(ridge);
  return group;
}

function makeShojiWall(
  width: number,
  height: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  panelMat: THREE.Material,
  timberMat: THREE.Material
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = yaw;
  group.add(makeBox("shoji_panel", [width, height, 0.08], panelMat, [0, 0, 0]));
  const cols = Math.max(2, Math.round(width / 1.05));
  for (let i = 0; i <= cols; i++) {
    const px = THREE.MathUtils.lerp(-width / 2, width / 2, i / cols);
    group.add(makeBox("shoji_mullion_v", [0.045, height + 0.04, 0.105], timberMat, [px, 0, 0]));
  }
  for (let i = 0; i <= 3; i++) {
    const py = THREE.MathUtils.lerp(-height / 2, height / 2, i / 3);
    group.add(makeBox("shoji_mullion_h", [width + 0.04, 0.04, 0.105], timberMat, [0, py, 0]));
  }
  return group;
}

function makeRailing(
  length: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  timberMat: THREE.Material
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = yaw;
  group.add(makeBox("rail_top", [length, 0.11, 0.11], timberMat, [0, 0.88, 0]));
  const count = Math.max(2, Math.round(length / 1.25));
  for (let i = 0; i <= count; i++) {
    const px = THREE.MathUtils.lerp(-length / 2, length / 2, i / count);
    group.add(makeBox("rail_post", [0.09, 0.95, 0.09], timberMat, [px, 0.42, 0]));
  }
  return group;
}

const TEA_HOUSE_ART = [
  "/art/tea-house/misty-pines.webp",
  "/art/tea-house/drum-bridge-moon.webp",
  "/art/tea-house/koi-ginkgo.webp",
  "/art/tea-house/four-seasons.webp"
] as const;

function makeTeaHouseGallery(
  center: { x: number; z: number },
  grade: number,
  yaw: number,
  timber: THREE.Material
): THREE.Group {
  const group = new THREE.Group();
  group.name = "tea_house_original_fusuma_gallery";
  group.position.set(center.x, grade, center.z);
  group.rotation.y = yaw;
  const loader = new THREE.TextureLoader();
  const paintingGeometry = new THREE.PlaneGeometry(2.08, 1.02);
  const xPositions = [-3.42, -1.14, 1.14, 3.42] as const;
  TEA_HOUSE_ART.forEach((url, index) => {
    const texture = loader.load(url);
    texture.name = `tea_house_art_${index + 1}`;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const painting = new THREE.Mesh(
      paintingGeometry,
      new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.86,
        metalness: 0,
        emissive: 0x1d130b,
        emissiveIntensity: 0.09
      })
    );
    painting.name = `tea_house_fusuma_art_${index + 1}`;
    painting.position.set(xPositions[index], 2.08, -4.235);
    painting.castShadow = false;
    painting.receiveShadow = false;
    group.add(painting);
    const frameWidth = 2.2;
    const frameHeight = 1.14;
    group.add(makeBox("tea_house_art_frame_top", [frameWidth, 0.055, 0.065], timber, [xPositions[index], 2.08 + frameHeight / 2, -4.21]));
    group.add(makeBox("tea_house_art_frame_bottom", [frameWidth, 0.055, 0.065], timber, [xPositions[index], 2.08 - frameHeight / 2, -4.21]));
    group.add(makeBox("tea_house_art_frame_left", [0.055, frameHeight, 0.065], timber, [xPositions[index] - frameWidth / 2, 2.08, -4.21]));
    group.add(makeBox("tea_house_art_frame_right", [0.055, frameHeight, 0.065], timber, [xPositions[index] + frameWidth / 2, 2.08, -4.21]));
  });
  return group;
}

function makeTeaKettleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const matrix = new THREE.Matrix4();
  const body = new THREE.SphereGeometry(0.28, 14, 10);
  body.scale(1, 0.8, 1);
  parts.push(body);
  const lid = new THREE.CylinderGeometry(0.15, 0.19, 0.045, 14);
  lid.translate(0, 0.22, 0);
  parts.push(lid);
  const knob = new THREE.SphereGeometry(0.05, 10, 6);
  knob.translate(0, 0.29, 0);
  parts.push(knob);
  const spout = new THREE.ConeGeometry(0.065, 0.34, 10);
  matrix.makeRotationZ(-Math.PI / 2);
  matrix.setPosition(0.27, 0.08, 0);
  spout.applyMatrix4(matrix);
  parts.push(spout);
  // A full ring sits just behind the body; natural occlusion leaves the upper
  // arch and side grips visible as a traditional iron-kettle handle.
  const handle = new THREE.TorusGeometry(0.235, 0.026, 6, 20);
  handle.translate(0, 0.06, -0.085);
  parts.push(handle);
  const flatParts = parts.map((part) => part.toNonIndexed());
  const merged = mergeGeometries(flatParts, false)!;
  for (const part of parts) part.dispose();
  for (const part of flatParts) part.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function makeTeaHouse(
  map: TeaGardenTerrain,
  spec: TeaGardenBuildingSpec,
  mats: ReturnType<typeof createMaterials>,
  physics: Physics | undefined,
  bodies: number[]
): THREE.Group {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_tea_house";
  const c = centroid(spec.outline);
  const grade = highestGround(map, spec.outline);
  const lowGrade = lowestGround(map, spec.outline);
  const yaw = spec.yaw;
  const up = new THREE.Vector3(0, 1, 0);
  const foundationBottom = lowGrade - 0.12;
  const foundationTop = grade + 0.38;
  const foundationHeight = foundationTop - foundationBottom;
  group.add(makeBox(
    "tea_house_stone_foundation",
    [11.6, foundationHeight, 10.6],
    mats.stoneDark,
    [c.x, foundationBottom + foundationHeight / 2, c.z],
    yaw
  ));
  group.add(makeBox("tea_house_walkable_veranda", [12.4, 0.26, 11.25], mats.timber, [c.x, grade + 0.5, c.z], yaw));

  const local = new THREE.Vector3();
  const world = (lx: number, ly: number, lz: number) => {
    local.set(lx, ly, lz).applyAxisAngle(up, yaw);
    return [c.x + local.x, grade + local.y, c.z + local.z] as const;
  };

  // Enclosed north/back wall carries the art; the pond-facing south elevation
  // is genuinely open across five bays. Side walls stop short of that veranda.
  group.add(makeBox("tea_house_north_knee_wall", [10.1, 0.9, 0.24], mats.plaster, world(0, 1.03, -4.42), yaw));
  group.add(makeShojiWall(9.8, 1.55, ...world(0, 2.22, -4.36), yaw, mats.shoji, mats.timberDark));
  for (const side of [-1, 1]) {
    group.add(makeBox("tea_house_side_knee_wall", [0.24, 0.9, 7.35], mats.plaster, world(side * 4.82, 1.03, -0.65), yaw));
    group.add(makeShojiWall(6.65, 1.55, ...world(side * 4.76, 2.22, -0.72), yaw + side * Math.PI / 2, mats.shoji, mats.timberDark));
  }

  const postPositions: readonly [number, number][] = [
    ...[-4.7, -2.35, 0, 2.35, 4.7].flatMap((x) => [[x, -4.48], [x, 4.48]] as [number, number][]),
    ...[-2.25, 0, 2.25].flatMap((z) => [[-4.72, z], [4.72, z]] as [number, number][])
  ];
  const postGeometry = new THREE.BoxGeometry(0.23, 2.84, 0.23);
  const posts = new THREE.InstancedMesh(postGeometry, mats.timberDark, postPositions.length);
  posts.name = "tea_house_structural_posts";
  const dummy = new THREE.Object3D();
  postPositions.forEach(([x, z], index) => {
    dummy.position.set(...world(x, 1.94, z));
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    posts.setMatrixAt(index, dummy.matrix);
  });
  posts.instanceMatrix.needsUpdate = true;
  posts.computeBoundingSphere();
  posts.castShadow = true;
  posts.receiveShadow = true;
  group.add(posts);

  group.add(makeBox("tea_house_front_lintel", [10.15, 0.22, 0.22], mats.timberDark, world(0, 3.36, 4.48), yaw));
  group.add(makeBox("tea_house_back_lintel", [10.15, 0.22, 0.22], mats.timberDark, world(0, 3.36, -4.48), yaw));
  group.add(makeBox("tea_house_east_lintel", [0.22, 0.22, 9.15], mats.timberDark, world(4.72, 3.36, 0), yaw));
  group.add(makeBox("tea_house_west_lintel", [0.22, 0.22, 9.15], mats.timberDark, world(-4.72, 3.36, 0), yaw));

  // Open front safety rails terminate before the broad central entry.
  group.add(makeRailing(2.75, ...world(-3.55, 0.58, 5.08), yaw, mats.timberDark));
  group.add(makeRailing(2.75, ...world(3.55, 0.58, 5.08), yaw, mats.timberDark));

  // Shared exposed rafters: two instanced draws instead of twelve box meshes.
  const rafterLong = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.16, 9.5), mats.timber, 7);
  rafterLong.name = "tea_house_exposed_long_rafters";
  for (let index = 0; index < 7; index++) {
    dummy.position.set(...world(THREE.MathUtils.lerp(-4.35, 4.35, index / 6), 3.44, 0));
    dummy.rotation.set(0, yaw, 0);
    dummy.updateMatrix();
    rafterLong.setMatrixAt(index, dummy.matrix);
  }
  rafterLong.instanceMatrix.needsUpdate = true;
  rafterLong.computeBoundingSphere();
  rafterLong.castShadow = true;
  group.add(rafterLong);
  const rafterCross = new THREE.InstancedMesh(new THREE.BoxGeometry(9.65, 0.17, 0.14), mats.timber, 5);
  rafterCross.name = "tea_house_exposed_cross_rafters";
  for (let index = 0; index < 5; index++) {
    dummy.position.set(...world(0, 3.39, THREE.MathUtils.lerp(-3.8, 3.8, index / 4)));
    dummy.rotation.set(0, yaw, 0);
    dummy.updateMatrix();
    rafterCross.setMatrixAt(index, dummy.matrix);
  }
  rafterCross.instanceMatrix.needsUpdate = true;
  rafterCross.computeBoundingSphere();
  rafterCross.castShadow = true;
  group.add(rafterCross);

  group.add(makeRoof("tea_house_roof", 13.6, 12.25, 2.08, c.x, grade + 3.48, c.z, yaw, mats.roof, mats.timberDark));
  group.add(makeBox("tea_house_roof_monitor", [4.55, 0.7, 3.15], mats.timberDark, world(0, 5.12, 0), yaw));
  group.add(makeShojiWall(3.75, 0.48, ...world(0, 5.15, 1.59), yaw, mats.shoji, mats.timberDark));
  group.add(makeShojiWall(3.75, 0.48, ...world(0, 5.15, -1.59), yaw + Math.PI, mats.shoji, mats.timberDark));
  group.add(makeRoof("tea_house_monitor_roof", 5.7, 4.35, 0.92, c.x, grade + 5.46, c.z, yaw, mats.roof, mats.timberDark));

  const tatamiGeometry = new THREE.BoxGeometry(2.05, 0.055, 1.02);
  const tatami = new THREE.InstancedMesh(tatamiGeometry, mats.tatami, 8);
  tatami.name = "tea_house_tatami_floor";
  let tatamiIndex = 0;
  for (const x of [-2.2, 0, 2.2, 4.4]) {
    for (const z of [-1.15, 1.15]) {
      dummy.position.set(...world(x - 1.1, 0.67, z));
      dummy.rotation.set(0, yaw + ((tatamiIndex & 1) ? Math.PI / 2 : 0), 0);
      dummy.updateMatrix();
      tatami.setMatrixAt(tatamiIndex++, dummy.matrix);
    }
  }
  tatami.instanceMatrix.needsUpdate = true;
  tatami.computeBoundingSphere();
  tatami.receiveShadow = true;
  group.add(tatami);

  // Irori table, benches, cushions and kettle form a visible social centre.
  const tableP = world(0, 1.05, 0.55);
  group.add(makeBox("tea_house_irori", [2.8, 0.42, 1.55], mats.bridgeTimberDark, tableP, yaw));
  group.add(makeBox("tea_house_irori_hearth", [1.15, 0.08, 0.72], mats.iron, world(0, 1.28, 0.55), yaw));
  group.add(makeBox("tea_house_bench_left", [2.7, 0.28, 0.62], mats.bridgeTimberDark, world(-2.35, 0.86, 0.55), yaw));
  group.add(makeBox("tea_house_bench_right", [2.7, 0.28, 0.62], mats.bridgeTimberDark, world(2.35, 0.86, 0.55), yaw));
  const kettle = new THREE.Mesh(makeTeaKettleGeometry(), mats.iron);
  kettle.name = "tea_house_kettle";
  kettle.position.set(...world(0, 1.47, 0.55));
  kettle.castShadow = true;
  group.add(kettle);

  group.add(makeTeaHouseGallery(c, grade, yaw, mats.timberDark));
  const lanternMaterial = new THREE.MeshStandardMaterial({
    color: 0xf5dfb1,
    emissive: 0xffbb68,
    emissiveIntensity: 1.25,
    roughness: 0.86
  });
  for (const x of [-2.5, 2.5]) {
    const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, 0.58, 16), lanternMaterial);
    lantern.name = "tea_house_warm_paper_lantern";
    lantern.position.set(...world(x, 2.85, 0.2));
    group.add(lantern);
    // Modern physically-correct light units make single-digit point-light
    // intensities nearly decorative. The warm fill that reveals the timber,
    // tatami, irori and artwork now rides the shared scene light pool — the
    // garden streaming in must never add a light to the visible set (that
    // invalidates every lit pipeline; measured as a multi-second flyover
    // freeze). `range` releases the pool slot whenever no one is close enough
    // to see inside the pavilion.
    const fillPos = world(x, 2.85, 0.2);
    group.add(lightAnchor({ color: 0xffc47d, intensity: 38, distance: 8, range: 60 }, ...fillPos));
  }

  // Walkable slab plus three enclosing walls. The whole south façade and its
  // central veranda remain physically open, so the player can enter and cross
  // the pavilion instead of colliding with a single sealed proxy.
  addPhysicsBox(physics, bodies, {
    x: c.x,
    y: grade + 0.49,
    z: c.z,
    hx: 5.6,
    hy: 0.15,
    hz: 5.05,
    yaw
  });
  const backP = world(0, 1.9, -4.44);
  addPhysicsBox(physics, bodies, { x: backP[0], y: backP[1], z: backP[2], hx: 5.05, hy: 1.42, hz: 0.13, yaw });
  for (const side of [-1, 1]) {
    const sideP = world(side * 4.84, 1.9, -0.65);
    addPhysicsBox(physics, bodies, {
      x: sideP[0], y: sideP[1], z: sideP[2], hx: 3.68, hy: 1.42, hz: 0.13, yaw: yaw + Math.PI / 2
    });
  }
  return group;
}

function makeGiftShop(
  map: TeaGardenTerrain,
  spec: TeaGardenBuildingSpec,
  mats: ReturnType<typeof createMaterials>,
  physics: Physics | undefined,
  bodies: number[]
): THREE.Group {
  const c = centroid(spec.outline);
  const grade = highestGround(map, spec.outline);
  const lowGrade = lowestGround(map, spec.outline);
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_gift_shop";
  const foundationBottom = lowGrade - 0.12;
  const foundationTop = grade + 0.21;
  const foundationHeight = foundationTop - foundationBottom;
  group.add(makeBox(
    "gift_shop_foundation",
    [7.3, foundationHeight, 6.3],
    mats.stoneDark,
    [c.x, foundationBottom + foundationHeight / 2, c.z],
    spec.yaw
  ));
  group.add(makeBox("gift_shop_walls", [6.45, 2.7, 5.45], mats.plaster, [c.x, grade + 1.48, c.z], spec.yaw));
  group.add(makeRoof("gift_shop_roof", 8.25, 7.15, 1.55, c.x, grade + 2.83, c.z, spec.yaw, mats.roof, mats.vermilionDark));
  const front = new THREE.Vector3(0, 0, 2.76).applyAxisAngle(new THREE.Vector3(0, 1, 0), spec.yaw);
  group.add(makeShojiWall(
    4.8,
    1.8,
    c.x + front.x,
    grade + 1.55,
    c.z + front.z,
    spec.yaw,
    mats.shoji,
    mats.timberDark
  ));
  const collisionTop = grade + 2.83;
  addPhysicsBox(physics, bodies, {
    x: c.x,
    y: (foundationBottom + collisionTop) / 2,
    z: c.z,
    hx: 3.22,
    hy: (collisionTop - foundationBottom) / 2,
    hz: 2.72,
    yaw: spec.yaw
  });
  return group;
}

function makePagoda(
  map: TeaGardenTerrain,
  spec: TeaGardenBuildingSpec,
  mats: ReturnType<typeof createMaterials>,
  physics: Physics | undefined,
  bodies: number[]
): THREE.Group {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_five_story_pagoda";
  const c = centroid(spec.outline);
  const grade = highestGround(map, spec.outline);
  const lowGrade = lowestGround(map, spec.outline);
  const yaw = spec.yaw;
  const plinthBottom = lowGrade - 0.12;
  const plinthTop = grade + 0.425;
  const plinthHeight = plinthTop - plinthBottom;
  group.add(makeBox(
    "pagoda_tatsuyama_plinth",
    [10.6, plinthHeight, 10.6],
    mats.tatsuyama,
    [c.x, plinthBottom + plinthHeight / 2, c.z],
    yaw
  ));
  group.add(makeBox("pagoda_base", [6.5, 3.1, 6.5], mats.plaster, [c.x, grade + 1.85, c.z], yaw));
  for (let face = 0; face < 4; face++) {
    const faceYaw = yaw + face * Math.PI / 2;
    const faceOffset = new THREE.Vector3(0, 0, 3.27).applyAxisAngle(new THREE.Vector3(0, 1, 0), faceYaw);
    group.add(makeShojiWall(
      5.4,
      2.05,
      c.x + faceOffset.x,
      grade + 1.95,
      c.z + faceOffset.z,
      faceYaw,
      mats.shoji,
      mats.vermilionDark
    ));
  }

  const sizes = [10.2, 9.15, 8.05, 6.95, 5.85];
  for (let level = 0; level < 5; level++) {
    const floorY = grade + 2.65 + level * 2.25;
    const wallSize = 5.65 - level * 0.72;
    group.add(makeBox(
      `pagoda_floor_band_${level + 1}`,
      [wallSize + 0.52, 0.2, wallSize + 0.52],
      mats.vermilion,
      [c.x, floorY + 0.02, c.z],
      yaw
    ));
    group.add(makeBox(`pagoda_level_${level + 1}`, [wallSize, 1.7, wallSize], mats.plaster, [c.x, floorY + 0.72, c.z], yaw));
    group.add(makeBox(
      `pagoda_ceiling_band_${level + 1}`,
      [wallSize + 0.38, 0.16, wallSize + 0.38],
      mats.vermilion,
      [c.x, floorY + 1.5, c.z],
      yaw
    ));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p = new THREE.Vector3(sx * wallSize * 0.51, 0, sz * wallSize * 0.51).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        group.add(makeBox(`pagoda_post_${level}`, [0.18, 1.95, 0.18], mats.vermilion, [c.x + p.x, floorY + 0.84, c.z + p.z], yaw));
      }
    }
    for (let face = 0; face < 4; face++) {
      const faceYaw = yaw + face * Math.PI / 2;
      const facade = new THREE.Vector3(0, 0, wallSize / 2 + 0.055)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), faceYaw);
      group.add(makeShojiWall(
        wallSize * 0.72,
        1.12,
        c.x + facade.x,
        floorY + 0.8,
        c.z + facade.z,
        faceYaw,
        mats.shoji,
        mats.vermilionDark
      ));
    }
    group.add(makeRoof(`pagoda_roof_${level + 1}`, sizes[level], sizes[level], 1.38, c.x, floorY + 1.62, c.z, yaw, mats.roof, mats.vermilionDark));
  }

  const finialY = grade + 14.05;
  const finial = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 2.3, 10), mats.bronze);
  finial.name = "pagoda_finial";
  finial.position.set(c.x, finialY, c.z);
  finial.castShadow = true;
  group.add(finial);
  for (let i = 0; i < 5; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38 - i * 0.045, 0.055, 6, 16), mats.bronze);
    ring.name = "pagoda_finial_ring";
    ring.rotation.x = Math.PI / 2;
    ring.position.set(c.x, finialY - 0.4 + i * 0.25, c.z);
    group.add(ring);
  }
  const collisionTop = grade + 10.8;
  addPhysicsBox(physics, bodies, {
    x: c.x,
    y: (plinthBottom + collisionTop) / 2,
    z: c.z,
    hx: 3.25,
    hy: (collisionTop - plinthBottom) / 2,
    hz: 3.25,
    yaw
  });
  return group;
}

function makeTurnstileHouse(
  map: TeaGardenTerrain,
  spec: TeaGardenBuildingSpec,
  mats: ReturnType<typeof createMaterials>,
  physics: Physics | undefined,
  bodies: number[]
): THREE.Group {
  const c = centroid(spec.outline);
  const grade = highestGround(map, spec.outline);
  const lowGrade = lowestGround(map, spec.outline);
  const yaw = spec.yaw;
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_turnstile_house";

  const foundationBottom = lowGrade - 0.12;
  const foundationTop = grade + 0.24;
  const foundationHeight = foundationTop - foundationBottom;
  group.add(makeBox(
    "turnstile_house_foundation",
    [5.15, foundationHeight, 6.65],
    mats.stoneDark,
    [c.x, foundationBottom + foundationHeight / 2, c.z],
    yaw
  ));
  group.add(makeBox("turnstile_house_walls", [4.45, 2.45, 5.85], mats.plaster, [c.x, grade + 1.46, c.z], yaw));
  group.add(makeBox("turnstile_house_sill", [4.7, 0.24, 6.05], mats.timberDark, [c.x, grade + 0.42, c.z], yaw));

  const front = new THREE.Vector3(0, 0, 2.96).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  group.add(makeShojiWall(
    3.25,
    1.35,
    c.x + front.x,
    grade + 1.65,
    c.z + front.z,
    yaw,
    mats.shoji,
    mats.timberDark
  ));
  group.add(makeRoof("turnstile_house_roof", 6.15, 7.55, 1.28, c.x, grade + 2.7, c.z, yaw, mats.roof, mats.vermilionDark));

  const collisionTop = grade + 2.7;
  addPhysicsBox(physics, bodies, {
    x: c.x,
    y: (foundationBottom + collisionTop) / 2,
    z: c.z,
    hx: 2.23,
    hy: (collisionTop - foundationBottom) / 2,
    hz: 2.93,
    yaw
  });
  return group;
}

function makeGate(
  map: TeaGardenTerrain,
  spec: TeaGardenBuildingSpec,
  mats: ReturnType<typeof createMaterials>,
  physics: Physics | undefined,
  bodies: number[]
): THREE.Group {
  const c = centroid(spec.outline);
  const grade = highestGround(map, spec.outline);
  const isMain = spec.kind === "hagiwara-gate";
  const isTemple = spec.kind === "temple-gate";
  const width = isMain ? 8.4 : isTemple ? 7.2 : spec.kind === "south-gate" ? 6.8 : 4.8;
  const height = isMain ? 4.9 : isTemple ? 4.5 : 3.9;
  const group = new THREE.Group();
  group.name = `japanese_tea_garden_${spec.kind}`;
  const postMat = isTemple ? mats.vermilion : mats.timberDark;
  const topY = grade + height;
  for (const side of [-1, 1]) {
    const offset = new THREE.Vector3(side * width * 0.38, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), spec.yaw);
    const postX = c.x + offset.x;
    const postZ = c.z + offset.z;
    const postBottom = map.groundTop(postX, postZ) - 0.12;
    const postHeight = Math.max(0.6, topY - postBottom);
    const postY = postBottom + postHeight / 2;
    group.add(makeBox("gate_post", [0.42, postHeight, 0.42], postMat, [postX, postY, postZ], spec.yaw));
    addPhysicsBox(physics, bodies, {
      x: postX,
      y: postY,
      z: postZ,
      hx: 0.21,
      hy: postHeight / 2,
      hz: 0.21,
      yaw: spec.yaw
    });
  }
  group.add(makeBox("gate_lintel", [width, 0.48, 0.72], postMat, [c.x, topY - 0.45, c.z], spec.yaw));
  group.add(makeRoof("gate_roof", width + 2.2, 4.2, 1.25, c.x, topY - 0.2, c.z, spec.yaw, mats.roof, mats.vermilionDark));
  if (isMain) {
    const sign = makeBox("hagiwara_gate_sign", [3.7, 0.72, 0.16], mats.timber, [c.x, topY - 0.75, c.z], spec.yaw);
    group.add(sign);
  }
  return group;
}

function densify(points: readonly TeaGardenXZ[], spacing = 2): TeaGardenXZ[] {
  const dense: TeaGardenXZ[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing));
    for (let s = 0; s < steps; s++) {
      if (i > 0 && s === 0) continue;
      const t = s / steps;
      dense.push([THREE.MathUtils.lerp(a[0], b[0], t), THREE.MathUtils.lerp(a[1], b[1], t)]);
    }
  }
  dense.push(points[points.length - 1]);
  return dense;
}

function makePaths(map: TeaGardenTerrain, pathMat: THREE.Material, stepMat: THREE.Material): THREE.Group {
  const waterMargin = 0.2;
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_paths";
  for (const path of TEA_GARDEN_PATHS) {
    if (path.kind === "bridge") continue;
    const points = densify(path.points);
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dz = next[1] - prev[1];
      const inv = 1 / (Math.hypot(dx, dz) || 1);
      const nx = -dz * inv * path.width * 0.5;
      const nz = dx * inv * path.width * 0.5;
      for (const side of [-1, 1]) {
        const x = points[i][0] + nx * side;
        const z = points[i][1] + nz * side;
        positions.push(x, map.groundTop(x, z) + 0.075, z);
      }
    }
    const appendIfDry = (a: number, b: number, c: number) => {
      const x = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
      const z = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
      if (!inTeaGardenWater(x, z, waterMargin)) indices.push(a, b, c);
    };
    for (let i = 0; i + 1 < points.length; i++) {
      const base = i * 2;
      appendIfDry(base, base + 1, base + 2);
      appendIfDry(base + 1, base + 3, base + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, path.kind === "steps" ? stepMat : pathMat);
    mesh.name = `tea_garden_${path.kind}_${path.name.replaceAll(" ", "_")}`;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

function makeStraightBridge(
  map: TeaGardenTerrain,
  mats: ReturnType<typeof createMaterials>,
  physics: Physics | undefined,
  bodies: number[]
): THREE.Group {
  const path = TEA_GARDEN_PATHS.find((entry) => entry.name === "long bridge")!;
  const a = path.points[0];
  const b = path.points[path.points.length - 1];
  const cx = (a[0] + b[0]) / 2;
  const cz = (a[1] + b[1]) / 2;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
  const y = Math.max(map.groundTop(a[0], a[1]), map.groundTop(b[0], b[1])) + 0.44;
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_long_bridge";
  group.add(makeBox("long_bridge_deck", [2.25, 0.24, length], mats.timber, [cx, y, cz], yaw));
  for (let i = 0; i <= Math.floor(length / 0.7); i++) {
    const t = i / Math.floor(length / 0.7);
    const x = THREE.MathUtils.lerp(a[0], b[0], t);
    const z = THREE.MathUtils.lerp(a[1], b[1], t);
    group.add(makeBox("long_bridge_plank", [2.32, 0.055, 0.56], mats.timberDark, [x, y + 0.14, z], yaw));
  }
  const side = new THREE.Vector3(1.24, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  for (const sign of [-1, 1]) {
    group.add(makeRailing(length, cx + side.x * sign, y + 0.08, cz + side.z * sign, yaw + Math.PI / 2, mats.vermilionDark));
  }
  addPhysicsBox(physics, bodies, { x: cx, y, z: cz, hx: 1.12, hy: 0.18, hz: length / 2, yaw });
  return group;
}

function makeDrumBridge(
  map: TeaGardenTerrain,
  mats: ReturnType<typeof createMaterials>,
  physics: Physics | undefined,
  bodies: number[]
): THREE.Group {
  const a = new THREE.Vector3(-2274.81, 0, 2196.14);
  const b = new THREE.Vector3(-2273.11, 0, 2189.91);
  const baseY = Math.max(map.groundTop(a.x, a.z), map.groundTop(b.x, b.z)) + 0.18;
  const count = 18;
  const rise = 3.12;
  const width = 1.82;
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_drum_bridge";
  const curvePoints: THREE.Vector3[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    curvePoints.push(new THREE.Vector3(
      THREE.MathUtils.lerp(a.x, b.x, t),
      baseY + Math.sin(Math.PI * t) * rise,
      THREE.MathUtils.lerp(a.z, b.z, t)
    ));
  }

  const forward = b.clone().sub(a).setY(0).normalize();
  const right = new THREE.Vector3(forward.z, 0, -forward.x);
  const upAxis = new THREE.Vector3(0, 1, 0);
  const yaw = Math.atan2(forward.x, forward.z);
  const treadQuaternion = new THREE.Quaternion().setFromAxisAngle(upAxis, yaw);
  const treadGeometry = new THREE.BoxGeometry(1, 1, 1);
  const treads = new THREE.InstancedMesh(treadGeometry, mats.bridgeTimber, count);
  treads.name = "drum_bridge_worn_stair_treads";
  const risers = new THREE.InstancedMesh(treadGeometry, mats.bridgeTimberPaint, count);
  risers.name = "drum_bridge_painted_stair_risers";
  const nosings = new THREE.InstancedMesh(treadGeometry, mats.bridgeTimberPaint, count);
  nosings.name = "drum_bridge_rounded_stair_nosings";
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const p0 = curvePoints[i];
    const p1 = curvePoints[i + 1];
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    const length = Math.hypot(p1.x - p0.x, p1.z - p0.z) + 0.075;
    // Horizontal stair treads, not a smooth black ramp. Each rises to the high
    // end of its segment, creating the real bridge's deliberate steep steps.
    mid.y = Math.max(p0.y, p1.y) - 0.055;
    dummy.position.copy(mid);
    dummy.quaternion.copy(treadQuaternion);
    dummy.scale.set(width, 0.14, length);
    dummy.updateMatrix();
    treads.setMatrixAt(i, dummy.matrix);
    treads.setColorAt(i, new THREE.Color(i % 3 === 0 ? 0xffffff : i % 2 ? 0xf5f0e9 : 0xeae3da));

    const high = p1.y >= p0.y ? p1 : p0;
    const low = high === p1 ? p0 : p1;
    const towardLow = high === p1 ? -1 : 1;
    const riserHeight = Math.max(0.08, high.y - low.y - 0.04);
    dummy.position.copy(high).addScaledVector(forward, towardLow * 0.035);
    dummy.position.y = high.y - riserHeight / 2 - 0.055;
    dummy.quaternion.copy(treadQuaternion);
    dummy.scale.set(width - 0.08, riserHeight, 0.085);
    dummy.updateMatrix();
    risers.setMatrixAt(i, dummy.matrix);

    dummy.position.copy(high).addScaledVector(forward, towardLow * 0.015);
    dummy.position.y = high.y - 0.005;
    dummy.scale.set(width + 0.045, 0.085, 0.12);
    dummy.updateMatrix();
    nosings.setMatrixAt(i, dummy.matrix);

    const q = [treadQuaternion.x, treadQuaternion.y, treadQuaternion.z, treadQuaternion.w] as const;
    addPhysicsBox(physics, bodies, { x: mid.x, y: mid.y, z: mid.z, hx: width / 2, hy: 0.08, hz: length / 2, quat: q });
  }
  for (const mesh of [treads, risers, nosings]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (treads.instanceColor) treads.instanceColor.needsUpdate = true;

  // Six laminated load-bearing ribs are the bridge's defining underside.
  const ribCurve = new THREE.CatmullRomCurve3(
    curvePoints.map((point) => point.clone().add(new THREE.Vector3(0, -0.34, 0)))
  );
  const rectangularPathGeometry = (
    curve: THREE.Curve<THREE.Vector3>,
    width: number,
    height: number
  ) => {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, -height / 2);
    shape.lineTo(width / 2, -height / 2);
    shape.lineTo(width / 2, height / 2);
    shape.lineTo(-width / 2, height / 2);
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, {
      steps: 64,
      bevelEnabled: false,
      extrudePath: curve
    });
  };
  const ribGeometry = rectangularPathGeometry(ribCurve, 0.12, 0.24);
  const ribs = new THREE.InstancedMesh(ribGeometry, mats.bridgeTimberDark, 6);
  ribs.name = "drum_bridge_six_laminated_arch_ribs";
  [-0.7, -0.42, -0.14, 0.14, 0.42, 0.7].forEach((offset, index) => {
    dummy.position.copy(right).multiplyScalar(offset);
    dummy.quaternion.identity();
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    ribs.setMatrixAt(index, dummy.matrix);
  });
  ribs.instanceMatrix.needsUpdate = true;
  ribs.computeBoundingSphere();
  ribs.castShadow = true;
  ribs.receiveShadow = true;
  group.add(ribs);

  // Broad outer arch fascias frame the six structural laminations in profile,
  // matching the bridge's recognisable layered silhouette from the stream.
  const fasciaGeometry = rectangularPathGeometry(ribCurve, 0.2, 0.36);
  const fascias = new THREE.InstancedMesh(fasciaGeometry, mats.bridgeTimberPaint, 2);
  fascias.name = "drum_bridge_layered_outer_arch_fascias";
  for (const sign of [-1, 1]) {
    dummy.position.copy(right).multiplyScalar(sign * (width / 2 - 0.02));
    dummy.quaternion.identity();
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    fascias.setMatrixAt(sign === -1 ? 0 : 1, dummy.matrix);
  }
  fascias.instanceMatrix.needsUpdate = true;
  fascias.computeBoundingSphere();
  fascias.castShadow = true;
  fascias.receiveShadow = true;
  group.add(fascias);

  // The real upper rails are rounded where hands touch them; the lower rails
  // remain rectangular laminated members connected into the post joinery.
  const rails = new THREE.Group();
  rails.name = "drum_bridge_joined_upper_and_lower_rails";
  const railCurve = new THREE.CatmullRomCurve3(curvePoints);
  const handrailGeometry = new THREE.TubeGeometry(railCurve, 72, 0.075, 10, false);
  const handrails = new THREE.InstancedMesh(handrailGeometry, mats.bridgeTimberPaint, 2);
  handrails.name = "drum_bridge_round_handrails";
  const lowerRailGeometry = rectangularPathGeometry(railCurve, 0.12, 0.15);
  const lowerRails = new THREE.InstancedMesh(lowerRailGeometry, mats.bridgeTimberPaint, 2);
  lowerRails.name = "drum_bridge_laminated_lower_rails";
  for (const sign of [-1, 1]) {
    const index = sign === -1 ? 0 : 1;
    dummy.position.copy(right).multiplyScalar(sign * (width / 2 + 0.1));
    dummy.position.y = 1.06;
    dummy.quaternion.identity();
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    handrails.setMatrixAt(index, dummy.matrix);
    dummy.position.y = 0.55;
    dummy.updateMatrix();
    lowerRails.setMatrixAt(index, dummy.matrix);
  }
  for (const mesh of [handrails, lowerRails]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    rails.add(mesh);
  }
  group.add(rails);

  const postCountPerSide = Math.floor(count / 2) + 1;
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mats.bridgeTimberPaint, postCountPerSide * 2);
  posts.name = "drum_bridge_square_balustrade_posts";
  const postCaps = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.115, 0.145, 0.065, 10),
    mats.bridgeTimberPaint,
    postCountPerSide * 2
  );
  postCaps.name = "drum_bridge_post_joinery_caps";
  const postPoints: { point: THREE.Vector3; sign: number }[] = [];
  let postIndex = 0;
  for (const sign of [-1, 1]) {
    for (let i = 0; i <= count; i += 2) {
      const point = curvePoints[i];
      postPoints.push({ point, sign });
      dummy.position.copy(point).addScaledVector(right, sign * (width / 2 + 0.09));
      dummy.position.y += 0.54;
      dummy.quaternion.identity();
      dummy.scale.set(0.16, 0.9, 0.16);
      dummy.updateMatrix();
      posts.setMatrixAt(postIndex, dummy.matrix);
      dummy.position.y = point.y + 1.005;
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      postCaps.setMatrixAt(postIndex, dummy.matrix);
      postIndex++;
    }
  }
  for (const mesh of [posts, postCaps]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Recessed wooden peg heads make the post/rail joinery legible in close tour
  // shots without adding a separate draw for every fastener.
  const pegs = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.034, 0.034, 0.028, 9),
    mats.bridgeTimberDark,
    postPoints.length * 2
  );
  pegs.name = "drum_bridge_visible_joinery_pegs";
  let pegIndex = 0;
  for (const { point, sign } of postPoints) {
    const outward = right.clone().multiplyScalar(sign);
    const pegQuaternion = new THREE.Quaternion().setFromUnitVectors(upAxis, outward);
    for (const height of [0.55, 0.91]) {
      dummy.position.copy(point).addScaledVector(right, sign * (width / 2 + 0.185));
      dummy.position.y += height;
      dummy.quaternion.copy(pegQuaternion);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      pegs.setMatrixAt(pegIndex++, dummy.matrix);
    }
  }
  pegs.instanceMatrix.needsUpdate = true;
  pegs.computeBoundingSphere();
  pegs.castShadow = true;
  group.add(pegs);

  // Four turned finials terminate the handrails at the landings, echoing the
  // original bridge's welcoming ball-capped entrance posts.
  const finialProfile = [
    new THREE.Vector2(0.085, 0),
    new THREE.Vector2(0.115, 0.055),
    new THREE.Vector2(0.082, 0.105),
    new THREE.Vector2(0.105, 0.15),
    new THREE.Vector2(0.145, 0.225),
    new THREE.Vector2(0.11, 0.3),
    new THREE.Vector2(0.055, 0.345),
    new THREE.Vector2(0, 0.36)
  ];
  const finials = new THREE.InstancedMesh(new THREE.LatheGeometry(finialProfile, 14), mats.bridgeTimberPaint, 4);
  finials.name = "drum_bridge_turned_landing_finials";
  let finialIndex = 0;
  for (const point of [curvePoints[0], curvePoints[count]]) {
    for (const sign of [-1, 1]) {
      dummy.position.copy(point).addScaledVector(right, sign * (width / 2 + 0.09));
      dummy.position.y += 0.965;
      dummy.quaternion.identity();
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      finials.setMatrixAt(finialIndex++, dummy.matrix);
    }
  }
  finials.instanceMatrix.needsUpdate = true;
  finials.computeBoundingSphere();
  finials.castShadow = true;
  group.add(finials);

  // Damp, irregular abutment stones conceal the rib ends in the planting.
  const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
  const abutments = new THREE.InstancedMesh(rockGeometry, mats.stoneDark, 12);
  abutments.name = "drum_bridge_mossy_rock_abutments";
  let rockIndex = 0;
  for (const endpoint of [a, b]) {
    for (let index = 0; index < 6; index++) {
      const side = index < 3 ? -1 : 1;
      const along = ((index % 3) - 1) * 0.48;
      const x = endpoint.x + right.x * side * (0.86 + (index % 2) * 0.32) + forward.x * along;
      const z = endpoint.z + right.z * side * (0.86 + (index % 2) * 0.32) + forward.z * along;
      const scale = 0.42 + (index % 3) * 0.12;
      dummy.position.set(x, map.groundTop(x, z) + scale * 0.24, z);
      dummy.rotation.set(index * 0.17, index * 0.83, index * 0.11);
      dummy.scale.set(scale * 1.25, scale * 0.72, scale);
      dummy.updateMatrix();
      abutments.setMatrixAt(rockIndex++, dummy.matrix);
    }
  }
  abutments.instanceMatrix.needsUpdate = true;
  abutments.computeBoundingSphere();
  abutments.castShadow = true;
  abutments.receiveShadow = true;
  group.add(abutments);
  return group;
}

const KOI_WATER_MARGIN = 0.46;
const KOI_BODY_HALF_HEIGHT = 0.22 * 0.31;
const KOI_TRACK_LOOKAHEAD = 0.012;

type KoiRuntime = {
  body: THREE.InstancedMesh;
  tail: THREE.InstancedMesh;
  center: THREE.Vector3;
  rx: number;
  rz: number;
  outline: readonly TeaGardenXZ[];
};

type MutableKoiPosition = { x: number; z: number };

function distanceToKoiOutline(x: number, z: number, outline: readonly TeaGardenXZ[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0
      ? THREE.MathUtils.clamp(((x - a[0]) * dx + (z - a[1]) * dz) / lengthSq, 0, 1)
      : 0;
    distance = Math.min(distance, Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)));
  }
  return distance;
}

function insideKoiWaterLane(
  x: number,
  z: number,
  outline: readonly TeaGardenXZ[]
): boolean {
  return (
    pointInTeaGardenPolygon(x, z, outline) &&
    distanceToKoiOutline(x, z, outline) >= KOI_WATER_MARGIN
  );
}

/**
 * Pull an orbital sample back toward a known wet anchor until the complete koi
 * silhouette has bank clearance. This preserves the existing leisurely loops
 * while making the authored polygon—not an ellipse—the final authority.
 */
function sampleConstrainedKoiTrack(
  pond: KoiRuntime,
  angle: number,
  wobble: number,
  out: MutableKoiPosition
): void {
  const candidateX = pond.center.x + Math.cos(angle) * pond.rx * wobble;
  const candidateZ = pond.center.z + Math.sin(angle) * pond.rz * wobble;
  if (insideKoiWaterLane(candidateX, candidateZ, pond.outline)) {
    out.x = candidateX;
    out.z = candidateZ;
    return;
  }

  let wetX = pond.center.x;
  let wetZ = pond.center.z;
  let dryX = candidateX;
  let dryZ = candidateZ;
  for (let iteration = 0; iteration < 12; iteration++) {
    const midX = (wetX + dryX) * 0.5;
    const midZ = (wetZ + dryZ) * 0.5;
    if (insideKoiWaterLane(midX, midZ, pond.outline)) {
      wetX = midX;
      wetZ = midZ;
    } else {
      dryX = midX;
      dryZ = midZ;
    }
  }
  out.x = wetX;
  out.z = wetZ;
}

function createPondLife(): { group: THREE.Group; koi: KoiRuntime[] } {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_pond_life";
  const koi: KoiRuntime[] = [];
  TEA_GARDEN_WATER_FEATURES.forEach((feature, pondIndex) => {
    const name = feature.name.toLowerCase().replaceAll(" ", "_");
    const c = pondIndex === 0 ? { x: -2288.7, z: 2219.2 } : { x: -2274.2, z: 2193.2 };
    const rx = pondIndex === 0 ? 7.4 : 1.45;
    const rz = pondIndex === 0 ? 8.2 : 2.25;
    const count = pondIndex === 0 ? 10 : 6;
    const fishGeometry = new THREE.SphereGeometry(0.22, 10, 6);
    fishGeometry.scale(1.65, 0.31, 0.48);
    const tailGeometry = new THREE.BufferGeometry();
    tailGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([
        0.04, 0, 0,
        -0.24, 0, -0.16,
        -0.24, 0, 0.16
      ], 3)
    );
    tailGeometry.computeVertexNormals();
    const fishMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.55,
      metalness: 0,
      // The shared water layer correctly draws over the submerged school. A
      // restrained warm lift keeps orange and white koi readable at dusk
      // without making them look self-lit above the surface.
      emissive: 0x6b2e16,
      emissiveIntensity: 0.24,
      side: THREE.DoubleSide
    });
    const fish = new THREE.InstancedMesh(fishGeometry, fishMaterial, count);
    const tails = new THREE.InstancedMesh(tailGeometry, fishMaterial, count);
    fish.name = `${name}_koi`;
    tails.name = `${name}_koi_tails`;
    fish.castShadow = false;
    fish.receiveShadow = false;
    tails.castShadow = false;
    tails.receiveShadow = false;
    fish.frustumCulled = false;
    tails.frustumCulled = false;
    fish.renderOrder = 4;
    tails.renderOrder = 4;
    fish.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    tails.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const colors = [0xd8692e, 0xf1e6cc, 0xc94c32, 0xe29d3f];
    for (let i = 0; i < count; i++) {
      const color = new THREE.Color(colors[(i + pondIndex) % colors.length]);
      fish.setColorAt(i, color);
      tails.setColorAt(i, color);
    }
    if (fish.instanceColor) fish.instanceColor.needsUpdate = true;
    if (tails.instanceColor) tails.instanceColor.needsUpdate = true;
    fish.userData.authoredWaterFeature = feature.name;
    fish.userData.bankClearance = KOI_WATER_MARGIN;
    tails.userData.authoredWaterFeature = feature.name;
    tails.userData.bankClearance = KOI_WATER_MARGIN;
    group.add(fish, tails);
    const runtime = {
      body: fish,
      tail: tails,
      center: new THREE.Vector3(c.x, 0, c.z),
      rx,
      rz,
      outline: feature.outline
    };
    if (!insideKoiWaterLane(runtime.center.x, runtime.center.z, runtime.outline)) {
      throw new Error(`${feature.name} koi anchor is outside its authored water lane`);
    }
    koi.push(runtime);
  });
  return { group, koi };
}

function createMaterials() {
  const bridgeTimber = new THREE.MeshStandardMaterial({
    color: 0xb5aaa0,
    roughness: 0.96,
    metalness: 0,
    vertexColors: true
  });
  const bridgeTimberPaint = new THREE.MeshStandardMaterial({
    color: 0x8d5b4c,
    roughness: 0.84,
    metalness: 0
  });
  const bridgeTimberDark = new THREE.MeshStandardMaterial({
    color: 0x5f4038,
    roughness: 0.92,
    metalness: 0
  });
  const textureRoot = "/japanese-tea-garden/drum-bridge";
  const configure = (texture: THREE.Texture, name: string, repeatX: number, repeatY: number) => {
    texture.name = name;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    texture.needsUpdate = true;
  };
  const ready = Promise.all([
    loadTexture(`${textureRoot}/painted-timber-basecolor`, { srgb: true, anisotropy: 8 }),
    loadTexture(`${textureRoot}/painted-timber-normal`, { srgb: false, anisotropy: 8 }),
    loadTexture(`${textureRoot}/worn-timber-basecolor`, { srgb: true, anisotropy: 8 }),
    loadTexture(`${textureRoot}/worn-timber-normal`, { srgb: false, anisotropy: 8 })
  ]).then(([paintedColor, paintedNormal, wornColor, wornNormal]) => {
    configure(paintedColor, "drum_bridge_painted_timber_basecolor", 4.25, 1.6);
    configure(paintedNormal, "drum_bridge_painted_timber_normal", 4.25, 1.6);
    configure(wornColor, "drum_bridge_worn_timber_basecolor", 3.25, 1.35);
    configure(wornNormal, "drum_bridge_worn_timber_normal", 3.25, 1.35);

    bridgeTimber.color.setHex(0xffffff);
    bridgeTimber.map = wornColor;
    bridgeTimber.normalMap = wornNormal;
    bridgeTimber.normalScale.set(0.42, 0.42);
    bridgeTimber.needsUpdate = true;

    bridgeTimberPaint.color.setHex(0xffffff);
    bridgeTimberPaint.map = paintedColor;
    bridgeTimberPaint.normalMap = paintedNormal;
    bridgeTimberPaint.normalScale.set(0.5, 0.5);
    bridgeTimberPaint.needsUpdate = true;

    bridgeTimberDark.color.setHex(0xa58c82);
    bridgeTimberDark.map = paintedColor;
    bridgeTimberDark.normalMap = paintedNormal;
    bridgeTimberDark.normalScale.set(0.38, 0.38);
    bridgeTimberDark.needsUpdate = true;
  }).catch((error) => {
    console.warn("[tea-garden] drum bridge texture load failed; keeping material fallbacks:", error);
  });

  return {
    vermilion: material(COLORS.vermilion, 0.72),
    vermilionDark: material(COLORS.vermilionDark, 0.76),
    timber: material(COLORS.timber, 0.84),
    timberDark: material(COLORS.timberDark, 0.88),
    plaster: material(COLORS.plaster, 0.95),
    shoji: material(COLORS.shoji, 0.9),
    roof: material(COLORS.roof, 0.68, 0.08),
    stone: material(COLORS.stone, 1),
    stoneDark: material(COLORS.stoneDark, 1),
    tatsuyama: material(0x8d897b, 0.98),
    path: material(COLORS.path, 0.98),
    pathEdge: material(COLORS.pathEdge, 1),
    bronze: material(0x8a6b31, 0.48, 0.44),
    iron: material(0x272625, 0.5, 0.45),
    tatami: material(0xb4a46f, 0.98),
    bridgeTimber,
    bridgeTimberPaint,
    bridgeTimberDark,
    ready
  };
}

function makePeaceLantern(map: TeaGardenTerrain, mats: ReturnType<typeof createMaterials>): THREE.Group {
  const x = -2338.15;
  const z = 2199.5;
  const y = map.groundTop(x, z);
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_lantern_of_peace";
  group.add(makeBox("peace_lantern_base", [2.2, 0.42, 2.2], mats.stone, [x, y + 0.21, z]));
  group.add(makeBox("peace_lantern_stem", [0.72, 2.2, 0.72], mats.stone, [x, y + 1.5, z]));
  group.add(makeBox("peace_lantern_light_box", [1.55, 1.2, 1.55], mats.stone, [x, y + 3.12, z]));
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 1.35, 0.55, 4), mats.stoneDark);
  cap.name = "peace_lantern_cap";
  cap.position.set(x, y + 4, z);
  cap.rotation.y = Math.PI / 4;
  cap.castShadow = true;
  group.add(cap);
  const jewel = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 7), mats.stoneDark);
  jewel.name = "peace_lantern_jewel";
  jewel.position.set(x, y + 4.55, z);
  group.add(jewel);
  return group;
}

function makeStoneLantern(x: number, z: number, map: TeaGardenTerrain, mats: ReturnType<typeof createMaterials>): THREE.Group {
  const y = map.groundTop(x, z);
  const group = new THREE.Group();
  group.name = "tea_garden_stone_lantern";
  group.add(makeBox("stone_lantern_base", [0.75, 0.18, 0.75], mats.stone, [x, y + 0.09, z]));
  group.add(makeBox("stone_lantern_stem", [0.24, 1.15, 0.24], mats.stone, [x, y + 0.75, z]));
  group.add(makeBox("stone_lantern_box", [0.65, 0.52, 0.65], mats.stone, [x, y + 1.52, z]));
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.62, 0.28, 4), mats.stoneDark);
  cap.position.set(x, y + 1.93, z);
  cap.rotation.y = Math.PI / 4;
  group.add(cap);
  return group;
}

function makeWaterfall(map: TeaGardenTerrain, mats: ReturnType<typeof createMaterials>): THREE.Group {
  const x = -2307.4;
  const z = 2210.6;
  const base = map.groundTop(x, z) + 0.2;
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_waterfall";
  for (let i = 0; i < 11; i++) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.75 + (i % 3) * 0.28, 0), mats.stoneDark);
    rock.name = "waterfall_boulder";
    rock.scale.set(1.35, 0.78, 1.05);
    rock.position.set(x + ((i * 1.71) % 4.4) - 2.2, base + (i % 4) * 0.68, z + ((i * 2.13) % 3.4) - 1.7);
    rock.rotation.set(i * 0.21, i * 0.73, i * 0.16);
    rock.castShadow = true;
    rock.receiveShadow = true;
    group.add(rock);
  }
  const fallMat = alphaSurface(new THREE.MeshStandardMaterial({
    color: 0xa7d6d1,
    roughness: 0.18,
    metalness: 0,
    opacity: 0.82,
    side: THREE.DoubleSide,
    envMapIntensity: 0.4
  }));
  for (let i = 0; i < 3; i++) {
    const fall = makeBox("waterfall_ribbon", [0.48 + i * 0.2, 2.4 - i * 0.35, 0.055], fallMat, [x - 0.55 + i * 0.52, base + 1.55 - i * 0.28, z - 0.45 + i * 0.28], 0.28);
    fall.castShadow = false;
    fall.renderOrder = WATER_EFFECTS_RENDER_ORDER;
    group.add(fall);
  }
  return group;
}

export function createTeaGardenArchitecture(
  map: TeaGardenTerrain,
  physics?: Physics,
  waterSurfaceY?: (x: number, z: number) => number
): TeaGardenArchitecture {
  const mats = createMaterials();
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_architecture";
  const bodies: number[] = [];

  group.add(makePaths(map, mats.path, mats.pathEdge));
  const pondLife = createPondLife();
  group.add(pondLife.group);
  group.add(makeStraightBridge(map, mats, physics, bodies));
  group.add(makeDrumBridge(map, mats, physics, bodies));

  for (const spec of TEA_GARDEN_BUILDINGS) {
    if (spec.kind === "tea-house") group.add(makeTeaHouse(map, spec, mats, physics, bodies));
    else if (spec.kind === "gift-shop") group.add(makeGiftShop(map, spec, mats, physics, bodies));
    else if (spec.kind === "pagoda") group.add(makePagoda(map, spec, mats, physics, bodies));
    else if (spec.kind === "turnstile-house") group.add(makeTurnstileHouse(map, spec, mats, physics, bodies));
    else group.add(makeGate(map, spec, mats, physics, bodies));
  }

  // Redesigned 2024 Pagoda Plaza: an intentionally open permeable stone field.
  const plazaY = map.groundTop(-2322.5, 2199.3) + 0.08;
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(12.8, 13.2, 0.18, 48), mats.tatsuyama);
  plaza.name = "japanese_tea_garden_pagoda_plaza";
  plaza.position.set(-2322.5, plazaY, 2199.3);
  plaza.receiveShadow = true;
  // Add before the pagoda visually would be ideal, but depth makes this stable at ground level.
  group.add(plaza);

  group.add(makePeaceLantern(map, mats));
  for (const [x, z] of [
    [-2261.2, 2188.1], [-2287.6, 2200.2], [-2310.2, 2210.4], [-2293.4, 2151.5], [-2347.2, 2189.6]
  ] as const) {
    group.add(makeStoneLantern(x, z, map, mats));
  }
  group.add(makeWaterfall(map, mats));

  const koiCount = pondLife.koi.reduce((sum, pond) => sum + pond.body.count, 0);
  const stats: TeaGardenArchitectureStats = {
    meshes: 0,
    ponds: pondLife.koi.length,
    koi: koiCount,
    physicsBodies: 0,
    koiInWater: 0,
    koiSubmerged: 0,
    koiMinSubmersion: 0,
    koiTailStrokes: 0
  };
  const dummy = new THREE.Object3D();
  const koiPosition: MutableKoiPosition = { x: 0, z: 0 };
  const koiAhead: MutableKoiPosition = { x: 0, z: 0 };
  const lastTailStroke = pondLife.koi.map((pond) => new Int32Array(pond.body.count).fill(-2147483648));
  const update = (time: number, visitKoi?: TeaGardenKoiVisitor) => {
    stats.koiInWater = 0;
    stats.koiSubmerged = 0;
    stats.koiMinSubmersion = Number.POSITIVE_INFINITY;
    pondLife.koi.forEach((pond, pondIndex) => {
      for (let i = 0; i < pond.body.count; i++) {
        const speed = 0.11 + (i % 4) * 0.018;
        const angle = time * speed + (i / pond.body.count) * Math.PI * 2 + pondIndex * 0.7;
        const wobble = 0.74 + (i % 3) * 0.09;
        sampleConstrainedKoiTrack(pond, angle, wobble, koiPosition);
        sampleConstrainedKoiTrack(pond, angle + KOI_TRACK_LOOKAHEAD, wobble, koiAhead);
        const x = koiPosition.x;
        const z = koiPosition.z;
        const velocityScale = speed / KOI_TRACK_LOOKAHEAD;
        const velocityX = (koiAhead.x - x) * velocityScale;
        const velocityZ = (koiAhead.z - z) * velocityScale;
        const swimSpeed = Math.max(Math.hypot(velocityX, velocityZ), 1e-5);
        const forwardX = velocityX / swimSpeed;
        const forwardZ = velocityZ / swimSpeed;
        const surface = waterSurfaceY?.(x, z);
        const swimDepth = 0.115
          + (Math.sin(angle * 0.63 + i * 1.73 + pondIndex * 0.9) * 0.5 + 0.5) * 0.105;
        const y = surface === undefined
          ? map.groundTop(x, z) + 0.1
          : surface - swimDepth + Math.sin(angle * 2.1 + i) * 0.004;
        const scale = 0.62 + (i % 4) * 0.075;
        const heading = Math.atan2(-forwardZ, forwardX);
        const tailRate = 6.3 + (i % 4) * 0.58;
        const tailPhase = time * tailRate + i * 1.37 + pondIndex * 0.83;
        const tailSide = Math.sin(tailPhase) >= 0 ? 1 : -1;
        const tailStroke = Math.floor((tailPhase + Math.PI * 0.5) / Math.PI);
        const tailSwing = Math.sin(tailPhase) * 0.42;

        dummy.position.set(x, y, z);
        dummy.rotation.set(0, heading, tailSwing * 0.055);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        pond.body.setMatrixAt(i, dummy.matrix);

        dummy.position.set(
          x - forwardX * 0.29 * scale,
          y,
          z - forwardZ * 0.29 * scale
        );
        dummy.rotation.set(0, heading + tailSwing, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        pond.tail.setMatrixAt(i, dummy.matrix);

        if (pointInTeaGardenPolygon(x, z, pond.outline)) stats.koiInWater++;
        if (surface !== undefined) {
          const topSubmersion = surface - (y + KOI_BODY_HALF_HEIGHT * scale);
          if (topSubmersion > 0) stats.koiSubmerged++;
          stats.koiMinSubmersion = Math.min(stats.koiMinSubmersion, topSubmersion);
        }
        if (lastTailStroke[pondIndex][i] !== tailStroke) {
          if (lastTailStroke[pondIndex][i] !== -2147483648) stats.koiTailStrokes++;
          lastTailStroke[pondIndex][i] = tailStroke;
        }
        if (visitKoi && surface !== undefined) {
          visitKoi(
            pondIndex * 32 + i,
            x,
            y,
            z,
            velocityX,
            velocityZ,
            surface - y,
            tailStroke,
            tailSide
          );
        }
      }
      pond.body.instanceMatrix.needsUpdate = true;
      pond.tail.instanceMatrix.needsUpdate = true;
    });
    if (!Number.isFinite(stats.koiMinSubmersion)) stats.koiMinSubmersion = 0;
  };

  let meshCount = 0;
  const lightUnregisters: (() => void)[] = [];
  group.traverse((object) => {
    if (object.userData.lightSpec) lightUnregisters.push(registerAmbientLightAnchor(object));
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount++;
  });
  stats.meshes = meshCount;
  stats.physicsBodies = bodies.length;

  return {
    group,
    // Compatibility alias for callers that previously addressed the authored
    // static water group; the group now contains only pond life.
    waterGroup: pondLife.group,
    ready: mats.ready,
    update,
    dispose() {
      for (const unregister of lightUnregisters) unregister();
      lightUnregisters.length = 0;
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const entry of list) {
          materials.add(entry);
          const textured = entry as THREE.Material & {
            map?: THREE.Texture | null;
            normalMap?: THREE.Texture | null;
            roughnessMap?: THREE.Texture | null;
          };
          if (textured.map) textures.add(textured.map);
          if (textured.normalMap) textures.add(textured.normalMap);
          if (textured.roughnessMap) textures.add(textured.roughnessMap);
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const entry of materials) entry.dispose();
      for (const texture of textures) texture.dispose();
      if (physics) {
        for (const body of bodies) {
          physics.removeQuerySolid(body);
          physics.world.destroyBody(body);
        }
      }
      bodies.length = 0;
      group.removeFromParent();
    },
    stats
  };
}
