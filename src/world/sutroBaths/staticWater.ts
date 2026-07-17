import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  exp,
  float,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  saturate,
  screenCoordinate,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec3,
  vec4,
  viewportSharedTexture
} from "three/tsl";
import { SUN_DIR } from "../sky";
import {
  beerLambertWater,
  causticWeb,
  ditheredCoverage,
  interleavedGradientNoise,
  safeRefractionUV,
  sunSparkle,
  tintTowardBed
} from "../waterShadingTSL";
import {
  SUTRO_BATHS,
  SUTRO_POOLS,
  distanceToSutroWater,
  sutroLocalToWorld
} from "./layout";
import { SUTRO_BATHS_TUNING } from "./tuning";

type N = any;

/**
 * Lightweight visual water for the seven pools.
 *
 * This deliberately has no storage buffers, compute pipelines, solvers,
 * impulses, or gameplay wakes. A modest CPU-authored mesh and an analytical
 * TSL material retain the clear teal water, caustics, sparkle and quiet surface
 * motion without turning the whole hall into a fluid-simulation workload.
 */

const TARGET_CELL_SIZE = 1.15;
const POOL_EDGE_INSET = 0.08;
const MAX_VISUAL_RELIEF = 0.04;

function smoothstep01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export type SutroBathsStaticWaterStats = {
  backend: "WebGPU analytical surface";
  simulated: false;
  computeDispatches: 0;
  pools: number;
  vertices: number;
  triangles: number;
  animated: true;
  playerDistance: number;
  revision: number;
};

export type SutroBathsStaticWaterDebugState = {
  webgpu: true;
  staticSurface: true;
  disposed: boolean;
  enabled: boolean;
  stats: SutroBathsStaticWaterStats;
};

export type SutroBathsStaticWater = {
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  update(dt: number, time: number, player: { x: number; z: number }): void;
  setEnabled(enabled: boolean): void;
  syncTuning(): void;
  readonly stats: SutroBathsStaticWaterStats;
  debugState(): SutroBathsStaticWaterDebugState;
  dispose(): void;
};

