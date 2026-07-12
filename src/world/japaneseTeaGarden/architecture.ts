import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import { applyMaterialPolicy, RenderBand, tagTransparency } from "../../render/transparency";
import {
  TEA_GARDEN_BUILDINGS,
  TEA_GARDEN_PATHS,
  TEA_GARDEN_WATER_FEATURES,
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
  pathEdge: 0x5e5d54,
  water: 0x507f77,
  waterDeep: 0x244d49
} as const;

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
  update(time: number): void;
  dispose(): void;
  stats: { meshes: number; ponds: number; koi: number; physicsBodies: number };
};

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
  const foundationBottom = lowGrade - 0.12;
  const foundationTop = grade + 0.3;
  const foundationHeight = foundationTop - foundationBottom;
  group.add(makeBox(
    "tea_house_stone_foundation",
    [11.4, foundationHeight, 9.2],
    mats.stoneDark,
    [c.x, foundationBottom + foundationHeight / 2, c.z],
    yaw
  ));
  group.add(makeBox("tea_house_veranda", [12.2, 0.28, 9.9], mats.timber, [c.x, grade + 0.48, c.z], yaw));
  group.add(makeBox("tea_house_core", [8.7, 2.65, 6.5], mats.plaster, [c.x, grade + 1.9, c.z], yaw));

  const local = new THREE.Vector3();
  const world = (lx: number, ly: number, lz: number) => {
    local.set(lx, ly, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    return [c.x + local.x, grade + local.y, c.z + local.z] as const;
  };
  group.add(makeShojiWall(7.6, 2.15, ...world(0, 2.02, 3.31), yaw, mats.shoji, mats.timberDark));
  group.add(makeShojiWall(7.6, 2.15, ...world(0, 2.02, -3.31), yaw + Math.PI, mats.shoji, mats.timberDark));
  group.add(makeShojiWall(5.55, 2.15, ...world(4.36, 2.02, 0), yaw + Math.PI / 2, mats.shoji, mats.timberDark));
  group.add(makeShojiWall(5.55, 2.15, ...world(-4.36, 2.02, 0), yaw - Math.PI / 2, mats.shoji, mats.timberDark));
  group.add(makeRailing(10.8, ...world(0, 0.48, 4.55), yaw, mats.timberDark));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = world(sx * 4.05, 1.84, sz * 2.95);
      group.add(makeBox("tea_house_post", [0.2, 2.85, 0.2], mats.timberDark, p, yaw));
    }
  }
  group.add(makeRoof("tea_house_roof", 12.8, 10.4, 2.25, c.x, grade + 3.28, c.z, yaw, mats.roof, mats.vermilionDark));

  // Small irori table and ceremonial tea set visible from the south veranda.
  const tableP = world(0.7, 1.01, 1.45);
  group.add(makeBox("tea_house_irori", [2.2, 0.42, 1.25], mats.timberDark, tableP, yaw));
  const kettle = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), mats.iron);
  kettle.name = "tea_house_kettle";
  kettle.position.set(...world(0.7, 1.43, 1.45));
  kettle.castShadow = true;
  group.add(kettle);

  const collisionTop = grade + 3.25;
  addPhysicsBox(physics, bodies, {
    x: c.x,
    y: (foundationBottom + collisionTop) / 2,
    z: c.z,
    hx: 4.35,
    hy: (collisionTop - foundationBottom) / 2,
    hz: 3.25,
    yaw
  });
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
    for (let i = 0; i + 1 < points.length; i++) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
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
  const rise = 3.25;
  const width = 2.15;
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
  for (let i = 0; i < count; i++) {
    const p0 = curvePoints[i];
    const p1 = curvePoints[i + 1];
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    const tangent = p1.clone().sub(p0).normalize();
    // X=right and Z=tangent require Y=ZxX for a right-handed basis. Reversing
    // this cross product produces a reflection that a quaternion cannot encode.
    const up = new THREE.Vector3().crossVectors(tangent, right).normalize();
    const matrix = new THREE.Matrix4().makeBasis(right, up, tangent);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
    const length = p0.distanceTo(p1) + 0.055;
    const plank = new THREE.Mesh(new THREE.BoxGeometry(width, 0.13, length), i % 2 ? mats.timber : mats.timberDark);
    plank.name = "drum_bridge_plank";
    plank.position.copy(mid);
    plank.quaternion.copy(quaternion);
    // A few planks plus both continuous rails carry the bridge silhouette; every
    // individual slat in every shadow cascade is unnecessary.
    plank.castShadow = i % 3 === 0;
    plank.receiveShadow = true;
    group.add(plank);
    const q = [quaternion.x, quaternion.y, quaternion.z, quaternion.w] as const;
    addPhysicsBox(physics, bodies, { x: mid.x, y: mid.y, z: mid.z, hx: width / 2, hy: 0.08, hz: length / 2, quat: q });

    if (i % 2 === 0) {
      for (const sign of [-1, 1]) {
        const post = makeBox(
          "drum_bridge_post",
          [0.12, 1.05, 0.12],
          mats.vermilionDark,
          [mid.x + right.x * sign * (width / 2 + 0.08), mid.y + 0.48, mid.z + right.z * sign * (width / 2 + 0.08)]
        );
        group.add(post);
      }
    }
  }
  for (const sign of [-1, 1]) {
    const railCurve = new THREE.CatmullRomCurve3(
      curvePoints.map((point) => point.clone().addScaledVector(right, sign * (width / 2 + 0.08)).add(new THREE.Vector3(0, 1.02, 0)))
    );
    const rail = new THREE.Mesh(new THREE.TubeGeometry(railCurve, 48, 0.095, 8, false), mats.vermilionDark);
    rail.name = "drum_bridge_arch_rail";
    rail.castShadow = true;
    group.add(rail);
  }
  return group;
}

