import * as THREE from "three/webgpu";
import {
  Fn,
  cameraViewMatrix,
  clamp,
  exp,
  float,
  instancedArray,
  instanceIndex,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  saturate,
  select,
  sin,
  smoothstep,
  storage,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
  vertexIndex,
  vertexStage
} from "three/tsl";
import type { FolderApi } from "tweakpane";
import { releaseRendererAttribute } from "../../app/rendererRegistry";
import { tunables } from "../../core/persist";
import {
  SOUTH_POND_OUTLINE,
  TEA_GARDEN_WATER_FEATURES,
  pointInTeaGardenPolygon,
  type TeaGardenTerrain,
  type TeaGardenXZ
} from "./layout";
import { TEA_GARDEN_STREAM_AUDIO_ANCHORS } from "./streamAudio";

/**
 * One WebGPU shallow-water field shared by the Drum Bridge stream and pond.
 *
 * The regular grid is both the render lattice and the spatial binning scheme:
 * every cell reads only its four immediate bins. Local Rusanov face fluxes
 * conservatively advance ping-pong (height, x discharge, z discharge, foam)
 * state; reflected ghost states turn the polygon banks and rock mask into solid
 * boundaries. A bounded impulse pass injects gameplay wakes without readback.
 *
 * This path is deliberately WebGPU-only and fails at construction unless the
 * renderer owns a native WebGPU backend.
 */

const GRID_WIDTH = 224;
const GRID_HEIGHT = 272;
const CELL_COUNT = GRID_WIDTH * GRID_HEIGHT;
const FIXED_STEP = 1 / 60;
const MAX_TICKS_PER_FRAME = 2;
const MAX_SIM_HEIGHT = 0.14;
const MAX_SIM_SPEED = 2.4;
const MIN_SIM_DEPTH = 0.08;
const MAX_QUEUED_IMPULSES = 64;
const MAX_IMPULSES_PER_DISPATCH = 24;
const WATER_BOUNDS_PAD = 0.36;
const BANK_INSET = 0.58;
const BANK_WIDTH = 0.72;
const WATER_LIFT = 0.22;
const POND_CENTER = { x: -2289.1, z: 2219.7 } as const;

/** Surveyed visual grade from the north-east mouth to the pond entry. */
export const TEA_GARDEN_WATER_DROP = 0.8;

const WATER_TUNING = tunables("teaGarden.waterSimulation", {
  enabled: { v: true, label: "simulation enabled" },
  flow: { v: 0.48, min: 0, max: 1.6, step: 0.01, label: "downstream flow" },
  depth: { v: 0.38, min: 0.12, max: 1.2, step: 0.01, label: "effective depth" },
  pressure: { v: 5.2, min: 0.2, max: 12, step: 0.1, label: "gravity / wave speed" },
  viscosity: { v: 0.42, min: 0, max: 4, step: 0.02, label: "viscosity" },
  damping: { v: 0.32, min: 0.01, max: 2.5, step: 0.01, label: "wave damping" },
  vorticity: { v: 0.68, min: 0, max: 4, step: 0.02, label: "eddy strength" },
  substeps: { v: 2, min: 1, max: 4, step: 1, label: "solver substeps" },
  rockSlip: { v: 0.76, min: 0, max: 1, step: 0.01, label: "rock slip" },
  interactionScale: { v: 1, min: 0, max: 3, step: 0.02, label: "interaction strength" },
  interactionRadius: { v: 0.58, min: 0.18, max: 2.4, step: 0.02, label: "default ripple radius" },
  wakeResponse: { v: 0.82, min: 0, max: 2.5, step: 0.02, label: "wake response" },
  interactionFoam: { v: 0.12, min: 0, max: 1, step: 0.01, label: "interaction foam" },
  relief: { v: 1, min: 0, max: 2.2, step: 0.02, label: "surface relief" },
  normal: { v: 1.45, min: 0, max: 6, step: 0.05, label: "field-gradient normal" },
  waveContrast: { v: 0.78, min: 0, max: 2, step: 0.02, label: "simulated wave contrast" },
  ripple: { v: 0.0015, min: 0, max: 0.025, step: 0.0005, label: "micro ripple" },
  streak: { v: 0.07, min: 0, max: 1.5, step: 0.01, label: "ink-flow streaks" },
  foam: { v: 0.56, min: 0, max: 2, step: 0.01, label: "foam / eddies" },
  opacity: { v: 0.92, min: 0.45, max: 1, step: 0.01, label: "water opacity" },
  palette: {
    v: "celadon-dusk",
    options: {
      "Celadon dusk": "celadon-dusk",
      "Jade ink": "jade-ink",
      "Moonlit teal": "moonlit-teal"
    },
    label: "palette"
  }
});

type WaterTuningKey = keyof typeof WATER_TUNING.values;

/** Folder metadata lives next to the defaults/ranges so the pane is one schema. */
const WATER_TUNING_FOLDERS: readonly {
  title: string;
  expanded?: boolean;
  keys: WaterTuningKey[];
}[] = [
  {
    title: "shallow-water field",
    expanded: true,
    keys: ["enabled", "flow", "depth", "pressure", "viscosity", "damping", "vorticity", "substeps", "rockSlip"]
  },
  {
    title: "interaction ripples",
    expanded: true,
    keys: ["interactionScale", "interactionRadius", "wakeResponse", "interactionFoam"]
  },
  {
    title: "celadon surface",
    expanded: true,
    keys: ["relief", "normal", "waveContrast", "ripple", "streak", "foam", "opacity", "palette"]
  }
];

const WATER_PALETTES = {
  "celadon-dusk": { deep: 0x1a514b, shallow: 0x6ca989, streak: 0xb8d9b5, foam: 0xe4edcf },
  "jade-ink": { deep: 0x102f2c, shallow: 0x3f8068, streak: 0x8ec49a, foam: 0xdde9c4 },
  "moonlit-teal": { deep: 0x173b44, shallow: 0x689d99, streak: 0xa8cec1, foam: 0xe9eed8 }
} as const;

const FLOW_PATH: readonly TeaGardenXZ[] = [
  [-2261.8, 2182.7],
  [-2265.8, 2186.8],
  [-2269.2, 2188.4],
  [TEA_GARDEN_STREAM_AUDIO_ANCHORS.bridge.x, TEA_GARDEN_STREAM_AUDIO_ANCHORS.bridge.z],
  [-2280.6, 2197.4],
  [-2285.6, 2199.1],
  [TEA_GARDEN_STREAM_AUDIO_ANCHORS.pondEntry.x, TEA_GARDEN_STREAM_AUDIO_ANCHORS.pondEntry.z]
] as const;

const FLOW_PATH_LENGTHS = (() => {
  const lengths = [0];
  for (let i = 1; i < FLOW_PATH.length; i++) {
    lengths.push(
      lengths[i - 1] +
        Math.hypot(FLOW_PATH[i][0] - FLOW_PATH[i - 1][0], FLOW_PATH[i][1] - FLOW_PATH[i - 1][1])
    );
  }
  return lengths;
})();

const FLOW_PATH_LENGTH = FLOW_PATH_LENGTHS[FLOW_PATH_LENGTHS.length - 1];

export type TeaGardenWaterRockSpec = {
  x: number;
  z: number;
  /** Horizontal radius used by both the solver mask and render cutout. */
  radius: number;
  /** Visual size multiplier for the common low-poly stone. */
  scale: number;
  yaw: number;
};

const ROCK_PROFILES = [
  { radius: 0.64, scale: 1.02, yaw: 0.28 },
  { radius: 0.53, scale: 0.86, yaw: 1.31 },
  { radius: 0.76, scale: 1.18, yaw: 2.14 },
  { radius: 0.61, scale: 0.98, yaw: 0.82 },
  { radius: 0.69, scale: 1.08, yaw: 2.74 }
] as const;

/** One deterministic visible obstacle for every procedural audio eddy anchor. */
export const TEA_GARDEN_STREAM_ROCKS: readonly TeaGardenWaterRockSpec[] =
  TEA_GARDEN_STREAM_AUDIO_ANCHORS.eddies.map((anchor, index) => ({
    x: anchor.x,
    z: anchor.z,
    ...ROCK_PROFILES[index % ROCK_PROFILES.length]
  }));

