import type * as THREE from "three/webgpu"
import { Vector2, Vector3 } from "three/webgpu"
import {
  If,
  getViewPosition,
  luminance,
  mix,
  smoothstep,
  uniform,
  vec3
} from "three/tsl"
import type { N } from "../types"

/**
 * SURVIVOR. Carried over from postfx.ts:148-204, :341-390 — the math is
 * verbatim, and so is the reasoning, because both are measured.
 *
 * Per-channel Beer-Lambert fog plus 16 radial god-ray taps toward the refracted
 * sun, in linear light before the display transform. All uniforms default to the
 * exact "dry" identity, and `uwSubmersion` doubles as the uniform branch
 * condition that skips the whole package's taps while the camera is above the
 * surface — so dry frames pay nothing.
 *
 * ONE change from postfx.ts, and it is a latent bug fix rather than a
 * refactor: **depth is now bound explicitly**. It used to be reached by a
 * private traversal — `(sceneTex as {passNode?}).passNode?.getTextureNode?.("depth")`
 * (postfx.ts:278-280) — guarded by a build-time `if (uwDepthTex)`, so the entire
 * package vanished with NO error whenever `sceneTex` was anything but a
 * PassTextureNode. The bloomed family already fed an `rtt` through
 * `getWithSceneTexture` (old pipeline.ts:276), so the shipping build may already
 * have been losing underwater fog whenever bloom was on.
 *
 * Behaviour change to verify against a submerged before/after: the god rays now
 * run BEFORE bloom rather than after. They used to sample the bloomed image
 * incidentally, because bloom was injected at the source texture; now they are
 * computed on the raw beauty and bloom smears them. That is an improvement
 * (bright rays bloom) but it is visible.
 */
const U = {
  // Underwater package (fx/underwaterRig.ts drives these per frame). All of
  // them default to the exact "dry" identity, and uwSubmersion doubles as the
  // uniform branch condition that skips the whole package's taps while the
  // camera is above the surface — so dry frames pay nothing and submerging
  // still never selects a different pipeline.
  uwSubmersion: uniform(0),
  uwSigma: uniform(new Vector3(0.38, 0.085, 0.05)), // per-channel extinction /m
  uwSigmaScale: uniform(1), // artist "visibility" scalar over sigma
  uwScatterAmbient: uniform(new Vector3(0, 0, 0)), // linear, pre-scaled CPU-side
  uwSunScatter: uniform(new Vector3(0, 0, 0)), // sun-forward in-scatter colour
  uwSunViewDir: uniform(new Vector3(0, 0, 1)), // view-space dir toward refracted sun
  uwSunScreen: uniform(new Vector2(0.5, 0.35)), // refracted sun anchor in screen UV
  uwRayAmount: uniform(0), // god-ray gain (0 = exact identity)
  /**
   * `post.composite.underwater`, a DEBUG kill switch — gameplay drives the
   * uniforms above and never touches this. It multiplies the branch condition
   * rather than gating the block at build time, because the composite is enabled
   * by default and `StageTuning.recompileKeys` must stay empty for such a stage
   * (types.ts:125-128). At 1 it is the exact identity; at 0 the package is
   * skipped by the same uniform branch that already skips it on dry land, so
   * turning it off is free rather than a second pipeline.
   */
  uwEnable: uniform(1)
}

/** Debug only. See `uwEnable`. */
export function setUnderwaterEnabled(enabled: boolean): void {
  U.uwEnable.value = enabled ? 1 : 0
}

/**
 * Per-frame underwater driver contract. The vectors are copied, never
 * retained. Everything here is a live uniform — no pipeline reselection.
 *
 * Signature unchanged from postfx.ts:187; fx/underwaterRig.ts:2, 74, 192 is
 * untouched by the rebuild.
 */
export function setUnderwaterPostFx(s: {
  submersion: number
  sigmaScale: number
  scatterAmbient: THREE.Vector3
  sunScatter: THREE.Vector3
  sunViewDir: THREE.Vector3
  sunScreenX: number
  sunScreenY: number
  rayAmount: number
}) {
  U.uwSubmersion.value = Math.min(1, Math.max(0, s.submersion))
  U.uwSigmaScale.value = Math.max(0.05, s.sigmaScale)
  ;(U.uwScatterAmbient.value as THREE.Vector3).copy(s.scatterAmbient)
  ;(U.uwSunScatter.value as THREE.Vector3).copy(s.sunScatter)
  ;(U.uwSunViewDir.value as THREE.Vector3).copy(s.sunViewDir)
  ;(U.uwSunScreen.value as THREE.Vector2).set(s.sunScreenX, s.sunScreenY)
  U.uwRayAmount.value = Math.max(0, s.rayAmount)
}

