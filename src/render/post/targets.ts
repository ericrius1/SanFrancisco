import * as THREE from "three/webgpu"
import type { TargetSpec } from "./types"

/**
 * The chain owns every intermediate render target. A stage asks for one at
 * setup, names its resolution class, and never thinks about size again — the
 * chain resizes the whole pool whenever the drawing buffer or the temporal
 * input scale moves, and disposes it on teardown.
 *
 * Two policies live here rather than in each stage:
 *
 *  - **Format default is rgba16float.** Everything before `grade.toDisplay` is
 *    scene-linear HDR, and the bloom threshold (2.2) is measured in PRE-exposure
 *    linear. An 8-bit intermediate anywhere in that stretch quantises the exact
 *    values the look is tuned against — the old FXAA detour (pipeline.ts:481-498)
 *    was RGBA8 sRGB precisely because it sat AFTER the seam, and that is the only
 *    place an 8-bit intermediate is defensible.
 *  - **No depth buffer, no stencil, no mipmaps.** Every stage in this chain is a
 *    fullscreen quad reading somebody else's depth. A target that carried its own
 *    depth attachment would be one more texture WebGPU could catch us binding and
 *    writing in the same pass.
 */
export type ChainTargets = {
  /** Allocate (or return the existing) target for `spec`. Sized on first resize. */
  alloc(spec: TargetSpec): THREE.RenderTarget
  /** Resize the whole pool. Returns true when anything actually changed. */
  resize(input: { width: number; height: number }, output: { width: number; height: number }): boolean
  dispose(): void
}

type PooledTarget = {
  readonly spec: TargetSpec
  readonly target: THREE.RenderTarget
}

export function createChainTargets(): ChainTargets {
  const pool: PooledTarget[] = []
  let inputWidth = 1
  let inputHeight = 1
  let outputWidth = 1
  let outputHeight = 1

  const sizeFor = (spec: TargetSpec) => {
    const scale = spec.scale ?? 1
    const width = spec.resolution === "input" ? inputWidth : outputWidth
    const height = spec.resolution === "input" ? inputHeight : outputHeight
    // `minEdge`, not a bare 1. A target carrying a pre-declared mip chain is a
    // WebGPU validation FAILURE below its floor rather than a degrade, and this
    // pool is the only sizing path taken while the owning stage is disabled —
    // see TargetSpec.minEdge. Defaults to 1, so every other target is unchanged.
    const floor = Math.max(1, Math.round(spec.minEdge ?? 1))
    return {
      width: Math.max(floor, Math.round(width * scale)),
      height: Math.max(floor, Math.round(height * scale))
    }
  }

  return {
    alloc(spec) {
      const existing = pool.find((entry) => entry.spec.name === spec.name)
      if (existing) return existing.target

      const size = sizeFor(spec)
      const target = new THREE.RenderTarget(size.width, size.height, {
        format: spec.format ?? THREE.RGBAFormat,
        type: spec.type ?? THREE.HalfFloatType,
        colorSpace: spec.colorSpace ?? THREE.NoColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        count: spec.count ?? 1
      })
      // Underscores only. Some codegen paths emit this name verbatim as a WGSL
      // identifier and a dot is a parse error (pianoGodRays.ts:112-118).
      target.texture.name = spec.name
      for (let i = 1; i < target.textures.length; i++) {
        target.textures[i].name = `${spec.name}_${i}`
      }
      pool.push({ spec, target })
      return target
    },

    resize(input, output) {
      if (
        input.width === inputWidth &&
        input.height === inputHeight &&
        output.width === outputWidth &&
        output.height === outputHeight
      ) {
        return false
      }
      inputWidth = input.width
      inputHeight = input.height
      outputWidth = output.width
      outputHeight = output.height
      for (const entry of pool) {
        const size = sizeFor(entry.spec)
        if (entry.target.width === size.width && entry.target.height === size.height) continue
        entry.target.setSize(size.width, size.height)
      }
      return true
    },

    dispose() {
      for (const entry of pool) entry.target.dispose()
      pool.length = 0
    }
  }
}
