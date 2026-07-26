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
  reflect,
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

/**
 * What the barrel roof does to a reflected ray that hits it instead of the sky:
 * most of the energy gone, and what survives carries the ironwork's warmth
 * rather than the sky's violet. Not a colour anyone sees directly — it only
 * ever multiplies reflected sky radiance.
 */
const ROOF_REFLECTED = /*@__PURE__*/ new THREE.Vector3(0.26, 0.22, 0.2);

/**
 * Normal-slope contribution of the fine ripple octave, relative to the long
 * swell's. Above roughly 1.2 the surface starts to sparkle like crushed foil
 * under the lamps rather than ripple; below about 0.4 a grazing reflection goes
 * back to being one flat sheet.
 */
const FINE_RIPPLE_GAIN = 0.58;

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
  /** 0 = daylight pools, 1 = the out-of-time twilight (lamps on the water). */
  setTwilight(depth: number): void;
  syncTuning(): void;
  readonly stats: SutroBathsStaticWaterStats;
  debugState(): SutroBathsStaticWaterDebugState;
  dispose(): void;
};

/** What the pools need from the Sky to mirror it. See SutroSkyClock. */
export type SutroWaterSky = {
  envRadiance?(dir: unknown, level: unknown): unknown;
};

export function createSutroBathsStaticWater(options: {
  renderer: THREE.WebGPURenderer;
  /** Omit and the pools keep their pre-mirror look; nothing else changes. */
  sky?: SutroWaterSky | null;
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
  // A second, much finer wave scale. The long swell above carries the pool's
  // motion but its normal tilts only about a degree, which is nothing to a
  // mirror: reflected rays a degree apart land on the same patch of a smooth
  // sky and the whole pool returns one flat sheet. Surface texture is what
  // makes water read as water, and normal slope goes as amplitude times
  // frequency — so a wave a fifth the height but four times the frequency
  // costs almost no visible displacement while contributing several times the
  // tilt. Normals only, for the reason above: this never moves a vertex.
  const waveC = positionWorld.x.mul(1.97).sub(positionWorld.z.mul(1.53)).add(timeU.mul(1.31));
  const waveD = positionWorld.z.mul(2.21).add(positionWorld.x.mul(1.07)).sub(timeU.mul(1.09));
  const fineRipple = normalRipple.mul(FINE_RIPPLE_GAIN);
  const analyticalNormalX = cos(waveA)
    .mul(normalRipple)
    .mul(0.27)
    .add(cos(waveC).mul(fineRipple));
  const analyticalNormalZ = cos(waveB)
    .mul(normalRipple)
    .mul(0.29)
    .add(cos(waveD).mul(fineRipple));
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

  // ---------------------------------------------------------------- sky mirror
  //
  // A still pool under a glass roof at sunset is mostly a mirror, and the hall's
  // whole reason to exist is the sky above it. Without this the pools render as
  // slate slabs: the material is a MeshStandardNodeMaterial and DOES already get
  // a specular reflection of the sky through `scene.environmentNode`, but that
  // arrives scaled by `scene.environmentIntensity`, which the world calibrates
  // to ~0.14 — a correct reflection at a seventh of its strength, which reads as
  // none at all.
  //
  // Rather than raise a global that the entire city is balanced against, the
  // pools take the reflection themselves, from the SAME source the dome draws
  // (`Sky.envRadiance`), so the mirror can never disagree with the sky it is
  // mirroring — across the pocket's whole sunset-to-twilight swing, for free.
  //
  // Schlick against F0 = 0.02 (water/air) is what keeps this honest and makes it
  // self-limiting: look straight down into a pool and it is ~2% reflective and
  // you see the lit bed exactly as before; look along the length of the great
  // plunge and it approaches 1 and becomes the sky. No twilight gate is needed —
  // the geometry already decides, which is why daylight keeps its clear teal.
  //
  // `envRadiance` excludes the sun/moon discs and the starfield. That is wanted:
  // the sparkle terms below already own the specular highlight, and a reflected
  // starfield on a rippled surface is sub-pixel noise, not stars.
  const mirrorU = uniform(0.85);
  // Roughness stand-in for the reflection blur. Kept low so the gradient reads,
  // and NOT zero — a perfect mirror on an analytic ripple looks like foil.
  const mirrorSoftenU = uniform(0.16);
  const mirror =
    typeof options.sky?.envRadiance === "function"
      ? (() => {
          const reflectDir = reflect(viewToFragment, worldNormal);
          const cosView = viewToFragment.negate().dot(worldNormal).clamp(0, 1);
          const fresnel = float(0.02).add(cosView.oneMinus().pow(5).mul(0.98));
          // These pools are indoors. Reflecting the open dome makes them read
          // brighter than the sky above them, which no mirror can be: most of
          // the upward hemisphere over a pool is barrel roof — iron ribs, tie
          // chords and dirty glass — not sky. Rays leaving nearly flat pass out
          // under the roof edge to the real horizon and stay bright; rays
          // climbing steeply hit the lattice and lose most of their energy.
          //
          // This is also what puts STRUCTURE back in the reflection. Reflected
          // elevation varies from the near rim to the far end of the great
          // plunge, so a single elevation-driven term becomes a gradient down
          // the pool instead of one flat sheet. It is an approximation of the
          // roof, not the roof — reflecting the actual ironwork needs a planar
          // or screen-space pass, which is deliberately not in this tier.
          const roofOpen = smoothstep(0.42, 0.03, reflectDir.y);
          const roofShade = mix(ROOF_REFLECTED, vec3(1, 1, 1), roofOpen);
          const radiance = (
            options.sky.envRadiance(reflectDir, mirrorSoftenU) as N
          ).mul(roofShade);
          // Foam is spray, not a surface — it must not mirror anything.
          const weight = fresnel.mul(mirrorU).mul(float(1).sub(foamMask)).clamp(0, 1);
          return { radiance, weight };
        })()
      : null;

  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.34,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide
  });
  material.positionNode = positionLocal.add(vec3(0, analyticalWave, 0));
  const diffuse = mix(
    surfaceColor.mul(vec3(1).sub(transmittance)),
    highlightColorU,
    foamMask
  );
  // Same complementarity as the emissive blend below: a fragment that is mostly
  // mirror has almost no diffuse response left to give.
  material.colorNode = mirror
    ? diffuse.mul(float(1).sub(mirror.weight))
    : diffuse;
  const body = litBed.mul(transmittance)
    .add(highlightColorU.mul(foamMask.mul(0.1)))
    .add(vec3(1.0, 0.97, 0.88).mul(sparkle).mul(twilightU.mul(0.7).oneMinus()))
    .add(lampColorU.mul(lampGlint.mul(0.5).add(lampWash)))
    .add(duskColorU.mul(twilightU).mul(0.5));
  // Reflection and transmission are complementary, never additive: light that
  // bounces off the surface is light that did not enter it. Adding the mirror
  // on top of a body chain authored without one made the pools brighter than
  // the sky. Blending by the same Fresnel weight keeps the sum at unity, so
  // looking straight down still shows the lit bed and only the grazing angles
  // become mirror.
  material.emissiveNode = mirror
    ? mix(body, mirror.radiance, mirror.weight)
    : body;
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz);

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
    mirrorU.value = tuning.waterSkyMirror;
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
    setTwilight(depth) {
      const t = depth < 0 ? 0 : depth > 1 ? 1 : depth;
      twilightU.value = t;
      // Daylight water is read through its surface; evening water is read off
      // it. Tightening roughness as the sun goes turns the pools into mirrors of
      // the sunset instead of the flat sky-grey slabs a broad rough reflection
      // leaves behind.
      material.roughness = 0.34 - t * 0.27;
      // `envMapIntensity` used to be set here and at construction. It does
      // nothing: three reads it only when the material carries its own envMap,
      // and this one reflects the scene-wide `environmentNode`, so the live
      // value is `scene.environmentIntensity` and always was. The sky mirror in
      // the node graph above is what actually opens up at dusk; sharpen the
      // reflection blur with it so a calm evening pool reads harder-edged.
      mirrorSoftenU.value = 0.16 - t * 0.09;
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
