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
  FAR_PROXY: 12,
  /**
   * Beauty-only markers: the render camera sees them, no shadow or prepass
   * camera should. Occlusion-gate query proxies, hashed flower rings, steam and
   * glow sprites, godray curtains. Nothing on this layer casts a shadow, and
   * keeping it off layer 0 also keeps it out of the ink/outline prepass.
   */
  BEAUTY_ONLY: 31,
  /**
   * Reserved; never assigned to an object. `ShadowNode.updateShadow` treats any
   * shadow-camera mask that selects nothing but layer 0 as "unconfigured" and
   * overwrites it with the render camera's mask — which carries BEAUTY_ONLY.
   * Including this bit makes a deliberate beauty-world mask stick.
   */
  SHADOW_CAMERA_PIN: 30
} as const

export type ShadowLayer =
  | typeof SHADOW_LAYERS.HERO_DYNAMIC
  | typeof SHADOW_LAYERS.LOCAL_STATIC
  | typeof SHADOW_LAYERS.FAR_PROXY

export const SHADOW_LAYER_MASKS = {
  BEAUTY: 1 << SHADOW_LAYERS.BEAUTY,
  HERO_DYNAMIC: 1 << SHADOW_LAYERS.HERO_DYNAMIC,
  LOCAL_STATIC: 1 << SHADOW_LAYERS.LOCAL_STATIC,
  FAR_PROXY: 1 << SHADOW_LAYERS.FAR_PROXY,
  BEAUTY_ONLY: 1 << SHADOW_LAYERS.BEAUTY_ONLY
} as const

/**
 * Restrict a conventional light's shadow camera to the beauty world (layer 0),
 * excluding BEAUTY_ONLY markers. Use for any light on a stock `ShadowNode`; the
 * clipmap domains pin themselves to their own layer instead.
 *
 * Without this a stock shadow camera inherits the render camera's whole mask, so
 * it LISTS every beauty-only marker. Nothing on that layer casts, so nothing is
 * drawn — but an occlusion-gate query proxy still counts toward
 * `renderContext.occlusionQueryCount`, which costs a GPU query set created and
 * destroyed every frame and, without src/render/occlusionQueryPatch.ts, ended a
 * query that was never begun and dropped the pass's whole submit.
 */
export function pinShadowCameraToBeautyWorld(camera: THREE.Camera): void {
  camera.layers.set(SHADOW_LAYERS.BEAUTY)
  camera.layers.enable(SHADOW_LAYERS.SHADOW_CAMERA_PIN)
}

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
