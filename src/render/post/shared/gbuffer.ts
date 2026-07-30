import type * as THREE from "three/webgpu"
import {
  Fn,
  getViewPosition,
  mrt,
  normalView,
  packNormalToRGB,
  positionPrevious,
  unpackRGBToNormal,
  vec3,
  vec4,
  float
} from "three/tsl"
import type { N, PostGBuffer } from "../types"

/**
 * The beauty pass's second colour attachment: `rgb = packNormalToRGB(normalView)`,
 * `a = SSR reflectivity mask`. RGBA8 (see pipeline.ts for the `getTexture()`
 * call that actually allocates it).
 *
 * `normalView`, not `normalViewGeometry`. The deleted half-res outline prepass
 * used geometry normals deliberately (old pipeline.ts:113-117) because sampling
 * material normals THERE meant re-running every material's `normalNode` chain —
 * the facade brick-bump fractal — a second time over the frame, purely to feed
 * edge detection that did not need material-scale bumps. In the BEAUTY pass that
 * chain is already being evaluated for shading, so writing it to a second
 * attachment costs the write, not the evaluation. SSAO and SSR therefore get
 * normal-mapped normals for free, which the prepass could never have afforded.
 */
export const SSR_MASK_DEFAULT: N = float(0)

/** The MRT the beauty pass publishes, alongside three's `output` accessor. */
export function beautyGBufferAttachment(): N {
  return vec4(packNormalToRGB(normalView), SSR_MASK_DEFAULT)
}

/**
 * Opt a material into screen-space reflections. `amount` is 0..1 reflectivity;
 * it may be any TSL node, so wetness can be spatial and animated.
 * Materials that never call this write 0 and SSR skips them entirely — which
 * is the whole reason the stage is nearly free on a dry afternoon.
 *
 * `NodeMaterial.js:558-580` merges `material.mrtNode` over the pass MRT, so this
 * replaces the whole gbuffer attachment for that material — the normal term has
 * to be restated here, not just the alpha.
 */
export function writeSsrMask(material: THREE.NodeMaterial, amount: N): void {
  ;(material as THREE.NodeMaterial & { mrtNode: N }).mrtNode = mrt({
    gbuffer: vec4(packNormalToRGB(normalView), amount)
  })
}

/**
 * Adopt true per-object velocity for ONE family of displaced geometry, in one
 * line at the family's `positionNode`.
 *
 * `displace(previous)` returns the family's local position; the flag says which
 * frame to evaluate it for. A family that is displaced by time reads a
 * `uPrevTime` uniform when the flag is set and nothing else changes; a family
 * whose displacement is static (the terrain clipmap, terrainClipmap.ts:658)
 * ignores the flag entirely and is exact immediately.
 *
 * Two things this buys that fifty hand-rolled copies would not:
 *
 *  - **It costs nothing when velocity is off.** `builder.needsPreviousData()`
 *    (NodeBuilder.js:3449) is a JS boolean read at CODEGEN time — it checks
 *    whether the renderer's MRT has a `velocity` output — so with the default
 *    reprojection source the second evaluation is not merely branch-predicted
 *    away, it is never emitted. This is a compile-time `if`, deliberately not a
 *    TSL `If()`; a family's displacement is usually noise, and noise inside an
 *    `If()` is non-uniform control flow.
 *  - **It is the only correct place to write `positionPrevious`.** That varying
 *    is written by exactly three files in all of three (Skinning.js:166/:233,
 *    Instance.js:228) and by NOTHING in Batch.js, which is BRIEF §3.4's second
 *    disqualifying reason for MRT velocity. A family that overrides
 *    `positionNode` and does not do this reports the velocity of its
 *    UNDISPLACED local coordinates — a confident, plausible, wrong number.
 *
 * Do NOT key a previous placement off `instanceIndex`: gpuIndirect.ts:208,:214
 * resolves instances through `visibleIndices.element(instanceIndex)` and the
 * compaction order changes every frame, so `instanceIndex` does not identify the
 * same blade or tree across frames. Placement is a pure function of `trueIndex`
 * plus static attributes — evaluate the previous placement from a time uniform
 * and no cross-frame index mapping is needed.
 */
export function withPreviousPosition(displace: (previous: boolean) => N): N {
  // `any` at the node boundary, as every render module in this repo does:
  // NodeBuilder's published typings do not surface `needsPreviousData()`.
  return Fn((_args: N[], builder: N) => {
    const current = vec3(displace(false)).toVar()
    if (builder.needsPreviousData() === true) {
      positionPrevious.assign(vec3(displace(true)))
    }
    return current
  })()
}

/**
 * Decoders over the packed attachment. Format-agnostic on purpose: the one-line
 * escape hatch for normal banding (8-bit packing is ~1.4° of quantisation) is to
 * flip `getTexture("gbuffer").type` to HalfFloatType in pipeline.ts and change
 * nothing here. Do not do that speculatively — measure first, it doubles the
 * attachment to 8 B/px.
 */
export function createGBufferDecoders(deps: {
  gbufferNode: N
  depthNode: N
  projectionInverse: N
}) {
  const { gbufferNode, depthNode, projectionInverse } = deps
  return {
    normalViewAt: (uv: N): N => unpackRGBToNormal(gbufferNode.sample(uv).rgb).normalize(),
    reflectivityAt: (uv: N): N => gbufferNode.sample(uv).a,
    // Reversed-Z safe as written — see shared/reversedDepth.ts. No oneMinus().
    viewPositionAt: (uv: N): N =>
      getViewPosition(uv, depthNode.sample(uv).r, projectionInverse)
  } satisfies Pick<PostGBuffer, "normalViewAt" | "reflectivityAt" | "viewPositionAt">
}
