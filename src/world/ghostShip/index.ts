import * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import { createGhostShipCollision } from "./collision";
import {
  GHOST_SHIP_DECK_EXIT_LOCAL,
  GHOST_SHIP_DECK_TOP,
  GHOST_SHIP_RAIL_INTERVALS,
  GHOST_SHIP_STAIR_BOTTOM_Y,
  GHOST_SHIP_STAIR_INNER_X,
  GHOST_SHIP_STAIR_OUTER_X,
  GHOST_SHIP_STAIR_STEPS,
  GHOST_SHIP_STAIR_WIDTH,
  GHOST_SHIP_STAIR_ZS,
  ghostShipRailXAtZ
} from "./collisionLayout";
import { createGhostShipSteam, RainbowStarShower } from "./effects";
import { createGhostShipHotTubWater } from "./hotTubWater";
import {
  GHOST_SHIP_SEAT_COUNT,
  ghostShipClaimSeat,
  type GhostShipPose
} from "./route";
import { GHOST_SHIP_TUNING } from "./tuning";

export {
  GHOST_SHIP_LANDMARK_NAME,
  GHOST_SHIP_RIDE_ID,
  GHOST_SHIP_SEAT_COUNT,
  ghostShipClaimSeat
} from "./route";

const BOARDING_RADIUS = 6;
const BOARDING_LOCALS = ([-1, 1] as const).flatMap((side) =>
  GHOST_SHIP_STAIR_ZS.flatMap((z) => [
    new THREE.Vector3(
      side * (GHOST_SHIP_STAIR_INNER_X + GHOST_SHIP_STAIR_OUTER_X) * 0.5,
      (GHOST_SHIP_DECK_TOP + GHOST_SHIP_STAIR_BOTTOM_Y) * 0.5,
      z
    ),
    new THREE.Vector3(side * GHOST_SHIP_STAIR_OUTER_X, GHOST_SHIP_STAIR_BOTTOM_Y + 0.9, z),
    new THREE.Vector3(side * GHOST_SHIP_STAIR_INNER_X, GHOST_SHIP_DECK_TOP + 0.9, z)
  ])
);
const SEATS = [
  new THREE.Vector3(-3.2, 2.2, 15),
  new THREE.Vector3(3.2, 2.2, 15),
  new THREE.Vector3(-4.7, 2.2, 7),
  new THREE.Vector3(4.7, 2.2, 7),
  new THREE.Vector3(-4.9, 2.2, 0),
  new THREE.Vector3(4.9, 2.2, 0),
  new THREE.Vector3(-4.6, 2.2, -7),
  new THREE.Vector3(4.6, 2.2, -7),
  new THREE.Vector3(-3.1, 2.2, -19),
  new THREE.Vector3(3.1, 2.2, -19),
  new THREE.Vector3(-1.8, 3.25, -13),
  new THREE.Vector3(1.8, 3.25, -13)
] as const;

if (SEATS.length !== GHOST_SHIP_SEAT_COUNT) {
  throw new Error("Ghost ship seat contract is out of sync");
}

type ShipModel = {
  landingStairs: THREE.Group | null;
  flightGates: THREE.Group | null;
  fairyLights: THREE.InstancedMesh | null;
  fairyBaseHues: Float32Array;
  fairyMaterial: THREE.MeshBasicMaterial;
  glowLights: THREE.PointLight[];
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
};

export type GhostShip = {
  root: THREE.Group;
  update(
    dt: number,
    time: number,
    pose: GhostShipPose,
    playerPosition: THREE.Vector3,
    localRider: boolean,
    walkerBody: number
  ): void;
  warmup(): Promise<void>;
  nearbyBoarding(playerPosition: THREE.Vector3): boolean;
  board(playerPosition: THREE.Vector3, occupiedSeats: readonly number[]): number;
  /** Map/teleport boarding — ignores gangplank proximity and landed state. */
  claimDeckSeat(occupiedSeats: readonly number[]): number;
  seatPose(seat: number, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): boolean;
  /** Safe on-deck dismount target; returns the ship-relative facing yaw. */
  deckDismountPose(seat: number, outPosition: THREE.Vector3): number | null;
  tuningDescriptor(): DebugFeatureTuningRegistration;
  readonly stats: {
    backend: string;
    waterGrid: string;
    horizontalDistance: number;
    landed: boolean;
    landing: string;
    waterRunning: boolean;
    waterDispatches: number;
    steamVisible: number;
    showerActive: boolean;
    starsVisible: number;
    collisionBodies: number;
    walkerAboard: boolean;
    stairsDeployed: boolean;
  };
  dispose(): void;
};

