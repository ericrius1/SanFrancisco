// U1 · Velocity — the two-source seam. Build spec: .data/postfx/BRIEF.md §3.4.
//
// The stage owns ONE stable texture node (a `textureSlot`) and rebinds its value
// to whichever source is active. That is what makes `post.velocity.source` a
// STRUCTURAL key rather than a recompile key: flipping it swaps a binding for
// every downstream consumer, never a shader. See index.ts for why that
// distinction is not cosmetic here.
import type * as THREE from "three/webgpu"
import { vec2 } from "three/tsl"
import type { N, PostFrameContext } from "../types"

export type VelocitySourceKind = "reproject" | "mrt"

/** What a source has to provide. Deliberately smaller than PostStage — the
 *  stage owns enabled()/tuning/slot rebinding; a source owns pixels. */
export type VelocitySourceImpl = {
  readonly kind: VelocitySourceKind
  /** The rg16float motion texture, or null before it exists. */
  texture(): THREE.Texture | null
  /** Called only when the stage is enabled and only with no pass open. A source
   *  that rides the beauty pass (mrt) does nothing here. */
  render(frame: PostFrameContext): void
  warmupQuads(): THREE.QuadMesh[]
  dispose(): void
}

/**
 * NDC motion -> the uv offset that lands on the same surface in the PREVIOUS
 * frame's image: `prevUv = uv - motionUv`.
 *
 * The y negate is the whole reason this is a named function instead of an
 * inline `mul(0.5)` at each call site. The buffer is in NDC (y up, because that
 * is `getViewPosition`'s convention — PostProcessingUtils.js:24), while every
 * consumer samples in uv (y down). Getting the sign wrong does not look like a
 * bug: it looks like vertical ghosting that gets WORSE when you tighten the
 * velocity clamp, which reads as a tuning problem and is not one.
 */
export function ndcMotionToUv(motion: N): N {
  return vec2(motion.x, motion.y.negate()).mul(0.5)
}
