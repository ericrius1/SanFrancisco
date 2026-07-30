// VENDORED from three/examples/jsm/tsl/utils/SpecularHelpers.js — three r185 (0.185.1).
//
// Microfacet BRDF helpers: bounded-VNDF sampling (Eto & Tokuyoshi 2023, spherical-cap
// form from Dupuy & Benyoub 2023), GTR/GGX distribution, Smith geometry, Schlick
// Fresnel, and the REBLUR specular-dominant-factor used for parallax-corrected ray
// length.
//
// Used ONLY by the SSR fork's stochastic (GGX-scatter) path, which the stage bakes
// out (`stochastic: false`). See ./ssr.ts's header for why that path is preserved
// rather than deleted.
//
// DEVIATIONS FROM UPSTREAM, and why:
//
//  1. The equirectangular environment block is NOT vendored — `ENV_RAY_LENGTH`,
//     `ENV_RAY_LENGTH_THRESHOLD`, `equirectUvToDir`, `equirectDirPdf` and
//     `misPowerHeuristic` (upstream:16-24, :258-325). Every one of them exists to
//     serve `ImportanceSampledEnvironment`, which this fork deliberately does not
//     vendor: it builds CPU-side luminance CDF tables from an equirect HDR with
//     `image.data`, and this project has no such texture — the sky is procedural
//     (world/sky.ts). Without an env map the SSR miss path is black, so the MIS
//     machinery has nothing to weight against.
//  2. `pdf` stays in the returned struct even though only the (dropped) MIS path
//     reads it. Removing a struct member changes the WGSL struct layout for no
//     measurable win, and leaving it keeps this file diffable against upstream.
//  3. TypeScript signatures. Node parameters are `N` (= any), the house convention
//     at every TSL boundary in this repo.
//
// The maths is upstream's, unchanged — including the analytically-cancelled
// importance weight in `ggxReflectionSample`, whose comment is worth keeping:
// evaluating D explicitly is catastrophic at low roughness.
import * as TSL from "three/tsl"
import type { N } from "../../types"

// See ./boxBlur.ts for why the TSL namespace is taken loose in one place.
const { Fn, If, PI, clamp, cos, cross, dot, float, log, max, mix, normalize, pow, reflect, sin, sqrt, struct, vec3 } =
  TSL as unknown as Record<string, N>

// Bounded-VNDF sampler. alpha ∈ [0,1] here, so the sign term in `s` is always +1
// and is dropped.
const SampleGGXVNDF = /*#__PURE__*/ Fn(([V, ax, ay, r1, r2]: N[]): N => {
  // Warp the view direction to the hemisphere ("standard") configuration.
  const wiStd = normalize(vec3(ax.mul(V.x), ay.mul(V.y), V.z)).toVar()

  // Isotropic bound on the spherical cap (Eto & Tokuyoshi eq. 5).
  const a = ax.min(ay).toVar()
  const s = float(1.0).add(V.xy.length()).toVar()
  const a2 = a.mul(a).toVar()
  const s2 = s.mul(s).toVar()
  const k = a2
    .oneMinus()
    .mul(s2)
    .div(s2.add(a2.mul(V.z).mul(V.z)))
    .toVar()

  // Tighten the cap with the bound (upper hemisphere; N·V ≥ 0 in our usage).
  const b = wiStd.z.mul(k).toVar()

  // Sample the (bounded) spherical cap.
  const phi = float(6.283185307179586).mul(r1).toVar()
  const z = r2
    .oneMinus()
    .mul(float(1.0).add(b))
    .sub(b)
    .toVar()
  const sinTheta = sqrt(max(float(0.0), float(1.0).sub(z.mul(z)))).toVar()
  const c = vec3(sinTheta.mul(cos(phi)), sinTheta.mul(sin(phi)), z).toVar()

  // Microfacet normal in the standard config, then warp back to the ellipsoid.
  const wmStd = c.add(wiStd).toVar()
  return normalize(
    vec3(ax.mul(wmStd.x), ay.mul(wmStd.y), max(float(0.0), wmStd.z))
  ).toVar()
}).setLayout({
  name: "SampleGGXVNDF",
  type: "vec3",
  inputs: [
    { name: "V", type: "vec3" },
    { name: "ax", type: "float" },
    { name: "ay", type: "float" },
    { name: "r1", type: "float" },
    { name: "r2", type: "float" }
  ]
})