function createHullGeometry(): THREE.BufferGeometry {
  const sections = [
    { z: -24, width: 0.45, top: 0.55, bottom: -1 },
    { z: -19, width: 4.1, top: 1.15, bottom: -3.2 },
    { z: -9, width: 6.15, top: 1.35, bottom: -4.7 },
    { z: 8, width: 6.25, top: 1.35, bottom: -4.8 },
    { z: 19, width: 4.15, top: 1.05, bottom: -3.15 },
    { z: 24, width: 0.38, top: 0.45, bottom: -0.8 }
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const section of sections) {
    positions.push(
      -section.width, section.top, section.z,
      section.width, section.top, section.z,
      section.width * 0.96, -1.15, section.z,
      0, section.bottom, section.z,
      -section.width * 0.96, -1.15, section.z
    );
  }
  for (let ring = 0; ring < sections.length - 1; ring++) {
    const a = ring * 5;
    const b = (ring + 1) * 5;
    for (let side = 0; side < 5; side++) {
      const next = (side + 1) % 5;
      indices.push(a + side, b + side, a + next, a + next, b + side, b + next);
    }
  }
  indices.push(0, 1, 2, 0, 2, 3, 0, 3, 4);
  const last = (sections.length - 1) * 5;
  indices.push(last, last + 2, last + 1, last, last + 3, last + 2, last, last + 4, last + 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createDeckGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -23.2);
  shape.bezierCurveTo(5.1, -20, 6.25, -9, 6.15, 4);
  shape.bezierCurveTo(6.05, 15, 3.7, 21.5, 0, 23.4);
  shape.bezierCurveTo(-3.7, 21.5, -6.05, 15, -6.15, 4);
  shape.bezierCurveTo(-6.25, -9, -5.1, -20, 0, -23.2);
  const geometry = new THREE.ShapeGeometry(shape, 32);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function createSailGeometry(width: number, height: number, curve: number): THREE.BufferGeometry {
  const columns = 10;
  const rows = 12;
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const uvs = new Float32Array((columns + 1) * (rows + 1) * 2);
  const indices: number[] = [];
  let vertex = 0;
  for (let y = 0; y <= rows; y++) {
    const v = y / rows;
    const taper = 0.68 + Math.sin(v * Math.PI) * 0.32;
    for (let x = 0; x <= columns; x++) {
      const u = x / columns;
      const offset = vertex * 3;
      positions[offset] = (u - 0.5) * width * taper;
      positions[offset + 1] = (v - 0.5) * height;
      positions[offset + 2] = Math.sin(u * Math.PI) * curve * (0.55 + Math.sin(v * Math.PI) * 0.45);
      uvs[vertex * 2] = u;
      uvs[vertex * 2 + 1] = v;
      vertex++;
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const a = y * (columns + 1) + x;
      const b = a + 1;
      const c = a + columns + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addTube(
  parent: THREE.Object3D,
  points: THREE.Vector3[],
  radius: number,
  material: THREE.Material,
  model: ShipModel,
  closed = false
): THREE.Mesh {
  const geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, closed), points.length * 8, radius, 6, closed);
  const mesh = new THREE.Mesh(geometry, material);
  parent.add(mesh);
  model.geometries.add(geometry);
  return mesh;
}

function buildLandingAccess(
  root: THREE.Object3D,
  stairMaterial: THREE.Material,
  trimMaterial: THREE.Material,
  model: ShipModel
): void {
  const stairs = new THREE.Group();
  stairs.name = "ghost_ship_landing_stairs";
  stairs.visible = false;
  root.add(stairs);

  const stairCount = GHOST_SHIP_STAIR_ZS.length * 2 * GHOST_SHIP_STAIR_STEPS;
  const stepGeometry = new THREE.BoxGeometry(1, 1, 1);
  model.geometries.add(stepGeometry);
  const steps = new THREE.InstancedMesh(stepGeometry, stairMaterial, stairCount);
  steps.name = "ghost_ship_landing_stair_treads";
  steps.receiveShadow = true;
  const dummy = new THREE.Object3D();
  const stepRun =
    (GHOST_SHIP_STAIR_OUTER_X - GHOST_SHIP_STAIR_INNER_X) /
    GHOST_SHIP_STAIR_STEPS;
  let instance = 0;
  for (const side of [-1, 1] as const) {
    for (const z of GHOST_SHIP_STAIR_ZS) {
      for (let step = 0; step < GHOST_SHIP_STAIR_STEPS; step++) {
        const t0 = step / GHOST_SHIP_STAIR_STEPS;
        const t1 = (step + 1) / GHOST_SHIP_STAIR_STEPS;
        const t = (t0 + t1) * 0.5;
        const surfaceY = THREE.MathUtils.lerp(GHOST_SHIP_STAIR_BOTTOM_Y, GHOST_SHIP_DECK_TOP, t1);
        const previousY = THREE.MathUtils.lerp(GHOST_SHIP_STAIR_BOTTOM_Y, GHOST_SHIP_DECK_TOP, t0);
        const height = Math.max(0.18, surfaceY - previousY + 0.05);
        dummy.position.set(
          side * THREE.MathUtils.lerp(GHOST_SHIP_STAIR_OUTER_X, GHOST_SHIP_STAIR_INNER_X, t),
          surfaceY - height * 0.5,
          z
        );
        dummy.scale.set(stepRun + 0.1, height, GHOST_SHIP_STAIR_WIDTH - 0.16);
        dummy.updateMatrix();
        steps.setMatrixAt(instance++, dummy.matrix);
      }

      for (const edge of [-1, 1] as const) {
        const railZ = z + edge * GHOST_SHIP_STAIR_WIDTH * 0.5;
        addTube(
          stairs,
          [
            new THREE.Vector3(side * GHOST_SHIP_STAIR_OUTER_X, GHOST_SHIP_STAIR_BOTTOM_Y + 0.9, railZ),
            new THREE.Vector3(
              side * (GHOST_SHIP_STAIR_INNER_X + GHOST_SHIP_STAIR_OUTER_X) * 0.5,
              (GHOST_SHIP_STAIR_BOTTOM_Y + GHOST_SHIP_DECK_TOP) * 0.5 + 0.9,
              railZ
            ),
            new THREE.Vector3(side * GHOST_SHIP_STAIR_INNER_X, GHOST_SHIP_DECK_TOP + 0.9, railZ)
          ],
          0.085,
          trimMaterial,
          model
        );
        addTube(
          stairs,
          [
            new THREE.Vector3(side * GHOST_SHIP_STAIR_OUTER_X, GHOST_SHIP_STAIR_BOTTOM_Y + 0.08, railZ),
            new THREE.Vector3(side * GHOST_SHIP_STAIR_INNER_X, GHOST_SHIP_DECK_TOP + 0.08, railZ)
          ],
          0.11,
          trimMaterial,
          model
        );
      }
    }
  }
  steps.instanceMatrix.needsUpdate = true;
  stairs.add(steps);

  const flightGates = new THREE.Group();
  flightGates.name = "ghost_ship_flight_stair_gates";
  root.add(flightGates);
  const halfGap = GHOST_SHIP_STAIR_WIDTH * 0.55;
  for (const side of [-1, 1] as const) {
    for (const z of GHOST_SHIP_STAIR_ZS) {
      addTube(
        flightGates,
        [
          new THREE.Vector3(ghostShipRailXAtZ(side, z - halfGap), 2.05, z - halfGap),
          new THREE.Vector3(ghostShipRailXAtZ(side, z), 2.05, z),
          new THREE.Vector3(ghostShipRailXAtZ(side, z + halfGap), 2.05, z + halfGap)
        ],
        0.095,
        trimMaterial,
        model
      );
    }
  }
  model.landingStairs = stairs;
  model.flightGates = flightGates;
}

function buildShip(root: THREE.Group): ShipModel {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  const hullMaterial = new THREE.MeshStandardMaterial({
    color: 0x251539,
    roughness: 0.62,
    metalness: 0.18,
    emissive: 0x180d36,
    emissiveIntensity: 1.1,
    transparent: true,
    opacity: 0.94
  });
  const ghostMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x57dfff).multiplyScalar(1.4),
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    side: THREE.BackSide
  });
  const deckMaterial = new THREE.MeshStandardMaterial({
    color: 0x493061,
    roughness: 0.7,
    metalness: 0.1,
    emissive: 0x190e2c,
    emissiveIntensity: 0.8
  });
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: 0x9a6cd1,
    roughness: 0.38,
    metalness: 0.64,
    emissive: 0x321455,
    emissiveIntensity: 1.5
  });
  const sailMaterial = new THREE.MeshStandardMaterial({
    color: 0x7fd7e8,
    roughness: 0.38,
    metalness: 0.04,
    emissive: 0x4c7dff,
    emissiveIntensity: 1.75,
    transparent: true,
    opacity: 0.54,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const fairyMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  for (const material of [hullMaterial, ghostMaterial, deckMaterial, trimMaterial, sailMaterial, fairyMaterial]) {
    materials.add(material);
  }

  const hullGeometry = createHullGeometry();
  geometries.add(hullGeometry);
  const hull = new THREE.Mesh(hullGeometry, hullMaterial);
  hull.castShadow = true;
  hull.receiveShadow = true;
  root.add(hull);
  const ghostShellGeometry = hullGeometry.clone();
  ghostShellGeometry.scale(1.04, 1.04, 1.025);
  geometries.add(ghostShellGeometry);
  const ghostShell = new THREE.Mesh(ghostShellGeometry, ghostMaterial);
  ghostShell.renderOrder = 9;
  root.add(ghostShell);

  const deckGeometry = createDeckGeometry();
  geometries.add(deckGeometry);
  const deck = new THREE.Mesh(deckGeometry, deckMaterial);
  deck.position.y = 1.37;
  deck.receiveShadow = true;
  root.add(deck);

  const mastGeometry = new THREE.CylinderGeometry(0.22, 0.38, 25, 8);
  geometries.add(mastGeometry);
  for (const [z, height, scale] of [[-6, 25, 1], [8, 21, 0.82], [18, 14, 0.58]] as const) {
    const mast = new THREE.Mesh(mastGeometry, trimMaterial);
    mast.scale.set(scale, height / 25, scale);
    mast.position.set(0, 1.3 + height * 0.5, z);
    mast.castShadow = true;
    root.add(mast);
  }

  const sails = [
    { width: 15.5, height: 11.5, y: 15.5, z: -6, curve: 1.55 },
    { width: 12.8, height: 9.2, y: 13.2, z: 8, curve: 1.25 },
    { width: 8.2, height: 6.4, y: 9.5, z: 18, curve: 0.85 }
  ];
  for (const sailSpec of sails) {
    const geometry = createSailGeometry(sailSpec.width, sailSpec.height, sailSpec.curve);
    geometries.add(geometry);
    const sail = new THREE.Mesh(geometry, sailMaterial);
    sail.position.set(0.22, sailSpec.y, sailSpec.z - 0.4);
    sail.castShadow = false;
    sail.renderOrder = 8;
    root.add(sail);
  }

  const model: ShipModel = {
    landingStairs: null,
    flightGates: null,
    fairyLights: null,
    fairyBaseHues: new Float32Array(),
    fairyMaterial,
    glowLights: [],
    geometries,
    materials
  };

  for (const side of [-1, 1] as const) {
    for (const [z0, z1] of GHOST_SHIP_RAIL_INTERVALS) {
      const railPoints: THREE.Vector3[] = [];
      const segments = Math.ceil((z1 - z0) / 3);
      for (let i = 0; i <= segments; i++) {
        const z = THREE.MathUtils.lerp(z0, z1, i / segments);
        railPoints.push(new THREE.Vector3(ghostShipRailXAtZ(side, z), 2.05, z));
      }
      addTube(root, railPoints, 0.095, trimMaterial, model);
    }
  }
  addTube(
    root,
    [
      new THREE.Vector3(-5.3, 2.45, -18),
      new THREE.Vector3(0, 20.2, -6),
      new THREE.Vector3(5.3, 2.45, 17)
    ],
    0.06,
    trimMaterial,
    model
  );

  const bulbGeometry = new THREE.SphereGeometry(0.17, 8, 5);
  geometries.add(bulbGeometry);
  const bulbCount = 76;
  const fairyLights = new THREE.InstancedMesh(bulbGeometry, fairyMaterial, bulbCount);
  fairyLights.name = "ghost_ship_fairy_lights";
  const fairyBaseHues = new Float32Array(bulbCount);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < bulbCount; i++) {
    const railCount = 52;
    if (i < railCount) {
      const side = i % 2 === 0 ? -1 : 1;
      const t = Math.floor(i / 2) / 25;
      dummy.position.set(side * (3.55 + Math.sin(t * Math.PI) * 2.52), 2.25, -20.5 + t * 41);
    } else {
      const t = (i - railCount) / (bulbCount - railCount - 1);
      dummy.position.set(Math.sin(t * Math.PI * 2) * 0.7, 4 + t * 18, -6 + Math.cos(t * Math.PI * 2) * 0.6);
    }
    dummy.updateMatrix();
    fairyLights.setMatrixAt(i, dummy.matrix);
    fairyBaseHues[i] = (i * 0.137 + (i % 5) * 0.08) % 1;
    color.setHSL(fairyBaseHues[i], 0.92, 0.68).multiplyScalar(GHOST_SHIP_TUNING.values.fairyBrightness);
    fairyLights.setColorAt(i, color);
  }
  fairyLights.instanceMatrix.needsUpdate = true;
  if (fairyLights.instanceColor) fairyLights.instanceColor.needsUpdate = true;
  root.add(fairyLights);

  const glowLights = [
    new THREE.PointLight(0x65ebff, 16, 44, 2),
    new THREE.PointLight(0xff6ee1, 12, 34, 2),
    new THREE.PointLight(0xffd270, 10, 30, 2)
  ];
  glowLights[0].position.set(0, 7, -6);
  glowLights[1].position.set(0, 4, 18);
  glowLights[2].position.set(0, 4, -14);
  root.add(...glowLights);

  // Ornate forward crystal and antler-like spectral figurehead.
  const crystalGeometry = new THREE.OctahedronGeometry(1.6, 1);
  geometries.add(crystalGeometry);
  const crystal = new THREE.Mesh(crystalGeometry, sailMaterial);
  crystal.position.set(0, 1.4, -25.3);
  crystal.rotation.z = Math.PI / 4;
  root.add(crystal);
  addTube(root, [new THREE.Vector3(0, 0, -23), new THREE.Vector3(-3.2, 2.5, -27), new THREE.Vector3(-5, 5.4, -26)], 0.14, trimMaterial, model);
  addTube(root, [new THREE.Vector3(0, 0, -23), new THREE.Vector3(3.2, 2.5, -27), new THREE.Vector3(5, 5.4, -26)], 0.14, trimMaterial, model);

  buildLandingAccess(root, deckMaterial, trimMaterial, model);
  model.fairyLights = fairyLights;
  model.fairyBaseHues = fairyBaseHues;
  model.glowLights = glowLights;
  return model;
}