function scaledOutline(points: readonly TeaGardenXZ[], scale: number): TeaGardenXZ[] {
  const c = centroid(points);
  return points.map(([x, z]) => [c.x + (x - c.x) * scale, c.z + (z - c.z) * scale] as const);
}

function shapeMesh(
  map: TeaGardenTerrain,
  name: string,
  outline: readonly TeaGardenXZ[],
  lift: number,
  mat: THREE.Material
): THREE.Mesh {
  const c = centroid(outline);
  const shape = new THREE.Shape();
  outline.forEach(([x, z], i) => {
    const lx = x - c.x;
    const lz = -(z - c.z);
    if (i === 0) shape.moveTo(lx, lz);
    else shape.lineTo(lx, lz);
  });
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape, 12);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    const worldX = c.x + positions.getX(i);
    const worldZ = c.z + positions.getZ(i);
    positions.setY(i, map.groundTop(worldX, worldZ) + lift);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  mesh.position.set(c.x, 0, c.z);
  mesh.receiveShadow = true;
  return mesh;
}

function ringMesh(
  map: TeaGardenTerrain,
  name: string,
  outline: readonly TeaGardenXZ[],
  lift: number,
  mat: THREE.Material
): THREE.Mesh {
  const outer = scaledOutline(outline, 1.09);
  const c = centroid(outline);
  const shape = new THREE.Shape();
  outer.forEach(([x, z], i) => {
    if (i === 0) shape.moveTo(x - c.x, -(z - c.z));
    else shape.lineTo(x - c.x, -(z - c.z));
  });
  shape.closePath();
  const hole = new THREE.Path();
  [...outline].reverse().forEach(([x, z], i) => {
    if (i === 0) hole.moveTo(x - c.x, -(z - c.z));
    else hole.lineTo(x - c.x, -(z - c.z));
  });
  hole.closePath();
  shape.holes.push(hole);
  const geometry = new THREE.ShapeGeometry(shape, 12);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    const worldX = c.x + positions.getX(i);
    const worldZ = c.z + positions.getZ(i);
    positions.setY(i, map.groundTop(worldX, worldZ) + lift);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  mesh.position.set(c.x, 0, c.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

type KoiRuntime = { mesh: THREE.InstancedMesh; center: THREE.Vector3; rx: number; rz: number };

function createPonds(map: TeaGardenTerrain, mats: ReturnType<typeof createMaterials>): { group: THREE.Group; koi: KoiRuntime[] } {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_ponds";
  const outlines = TEA_GARDEN_WATER_FEATURES.map((feature) => ({
    name: feature.name.toLowerCase().replaceAll(" ", "_"),
    outline: [...feature.outline]
  }));
  const koi: KoiRuntime[] = [];
  outlines.forEach(({ name, outline }, pondIndex) => {
    group.add(ringMesh(map, `${name}_stone_bank`, outline, 0.055, mats.stoneDark));
    // The committed terrain has no separately carved basin. Keep the connected
    // shallow water just above local grade instead of floating across the slope.
    const water = shapeMesh(map, `${name}_water`, outline, 0.085, mats.water);
    tagTransparency(water, { profile: "alphaSurface", renderBand: RenderBand.WATER_OVERLAY });
    group.add(water);
    const c = pondIndex === 0 ? { x: -2288.7, z: 2219.2 } : { x: -2274.2, z: 2193.2 };
    const rx = pondIndex === 0 ? 7.4 : 1.45;
    const rz = pondIndex === 0 ? 8.2 : 2.25;
    const count = pondIndex === 0 ? 10 : 6;
    const fishGeometry = new THREE.SphereGeometry(0.34, 10, 6);
    fishGeometry.scale(1.55, 0.35, 0.52);
    const fishMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
    const fish = new THREE.InstancedMesh(fishGeometry, fishMaterial, count);
    fish.name = `${name}_koi`;
    fish.castShadow = false;
    fish.receiveShadow = false;
    const colors = [0xd8692e, 0xf1e6cc, 0xc94c32, 0xe29d3f];
    for (let i = 0; i < count; i++) fish.setColorAt(i, new THREE.Color(colors[(i + pondIndex) % colors.length]));
    if (fish.instanceColor) fish.instanceColor.needsUpdate = true;
    group.add(fish);
    koi.push({ mesh: fish, center: new THREE.Vector3(c.x, 0, c.z), rx, rz });
  });
  return { group, koi };
}

function createMaterials() {
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
    water: applyMaterialPolicy(new THREE.MeshPhysicalMaterial({
      color: COLORS.water,
      roughness: 0.22,
      metalness: 0,
      transmission: 0.08,
      opacity: 0.86,
      side: THREE.DoubleSide
    }), "alphaSurface")
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
  const fallMat = applyMaterialPolicy(new THREE.MeshPhysicalMaterial({
    color: 0xa7d6d1,
    roughness: 0.08,
    opacity: 0.78,
    transmission: 0.18,
    side: THREE.DoubleSide
  }), "alphaSurface");
  for (let i = 0; i < 3; i++) {
    const fall = makeBox("waterfall_ribbon", [0.48 + i * 0.2, 2.4 - i * 0.35, 0.055], fallMat, [x - 0.55 + i * 0.52, base + 1.55 - i * 0.28, z - 0.45 + i * 0.28], 0.28);
    fall.castShadow = false;
    tagTransparency(fall, { profile: "alphaSurface", renderBand: RenderBand.WATER_EFFECTS });
    group.add(fall);
  }
  return group;
}

export function createTeaGardenArchitecture(
  map: TeaGardenTerrain,
  physics?: Physics
): TeaGardenArchitecture {
  const mats = createMaterials();
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_architecture";
  const bodies: number[] = [];

  group.add(makePaths(map, mats.path, mats.pathEdge));
  const ponds = createPonds(map, mats);
  group.add(ponds.group);
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

  const dummy = new THREE.Object3D();
  const update = (time: number) => {
    ponds.koi.forEach((pond, pondIndex) => {
      for (let i = 0; i < pond.mesh.count; i++) {
        const speed = 0.11 + (i % 4) * 0.018;
        const angle = time * speed + (i / pond.mesh.count) * Math.PI * 2 + pondIndex * 0.7;
        const wobble = 0.74 + (i % 3) * 0.09;
        const x = pond.center.x + Math.cos(angle) * pond.rx * wobble;
        const z = pond.center.z + Math.sin(angle) * pond.rz * wobble;
        dummy.position.set(
          x,
          map.groundTop(x, z) + 0.12 + Math.sin(angle * 2.1 + i) * 0.025,
          z
        );
        dummy.rotation.set(0, -angle + Math.PI / 2, 0);
        const scale = 0.75 + (i % 4) * 0.11;
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        pond.mesh.setMatrixAt(i, dummy.matrix);
      }
      pond.mesh.instanceMatrix.needsUpdate = true;
    });
  };

  let meshCount = 0;
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount++;
  });

  return {
    group,
    waterGroup: ponds.group,
    update,
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const entry of list) materials.add(entry);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const entry of materials) entry.dispose();
      if (physics) {
        for (const body of bodies) {
          physics.removeQuerySolid(body);
          physics.world.destroyBody(body);
        }
      }
      bodies.length = 0;
      group.removeFromParent();
    },
    stats: {
      meshes: meshCount,
      ponds: ponds.koi.length,
      koi: ponds.koi.reduce((sum, pond) => sum + pond.mesh.count, 0),
      physicsBodies: bodies.length
    }
  };
}
