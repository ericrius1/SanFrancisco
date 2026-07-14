import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  clamp,
  color,
  cos,
  exp,
  float,
  instancedArray,
  instanceIndex,
  mix,
  normalLocal,
  normalize,
  positionLocal,
  positionWorld,
  saturate,
  select,
  sin,
  storage,
  transformNormalToView,
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
import type { TeaGardenTerrain } from "./layout";

/**
 * GPU granular heightfield for the karesansui garden.
 *
 * The simulation intentionally is not a fluid solver. A conservative thermal-
 * erosion pass moves only the part of a height difference above sand's angle
 * of repose. Rake stamps cut seven swept troughs and put nearly the same volume
 * back into their shoulders; short, capped settling then lets sharp cuts slump
 * into believable grains without turning into water.
 *
 * TSL storage buffers keep the full simulation on WebGPU. There are no CPU
 * readbacks and no compatibility path for another rendering backend.
 */

const GRID_WIDTH = 192;
const GRID_HEIGHT = 112;
const CELL_COUNT = GRID_WIDTH * GRID_HEIGHT;
// The granular solve stays compact while a one-draw, 2× reconstruction grid
// carries the visible surface. Rebuilding this buffer only while the state is
// dirty is substantially cheaper than quadrupling every avalanche dispatch.
const DISPLAY_SUBDIVISIONS = 2;
const DISPLAY_WIDTH = (GRID_WIDTH - 1) * DISPLAY_SUBDIVISIONS + 1;
const DISPLAY_HEIGHT = (GRID_HEIGHT - 1) * DISPLAY_SUBDIVISIONS + 1;
const DISPLAY_CELL_COUNT = DISPLAY_WIDTH * DISPLAY_HEIGHT;
const TINE_COUNT = 7;
const FIXED_STEP = 1 / 60;
const MAX_SETTLE_TICKS_PER_FRAME = 2;
const MAX_STAMPS_PER_FRAME = 6;
const MAX_QUEUED_STAMPS = 18;
const EDGE_INSET = 0.16;
const MAX_RENDER_RELIEF = 0.16;
const MAX_HEIGHT_SCALE = 2.25;

const SAND_TUNING = tunables("teaGarden.sandSimulation", {
  reposeDeg: { v: 32, min: 18, max: 42, step: 0.5, label: "angle of repose (°)" },
  avalancheRate: { v: 0.46, min: 0.05, max: 0.9, step: 0.01, label: "avalanche rate" },
  maxTransfer: { v: 0.018, min: 0.002, max: 0.05, step: 0.001, label: "max transfer (m)" },
  settleIterations: { v: 1, min: 0, max: 3, step: 1, label: "settle iterations" },
  settleTime: { v: 1.25, min: 0.1, max: 4, step: 0.05, label: "settle time (s)" },
  memoryFade: { v: 0.035, min: 0, max: 0.4, step: 0.005, label: "mark fade (/s)" },
  rakeDepth: { v: 0.052, min: 0.008, max: 0.11, step: 0.002, label: "rake depth (m)" },
  tineRadius: { v: 0.042, min: 0.018, max: 0.09, step: 0.002, label: "tine radius (m)" },
  tineSpacing: { v: 0.15, min: 0.08, max: 0.24, step: 0.005, label: "tine spacing (m)" },
  shoulderLift: { v: 0.64, min: 0.15, max: 1.1, step: 0.01, label: "shoulder lift" },
  compaction: { v: 0.14, min: 0, max: 0.5, step: 0.01, label: "compaction / pass" },
  surfaceSmoothing: { v: 0.62, min: 0, max: 1, step: 0.01, label: "surface smoothing" },
  heightScale: { v: 1, min: 0.25, max: MAX_HEIGHT_SCALE, step: 0.05, label: "height relief" },
  normalStrength: { v: 0.92, min: 0, max: 2, step: 0.02, label: "relief shading" },
  microRelief: { v: 0.00055, min: 0, max: 0.002, step: 0.00005, label: "grain relief" },
  compactionTint: { v: 0.18, min: 0, max: 0.4, step: 0.01, label: "rake mark contrast" }
});

export type SandSimulationPoint = { x: number; z: number };

export type SandSimulationRock = {
  x: number;
  z: number;
  /** World-space radius excluded from both the render mesh and the simulation. */
  radius: number;
};

export type SandRakeStamp = {
  /** Previous and current world-space centre of the rake's tine contact line. */
  previous: SandSimulationPoint;
  current: SandSimulationPoint;
  /** World-space unit direction along the seven-tine head. */
  across: SandSimulationPoint;
  /** World-space pull direction; stored in the sand for directional shading. */
  pull: SandSimulationPoint;
  /** Optional contact/animation pressure multiplier. */
  strength?: number;
};

