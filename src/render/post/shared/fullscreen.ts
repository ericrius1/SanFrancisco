import * as THREE from "three/webgpu"
import type { N } from "../types"

/**
 * A chain-owned fullscreen quad: QuadMesh + NodeMaterial + an explicit render.
 *
 * This is deliberately the ONE place in `post/` that touches r185's private
 * fullscreen shape, and it exists so an N-stage chain does not multiply that
 * coupling by N. Stages never construct a QuadMesh themselves; `warmup.ts`
 * collects `mesh` from every stage and hands the union to
 * `compileFullscreenQuads()` in one traversal.
 *
 * `render()` reproduces the contact-shadow complement's discipline verbatim
 * (contactShadows.ts:356-380): reset the renderer's state, draw, restore. Every
 * stage in this chain samples a texture that some other pass writes, and WebGPU
 * rejects the whole command buffer if a render pass both writes and binds the
 * same texture. The chain guarantees no pass is open when a stage renders; this
 * guarantees the stage does not leak target/MRT/clear state into the next one.
 */
export type StageQuad = {
  readonly mesh: THREE.QuadMesh
  readonly material: THREE.NodeMaterial
  /** Assign the fragment graph. Safe to call again; forces a rebuild. */
  setFragment(node: N): void
  /**
   * Draw into `target` (null = the canvas), leaving renderer state as found.
   * `clearColor` is the value discarded pixels keep — white for occlusion
   * factors, black for additive accumulation buffers.
   */
  render(
    renderer: THREE.WebGPURenderer,
    target: THREE.RenderTarget | null,
    clearColor?: number,
    clearAlpha?: number
  ): void
  dispose(): void
}

export function createStageQuad(name: string): StageQuad {
  const material = new THREE.NodeMaterial()
  material.name = name
  const mesh = new THREE.QuadMesh(material)
  mesh.name = name
  // `any` matches contactShadows.ts:227 — RendererUtils.resetRendererState()
  // types its state parameter as required even though the first call seeds it.
  let rendererState: any = undefined

  return {
    mesh,
    material,
    setFragment(node: N) {
      material.fragmentNode = node
      material.needsUpdate = true
    },
    render(renderer, target, clearColor = 0x000000, clearAlpha = 1) {
      rendererState = THREE.RendererUtils.resetRendererState(renderer, rendererState)
      try {
        renderer.setClearColor(clearColor, clearAlpha)
        renderer.setRenderTarget(target)
        mesh.render(renderer)
      } finally {
        THREE.RendererUtils.restoreRendererState(renderer, rendererState)
      }
    },
    dispose() {
      material.dispose()
    }
  }
}