export type TeaGardenWaterPlayer = { x: number; y?: number; z: number };

/**
 * A bounded, world-space disturbance applied by a dedicated GPU pass.
 * `strength` is signed surface displacement in metres. Horizontal velocity is
 * in metres/second, so moving feet, balls, and koi can leave directional wakes.
 */
export type TeaGardenWaterImpulse = {
  x: number;
  z: number;
  radius?: number;
  strength?: number;
  velocityX?: number;
  velocityZ?: number;
  foam?: number;
};

export type TeaGardenWaterSimulationStats = {
  backend: string;
  grid: string;
  gridWidth: number;
  gridHeight: number;
  activeCells: number;
  triangles: number;
  rocks: number;
  dispatches: number;
  totalDispatches: number;
  ticks: number;
  totalTicks: number;
  substeps: number;
  running: boolean;
  playerDistance: number;
  impulseCapacity: number;
  queuedImpulses: number;
  impulses: number;
  totalImpulses: number;
  droppedImpulses: number;
  cfl: number;
  revision: number;
};

export type TeaGardenWaterDebugState = {
  webgpu: true;
  disposed: boolean;
  enabled: boolean;
  accumulator: number;
  pondSurfaceY: number;
  upstreamSurfaceY: number;
  waterDrop: number;
  stats: TeaGardenWaterSimulationStats;
};

export type TeaGardenWaterTuningMonitor = { refresh(): void };

export type TeaGardenWaterSimulation = {
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  shoreline: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  rocks: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  update(dt: number, time: number, player: TeaGardenWaterPlayer): void;
  addTuning(folder: FolderApi): TeaGardenWaterTuningMonitor[];
  syncTuning(): void;
  reset(): void;
  /** Returns false for invalid/out-of-water impulses or when the bounded queue is full. */
  queueImpulse(impulse: TeaGardenWaterImpulse): boolean;
  /** CPU twin of the authored, non-terrain-draped simulation surface. */
  surfaceY(x: number, z: number): number;
  readonly stats: TeaGardenWaterSimulationStats;
  debugState(): TeaGardenWaterDebugState;
  dispose(): void;
};

export type TeaGardenWaterSimulationOptions = {
  renderer: THREE.WebGPURenderer;
  map: TeaGardenTerrain;
};

type QueuedWaterImpulse = Required<TeaGardenWaterImpulse>;

type WaterStorageAttribute = THREE.StorageInstancedBufferAttribute | THREE.StorageBufferAttribute;

function disposeStorageBuffer(node: { value: WaterStorageAttribute }): void {
  releaseRendererAttribute(node.value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function waterBounds() {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const feature of TEA_GARDEN_WATER_FEATURES) {
    for (const [x, z] of feature.outline) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  return {
    minX: minX - WATER_BOUNDS_PAD,
    maxX: maxX + WATER_BOUNDS_PAD,
    minZ: minZ - WATER_BOUNDS_PAD,
    maxZ: maxZ + WATER_BOUNDS_PAD
  };
}

function centroid(outline: readonly TeaGardenXZ[]): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const point of outline) {
    x += point[0];
    z += point[1];
  }
  return { x: x / outline.length, z: z / outline.length };
}

/** Rounded visual bank only; the authored polygons remain the exact solver walls. */
function smoothClosedOutline(
  source: readonly TeaGardenXZ[],
  passes = 2
): TeaGardenXZ[] {
  let points: TeaGardenXZ[] = [...source];
  for (let pass = 0; pass < passes; pass++) {
    const next: TeaGardenXZ[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      next.push(
        [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
        [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]
      );
    }
    points = next;
  }
  return points;
}

function nearestFlowSample(x: number, z: number): {
  progress: number;
  distance: number;
  directionX: number;
  directionZ: number;
} {
  let bestDistanceSq = Infinity;
  let bestProgress = 0;
  let bestDirectionX = -Math.SQRT1_2;
  let bestDirectionZ = Math.SQRT1_2;

  for (let i = 0; i + 1 < FLOW_PATH.length; i++) {
    const ax = FLOW_PATH[i][0];
    const az = FLOW_PATH[i][1];
    const dx = FLOW_PATH[i + 1][0] - ax;
    const dz = FLOW_PATH[i + 1][1] - az;
    const lengthSq = dx * dx + dz * dz;
    const along = lengthSq > 0 ? clamp01(((x - ax) * dx + (z - az) * dz) / lengthSq) : 0;
    const nearestX = ax + dx * along;
    const nearestZ = az + dz * along;
    const distanceSq = (x - nearestX) ** 2 + (z - nearestZ) ** 2;
    if (distanceSq >= bestDistanceSq) continue;
    const length = Math.sqrt(lengthSq) || 1;
    bestDistanceSq = distanceSq;
    bestProgress = (FLOW_PATH_LENGTHS[i] + length * along) / Math.max(FLOW_PATH_LENGTH, 1e-5);
    bestDirectionX = dx / length;
    bestDirectionZ = dz / length;
  }

  return {
    progress: clamp01(bestProgress),
    distance: Math.sqrt(bestDistanceSq),
    directionX: bestDirectionX,
    directionZ: bestDirectionZ
  };
}

function insideWaterFeature(x: number, z: number): boolean {
  return TEA_GARDEN_WATER_FEATURES.some((feature) => pointInTeaGardenPolygon(x, z, feature.outline));
}

function insideWaterSimulation(x: number, z: number): boolean {
  return (
    insideWaterFeature(x, z) &&
    !TEA_GARDEN_STREAM_ROCKS.some((rock) => Math.hypot(x - rock.x, z - rock.z) <= rock.radius)
  );
}

function distanceToSegment(x: number, z: number, a: TeaGardenXZ, b: TeaGardenXZ): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? clamp01(((x - a[0]) * dx + (z - a[1]) * dz) / lengthSq) : 0;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

function signedDistanceToWaterSimulation(x: number, z: number): number {
  // Union of the authored water polygons: max composes signed-distance fields
  // without exposing the stream/pond overlap as an internal visual seam.
  let unionDistance = Number.NEGATIVE_INFINITY;
  for (const feature of TEA_GARDEN_WATER_FEATURES) {
    let edgeDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < feature.outline.length; i++) {
      edgeDistance = Math.min(
        edgeDistance,
        distanceToSegment(x, z, feature.outline[i], feature.outline[(i + 1) % feature.outline.length])
      );
    }
    unionDistance = Math.max(
      unionDistance,
      pointInTeaGardenPolygon(x, z, feature.outline) ? edgeDistance : -edgeDistance
    );
  }
  // Subtract each solid rock circle from the union.
  for (const rock of TEA_GARDEN_STREAM_ROCKS) {
    unionDistance = Math.min(
      unionDistance,
      Math.hypot(x - rock.x, z - rock.z) - rock.radius
    );
  }
  return unionDistance;
}

function distanceToWater(x: number, z: number): number {
  if (insideWaterFeature(x, z)) return 0;
  let distance = Infinity;
  for (const feature of TEA_GARDEN_WATER_FEATURES) {
    for (let i = 0; i < feature.outline.length; i++) {
      distance = Math.min(
        distance,
        distanceToSegment(x, z, feature.outline[i], feature.outline[(i + 1) % feature.outline.length])
      );
    }
  }
  return distance;
}

function samplePondSurfaceLevel(map: TeaGardenTerrain): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of SOUTH_POND_OUTLINE) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  const samples: number[] = [];
  for (let z = minZ; z <= maxZ; z += 0.72) {
    for (let x = minX; x <= maxX; x += 0.72) {
      if (pointInTeaGardenPolygon(x, z, SOUTH_POND_OUTLINE)) samples.push(map.baseGroundTop(x, z));
    }
  }
  if (samples.length === 0) return map.baseGroundTop(POND_CENTER.x, POND_CENTER.z) + WATER_LIFT;
  samples.sort((a, b) => a - b);
  // A level surface that clears most of the uncarved terrain without following
  // every boundary bump; moss banks hide the remaining shallow edge transition.
  const upperQuartile = samples[Math.floor((samples.length - 1) * 0.78)];
  return upperQuartile + WATER_LIFT;
}

