import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import { SUTRO_BATHS, SUTRO_POOLS, sutroLocalToWorld } from "./layout";

/** The two architecture values owned by the shared Sutro Baths tuning schema. */
export type SutroBathsArchitectureTuning = {
  glassOpacity: number;
  lampIntensity: number;
};

export type SutroBathsColliderSpec = {
  /** Site-local horizontal position; y remains an absolute world height. */
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw?: number;
};

export type SutroBathsArchitectureStats = {
  meshes: number;
  instances: number;
  roofRibs: number;
  glassPanels: number;
  lamps: number;
  physicsBodies: number;
};

export type SutroBathsArchitecture = {
  group: THREE.Group;
  ready: Promise<void>;
  colliderSpecs: readonly SutroBathsColliderSpec[];
  applyTuning(values: SutroBathsArchitectureTuning): void;
  update(time: number, values?: SutroBathsArchitectureTuning): void;
  dispose(): void;
  stats: SutroBathsArchitectureStats;
};

export type SutroBathsArchitectureOptions = {
  physics?: Physics;
};

type BoxInstance = {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rx?: number;
  ry?: number;
  rz?: number;
  color?: number;
};

type CylinderInstance = BoxInstance;

const COLORS = {
  iron: 0x476f4c,
  ironLight: 0x68885c,
  ironDark: 0x263f31,
  glass: 0xb7d8d5,
  oceanGlass: 0x8abfc4,
  tileCream: 0xe8debf,
  tileWhite: 0xf1eddf,
  tileBlue: 0x6f9991,
  tileDeep: 0x3e6969,
  terracotta: 0xa96547,
  terracottaDark: 0x76402f,
  timber: 0x86543b,
  timberDark: 0x4d3027,
  plaster: 0xe7dfc4,
  plasterShade: 0xcbbf9f,
  brass: 0x8e7045,
  lamp: 0xffd79a,
  black: 0x171d1a
} as const;

const DEFAULT_TUNING: SutroBathsArchitectureTuning = {
  glassOpacity: 0.2,
  lampIntensity: 4.6
};

const ARCH_SEGMENTS = 18;
const ROOF_BAYS = 16;
const HALL_DEPTH = SUTRO_BATHS.halfLength * 2;
const HALL_MIN_Z = -SUTRO_BATHS.halfLength;
const HALL_MAX_Z = SUTRO_BATHS.halfLength;
const ROOF_HALF_WIDTH = SUTRO_BATHS.halfWidth - 0.8;
const ROOF_RISE = SUTRO_BATHS.roofApexY - SUTRO_BATHS.roofSpringY;
const BAY_DEPTH = HALL_DEPTH / ROOF_BAYS;