// Generalized Trowbridge-Reitz. For GGX set k=2. `roughness` is α, not α².
export const D_GTR = /*#__PURE__*/ Fn(([roughness, NoH, k]: N[]): N => {
  const a2 = roughness.mul(roughness).toVar()
  const NoH2 = NoH.mul(NoH).toVar()
  const base = NoH2.mul(a2.sub(float(1.0))).add(float(1.0)).toVar()
  return a2.div(PI.mul(pow(base, k))).toVar()
})

// Smith G1 (Heitz): expects alpha (not squared); it squares internally.
export const SmithG = /*#__PURE__*/ Fn(([NDotX, alpha]: N[]): N => {
  const a2 = alpha.mul(alpha).toVar()
  const NDotX2 = NDotX.mul(NDotX).toVar()
  return float(2.0)
    .mul(NDotX)
    .div(NDotX.add(sqrt(a2.add(a2.oneMinus().mul(NDotX2)))))
})

// G = G1(N·L, α_G) * G1(N·V, α_G). α_G is NOT squared here.
export const GeometryTerm = /*#__PURE__*/ Fn(([NoL, NoV, alphaG]: N[]): N => {
  const G1v = SmithG(NoV, alphaG).toVar()
  const G1l = SmithG(NoL, alphaG).toVar()
  return G1v.mul(G1l).toVar()
})

// Bounded VNDF direction PDF matching SampleGGXVNDF (Eto & Tokuyoshi eq. 8).
const GGXVNDFPdf = /*#__PURE__*/ Fn(([NoH, NoV, roughness]: N[]): N => {
  const D = D_GTR(roughness, NoH, float(2.0)).toVar()
  const a2 = roughness.mul(roughness).toVar()
  const sinV2 = max(float(0.0), float(1.0).sub(NoV.mul(NoV))).toVar()
  const s = float(1.0).add(sqrt(sinV2)).toVar()
  const s2 = s.mul(s).toVar()
  const k = float(1.0)
    .sub(a2)
    .mul(s2)
    .div(s2.add(a2.mul(NoV).mul(NoV)))
    .toVar()
  const t = sqrt(a2.mul(sinV2).add(NoV.mul(NoV))).toVar()
  return D.div(max(float(1e-6), float(2.0).mul(k.mul(NoV).add(t)))).toVar()
})

/** Fresnel reflectance, Schlick approximation. */
export const F_Schlick = /*#__PURE__*/ Fn(([f0, theta]: N[]): N => {
  const oneMinus = float(1.0).sub(theta).toVar()
  const oneMinus2 = oneMinus.mul(oneMinus).toVar()
  const oneMinus5 = oneMinus2.mul(oneMinus2).mul(oneMinus).toVar()
  return f0.add(vec3(1.0).sub(f0).mul(oneMinus5)).toVar()
})

/**
 * Specular dominant factor for parallax-corrected ray length.
 * From REBLUR: A Hierarchical Recurrent Denoiser (NRD).
 */
export const getSpecularDominantFactor = /*#__PURE__*/ Fn(([NoV, roughness]: N[]): N => {
  const a = float(0.298475).mul(log(float(39.4115).sub(float(39.0029).mul(roughness))))
  const f = float(1.0)
    .sub(NoV)
    .pow(10.8649)
    .mul(float(1.0).sub(a))
    .add(a)
  return clamp(f)
}).setLayout({
  name: "getSpecularDominantFactor",
  type: "float",
  inputs: [
    { name: "NoV", type: "float" },
    { name: "roughness", type: "float" }
  ]
})

/**
 * Everything a single GGX reflection sample produces. `reflectDir` and
 * `sampleWeight` drive the ray-march and compositing; the rest are the GGX terms
 * upstream's env-miss MIS fallback needed (see deviation 2 in the header).
 */
