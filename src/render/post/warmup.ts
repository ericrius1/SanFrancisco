import type * as THREE from "three/webgpu"
import type { PostChainInternals } from "./chain"

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

/** `compileGate.compileFullscreenQuads`, passed in so post/ never imports it. */
export type FullscreenQuadCompiler = (quads: THREE.QuadMesh[]) => Promise<void>

/**
 * Warm the chain's fullscreen pipelines AGAINST THE FORMAT EACH ONE DRAWS INTO.
 *
 * This replaces `compileFullscreenQuads(chain.warmupQuads())`, which compiled
 * every quad with no render target bound. That does not produce the pipeline the
 * chain runs: the WebGPU pipeline cache key includes the render context's colour
 * and depth/stencil formats (WebGPUBackend.js:2125-2140), and with no target
 * bound those resolve to the canvas's bgra8unorm + depth32float rather than the
 * chain's rgba16float / rg16float / r16float with no depth buffer.
 * `chain.warmupGroups()` carries the full derivation, the source lines, and — the
 * part worth knowing before judging the severity — what the mismatch did and did
 * not cost: the WGSL and the shader module were shared and genuinely warm; the
 * GPURenderPipeline was not.
 *
 * The bound target is captured and restored here rather than left to the
 * compiler: `compileFullscreenQuads` restores whatever was bound when IT was
 * called, which from the second group on is this function's own choice. Leaving
 * a chain target bound would be silent and lethal — the display tail draws into
 * "whatever the caller bound", so the next presented frame would land in an
 * offscreen texture instead of the canvas.
 *
 * Groups are compiled one at a time, each inside its own exclusive compile
 * window, so the stillness gate still gets to camouflage them individually
 * rather than holding frames for the whole chain at once.
 *
 * BINDING THE TARGET IS ONLY HALF THE KEY, and the other half has to be forced
 * from out here. `Renderer.compile()` populates `renderContext.textures` from
 * the bound target (Renderer.js:986-993), which is what fixes the colour
 * format — but it sets `renderContext.depth = this.depth` /
 * `renderContext.stencil = this.stencil` from the RENDERER (Renderer.js:931-932)
 * and never re-derives them from the target, while `render()` does exactly that
 * (`renderContext.depth = renderTarget.depthBuffer`, Renderer.js:1698). The app
 * builds its renderer with depth on (app/renderCore.ts:48-51 passes no `depth`,
 * so it defaults true), so a chain target with `depthBuffer: false` compiles
 * against depth32float and renders against no depth attachment at all
 * (WebGPUUtils.js:44-82 returns undefined once `renderContext.depth` is false).
 * The cache key is a joined string — one differing component is a full miss —
 * so fixing the colour half alone would have bought nothing.
 *
 * Mirroring render()'s own rule is therefore part of the fix, not a refinement
 * of it: the target's `depthBuffer`/`stencilBuffer` while a target is bound, the
 * renderer's own flags for the display tail, which presents to the canvas and
 * whose runtime context reads `this.depth` too (Renderer.js:1707).
 */
export async function warmChainQuads(
  renderer: THREE.WebGPURenderer,
  chain: PostChainInternals,
  compile: FullscreenQuadCompiler
): Promise<void> {
  const previousTarget = renderer.getRenderTarget()
  const previousCubeFace = renderer.getActiveCubeFace()
  const previousMipmapLevel = renderer.getActiveMipmapLevel()
  const previousDepth = renderer.depth
  const previousStencil = renderer.stencil
  try {
    for (const group of chain.warmupGroups()) {
      if (group.quads.length === 0) continue
      renderer.setRenderTarget(group.target)
      // null = the canvas: leave the renderer's own flags alone, because that is
      // what the runtime context will read for the tail as well.
      renderer.depth = group.target ? group.target.depthBuffer : previousDepth
      renderer.stencil = group.target ? group.target.stencilBuffer : previousStencil
      await compile(group.quads)
    }
  } finally {
    renderer.depth = previousDepth
    renderer.stencil = previousStencil
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel)
  }
}
