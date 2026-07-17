import * as THREE from "three/webgpu";
import {
  Fn,
  cameraViewMatrix,
  clamp,
  cos,
  exp,
  float,
  instanceIndex,
  instancedArray,
  mix,
  normalize,
  positionLocal,
  select,
  sin,
  storage,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
  vertexIndex,
  vertexStage
} from "three/tsl";
import { releaseRendererAttribute } from "../../app/rendererRegistry";
import { GHOST_SHIP_TUNING } from "./tuning";

const GRID_X = 32;
const GRID_Z = 24;
const CELL_COUNT = GRID_X * GRID_Z;
const WIDTH = 6.6;
const LENGTH = 4.25;
const CELL_X = WIDTH / (GRID_X - 1);
const CELL_Z = LENGTH / (GRID_Z - 1);
const FIXED_STEP = 1 / 60;
const MAX_TICKS = 2;
const WORKGROUP_SIZE = 256;
const MAX_HEIGHT = 0.16;

type StorageAttribute = THREE.StorageInstancedBufferAttribute | THREE.StorageBufferAttribute;

export type GhostShipHotTubWater = {
  group: THREE.Group;
  warmup(): Promise<void>;
  update(dt: number, time: number, active: boolean): void;
  reset(): void;
  readonly stats: {
    backend: string;
    grid: string;
    running: boolean;
    dispatches: number;
    totalDispatches: number;
    ticks: number;
  };
  dispose(): void;
};

