import { Color, DepthTexture, FloatType, Vector3 } from "three/webgpu";
import {
  abs,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  hash,
  linearDepth,
  log,
  max,
  mix,
  normalize,
  pow,
  reflect,
  saturate,
  screenUV,
  sin,
  smoothstep,
  vec2,
  vec3,
  viewportDepthTexture
} from "three/tsl";
import { spectrum } from "./oceanBeachKite/spectrum";

/**
 * Shared stylized-water shading helpers for the clear "sunlit turquoise" look:
 * Beer-Lambert depth tint over a refracted scene sample, a bed caustic web,
 * discrete sun sparkles and ordered-dither foam edges. Every helper is
 * branchless — If() arms that sample nodes corrupt skipped pixels under the
 * WGSL single-emission rule, so composition stays mix/multiply only.
 */

// TSL node generics fight composition; any is the idiom here (see facade.ts).
type N = any;

/**
 * Interleaved gradient noise: a stable per-pixel ordered-dither value in 0..1.
 * Thresholding a smooth coverage field against it dissolves edges into the
 * chunky stipple the reference art direction uses instead of soft alpha.
 */
export function interleavedGradientNoise(pixelCoord: N): N {
  return fract(fract(dot(pixelCoord, vec2(0.06711056, 0.00583715))).mul(52.9829189));
}

/**
 * Dissolves a smooth 0..1 coverage field through a dither threshold. Full
 * coverage stays solid; partial coverage becomes discrete stipple instead of a
 * translucent smear.
 */
export function ditheredCoverage(coverage: N, dither: N, softness = 0.09): N {
  return saturate(
    smoothstep(dither.mul(0.82).add(0.06).sub(softness), dither.mul(0.82).add(0.06).add(softness), coverage)
  );
}

/**
 * Cheap two-layer caustic filament web. Two counter-drifting warped sine
 * fields multiply so bright ridges only survive where both layers align,
 * which reads as refracted light focusing on the bed.
 */
export function causticWeb(uv: N, t: N): N {
  const layerA = abs(
    sin(uv.x.add(sin(uv.y.mul(1.31).add(t.mul(0.9)))))
      .mul(sin(uv.y.add(sin(uv.x.mul(1.17).sub(t.mul(0.7))))))
  );
  const rotated = vec2(
    uv.x.mul(0.54).sub(uv.y.mul(0.84)),
    uv.x.mul(0.84).add(uv.y.mul(0.54))
  ).mul(1.23);
  const layerB = abs(
    sin(rotated.x.add(sin(rotated.y.mul(1.27).sub(t.mul(0.8)))))
      .mul(sin(rotated.y.add(sin(rotated.x.mul(1.09).add(t.mul(0.63))))))
  );
  const web = pow(saturate(vec3(1).x.sub(layerA.mul(layerB).mul(1.35))), 5.0);
  return smoothstep(0.42, 0.94, web);
}

/**
 * Discrete sun glints: a tight specular lobe gated by a time-flickering hash
 * over world-space cells, so individual points pop on and off rather than one
 * continuous highlight smear.
 */
export function sunSparkle(options: {
  worldPosition: N;
  worldNormal: N;
  viewToFragment: N;
  sunDirection: N;
  time: N;
  cellDensity?: number;
}): N {
  const density = options.cellDensity ?? 9.0;
  const reflected = reflect(options.viewToFragment, options.worldNormal);
  const alignment = saturate(dot(reflected, options.sunDirection));
  const lobe = pow(alignment, 180.0);
  const cell = floor(options.worldPosition.xz.mul(density)) as N;
  const phase = floor(options.time.mul(5.0));
  const seed = cell.x.mul(127.1).add(cell.y.mul(311.7)).add(phase.mul(74.7));
  const gate = smoothstep(0.72, 0.94, hash(seed));
  // Day-only: the gate fades with sun height so night water never glitters.
  const daylight = saturate(options.sunDirection.y.mul(4.0));
  return smoothstep(0.12, 0.55, lobe.mul(gate)).mul(daylight);
}