function nearestRockField(
  x: number,
  z: number,
  preferredX: number,
  preferredZ: number
): { inside: boolean; influence: number; tangentX: number; tangentZ: number } {
  let nearest: TeaGardenWaterRockSpec | undefined;
  let nearestDistance = Infinity;
  for (const rock of TEA_GARDEN_STREAM_ROCKS) {
    const distance = Math.hypot(x - rock.x, z - rock.z);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = rock;
    }
  }
  if (!nearest) return { inside: false, influence: 0, tangentX: preferredX, tangentZ: preferredZ };

  const radialLength = Math.max(nearestDistance, 1e-5);
  const radialX = (x - nearest.x) / radialLength;
  const radialZ = (z - nearest.z) / radialLength;
  let tangentX = -radialZ;
  let tangentZ = radialX;
  if (tangentX * preferredX + tangentZ * preferredZ < 0) {
    tangentX *= -1;
    tangentZ *= -1;
  }
  return {
    inside: nearestDistance <= nearest.radius,
    influence: 1 - smoothstep01((nearestDistance - nearest.radius) / 1.8),
    tangentX,
    tangentZ
  };
}

function preferredFlowField(x: number, z: number): {
  progress: number;
  pond: number;
  flowX: number;
  flowZ: number;
} {
  const stream = nearestFlowSample(x, z);
  const inPond = pointInTeaGardenPolygon(x, z, SOUTH_POND_OUTLINE);
  const entryDistance = Math.hypot(
    x - TEA_GARDEN_STREAM_AUDIO_ANCHORS.pondEntry.x,
    z - TEA_GARDEN_STREAM_AUDIO_ANCHORS.pondEntry.z
  );
  const pond = inPond ? smoothstep01(entryDistance / 10.5) : 0;
  const centerDx = x - POND_CENTER.x;
  const centerDz = z - POND_CENTER.z;
  const centerLength = Math.max(Math.hypot(centerDx, centerDz), 1e-5);
  // Clockwise circulation carries the incoming south-west flow around the pond
  // rather than letting it die in a uniform radial blur.
  const circulationX = -centerDz / centerLength;
  const circulationZ = centerDx / centerLength;
  let flowX = THREE.MathUtils.lerp(stream.directionX, circulationX, pond * 0.78);
  let flowZ = THREE.MathUtils.lerp(stream.directionZ, circulationZ, pond * 0.78);
  const length = Math.max(Math.hypot(flowX, flowZ), 1e-5);
  flowX /= length;
  flowZ /= length;
  return { progress: stream.progress, pond, flowX, flowZ };
}