export function createSutroBathsStaticWater(options: {
  renderer: THREE.WebGPURenderer;
}): SutroBathsStaticWater {
  const backend = options.renderer.backend as unknown as { isWebGPUBackend?: boolean };
  if (backend.isWebGPUBackend !== true) {
    throw new Error("Sutro Baths static water requires the WebGPU backend");
  }

  const positions: number[] = [];
  const metadata: number[] = [];
  const indices: number[] = [];

  for (const [poolIndex, pool] of SUTRO_POOLS.entries()) {
    const width = pool.maxX - pool.minX - POOL_EDGE_INSET * 2;
    const depth = pool.maxZ - pool.minZ - POOL_EDGE_INSET * 2;
    const columns = Math.max(2, Math.ceil(width / TARGET_CELL_SIZE) + 1);
    const rows = Math.max(2, Math.ceil(depth / TARGET_CELL_SIZE) + 1);
    const firstVertex = positions.length / 3;

    for (let row = 0; row < rows; row++) {
      const z01 = row / (rows - 1);
      const localZ = pool.minZ + POOL_EDGE_INSET + z01 * depth;
      for (let column = 0; column < columns; column++) {
        const x01 = column / (columns - 1);
        const localX = pool.minX + POOL_EDGE_INSET + x01 * width;
        const world = sutroLocalToWorld(localX, localZ);
        positions.push(
          world.x - SUTRO_BATHS.centerX,
          SUTRO_BATHS.waterY,
          world.z - SUTRO_BATHS.centerZ
        );

        const edgeDistance = Math.min(
          localX - pool.minX,
          pool.maxX - localX,
          localZ - pool.minZ,
          pool.maxZ - localZ
        );
        metadata.push(
          pool.heat,
          1 - smoothstep01(edgeDistance / 2.4),
          poolIndex / Math.max(SUTRO_POOLS.length - 1, 1),
          1
        );
      }
    }

    for (let row = 0; row < rows - 1; row++) {
      for (let column = 0; column < columns - 1; column++) {
        const a = firstVertex + row * columns + column;
        const b = a + 1;
        const c = a + columns;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("waterMeta", new THREE.Float32BufferAttribute(metadata, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += MAX_VISUAL_RELIEF;

  const timeU = uniform(0);
  const rippleU = uniform(0.018);
  const clarityU = uniform(1.5);
  const refractionU = uniform(0.5);
  const bedTintU = uniform(0.5);
  const causticU = uniform(0.85);
  const sparkleU = uniform(0.85);
  const shoreFoamU = uniform(0.5);
  const poolDepthU = uniform(1.35);
  const sunDirU = uniform(new THREE.Vector3(-0.52, 0.42, -0.28));
  const waterMeta: N = attribute("waterMeta", "vec4");

  const waveA = positionWorld.x.mul(0.46).add(positionWorld.z.mul(0.13)).add(timeU.mul(0.72));
  const waveB = positionWorld.z.mul(0.69).sub(positionWorld.x.mul(0.08)).sub(timeU.mul(0.49));
  const analyticalWave = sin(waveA).mul(0.58).add(sin(waveB).mul(0.42)).mul(rippleU);
  const crest = sin(positionWorld.x.mul(0.29).sub(positionWorld.z.mul(0.21)).add(timeU.mul(0.36)))
    .mul(0.5)
    .add(0.5);

  const deepColorU = uniform(new THREE.Color(0x125257));
  const coldColorU = uniform(new THREE.Color(0x3fa398));
  const warmColorU = uniform(new THREE.Color(0x63b3a0));
  const highlightColorU = uniform(new THREE.Color(0xeef2df));
  const bedColorU = uniform(new THREE.Color(0xb3a37e));
  const temperatureColor = mix(coldColorU, warmColorU, waterMeta.x);
  const fieldLight = saturate(crest.mul(0.18).add(0.27));

  const analyticalNormalX = cos(waveA).mul(rippleU).mul(0.27);
  const analyticalNormalZ = cos(waveB).mul(rippleU).mul(0.29);
  const worldNormal = normalize(vec3(analyticalNormalX, 1, analyticalNormalZ));

  const viewVector = positionWorld.sub(cameraPosition);
  const viewDistance = viewVector.length();
  const viewToFragment = viewVector.div(viewDistance.max(1e-4));
  const slant = viewToFragment.y.abs().max(0.18);
  const bedDepth = mix(poolDepthU, float(0.14), smoothstep(0.2, 1.0, waterMeta.y)).max(0.05);
  const pathLength = bedDepth.div(slant);
  const distortion = worldNormal.xz
    .mul(refractionU)
    .mul(0.045)
    .div(viewDistance.mul(0.09).add(1))
    .mul(float(1).sub(waterMeta.y.mul(0.7)));
  const refractionUV = safeRefractionUV(screenUV.add(distortion));
  const sceneBehind = viewportSharedTexture(refractionUV).rgb;
  const bedScene = tintTowardBed(sceneBehind, bedColorU, bedTintU);
  const daylight = saturate(sunDirU.y.mul(4));
  const causticPattern = causticWeb(
    positionWorld.xz.mul(1.9).add(worldNormal.xz.mul(1.4)),
    timeU.mul(0.55)
  );
  const shallowFocus = exp(bedDepth.negate().mul(0.9));
  const litBed = bedScene.add(
    causticPattern.mul(causticU).mul(shallowFocus).mul(daylight).mul(bedScene.add(0.12))
  );
  const water = beerLambertWater({
    pathLength,
    deepColor: deepColorU,
    shallowColor: temperatureColor,
    clarityDepth: clarityU
  });
  const baseColor = mix(water.scatter, temperatureColor, fieldLight.mul(0.35));
  const surfaceColor = mix(baseColor, highlightColorU, smoothstep(0.81, 0.99, crest).mul(0.12));

  const dither = interleavedGradientNoise(screenCoordinate.xy);
  const edgeWobble = sin(positionWorld.x.mul(1.4).add(sin(positionWorld.z.mul(1.1)).mul(1.6)));
  const edgeRings = sin(waterMeta.y.mul(9.5).sub(timeU.mul(1.05)).add(edgeWobble.mul(0.7)));
  const edgeFoam = smoothstep(0.6, 0.94, edgeRings)
    .mul(smoothstep(0.25, 0.85, waterMeta.y))
    .mul(shoreFoamU);
  const foamMask = ditheredCoverage(saturate(edgeFoam), dither);
  const sparkle = sunSparkle({
    worldPosition: positionWorld,
    worldNormal,
    viewToFragment,
    sunDirection: sunDirU,
    time: timeU
  }).mul(sparkleU);
  const transmittance = water.transmittance.mul(float(1).sub(foamMask));

  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.34,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide
  });
  material.positionNode = positionLocal.add(vec3(0, analyticalWave, 0));
  material.colorNode = mix(
    surfaceColor.mul(vec3(1).sub(transmittance)),
    highlightColorU,
    foamMask
  );
  material.emissiveNode = litBed.mul(transmittance)
    .add(highlightColorU.mul(foamMask.mul(0.1)))
    .add(vec3(1.0, 0.97, 0.88).mul(sparkle));
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz);
  material.envMapIntensity = 0.42;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "sutro_baths_static_water_surface";
  mesh.position.set(SUTRO_BATHS.centerX, 0, SUTRO_BATHS.centerZ);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = 7;

  const group = new THREE.Group();
  group.name = "sutro_baths_static_water";
  group.add(mesh);

  const stats: SutroBathsStaticWaterStats = {
    backend: "WebGPU analytical surface",
    simulated: false,
    computeDispatches: 0,
    pools: SUTRO_POOLS.length,
    vertices: positions.length / 3,
    triangles: indices.length / 3,
    animated: true,
    playerDistance: Number.POSITIVE_INFINITY,
    revision: 0
  };
  group.userData.staticWater = stats;
  mesh.userData.staticWater = stats;

  let apiEnabled = true;
  let disposed = false;

  const syncTuning = () => {
    const tuning = SUTRO_BATHS_TUNING.values;
    rippleU.value = tuning.waterRipple;
    clarityU.value = tuning.waterClarity;
    refractionU.value = tuning.waterRefraction;
    bedTintU.value = tuning.waterBedTint;
    causticU.value = tuning.waterCaustics;
    sparkleU.value = tuning.waterSparkle;
    shoreFoamU.value = tuning.waterShoreFoam;
    poolDepthU.value = tuning.waterDepth;
    group.visible = apiEnabled && tuning.waterEnabled;
  };

  syncTuning();

  return {
    group,
    mesh,
    update(_dt, time, player) {
      if (disposed) return;
      timeU.value = Number.isFinite(time) ? time : 0;
      (sunDirU.value as THREE.Vector3).copy(SUN_DIR);
      stats.playerDistance = distanceToSutroWater(player.x, player.z);
      stats.revision++;
    },
    setEnabled(enabled) {
      apiEnabled = enabled;
      group.visible = enabled && SUTRO_BATHS_TUNING.values.waterEnabled;
    },
    syncTuning,
    stats,
    debugState() {
      return {
        webgpu: true,
        staticSurface: true,
        disposed,
        enabled: apiEnabled && SUTRO_BATHS_TUNING.values.waterEnabled,
        stats
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      geometry.dispose();
      material.dispose();
    }
  };
}
