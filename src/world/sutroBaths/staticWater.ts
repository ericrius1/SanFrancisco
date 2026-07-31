import * as THREE from "three/webgpu";
import {
  abs,
  atan,
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
  pow,
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
  SUTRO_DRAIN,
  SUTRO_POOLS,
  SUTRO_WATER_RENDER_ORDER,
  distanceToSutroWater,
  isInsideSutroPool,
  sutroLocalToWorld,
  sutroPoolEdgeDistance,
  sutroPoolSideIsSeamed
} from "./layout";
import { SUTRO_BATHS_TUNING } from "./tuning";
import { writeSsrMask } from "../../render/post/shared/gbuffer";

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
/** Near the plunge drain the sheet densifies so the whirlpool funnel is smooth. */
const DRAIN_DENSE_CELL = 0.34;
const DRAIN_DENSE_RADIUS = 5.8;
const POOL_EDGE_INSET = 0.08;
/** Ripple relief plus the authored whirlpool depression. */
const MAX_VISUAL_RELIEF = 0.72;
/** How deep the surface sinks into the drain (metres). */
const WHIRL_DEPRESSION = 0.58;
const WHIRL_OUTER = 5.2;
const WHIRL_CORE = 1.35;

/**
 * Non-uniform samples along one pool axis: coarse far from `focus`, dense near
 * it. Keeps the great plunge cheap while giving the whirlpool enough verts to
 * look round instead of faceted.
 */