function makeShorelineGeometry(
  map: TeaGardenTerrain,
  centerX: number,
  centerZ: number,
  surfaceY: (x: number, z: number) => number
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const innerColor = new THREE.Color(0x557c43);
  const outerColor = new THREE.Color(0x8db665);

  for (const feature of TEA_GARDEN_WATER_FEATURES) {
    const outline = smoothClosedOutline(feature.outline);
    const c = centroid(outline);
    const outwardNormal = (a: TeaGardenXZ, b: TeaGardenXZ) => {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const length = Math.hypot(dx, dz) || 1;
      let x = -dz / length;
      let z = dx / length;
      const midX = (a[0] + b[0]) * 0.5;
      const midZ = (a[1] + b[1]) * 0.5;
      if (x * (midX - c.x) + z * (midZ - c.z) < 0) {
        x *= -1;
        z *= -1;
      }
      return { x, z };
    };
    const base = positions.length / 3;
    for (let i = 0; i < outline.length; i++) {
      const point = outline[i];
      const previous = outline[(i - 1 + outline.length) % outline.length];
      const next = outline[(i + 1) % outline.length];
      const previousNormal = outwardNormal(previous, point);
      const nextNormal = outwardNormal(point, next);
      let miterX = previousNormal.x + nextNormal.x;
      let miterZ = previousNormal.z + nextNormal.z;
      const miterLength = Math.hypot(miterX, miterZ);
      if (miterLength < 1e-4) {
        miterX = nextNormal.x;
        miterZ = nextNormal.z;
      } else {
        miterX /= miterLength;
        miterZ /= miterLength;
      }
      const alignment = Math.max(0.42, miterX * nextNormal.x + miterZ * nextNormal.z);
      const miterScale = Math.min(1.75, 1 / alignment);
      const inner = {
        x: point[0] - miterX * BANK_INSET * miterScale,
        z: point[1] - miterZ * BANK_INSET * miterScale
      };
      const outer = {
        x: point[0] + miterX * BANK_WIDTH * miterScale,
        z: point[1] + miterZ * BANK_WIDTH * miterScale
      };
      positions.push(
        inner.x - centerX, surfaceY(inner.x, inner.z) + 0.075, inner.z - centerZ,
        outer.x - centerX, map.groundTop(outer.x, outer.z) + 0.085, outer.z - centerZ
      );
      colors.push(
        innerColor.r, innerColor.g, innerColor.b,
        outerColor.r, outerColor.g, outerColor.b
      );
    }
    for (let i = 0; i < outline.length; i++) {
      const current = base + i * 2;
      const next = base + ((i + 1) % outline.length) * 2;
      indices.push(current, current + 1, next, next, current + 1, next + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeStreamRocks(
  surfaceY: (x: number, z: number) => number,
  centerX: number,
  centerZ: number
): THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const geometry = new THREE.DodecahedronGeometry(0.64, 0);
  const material = new THREE.MeshStandardMaterial({
    color: 0x4d5545,
    roughness: 0.98,
    metalness: 0,
    flatShading: true,
    vertexColors: true
  });
  const mesh = new THREE.InstancedMesh(geometry, material, TEA_GARDEN_STREAM_ROCKS.length);
  mesh.name = "tea_garden_stream_eddy_obstacle_rocks";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  TEA_GARDEN_STREAM_ROCKS.forEach((rock, index) => {
    dummy.position.set(rock.x - centerX, surfaceY(rock.x, rock.z) - rock.radius * 0.28, rock.z - centerZ);
    dummy.rotation.set((index % 2 ? -1 : 1) * 0.08, rock.yaw, (index % 3 - 1) * 0.07);
    dummy.scale.set(rock.scale * 1.12, rock.scale * 0.78, rock.scale * 0.94);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    color.setHex(index % 2 === 0 ? 0x59604e : 0x454d41).offsetHSL(0, 0, (index - 2) * 0.012);
    mesh.setColorAt(index, color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.renderOrder = 3;
  mesh.userData.obstacles = TEA_GARDEN_STREAM_ROCKS;
  return mesh;
}

export function createTeaGardenWaterSimulation(
  options: TeaGardenWaterSimulationOptions
): TeaGardenWaterSimulation {
  const { renderer, map } = options;
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  if (backend.isWebGPUBackend !== true) {
    throw new Error("Japanese Tea Garden water simulation requires the WebGPU backend");
  }

  const bounds = waterBounds();
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const cellSizeX = (bounds.maxX - bounds.minX) / (GRID_WIDTH - 1);
  const cellSizeZ = (bounds.maxZ - bounds.minZ) / (GRID_HEIGHT - 1);
  const pondSurfaceY = samplePondSurfaceLevel(map);
  const upstreamSurfaceY = pondSurfaceY + TEA_GARDEN_WATER_DROP;

  const surfaceY = (x: number, z: number): number => {
    const authored = pointInTeaGardenPolygon(x, z, SOUTH_POND_OUTLINE)
      ? pondSurfaceY
      : pondSurfaceY + TEA_GARDEN_WATER_DROP * (1 - smoothstep01(nearestFlowSample(x, z).progress));
    // The committed terrain has no carved pond basin. A dense per-cell
    // clearance envelope keeps the unified surface above that terrain without
    // resurrecting the old giant, terrain-crossing triangles.
    return Math.max(authored, map.groundTop(x, z) + WATER_LIFT);
  };

  const positions = new Float32Array(CELL_COUNT * 3);
  const initialStateData = new Float32Array(CELL_COUNT * 4);
  const metadataData = new Float32Array(CELL_COUNT * 4);
  const guideData = new Float32Array(CELL_COUNT * 4);
  const renderBand = new Uint8Array(CELL_COUNT);
  const renderBandWidth = Math.hypot(cellSizeX, cellSizeZ) * 1.6;
  let activeCells = 0;

  for (let gz = 0; gz < GRID_HEIGHT; gz++) {
    const worldZ = bounds.minZ + gz * cellSizeZ;
    for (let gx = 0; gx < GRID_WIDTH; gx++) {
      const index = gz * GRID_WIDTH + gx;
      const worldX = bounds.minX + gx * cellSizeX;
      const stateOffset = index * 4;
      const flow = preferredFlowField(worldX, worldZ);
      const rock = nearestRockField(worldX, worldZ, flow.flowX, flow.flowZ);
      const isActive = insideWaterFeature(worldX, worldZ) && !rock.inside;
      const signedWaterDistance = signedDistanceToWaterSimulation(worldX, worldZ);

      positions[index * 3] = worldX - centerX;
      positions[index * 3 + 1] = surfaceY(worldX, worldZ);
      positions[index * 3 + 2] = worldZ - centerZ;

      metadataData[stateOffset] = isActive ? 1 : 0;
      metadataData[stateOffset + 1] = flow.pond;
      metadataData[stateOffset + 2] = rock.influence;
      metadataData[stateOffset + 3] = signedWaterDistance;
      guideData[stateOffset] = flow.flowX;
      guideData[stateOffset + 1] = flow.flowZ;
      guideData[stateOffset + 2] = rock.tangentX;
      guideData[stateOffset + 3] = rock.tangentZ;

      if (signedWaterDistance >= -renderBandWidth) renderBand[index] = 1;
      if (!isActive) continue;
      activeCells++;
      const authoredRipple =
        Math.sin(worldX * 0.31 + worldZ * 0.17) * 0.0022 +
        Math.sin(worldX * 0.13 - worldZ * 0.23) * 0.0015;
      const initialSpeed = WATER_TUNING.values.flow * THREE.MathUtils.lerp(0.82, 0.18, flow.pond);
      const initialDischarge = initialSpeed * WATER_TUNING.values.depth;
      initialStateData[stateOffset] = authoredRipple;
      initialStateData[stateOffset + 1] = flow.flowX * initialDischarge;
      initialStateData[stateOffset + 2] = flow.flowZ * initialDischarge;
      initialStateData[stateOffset + 3] = rock.influence * 0.12;
    }
  }

  const indices: number[] = [];
  for (let gz = 0; gz < GRID_HEIGHT - 1; gz++) {
    for (let gx = 0; gx < GRID_WIDTH - 1; gx++) {
      const a = gz * GRID_WIDTH + gx;
      const b = a + 1;
      const c = a + GRID_WIDTH;
      const d = c + 1;
      if (renderBand[a] || renderBand[b] || renderBand[c]) indices.push(a, c, b);
      if (renderBand[b] || renderBand[c] || renderBand[d]) indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += MAX_SIM_HEIGHT;

  // State is (surface displacement, x discharge, z discharge, foam). Keeping
  // discharge rather than velocity lets the local finite-volume update remain
  // conservative while still using one naturally aligned vec4 storage slot.
  const initialState = instancedArray(initialStateData, "vec4").toReadOnly();
  const metadata = instancedArray(metadataData, "vec4").toReadOnly();
  const guide = instancedArray(guideData, "vec4").toReadOnly();
  const stateA = instancedArray(CELL_COUNT, "vec4");
  const stateB = instancedArray(CELL_COUNT, "vec4");
  const derivatives = instancedArray(CELL_COUNT, "vec4");
  const impulseHeaderData = new Float32Array(MAX_IMPULSES_PER_DISPATCH * 4);
  const impulseMotionData = new Float32Array(MAX_IMPULSES_PER_DISPATCH * 4);
  // header = (world x, world z, radius, signed height displacement)
  // motion = (x velocity, z velocity, foam, unused)
  const impulseHeaders = instancedArray(impulseHeaderData, "vec4").toReadOnly();
  const impulseMotions = instancedArray(impulseMotionData, "vec4").toReadOnly();

  const metadataRead = storage(metadata.value, "vec4", CELL_COUNT).toReadOnly();
  const guideRead = storage(guide.value, "vec4", CELL_COUNT).toReadOnly();
  const stateARead = storage(stateA.value, "vec4", CELL_COUNT).toReadOnly();
  const stateBRead = storage(stateB.value, "vec4", CELL_COUNT).toReadOnly();
  const derivativesRead = storage(derivatives.value, "vec4", CELL_COUNT).toReadOnly();
  const impulseHeadersRead = storage(
    impulseHeaders.value,
    "vec4",
    MAX_IMPULSES_PER_DISPATCH
  ).toReadOnly();
  const impulseMotionsRead = storage(
    impulseMotions.value,
    "vec4",
    MAX_IMPULSES_PER_DISPATCH
  ).toReadOnly();

  const stepDtU = uniform(FIXED_STEP / 4);
  const timeU = uniform(0);
  const flowU = uniform(0.48);
  const depthU = uniform(0.38);
  const pressureU = uniform(5.2);
  const viscosityU = uniform(0.42);
  const dampingU = uniform(0.32);
  const vorticityU = uniform(0.68);
  const rockSlipU = uniform(0.76);
  const maxSpeedU = uniform(MAX_SIM_SPEED);
  const impulseCountU = uniform(0, "uint");
  const interactionScaleU = uniform(1);
  const wakeResponseU = uniform(0.82);
  const reliefU = uniform(1);
  const normalU = uniform(1.45);
  const waveContrastU = uniform(0.78);
  const rippleU = uniform(0.0015);
  const streakU = uniform(0.07);
  const foamU = uniform(0.56);
  const opacityU = uniform(0.92);
  const deepColorU = uniform(new THREE.Color(WATER_PALETTES["celadon-dusk"].deep));
  const shallowColorU = uniform(new THREE.Color(WATER_PALETTES["celadon-dusk"].shallow));
  const streakColorU = uniform(new THREE.Color(WATER_PALETTES["celadon-dusk"].streak));
  const foamColorU = uniform(new THREE.Color(WATER_PALETTES["celadon-dusk"].foam));

  const resetCompute = Fn(() => {
    const seed = initialState.element(instanceIndex);
    const meta = metadataRead.element(instanceIndex);
    const flowGuide = guideRead.element(instanceIndex);
    const speed = flowU.mul(mix(float(0.82), float(0.18), meta.y));
    const discharge = flowGuide.xy.mul(speed).mul(depthU);
    const value = select(
      meta.x.greaterThan(0.5),
      vec4(seed.x, discharge.x, discharge.y, seed.w),
      vec4(0)
    );
    stateA.element(instanceIndex).assign(value);
    stateB.element(instanceIndex).assign(value);
    derivatives.element(instanceIndex).assign(vec4(0));
  })().compute(CELL_COUNT, [256]);

  // A zero-net-volume Mexican-hat displacement creates a crest and matching
  // trough instead of continuously adding water. Directional velocity turns
  // that radial wave into a foot, ball, or fish wake. The fixed-size loop is
  // deliberately bounded so a burst of gameplay events cannot grow GPU work.
  const impulseCompute = Fn(() => {
    const gx = instanceIndex.mod(uint(GRID_WIDTH));
    const gz = instanceIndex.div(uint(GRID_WIDTH));
    const cell = vec2(
      float(gx).mul(cellSizeX).add(bounds.minX),
      float(gz).mul(cellSizeZ).add(bounds.minZ)
    );
    const meta = metadataRead.element(instanceIndex);
    const value = stateA.element(instanceIndex);
    const heightDelta = float(0).toVar();
    const motionDelta = vec2(0).toVar();
    const foamDelta = float(0).toVar();

    for (let i = 0; i < MAX_IMPULSES_PER_DISPATCH; i++) {
      const header = impulseHeadersRead.element(uint(i));
      const motion = impulseMotionsRead.element(uint(i));
      const enabled = select(uint(i).lessThan(impulseCountU), float(1), float(0));
      const offset = cell.sub(header.xy);
      const radius = header.z.max(Math.min(cellSizeX, cellSizeZ) * 1.5);
      const radiusSquared = offset.dot(offset).div(radius.mul(radius));
      const envelope = exp(radiusSquared.mul(-0.5)).mul(enabled);
      const balancedWave = envelope.mul(float(1).sub(radiusSquared.mul(0.5)));
      heightDelta.addAssign(balancedWave.mul(header.w));
      motionDelta.addAssign(motion.xy.mul(envelope));
      foamDelta.addAssign(motion.z.mul(envelope));
    }

    const nextHeight = clamp(
      value.x.add(heightDelta.mul(interactionScaleU)),
      -MAX_SIM_HEIGHT,
      MAX_SIM_HEIGHT
    );
    const nextDepth = depthU.add(nextHeight).max(MIN_SIM_DEPTH);
    const nextMomentum = value.yz.add(
      motionDelta.mul(nextDepth).mul(wakeResponseU)
    );
    const next = vec4(
      nextHeight,
      nextMomentum.x,
      nextMomentum.y,
      clamp(value.w.add(foamDelta), 0, 1)
    );
    value.assign(select(meta.x.greaterThan(0.5), next, vec4(0)));
  })().compute(CELL_COUNT, [256]);

  const reflectedX = (value: any, slip: any) =>
    vec4(value.x, value.y.negate(), value.z.mul(slip), value.w);
  const reflectedZ = (value: any, slip: any) =>
    vec4(value.x, value.y.mul(slip), value.z.negate(), value.w);

  // Local Lax-Friedrichs (Rusanov) face fluxes. They conservatively transport
  // height and both momentum components and add just enough wave-speed-scaled
  // numerical diffusion to remain stable at discontinuities and stair-stepped
  // polygon/rock boundaries.
  const fluxX = (left: any, right: any) => {
    const leftDepth = depthU.add(left.x).max(MIN_SIM_DEPTH);
    const rightDepth = depthU.add(right.x).max(MIN_SIM_DEPTH);
    const leftU = left.y.div(leftDepth);
    const leftV = left.z.div(leftDepth);
    const rightU = right.y.div(rightDepth);
    const rightV = right.z.div(rightDepth);
    const leftFlux = vec3(
      left.y,
      left.y.mul(leftU).add(pressureU.mul(leftDepth.mul(leftDepth)).mul(0.5)),
      left.y.mul(leftV)
    );
    const rightFlux = vec3(
      right.y,
      right.y.mul(rightU).add(pressureU.mul(rightDepth.mul(rightDepth)).mul(0.5)),
      right.y.mul(rightV)
    );
    const speed = leftU.abs().add(pressureU.mul(leftDepth).sqrt())
      .max(rightU.abs().add(pressureU.mul(rightDepth).sqrt()));
    return leftFlux.add(rightFlux).mul(0.5)
      .sub(right.xyz.sub(left.xyz).mul(speed).mul(0.5));
  };

  const fluxZ = (up: any, down: any) => {
    const upDepth = depthU.add(up.x).max(MIN_SIM_DEPTH);
    const downDepth = depthU.add(down.x).max(MIN_SIM_DEPTH);
    const upU = up.y.div(upDepth);
    const upV = up.z.div(upDepth);
    const downU = down.y.div(downDepth);
    const downV = down.z.div(downDepth);
    const upFlux = vec3(
      up.z,
      up.z.mul(upU),
      up.z.mul(upV).add(pressureU.mul(upDepth.mul(upDepth)).mul(0.5))
    );
    const downFlux = vec3(
      down.z,
      down.z.mul(downU),
      down.z.mul(downV).add(pressureU.mul(downDepth.mul(downDepth)).mul(0.5))
    );
    const speed = upV.abs().add(pressureU.mul(upDepth).sqrt())
      .max(downV.abs().add(pressureU.mul(downDepth).sqrt()));
    return upFlux.add(downFlux).mul(0.5)
      .sub(down.xyz.sub(up.xyz).mul(speed).mul(0.5));
  };

  const buildAnalyze = (source: typeof stateARead) =>
    Fn(() => {
      const gx = instanceIndex.mod(uint(GRID_WIDTH));
      const gz = instanceIndex.div(uint(GRID_WIDTH));
      const leftIndex = select(gx.greaterThan(0), instanceIndex.sub(uint(1)), instanceIndex);
      const rightIndex = select(gx.lessThan(uint(GRID_WIDTH - 1)), instanceIndex.add(uint(1)), instanceIndex);
      const upIndex = select(gz.greaterThan(0), instanceIndex.sub(uint(GRID_WIDTH)), instanceIndex);
      const downIndex = select(gz.lessThan(uint(GRID_HEIGHT - 1)), instanceIndex.add(uint(GRID_WIDTH)), instanceIndex);
      const center = source.element(instanceIndex);
      const centerMeta = metadataRead.element(instanceIndex);
      const left = select(metadataRead.element(leftIndex).x.greaterThan(0.5), source.element(leftIndex), center);
      const right = select(metadataRead.element(rightIndex).x.greaterThan(0.5), source.element(rightIndex), center);
      const up = select(metadataRead.element(upIndex).x.greaterThan(0.5), source.element(upIndex), center);
      const down = select(metadataRead.element(downIndex).x.greaterThan(0.5), source.element(downIndex), center);
      const leftVelocity = left.yz.div(depthU.add(left.x).max(MIN_SIM_DEPTH));
      const rightVelocity = right.yz.div(depthU.add(right.x).max(MIN_SIM_DEPTH));
      const upVelocity = up.yz.div(depthU.add(up.x).max(MIN_SIM_DEPTH));
      const downVelocity = down.yz.div(depthU.add(down.x).max(MIN_SIM_DEPTH));
      const gradientX = right.x.sub(left.x).div(cellSizeX * 2);
      const gradientZ = down.x.sub(up.x).div(cellSizeZ * 2);
      const divergence = rightVelocity.x.sub(leftVelocity.x).div(cellSizeX * 2)
        .add(downVelocity.y.sub(upVelocity.y).div(cellSizeZ * 2));
      const curl = rightVelocity.y.sub(leftVelocity.y).div(cellSizeX * 2)
        .sub(downVelocity.x.sub(upVelocity.x).div(cellSizeZ * 2));
      derivatives.element(instanceIndex).assign(
        select(centerMeta.x.greaterThan(0.5), vec4(gradientX, gradientZ, divergence, curl), vec4(0))
      );
    })().compute(CELL_COUNT, [256]);

  const buildIntegrate = (source: typeof stateARead, destination: typeof stateA) =>
    Fn(() => {
      const gx = instanceIndex.mod(uint(GRID_WIDTH));
      const gz = instanceIndex.div(uint(GRID_WIDTH));
      const leftIndex = select(gx.greaterThan(0), instanceIndex.sub(uint(1)), instanceIndex);
      const rightIndex = select(gx.lessThan(uint(GRID_WIDTH - 1)), instanceIndex.add(uint(1)), instanceIndex);
      const upIndex = select(gz.greaterThan(0), instanceIndex.sub(uint(GRID_WIDTH)), instanceIndex);
      const downIndex = select(gz.lessThan(uint(GRID_HEIGHT - 1)), instanceIndex.add(uint(GRID_WIDTH)), instanceIndex);
      const current = source.element(instanceIndex);
      const meta = metadataRead.element(instanceIndex);
      const flowGuide = guideRead.element(instanceIndex);
      const leftMeta = metadataRead.element(leftIndex);
      const rightMeta = metadataRead.element(rightIndex);
      const upMeta = metadataRead.element(upIndex);
      const downMeta = metadataRead.element(downIndex);
      const leftActive = leftMeta.x.greaterThan(0.5);
      const rightActive = rightMeta.x.greaterThan(0.5);
      const upActive = upMeta.x.greaterThan(0.5);
      const downActive = downMeta.x.greaterThan(0.5);
      const leftSlip = mix(float(0.92), rockSlipU, saturate(leftMeta.z));
      const rightSlip = mix(float(0.92), rockSlipU, saturate(rightMeta.z));
      const upSlip = mix(float(0.92), rockSlipU, saturate(upMeta.z));
      const downSlip = mix(float(0.92), rockSlipU, saturate(downMeta.z));
      const left = select(leftActive, source.element(leftIndex), reflectedX(current, leftSlip));
      const right = select(rightActive, source.element(rightIndex), reflectedX(current, rightSlip));
      const up = select(upActive, source.element(upIndex), reflectedZ(current, upSlip));
      const down = select(downActive, source.element(downIndex), reflectedZ(current, downSlip));

      const conservative = current.xyz
        .sub(fluxX(current, right).sub(fluxX(left, current)).mul(stepDtU.div(cellSizeX)))
        .sub(fluxZ(current, down).sub(fluxZ(up, current)).mul(stepDtU.div(cellSizeZ)));
      const height = clamp(conservative.x, -MAX_SIM_HEIGHT, MAX_SIM_HEIGHT);
      const localDepth = depthU.add(height).max(MIN_SIM_DEPTH);
      const momentum = conservative.yz.toVar();
      const velocity = momentum.div(localDepth).toVar();
      const leftVelocity = left.yz.div(depthU.add(left.x).max(MIN_SIM_DEPTH));
      const rightVelocity = right.yz.div(depthU.add(right.x).max(MIN_SIM_DEPTH));
      const upVelocity = up.yz.div(depthU.add(up.x).max(MIN_SIM_DEPTH));
      const downVelocity = down.yz.div(depthU.add(down.x).max(MIN_SIM_DEPTH));
      const neighborVelocity = leftVelocity.add(rightVelocity).add(upVelocity).add(downVelocity).mul(0.25);
      momentum.addAssign(
        neighborVelocity.sub(velocity)
          .mul(localDepth)
          .mul(clamp(viscosityU.mul(stepDtU), 0, 0.18))
      );

      // The path is a gentle body-force source, not a rendered velocity field.
      // All visible direction, waves, wakes, and obstacle flow come from state.
      const desiredSpeed = flowU.mul(mix(float(0.88), float(0.08), meta.y));
      const desiredVelocity = flowGuide.xy.mul(desiredSpeed);
      momentum.addAssign(
        desiredVelocity.sub(velocity)
          .mul(localDepth)
          .mul(stepDtU)
          .mul(mix(float(0.72), float(0.07), meta.y))
      );

      const curl = rightVelocity.y.sub(leftVelocity.y).div(cellSizeX * 2)
        .sub(downVelocity.x.sub(upVelocity.x).div(cellSizeZ * 2));
      momentum.addAssign(
        vec2(velocity.y.negate(), velocity.x)
          .mul(curl.sign())
          .mul(curl.abs().min(4))
          .mul(vorticityU)
          .mul(stepDtU)
          .mul(localDepth)
          .mul(0.024)
      );
      momentum.addAssign(
        flowGuide.zw.mul(meta.z).mul(vorticityU).mul(flowU)
          .mul(stepDtU).mul(localDepth).mul(0.18)
      );

      // Immediately outside rock cut-outs, retain tangential discharge and
      // remove radial penetration. Reflected face states do the same for the
      // polygon banks while retaining their tangential component.
      const rockConstraint = smoothstep(0.58, 0.98, meta.z);
      const tangentialMomentum = flowGuide.zw
        .mul(momentum.dot(flowGuide.zw))
        .mul(rockSlipU);
      momentum.assign(mix(momentum, tangentialMomentum, rockConstraint.mul(0.72)));
      momentum.x.assign(select(leftActive, momentum.x, momentum.x.max(0)));
      momentum.x.assign(select(rightActive, momentum.x, momentum.x.min(0)));
      momentum.y.assign(select(upActive, momentum.y, momentum.y.max(0)));
      momentum.y.assign(select(downActive, momentum.y, momentum.y.min(0)));
      momentum.mulAssign(
        exp(dampingU.mul(stepDtU).mul(mix(float(1), float(1.45), meta.y)).negate())
      );
      const constrainedVelocity = momentum.div(localDepth);
      const speed = constrainedVelocity.length();
      momentum.mulAssign(
        select(speed.greaterThan(maxSpeedU), maxSpeedU.div(speed.max(1e-5)), float(1))
      );

      const upwindX = select(constrainedVelocity.x.greaterThanEqual(0), left.w, right.w);
      const upwindZ = select(constrainedVelocity.y.greaterThanEqual(0), up.w, down.w);
      const courant = clamp(
        speed.mul(stepDtU).div(Math.min(cellSizeX, cellSizeZ)),
        0,
        0.45
      );
      const transportedFoam = mix(current.w, upwindX.add(upwindZ).mul(0.5), courant);
      const divergence = rightVelocity.x.sub(leftVelocity.x).div(cellSizeX * 2)
        .add(downVelocity.y.sub(upVelocity.y).div(cellSizeZ * 2));
      const turbulence = curl.abs().sub(0.18).max(0).mul(vorticityU).mul(0.13)
        .add(divergence.abs().sub(0.16).max(0).mul(0.11))
        .add(meta.z.mul(speed).mul(0.34));
      const foam = transportedFoam
        .mul(exp(stepDtU.mul(mix(float(0.52), float(0.85), meta.y)).negate()))
        .add(saturate(turbulence).mul(stepDtU).mul(0.72));
      const next = vec4(
        height,
        momentum.x,
        momentum.y,
        clamp(foam, 0, 1)
      );
      destination.element(instanceIndex).assign(select(meta.x.greaterThan(0.5), next, vec4(0)));
    })().compute(CELL_COUNT, [256]);

  const analyzeACompute = buildAnalyze(stateARead);
  const integrateABCompute = buildIntegrate(stateARead, stateB);
  const integrateBACompute = buildIntegrate(stateBRead, stateA);
  const solverGroup = [integrateABCompute, integrateBACompute];

  // A five-bin display reconstruction removes the collocated-grid checkerboard
  // mode while preserving broad pressure ripples and the velocity field. This
  // is the 2D analogue of reconstructing a continuous relief from a particle
  // density field: the solver stays discrete, but the visible body does not.
  const renderedState = vertexStage(
    Fn(() => {
      const gx = vertexIndex.mod(uint(GRID_WIDTH));
      const gz = vertexIndex.div(uint(GRID_WIDTH));
      const leftIndex = select(gx.greaterThan(0), vertexIndex.sub(uint(1)), vertexIndex);
      const rightIndex = select(gx.lessThan(uint(GRID_WIDTH - 1)), vertexIndex.add(uint(1)), vertexIndex);
      const upIndex = select(gz.greaterThan(0), vertexIndex.sub(uint(GRID_WIDTH)), vertexIndex);
      const downIndex = select(gz.lessThan(uint(GRID_HEIGHT - 1)), vertexIndex.add(uint(GRID_WIDTH)), vertexIndex);
      const center = stateARead.element(vertexIndex);
      const left = select(metadataRead.element(leftIndex).x.greaterThan(0.5), stateARead.element(leftIndex), center);
      const right = select(metadataRead.element(rightIndex).x.greaterThan(0.5), stateARead.element(rightIndex), center);
      const up = select(metadataRead.element(upIndex).x.greaterThan(0.5), stateARead.element(upIndex), center);
      const down = select(metadataRead.element(downIndex).x.greaterThan(0.5), stateARead.element(downIndex), center);
      const reconstructedHeight = center.x.mul(0.5)
        .add(left.x.add(right.x).add(up.x).add(down.x).mul(0.125));
      const reconstructedDischarge = center.yz.mul(0.5)
        .add(left.yz.add(right.yz).add(up.yz).add(down.yz).mul(0.125));
      const reconstructedFoam = center.w.mul(0.5)
        .add(left.w.add(right.w).add(up.w).add(down.w).mul(0.125));
      return vec4(reconstructedHeight, reconstructedDischarge.x, reconstructedDischarge.y, reconstructedFoam);
    })()
  );
  const renderedMeta = vertexStage(Fn(() => metadataRead.element(vertexIndex))());
  const renderedDerivatives = vertexStage(Fn(() => derivativesRead.element(vertexIndex))());
  const renderedHeight = renderedState.x.mul(reliefU);
  // Render the evolved discharge everywhere. The old surface substituted an
  // authored guide outside rock wakes, which made the simulation look static.
  const displayedVelocity = renderedState.yz.div(
    depthU.add(renderedState.x).max(MIN_SIM_DEPTH)
  );
  const renderedSpeed = displayedVelocity.length();
  const flowDirection = mix(
    vec2(-Math.SQRT1_2, Math.SQRT1_2),
    displayedVelocity.div(renderedSpeed.max(0.04)),
    smoothstep(0.025, 0.14, renderedSpeed)
  );
  const along = positionWorld.x.mul(flowDirection.x).add(positionWorld.z.mul(flowDirection.y));
  const across = positionWorld.x.mul(flowDirection.y.negate()).add(positionWorld.z.mul(flowDirection.x));
  const brushWave = sin(
    along.mul(1.15).sub(timeU.mul(0.62)).add(sin(across.mul(0.32)).mul(1.2))
  ).mul(0.5).add(0.5);
  const brushBreaks = sin(along.mul(0.21).add(across.mul(0.44)).sub(timeU.mul(0.14))).mul(0.5).add(0.5);
  const streak = smoothstep(0.72, 0.96, brushWave)
    .mul(smoothstep(0.12, 0.72, brushBreaks))
    .mul(streakU)
    .mul(mix(float(1), float(0.25), renderedMeta.y))
    .mul(saturate(renderedSpeed.mul(1.1).add(0.18)));
  const broadLight = sin(positionWorld.x.mul(0.15).add(positionWorld.z.mul(0.11))).mul(0.5).add(0.5);
  const shallow = saturate(
    renderedHeight.mul(1.8)
      .add(broadLight.mul(0.035)).add(renderedMeta.y.mul(0.12)).add(0.28)
  );
  const simulatedSlope = renderedDerivatives.xy.length();
  const crest = smoothstep(0.0025, 0.04, renderedHeight);
  const trough = smoothstep(0.0025, 0.04, renderedHeight.negate());
  const compression = smoothstep(0.1, 0.85, renderedDerivatives.z.abs());
  // Stylized relief comes only from the evolved field: crests catch celadon
  // light, troughs carry a thin ink edge, and compression adds a restrained
  // glint. This makes small gameplay waves readable without drawing fake rings.
  const waveHighlight = saturate(
    smoothstep(0.008, 0.11, simulatedSlope).mul(0.58)
      .add(crest.mul(0.34))
      .add(compression.mul(0.18))
  ).mul(waveContrastU);
  const troughInk = saturate(trough.mul(waveContrastU).mul(0.3));
  const foamHighlight = saturate(
    smoothstep(0.012, 0.58, renderedState.w).mul(foamU)
      .add(renderedMeta.z.mul(0.07).mul(foamU))
      .add(waveHighlight.mul(0.09))
  );
  const waterColor = mix(deepColorU, shallowColorU, shallow);
  const sculptedColor = mix(waterColor, deepColorU.mul(0.72), troughInk);
  const streakedColor = mix(
    sculptedColor,
    streakColorU,
    saturate(streak.mul(0.48).add(waveHighlight.mul(0.48)))
  );
  const shorelineMask = smoothstep(-0.08, 0.12, renderedMeta.w);

  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.52,
    metalness: 0,
    transparent: true,
    depthWrite: false
  });
  material.positionNode = positionLocal.add(vec3(0, renderedHeight, 0));
  material.colorNode = mix(streakedColor, foamColorU, foamHighlight);
  material.emissiveNode = streakColorU.mul(waveHighlight.mul(0.28))
    .add(foamColorU.mul(foamHighlight.mul(0.1)));
  material.opacityNode = opacityU
    .mul(mix(float(0.9), float(1), foamHighlight))
    .mul(shorelineMask);
  // The committed terrain beneath the pond is not a carved basin, so the mesh
  // uses a clearance envelope. Shade it as one water body rather than inheriting
  // every little terrain triangle's normal. The simulated height gradient is
  // the primary normal; the sine terms are only sub-millimetre micro texture.
  const normalWaveX = sin(positionWorld.x.mul(0.72).add(timeU.mul(0.47)))
    .mul(rippleU).mul(normalU).mul(5.5);
  const normalWaveZ = sin(positionWorld.z.mul(0.61).sub(timeU.mul(0.39)))
    .mul(rippleU).mul(normalU).mul(5.5);
  const worldNormal = normalize(vec3(
    normalWaveX.sub(clamp(renderedDerivatives.x.mul(reliefU).mul(normalU), -1.2, 1.2)),
    1,
    normalWaveZ.sub(clamp(renderedDerivatives.y.mul(reliefU).mul(normalU), -1.2, 1.2))
  ));
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz);
  material.envMapIntensity = 0.37;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "tea_garden_unified_webgpu_shallow_water_surface";
  mesh.position.set(centerX, 0, centerZ);
  mesh.castShadow = false;
  // Hard cascaded shadows hid centimetre-scale relief beneath broad dark bands.
  // The PBR surface still receives scene/environment lighting and its simulated
  // normals, while nearby rocks/banks retain grounded shadows.
  mesh.receiveShadow = false;
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;

  const shorelineGeometry = makeShorelineGeometry(map, centerX, centerZ, surfaceY);
  const shorelineMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.98,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide
  });
  const shoreline = new THREE.Mesh(shorelineGeometry, shorelineMaterial);
  shoreline.name = "tea_garden_narrow_green_shoreline_bank";
  shoreline.position.set(centerX, 0, centerZ);
  shoreline.castShadow = false;
  shoreline.receiveShadow = true;
  shoreline.renderOrder = 2;
  shoreline.userData.replacesAsphaltAtWater = true;

  const rocks = makeStreamRocks(surfaceY, centerX, centerZ);
  rocks.position.set(centerX, 0, centerZ);

  const group = new THREE.Group();
  group.name = "japanese_tea_garden_unified_flowing_water";
  group.add(shoreline, rocks, mesh);

  const stats: TeaGardenWaterSimulationStats = {
    backend: "WebGPU storage buffers",
    grid: `${GRID_WIDTH}×${GRID_HEIGHT}`,
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    activeCells,
    triangles: indices.length / 3,
    rocks: TEA_GARDEN_STREAM_ROCKS.length,
    dispatches: 0,
    totalDispatches: 0,
    ticks: 0,
    totalTicks: 0,
    substeps: 2,
    running: false,
    playerDistance: Number.POSITIVE_INFINITY,
    impulseCapacity: MAX_QUEUED_IMPULSES,
    queuedImpulses: 0,
    impulses: 0,
    totalImpulses: 0,
    droppedImpulses: 0,
    cfl: 0,
    revision: 0
  };
  group.userData.waterSimulation = stats;
  mesh.userData.waterSimulation = stats;

  let accumulator = 0;
  let disposed = false;
  const impulseQueue: QueuedWaterImpulse[] = [];

  const countDispatches = (count: number) => {
    stats.dispatches += count;
    stats.totalDispatches += count;
    stats.revision++;
  };

  const syncTuning = () => {
    const tuning = WATER_TUNING.values;
    const substeps = Math.round(THREE.MathUtils.clamp(tuning.substeps, 1, 4));
    stepDtU.value = FIXED_STEP / (substeps * 2);
    flowU.value = tuning.flow;
    depthU.value = tuning.depth;
    pressureU.value = tuning.pressure;
    viscosityU.value = tuning.viscosity;
    dampingU.value = tuning.damping;
    vorticityU.value = tuning.vorticity;
    rockSlipU.value = tuning.rockSlip;
    maxSpeedU.value = Math.min(MAX_SIM_SPEED, Math.max(0.55, tuning.flow * 2.4 + 0.65));
    interactionScaleU.value = tuning.interactionScale;
    wakeResponseU.value = tuning.wakeResponse;
    reliefU.value = tuning.relief;
    normalU.value = tuning.normal;
    waveContrastU.value = tuning.waveContrast;
    rippleU.value = tuning.ripple;
    streakU.value = tuning.streak;
    foamU.value = tuning.foam;
    opacityU.value = tuning.opacity;
    const palette = WATER_PALETTES[tuning.palette as keyof typeof WATER_PALETTES] ?? WATER_PALETTES["celadon-dusk"];
    deepColorU.value.setHex(palette.deep);
    shallowColorU.value.setHex(palette.shallow);
    streakColorU.value.setHex(palette.streak);
    foamColorU.value.setHex(palette.foam);
    stats.substeps = substeps;
    stats.cfl =
      ((maxSpeedU.value + Math.sqrt(tuning.pressure * tuning.depth)) * stepDtU.value) /
      Math.min(cellSizeX, cellSizeZ);
  };

  const queueImpulse = (impulse: TeaGardenWaterImpulse): boolean => {
    if (disposed || impulseQueue.length >= MAX_QUEUED_IMPULSES) {
      stats.droppedImpulses++;
      return false;
    }
    if (!Number.isFinite(impulse.x) || !Number.isFinite(impulse.z)) {
      stats.droppedImpulses++;
      return false;
    }
    const radius = THREE.MathUtils.clamp(
      Number.isFinite(impulse.radius) ? impulse.radius! : WATER_TUNING.values.interactionRadius,
      Math.min(cellSizeX, cellSizeZ) * 1.5,
      3.2
    );
    if (!insideWaterSimulation(impulse.x, impulse.z)) {
      stats.droppedImpulses++;
      return false;
    }
    impulseQueue.push({
      x: impulse.x,
      z: impulse.z,
      radius,
      strength: THREE.MathUtils.clamp(
        Number.isFinite(impulse.strength) ? impulse.strength! : 0.024,
        -MAX_SIM_HEIGHT * 0.82,
        MAX_SIM_HEIGHT * 0.82
      ),
      velocityX: THREE.MathUtils.clamp(
        Number.isFinite(impulse.velocityX) ? impulse.velocityX! : 0,
        -MAX_SIM_SPEED,
        MAX_SIM_SPEED
      ),
      velocityZ: THREE.MathUtils.clamp(
        Number.isFinite(impulse.velocityZ) ? impulse.velocityZ! : 0,
        -MAX_SIM_SPEED,
        MAX_SIM_SPEED
      ),
      foam: THREE.MathUtils.clamp(
        Number.isFinite(impulse.foam) ? impulse.foam! : WATER_TUNING.values.interactionFoam,
        0,
        1
      )
    });
    stats.queuedImpulses = impulseQueue.length;
    return true;
  };

  const applyQueuedImpulses = (): boolean => {
    const count = Math.min(impulseQueue.length, MAX_IMPULSES_PER_DISPATCH);
    if (count === 0) return false;
    for (let i = 0; i < count; i++) {
      const impulse = impulseQueue[i];
      const offset = i * 4;
      impulseHeaderData[offset] = impulse.x;
      impulseHeaderData[offset + 1] = impulse.z;
      impulseHeaderData[offset + 2] = impulse.radius;
      impulseHeaderData[offset + 3] = impulse.strength;
      impulseMotionData[offset] = impulse.velocityX;
      impulseMotionData[offset + 1] = impulse.velocityZ;
      impulseMotionData[offset + 2] = impulse.foam;
      impulseMotionData[offset + 3] = 0;
    }
    impulseHeaders.value.needsUpdate = true;
    impulseMotions.value.needsUpdate = true;
    impulseCountU.value = count;
    renderer.compute(impulseCompute);
    countDispatches(1);
    impulseQueue.splice(0, count);
    impulseCountU.value = 0;
    stats.impulses += count;
    stats.totalImpulses += count;
    stats.queuedImpulses = impulseQueue.length;
    // Always advance at least one stable solve step so the newly injected wake
    // is boundary-constrained and starts propagating in this rendered frame.
    accumulator = Math.max(accumulator, FIXED_STEP);
    return true;
  };

  const reset = () => {
    if (disposed) return;
    accumulator = 0;
    impulseQueue.length = 0;
    stats.dispatches = 0;
    stats.ticks = 0;
    stats.impulses = 0;
    stats.queuedImpulses = 0;
    syncTuning();
    renderer.compute(resetCompute);
    countDispatches(1);
    stats.running = false;
  };

  const update = (dt: number, time: number, player: TeaGardenWaterPlayer) => {
    if (disposed) return;
    stats.dispatches = 0;
    stats.ticks = 0;
    stats.impulses = 0;
    stats.playerDistance = distanceToWater(player.x, player.z);
    timeU.value = Number.isFinite(time) ? time : 0;
    syncTuning();
    if (!WATER_TUNING.values.enabled) {
      accumulator = 0;
      stats.running = false;
      return;
    }

    const appliedImpulse = applyQueuedImpulses();
    accumulator = Math.min(
      accumulator + Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1),
      FIXED_STEP * MAX_TICKS_PER_FRAME
    );
    while (accumulator >= FIXED_STEP && stats.ticks < MAX_TICKS_PER_FRAME) {
      for (let substep = 0; substep < stats.substeps; substep++) {
        renderer.compute(solverGroup);
        countDispatches(solverGroup.length);
      }
      accumulator -= FIXED_STEP;
      stats.ticks++;
      stats.totalTicks++;
    }
    if (stats.ticks > 0 || appliedImpulse) {
      renderer.compute(analyzeACompute);
      countDispatches(1);
    }
    stats.running = stats.ticks > 0 || appliedImpulse;
  };

  const addTuning = (folder: FolderApi): TeaGardenWaterTuningMonitor[] => {
    for (const descriptor of WATER_TUNING_FOLDERS) {
      const child = folder.addFolder({ title: descriptor.title, expanded: descriptor.expanded });
      WATER_TUNING.bind(child, { keys: descriptor.keys, onChange: () => syncTuning() });
    }
    folder.addButton({ title: "reset water field", label: "water" }).on("click", reset);
    const debug = folder.addFolder({ title: "GPU field · debug" });
    return [
      debug.addBinding(stats, "backend", { readonly: true, label: "backend" }),
      debug.addBinding(stats, "grid", { readonly: true, label: "spatial grid" }),
      debug.addBinding(stats, "activeCells", { readonly: true, label: "active cells" }),
      debug.addBinding(stats, "triangles", { readonly: true, label: "surface triangles" }),
      debug.addBinding(stats, "rocks", { readonly: true, label: "eddy rocks" }),
      debug.addBinding(stats, "dispatches", { readonly: true, label: "dispatches/frame" }),
      debug.addBinding(stats, "ticks", { readonly: true, label: "fixed ticks/frame" }),
      debug.addBinding(stats, "impulses", { readonly: true, label: "impulses/frame" }),
      debug.addBinding(stats, "queuedImpulses", { readonly: true, label: "queued impulses" }),
      debug.addBinding(stats, "droppedImpulses", { readonly: true, label: "dropped impulses" }),
      debug.addBinding(stats, "cfl", {
        readonly: true,
        label: "solver CFL",
        format: (value: number) => value.toFixed(3)
      }),
      debug.addBinding(stats, "running", { readonly: true, label: "running" }),
      debug.addBinding(stats, "playerDistance", {
        readonly: true,
        label: "player distance",
        format: (value: number) => (Number.isFinite(value) ? value.toFixed(1) : "—")
      })
    ];
  };

  const debugState = (): TeaGardenWaterDebugState => ({
    webgpu: true,
    disposed,
    enabled: WATER_TUNING.values.enabled,
    accumulator,
    pondSurfaceY,
    upstreamSurfaceY,
    waterDrop: TEA_GARDEN_WATER_DROP,
    stats
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    group.removeFromParent();
    resetCompute.dispose();
    impulseCompute.dispose();
    analyzeACompute.dispose();
    integrateABCompute.dispose();
    integrateBACompute.dispose();
    geometry.dispose();
    material.dispose();
    shorelineGeometry.dispose();
    shorelineMaterial.dispose();
    rocks.geometry.dispose();
    rocks.material.dispose();
    disposeStorageBuffer(initialState);
    disposeStorageBuffer(metadata);
    disposeStorageBuffer(guide);
    disposeStorageBuffer(stateA);
    disposeStorageBuffer(stateB);
    disposeStorageBuffer(derivatives);
    disposeStorageBuffer(impulseHeaders);
    disposeStorageBuffer(impulseMotions);
    impulseQueue.length = 0;
  };

  syncTuning();
  reset();

  return {
    group,
    mesh,
    shoreline,
    rocks,
    update,
    addTuning,
    syncTuning,
    reset,
    queueImpulse,
    surfaceY,
    stats,
    debugState,
    dispose
  };
}
