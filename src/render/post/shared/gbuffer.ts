import type * as THREE from "three/webgpu"
import {
  getViewPosition,
  mrt,
  normalView,
  packNormalToRGB,
  unpackRGBToNormal,
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