function axisSamples(
  min: number,
  max: number,
  focus: number,
  denseRadius: number,
  denseStep: number,
  coarseStep: number
): number[] {
  const pts: number[] = [min];
  let x = min;
  while (x < max - 1e-5) {
    const near = Math.abs(x - focus) < denseRadius || Math.abs(x + coarseStep - focus) < denseRadius;
    const step = near ? denseStep : coarseStep;
    x = Math.min(max, x + step);
    if (x - pts[pts.length - 1] > 1e-5) pts.push(x);
    else if (x >= max) break;
    else x = pts[pts.length - 1] + denseStep * 0.5;
  }
  if (pts[pts.length - 1] < max - 1e-4) pts.push(max);
  return pts;
}

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

  for (const pool of SUTRO_POOLS) {
    // A sheet stops just short of a real coping so its edge hides under the
    // tile — but runs dead onto a seam, because the far side of a seam is more
    // of the same pool and two inset edges there leave a crack in the water.
    const inset = (side: "minX" | "maxX" | "minZ" | "maxZ") =>
      sutroPoolSideIsSeamed(pool, side) ? 0 : POOL_EDGE_INSET;
    const minX = pool.minX + inset("minX");
    const maxX = pool.maxX - inset("maxX");
    const minZ = pool.minZ + inset("minZ");
    const maxZ = pool.maxZ - inset("maxZ");
    const holdsDrain =
      SUTRO_DRAIN.x >= minX &&
      SUTRO_DRAIN.x <= maxX &&
      SUTRO_DRAIN.z >= minZ &&
      SUTRO_DRAIN.z <= maxZ;
    const xs = holdsDrain
      ? axisSamples(minX, maxX, SUTRO_DRAIN.x, DRAIN_DENSE_RADIUS, DRAIN_DENSE_CELL, TARGET_CELL_SIZE)
      : axisSamples(minX, maxX, (minX + maxX) * 0.5, 0, TARGET_CELL_SIZE, TARGET_CELL_SIZE);
    const zs = holdsDrain
      ? axisSamples(minZ, maxZ, SUTRO_DRAIN.z, DRAIN_DENSE_RADIUS, DRAIN_DENSE_CELL, TARGET_CELL_SIZE)
      : axisSamples(minZ, maxZ, (minZ + maxZ) * 0.5, 0, TARGET_CELL_SIZE, TARGET_CELL_SIZE);
    const columns = xs.length;
    const rows = zs.length;
    const firstVertex = positions.length / 3;

    for (let row = 0; row < rows; row++) {
      const localZ = zs[row]!;
      for (let column = 0; column < columns; column++) {
        const localX = xs[column]!;
        const world = sutroLocalToWorld(localX, localZ);
        positions.push(
          world.x - SUTRO_BATHS.centerX,
          SUTRO_BATHS.waterY,
          world.z - SUTRO_BATHS.centerZ
        );

        metadata.push(
          pool.heat,
          1 - smoothstep01(sutroPoolEdgeDistance(pool, localX, localZ) / 2.4),
          pool.tone,
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
  // World-space centre of the plunge drain. The surface whirlpool is shaded
  // here so it is the same teal / mirror / foam as the rest of the sheet —
  // drain.ts only owns the bronze collar and the dark bore below.
  const drainWorld = sutroLocalToWorld(SUTRO_DRAIN.x, SUTRO_DRAIN.z);
  const drainPosU = uniform(new THREE.Vector2(drainWorld.x, drainWorld.z));

  const toDrain = positionWorld.xz.sub(drainPosU);
  const drainDist = toDrain.length();
  const drainSafe = drainDist.max(0.08);
  const whirlAmt = float(1).sub(smoothstep(float(WHIRL_CORE), float(WHIRL_OUTER), drainDist));
  // Funnel walls (not the open core): where the surface slopes into the bore.
  const funnelAmt = smoothstep(float(WHIRL_CORE * 0.35), float(WHIRL_CORE + 0.55), drainDist).mul(
    float(1).sub(smoothstep(float(WHIRL_CORE + 0.9), float(WHIRL_OUTER), drainDist))
  );
  const drainAngle = atan(toDrain.y, toDrain.x);
  const spiralPhase = drainAngle.mul(2.8).sub(drainDist.mul(1.9)).sub(timeU.mul(1.55));
  const spiral = sin(spiralPhase).mul(0.5).add(0.5);
  // Soft depression: deepest on the funnel, gently flat in the open core so
  // the sheet does not pin itself to a single vertex in the middle.
  const depression = whirlAmt
    .mul(whirlAmt)
    .mul(float(WHIRL_DEPRESSION))
    .mul(mix(float(0.55), float(1), funnelAmt.add(0.35).min(1)));

  const waveA = positionWorld.x.mul(0.46).add(positionWorld.z.mul(0.13)).add(timeU.mul(0.72));
  const waveB = positionWorld.z.mul(0.69).sub(positionWorld.x.mul(0.08)).sub(timeU.mul(0.49));
  const analyticalWave = sin(waveA)
    .mul(0.58)
    .add(sin(waveB).mul(0.42))
    .mul(rippleU)
    .mul(float(1).sub(whirlAmt.mul(0.85)))
    .sub(depression);
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
  // A third, incommensurate octave breaks the two-wave lattice that can lock
  // into a tiled mirror at mid-range on the great plunge.
  const waveE = positionWorld.x.mul(3.13).add(positionWorld.z.mul(2.71)).sub(timeU.mul(1.67));
  const viewVectorEarly = positionWorld.sub(cameraPosition);
  const viewDistance = viewVectorEarly.length();
  // Fine normals are for close water; past ~30 m they alias into a regular
  // shimmer grid on the sky mirror. Soften them with distance — cheaper and
  // more organic than keeping full-frequency tilt on every far fragment.
  const fineKeep = float(1)
    .sub(smoothstep(12, 36, viewDistance).mul(0.82))
    .mul(float(1).sub(whirlAmt.mul(0.55)));
  const fineRipple = normalRipple.mul(FINE_RIPPLE_GAIN).mul(fineKeep);
  // Tangential swirl + radial inward slope: the surface is turning into the
  // bore. Normals only — the vertex depression already owns the silhouette.
  const radialX = toDrain.x.div(drainSafe);
  const radialZ = toDrain.y.div(drainSafe);
  const tangX = radialZ.negate();
  const tangZ = radialX;
  const swirlGain = funnelAmt.mul(0.95).add(whirlAmt.mul(0.35));
  const spiralTilt = spiral.sub(0.5).mul(swirlGain).mul(0.55);
  const analyticalNormalX = cos(waveA)
    .mul(normalRipple)
    .mul(0.27)
    .add(cos(waveC).mul(fineRipple))
    .add(cos(waveE).mul(fineRipple.mul(0.45)))
    .add(tangX.mul(swirlGain).mul(0.62))
    .add(radialX.mul(funnelAmt).mul(0.48))
    .add(spiralTilt.mul(tangX));
  const analyticalNormalZ = cos(waveB)
    .mul(normalRipple)
    .mul(0.29)
    .add(cos(waveD).mul(fineRipple))
    .add(sin(waveE).mul(fineRipple.mul(0.45)))
    .add(tangZ.mul(swirlGain).mul(0.62))
    .add(radialZ.mul(funnelAmt).mul(0.48))
    .add(spiralTilt.mul(tangZ));
  const worldNormal = normalize(vec3(analyticalNormalX, 1, analyticalNormalZ));

  const viewVector = viewVectorEarly;
  const viewToFragment = viewVector.div(viewDistance.max(1e-4));
  const slant = viewToFragment.y.abs().max(0.18);
  const bedDepth = mix(poolDepthU, float(0.14), smoothstep(0.2, 1.0, waterMeta.y))
    .add(whirlAmt.mul(1.8))
    .max(0.05);
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
  // Caustic webs tile hard at mid-range; soften with view distance and keep
  // them out of the whirlpool where the bore already owns the bed read.
  const causticKeep = float(1)
    .sub(smoothstep(18, 52, viewDistance).mul(0.75))
    .mul(float(1).sub(whirlAmt));
  const litBed = bedScene.add(
    causticPattern
      .mul(causticU)
      .mul(shallowFocus)
      .mul(daylight)
      .mul(causticKeep)
      .mul(bedScene.add(0.12))
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
  // Whirl body: same family of teal, just deeper and a little cooler where the
  // sheet is being pulled down — never a separate cyan VFX colour.
  const whirlDeep = mix(deepColorU, duskColorU, twilightU.mul(0.55));
  const whirlSurface = mix(
    surfaceColor,
    mix(whirlDeep, temperatureColor, spiral.mul(0.22).add(0.1)),
    whirlAmt.mul(0.78)
  );

  const dither = interleavedGradientNoise(screenCoordinate.xy);
  const edgeWobble = sin(positionWorld.x.mul(1.4).add(sin(positionWorld.z.mul(1.1)).mul(1.6)));
  const edgeRings = sin(waterMeta.y.mul(9.5).sub(timeU.mul(1.05)).add(edgeWobble.mul(0.7)));
  const edgeFoam = smoothstep(0.6, 0.94, edgeRings)
    .mul(smoothstep(0.25, 0.85, waterMeta.y))
    .mul(shoreFoamU);
  // Soft white lip where the funnel meets the free surface — the one bright
  // cue that this is a whirlpool, and still the sheet's own foam path.
  const lipFoam = smoothstep(float(0.7), float(0), abs(drainDist.sub(float(WHIRL_CORE + 0.55))))
    .mul(mix(float(0.35), float(0.85), spiral))
    .mul(0.55);
  const foamMask = ditheredCoverage(saturate(edgeFoam.add(lipFoam)), dither);
  // Kill discrete sparkle cells near the drain — they are what read as tiling
  // on the funnel — and fade them earlier across the hall in general.
  const sparkle = sunSparkle({
    worldPosition: positionWorld,
    worldNormal,
    viewToFragment,
    sunDirection: sunDirU,
    time: timeU,
    cellJitter: 0.85,
    fadeStart: 14,
    fadeEnd: 48
  })
    .mul(sparkleU)
    .mul(float(1).sub(whirlAmt));
  // Evening water must still read as water. Clear daylight water is mostly the
  // lit bed showing through; with the sun gone that left the pools looking like
  // dry basins, so twilight closes the transmittance down and the body of the
  // pool carries its own dusk glow instead.
  const transmittance = water.transmittance
    .mul(float(1).sub(foamMask))
    .mul(twilightU.mul(0.3).oneMinus())
    .mul(float(1).sub(whirlAmt.mul(0.55)));

  // Lamplight on the surface. Discrete glints are jittered off the cell lattice
  // and fade with distance so the great plunge never locks into a checkerboard;
  // a soft continuous lobe carries the warm presence once the points dissolve.
  const lampColorU = uniform(new THREE.Color(0xffb673));
  const lampDirU = uniform(new THREE.Vector3(0.18, 0.94, -0.28).normalize());
  const lampGlint = sunSparkle({
    worldPosition: positionWorld,
    worldNormal,
    viewToFragment,
    sunDirection: lampDirU,
    time: timeU.mul(0.6),
    cellDensity: 11,
    cellJitter: 0.95,
    fadeStart: 8,
    fadeEnd: 28
  })
    .mul(twilightU)
    .mul(float(1).sub(whirlAmt.mul(0.9)));
  const lampSoft = pow(
    saturate(reflect(viewToFragment, worldNormal).dot(lampDirU)),
    28
  )
    .mul(twilightU)
    .mul(0.1)
    .mul(float(1).sub(whirlAmt.mul(0.7)));
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
          // Foam is spray, not a surface — it must not mirror anything. The
          // whirlpool core opens the sheet so the dark bore below can read
          // through instead of reflecting sky as a flat disc over the drain.
          const weight = fresnel
            .mul(mirrorU)
            .mul(float(1).sub(foamMask))
            .mul(float(1).sub(whirlAmt.mul(0.85)))
            .clamp(0, 1);
          return { radiance, weight };
        })()
      : null;

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
  // The hall lamps are real punctual lights on a regular grid. Feeding them
  // through MeshStandard's specular path at dusk roughness (~0.07) stamps that
  // grid onto the great plunge as tiled circular highlights — exactly the
  // artifact that made distant water look like a checkerboard while the near
  // right side (steam, smaller tanks, foreshortening) still read organic.
  //
  // The pools already author their whole look in emissiveNode (bed, sparkle,
  // lamp glints, sky mirror). Skipping the lighting block matches the ocean
  // sheets' `lights = false` contract, removes the lattice, and drops the
  // per-fragment punctual + IBL work on a hall-sized transparent surface.
  // MeshStandard (not Basic) stays so `normalNode` still reaches the SSR mask.
  material.lights = false;
  material.forceSinglePass = true;
  material.positionNode = positionLocal.add(vec3(0, analyticalWave, 0));
  // The sky mirror belongs to the ABOVE-water branch only. Seen from beneath,
  // the surface is Snell's window and total internal reflection — a swimmer
  // looking up must not also get a reflection of the dome painted over it.
  const aboveDiffuse = mix(
    whirlSurface.mul(vec3(1).sub(transmittance)),
    highlightColorU,
    foamMask
  );
  // Same complementarity as the emissive blend below: a fragment that is mostly
  // mirror has almost no diffuse response left to give.
  material.colorNode = mix(
    mirror ? aboveDiffuse.mul(float(1).sub(mirror.weight)) : aboveDiffuse,
    // Almost all of the underside is emissive; leaving albedo dark keeps the
    // hall's directional light from raking across a surface it is behind.
    underLit.mul(0.12),
    belowU
  );
  // Soft spiral highlight in pool colour — folding water, not additive cyan.
  const whirlRibbon = temperatureColor
    .mul(spiral.mul(funnelAmt).mul(0.16))
    .add(whirlDeep.mul(whirlAmt.mul(0.12)));
  const body = litBed
    .mul(transmittance)
    .add(highlightColorU.mul(foamMask.mul(0.1)))
    .add(vec3(1.0, 0.97, 0.88).mul(sparkle).mul(twilightU.mul(0.7).oneMinus()))
    .add(lampColorU.mul(lampGlint.mul(0.55).add(lampSoft).add(lampWash)))
    .add(duskColorU.mul(twilightU).mul(0.5))
    .add(whirlRibbon);
  // Reflection and transmission are complementary, never additive: light that
  // bounces off the surface is light that did not enter it. Adding the mirror
  // on top of a body chain authored without one made the pools brighter than
  // the sky. Blending by the same Fresnel weight keeps the sum at unity, so
  // looking straight down still shows the lit bed and only the grazing angles
  // become mirror.
  material.emissiveNode = mix(
    mirror ? mix(body, mirror.radiance, mirror.weight) : body,
    underLit.mul(0.85).add(underGlint),
    belowU
  );
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz);
  // SSR opt-in. These pools ALREADY mirror the sky analytically (`mirror`
  // above, weighted by Fresnel × mirrorU), which is what makes the hall read
  // at sunset — but an analytic sky mirror cannot show the arcade columns or
  // the ruined walls standing in the water, and those are the reflections a
  // visitor standing at the rim expects. SSR supplies exactly the term the
  // analytic path structurally cannot.
  //
  // Two suppressions, both restating shading decisions this file already made:
  // foam is spray and "must not mirror anything" (see the mirror weight), and
  // the mirror "belongs to the ABOVE-water branch only" — a swimmer looking up
  // gets Snell's window, not a screen-space reflection of the hall.
  //
  // 0.85 matches mirrorU's default rather than being a second opinion about how
  // reflective still water is.
  writeSsrMask(
    material,
    float(0.85)
      .mul(foamMask.oneMinus())
      .mul(belowU.oneMinus())
      .mul(float(1).sub(whirlAmt.mul(0.9)))
  );

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
    mirrorU.value = tuning.waterSkyMirror;
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
      // Roughness no longer drives lamp speculars (`lights = false`); keep a
      // mild dusk tighten only so any future lit path stays calm. The sky
      // mirror in the node graph is what actually opens up at dusk — sharpen
      // its blur so a calm evening pool reads harder-edged.
      material.roughness = 0.34 - t * 0.12;
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