/** Small GPU-local damped-wave field for the ship's moving hot tub. */
export function createGhostShipHotTubWater(renderer: THREE.WebGPURenderer): GhostShipHotTubWater {
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  if (backend.isWebGPUBackend !== true) {
    throw new Error("Ghost ship hot-tub fluid simulation requires the WebGPU backend");
  }

  const stateA = instancedArray(new Float32Array(CELL_COUNT * 4), "vec4");
  const stateB = instancedArray(new Float32Array(CELL_COUNT * 4), "vec4");
  const stateARead = storage(stateA.value, "vec4", CELL_COUNT).toReadOnly();
  const stateBRead = storage(stateB.value, "vec4", CELL_COUNT).toReadOnly();
  const stepDtU = uniform(FIXED_STEP);
  const timeU = uniform(0);
  const waveSpeedU = uniform(GHOST_SHIP_TUNING.values.waterWaveSpeed);
  const dampingU = uniform(GHOST_SHIP_TUNING.values.waterDamping);

  const resetCompute = Fn(() => {
    stateA.element(instanceIndex).assign(vec4(0));
    stateB.element(instanceIndex).assign(vec4(0));
  })().compute(CELL_COUNT, [WORKGROUP_SIZE]);

  const buildStep = (source: typeof stateARead, destination: typeof stateA) =>
    Fn(() => {
      const gx = instanceIndex.mod(uint(GRID_X));
      const gz = instanceIndex.div(uint(GRID_X));
      const leftIndex = select(gx.greaterThan(0), instanceIndex.sub(uint(1)), instanceIndex);
      const rightIndex = select(gx.lessThan(uint(GRID_X - 1)), instanceIndex.add(uint(1)), instanceIndex);
      const upIndex = select(gz.greaterThan(0), instanceIndex.sub(uint(GRID_X)), instanceIndex);
      const downIndex = select(gz.lessThan(uint(GRID_Z - 1)), instanceIndex.add(uint(GRID_X)), instanceIndex);
      const current = source.element(instanceIndex);
      const left = source.element(leftIndex);
      const right = source.element(rightIndex);
      const up = source.element(upIndex);
      const down = source.element(downIndex);
      const laplacian = left.x.add(right.x).add(up.x).add(down.x).sub(current.x.mul(4));

      const cell = vec2(
        float(gx).div(GRID_X - 1).sub(0.5).mul(WIDTH),
        float(gz).div(GRID_Z - 1).sub(0.5).mul(LENGTH)
      );
      const sourcePoint = vec2(sin(timeU.mul(0.73)).mul(1.8), cos(timeU.mul(0.57)).mul(1.15));
      const sourceDistance2 = cell.sub(sourcePoint).dot(cell.sub(sourcePoint));
      const thermalPulse = exp(sourceDistance2.mul(-2.4))
        .mul(sin(timeU.mul(3.7)))
        .mul(0.7);

      const velocity = current.y
        .add(laplacian.mul(waveSpeedU).mul(stepDtU))
        .add(thermalPulse.mul(stepDtU))
        .mul(exp(dampingU.mul(stepDtU).negate()));
      const height = clamp(current.x.add(velocity.mul(stepDtU)), -MAX_HEIGHT, MAX_HEIGHT);
      const boundary = gx.greaterThan(0)
        .and(gx.lessThan(uint(GRID_X - 1)))
        .and(gz.greaterThan(0))
        .and(gz.lessThan(uint(GRID_Z - 1)));
      destination.element(instanceIndex).assign(select(boundary, vec4(height, velocity, 0, 0), vec4(0)));
    })().compute(CELL_COUNT, [WORKGROUP_SIZE]);

  const stepAB = buildStep(stateARead, stateB);
  const stepBA = buildStep(stateBRead, stateA);
  const solver = [stepAB, stepBA];

  const rendered = vertexStage(
    Fn(() => {
      const gx = vertexIndex.mod(uint(GRID_X));
      const gz = vertexIndex.div(uint(GRID_X));
      const leftIndex = select(gx.greaterThan(0), vertexIndex.sub(uint(1)), vertexIndex);
      const rightIndex = select(gx.lessThan(uint(GRID_X - 1)), vertexIndex.add(uint(1)), vertexIndex);
      const upIndex = select(gz.greaterThan(0), vertexIndex.sub(uint(GRID_X)), vertexIndex);
      const downIndex = select(gz.lessThan(uint(GRID_Z - 1)), vertexIndex.add(uint(GRID_X)), vertexIndex);
      return vec4(
        stateARead.element(vertexIndex).x,
        stateARead.element(leftIndex).x,
        stateARead.element(rightIndex).x,
        stateARead.element(upIndex).x.sub(stateARead.element(downIndex).x)
      );
    })()
  );

  const fineWave = sin(positionLocal.x.mul(2.2).add(timeU.mul(1.3)))
    .add(cos(positionLocal.z.mul(2.7).sub(timeU.mul(1.05))) )
    .mul(0.012);
  const dynamicHeight = rendered.x;
  const crest = clamp(dynamicHeight.mul(4).add(fineWave.mul(8)).add(0.5), 0, 1);
  const deepU = uniform(new THREE.Color(0x15436f));
  const glowU = uniform(new THREE.Color(0x63eaff));
  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.18,
    metalness: 0.04,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  material.positionNode = positionLocal.add(vec3(0, dynamicHeight.add(fineWave), 0));
  material.colorNode = mix(deepU, glowU, crest);
  material.opacityNode = float(0.9);
  const worldNormal = normalize(vec3(
    rendered.y.sub(rendered.z).div(CELL_X * 2),
    1,
    rendered.w.div(CELL_Z * 2)
  ));
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz);
  material.envMapIntensity = 0.8;

  const geometry = new THREE.PlaneGeometry(WIDTH, LENGTH, GRID_X - 1, GRID_Z - 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "ghost_ship_hot_tub_webgpu_water";
  mesh.renderOrder = 11;
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = "ghost_ship_hot_tub_fluid";
  group.add(mesh);

  const stats = {
    backend: "WebGPU storage buffers",
    grid: `${GRID_X}×${GRID_Z}`,
    running: false,
    dispatches: 0,
    totalDispatches: 0,
    ticks: 0
  };
  group.userData.waterSimulation = stats;

  let accumulator = 0;
  let pendingReset = true;
  let disposed = false;

  const countDispatch = (count: number) => {
    stats.dispatches += count;
    stats.totalDispatches += count;
  };

  const reset = () => {
    if (disposed) return;
    accumulator = 0;
    pendingReset = true;
    stats.running = false;
  };

  const performReset = () => {
    renderer.compute(resetCompute);
    countDispatch(1);
    pendingReset = false;
  };

  return {
    group,
    async warmup() {
      if (disposed) return;
      await renderer.computeAsync(resetCompute);
      await renderer.computeAsync(solver);
      await renderer.computeAsync(resetCompute);
      pendingReset = false;
    },
    update(dt, time, active) {
      if (disposed) return;
      stats.dispatches = 0;
      stats.ticks = 0;
      timeU.value = Number.isFinite(time) ? time : 0;
      waveSpeedU.value = GHOST_SHIP_TUNING.values.waterWaveSpeed;
      dampingU.value = GHOST_SHIP_TUNING.values.waterDamping;
      if (!active || !GHOST_SHIP_TUNING.values.waterEnabled) {
        accumulator = 0;
        stats.running = false;
        return;
      }
      if (pendingReset) performReset();
      accumulator = Math.min(accumulator + Math.max(0, Math.min(dt, 0.1)), FIXED_STEP * MAX_TICKS);
      while (accumulator >= FIXED_STEP && stats.ticks < MAX_TICKS) {
        renderer.compute(solver);
        countDispatch(solver.length);
        accumulator -= FIXED_STEP;
        stats.ticks++;
      }
      stats.running = stats.ticks > 0;
    },
    reset,
    stats,
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      resetCompute.dispose();
      stepAB.dispose();
      stepBA.dispose();
      geometry.dispose();
      material.dispose();
      releaseRendererAttribute(stateA.value as StorageAttribute);
      releaseRendererAttribute(stateB.value as StorageAttribute);
    }
  };
}