const ggxReflectionStruct = /*#__PURE__*/ struct({
  reflectDir: "vec3",
  sampleWeight: "vec3",
  pdf: "float",
  NdotV: "float",
  alpha: "float",
  f0: "vec3"
})

/**
 * Importance-samples the GGX/VNDF specular lobe for one pixel.
 *
 * @param N - view-space shading normal (normalized)
 * @param V - view-space surface→camera direction (normalized)
 * @param roughness - perceptual roughness in [0,1]
 * @param metalness - metalness in [0,1]; tints `f0` toward `albedo`
 * @param albedo - surface base colour
 * @param Xi - per-pixel random numbers; only `.xy` are used
 */
export const ggxReflectionSample = /*#__PURE__*/ Fn(
  ([Nv, V, roughness, metalness, albedo, Xi]: N[]): N => {
    // GGX alpha (r², clamped away from degenerate).
    const a = roughness.mul(roughness).max(0.001).toVar()
    const ax = a.toVar()
    const ay = a.toVar()

    // TBN from the view-space normal.
    const up = vec3(0, 0, 1)
    let T = cross(up, Nv).toVar()
    T = T.normalize().toVar()
    If(T.length().lessThan(1e-3), () => {
      T.assign(cross(vec3(0, 1, 0), Nv).normalize())
    })
    const B = cross(Nv, T).normalize().toVar()

    // V into the LOCAL frame (N = +Z).
    const Vlocal = vec3(dot(T, V), dot(B, V), dot(Nv, V)).toVar()

    const Hlocal = SampleGGXVNDF(Vlocal, ax, ay, Xi.x, Xi.y).toVar()
    If(Hlocal.z.lessThan(0), () => {
      Hlocal.assign(Hlocal.negate())
    })

    // H back to VIEW space.
    const h = normalize(T.mul(Hlocal.x).add(B.mul(Hlocal.y)).add(Nv.mul(Hlocal.z))).toVar()

    const viewReflectDir = reflect(V.negate(), h).normalize().toVar()

    const L = viewReflectDir.toVar()
    const H = normalize(V.add(L)).toVar() // ~h; recomputed for robustness

    const NdotV = max(float(0.0), dot(Nv, V)).toVar()
    const NdotL = max(float(0.0), dot(Nv, L)).toVar()
    const NdotH = max(float(0.0), dot(Nv, H)).toVar()
    const VdotH = max(float(0.0), dot(V, H)).toVar()

    const f0 = mix(vec3(0.04), albedo, metalness).toVar()
    // Chromatic Fresnel: for metals f0 = albedo, so the reflection is tinted and
    // desaturates toward white at grazing angles.
    const fresnelWeight = F_Schlick(f0, VdotH).toVar()

    const pdf = GGXVNDFPdf(NdotH, NdotV, ax).toVar()

    // Numerically stable importance weight: brdf·NdotL/pdf ≡
    // fresnel·G2·(k·NdotV + t)/(2·NdotV), which cancels the GGX D analytically.
    // Evaluating D explicitly is catastrophic at low roughness (D → 3e5 at
    // α = 0.001 wrecks f32 precision); the cancelled form stays stable down to a
    // mirror — which is exactly the regime a wet street lives in.
    const a2 = ax.mul(ax).toVar()
    const sinV2 = NdotV.mul(NdotV).oneMinus().max(0.0).toVar()
    const sB = float(1.0).add(sqrt(sinV2)).toVar()
    const s2B = sB.mul(sB).toVar()
    const kB = a2
      .oneMinus()
      .mul(s2B)
      .div(s2B.add(a2.mul(NdotV).mul(NdotV)))
      .toVar()
    const tB = sqrt(a2.mul(sinV2).add(NdotV.mul(NdotV))).toVar()
    const glossyWeight = fresnelWeight
      .mul(GeometryTerm(NdotL, NdotV, ax))
      .mul(kB.mul(NdotV).add(tB))
      .div(float(2.0).mul(NdotV).max(1e-4))
      .toVar()

    return ggxReflectionStruct(viewReflectDir, glossyWeight, pdf, NdotV, ax, f0)
  }
)
