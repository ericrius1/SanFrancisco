import * as THREE from "three/webgpu"
import { texture, uniform } from "three/tsl"
import type { N, TextureSlot } from "../types"

const _size = new THREE.Vector2()

/**
 * A `texture()` node whose `.value` the chain rebinds every frame to whatever
 * the last ENABLED upstream stage produced.
 *
 * This is the mechanism that makes a disabled stage cost exactly zero. Swapping
 * a Texture object on a TextureNode updates a BINDING, not a shader: Bindings.js
 * compares `binding.generation` against the texture's and calls
 * `backend.updateBindings()` only when the object actually changed — no codegen,
 * no pipeline creation, no hitch. three does the same thing itself three times
 * per frame inside DepthOfFieldNode (`_CoCTextureNode.value` at :294, :303, :319).
 *
 * The initial texture is required rather than optional on purpose. A placeholder
 * would reach codegen if any stage ever built before its first `bind()`, and the
 * placeholder's filter mode decides the WGSL sampler binding type — a
 * nearest-filtered stand-in for a linear-filtered target is a bind-group
 * mismatch, not a cosmetic difference.
 */
export function createTextureSlot(name: string, initial: THREE.Texture): TextureSlot {
  const node = texture(initial) as N
  node.name = name
  const texelSize = uniform(new THREE.Vector2(1, 1)) as N

  const syncTexelSize = (value: THREE.Texture) => {
    const image = value.image as { width?: number; height?: number } | undefined
    const width = Math.max(1, Math.round(image?.width ?? 1))
    const height = Math.max(1, Math.round(image?.height ?? 1))
    _size.set(1 / width, 1 / height)
    ;(texelSize.value as THREE.Vector2).copy(_size)
  }
  syncTexelSize(initial)

  return {
    node,
    texelSize,
    bind(value: THREE.Texture) {
      if (node.value !== value) node.value = value
      // Kept in sync unconditionally: a RenderTarget keeps texture identity
      // across setSize(), so an identity check would miss every resize.
      syncTexelSize(value)
    }
  }
}
