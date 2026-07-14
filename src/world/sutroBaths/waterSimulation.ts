import * as THREE from "three/webgpu";
import {
  Fn,
  cameraViewMatrix,
  clamp,
  cos,
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
import { releaseRendererAttribute } from "../../app/rendererRegistry";
import {
  SUTRO_BATHS,
  SUTRO_POOLS,
  distanceToSutroWater,
  poolAtLocal,
  sutroLocalToWorld,
  sutroWorldToLocal
} from "./layout";
import { SUTRO_BATHS_TUNING } from "./tuning";

/**
 * One masked shallow-water field shared by all seven Sutro pools.
 *
 * Each grid cell is a naturally aligned vec4: (height, vx, vz, energy). An
 * analysis pass writes gradient/divergence/laplacian data, then an integration
 * pass advances a ping-pong state buffer. The field remains entirely GPU-local;
 * the CPU only supplies a bounded player wake and never reads simulation data
 * back. Fine capillary ripples live in the material and remain animated even
 * while the close-range solver is asleep.
 */

const GRID_WIDTH = 88;
const GRID_HEIGHT = 184;
const CELL_COUNT = GRID_WIDTH * GRID_HEIGHT;
const FIXED_STEP = 1 / 60;
const MAX_TICKS_PER_FRAME = 2;
const WORKGROUP_SIZE = 256;
const MAX_SIM_HEIGHT = 0.14;
const MAX_SIM_SPEED = 1.35;
const POOL_EDGE_INSET = 0.1;
const HYSTERESIS_METRES = 12;
const PLAYER_WAKE_REACH = 3.6;

const FIELD_BOUNDS = (() => {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const pool of SUTRO_POOLS) {
    minX = Math.min(minX, pool.minX);
    maxX = Math.max(maxX, pool.maxX);
    minZ = Math.min(minZ, pool.minZ);
    maxZ = Math.max(maxZ, pool.maxZ);
  }
  return { minX: minX - 0.8, maxX: maxX + 0.8, minZ: minZ - 0.8, maxZ: maxZ + 0.8 };
})();

const CELL_SIZE_X = (FIELD_BOUNDS.maxX - FIELD_BOUNDS.minX) / (GRID_WIDTH - 1);
const CELL_SIZE_Z = (FIELD_BOUNDS.maxZ - FIELD_BOUNDS.minZ) / (GRID_HEIGHT - 1);

export type SutroBathsWaterPlayer = {
  x: number;
  y?: number;
  z: number;
};

export type SutroBathsWaterStats = {
  backend: string;
  grid: string;
  gridWidth: number;
  gridHeight: number;
  activeCells: number;
  triangles: number;
  dispatches: number;
  totalDispatches: number;
  ticks: number;
  totalTicks: number;
  substeps: number;
  running: boolean;
  playerDistance: number;
  revision: number;
};

export type SutroBathsWaterDebugState = {
  webgpu: true;
  disposed: boolean;
  enabled: boolean;
  proximityActive: boolean;
  enterRadius: number;
  exitRadius: number;
  simulationBlend: number;
  accumulator: number;
  pendingReset: boolean;
  stats: SutroBathsWaterStats;
};

export type SutroBathsWaterSimulation = {
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  update(dt: number, time: number, player: SutroBathsWaterPlayer): void;
  warmup(): Promise<void>;
  setEnabled(enabled: boolean): void;
  syncTuning(): void;
  reset(): void;
  readonly stats: SutroBathsWaterStats;
  debugState(): SutroBathsWaterDebugState;
  dispose(): void;
};

export type SutroBathsWaterSimulationOptions = {
  renderer: THREE.WebGPURenderer;
};

type WaterStorageAttribute = THREE.StorageInstancedBufferAttribute | THREE.StorageBufferAttribute;