export type SandSimulationStats = {
  grid: string;
  gridWidth: number;
  gridHeight: number;
  displayGrid: string;
  displayVertices: number;
  activeCells: number;
  queuedStamps: number;
  /** GPU dispatches issued by the most recent update/reset. */
  dispatches: number;
  totalDispatches: number;
  dirtySeconds: number;
  settling: boolean;
  revision: number;
};

export type SandTuningMonitor = { refresh(): void };

export type SandSimulation = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  queueStamp(stamp: SandRakeStamp): void;
  update(dt: number): void;
  reset(): void;
  addTuning(folder: FolderApi): SandTuningMonitor[];
  /** Re-apply uniforms after the global `.` tuning reset. */
  syncTuning(): void;
  readonly stats: SandSimulationStats;
  dispose(): void;
};

export type SandSimulationOptions = {
  renderer: THREE.WebGPURenderer;
  map: TeaGardenTerrain;
  center: SandSimulationPoint;
  radii: SandSimulationPoint;
  rocks?: readonly SandSimulationRock[];
  sandLift?: number;
};

type QueuedStamp = {
  previousX: number;
  previousZ: number;
  currentX: number;
  currentZ: number;
  acrossX: number;
  acrossZ: number;
  pullX: number;
  pullZ: number;
  strength: number;
};

type SandStorageAttribute = THREE.StorageInstancedBufferAttribute | THREE.StorageBufferAttribute;

function normalised(point: SandSimulationPoint, fallbackX: number, fallbackZ: number): SandSimulationPoint {
  let x = point.x;
  let z = point.z;
  let length = Math.hypot(x, z);
  if (length < 1e-5) {
    x = fallbackX;
    z = fallbackZ;
    length = Math.hypot(x, z);
  }
  if (length < 1e-5) return { x: 0, z: 1 };
  return { x: x / length, z: z / length };
}

