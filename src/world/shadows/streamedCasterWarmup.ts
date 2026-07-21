import * as THREE from "three/webgpu"
import { setLocalFarShadowOnly } from "./shadowLayers"

/**
 * Keep the static-shadow RenderObject/pipeline signature used by streamed
 * merged building proxies alive from the covered boot frame onward.
 *
 * Three's WebGPU node cache includes the complete vertex layout even when the
 * shadow material reads only `position`. CityGen chunks add `color` and
 * `lodVisibility`, so the first chunk entering an otherwise-empty static
 * shadow domain used to pay a synchronous node build while the player moved.
 * A degenerate triangle with the same indexed Float32 layout warms both the
 * local and far clipmap contexts without drawing a visible texel. Keeping the
 * owner resident prevents the shared cache entry from reaching zero users
 * when a teleport temporarily unloads every live CityGen cell.
 */
export function createStreamedStaticCasterWarmup(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3))
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(9), 3))
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6), 2))
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(9), 3))
  geometry.setAttribute("lodVisibility", new THREE.BufferAttribute(new Float32Array(3), 1))
  geometry.setIndex([0, 1, 2])
  geometry.computeBoundingSphere()

  // The live static shadow pass replaces this with its per-domain
  // ShadowMaterial. The material exists only to make the owner well-formed.
  const material = new THREE.MeshBasicMaterial()
  material.name = "streamedStaticCasterWarmup.placeholder"
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = "streamedStaticCasterWarmup"
  mesh.castShadow = true
  mesh.receiveShadow = false
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  setLocalFarShadowOnly(mesh)
  return mesh
}
