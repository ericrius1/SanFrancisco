import type * as THREE from "three/webgpu"
import type { PostChain } from "./types"

/**
 * ONE adapter, not one per stage folder.
 *
 * `compilePostFxVariants(masks)` is gone. Its replacement is "compile every
 * stage's quad once, unconditionally, at boot scope" — strictly cheaper than the
 * eight combinatorial mega-shaders it replaces, and it removes the boot/full
 * scope distinction for post-FX entirely. After boot, no toggle can create a new
 * pipeline, so `warmupPostFx` and the debug panel's warm-on-folder-expand are
 * both deleted rather than ported.
 *
 * The reason this collection point exists at all rather than each stage
 * compiling itself: `compileFullscreenQuads` (render/compileGate.ts) reaches into
 * r185 privates because `RenderPipeline` has no public compile method, and it
 * must match `RenderPipeline.render()`'s cache key exactly (NoToneMapping,
 * working colour space, xr disabled). An N-stage chain must not multiply that
 * private-shape coupling by N.
 */
export function collectChainQuads(chain: PostChain): THREE.QuadMesh[] {
  return chain.warmupQuads()
}
