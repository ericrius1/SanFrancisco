import type * as THREE from "three/webgpu"

/**
 * Scene-layer taxonomy shared by beauty and shadow-only render paths.
 *
 * Beauty cameras continue to render layer 0. Shadow cameras opt into one or
 * more dedicated layers so expensive casters can be selected per domain.
 */
export const SHADOW_LAYERS = {
  BEAUTY: 0,
  HERO_DYNAMIC: 10,
  LOCAL_STATIC: 11,
  FAR_PROXY: 12
} as const

export type ShadowLayer =
  | typeof SHADOW_LAYERS.HERO_DYNAMIC
  | typeof SHADOW_LAYERS.LOCAL_STATIC
  | typeof SHADOW_LAYERS.FAR_PROXY

export const SHADOW_LAYER_MASKS = {
  BEAUTY: 1 << SHADOW_LAYERS.BEAUTY,
  HERO_DYNAMIC: 1 << SHADOW_LAYERS.HERO_DYNAMIC,
  LOCAL_STATIC: 1 << SHADOW_LAYERS.LOCAL_STATIC,
  FAR_PROXY: 1 << SHADOW_LAYERS.FAR_PROXY
} as const

/** Add a shadow-domain bit without disturbing layer 0 or any other membership. */
export function enableShadowLayer<T extends THREE.Object3D>(object: T, layer: ShadowLayer): T {
  object.layers.enable(layer)
  return object
}

/** Add only the cached close-static domain while preserving beauty layers. */
export function enableLocalShadowLayer<T extends THREE.Object3D>(object: T): T {
  object.layers.enable(SHADOW_LAYERS.LOCAL_STATIC)
  return object
}

/** Add both cached static domains while preserving beauty/interaction layers. */
export function enableLocalFarShadowLayers<T extends THREE.Object3D>(object: T): T {
  object.layers.enable(SHADOW_LAYERS.LOCAL_STATIC)
  object.layers.enable(SHADOW_LAYERS.FAR_PROXY)
  return object
}

/** Remove beauty visibility and leave the object in exactly one shadow domain. */
export function setShadowOnlyLayer<T extends THREE.Object3D>(object: T, layer: ShadowLayer): T {
  object.layers.disableAll()
  object.layers.enable(layer)
  return object
}

/** Configure static massing that contributes to both local and far shadow maps. */
export function setLocalFarShadowOnly<T extends THREE.Object3D>(object: T): T {
  object.layers.disableAll()
  object.layers.enable(SHADOW_LAYERS.LOCAL_STATIC)
  object.layers.enable(SHADOW_LAYERS.FAR_PROXY)
  return object
}