export function createGhostShip(options: {
  scene: THREE.Scene;
  renderer: THREE.WebGPURenderer;
  physics: Physics;
}): GhostShip {
  const { scene, renderer, physics } = options;
  const root = new THREE.Group();
  root.name = "the_wandering_ghost_ship";
  root.visible = false;
  scene.add(root);
  const model = buildShip(root);
  const collision = createGhostShipCollision(physics, root);

  const tub = new THREE.Group();
  tub.name = "ghost_ship_hot_tub";
  tub.position.set(0, 2.65, -13);
  root.add(tub);
  const tubMaterial = new THREE.MeshStandardMaterial({
    color: 0x72568f,
    roughness: 0.38,
    metalness: 0.5,
    emissive: 0x271b55,
    emissiveIntensity: 1.4
  });
  model.materials.add(tubMaterial);
  const wallSpecs = [
    [0, -2.35, 7.7, 0.55, 0.38],
    [0, 2.35, 7.7, 0.55, 0.38],
    [-3.65, 0, 0.55, 4.25, 0.38],
    [3.65, 0, 0.55, 4.25, 0.38]
  ] as const;
  for (const [x, z, width, length, height] of wallSpecs) {
    const geometry = new THREE.BoxGeometry(width, height, length);
    model.geometries.add(geometry);
    const wall = new THREE.Mesh(geometry, tubMaterial);
    wall.position.set(x, 0, z);
    tub.add(wall);
  }

  const water = createGhostShipHotTubWater(renderer);
  tub.add(water.group);
  const steam = createGhostShipSteam();
  steam.group.position.y = 0.08;
  tub.add(steam.group);
  const shower = new RainbowStarShower(scene);
  const boardingWorld = new THREE.Vector3();
  const seatScratch = new THREE.Vector3();
  const dismountScratch = new THREE.Vector3();
  const color = new THREE.Color();
  let disposed = false;
  let fairyClock = 0;
  let lastPose: GhostShipPose | null = null;

  const stats = {
    backend: water.stats.backend,
    waterGrid: water.stats.grid,
    horizontalDistance: Number.POSITIVE_INFINITY,
    landed: false,
    landing: "—",
    waterRunning: false,
    waterDispatches: 0,
    steamVisible: 0,
    showerActive: false,
    starsVisible: 0,
    collisionBodies: collision.bodyCount,
    walkerAboard: false,
    stairsDeployed: false
  };

  const applyPose = (pose: GhostShipPose) => {
    root.position.set(pose.x, pose.y, pose.z);
    root.rotation.order = "YXZ";
    root.rotation.set(pose.pitch, pose.yaw, pose.roll);
    root.updateMatrixWorld(true);
    if (model.landingStairs) model.landingStairs.visible = pose.landed;
    if (model.flightGates) model.flightGates.visible = !pose.landed;
  };

  const nearbyBoarding = (playerPosition: THREE.Vector3): boolean => {
    if (!lastPose?.landed) return false;
    for (const local of BOARDING_LOCALS) {
      boardingWorld.copy(local);
      root.localToWorld(boardingWorld);
      if (boardingWorld.distanceTo(playerPosition) <= BOARDING_RADIUS) return true;
    }
    return false;
  };

  const syncFairyLights = (time: number) => {
    const brightness = GHOST_SHIP_TUNING.values.fairyBrightness;
    for (let i = 0; i < model.fairyBaseHues.length; i++) {
      const hue = (model.fairyBaseHues[i] + time * 0.018 + Math.sin(time * 0.9 + i) * 0.018 + 1) % 1;
      color.setHSL(hue, 0.94, 0.68).multiplyScalar(brightness);
      model.fairyLights?.setColorAt(i, color);
    }
    if (model.fairyLights?.instanceColor) model.fairyLights.instanceColor.needsUpdate = true;
    for (let i = 0; i < model.glowLights.length; i++) {
      model.glowLights[i].intensity = (9 + i * 2.2) * brightness;
    }
  };

  return {
    root,
    async warmup() {
      await water.warmup();
    },
    update(dt, time, pose, playerPosition, localRider, walkerBody) {
      if (disposed) return;
      lastPose = pose;
      root.visible = true;
      applyPose(pose);
      collision.sync(dt, walkerBody, pose.landed);
      stats.horizontalDistance = Math.hypot(playerPosition.x - pose.x, playerPosition.z - pose.z);
      stats.landed = pose.landed;
      stats.landing = pose.landingName ?? "roaming";
      fairyClock -= dt;
      if (fairyClock <= 0) {
        fairyClock = 0.12;
        syncFairyLights(time);
      }
      const closeDistance = playerPosition.distanceTo(root.position);
      const waterActive = localRider || closeDistance <= GHOST_SHIP_TUNING.values.waterDistance;
      water.update(dt, time, waterActive);
      const steamActive = localRider || closeDistance <= 360;
      steam.update(dt, time, GHOST_SHIP_TUNING.values.steamAmount, steamActive);
      shower.update(dt, pose.showerActive, GHOST_SHIP_TUNING.values.showerAmount, root.position);
      stats.waterRunning = water.stats.running;
      stats.waterDispatches = water.stats.dispatches;
      stats.steamVisible = steam.visible;
      stats.showerActive = pose.showerActive;
      stats.starsVisible = shower.visible;
      stats.walkerAboard = collision.walkerAboard;
      stats.stairsDeployed = pose.landed;
    },
    nearbyBoarding,
    board(playerPosition, occupiedSeats) {
      if (!nearbyBoarding(playerPosition)) return 0;
      return ghostShipClaimSeat(occupiedSeats);
    },
    claimDeckSeat(occupiedSeats) {
      return ghostShipClaimSeat(occupiedSeats);
    },
    seatPose(seat, outPosition, outQuaternion) {
      const index = Math.round(seat) - 1;
      if (index < 0 || index >= SEATS.length || !root.visible) return false;
      seatScratch.copy(SEATS[index]);
      root.localToWorld(seatScratch);
      outPosition.copy(seatScratch);
      root.getWorldQuaternion(outQuaternion);
      return true;
    },
    deckDismountPose(seat, outPosition) {
      const index = Math.round(seat) - 1;
      const target = GHOST_SHIP_DECK_EXIT_LOCAL[index];
      if (!target || !root.visible) return null;
      dismountScratch.set(target[0], target[1], target[2]);
      root.localToWorld(dismountScratch);
      outPosition.copy(dismountScratch);
      return root.rotation.y;
    },
    tuningDescriptor() {
      return {
        id: "wandering-ghost-ship",
        title: "Wandering ghost ship",
        build(folder) {
          const travel = folder.addFolder({ title: "fairy lights", expanded: true });
          GHOST_SHIP_TUNING.bind(travel, {
            keys: ["fairyBrightness"]
          });
          const particles = folder.addFolder({ title: "particles", expanded: true });
          GHOST_SHIP_TUNING.bind(particles, {
            keys: ["steamAmount", "showerAmount"]
          });
          const fluid = folder.addFolder({ title: "WebGPU hot-tub fluid", expanded: true });
          GHOST_SHIP_TUNING.bind(fluid, {
            keys: ["waterEnabled", "waterDistance", "waterWaveSpeed", "waterDamping"]
          });
          folder.addButton({ title: "reset hot-tub water", label: "fluid" }).on("click", () => water.reset());
          const debug = folder.addFolder({ title: "debug", expanded: false });
          return {
            monitors: [
              debug.addBinding(stats, "backend", { readonly: true }),
              debug.addBinding(stats, "waterGrid", { readonly: true, label: "water grid" }),
              debug.addBinding(stats, "horizontalDistance", {
                readonly: true,
                label: "player distance",
                format: (value: number) => Number.isFinite(value) ? value.toFixed(1) : "—"
              }),
              debug.addBinding(stats, "landed", { readonly: true }),
              debug.addBinding(stats, "landing", { readonly: true }),
              debug.addBinding(stats, "waterRunning", { readonly: true, label: "fluid running" }),
              debug.addBinding(stats, "waterDispatches", { readonly: true, label: "dispatches/frame" }),
              debug.addBinding(stats, "steamVisible", { readonly: true, label: "steam puffs" }),
              debug.addBinding(stats, "showerActive", { readonly: true, label: "star shower" }),
              debug.addBinding(stats, "starsVisible", { readonly: true, label: "rainbow stars" }),
              debug.addBinding(stats, "collisionBodies", { readonly: true, label: "collision bodies" }),
              debug.addBinding(stats, "walkerAboard", { readonly: true, label: "walker aboard" }),
              debug.addBinding(stats, "stairsDeployed", { readonly: true, label: "landing stairs" })
            ]
          };
        },
        sync() {
          syncFairyLights(0);
        }
      };
    },
    stats,
    dispose() {
      if (disposed) return;
      disposed = true;
      water.dispose();
      steam.dispose();
      shower.dispose();
      collision.dispose();
      root.removeFromParent();
      for (const geometry of model.geometries) geometry.dispose();
      for (const material of model.materials) material.dispose();
      model.geometries.clear();
      model.materials.clear();
    }
  };
}