function disposeStorageBuffer(node: { value: WaterStorageAttribute }): void {
  releaseRendererAttribute(node.value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function nearestPoolPoint(localX: number, localZ: number): {
  x: number;
  z: number;
  distance: number;
} {
  let bestX = 0;
  let bestZ = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const pool of SUTRO_POOLS) {
    const inset = 0.55;
    const x = THREE.MathUtils.clamp(localX, pool.minX + inset, pool.maxX - inset);
    const z = THREE.MathUtils.clamp(localZ, pool.minZ + inset, pool.maxZ - inset);
    const distance = Math.hypot(localX - x, localZ - z);
    if (distance >= bestDistance) continue;
    bestX = x;
    bestZ = z;
    bestDistance = distance;
  }
  return { x: bestX, z: bestZ, distance: bestDistance };
}

export function createSutroBathsWaterSimulation(
  options: SutroBathsWaterSimulationOptions
): SutroBathsWaterSimulation {
  const { renderer } = options;
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  if (backend.isWebGPUBackend !== true) {
    throw new Error("Sutro Baths water simulation requires the WebGPU backend");
  }

  const positions = new Float32Array(CELL_COUNT * 3);
  const metadataData = new Float32Array(CELL_COUNT * 4);
  const poolIndices = new Int16Array(CELL_COUNT);
  poolIndices.fill(-1);
  let activeCells = 0;

  for (let gz = 0; gz < GRID_HEIGHT; gz++) {
    const localZ = FIELD_BOUNDS.minZ + gz * CELL_SIZE_Z;
    for (let gx = 0; gx < GRID_WIDTH; gx++) {
      const index = gz * GRID_WIDTH + gx;
      const localX = FIELD_BOUNDS.minX + gx * CELL_SIZE_X;
      const world = sutroLocalToWorld(localX, localZ);
      positions[index * 3] = world.x - SUTRO_BATHS.centerX;
      positions[index * 3 + 1] = SUTRO_BATHS.waterY;
      positions[index * 3 + 2] = world.z - SUTRO_BATHS.centerZ;

      const pool = poolAtLocal(localX, localZ, POOL_EDGE_INSET);
      if (!pool) continue;
      const poolIndex = SUTRO_POOLS.findIndex((candidate) => candidate.id === pool.id);
      if (poolIndex < 0) continue;

      const edgeDistance = Math.max(
        0,
        Math.min(
          localX - pool.minX,
          pool.maxX - localX,
          localZ - pool.minZ,
          pool.maxZ - localZ
        )
      );
      const offset = index * 4;
      metadataData[offset] = 1;
      metadataData[offset + 1] = pool.heat;
      metadataData[offset + 2] = poolIndex / Math.max(SUTRO_POOLS.length - 1, 1);
      metadataData[offset + 3] = 1 - smoothstep01(edgeDistance / 2.4);
      poolIndices[index] = poolIndex;
      activeCells++;
    }
  }

  const indices: number[] = [];
  for (let gz = 0; gz < GRID_HEIGHT - 1; gz++) {
    for (let gx = 0; gx < GRID_WIDTH - 1; gx++) {
      const a = gz * GRID_WIDTH + gx;
      const b = a + 1;
      const c = a + GRID_WIDTH;
      const d = c + 1;
      const poolA = poolIndices[a];
      if (poolA >= 0 && poolIndices[b] === poolA && poolIndices[c] === poolA) indices.push(a, c, b);
      if (poolIndices[b] >= 0 && poolIndices[c] === poolIndices[b] && poolIndices[d] === poolIndices[b]) {
        indices.push(b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += MAX_SIM_HEIGHT;

  // vec4 storage keeps every cell naturally aligned for native WGSL IO.
  const metadata = instancedArray(metadataData, "vec4").toReadOnly();
  const stateA = instancedArray(new Float32Array(CELL_COUNT * 4), "vec4");
  const stateB = instancedArray(new Float32Array(CELL_COUNT * 4), "vec4");
  const derivatives = instancedArray(new Float32Array(CELL_COUNT * 4), "vec4");
  const metadataRead = storage(metadata.value, "vec4", CELL_COUNT).toReadOnly();
  const stateARead = storage(stateA.value, "vec4", CELL_COUNT).toReadOnly();
  const stateBRead = storage(stateB.value, "vec4", CELL_COUNT).toReadOnly();
  const derivativesRead = storage(derivatives.value, "vec4", CELL_COUNT).toReadOnly();

  const stepDtU = uniform(FIXED_STEP / 4);
  const timeU = uniform(0);
  const pressureU = uniform(2.3);
  const viscosityU = uniform(2.75);
  const dampingU = uniform(1.35);
  const reliefU = uniform(0.72);
  const normalU = uniform(1.05);
  const rippleU = uniform(0.018);
  const opacityU = uniform(0.9);
  const simulationBlendU = uniform(0);
  // xy = nearest wet point in site-local space; zw = local player velocity.
  const playerWakeU = uniform(new THREE.Vector4());
  const playerInfluenceU = uniform(0);

  const resetCompute = Fn(() => {
    stateA.element(instanceIndex).assign(vec4(0));
    stateB.element(instanceIndex).assign(vec4(0));
    derivatives.element(instanceIndex).assign(vec4(0));
  })().compute(CELL_COUNT, [WORKGROUP_SIZE]);

  const buildAnalyze = (source: typeof stateARead) =>
    Fn(() => {
      const gx = instanceIndex.mod(uint(GRID_WIDTH));
      const gz = instanceIndex.div(uint(GRID_WIDTH));
      const leftIndex = select(gx.greaterThan(0), instanceIndex.sub(uint(1)), instanceIndex);
      const rightIndex = select(gx.lessThan(uint(GRID_WIDTH - 1)), instanceIndex.add(uint(1)), instanceIndex);
      const upIndex = select(gz.greaterThan(0), instanceIndex.sub(uint(GRID_WIDTH)), instanceIndex);
      const downIndex = select(gz.lessThan(uint(GRID_HEIGHT - 1)), instanceIndex.add(uint(GRID_WIDTH)), instanceIndex);
      const current = source.element(instanceIndex);
      const meta = metadataRead.element(instanceIndex);
      const left = select(metadataRead.element(leftIndex).x.greaterThan(0.5), source.element(leftIndex), current);
      const right = select(metadataRead.element(rightIndex).x.greaterThan(0.5), source.element(rightIndex), current);
      const up = select(metadataRead.element(upIndex).x.greaterThan(0.5), source.element(upIndex), current);
      const down = select(metadataRead.element(downIndex).x.greaterThan(0.5), source.element(downIndex), current);
      const gradientX = right.x.sub(left.x).div(CELL_SIZE_X * 2);
      const gradientZ = down.x.sub(up.x).div(CELL_SIZE_Z * 2);
      const divergence = right.y.sub(left.y).div(CELL_SIZE_X * 2)
        .add(down.z.sub(up.z).div(CELL_SIZE_Z * 2));
      const laplacian = right.x.add(left.x).sub(current.x.mul(2)).div(CELL_SIZE_X * CELL_SIZE_X)
        .add(down.x.add(up.x).sub(current.x.mul(2)).div(CELL_SIZE_Z * CELL_SIZE_Z));
      derivatives.element(instanceIndex).assign(
        select(meta.x.greaterThan(0.5), vec4(gradientX, gradientZ, divergence, laplacian), vec4(0))
      );
    })().compute(CELL_COUNT, [WORKGROUP_SIZE]);

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
      const derived = derivativesRead.element(instanceIndex);
      const left = select(metadataRead.element(leftIndex).x.greaterThan(0.5), source.element(leftIndex), current);
      const right = select(metadataRead.element(rightIndex).x.greaterThan(0.5), source.element(rightIndex), current);
      const up = select(metadataRead.element(upIndex).x.greaterThan(0.5), source.element(upIndex), current);
      const down = select(metadataRead.element(downIndex).x.greaterThan(0.5), source.element(downIndex), current);
      const neighborVelocity = left.yz.add(right.yz).add(up.yz).add(down.yz).mul(0.25);
      const neighborHeight = left.x.add(right.x).add(up.x).add(down.x).mul(0.25);

      const velocity = current.yz.toVar();
      velocity.addAssign(derived.xy.mul(pressureU).mul(stepDtU).negate());
      velocity.addAssign(neighborVelocity.sub(velocity).mul(viscosityU).mul(stepDtU));

      const localX = float(gx).mul(CELL_SIZE_X).add(FIELD_BOUNDS.minX);
      const localZ = float(gz).mul(CELL_SIZE_Z).add(FIELD_BOUNDS.minZ);
      const wakeOffset = vec2(localX, localZ).sub(playerWakeU.xy);
      const wakeDistance = wakeOffset.length();
      const wake = float(1).sub(smoothstep(0.18, PLAYER_WAKE_REACH, wakeDistance))
        .mul(playerInfluenceU);
      const radial = wakeOffset.div(wakeDistance.max(0.16));
      const playerSpeed = playerWakeU.zw.length();
      velocity.addAssign(playerWakeU.zw.mul(wake).mul(stepDtU).mul(0.82));
      velocity.addAssign(radial.mul(wake).mul(playerSpeed.mul(0.11).add(0.06)).mul(stepDtU));

      velocity.mulAssign(exp(dampingU.mul(stepDtU).negate()));
      velocity.mulAssign(exp(meta.w.mul(stepDtU).mul(-2.8)));
      const speed = velocity.length();
      velocity.mulAssign(select(speed.greaterThan(MAX_SIM_SPEED), float(MAX_SIM_SPEED).div(speed.max(1e-5)), float(1)));

      const wakePulse = sin(timeU.mul(5.1).sub(wakeDistance.mul(3.2)))
        .mul(wake)
        .mul(playerSpeed.mul(0.006).add(0.003));
      const thermalPulse = sin(timeU.mul(0.78).add(localX.mul(0.19)).sub(localZ.mul(0.11)))
        .mul(meta.y)
        .mul(0.0011);
      const height = current.x.toVar();
      height.addAssign(neighborHeight.sub(current.x).mul(viscosityU).mul(stepDtU).mul(0.045));
      height.addAssign(derived.w.mul(pressureU).mul(stepDtU).mul(0.016));
      height.subAssign(derived.z.mul(stepDtU).mul(0.19));
      height.addAssign(wakePulse.mul(stepDtU));
      height.addAssign(thermalPulse.mul(stepDtU));
      height.mulAssign(exp(dampingU.mul(stepDtU).mul(-0.34)));

      const energy = current.w.mul(exp(stepDtU.mul(-1.35)))
        .add(derived.z.abs().mul(stepDtU).mul(0.52))
        .add(wake.mul(playerSpeed.mul(0.08).add(0.03)).mul(stepDtU));
      const next = vec4(
        clamp(height, -MAX_SIM_HEIGHT, MAX_SIM_HEIGHT),
        velocity.x,
        velocity.y,
        clamp(energy, 0, 1)
      );
      destination.element(instanceIndex).assign(select(meta.x.greaterThan(0.5), next, vec4(0)));
    })().compute(CELL_COUNT, [WORKGROUP_SIZE]);

  const analyzeACompute = buildAnalyze(stateARead);
  const integrateABCompute = buildIntegrate(stateARead, stateB);
  const analyzeBCompute = buildAnalyze(stateBRead);
  const integrateBACompute = buildIntegrate(stateBRead, stateA);
  const solverGroup = [analyzeACompute, integrateABCompute, analyzeBCompute, integrateBACompute];

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
      return center.mul(0.52).add(left.add(right).add(up).add(down).mul(0.12));
    })()
  );
  const renderedMeta = vertexStage(Fn(() => metadataRead.element(vertexIndex))());
  const renderedDerivatives = vertexStage(Fn(() => derivativesRead.element(vertexIndex))());

  const analyticalWave = sin(positionWorld.x.mul(0.46).add(positionWorld.z.mul(0.13)).add(timeU.mul(0.72)))
    .mul(0.58)
    .add(sin(positionWorld.z.mul(0.69).sub(positionWorld.x.mul(0.08)).sub(timeU.mul(0.49))).mul(0.42))
    .mul(rippleU);
  const dynamicHeight = renderedState.x.mul(reliefU).mul(simulationBlendU);
  const crest = sin(positionWorld.x.mul(0.29).sub(positionWorld.z.mul(0.21)).add(timeU.mul(0.36)))
    .mul(0.5)
    .add(0.5);
  const fieldLight = saturate(
    renderedState.w.mul(simulationBlendU).mul(0.58)
      .add(dynamicHeight.mul(1.6))
      .add(crest.mul(0.18))
      .add(0.27)
  );

  const deepColorU = uniform(new THREE.Color(0x123e46));
  const coldColorU = uniform(new THREE.Color(0x4f9897));
  const warmColorU = uniform(new THREE.Color(0x73aaa0));
  const highlightColorU = uniform(new THREE.Color(0xc7ded1));
  const temperatureColor = mix(coldColorU, warmColorU, renderedMeta.y);
  const baseColor = mix(deepColorU, temperatureColor, fieldLight);
  const waterColor = mix(baseColor, highlightColorU, smoothstep(0.81, 0.99, crest).mul(0.12));

  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.34,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide
  });
  material.positionNode = positionLocal.add(vec3(0, analyticalWave.add(dynamicHeight), 0));
  material.colorNode = waterColor;
  material.opacityNode = opacityU.mul(mix(float(0.9), float(1), fieldLight));
  const analyticalNormalX = cos(positionWorld.x.mul(0.46).add(positionWorld.z.mul(0.13)).add(timeU.mul(0.72)))
    .mul(rippleU)
    .mul(0.27);
  const analyticalNormalZ = cos(positionWorld.z.mul(0.69).sub(positionWorld.x.mul(0.08)).sub(timeU.mul(0.49)))
    .mul(rippleU)
    .mul(0.29);
  const worldNormal = normalize(vec3(
    analyticalNormalX.sub(renderedDerivatives.x.mul(reliefU).mul(normalU).mul(simulationBlendU)),
    1,
    analyticalNormalZ.sub(renderedDerivatives.y.mul(reliefU).mul(normalU).mul(simulationBlendU))
  ));
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz);
  material.envMapIntensity = 0.42;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "sutro_baths_seven_pool_webgpu_water";
  mesh.position.set(SUTRO_BATHS.centerX, 0, SUTRO_BATHS.centerZ);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = 7;
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = "sutro_baths_shared_water_field";
  group.add(mesh);

  const stats: SutroBathsWaterStats = {
    backend: "WebGPU storage buffers",
    grid: `${GRID_WIDTH}×${GRID_HEIGHT}`,
    gridWidth: GRID_WIDTH,
    gridHeight: GRID_HEIGHT,
    activeCells,
    triangles: indices.length / 3,
    dispatches: 0,
    totalDispatches: 0,
    ticks: 0,
    totalTicks: 0,
    substeps: 2,
    running: false,
    playerDistance: Number.POSITIVE_INFINITY,
    revision: 0
  };
  group.userData.waterSimulation = stats;
  mesh.userData.waterSimulation = stats;

  let disposed = false;
  let apiEnabled = true;
  let proximityActive = false;
  let simulationBlend = 0;
  let accumulator = 0;
  let pendingReset = true;
  let previousPlayerLocal: { x: number; z: number } | null = null;

  const countDispatches = (count: number) => {
    stats.dispatches += count;
    stats.totalDispatches += count;
    stats.revision++;
  };

  const syncTuning = () => {
    const tuning = SUTRO_BATHS_TUNING.values;
    const substeps = Math.round(THREE.MathUtils.clamp(tuning.waterSubsteps, 1, 4));
    stepDtU.value = FIXED_STEP / (substeps * 2);
    pressureU.value = tuning.waterPressure;
    viscosityU.value = tuning.waterViscosity;
    dampingU.value = tuning.waterDamping;
    reliefU.value = tuning.waterRelief;
    normalU.value = tuning.waterNormal * 0.035;
    rippleU.value = tuning.waterRipple;
    opacityU.value = tuning.waterOpacity;
    stats.substeps = substeps;
  };

  const performReset = () => {
    renderer.compute(resetCompute);
    countDispatches(1);
    pendingReset = false;
  };

  const reset = () => {
    if (disposed) return;
    accumulator = 0;
    pendingReset = true;
  };

  const warmup = async () => {
    if (disposed) return;
    // Build every compute pipeline while the field is detached, then leave the
    // storage in its clean initial state. This is one initialization sequence,
    // not a simulation tick; normal proximity gating still owns all updates.
    await renderer.computeAsync(resetCompute);
    await renderer.computeAsync(solverGroup);
    await renderer.computeAsync(resetCompute);
    pendingReset = false;
  };

  const setEnabled = (enabled: boolean) => {
    apiEnabled = enabled;
    if (!enabled) {
      proximityActive = false;
      accumulator = 0;
      stats.running = false;
    }
  };

  const update = (dt: number, time: number, player: SutroBathsWaterPlayer) => {
    if (disposed) return;
    const frameDt = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1);
    stats.dispatches = 0;
    stats.ticks = 0;
    stats.playerDistance = distanceToSutroWater(player.x, player.z);
    timeU.value = Number.isFinite(time) ? time : 0;
    syncTuning();

    const tuningEnabled = SUTRO_BATHS_TUNING.values.waterEnabled;
    const enterRadius = Math.max(1, SUTRO_BATHS_TUNING.values.waterRadius);
    const exitRadius = enterRadius + HYSTERESIS_METRES;
    if (!apiEnabled || !tuningEnabled) {
      proximityActive = false;
    } else if (proximityActive) {
      proximityActive = stats.playerDistance <= exitRadius;
    } else {
      proximityActive = stats.playerDistance <= enterRadius;
    }

    const targetBlend = proximityActive ? 1 : 0;
    simulationBlend += (targetBlend - simulationBlend) * (1 - Math.exp(-frameDt * 3.8));
    if (Math.abs(simulationBlend - targetBlend) < 0.001) simulationBlend = targetBlend;
    simulationBlendU.value = simulationBlend;

    const playerLocal = sutroWorldToLocal(player.x, player.z);
    const wetPoint = nearestPoolPoint(playerLocal.x, playerLocal.z);
    let velocityX = 0;
    let velocityZ = 0;
    if (previousPlayerLocal && frameDt > 1e-4) {
      const dx = playerLocal.x - previousPlayerLocal.x;
      const dz = playerLocal.z - previousPlayerLocal.z;
      if (Math.hypot(dx, dz) < 8) {
        velocityX = THREE.MathUtils.clamp(dx / frameDt, -5, 5);
        velocityZ = THREE.MathUtils.clamp(dz / frameDt, -5, 5);
      }
    }
    previousPlayerLocal = playerLocal;
    playerWakeU.value.set(wetPoint.x, wetPoint.z, velocityX, velocityZ);
    playerInfluenceU.value = 1 - smoothstep01(wetPoint.distance / PLAYER_WAKE_REACH);

    if (!proximityActive || !apiEnabled || !tuningEnabled) {
      accumulator = 0;
      stats.running = false;
      return;
    }

    if (pendingReset) performReset();
    accumulator = Math.min(accumulator + frameDt, FIXED_STEP * MAX_TICKS_PER_FRAME);
    while (accumulator >= FIXED_STEP && stats.ticks < MAX_TICKS_PER_FRAME) {
      for (let substep = 0; substep < stats.substeps; substep++) {
        renderer.compute(solverGroup);
        countDispatches(solverGroup.length);
      }
      accumulator -= FIXED_STEP;
      stats.ticks++;
      stats.totalTicks++;
    }
    stats.running = true;
  };

  const debugState = (): SutroBathsWaterDebugState => {
    const enterRadius = Math.max(1, SUTRO_BATHS_TUNING.values.waterRadius);
    return {
      webgpu: true,
      disposed,
      enabled: apiEnabled && SUTRO_BATHS_TUNING.values.waterEnabled,
      proximityActive,
      enterRadius,
      exitRadius: enterRadius + HYSTERESIS_METRES,
      simulationBlend,
      accumulator,
      pendingReset,
      stats
    };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    group.removeFromParent();
    resetCompute.dispose();
    analyzeACompute.dispose();
    integrateABCompute.dispose();
    analyzeBCompute.dispose();
    integrateBACompute.dispose();
    geometry.dispose();
    material.dispose();
    disposeStorageBuffer(metadata);
    disposeStorageBuffer(stateA);
    disposeStorageBuffer(stateB);
    disposeStorageBuffer(derivatives);
  };

  syncTuning();

  return {
    group,
    mesh,
    update,
    warmup,
    setEnabled,
    syncTuning,
    reset,
    stats,
    debugState,
    dispose
  };
}