/**
 * Beer-Lambert transmittance and in-scatter colour for a view path through
 * water. Calibrated so at `clarityDepth` metres the transmitted scene takes on
 * exactly the deep palette colour — palettes stay the single source of truth.
 */
export function beerLambertWater(options: {
  /** Metres of water along the eye ray to whatever is behind the surface. */
  pathLength: N;
  deepColor: N;
  shallowColor: N;
  /** Path length (m) at which the water reaches its full deep colour. */
  clarityDepth: N;
}): { transmittance: N; scatter: N } {
  const sigma = log(max(options.deepColor, vec3(0.02))).negate().div(options.clarityDepth);
  const transmittance = exp(options.pathLength.negate().mul(sigma));
  const scatter = mix(
    options.shallowColor,
    options.deepColor,
    saturate(options.pathLength.div(options.clarityDepth))
  );
  return { transmittance, scatter };
}

// Stock viewportSafeUV() copies the pass depth into a default DepthTexture
// (depth24plus), which mismatches this project's reversed float depth buffer
// (depth32float) and makes every copy fail with a WebGPU validation error. One
// shared float-typed destination keeps the copy format-identical.
let sharedFloatDepth: DepthTexture | null = null;
let sharedFloatDepthNode: N = null;

function floatViewportDepthTexture(uv: N): N {
  if (!sharedFloatDepth) {
    sharedFloatDepth = new DepthTexture(1, 1, FloatType);
    // Build one viewport-copy owner and sample that same copied texture at all
    // UVs. Separate viewportDepthTexture() nodes can otherwise allocate a
    // second, default depth24plus destination during material composition.
    sharedFloatDepthNode = (viewportDepthTexture as unknown as (...args: unknown[]) => N)(
      screenUV,
      null,
      sharedFloatDepth
    );
  }
  return sharedFloatDepthNode.sample(uv);
}

/**
 * Depth-checked refraction UV (reversed-z-safe viewportSafeUV equivalent):
 * where the distorted sample would land on geometry in FRONT of the water
 * surface, fall back to the undistorted UV so foreground objects never smear
 * into the refraction.
 */
export function safeRefractionUV(distortedUV: N): N {
  const sampledIsBehind = linearDepth(floatViewportDepthTexture(distortedUV))
    .greaterThanEqual(linearDepth(floatViewportDepthTexture(screenUV)));
  return sampledIsBehind.select(distortedUV, screenUV);
}

// --- twilight foam light ----------------------------------------------------
// The aerated-foam glow below (foamScatter) is driven by sunRadiance, which the
// sky retires at sunset and hands to the moon at −2° — so foam went dark in the
// exact minutes a west-facing beach is worth filming. This is the horizon-band
// afterglow as a light source for AERATED WATER ONLY: resolved on the CPU once
// per frame into a uniform (mirroring how water.ts mirrors sun.color×intensity),
// zero outside the elevation window so night surf never glows.

/** Twilight window + gain — the art pass dials these. Elevations are TRUE sun
 *  elevation (SUN_STATE.elevationDeg), which keeps pointing down after dusk. */
export const TWILIGHT_FOAM = {
  /** Fades in as the sun crosses this elevation on the way down (deg). The sun
   *  key's own transmittance dies at 0°, so the two hand over across 2°…0°. */
  onDeg: 2,
  /** Full strength holds until here (deg, below horizon)… */
  fullUntilDeg: -6,
  /** …then fades to exactly zero by here — the end of the bright afterglow. */
  offDeg: -9.5,
  /** Peak radiance scale, in the same linear space as sunRadiance. Modest by
   *  design: readable crashes through deep sunset, not glowing night foam. */
  gain: 0.5
};