function standardMaterial(
  color: number,
  roughness = 0.84,
  metalness = 0
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function createMaterials() {
  const roofGlass = new THREE.MeshStandardMaterial({
    color: COLORS.glass,
    roughness: 0.2,
    metalness: 0.05,
    transparent: true,
    opacity: DEFAULT_TUNING.glassOpacity,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const windowGlass = new THREE.MeshStandardMaterial({
    color: COLORS.oceanGlass,
    roughness: 0.12,
    metalness: 0.02,
    transparent: true,
    opacity: Math.min(0.5, DEFAULT_TUNING.glassOpacity * 1.7),
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const bulb = new THREE.MeshStandardMaterial({
    color: COLORS.lamp,
    roughness: 0.24,
    emissive: COLORS.lamp,
    emissiveIntensity: 1.5
  });
  return {
    iron: standardMaterial(COLORS.iron, 0.42, 0.62),
    ironLight: standardMaterial(COLORS.ironLight, 0.5, 0.48),
    ironDark: standardMaterial(COLORS.ironDark, 0.38, 0.68),
    roofGlass,
    windowGlass,
    creamTile: standardMaterial(COLORS.tileCream, 0.7, 0.02),
    whiteTile: standardMaterial(COLORS.tileWhite, 0.62, 0.01),
    blueTile: standardMaterial(COLORS.tileBlue, 0.48, 0.02),
    deepTile: standardMaterial(COLORS.tileDeep, 0.46, 0.02),
    terracotta: standardMaterial(COLORS.terracotta, 0.72, 0.02),
    terracottaDark: standardMaterial(COLORS.terracottaDark, 0.76, 0.01),
    timber: standardMaterial(COLORS.timber, 0.74),
    timberDark: standardMaterial(COLORS.timberDark, 0.8),
    plaster: standardMaterial(COLORS.plaster, 0.88),
    plasterShade: standardMaterial(COLORS.plasterShade, 0.9),
    brass: standardMaterial(COLORS.brass, 0.38, 0.72),
    black: standardMaterial(COLORS.black, 0.34, 0.72),
    bulb
  };
}

type SutroMaterials = ReturnType<typeof createMaterials>;

function placeInstance(dummy: THREE.Object3D, spec: BoxInstance): void {
  dummy.position.set(spec.x, spec.y, spec.z);
  dummy.rotation.set(spec.rx ?? 0, spec.ry ?? 0, spec.rz ?? 0);
  dummy.scale.set(spec.sx, spec.sy, spec.sz);
  dummy.updateMatrix();
}

function makeBoxInstances(
  name: string,
  material: THREE.Material,
  specs: readonly BoxInstance[],
  options: { castShadow?: boolean; receiveShadow?: boolean; renderOrder?: number } = {}
): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
  mesh.name = name;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.renderOrder = options.renderOrder ?? 0;
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  specs.forEach((spec, index) => {
    placeInstance(dummy, spec);
    mesh.setMatrixAt(index, dummy.matrix);
    if (spec.color !== undefined) {
      tint.setHex(spec.color);
      mesh.setColorAt(index, tint);
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  return mesh;
}

function makeCylinderInstances(
  name: string,
  material: THREE.Material,
  specs: readonly CylinderInstance[],
  radialSegments = 8,
  castShadow = true
): THREE.InstancedMesh {
  const geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, radialSegments, 1, false);
  const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  specs.forEach((spec, index) => {
    placeInstance(dummy, spec);
    mesh.setMatrixAt(index, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  return mesh;
}

function box(
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  rx = 0,
  ry = 0,
  rz = 0,
  color?: number
): BoxInstance {
  return { x, y, z, sx, sy, sz, rx, ry, rz, color };
}

function addBeamBetweenXY(
  target: BoxInstance[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
  thickness: number,
  depth: number
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  target.push(
    box(
      (x0 + x1) * 0.5,
      (y0 + y1) * 0.5,
      z,
      Math.hypot(dx, dy),
      thickness,
      depth,
      0,
      0,
      Math.atan2(dy, dx)
    )
  );
}

function addBeamBetweenYZ(
  target: BoxInstance[],
  y0: number,
  z0: number,
  y1: number,
  z1: number,
  x: number,
  thickness: number,
  depth: number
): void {
  const dy = y1 - y0;
  const dz = z1 - z0;
  // Use the box's local z as its long axis, then pitch it in the facade plane.
  // This is used only for the compact classical pediment.
  target.push(
    box(
      x,
      (y0 + y1) * 0.5,
      (z0 + z1) * 0.5,
      depth,
      thickness,
      Math.hypot(dy, dz),
      -Math.atan2(dy, dz)
    )
  );
}

function archPoint(segment: number): { x: number; y: number } {
  const theta = Math.PI - (segment / ARCH_SEGMENTS) * Math.PI;
  return {
    x: Math.cos(theta) * ROOF_HALF_WIDTH,
    y: SUTRO_BATHS.roofSpringY + Math.sin(theta) * ROOF_RISE
  };
}

function makeRoof(mats: SutroMaterials): {
  group: THREE.Group;
  ribCount: number;
  glassCount: number;
  instances: number;
} {
  const group = new THREE.Group();
  group.name = "sutro_baths_glass_barrel_roof";

  const ribSpecs: BoxInstance[] = [];
  const chordSpecs: BoxInstance[] = [];
  const hangerSpecs: BoxInstance[] = [];
  const purlinSpecs: BoxInstance[] = [];
  const glassSpecs: BoxInstance[] = [];
  const bayZ: number[] = [];
  for (let bay = 0; bay <= ROOF_BAYS; bay++) {
    bayZ.push(HALL_MIN_Z + bay * BAY_DEPTH);
  }

  for (const z of bayZ) {
    for (let segment = 0; segment < ARCH_SEGMENTS; segment++) {
      const a = archPoint(segment);
      const b = archPoint(segment + 1);
      addBeamBetweenXY(ribSpecs, a.x, a.y, b.x, b.y, z, 0.34, 0.42);
    }
    // The straight lower chord and short verticals make the green iron roof read
    // as a riveted truss instead of a decorative hoop.
    chordSpecs.push(
      box(0, SUTRO_BATHS.roofSpringY + 0.65, z, ROOF_HALF_WIDTH * 2, 0.28, 0.34)
    );
    for (let segment = 2; segment < ARCH_SEGMENTS; segment += 2) {
      const point = archPoint(segment);
      const lowerY = SUTRO_BATHS.roofSpringY + 0.75;
      const height = Math.max(0.45, point.y - lowerY);
      hangerSpecs.push(box(point.x, lowerY + height * 0.5, z, 0.2, height, 0.24));
    }
  }

  // Longitudinal purlins tie every rib together and cast the characteristic
  // repeating shadows seen in historic photographs.
  for (let segment = 0; segment <= ARCH_SEGMENTS; segment++) {
    const point = archPoint(segment);
    purlinSpecs.push(box(point.x, point.y + 0.12, 0, 0.18, 0.2, HALL_DEPTH + 0.7));
  }

  // One draw call for all panes. Slight gaps expose every iron bay and avoid a
  // single giant alpha surface over the entire scene.
  for (let bay = 0; bay < ROOF_BAYS; bay++) {
    const z = HALL_MIN_Z + (bay + 0.5) * BAY_DEPTH;
    for (let segment = 0; segment < ARCH_SEGMENTS; segment++) {
      const a = archPoint(segment);
      const b = archPoint(segment + 1);
      addBeamBetweenXY(
        glassSpecs,
        a.x,
        a.y + 0.08,
        b.x,
        b.y + 0.08,
        z,
        0.055,
        BAY_DEPTH - 0.32
      );
    }
  }

  const ribs = makeBoxInstances("sutro_baths_arched_iron_ribs", mats.iron, ribSpecs);
  const chords = makeBoxInstances("sutro_baths_roof_tie_chords", mats.ironDark, chordSpecs);
  const hangers = makeBoxInstances("sutro_baths_roof_truss_hangers", mats.iron, hangerSpecs, {
    castShadow: false
  });
  const purlins = makeBoxInstances("sutro_baths_longitudinal_purlins", mats.ironLight, purlinSpecs, {
    castShadow: false
  });
  const glass = makeBoxInstances("sutro_baths_segmented_roof_glass", mats.roofGlass, glassSpecs, {
    castShadow: false,
    receiveShadow: false,
    renderOrder: 5
  });
  group.add(ribs, chords, hangers, purlins, glass);
  return {
    group,
    ribCount: ribSpecs.length,
    glassCount: glassSpecs.length,
    instances:
      ribSpecs.length + chordSpecs.length + hangerSpecs.length + purlinSpecs.length + glassSpecs.length
  };
}

function makeStructuralFrame(mats: SutroMaterials): { group: THREE.Group; instances: number } {
  const group = new THREE.Group();
  group.name = "sutro_baths_iron_structural_frame";
  const columns: BoxInstance[] = [];
  const braces: BoxInstance[] = [];
  const capitals: CylinderInstance[] = [];
  const columnRows = [
    -SUTRO_BATHS.halfWidth + 1.2,
    SUTRO_POOLS[0].maxX + 0.55,
    Math.max(...SUTRO_POOLS.slice(1).map((pool) => pool.maxX)) + 0.55,
    SUTRO_BATHS.halfWidth - 1.2
  ];
  for (let bay = 0; bay <= ROOF_BAYS; bay++) {
    const z = HALL_MIN_Z + bay * BAY_DEPTH;
    for (const x of columnRows) {
      const height = SUTRO_BATHS.roofSpringY - SUTRO_BATHS.deckY;
      const interior = x !== columnRows[0] && x !== columnRows[columnRows.length - 1];
      columns.push(
        box(x, SUTRO_BATHS.deckY + height * 0.5, z, interior ? 0.38 : 0.48, height, 0.48)
      );
      capitals.push(box(x, SUTRO_BATHS.roofSpringY - 0.4, z, 0.62, 0.34, 0.62));
    }
    // Knee braces at both exterior walls and at the two interior column lines.
    for (const x of columnRows) {
      const direction = x < 0 ? 1 : -1;
      addBeamBetweenXY(
        braces,
        x,
        SUTRO_BATHS.roofSpringY - 5.1,
        x + direction * 3.5,
        SUTRO_BATHS.roofSpringY - 0.7,
        z,
        0.22,
        0.3
      );
    }
  }
  const columnMesh = makeBoxInstances("sutro_baths_riveted_columns", mats.iron, columns);
  const braceMesh = makeBoxInstances("sutro_baths_column_knee_braces", mats.ironDark, braces, {
    castShadow: false
  });
  const capitalMesh = makeCylinderInstances("sutro_baths_column_capitals", mats.brass, capitals, 10);
  group.add(columnMesh, braceMesh, capitalMesh);
  return { group, instances: columns.length + braces.length + capitals.length };
}

type PoolBuildResult = {
  group: THREE.Group;
  dryDecks: BoxInstance[];
  instances: number;
};

function makePoolsAndDecks(mats: SutroMaterials): PoolBuildResult {
  const group = new THREE.Group();
  group.name = "sutro_baths_seven_pool_basin_and_decks";
  const basinFloors: BoxInstance[] = [];
  const basinWalls: BoxInstance[] = [];
  const waterlineBands: BoxInstance[] = [];
  const coping: BoxInstance[] = [];
  const laneStripes: BoxInstance[] = [];

  for (const pool of SUTRO_POOLS) {
    const width = pool.maxX - pool.minX;
    const depth = pool.maxZ - pool.minZ;
    const cx = (pool.minX + pool.maxX) * 0.5;
    const cz = (pool.minZ + pool.maxZ) * 0.5;
    const wallY = (SUTRO_BATHS.basinY + SUTRO_BATHS.waterY) * 0.5;
    const wallHeight = SUTRO_BATHS.waterY - SUTRO_BATHS.basinY + 0.65;
    basinFloors.push(box(cx, SUTRO_BATHS.basinY - 0.15, cz, width - 0.5, 0.3, depth - 0.5));
    basinWalls.push(
      box(pool.minX + 0.15, wallY, cz, 0.3, wallHeight, depth),
      box(pool.maxX - 0.15, wallY, cz, 0.3, wallHeight, depth),
      box(cx, wallY, pool.minZ + 0.15, width, wallHeight, 0.3),
      box(cx, wallY, pool.maxZ - 0.15, width, wallHeight, 0.3)
    );
    waterlineBands.push(
      box(pool.minX + 0.32, SUTRO_BATHS.waterY - 0.28, cz, 0.12, 0.36, depth - 0.7),
      box(pool.maxX - 0.32, SUTRO_BATHS.waterY - 0.28, cz, 0.12, 0.36, depth - 0.7),
      box(cx, SUTRO_BATHS.waterY - 0.28, pool.minZ + 0.32, width - 0.7, 0.36, 0.12),
      box(cx, SUTRO_BATHS.waterY - 0.28, pool.maxZ - 0.32, width - 0.7, 0.36, 0.12)
    );
    coping.push(
      box(pool.minX - 0.18, SUTRO_BATHS.deckY + 0.1, cz, 0.55, 0.2, depth + 0.55),
      box(pool.maxX + 0.18, SUTRO_BATHS.deckY + 0.1, cz, 0.55, 0.2, depth + 0.55),
      box(cx, SUTRO_BATHS.deckY + 0.1, pool.minZ - 0.18, width + 0.55, 0.2, 0.55),
      box(cx, SUTRO_BATHS.deckY + 0.1, pool.maxZ + 0.18, width + 0.55, 0.2, 0.55)
    );
    if (pool.id === "great-plunge") {
      for (let lane = 1; lane <= 4; lane++) {
        laneStripes.push(
          box(
            THREE.MathUtils.lerp(pool.minX, pool.maxX, lane / 5),
            SUTRO_BATHS.basinY + 0.03,
            cz,
            0.14,
            0.08,
            depth - 2.2
          )
        );
      }
    } else {
      laneStripes.push(box(cx, SUTRO_BATHS.basinY + 0.03, cz, width - 1.4, 0.08, 0.12));
    }
  }

  // Dry floor is authored as individual strips so none of the seven water
  // rectangles is accidentally sealed by a giant foundation slab.
  const great = SUTRO_POOLS[0];
  const smaller = [...SUTRO_POOLS.slice(1)].sort((a, b) => a.minZ - b.minZ);
  const smallMinX = Math.min(...smaller.map((pool) => pool.minX));
  const smallMaxX = Math.max(...smaller.map((pool) => pool.maxX));
  const minPoolZ = Math.min(...SUTRO_POOLS.map((pool) => pool.minZ));
  const maxPoolZ = Math.max(...SUTRO_POOLS.map((pool) => pool.maxZ));
  const deckY = SUTRO_BATHS.deckY - 0.18;
  const outerWestWidth = great.minX + SUTRO_BATHS.halfWidth;
  const dividerWidth = smallMinX - great.maxX;
  const outerEastWidth = SUTRO_BATHS.halfWidth - smallMaxX;
  const dryDecks: BoxInstance[] = [
    box((great.minX - SUTRO_BATHS.halfWidth) * 0.5, deckY, 0, outerWestWidth, 0.36, HALL_DEPTH),
    box((great.maxX + smallMinX) * 0.5, deckY, 0, dividerWidth, 0.36, HALL_DEPTH),
    box((smallMaxX + SUTRO_BATHS.halfWidth) * 0.5, deckY, 0, outerEastWidth, 0.36, HALL_DEPTH),
    box(0, deckY - 0.01, (HALL_MIN_Z + minPoolZ) * 0.5, SUTRO_BATHS.halfWidth * 2, 0.34, minPoolZ - HALL_MIN_Z),
    box(0, deckY - 0.01, (maxPoolZ + HALL_MAX_Z) * 0.5, SUTRO_BATHS.halfWidth * 2, 0.34, HALL_MAX_Z - maxPoolZ)
  ];
  if (great.maxZ < maxPoolZ) {
    dryDecks.push(
      box(
        (great.minX + great.maxX) * 0.5,
        deckY,
        (great.maxZ + maxPoolZ) * 0.5,
        great.maxX - great.minX,
        0.36,
        maxPoolZ - great.maxZ
      )
    );
  }
  for (let index = 0; index < smaller.length - 1; index++) {
    const current = smaller[index];
    const next = smaller[index + 1];
    const gap = next.minZ - current.maxZ;
    if (gap <= 0.35) continue;
    dryDecks.push(
      box(
        (smallMinX + smallMaxX) * 0.5,
        deckY,
        (current.maxZ + next.minZ) * 0.5,
        smallMaxX - smallMinX,
        0.36,
        gap
      )
    );
  }
  const terracottaBorders: BoxInstance[] = [
    box(
      (great.minX - SUTRO_BATHS.halfWidth) * 0.5,
      SUTRO_BATHS.deckY + 0.025,
      0,
      outerWestWidth,
      0.05,
      HALL_DEPTH - 0.6
    ),
    box(
      (great.maxX + smallMinX) * 0.5,
      SUTRO_BATHS.deckY + 0.025,
      0,
      dividerWidth,
      0.05,
      HALL_DEPTH - 0.6
    ),
    box(
      (smallMaxX + SUTRO_BATHS.halfWidth) * 0.5,
      SUTRO_BATHS.deckY + 0.025,
      0,
      outerEastWidth,
      0.05,
      HALL_DEPTH - 0.6
    )
  ];

  group.add(
    makeBoxInstances("sutro_baths_pool_bottom_tiles", mats.deepTile, basinFloors),
    makeBoxInstances("sutro_baths_pool_tiled_walls", mats.blueTile, basinWalls),
    makeBoxInstances("sutro_baths_pool_waterline_bands", mats.whiteTile, waterlineBands, {
      castShadow: false
    }),
    makeBoxInstances("sutro_baths_cream_tile_coping", mats.creamTile, coping),
    makeBoxInstances("sutro_baths_underwater_lane_inlays", mats.whiteTile, laneStripes, {
      castShadow: false
    }),
    makeBoxInstances("sutro_baths_dry_promenoir_decks", mats.creamTile, dryDecks),
    makeBoxInstances("sutro_baths_terracotta_promenoir_inlay", mats.terracotta, terracottaBorders, {
      castShadow: false
    })
  );
  return {
    group,
    dryDecks,
    instances:
      basinFloors.length +
      basinWalls.length +
      waterlineBands.length +
      coping.length +
      laneStripes.length +
      dryDecks.length +
      terracottaBorders.length
  };
}

function makeRailingsLaddersAndDiving(mats: SutroMaterials): {
  group: THREE.Group;
  instances: number;
} {
  const group = new THREE.Group();
  group.name = "sutro_baths_pool_railings_ladders_and_diving";
  const posts: CylinderInstance[] = [];
  const rails: CylinderInstance[] = [];
  const ladderRails: CylinderInstance[] = [];
  const ladderRungs: CylinderInstance[] = [];
  const boardSpecs: BoxInstance[] = [];
  const towerSpecs: BoxInstance[] = [];
  const railY = SUTRO_BATHS.deckY + 0.82;
  const great = SUTRO_POOLS[0];

  const addRailRunZ = (x: number, z0: number, z1: number, spacing = 3.7) => {
    const length = z1 - z0;
    const count = Math.max(1, Math.ceil(length / spacing));
    for (let index = 0; index <= count; index++) {
      const z = THREE.MathUtils.lerp(z0, z1, index / count);
      posts.push(box(x, SUTRO_BATHS.deckY + 0.65, z, 0.12, 1.3, 0.12));
    }
    for (const y of [railY, railY + 0.45]) {
      rails.push(box(x, y, (z0 + z1) * 0.5, 0.09, length, 0.09, Math.PI / 2, 0, 0));
    }
  };
  addRailRunZ(great.maxX + 0.45, great.minZ + 0.8, great.maxZ - 0.8);
  for (const pool of SUTRO_POOLS.slice(1)) {
    addRailRunZ(pool.maxX + 0.52, pool.minZ + 0.7, pool.maxZ - 0.7, 3.2);
  }

  const ladderLocations = [
    ...[0.12, 0.38, 0.64, 0.88].map((fraction) => ({
      x: great.maxX + 0.2,
      z: THREE.MathUtils.lerp(great.minZ, great.maxZ, fraction),
      intoX: -1
    })),
    ...SUTRO_POOLS.slice(1).map((pool) => ({
      x: pool.maxX + 0.2,
      z: (pool.minZ + pool.maxZ) * 0.5,
      intoX: -1
    }))
  ];
  for (const ladder of ladderLocations) {
    for (const dz of [-0.38, 0.38]) {
      ladderRails.push(
        box(
          ladder.x,
          (SUTRO_BATHS.waterY + SUTRO_BATHS.deckY + 1.35) * 0.5,
          ladder.z + dz,
          0.12,
          SUTRO_BATHS.deckY + 1.35 - SUTRO_BATHS.waterY,
          0.12
        )
      );
    }
    for (let rung = 0; rung < 5; rung++) {
      ladderRungs.push(
        box(
          ladder.x + ladder.intoX * 0.03,
          SUTRO_BATHS.waterY - 0.05 + rung * 0.38,
          ladder.z,
          0.1,
          0.84,
          0.1,
          Math.PI / 2,
          0,
          0
        )
      );
    }
  }

  for (const fraction of [0.22, 0.51, 0.8]) {
    const z = THREE.MathUtils.lerp(great.minZ, great.maxZ, fraction);
    boardSpecs.push(
      box(great.maxX - 2.4, SUTRO_BATHS.deckY + 0.72, z, 5.6, 0.22, 0.72, 0, 0, 0, 0xe1d7b8),
      box(great.maxX + 0.45, SUTRO_BATHS.deckY + 0.35, z, 0.24, 0.7, 1.2),
      box(great.maxX - 0.35, SUTRO_BATHS.deckY + 0.44, z, 0.2, 0.9, 0.2)
    );
  }

  // A stylized echo of the famous tiered diving apparatus in the great plunge.
  const towerZ = THREE.MathUtils.lerp(great.minZ, great.maxZ, 0.17);
  const towerX = (great.maxX + SUTRO_POOLS[1].minX) * 0.5;
  for (const dx of [-1.15, 1.15]) {
    towerSpecs.push(box(towerX + dx, SUTRO_BATHS.deckY + 3.5, towerZ, 0.24, 7, 0.24));
    addBeamBetweenXY(
      towerSpecs,
      towerX + dx,
      SUTRO_BATHS.deckY + 0.5,
      towerX - dx,
      SUTRO_BATHS.deckY + 6.4,
      towerZ,
      0.18,
      0.22
    );
  }
  towerSpecs.push(
    box(towerX - 2.1, SUTRO_BATHS.deckY + 3.5, towerZ, 4.2, 0.22, 2.1),
    box(towerX - 2.8, SUTRO_BATHS.deckY + 6.55, towerZ, 5.6, 0.22, 1.4)
  );

  group.add(
    makeCylinderInstances("sutro_baths_white_guardrail_posts", mats.whiteTile, posts, 8),
    makeCylinderInstances("sutro_baths_white_guardrail_runs", mats.whiteTile, rails, 8),
    makeCylinderInstances("sutro_baths_brass_ladder_rails", mats.brass, ladderRails, 10),
    makeCylinderInstances("sutro_baths_brass_ladder_rungs", mats.brass, ladderRungs, 10),
    makeBoxInstances("sutro_baths_spring_diving_boards", mats.timber, boardSpecs),
    makeBoxInstances("sutro_baths_tiered_diving_tower", mats.ironDark, towerSpecs)
  );
  return {
    group,
    instances: posts.length + rails.length + ladderRails.length + ladderRungs.length + boardSpecs.length + towerSpecs.length
  };
}

function makeOceanWindowGallery(mats: SutroMaterials): {
  group: THREE.Group;
  galleryDeck: BoxInstance;
  stairBoxes: BoxInstance[];
  glassPanels: number;
  instances: number;
} {
  const group = new THREE.Group();
  group.name = "sutro_baths_ocean_window_seating_gallery";
  const glass: BoxInstance[] = [];
  const mullions: BoxInstance[] = [];
  const galleryStructure: BoxInstance[] = [];
  const benches: BoxInstance[] = [];
  const railPosts: CylinderInstance[] = [];
  const railRuns: CylinderInstance[] = [];
  const stairBoxes: BoxInstance[] = [];
  const wallX = -SUTRO_BATHS.halfWidth + 0.32;
  const galleryCenterX = -SUTRO_BATHS.halfWidth + 3.85;
  const galleryInnerX = -SUTRO_BATHS.halfWidth + 7.2;
  const windowBottom = SUTRO_BATHS.deckY + 1.2;
  const windowTop = SUTRO_BATHS.roofSpringY - 0.6;
  const windowHeight = windowTop - windowBottom;

  for (let bay = 0; bay < ROOF_BAYS; bay++) {
    const z = HALL_MIN_Z + (bay + 0.5) * BAY_DEPTH;
    glass.push(box(wallX, windowBottom + windowHeight * 0.5, z, 0.07, windowHeight, BAY_DEPTH - 0.42));
  }
  for (let bay = 0; bay <= ROOF_BAYS; bay++) {
    const z = HALL_MIN_Z + bay * BAY_DEPTH;
    mullions.push(box(wallX + 0.03, windowBottom + windowHeight * 0.5, z, 0.24, windowHeight + 0.4, 0.24));
  }
  for (const y of [windowBottom, windowBottom + windowHeight * 0.5, windowTop]) {
    mullions.push(box(wallX + 0.03, y, 0, 0.24, 0.22, HALL_DEPTH));
  }

  const galleryY = SUTRO_BATHS.deckY + 6.1;
  const galleryDeck = box(galleryCenterX, galleryY, 0, 6.6, 0.32, HALL_DEPTH - 5);
  galleryStructure.push(galleryDeck);
  for (let bay = 0; bay <= ROOF_BAYS; bay += 2) {
    const z = HALL_MIN_Z + bay * BAY_DEPTH;
    galleryStructure.push(
      box(galleryInnerX, (SUTRO_BATHS.deckY + galleryY) * 0.5, z, 0.3, galleryY - SUTRO_BATHS.deckY, 0.3),
      box(galleryCenterX + 1.1, galleryY - 1.8, z, 4.2, 0.22, 0.24, 0, 0, -0.62)
    );
  }

  for (let bay = 1; bay < ROOF_BAYS; bay += 2) {
    const z = HALL_MIN_Z + (bay + 0.5) * BAY_DEPTH;
    // Seats face west through the tall panes; backs sit on the pool side.
    benches.push(
      box(galleryCenterX - 0.3, galleryY + 0.55, z, 0.95, 0.16, 5.1),
      box(galleryCenterX + 0.21, galleryY + 1.15, z, 0.16, 1.25, 5.1),
      box(galleryCenterX - 0.03, galleryY + 0.18, z - 2.0, 0.18, 0.55, 0.18),
      box(galleryCenterX - 0.03, galleryY + 0.18, z + 2.0, 0.18, 0.55, 0.18)
    );
  }

  for (let bay = 0; bay <= ROOF_BAYS; bay++) {
    const z = HALL_MIN_Z + bay * BAY_DEPTH;
    railPosts.push(box(galleryInnerX + 0.25, galleryY + 0.72, z, 0.12, 1.44, 0.12));
  }
  for (const y of [galleryY + 0.68, galleryY + 1.28]) {
    railRuns.push(box(galleryInnerX + 0.25, y, 0, 0.11, HALL_DEPTH - 3, 0.11, Math.PI / 2));
  }

  // A visible period stair makes the upper promeneoir a real destination, not
  // just scenery. Individual treads are mirrored by coarse step colliders.
  const stairCount = 13;
  for (let step = 0; step < stairCount; step++) {
    const rise = (galleryY - SUTRO_BATHS.deckY) / stairCount;
    stairBoxes.push(
      box(
        galleryCenterX + 0.45,
        SUTRO_BATHS.deckY + rise * (step + 0.5),
        HALL_MIN_Z + 1.25 + step * 0.61,
        3.2,
        rise,
        0.78
      )
    );
  }

  group.add(
    makeBoxInstances("sutro_baths_ocean_window_glass", mats.windowGlass, glass, {
      castShadow: false,
      receiveShadow: false,
      renderOrder: 6
    }),
    makeBoxInstances("sutro_baths_ocean_window_mullions", mats.iron, mullions),
    makeBoxInstances("sutro_baths_upper_gallery_structure", mats.ironDark, galleryStructure),
    makeBoxInstances("sutro_baths_ocean_view_benches", mats.timber, benches),
    makeCylinderInstances("sutro_baths_upper_gallery_rail_posts", mats.brass, railPosts, 8),
    makeCylinderInstances("sutro_baths_upper_gallery_rail_runs", mats.brass, railRuns, 8),
    makeBoxInstances("sutro_baths_upper_gallery_stair", mats.terracotta, stairBoxes)
  );
  return {
    group,
    galleryDeck,
    stairBoxes,
    glassPanels: glass.length,
    instances:
      glass.length + mullions.length + galleryStructure.length + benches.length + railPosts.length + railRuns.length + stairBoxes.length
  };
}

function makeNorthPavilion(mats: SutroMaterials): { group: THREE.Group; instances: number } {
  const group = new THREE.Group();
  group.name = "sutro_baths_north_conservatory_pavilion";
  const shell: BoxInstance[] = [];
  const trim: BoxInstance[] = [];
  const windows: BoxInstance[] = [];
  const windowFrames: BoxInstance[] = [];
  const balconyRails: CylinderInstance[] = [];
  const frontZ = HALL_MIN_Z + 5.0;
  const floorY = SUTRO_BATHS.deckY;

  shell.push(
    box(0, floorY + 6.2, frontZ - 0.35, 68, 12.4, 0.7),
    box(0, floorY + 15.1, frontZ - 0.48, 21, 5.4, 0.72),
    box(0, floorY + 11.8, frontZ + 1.0, 69, 0.42, 3.4)
  );
  trim.push(
    box(0, floorY + 10.9, frontZ + 0.08, 68.5, 0.56, 0.28),
    box(0, floorY + 12.4, frontZ + 0.08, 68.5, 0.34, 0.3),
    box(0, floorY + 17.8, frontZ + 0.05, 21.8, 0.4, 0.3),
    box(0, floorY + 9.8, frontZ + 1.25, 68, 0.22, 2.7)
  );

  const windowXs = [-27, -19, -11, 11, 19, 27];
  for (const x of windowXs) {
    windows.push(box(x, floorY + 6.8, frontZ + 0.06, 3.5, 6.1, 0.08));
    windowFrames.push(
      box(x - 1.85, floorY + 6.8, frontZ + 0.15, 0.22, 6.5, 0.2),
      box(x + 1.85, floorY + 6.8, frontZ + 0.15, 0.22, 6.5, 0.2),
      box(x, floorY + 3.65, frontZ + 0.15, 3.9, 0.22, 0.2),
      box(x, floorY + 6.8, frontZ + 0.15, 3.7, 0.16, 0.2),
      box(x, floorY + 9.95, frontZ + 0.15, 3.9, 0.22, 0.2)
    );
  }
  // Central double doors and upper ceremonial windows.
  windows.push(
    box(0, floorY + 4.0, frontZ + 0.06, 5.5, 7.6, 0.08),
    box(-5.2, floorY + 15.0, frontZ + 0.06, 3.1, 3.4, 0.08),
    box(5.2, floorY + 15.0, frontZ + 0.06, 3.1, 3.4, 0.08)
  );
  windowFrames.push(
    box(0, floorY + 4.0, frontZ + 0.16, 0.2, 7.9, 0.22),
    box(-2.9, floorY + 4.0, frontZ + 0.16, 0.22, 8.0, 0.22),
    box(2.9, floorY + 4.0, frontZ + 0.16, 0.22, 8.0, 0.22),
    box(0, floorY + 7.95, frontZ + 0.16, 6.1, 0.24, 0.22)
  );

  for (let i = 0; i <= 17; i++) {
    const x = THREE.MathUtils.lerp(-33, 33, i / 17);
    balconyRails.push(box(x, floorY + 11.4, frontZ + 2.35, 0.12, 1.2, 0.12));
  }
  balconyRails.push(
    box(0, floorY + 11.05, frontZ + 2.35, 0.1, 66, 0.1, 0, 0, Math.PI / 2),
    box(0, floorY + 11.8, frontZ + 2.35, 0.1, 66, 0.1, 0, 0, Math.PI / 2)
  );

  const clock = new THREE.Group();
  clock.name = "sutro_baths_pavilion_clock";
  const face = new THREE.Mesh(new THREE.CircleGeometry(1.45, 32), mats.whiteTile);
  face.position.set(0, floorY + 15.4, frontZ + 0.43);
  face.castShadow = false;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.48, 0.14, 8, 32), mats.brass);
  rim.position.copy(face.position);
  const handHour = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 0.08), mats.black);
  handHour.position.set(0.2, floorY + 15.7, frontZ + 0.55);
  handHour.rotation.z = -0.52;
  const handMinute = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.08), mats.black);
  handMinute.position.set(-0.25, floorY + 15.75, frontZ + 0.56);
  handMinute.rotation.z = 0.82;
  clock.add(face, rim, handHour, handMinute);

  group.add(
    makeBoxInstances("sutro_baths_pavilion_shell", mats.plaster, shell),
    makeBoxInstances("sutro_baths_pavilion_terracotta_frieze", mats.terracotta, trim),
    makeBoxInstances("sutro_baths_pavilion_window_glass", mats.windowGlass, windows, {
      castShadow: false,
      receiveShadow: false,
      renderOrder: 6
    }),
    makeBoxInstances("sutro_baths_pavilion_window_frames", mats.ironDark, windowFrames),
    makeCylinderInstances("sutro_baths_pavilion_balcony_railing", mats.brass, balconyRails, 8),
    clock
  );
  return {
    group,
    instances: shell.length + trim.length + windows.length + windowFrames.length + balconyRails.length
  };
}

function makeEastGalleryAndEndWalls(mats: SutroMaterials): {
  group: THREE.Group;
  instances: number;
} {
  const group = new THREE.Group();
  group.name = "sutro_baths_inland_gallery_and_end_walls";
  const walls: BoxInstance[] = [];
  const panels: BoxInstance[] = [];
  const pilasters: BoxInstance[] = [];
  const eastX = SUTRO_BATHS.halfWidth - 0.3;
  const wallHeight = SUTRO_BATHS.roofSpringY - SUTRO_BATHS.deckY;
  const entranceZ = HALL_MAX_Z - 13;
  const entranceHalfWidth = 4.35;
  const backWallDepth = entranceZ - entranceHalfWidth - HALL_MIN_Z;
  const entryEndWallDepth = HALL_MAX_Z - (entranceZ + entranceHalfWidth);
  walls.push(
    box(
      eastX,
      SUTRO_BATHS.deckY + wallHeight * 0.5,
      HALL_MIN_Z + backWallDepth * 0.5,
      0.62,
      wallHeight,
      backWallDepth
    ),
    box(
      eastX,
      SUTRO_BATHS.deckY + wallHeight * 0.5,
      entranceZ + entranceHalfWidth + entryEndWallDepth * 0.5,
      0.62,
      wallHeight,
      entryEndWallDepth
    ),
    // A high lintel retains the iron frame over the broad entry opening.
    box(eastX, SUTRO_BATHS.deckY + 14.2, entranceZ, 0.62, wallHeight - 9.2, entranceHalfWidth * 2),
    box(0, SUTRO_BATHS.deckY + 4.2, HALL_MIN_Z + 0.3, SUTRO_BATHS.halfWidth * 2, 8.4, 0.6)
  );
  for (let bay = 0; bay < ROOF_BAYS; bay++) {
    const z = HALL_MIN_Z + (bay + 0.5) * BAY_DEPTH;
    if (Math.abs(z - entranceZ) < entranceHalfWidth + 0.8) continue;
    panels.push(box(eastX - 0.38, SUTRO_BATHS.deckY + 7.2, z, 0.08, 8.8, BAY_DEPTH - 0.75));
  }
  for (let bay = 0; bay <= ROOF_BAYS; bay++) {
    const z = HALL_MIN_Z + bay * BAY_DEPTH;
    pilasters.push(box(eastX - 0.52, SUTRO_BATHS.deckY + wallHeight * 0.5, z, 0.35, wallHeight, 0.35));
  }
  pilasters.push(
    box(eastX - 0.52, SUTRO_BATHS.deckY + 7.0, entranceZ - entranceHalfWidth, 0.48, 14, 0.48),
    box(eastX - 0.52, SUTRO_BATHS.deckY + 7.0, entranceZ + entranceHalfWidth, 0.48, 14, 0.48)
  );
  group.add(
    makeBoxInstances("sutro_baths_inland_retaining_wall", mats.plasterShade, walls),
    makeBoxInstances("sutro_baths_inland_gallery_panels", mats.ironLight, panels),
    makeBoxInstances("sutro_baths_inland_gallery_pilasters", mats.ironDark, pilasters)
  );
  return { group, instances: walls.length + panels.length + pilasters.length };
}

function makeTieredBleacherGallery(mats: SutroMaterials): {
  group: THREE.Group;
  instances: number;
} {
  const group = new THREE.Group();
  group.name = "sutro_baths_tiered_spectator_gallery";
  const frames: BoxInstance[] = [];
  const seats: BoxInstance[] = [];
  const backs: BoxInstance[] = [];
  const railPosts: CylinderInstance[] = [];
  const railRuns: CylinderInstance[] = [];
  const galleryBaseY = SUTRO_BATHS.deckY + 6.5;
  const zSections = [-44, -22, 0, 22, 44];

  // Four compact tiers rise toward the inland wall. Gaps between the long bench
  // sections make them feel like real aisles while keeping the draw cost fixed.
  for (let tier = 0; tier < 4; tier++) {
    const x = 29.1 + tier * 1.55;
    const y = galleryBaseY + tier * 0.82;
    for (const z of zSections) {
      frames.push(box(x, y - 0.45, z, 1.45, 0.9 + tier * 0.2, 19.5));
      seats.push(box(x - 0.12, y + 0.08, z, 1.24, 0.18, 18.9));
      backs.push(box(x + 0.58, y + 0.7, z, 0.16, 1.3, 18.9, 0, 0, -0.13));
    }
  }
  for (const z of [-54, -33, -11, 11, 33, 54]) {
    railPosts.push(box(28.25, galleryBaseY + 0.75, z, 0.13, 1.5, 0.13));
  }
  for (const y of [galleryBaseY + 0.72, galleryBaseY + 1.35]) {
    railRuns.push(box(28.25, y, 0, 0.1, 108, 0.1, Math.PI / 2));
  }
  group.add(
    makeBoxInstances("sutro_baths_bleacher_risers", mats.ironDark, frames),
    makeBoxInstances("sutro_baths_bleacher_seats", mats.timber, seats),
    makeBoxInstances("sutro_baths_bleacher_backs", mats.timberDark, backs),
    makeCylinderInstances("sutro_baths_bleacher_rail_posts", mats.brass, railPosts, 8),
    makeCylinderInstances("sutro_baths_bleacher_rail_runs", mats.brass, railRuns, 8)
  );
  return {
    group,
    instances: frames.length + seats.length + backs.length + railPosts.length + railRuns.length
  };
}

type LampBuildResult = {
  group: THREE.Group;
  bulbs: THREE.MeshStandardMaterial;
  lights: THREE.PointLight[];
  fixtureCount: number;
  instances: number;
};

function makePeriodLamps(mats: SutroMaterials): LampBuildResult {
  const group = new THREE.Group();
  group.name = "sutro_baths_period_pendant_lamps";
  const cords: CylinderInstance[] = [];
  const shades: CylinderInstance[] = [];
  const bulbs: CylinderInstance[] = [];
  const lights: THREE.PointLight[] = [];
  const lampPositions: Array<{ x: number; z: number }> = [];
  for (const z of [-55, -37, -19, -1, 17, 35, 53]) {
    lampPositions.push({ x: -18.4, z }, { x: 11.2, z });
  }
  const cordTop = SUTRO_BATHS.roofSpringY + 2.5;
  const lampY = SUTRO_BATHS.deckY + 10.4;
  for (const [index, lamp] of lampPositions.entries()) {
    cords.push(box(lamp.x, (cordTop + lampY) * 0.5, lamp.z, 0.08, cordTop - lampY, 0.08));
    shades.push(box(lamp.x, lampY + 0.18, lamp.z, 1.25, 0.6, 1.25));
    bulbs.push(box(lamp.x, lampY - 0.25, lamp.z, 0.42, 0.72, 0.42));
    // A handful of real lights provide warm pools while the instanced emissive
    // fixtures carry the full historical rhythm at negligible light-count cost.
    if (index % 3 === 0) {
      const light = new THREE.PointLight(COLORS.lamp, DEFAULT_TUNING.lampIntensity * 11, 24, 2);
      light.name = `sutro_baths_warm_lamp_${index}`;
      light.position.set(lamp.x, lampY - 0.45, lamp.z);
      light.castShadow = false;
      lights.push(light);
      group.add(light);
    }
  }
  group.add(
    makeCylinderInstances("sutro_baths_lamp_cords", mats.black, cords, 6, false),
    makeCylinderInstances("sutro_baths_lamp_shades", mats.black, shades, 14),
    makeCylinderInstances("sutro_baths_glowing_lamp_bulbs", mats.bulb, bulbs, 12, false)
  );
  return {
    group,
    bulbs: mats.bulb,
    lights,
    fixtureCount: lampPositions.length,
    instances: cords.length + shades.length + bulbs.length
  };
}

function makePointLobosEntrance(mats: SutroMaterials): {
  group: THREE.Group;
  stairBoxes: BoxInstance[];
  instances: number;
} {
  const group = new THREE.Group();
  group.name = "sutro_baths_point_lobos_classical_portal";
  const structure: BoxInstance[] = [];
  const handrails: BoxInstance[] = [];
  const columns: CylinderInstance[] = [];
  const stairBoxes: BoxInstance[] = [];
  const doors: BoxInstance[] = [];
  const eastX = SUTRO_BATHS.halfWidth;
  const z = HALL_MAX_Z - 13;
  // The surviving approach is high on the Point Lobos cliff (~31 m in the
  // terrain bake) while the pool deck sits near sea level. The long interior
  // stair therefore rises from the east promeneoir to the real arrival shelf.
  const stairBottomX = Math.max(...SUTRO_POOLS.slice(1).map((pool) => pool.maxX)) + 2.0;
  const stairTopX = eastX + 5.6;
  const landingY = SUTRO_BATHS.deckY + 25.4;
  const stairCount = 32;
  const stairRise = (landingY - SUTRO_BATHS.deckY) / stairCount;
  const stairRun = (stairTopX - stairBottomX) / stairCount;
  for (let step = 0; step < stairCount; step++) {
    stairBoxes.push(
      box(
        stairBottomX + stairRun * (step + 0.5),
        SUTRO_BATHS.deckY + stairRise * (step + 0.5),
        z,
        stairRun + 0.12,
        stairRise,
        8.8
      )
    );
  }
  const porticoX = eastX + 8.7;
  structure.push(
    box(eastX + 7.4, landingY - 0.2, z, 5.2, 0.4, 11.5),
    box(porticoX + 1.7, landingY + 4.0, z, 0.7, 8.0, 11.2),
    box(porticoX, landingY + 8.25, z, 4.6, 0.72, 12.2),
    box(porticoX, landingY + 9.0, z, 4.7, 0.42, 12.8)
  );
  addBeamBetweenYZ(
    structure,
    landingY + 9.15,
    z - 6.35,
    landingY + 12.35,
    z,
    porticoX - 0.2,
    0.5,
    0.72
  );
  addBeamBetweenYZ(
    structure,
    landingY + 12.35,
    z,
    landingY + 9.15,
    z + 6.35,
    porticoX - 0.2,
    0.5,
    0.72
  );
  for (const dz of [-4.6, -1.55, 1.55, 4.6]) {
    columns.push(box(porticoX - 0.9, landingY + 3.75, z + dz, 0.92, 7.5, 0.92));
  }
  doors.push(
    box(porticoX + 1.28, landingY + 3.1, z - 1.7, 0.12, 6.2, 3.1),
    box(porticoX + 1.28, landingY + 3.1, z + 1.7, 0.12, 6.2, 3.1)
  );

  // Sloped iron handrails visually connect the temple-like Point Lobos portal
  // to the museum-level promeneoir below.
  for (const dz of [-4.75, 4.75]) {
    addBeamBetweenXY(
      handrails,
      stairBottomX,
      SUTRO_BATHS.deckY + 1.0,
      stairTopX,
      landingY + 1.0,
      z + dz,
      0.18,
      0.2
    );
  }
  group.add(
    makeBoxInstances("sutro_baths_entry_grand_stair", mats.terracotta, stairBoxes),
    makeBoxInstances("sutro_baths_classical_portal_entablature", mats.plaster, structure),
    makeBoxInstances("sutro_baths_entry_stair_handrails", mats.ironDark, handrails),
    makeCylinderInstances("sutro_baths_classical_portal_columns", mats.plasterShade, columns, 18),
    makeBoxInstances("sutro_baths_classical_portal_doors", mats.ironDark, doors)
  );
  return {
    group,
    stairBoxes,
    instances: stairBoxes.length + structure.length + handrails.length + columns.length + doors.length
  };
}

function getSitePlacement(): { x: number; z: number; yaw: number } {
  const origin = sutroLocalToWorld(0, 0);
  const forward = sutroLocalToWorld(0, 1);
  return {
    x: origin.x,
    z: origin.z,
    // A Three.js Y rotation maps local +z to (sin(yaw), cos(yaw)). Deriving it
    // from the layout transform keeps this module independent of its chosen yaw.
    yaw: Math.atan2(forward.x - origin.x, forward.z - origin.z)
  };
}

function makeColliderSpecs(
  dryDecks: readonly BoxInstance[],
  galleryDeck: BoxInstance,
  galleryStairBoxes: readonly BoxInstance[],
  entryStairBoxes: readonly BoxInstance[]
): SutroBathsColliderSpec[] {
  const result: SutroBathsColliderSpec[] = [];
  for (const deck of dryDecks) {
    result.push({
      x: deck.x,
      y: deck.y,
      z: deck.z,
      hx: deck.sx * 0.5,
      hy: deck.sy * 0.5,
      hz: deck.sz * 0.5
    });
  }
  // Basin bottoms are deliberately lower than the promeneoir. These preserve
  // the seven open voids while preventing a fall through the restored shell.
  for (const pool of SUTRO_POOLS) {
    result.push({
      x: (pool.minX + pool.maxX) * 0.5,
      y: SUTRO_BATHS.basinY - 0.2,
      z: (pool.minZ + pool.maxZ) * 0.5,
      hx: (pool.maxX - pool.minX - 0.6) * 0.5,
      hy: 0.2,
      hz: (pool.maxZ - pool.minZ - 0.6) * 0.5
    });
  }
  result.push(
    {
      x: galleryDeck.x,
      y: galleryDeck.y,
      z: galleryDeck.z,
      hx: galleryDeck.sx * 0.5,
      hy: galleryDeck.sy * 0.5,
      hz: galleryDeck.sz * 0.5
    },
    {
      x: -SUTRO_BATHS.halfWidth + 0.3,
      y: (SUTRO_BATHS.deckY + SUTRO_BATHS.roofSpringY) * 0.5,
      z: 0,
      hx: 0.35,
      hy: (SUTRO_BATHS.roofSpringY - SUTRO_BATHS.deckY) * 0.5,
      hz: SUTRO_BATHS.halfLength
    },
    {
      x: 0,
      y: SUTRO_BATHS.deckY + 6.1,
      z: HALL_MIN_Z + 4.65,
      hx: SUTRO_BATHS.halfWidth - 2,
      hy: 6.2,
      hz: 0.42
    }
  );
  const entranceZ = HALL_MAX_Z - 13;
  const entranceHalfWidth = 4.35;
  const backWallDepth = entranceZ - entranceHalfWidth - HALL_MIN_Z;
  const entryEndWallDepth = HALL_MAX_Z - (entranceZ + entranceHalfWidth);
  result.push(
    {
      x: SUTRO_BATHS.halfWidth - 0.3,
      y: (SUTRO_BATHS.deckY + SUTRO_BATHS.roofSpringY) * 0.5,
      z: HALL_MIN_Z + backWallDepth * 0.5,
      hx: 0.35,
      hy: (SUTRO_BATHS.roofSpringY - SUTRO_BATHS.deckY) * 0.5,
      hz: backWallDepth * 0.5
    },
    {
      x: SUTRO_BATHS.halfWidth - 0.3,
      y: (SUTRO_BATHS.deckY + SUTRO_BATHS.roofSpringY) * 0.5,
      z: entranceZ + entranceHalfWidth + entryEndWallDepth * 0.5,
      hx: 0.35,
      hy: (SUTRO_BATHS.roofSpringY - SUTRO_BATHS.deckY) * 0.5,
      hz: entryEndWallDepth * 0.5
    }
  );
  for (const step of [...galleryStairBoxes, ...entryStairBoxes]) {
    result.push({
      x: step.x,
      y: step.y,
      z: step.z,
      hx: step.sx * 0.5,
      hy: step.sy * 0.5,
      hz: step.sz * 0.5
    });
  }
  return result;
}

function addPhysicsColliders(
  physics: Physics | undefined,
  specs: readonly SutroBathsColliderSpec[]
): number[] {
  if (!physics) return [];
  const site = getSitePlacement();
  const sin = Math.sin(site.yaw);
  const cos = Math.cos(site.yaw);
  const bodies: number[] = [];
  for (const spec of specs) {
    const x = site.x + cos * spec.x + sin * spec.z;
    const z = site.z - sin * spec.x + cos * spec.z;
    const yaw = site.yaw + (spec.yaw ?? 0);
    const quat: readonly [number, number, number, number] = [0, Math.sin(yaw * 0.5), 0, Math.cos(yaw * 0.5)];
    const body = physics.world.createBox({
      type: BodyType.Static,
      position: [x, spec.y, z],
      halfExtents: [spec.hx, spec.hy, spec.hz],
      friction: 0.86
    });
    physics.world.setBodyTransform(body, [x, spec.y, z], quat);
    physics.addQuerySolid(body, {
      x,
      y: spec.y,
      z,
      hx: spec.hx,
      hy: spec.hy,
      hz: spec.hz,
      quat
    });
    bodies.push(body);
  }
  return bodies;
}

/**
 * Builds the complete restored shell without external media or fetches. The
 * caller can keep this module behind a dynamic import; creation is synchronous
 * and `ready` is immediately resolved for the feature's common preload API.
 */
export function createSutroBathsArchitecture(
  options: SutroBathsArchitectureOptions = {}
): SutroBathsArchitecture {
  const mats = createMaterials();
  const group = new THREE.Group();
  group.name = "sutro_baths_restored_architecture";
  const site = getSitePlacement();
  group.position.set(site.x, 0, site.z);
  group.rotation.y = site.yaw;

  const roof = makeRoof(mats);
  const structure = makeStructuralFrame(mats);
  const pools = makePoolsAndDecks(mats);
  const poolDetails = makeRailingsLaddersAndDiving(mats);
  const oceanGallery = makeOceanWindowGallery(mats);
  const pavilion = makeNorthPavilion(mats);
  const eastGallery = makeEastGalleryAndEndWalls(mats);
  const bleachers = makeTieredBleacherGallery(mats);
  const lamps = makePeriodLamps(mats);
  const entrance = makePointLobosEntrance(mats);
  group.add(
    pools.group,
    structure.group,
    roof.group,
    poolDetails.group,
    oceanGallery.group,
    pavilion.group,
    eastGallery.group,
    bleachers.group,
    lamps.group,
    entrance.group
  );

  const colliderSpecs = makeColliderSpecs(
    pools.dryDecks,
    oceanGallery.galleryDeck,
    oceanGallery.stairBoxes,
    entrance.stairBoxes
  );
  const physicsBodies = addPhysicsColliders(options.physics, colliderSpecs);
  let disposed = false;
  let requestedLampIntensity = DEFAULT_TUNING.lampIntensity;

  const applyTuning = (values: SutroBathsArchitectureTuning) => {
    mats.roofGlass.opacity = THREE.MathUtils.clamp(values.glassOpacity, 0.02, 0.78);
    mats.windowGlass.opacity = THREE.MathUtils.clamp(values.glassOpacity * 1.7, 0.08, 0.72);
    requestedLampIntensity = Math.max(0, values.lampIntensity);
    mats.bulb.emissiveIntensity = 0.55 + Math.min(3.8, requestedLampIntensity * 0.32);
  };
  applyTuning(DEFAULT_TUNING);

  let meshCount = 0;
  let instanceCount =
    roof.instances +
    structure.instances +
    pools.instances +
    poolDetails.instances +
    oceanGallery.instances +
    pavilion.instances +
    eastGallery.instances +
    bleachers.instances +
    lamps.instances +
    entrance.instances;
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount++;
    if (!(mesh as THREE.InstancedMesh).isInstancedMesh) instanceCount++;
  });

  return {
    group,
    ready: Promise.resolve(),
    colliderSpecs,
    applyTuning,
    update(time, values) {
      if (disposed) return;
      if (values) applyTuning(values);
      for (let index = 0; index < lamps.lights.length; index++) {
        const drift = 0.975 + Math.sin(time * 2.1 + index * 2.71) * 0.025;
        lamps.lights[index].intensity = requestedLampIntensity * 11 * drift;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) materials.add(material);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      if (options.physics) {
        for (const body of physicsBodies) {
          options.physics.removeQuerySolid(body);
          options.physics.world.destroyBody(body);
        }
      }
      physicsBodies.length = 0;
      group.removeFromParent();
    },
    stats: {
      meshes: meshCount,
      instances: instanceCount,
      roofRibs: roof.ribCount,
      glassPanels: roof.glassCount + oceanGallery.glassPanels,
      lamps: lamps.fixtureCount,
      physicsBodies: physicsBodies.length
    }
  };
}
