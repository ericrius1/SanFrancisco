import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  exp,
  float,
  max,
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
  SUTRO_WATER_RENDER_ORDER,
  distanceToSutroWater,
  isInsideSutroPool,
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
  /** Camera under the waterline: the sheet is drawing its underside look. */
  cameraSubmerged: boolean;
  stats: SutroBathsStaticWaterStats;
};

export type SutroBathsStaticWater = {
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  update(
    dt: number,
    time: number,
    player: { x: number; z: number },
    camera: THREE.Camera
  ): void;
  /** True while the camera is under the pools' waterline. */
  readonly cameraSubmerged: boolean;
  setEnabled(enabled: boolean): void;
  /** 0 = daylight pools, 1 = the out-of-time twilight (lamps on the water). */
  setTwilight(depth: number): void;
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
  // Pocket twilight: the sun leaves the bed caustics and the lamps take over the
  // surface. One uniform, no second material, no pipeline permutation.
  const twilightU = uniform(0);
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

  // At dusk the surface stops being a window and becomes a mirror, and a
  // perfectly flat mirror reads as a slab of slate. Deepening only the NORMAL
  // (never the vertex displacement, which would lift the waterline off the
  // coping) keeps the sunset broken up across the pool.
  const normalRipple = rippleU.mul(twilightU.mul(3.2).add(1));
  const analyticalNormalX = cos(waveA).mul(normalRipple).mul(0.27);
  const analyticalNormalZ = cos(waveB).mul(normalRipple).mul(0.29);
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
  // Caustics are sunlight on the pool bed; they fade out with the daylight and
  // never survive into deep twilight.
  const daylight = saturate(sunDirU.y.mul(4)).mul(twilightU.mul(0.82).oneMinus());
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
  const litSurface = mix(baseColor, highlightColorU, smoothstep(0.81, 0.99, crest).mul(0.12));
  // Evening water reads deeper and cooler in the body, so the warm lamp glints
  // below have something to sit against.
  const duskColorU = uniform(new THREE.Color(0x123a49));
  const surfaceColor = mix(litSurface, mix(litSurface, duskColorU, float(0.42)), twilightU);

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
  // Evening water must still read as water. Clear daylight water is mostly the
  // lit bed showing through; with the sun gone that left the pools looking like
  // dry basins, so twilight closes the transmittance down and the body of the
  // pool carries its own dusk glow instead.
  const transmittance = water.transmittance
    .mul(float(1).sub(foamMask))
    .mul(twilightU.mul(0.3).oneMinus());

  // Lamplight on the surface. Reusing the sparkle cell field with an overhead
  // "lamp direction" gives real per-wavelet twinkles instead of the smooth
  // sine-product blobs a hand-rolled field lays down in a visible grid.
  const lampColorU = uniform(new THREE.Color(0xffb673));
  const lampDirU = uniform(new THREE.Vector3(0.18, 0.94, -0.28).normalize());
  const lampGlint = sunSparkle({
    worldPosition: positionWorld,
    worldNormal,
    viewToFragment,
    sunDirection: lampDirU,
    time: timeU.mul(0.6),
    cellDensity: 13
  }).mul(twilightU);
  // …plus the faintest warm wash so an evening pool still has a body to it.
  const lampWash = twilightU.mul(0.04);

  // --- the surface seen from BENEATH ---------------------------------------
  //
  // The sheet used to be FrontSide, so a swimmer who ducked under looked
  // straight through the waterline at the roof trusses and the sky, with the
  // hall's columns stabbing into "air". This is the missing lid, on the same
  // mesh (so it can never disagree with the footprint) and selected by one
  // uniform rather than a second material: above and below are mutually
  // exclusive for a flat pool, so the CPU can just say which one it is and no
  // pipeline permutation is needed.
  //
  // Physics of the look: refraction inverts the whole sky into a bright cone
  // of about 48.6° half-angle straight overhead — Snell's window — and
  // everything outside that cone is total internal reflection, i.e. a rippled
  // mirror of the pool itself. Baths are shallow, so the window is small and
  // moves fast as you rise, which is exactly the cue that tells you which way
  // is up.
  const belowU = uniform(0);
  const camXZU = uniform(new THREE.Vector2());
  const camYU = uniform(0);
  const underDepth = max(float(SUTRO_BATHS.waterY).sub(camYU), 0.3);
  const underHoriz = positionWorld.xz.sub(camXZU).length();
  // The true cone is 48.6° half-angle (radius ≈ 1.13 × depth), but the pitch a
  // swimmer can actually reach means a physically sized window fills the entire
  // up-view with flat near-white and just reads as open sky. Drawing it tight
  // keeps it legible as a window — the same call world/water.ts's ocean lid
  // makes. The ripple wobbles the rim so it is a moving hole, not a disc.
  const underWobble = worldNormal.xz.length().mul(underDepth.mul(1.6));
  const underWindow = smoothstep(
    underDepth.mul(0.2),
    underDepth.mul(0.62),
    underHoriz.add(underWobble)
  ).oneMinus();
  // Everything outside the window is total internal reflection: a rippled
  // mirror of the bath, not a view of the hall.
  const underRipple = sin(positionWorld.x.mul(1.7).add(timeU.mul(1.05)))
    .mul(sin(positionWorld.z.mul(1.45).sub(timeU.mul(0.85))))
    .mul(0.5)
    .add(0.5);
  const underSilver = uniform(new THREE.Color(0x2c5c63));
  const underLit = mix(
    mix(underSilver, temperatureColor, underRipple.mul(0.45)),
    highlightColorU,
    saturate(underWindow.add(underRipple.mul(0.14)).add(crest.mul(0.1)))
  );
  // Lamps and the sun still glint off the mirror side, just dimmer.
  const underGlint = lampColorU.mul(lampGlint.mul(0.35).mul(twilightU));

  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.34,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    // Both faces: the same sheet is the pool from the deck and the ceiling from
    // in the water. Nothing here uses transmission, so this stays single-pass.
    side: THREE.DoubleSide
  });
  material.forceSinglePass = true;
  material.positionNode = positionLocal.add(vec3(0, analyticalWave, 0));
  material.colorNode = mix(
    mix(surfaceColor.mul(vec3(1).sub(transmittance)), highlightColorU, foamMask),
    // Almost all of the underside is emissive; leaving albedo dark keeps the
    // hall's directional light from raking across a surface it is behind.
    underLit.mul(0.12),
    belowU
  );
  material.emissiveNode = mix(
    litBed
      .mul(transmittance)
      .add(highlightColorU.mul(foamMask.mul(0.1)))
      .add(vec3(1.0, 0.97, 0.88).mul(sparkle).mul(twilightU.mul(0.7).oneMinus()))
      .add(lampColorU.mul(lampGlint.mul(0.5).add(lampWash)))
      .add(duskColorU.mul(twilightU).mul(0.5)),
    underLit.mul(0.85).add(underGlint),
    belowU
  );
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz);
  material.envMapIntensity = 0.42;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "sutro_baths_static_water_surface";
  mesh.position.set(SUTRO_BATHS.centerX, 0, SUTRO_BATHS.centerZ);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // Reversed-depth transparent ordering: this must stay ABOVE the steam shells'
  // order so the sheet is laid down first and the plumes composite on top of
  // it. See SUTRO_WATER_RENDER_ORDER in layout.ts.
  mesh.renderOrder = SUTRO_WATER_RENDER_ORDER;

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
  let cameraSubmerged = false;

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
    update(_dt, time, player, camera) {
      if (disposed) return;
      timeU.value = Number.isFinite(time) ? time : 0;
      (sunDirU.value as THREE.Vector3).copy(SUN_DIR);
      stats.playerDistance = distanceToSutroWater(player.x, player.z);
      stats.revision++;

      // Which side of the sheet the eye is on. The band is asymmetric so a
      // swimmer bobbing at the waterline cannot strobe between the two looks:
      // commit to the ceiling only once the eye is properly under, and give it
      // up as soon as it breaks the surface again.
      const eye = camera.position;
      const below = cameraSubmerged
        ? eye.y < SUTRO_BATHS.waterY - 0.02
        : eye.y < SUTRO_BATHS.waterY - 0.1;
      // Only inside a pool footprint: standing on the deck beside a bath puts
      // the eye above the waterline anyway, but the basin walkways and the
      // beach stair go below it, and the ceiling look there would be nonsense.
      cameraSubmerged = below && isInsideSutroPool(eye.x, eye.z);
      belowU.value = cameraSubmerged ? 1 : 0;
      // Depth is written ONLY from below, and it is what makes the underside
      // visible at all. The post-process underwater fog attenuates every pixel
      // by the OPAQUE depth behind it, so a depth-free ceiling inherited the
      // roof trusses' distance twelve metres up, took a full water column of
      // in-scatter, and washed out to flat fog — the sheet drew perfectly and
      // you could still see the roof through it. From above it must stay off:
      // the sheet is read THROUGH (its own refraction samples the scene behind
      // it) and the steam composites over it.
      if (material.depthWrite !== cameraSubmerged) material.depthWrite = cameraSubmerged;
      (camXZU.value as THREE.Vector2).set(eye.x, eye.z);
      camYU.value = eye.y;
    },
    get cameraSubmerged() {
      return cameraSubmerged;
    },
    setEnabled(enabled) {
      apiEnabled = enabled;
      group.visible = enabled && SUTRO_BATHS_TUNING.values.waterEnabled;
    },
    setTwilight(depth) {
      const t = depth < 0 ? 0 : depth > 1 ? 1 : depth;
      twilightU.value = t;
      // Daylight water is read through its surface; evening water is read off
      // it. Tightening roughness and opening the environment term as the sun
      // goes turns the pools into mirrors of the sunset instead of the flat
      // sky-grey slabs a broad rough reflection leaves behind.
      material.roughness = 0.34 - t * 0.27;
      material.envMapIntensity = 0.42 + t * 0.62;
    },
    syncTuning,
    stats,
    debugState() {
      return {
        webgpu: true,
        staticSurface: true,
        disposed,
        enabled: apiEnabled && SUTRO_BATHS_TUNING.values.waterEnabled,
        cameraSubmerged,
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