/**
 * Fold the package into an already-`toVar()`'d linear colour.
 *
 * @param linUw a colour VAR (the caller owns it; this reassigns it in place)
 * @param uv the composite's single UV — see (c) in BRIEF §4.4: the surf lens
 *   moved to the display tail, so the old `uv` vs `sampleUv` distinction that
 *   postfx.ts:339 had to navigate is simply gone.
 * @param sourceTexture the beauty colour, tapped 16 times for the rays
 * @param depthTexture gbuffer.depth — full-res beauty depth, bound explicitly
 * @param projectionInverse uniform(camera.projectionMatrixInverse), an object
 *   reference that re-uploads every frame, so it tracks the TAA jitter
 */
export function applyUnderwater(deps: {
  linUw: N
  uv: N
  sourceTexture: N
  depthTexture: N
  projectionInverse: N
}): void {
  const { linUw, uv, sourceTexture, depthTexture, projectionInverse } = deps

  // ---- underwater package: per-channel Beer-Lambert fog + refracted-sun
  // god rays, in linear light before tone mapping. The whole package (one
  // full-res depth tap + 16 radial scene taps + ~220 ALU) sits behind a
  // UNIFORM branch instead of running dry. The condition is a uniform-buffer
  // read, so the branch is uniform for the entire draw: the GPU skips the
  // block outright rather than masking it, and textureSample inside uniform
  // control flow is legal WGSL. PERF_LEVELUP.md:296 measures the win —
  // 19 full-res fetches down to 2 on dry land.
  //
  // The skip is bit-identical to the old branchless form: underwaterRig
  // drives rayAmount as `ease * …`, so submersion === 0 implies rayAmount
  // === 0, and latchDry() zeroes both. At submersion 0 the fog mixed by
  // exactly 0 and the rays added exactly 0.
  If(U.uwSubmersion.mul(U.uwEnable).greaterThan(0), () => {
    const uwViewPos = getViewPosition(uv, depthTexture.sample(uv).r, projectionInverse)
    // Camera is submerged, so water starts at the near plane: the fog path
    // is simply the per-pixel view distance. Clamp for sky/far pixels —
    // transmittance is already ~0 well before 240 m of water.
    const uwDist = uwViewPos.length().min(240.0)
    const uwSigma = U.uwSigma.mul(U.uwSigmaScale)
    const uwTrans = uwDist.negate().mul(uwSigma).exp()
    const uwViewDir = uwViewPos.normalize()
    // In-scatter: ambient term (depth-graded on the CPU) plus a forward
    // lobe toward the refracted sun for that silty light-in-water glow.
    const uwSunAlign = uwViewDir.dot(U.uwSunViewDir).max(0.0)
    const uwScatter = U.uwScatterAmbient.add(U.uwSunScatter.mul(uwSunAlign.pow(6.0)))
    const uwFogged = linUw.mul(uwTrans).add(uwScatter.mul(uwTrans.oneMinus()))
    linUw.assign(mix(linUw, uwFogged, U.uwSubmersion))

    // God rays: 16 fixed radial taps of the bright scene toward the
    // refracted sun's screen anchor. Weights decay away from the pixel;
    // the luminance gate keeps only genuinely bright sources (sun disc,
    // bright surface shimmer) so the veil doesn't lift the whole frame.
    const uwRayStep = U.uwSunScreen.sub(uv).mul(U.uwSubmersion.mul(0.052))
    let uwRays: N = vec3(0)
    let uwWeightSum = 0
    for (let i = 1; i <= 16; i++) {
      const w = Math.pow(0.86, i)
      uwWeightSum += w
      const s = sourceTexture.sample(uv.add(uwRayStep.mul(i))).rgb
      uwRays = uwRays.add(s.mul(smoothstep(0.3, 1.1, luminance(s))).mul(w))
    }
    linUw.addAssign(uwRays.mul(U.uwRayAmount.div(uwWeightSum)).mul(vec3(0.5, 0.82, 1.0)))
  })
}