// Afterglow ramp: warm amber just after the disc drops, through rose, into a
// cool slate before the band closes. Linear render space, unit peak.
const TWI_AMBER = new Color(1.0, 0.6, 0.3);
const TWI_ROSE = new Color(0.85, 0.42, 0.46);
const TWI_COOL = new Color(0.3, 0.36, 0.52);
const twiSmooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Resolve the twilight foam radiance for the current TRUE sun elevation into
 *  `out` (a uniform's Color). Zero outside the window. CPU-per-frame — the
 *  shader only ever reads the resulting vec3. */
export function twilightFoamRadiance(elevationDeg: number, out: Color): Color {
  const w =
    twiSmooth(TWILIGHT_FOAM.onDeg, 0, elevationDeg) *
    twiSmooth(TWILIGHT_FOAM.offDeg, TWILIGHT_FOAM.fullUntilDeg, elevationDeg) *
    TWILIGHT_FOAM.gain;
  // Hue slides with depth below the horizon: amber → rose → cool.
  const u = Math.min(1, Math.max(0, (1 - elevationDeg) / 8));
  if (u < 0.55) out.copy(TWI_AMBER).lerp(TWI_ROSE, u / 0.55);
  else out.copy(TWI_ROSE).lerp(TWI_COOL, (u - 0.55) / 0.45);
  return out.multiplyScalar(w);
}

/** The horizon point the afterglow radiates from: the TRUE sun bearing
 *  (SUN_STATE.toSun — SUN_DIR has flipped to the moon by now), flattened to
 *  just above the horizon so beach-level cameras catch the forward lobe. */
export function twilightDirection(toSun: Vector3, out: Vector3): Vector3 {
  out.set(toSun.x, 0, toSun.z);
  const len = out.length();
  if (len < 1e-5) out.set(-1, 0, 0);
  else out.divideScalar(len);
  out.y = 0.06;
  return out.normalize();
}

// --- open-water BRDF -------------------------------------------------------
// Water is not a diffuse solid. What the eye reads is a Fresnel-weighted blend
// of REFLECTED radiance (sky + sun) against TRANSMITTED/in-scattered radiance
// from the water column — the ratio swinging from ~2% reflection looking
// straight down to ~100% at the horizon. Shading it as an albedo through a
// Lambert lobe (what the bay sheets did before) collapses that swing and the
// ocean reads as painted lino: the same tone at your feet and at the horizon.
//
// Everything here is branchless and takes the sky as a CALLBACK, so this module
// stays decoupled from world/sky.ts while the caller supplies the project's
// analytic sky (Sky.envRadiance — a real per-pixel radiance evaluation along
// the reflected ray, no PMREM, no render target, tracking the sun continuously).

/** Water's normal-incidence reflectance: ((1.33−1)/(1.33+1))² ≈ 0.02. */
const WATER_F0 = 0.02;

export interface OceanSurfaceInputs {
  /** Unit world-space surface normal. */
  normal: N;
  /** Unit world-space view ray, EYE → FRAGMENT. */
  viewDir: N;
  /** Apparent roughness 0..1. Feed the LEADR ramp here (base + the slope
   *  variance of every spectral band that has faded below pixel footprint) so
   *  the sun lobe widens with distance instead of aliasing into crawl. */
  roughness: N;
  /** Unit world direction to the dominant key (sun by day, moon by night). */
  sunDir: N;
  /** Key-light radiance, vec3 — sun.color × sun.intensity. */
  sunRadiance: N;
  /** Hemispheric mean sky radiance, vec3 (Sky.ambientRadiance() — a uniform). */
  ambient: N;
  /** Art-directed water-column colour, treated as an in-scatter albedo. */
  bodyAlbedo: N;
  /** 0..1 foam coverage. */
  foam: N;
  /** Foam albedo. */
  foamAlbedo: N;
  /** dir, roughness → sky radiance in the scene's linear render space. */
  skyRadiance: (dir: N, level: N) => N;
  /** Fraction of the hemispheric sky that lights the water COLUMN (not the
   *  reflection). Deliberately separate from the reflection, which takes the
   *  sky at full radiance: three used to apply scene.environmentIntensity
   *  (0.24) to both, which is why the reflection was invisible. Raising the
   *  reflection to 1.0 while leaving this near the old value is the whole
   *  point — a mirror at the horizon, an unchanged turquoise underfoot. */
  ambientGain?: number;
  /** Key-light contribution to the water column. */
  sunDiffuseGain?: number;
  /** Foam is a brighter raft than the water it floats on. */
  foamGain?: number;
  /**
   * 0..1 how much of this foam is freshly AERATED whitewater rather than a
   * flat raft of spent bubbles. Drives a forward-scatter lobe: a breaking wave
   * is a metre-thick cloud of air in water, and with a low sun behind it that
   * cloud lights up from within — which is most of why surf reads at golden
   * hour and why, without this, whitewater rendered exactly as dim as the sea
   * around it and a crash was invisible in every sunset frame. Bay foam leaves
   * this unset and is shaded as before.
   */
  foamGlow?: N;
  /** Horizon-band afterglow radiance for aerated foam (vec3 uniform, already
   *  windowed/gained by twilightFoamRadiance — zero outside twilight). Only
   *  read where foamGlow is set, so bay water pays nothing. */
  twilightRadiance?: N;
  /** Unit direction to the sunset horizon point (twilightDirection). */
  twilightDir?: N;
  /** Master trim on reflected sky radiance (1 = physical). */
  reflectionGain?: number;
  /** 0..1 mask of thin, light-transmitting water — folding crests. Drives the
   *  view-dependent subsurface glow (see below). */
  sss?: N;
  /** Tint of light transmitted THROUGH a wave crest. */
  sssColor?: N;
  /** Seabed albedo seen through the water column (Tier B). Omit over deep
   *  water — the pair is build-time gated, so leaving it out costs nothing. */
  bedAlbedo?: N;
  /** vec3 Beer-Lambert transmittance to the bed, ALREADY multiplied by the
   *  shallow gate so it is exactly 0 past the visible depth. */
  bedTransmittance?: N;
  /** Calibration of the bed against the terrain's own (lit) illuminant. */
  bedGain?: number;
  /** skyDir -> 0..1 fraction of that reflected ray blocked by terrain (Tier C).
   *  Takes the ray as an argument rather than a precomputed value so it is
   *  resolved against the SAME horizon-clamped reflected direction the sky is
   *  sampled with; deriving it separately from a flat-mirror ray disagrees with
   *  the real per-pixel wave normal and tears. */
  reflectionBlock?: (skyDir: N) => N;
  /** Radiance substituted where the reflection is blocked — the reflected
   *  landmass. */
  blockedRadiance?: N;
  /** Prism-beam reflection (the rainbow kite's fan mirrored in the sea). The
   *  five below must be provided together; values come from the shared
   *  PRISM_GLINT uniforms (src/world/prismGlint.ts). Build-time gated like
   *  every other optional lane — only the displaced near sheet pays. */
  prismOrigin?: N;
  prismDir?: N;
  prismAcross?: N;
  /** x: beam length · y: far half-width · z: strength (0 kills the term). */
  prismParams?: N;
  /** Fragment world position — required by the prism lobe's ray test. */
  worldPos?: N;
}

/**
 * Fresnel-weighted open-water radiance. One sky evaluation, one GGX lobe.
 *
 * Cheaper than the PBR path it replaces: dropping `lights` on the material
 * removes the whole analytic-light + IBL tail (a pooled point light, the split-
 * sum DFG lookups, and the sky evaluated TWICE — once for radiance and once for
 * irradiance), which measured ~1500 ALU + 6 texture fetches per water pixel.
 * This function is ~90 ALU plus a single inlined sky gradient.
 */
export function oceanSurfaceRadiance(o: OceanSurfaceInputs): N {
  const n = o.normal;
  const v = o.viewDir;
  const eye = v.negate(); // fragment → eye
  const ndv = saturate(dot(n, eye)).max(0.02).toVar();

  // Schlick, with the grazing response capped by roughness. Uncapped Schlick
  // drives rough distant water to a full mirror at the horizon, which reads as
  // a blown white rim; `f90 = 1 − roughness` is the standard fix.
  const f90 = max(float(1).sub(o.roughness), float(WATER_F0));
  const fresnel = float(WATER_F0)
    .add(f90.sub(WATER_F0).mul(pow(float(1).sub(ndv), 5)))
    .toVar();

  // Reflected ray, clamped into the upper hemisphere. Choppy crests routinely
  // tilt the reflection below the horizon; sampling the sky's sub-horizon haze
  // there produces dark speckle, so those rays slide to the horizon ring
  // instead — which is what they would physically hit (distant sea/haze).
  const refl = reflect(v, n) as N; // TSL types collapse reflect() to vec2
  const skyDir = normalize(vec3(refl.x, max(refl.y, float(0.02)), refl.z));
  const sky = o.skyRadiance(skyDir, o.roughness);

  // Sun/moon glint. The analytic sky deliberately drops the sun disc from its
  // env path, so the disc comes back here as a proper GGX lobe — and because
  // `roughness` carries the faded spectral slope variance, the lobe broadens
  // with distance on its own. That IS the glitter path, at no extra cost and
  // with none of the aliasing a screen-space noise fleck has.
  const h = normalize(o.sunDir.sub(v));
  const ndh = saturate(dot(n, h));
  const ndl = saturate(dot(n, o.sunDir));
  const a = max(o.roughness.mul(o.roughness), float(2e-3)).toVar();
  const a2 = a.mul(a).toVar();
  const denom = ndh.mul(ndh).mul(a2.sub(1)).add(1).toVar();
  const ggx = a2.div(float(Math.PI).mul(denom).mul(denom));
  // Punctual specular with a cheap visibility stand-in; clamped because a
  // near-mirror lobe on per-pixel spectral normals otherwise throws single-pixel
  // fireflies that bloom into confetti.
  const glint = clamp(ggx.mul(fresnel).mul(ndl).mul(float(0.25).div(ndv)), 0, 60);
  // Below the horizon the key contributes nothing (and SUN_DIR has already
  // flipped to the moon by then, so this gates both).
  const keyUp = saturate(o.sunDir.y.mul(6));
  // NOTE the sun lobe is deliberately NOT part of `reflected`. `glint` already
  // carries its own Fresnel (line above), and `reflected` gets Fresnel-weighted
  // again by the final mix — folding the lobe in there would apply F twice.
  // F² vs F is ~50x too dark looking straight down (F = F0 = 0.02) and only
  // ~1.2x at grazing, i.e. it silently deletes the near-field glitter.
  const sunLobe = o.sunRadiance.mul(glint.mul(keyUp));
  // Terrain occlusion of the reflection (Tier C). A coast lays a dark band on
  // the water under it; sampling the sky there is why most ocean shaders look
  // like they were rendered on an empty planet. `reflectionBlock` is resolved
  // against a horizon profile rather than a screen-space march, so it is
  // correct for land that is entirely OFF-SCREEN — which, at grazing incidence
  // on a near-flat surface, is most of what a reflection ray actually hits.
  const reflected = (
    o.reflectionBlock && o.blockedRadiance
      ? mix(sky, o.blockedRadiance, o.reflectionBlock(skyDir))
      : sky
  ).mul(o.reflectionGain ?? 1);

  // Transmitted/in-scattered: the water column lit by sky + key. This keeps the
  // authored palette but makes it a RADIANCE, so it darkens at dusk with the
  // sky instead of staying a self-lit turquoise. The gains are calibrated to the
  // illuminance the old lit path delivered, so the body colour underfoot is
  // preserved while the REFLECTION gains its missing ~4×.
  //
  // WRAPPED diffuse, not a flat multiply. In-scattered radiance is NOT isotropic
  // — a facet tilted toward the key scatters more of it back — and looking down
  // at water Fresnel is only ~5%, so the body term is what the eye actually
  // reads across the whole near field. Make it normal-independent and every wave
  // face shades identically: the swell keeps its silhouette but the surface goes
  // glassy-flat, which is exactly what a plain `albedo × illuminant` produces.
  // The wrap (vs a hard N·L) keeps sun-shadowed backs of waves lit, since they
  // still receive the whole sky hemisphere.
  const wrap = float(0.45);
  const diffuseWrap = saturate(dot(n, o.sunDir).add(wrap).div(float(1).add(wrap)));
  const down = o.ambient
    .mul(o.ambientGain ?? 0.3)
    .add(o.sunRadiance.mul(diffuseWrap.mul(o.sunDiffuseGain ?? 0.26)))
    .toVar();
  // Subsurface: folding crests are thin, so the key shines THROUGH them — and
  // only when you are looking into it. `v` is eye→fragment, so dot(v, sunDir) is
  // high exactly when the sun is beyond the wave. This is the "glowing green
  // crest" read, and it is view-dependent by construction rather than a flat
  // emissive add.
  //
  // Built as a pure EXPRESSION, never `inScatter.addAssign(...)`. TSL's assign
  // operators need a current stack, which only exists inside an Fn() body; at
  // material-construction scope three logs "No stack defined for assign
  // operation" and returns the receiver UNMODIFIED, so the term silently
  // vanishes from the emitted WGSL. The `if` here is a build-time JS gate (so
  // the subgraph is dead-stripped when unused), not a shader branch.
  const sss = o.sss
    ? (o.sssColor ?? vec3(0.05, 0.4, 0.32))
        .mul(o.sss)
        .mul(pow(saturate(dot(v, o.sunDir)), 3.0))
        .mul(o.sunRadiance)
        .mul(saturate(o.sunDir.y.mul(4)))
    : vec3(0);
  // Transmitted seabed (Tier B). Composited into the in-scatter lane BEFORE
  // Fresnel, because the bed is only ever seen through the (1 − F) transport —
  // at grazing incidence the surface turns to a mirror and the bed correctly
  // disappears, which is what makes a shoreline read as wet rather than
  // painted. `bedTransmittance` already carries the depth gate, so this is
  // exp(−sigma·pathLength) blended against the water's own in-scatter: the
  // standard Beer-Lambert form, not a depth-keyed colour ramp.
  const column = o.bodyAlbedo.mul(down);
  const body =
    o.bedAlbedo && o.bedTransmittance
      ? mix(column, o.bedAlbedo.mul(down).mul(o.bedGain ?? 1), o.bedTransmittance)
      : column;
  const inScatter = body.add(sss).toVar();

  // Foam sits ON the surface: a rough dielectric raft, so it is lit by the same
  // illuminant, just with a brighter albedo — not a separate emissive white.
  //
  // Aerated foam gets one term more. Unlike `sss` above it is NOT gated on the
  // sun being above the horizon: a plume of whitewater keeps glowing through
  // the minutes either side of sunset, which is exactly the window these
  // beaches are worth filming in. `sunRadiance` fading is what retires it —
  // which is where the twilight term below takes over: once the disc is gone
  // the foam is lit by the horizon band itself (twilightFoamRadiance), with a
  // BROAD forward lobe (the afterglow spans a wide arc, so foam stays readable
  // from every framing, brightest looking into the glow) that the elevation
  // window retires by ~−9.5°. Both build-time gated, so bay water pays nothing.
  const twilightScatter =
    o.foamGlow && o.twilightRadiance && o.twilightDir
      ? o.twilightRadiance
          .mul(o.foamGlow)
          .mul(pow(saturate(dot(v, o.twilightDir)), 1.5).mul(0.65).add(0.35))
      : vec3(0);
  const foamScatter = o.foamGlow
    ? o.sunRadiance
        .mul(o.foamGlow)
        .mul(pow(saturate(dot(v, o.sunDir)), 2.2))
        .mul(0.85)
        .add(twilightScatter)
    : vec3(0);
  const foamLit = o.foamAlbedo.mul(down.mul(o.foamGain ?? 0.95)).add(foamScatter);

  // The prism kite's fan, mirrored in the sea. A fragment shows the beam's
  // reflection exactly when its reflected eye ray passes near the beam
  // segment hanging in the air — so this is a ray/segment closest-approach
  // test against the SAME per-pixel reflected ray the sky uses, which is what
  // breaks the streak into ripple sparkle for free. Color comes from the
  // across-beam offset at the closest point, sampled from the prism's own
  // spectrum ramp so sail, fan, sand and sea read as one piece of light.
  // ~30 ALU, near sheet only, and multiplied out entirely while the strength
  // uniform sits at 0 (all day, everywhere but golden hour at the festival).
  const prismLobe =
    o.prismOrigin && o.prismDir && o.prismAcross && o.prismParams && o.worldPos
      ? (() => {
          const beamLen = o.prismParams.x;
          const halfW = o.prismParams.y;
          const strength = o.prismParams.z;
          const w0 = o.worldPos.sub(o.prismOrigin).toVar();
          const b = dot(skyDir, o.prismDir).toVar();
          const dRay = dot(skyDir, w0);
          const eBeam = dot(o.prismDir, w0);
          const denom = max(float(1).sub(b.mul(b)), 1e-3);
          // Closest approach between ray(P, R) and the beam's segment. The ray
          // parameter is floored just off the surface so a fragment cannot
          // "reflect" a beam sitting behind its own eye ray; the beam
          // parameter is clamped to the lit span (the first metres are inside
          // the sail's comb and never read on water).
          const tRay = b.mul(eBeam).sub(dRay).div(denom).max(0.6);
          const tBeam = clamp(eBeam.sub(b.mul(dRay)).div(denom), 3, beamLen);
          const delta = w0.add(skyDir.mul(tRay)).sub(o.prismDir.mul(tBeam)).toVar();
          const along01 = tBeam.div(beamLen).toVar();
          // The beam widens toward its landing, like the fan it mirrors.
          const width = mix(float(1.2), halfW, along01).toVar();
          const dist = delta.length();
          const envelope = exp(dist.div(width).pow(2).negate());
          const u = clamp(dot(delta, o.prismAcross).div(width), -1, 1).mul(0.5).add(0.5);
          const alongFade = smoothstep(0.04, 0.14, along01).mul(float(1).sub(along01.mul(0.3)));
          // Fresnel-led like any reflection, but with a floor: ripple facets
          // catch grazing micro-angles a per-pixel Schlick undersells, and a
          // rainbow on the water that only exists at the horizon is not worth
          // its ALU.
          return spectrum(u)
            .mul(envelope)
            .mul(alongFade)
            .mul(strength)
            .mul(fresnel.mul(2.4).add(0.16))
            .mul(2.0);
        })()
      : vec3(0);

  // Fresnel mixes the two TRANSPORT lanes; the sun lobe is a specular addition
  // on top (it already carries its own F), and foam covers whatever it covers.
  return mix(mix(inScatter, reflected, fresnel).add(sunLobe).add(prismLobe), foamLit, o.foam);
}

/**
 * Luminance-preserving push of a lit scene sample toward an authored bed
 * colour: keeps the real underwater shading/detail while art-directing the
 * hue (sandy bed under a park lawn, for example).
 */
export function tintTowardBed(sceneColor: N, bedColor: N, amount: N): N {
  const lum = dot(sceneColor, vec3(0.299, 0.587, 0.114));
  const tinted = bedColor.mul(lum.mul(1.35).add(0.22));
  return mix(sceneColor, tinted, amount);
}