function hash01(x: number, z: number): number {
  let value = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b);
  value = Math.imul(value ^ z ^ (value >>> 13), 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function grooveProfile(distance: number, depth: number, width: number): number {
  const trough = Math.exp(-0.5 * (distance / width) ** 2);
  const shoulderWidth = width * 0.78;
  const shoulderDistance = Math.abs(distance) - width * 1.9;
  const shoulder = Math.exp(-0.5 * (shoulderDistance / shoulderWidth) ** 2);
  return -depth * trough + depth * 0.62 * shoulder;
}

/** A hand-composed quiet starting rake: breathing currents plus stone ripples. */
function initialHeight(
  localX: number,
  localZ: number,
  gridX: number,
  gridZ: number,
  rocks: readonly SandSimulationRock[],
  center: SandSimulationPoint
): { height: number; compaction: number } {
  let height = (hash01(gridX, gridZ) - 0.5) * 0.0016;
  let compaction = 0;

  for (let row = 0; row < 15; row++) {
    const baseZ = -5.25 + row * 0.75;
    const currentZ = baseZ + Math.sin(localX * 0.34 + row * 0.58) * 0.22;
    const distance = localZ - currentZ;
    const trough = Math.exp(-0.5 * (distance / 0.067) ** 2);
    height += grooveProfile(distance, 0.015, 0.067);
    compaction = Math.max(compaction, trough * 0.09);
  }

  for (const rock of rocks) {
    const dx = localX - (rock.x - center.x);
    const dz = localZ - (rock.z - center.z);
    const ellipticalDistance = Math.hypot(dx / 1.1, dz / 0.92);
    for (let ring = 0; ring < 3; ring++) {
      const target = rock.radius * (1.28 + ring * 0.33);
      const distance = ellipticalDistance - target;
      const width = 0.058 + ring * 0.006;
      const trough = Math.exp(-0.5 * (distance / width) ** 2);
      height += grooveProfile(distance, 0.013 - ring * 0.0015, width);
      compaction = Math.max(compaction, trough * 0.08);
    }
  }

  return {
    height: THREE.MathUtils.clamp(height, -0.042, 0.032),
    compaction
  };
}

function disposeStorageBuffer(node: { value: SandStorageAttribute }): void {
  releaseRendererAttribute(node.value);
}

export function createSandSimulation(options: SandSimulationOptions): SandSimulation {
  const { renderer, map, center, radii, rocks = [], sandLift = 0.12 } = options;
  const cellSizeX = (radii.x * 2) / (GRID_WIDTH - 1);
  const cellSizeZ = (radii.z * 2) / (GRID_HEIGHT - 1);
  const meanCellSize = (cellSizeX + cellSizeZ) * 0.5;

  const initialState = new Float32Array(CELL_COUNT * 4);
  let activeCells = 0;
  const isActivePoint = (localX: number, localZ: number, worldX: number, worldZ: number) => {
    const ellipseX = localX / Math.max(0.1, radii.x - EDGE_INSET);
    const ellipseZ = localZ / Math.max(0.1, radii.z - EDGE_INSET);
    const outsideRock = !rocks.some(
      (rock) => Math.hypot(worldX - rock.x, worldZ - rock.z) <= rock.radius
    );
    return ellipseX * ellipseX + ellipseZ * ellipseZ <= 1 && outsideRock;
  };

  for (let gz = 0; gz < GRID_HEIGHT; gz++) {
    const localZ = -radii.z + gz * cellSizeZ;
    for (let gx = 0; gx < GRID_WIDTH; gx++) {
      const index = gz * GRID_WIDTH + gx;
      const localX = -radii.x + gx * cellSizeX;
      const worldX = center.x + localX;
      const worldZ = center.z + localZ;
      const isActive = isActivePoint(localX, localZ, worldX, worldZ);

      if (isActive) {
        const authored = initialHeight(localX, localZ, gx, gz, rocks, center);
        activeCells++;
        initialState[index * 4] = authored.height;
        initialState[index * 4 + 1] = authored.compaction;
        initialState[index * 4 + 2] = 1;
        initialState[index * 4 + 3] = 0;
      } else {
        initialState[index * 4 + 1] = -1;
      }
    }
  }

  const displayCellSizeX = (radii.x * 2) / (DISPLAY_WIDTH - 1);
  const displayCellSizeZ = (radii.z * 2) / (DISPLAY_HEIGHT - 1);
  const positions = new Float32Array(DISPLAY_CELL_COUNT * 3);
  const displayActive = new Uint8Array(DISPLAY_CELL_COUNT);
  for (let gz = 0; gz < DISPLAY_HEIGHT; gz++) {
    const localZ = -radii.z + gz * displayCellSizeZ;
    for (let gx = 0; gx < DISPLAY_WIDTH; gx++) {
      const index = gz * DISPLAY_WIDTH + gx;
      const localX = -radii.x + gx * displayCellSizeX;
      const worldX = center.x + localX;
      const worldZ = center.z + localZ;
      displayActive[index] = isActivePoint(localX, localZ, worldX, worldZ) ? 1 : 0;
      positions[index * 3] = localX;
      positions[index * 3 + 1] = map.groundTop(worldX, worldZ) + sandLift;
      positions[index * 3 + 2] = localZ;
    }
  }

  const indices: number[] = [];
  for (let gz = 0; gz < DISPLAY_HEIGHT - 1; gz++) {
    for (let gx = 0; gx < DISPLAY_WIDTH - 1; gx++) {
      const a = gz * DISPLAY_WIDTH + gx;
      const b = a + 1;
      const c = a + DISPLAY_WIDTH;
      const d = c + 1;
      if (displayActive[a] && displayActive[b] && displayActive[c]) indices.push(a, c, b);
      if (displayActive[b] && displayActive[c] && displayActive[d]) indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += MAX_RENDER_RELIEF * MAX_HEIGHT_SCALE;

  // vec4 keeps every cell naturally aligned to a 16-byte WebGPU storage slot.
  const initial = instancedArray(initialState, "vec4").toReadOnly();
  const stateA = instancedArray(CELL_COUNT, "vec4");
  const stateB = instancedArray(CELL_COUNT, "vec4");
  const flux = instancedArray(CELL_COUNT, "vec4");
  // Height, compaction, dHeight/dX and dHeight/dZ for the dense display mesh.
  const displayState = instancedArray(DISPLAY_CELL_COUNT, "vec4");

  // Separate read-only views permit arbitrary neighbour loads while the write
  // nodes remain valid storage-buffer destinations in the compute pipelines.
  const stateARead = storage(stateA.value, "vec4", CELL_COUNT).toReadOnly();
  const stateBRead = storage(stateB.value, "vec4", CELL_COUNT).toReadOnly();
  const fluxRead = storage(flux.value, "vec4", CELL_COUNT).toReadOnly();
  const displayStateRead = storage(displayState.value, "vec4", DISPLAY_CELL_COUNT).toReadOnly();

  const reposeThresholdU = uniform(Math.tan(THREE.MathUtils.degToRad(32)) * meanCellSize);
  const avalancheRateU = uniform(0.46);
  const maxTransferU = uniform(0.018);
  const memoryRetentionU = uniform(0.9994);
  const previousU = uniform(new THREE.Vector2());
  const currentU = uniform(new THREE.Vector2());
  const acrossU = uniform(new THREE.Vector2(1, 0));
  const pullU = uniform(new THREE.Vector2(0, 1));
  const stampStrengthU = uniform(1);
  const rakeDepthU = uniform(0.052);
  const tineRadiusU = uniform(0.042);
  const tineSpacingU = uniform(0.15);
  const shoulderLiftU = uniform(0.64);
  const compactionU = uniform(0.14);
  const surfaceSmoothingU = uniform(0.62);
  const heightScaleU = uniform(1);
  const normalStrengthU = uniform(0.92);
  const microReliefU = uniform(0.00055);
  const compactionTintU = uniform(0.18);

  const resetCompute = Fn(() => {
    const value = initial.element(instanceIndex);
    stateA.element(instanceIndex).assign(value);
    stateB.element(instanceIndex).assign(value);
    flux.element(instanceIndex).assign(vec4(0));
  })().compute(CELL_COUNT, [256]);

  const stampCompute = Fn(() => {
    const gx = instanceIndex.mod(uint(GRID_WIDTH));
    const gz = instanceIndex.div(uint(GRID_WIDTH));
    const cell = vec2(
      float(gx).mul(cellSizeX).sub(radii.x),
      float(gz).mul(cellSizeZ).sub(radii.z)
    );
    const value = stateA.element(instanceIndex);
    const delta = float(0).toVar();
    const pressed = float(0).toVar();

    for (let tine = 0; tine < TINE_COUNT; tine++) {
      const offset = tineSpacingU.mul(tine - (TINE_COUNT - 1) * 0.5);
      const start = previousU.add(acrossU.mul(offset));
      const end = currentU.add(acrossU.mul(offset));
      const sweep = end.sub(start);
      const along = clamp(
        cell.sub(start).dot(sweep).div(sweep.dot(sweep).max(1e-5)),
        0,
        1
      );
      const distance = cell.sub(start.add(sweep.mul(along))).length();
      const trough = exp(distance.div(tineRadiusU).pow(2).mul(-0.5));
      const shoulderWidth = tineRadiusU.mul(0.78);
      const shoulder = exp(
        distance
          .sub(tineRadiusU.mul(1.9))
          .div(shoulderWidth)
          .pow(2)
          .mul(-0.5)
      );
      delta.addAssign(
        shoulder.mul(rakeDepthU).mul(shoulderLiftU).sub(trough.mul(rakeDepthU))
      );
      pressed.addAssign(trough);
    }

    If(value.y.greaterThanEqual(0), () => {
      value.x.assign(
        clamp(value.x.add(delta.mul(stampStrengthU)), -MAX_RENDER_RELIEF, MAX_RENDER_RELIEF)
      );
      value.y.assign(clamp(value.y.add(pressed.mul(compactionU).mul(stampStrengthU)), 0, 1));
      value.z.assign(pullU.x);
      value.w.assign(pullU.y);
    });
  })().compute(CELL_COUNT, [256]);

  const buildFlux = (
    source: typeof stateARead
  ) => Fn(() => {
    const gx = instanceIndex.mod(uint(GRID_WIDTH));
    const gz = instanceIndex.div(uint(GRID_WIDTH));
    const leftIndex = select(gx.greaterThan(0), instanceIndex.sub(uint(1)), instanceIndex);
    const rightIndex = select(gx.lessThan(uint(GRID_WIDTH - 1)), instanceIndex.add(uint(1)), instanceIndex);
    const upIndex = select(gz.greaterThan(0), instanceIndex.sub(uint(GRID_WIDTH)), instanceIndex);
    const downIndex = select(gz.lessThan(uint(GRID_HEIGHT - 1)), instanceIndex.add(uint(GRID_WIDTH)), instanceIndex);
    const value = source.element(instanceIndex);
    const left = source.element(leftIndex);
    const right = source.element(rightIndex);
    const up = source.element(upIndex);
    const down = source.element(downIndex);
    const cellActive = value.y.greaterThanEqual(0);
    const leftExcess = select(
      cellActive.and(left.y.greaterThanEqual(0)),
      value.x.sub(left.x).sub(reposeThresholdU).max(0),
      float(0)
    );
    const rightExcess = select(
      cellActive.and(right.y.greaterThanEqual(0)),
      value.x.sub(right.x).sub(reposeThresholdU).max(0),
      float(0)
    );
    const upExcess = select(
      cellActive.and(up.y.greaterThanEqual(0)),
      value.x.sub(up.x).sub(reposeThresholdU).max(0),
      float(0)
    );
    const downExcess = select(
      cellActive.and(down.y.greaterThanEqual(0)),
      value.x.sub(down.x).sub(reposeThresholdU).max(0),
      float(0)
    );
    const sum = leftExcess.add(rightExcess).add(upExcess).add(downExcess);
    const moved = sum.mul(avalancheRateU).min(maxTransferU);
    const scale = select(sum.greaterThan(1e-7), moved.div(sum.max(1e-7)), float(0));
    flux.element(instanceIndex).assign(
      vec4(
        leftExcess.mul(scale),
        rightExcess.mul(scale),
        upExcess.mul(scale),
        downExcess.mul(scale)
      )
    );
  })().compute(CELL_COUNT, [256]);

  const buildIntegrate = (
    source: typeof stateARead,
    destination: typeof stateA
  ) => Fn(() => {
    const gx = instanceIndex.mod(uint(GRID_WIDTH));
    const gz = instanceIndex.div(uint(GRID_WIDTH));
    const leftIndex = select(gx.greaterThan(0), instanceIndex.sub(uint(1)), instanceIndex);
    const rightIndex = select(gx.lessThan(uint(GRID_WIDTH - 1)), instanceIndex.add(uint(1)), instanceIndex);
    const upIndex = select(gz.greaterThan(0), instanceIndex.sub(uint(GRID_WIDTH)), instanceIndex);
    const downIndex = select(gz.lessThan(uint(GRID_HEIGHT - 1)), instanceIndex.add(uint(GRID_WIDTH)), instanceIndex);
    const value = source.element(instanceIndex);
    const ownFlux = fluxRead.element(instanceIndex);
    const incoming = fluxRead.element(leftIndex).y
      .add(fluxRead.element(rightIndex).x)
      .add(fluxRead.element(upIndex).w)
      .add(fluxRead.element(downIndex).z);
    const outgoing = ownFlux.x.add(ownFlux.y).add(ownFlux.z).add(ownFlux.w);
    const next = vec4(
      value.x.add(incoming).sub(outgoing),
      value.y.max(0).mul(memoryRetentionU),
      value.z.mul(memoryRetentionU),
      value.w.mul(memoryRetentionU)
    );
    destination.element(instanceIndex).assign(
      select(value.y.greaterThanEqual(0), next, value)
    );
  })().compute(CELL_COUNT, [256]);

  const fluxACompute = buildFlux(stateARead);
  const integrateABCompute = buildIntegrate(stateARead, stateB);
  const fluxBCompute = buildFlux(stateBRead);
  const integrateBACompute = buildIntegrate(stateBRead, stateA);
  const settleGroup = [fluxACompute, integrateABCompute, fluxBCompute, integrateBACompute];

  // Mask-aware bilinear sampling prevents inactive rock/ellipse cells (whose
  // compaction sentinel is -1) from bleeding into the reconstructed surface.
  const sampleSimulationState = (coordinate: any) => {
    const x = clamp(coordinate.x, 0, GRID_WIDTH - 1);
    const z = clamp(coordinate.y, 0, GRID_HEIGHT - 1);
    const x0 = x.floor();
    const z0 = z.floor();
    const x1 = x0.add(1).min(GRID_WIDTH - 1);
    const z1 = z0.add(1).min(GRID_HEIGHT - 1);
    const ix0 = uint(x0);
    const iz0 = uint(z0);
    const ix1 = uint(x1);
    const iz1 = uint(z1);
    const fractionX = x.fract();
    const fractionZ = z.fract();
    const state00 = stateARead.element(iz0.mul(uint(GRID_WIDTH)).add(ix0));
    const state10 = stateARead.element(iz0.mul(uint(GRID_WIDTH)).add(ix1));
    const state01 = stateARead.element(iz1.mul(uint(GRID_WIDTH)).add(ix0));
    const state11 = stateARead.element(iz1.mul(uint(GRID_WIDTH)).add(ix1));
    const weight00 = fractionX.oneMinus().mul(fractionZ.oneMinus());
    const weight10 = fractionX.mul(fractionZ.oneMinus());
    const weight01 = fractionX.oneMinus().mul(fractionZ);
    const weight11 = fractionX.mul(fractionZ);
    const validWeight00 = select(state00.y.greaterThanEqual(0), weight00, float(0));
    const validWeight10 = select(state10.y.greaterThanEqual(0), weight10, float(0));
    const validWeight01 = select(state01.y.greaterThanEqual(0), weight01, float(0));
    const validWeight11 = select(state11.y.greaterThanEqual(0), weight11, float(0));
    const weightSum = validWeight00.add(validWeight10).add(validWeight01).add(validWeight11);
    const weighted = state00.mul(validWeight00)
      .add(state10.mul(validWeight10))
      .add(state01.mul(validWeight01))
      .add(state11.mul(validWeight11));
    return select(
      weightSum.greaterThan(1e-6),
      weighted.div(weightSum.max(1e-6)),
      vec4(0, -1, 0, 0)
    );
  };

  const displayReconstructCompute = Fn(() => {
    const displayX = instanceIndex.mod(uint(DISPLAY_WIDTH));
    const displayZ = instanceIndex.div(uint(DISPLAY_WIDTH));
    const coordinate = vec2(
      float(displayX).div(DISPLAY_SUBDIVISIONS),
      float(displayZ).div(DISPLAY_SUBDIVISIONS)
    );
    const centerState = sampleSimulationState(coordinate);
    // Wider finite differences trade cell-scale sparkle for a continuous sand
    // sheet. A small cross-filter softens the height itself without erasing the
    // conservative coarse field or widening the physical rake brush.
    const gradientRadius = mix(float(0.55), float(1.45), surfaceSmoothingU);
    const leftRaw = sampleSimulationState(vec2(coordinate.x.sub(gradientRadius), coordinate.y));
    const rightRaw = sampleSimulationState(vec2(coordinate.x.add(gradientRadius), coordinate.y));
    const upRaw = sampleSimulationState(vec2(coordinate.x, coordinate.y.sub(gradientRadius)));
    const downRaw = sampleSimulationState(vec2(coordinate.x, coordinate.y.add(gradientRadius)));
    const left = select(leftRaw.y.greaterThanEqual(0), leftRaw, centerState);
    const right = select(rightRaw.y.greaterThanEqual(0), rightRaw, centerState);
    const up = select(upRaw.y.greaterThanEqual(0), upRaw, centerState);
    const down = select(downRaw.y.greaterThanEqual(0), downRaw, centerState);
    const crossHeight = left.x.add(right.x).add(up.x).add(down.x).mul(0.25);
    const crossCompaction = left.y.add(right.y).add(up.y).add(down.y).mul(0.25);
    const displayHeight = mix(centerState.x, crossHeight, surfaceSmoothingU.mul(0.08));
    const displayCompaction = mix(centerState.y, crossCompaction, surfaceSmoothingU.mul(0.18));
    const slopeX = right.x.sub(left.x).div(gradientRadius.mul(cellSizeX * 2));
    const slopeZ = down.x.sub(up.x).div(gradientRadius.mul(cellSizeZ * 2));
    displayState.element(instanceIndex).assign(select(
      centerState.y.greaterThanEqual(0),
      vec4(displayHeight, displayCompaction.max(0), slopeX, slopeZ),
      vec4(0, -1, 0, 0)
    ));
  })().compute(DISPLAY_CELL_COUNT, [256]);

  const warmupGroup = [...settleGroup, resetCompute, displayReconstructCompute];

  const renderedState = vertexStage(
    Fn(() => displayStateRead.element(vertexIndex))()
  );
  const renderedHeight = renderedState.x.mul(heightScaleU);
  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.96,
    metalness: 0
  });
  material.positionNode = positionLocal.add(vec3(0, renderedHeight, 0));
  const broad = sin(positionWorld.x.mul(0.31).add(positionWorld.z.mul(0.23))).mul(0.5).add(0.5);
  const grainPhaseA = positionWorld.x.mul(37.2).add(positionWorld.z.mul(51.7));
  const grainPhaseB = positionWorld.x.mul(73.1).sub(positionWorld.z.mul(31.4));
  const grain = sin(grainPhaseA).mul(0.62).add(sin(grainPhaseB).mul(0.38));
  const compacted = saturate(renderedState.y);
  material.colorNode = mix(
    color(0xe8d7b3),
    color(0xc3a474),
    saturate(compacted.mul(compactionTintU).add(broad.mul(0.045)))
  ).mul(grain.mul(0.012).add(0.994));
  // Coarse relief derivatives are reconstructed on the GPU and interpolated
  // between dense display vertices. The old screen-space derivative saw a
  // constant gradient per triangle, which is what exposed the pixelated shard
  // pattern. Only tiny analytic grain slopes are added here in the fragment.
  const reliefSlopeX = renderedState.z.mul(heightScaleU).mul(normalStrengthU);
  const reliefSlopeZ = renderedState.w.mul(heightScaleU).mul(normalStrengthU);
  const microSlopeX = cos(grainPhaseA).mul(37.2 * 0.62)
    .add(cos(grainPhaseB).mul(73.1 * 0.38))
    .mul(microReliefU);
  const microSlopeZ = cos(grainPhaseA).mul(51.7 * 0.62)
    .sub(cos(grainPhaseB).mul(31.4 * 0.38))
    .mul(microReliefU);
  const smoothLocalNormal = normalize(vec3(
    normalLocal.x.sub(reliefSlopeX).sub(microSlopeX),
    normalLocal.y,
    normalLocal.z.sub(reliefSlopeZ).sub(microSlopeZ)
  ));
  material.normalNode = transformNormalToView(smoothLocalNormal);
  material.envMapIntensity = 0.18;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "dry_landscape_gpu_granular_sand";
  mesh.position.set(center.x, 0, center.z);
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  const stats: SandSimulationStats = {
    grid: `${GRID_WIDTH}×${GRID_HEIGHT}`,
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    displayGrid: `${DISPLAY_WIDTH}×${DISPLAY_HEIGHT}`,
    displayVertices: DISPLAY_CELL_COUNT,
    activeCells,
    queuedStamps: 0,
    dispatches: 0,
    totalDispatches: 0,
    dirtySeconds: 0,
    settling: false,
    revision: 0
  };
  mesh.userData.sandSimulation = stats;

  const queuedStamps: QueuedStamp[] = [];
  let accumulator = 0;
  let dirtySeconds = 0;
  let disposed = false;
  let warmed = false;
  let displayDirty = true;
  let appliedSurfaceSmoothing = Number.NaN;

  const countDispatches = (count: number) => {
    stats.dispatches += count;
    stats.totalDispatches += count;
    stats.revision++;
  };

  const syncTuning = () => {
    const tuning = SAND_TUNING.values;
    reposeThresholdU.value = Math.tan(THREE.MathUtils.degToRad(tuning.reposeDeg)) * meanCellSize;
    avalancheRateU.value = tuning.avalancheRate;
    maxTransferU.value = tuning.maxTransfer;
    memoryRetentionU.value = Math.exp(-Math.max(0, tuning.memoryFade) * FIXED_STEP * 0.5);
    rakeDepthU.value = tuning.rakeDepth;
    tineRadiusU.value = tuning.tineRadius;
    tineSpacingU.value = tuning.tineSpacing;
    shoulderLiftU.value = tuning.shoulderLift;
    compactionU.value = tuning.compaction;
    surfaceSmoothingU.value = tuning.surfaceSmoothing;
    if (appliedSurfaceSmoothing !== tuning.surfaceSmoothing) {
      appliedSurfaceSmoothing = tuning.surfaceSmoothing;
      displayDirty = true;
    }
    heightScaleU.value = tuning.heightScale;
    normalStrengthU.value = tuning.normalStrength;
    microReliefU.value = tuning.microRelief;
    compactionTintU.value = tuning.compactionTint;
  };

  const reset = () => {
    if (disposed) return;
    queuedStamps.length = 0;
    accumulator = 0;
    dirtySeconds = 0;
    stats.dispatches = 0;
    syncTuning();

    if (!warmed) {
      // Compile every WebGPU settle pipeline before the player's first rake.
      // The reset dispatch runs last, so warm-up writes never reach the surface.
      renderer.compute(warmupGroup);
      countDispatches(warmupGroup.length);
      warmed = true;
    } else {
      renderer.compute([resetCompute, displayReconstructCompute]);
      countDispatches(2);
    }
    displayDirty = false;

    stats.queuedStamps = 0;
    stats.dirtySeconds = 0;
    stats.settling = false;
  };

  const queueStamp = (stamp: SandRakeStamp) => {
    if (disposed) return;
    const pull = normalised(
      stamp.pull,
      stamp.current.x - stamp.previous.x,
      stamp.current.z - stamp.previous.z
    );
    const acrossFallback = { x: -pull.z, z: pull.x };
    let across = normalised(stamp.across, acrossFallback.x, acrossFallback.z);
    // Keep the head perpendicular to the pull even if animation transforms are
    // slightly skewed; preserve the caller's side/sign for visual continuity.
    const handedness = across.x * acrossFallback.x + across.z * acrossFallback.z < 0 ? -1 : 1;
    across = { x: acrossFallback.x * handedness, z: acrossFallback.z * handedness };
    const queued: QueuedStamp = {
      previousX: stamp.previous.x - center.x,
      previousZ: stamp.previous.z - center.z,
      currentX: stamp.current.x - center.x,
      currentZ: stamp.current.z - center.z,
      acrossX: across.x,
      acrossZ: across.z,
      pullX: pull.x,
      pullZ: pull.z,
      strength: THREE.MathUtils.clamp(stamp.strength ?? 1, 0, 2)
    };
    if (queuedStamps.length >= MAX_QUEUED_STAMPS) queuedStamps.shift();
    queuedStamps.push(queued);
    stats.queuedStamps = queuedStamps.length;
  };

  const update = (dt: number) => {
    if (disposed) return;
    stats.dispatches = 0;
    syncTuning();

    const stampCount = Math.min(queuedStamps.length, MAX_STAMPS_PER_FRAME);
    for (let i = 0; i < stampCount; i++) {
      const stamp = queuedStamps.shift()!;
      previousU.value.set(stamp.previousX, stamp.previousZ);
      currentU.value.set(stamp.currentX, stamp.currentZ);
      acrossU.value.set(stamp.acrossX, stamp.acrossZ);
      pullU.value.set(stamp.pullX, stamp.pullZ);
      stampStrengthU.value = stamp.strength;
      renderer.compute(stampCompute);
      countDispatches(1);
      displayDirty = true;
      dirtySeconds = Math.max(dirtySeconds, SAND_TUNING.values.settleTime);
    }
    stats.queuedStamps = queuedStamps.length;

    const iterations = Math.round(THREE.MathUtils.clamp(SAND_TUNING.values.settleIterations, 0, 3));
    if (dirtySeconds > 0 && iterations > 0) {
      accumulator = Math.min(accumulator + Math.min(Math.max(dt, 0), 0.1), FIXED_STEP * MAX_SETTLE_TICKS_PER_FRAME);
      let ticks = 0;
      while (accumulator >= FIXED_STEP && ticks < MAX_SETTLE_TICKS_PER_FRAME) {
        for (let iteration = 0; iteration < iterations; iteration++) {
          renderer.compute(settleGroup);
          countDispatches(settleGroup.length);
          displayDirty = true;
        }
        accumulator -= FIXED_STEP;
        dirtySeconds = Math.max(0, dirtySeconds - FIXED_STEP);
        ticks++;
      }
    } else if (iterations === 0) {
      accumulator = 0;
      dirtySeconds = 0;
    }

    if (displayDirty) {
      renderer.compute(displayReconstructCompute);
      countDispatches(1);
      displayDirty = false;
    }

    stats.dirtySeconds = dirtySeconds;
    stats.settling = dirtySeconds > 0 || queuedStamps.length > 0;
  };

  const addTuning = (folder: FolderApi): SandTuningMonitor[] => {
    const granular = folder.addFolder({ title: "granular settling", expanded: true });
    SAND_TUNING.bind(granular, {
      keys: ["reposeDeg", "avalancheRate", "maxTransfer", "settleIterations", "settleTime", "memoryFade"],
      onChange: () => {
        syncTuning();
        dirtySeconds = Math.max(dirtySeconds, SAND_TUNING.values.settleTime);
      }
    });
    const rake = folder.addFolder({ title: "seven-tine rake", expanded: true });
    SAND_TUNING.bind(rake, {
      keys: ["rakeDepth", "tineRadius", "tineSpacing", "shoulderLift", "compaction"],
      onChange: () => syncTuning()
    });
    const appearance = folder.addFolder({ title: "sand appearance" });
    SAND_TUNING.bind(appearance, {
      keys: ["surfaceSmoothing", "heightScale", "normalStrength", "microRelief", "compactionTint"],
      onChange: () => syncTuning()
    });
    folder.addButton({ title: "reset authored rake pattern", label: "sand" }).on("click", reset);
    return [
      folder.addBinding(stats, "grid", { readonly: true, label: "grid" }),
      folder.addBinding(stats, "displayGrid", { readonly: true, label: "display grid" }),
      folder.addBinding(stats, "activeCells", { readonly: true, label: "active cells" }),
      folder.addBinding(stats, "queuedStamps", { readonly: true, label: "queued stamps" }),
      folder.addBinding(stats, "dispatches", { readonly: true, label: "dispatches/frame" }),
      folder.addBinding(stats, "dirtySeconds", {
        readonly: true,
        label: "settling (s)",
        format: (value: number) => value.toFixed(2)
      })
    ];
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    queuedStamps.length = 0;
    mesh.removeFromParent();
    resetCompute.dispose();
    stampCompute.dispose();
    fluxACompute.dispose();
    integrateABCompute.dispose();
    fluxBCompute.dispose();
    integrateBACompute.dispose();
    displayReconstructCompute.dispose();
    geometry.dispose();
    material.dispose();
    disposeStorageBuffer(initial);
    disposeStorageBuffer(stateA);
    disposeStorageBuffer(stateB);
    disposeStorageBuffer(flux);
    disposeStorageBuffer(displayState);
  };

  syncTuning();
  reset();

  return {
    mesh,
    queueStamp,
    update,
    reset,
    addTuning,
    syncTuning,
    stats,
    dispose
  };
}
