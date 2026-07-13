import * as THREE from "three/webgpu"
import { setShadowOnlyLayer, SHADOW_LAYERS } from "./shadowLayers"

const DEFAULT_CELL_SIZE = 512
const BOX_TRIANGLES = 12

export type LandmarkShadowCollider = Readonly<{
  lm?: string
  x: number
  y: number
  z: number
  hx: number
  hy: number
  hz: number
  yaw?: number
}>

export type LandmarkShadowProxyOptions = Readonly<{
  colliders: readonly LandmarkShadowCollider[]
  /** World-space microcell width. The far projection is roughly 1 m/texel. */
  cellSize?: number
}>

export type LandmarkShadowProxyStats = {
  cellSize: number
  cells: number
  landmarks: number
  boxes: number
  rejectedBoxes: number
  drawsPerShadowPass: number
  trianglesPerShadowPass: number
  matrixBytes: number
}

type Cell = { x: number; z: number; boxes: LandmarkShadowCollider[] }

function createUnitBoxGeometry(): THREE.BufferGeometry {
  // Shadow depth needs only eight positions; BoxGeometry would duplicate each
  // corner for face normals and UVs that this shadow-only material never reads.
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5
  ], 3))
  geometry.setIndex([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5
  ])
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function validCollider(collider: LandmarkShadowCollider): boolean {
  const yaw = collider.yaw ?? 0
  return Number.isFinite(collider.x) && Number.isFinite(collider.y) && Number.isFinite(collider.z) &&
    Number.isFinite(collider.hx) && Number.isFinite(collider.hy) && Number.isFinite(collider.hz) &&
    Number.isFinite(yaw) && collider.hx > 0 && collider.hy > 0 && collider.hz > 0
}

function writeColliderMatrix(
  target: Float32Array,
  offset: number,
  collider: LandmarkShadowCollider
): void {
  const sx = collider.hx * 2
  const sy = collider.hy * 2
  const sz = collider.hz * 2
  const yaw = collider.yaw ?? 0
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  target[offset] = cos * sx
  target[offset + 1] = 0
  target[offset + 2] = -sin * sx
  target[offset + 3] = 0
  target[offset + 4] = 0
  target[offset + 5] = sy
  target[offset + 6] = 0
  target[offset + 7] = 0
  target[offset + 8] = sin * sz
  target[offset + 9] = 0
  target[offset + 10] = cos * sz
  target[offset + 11] = 0
  target[offset + 12] = collider.x
  target[offset + 13] = collider.y
  target[offset + 14] = collider.z
  target[offset + 15] = 1
}

/**
 * Always-resident landmark massing for the cached far projection.
 *
 * Collider boxes are split into world-space cells so the far camera rejects
 * whole bridge/landmark sections before vertex work. Beauty meshes never enter
 * this group; every mesh is FAR_PROXY-only and uses one shared eight-vertex box.
 */
export class LandmarkShadowProxy {
  readonly group = new THREE.Group()
  readonly meshes: readonly THREE.InstancedMesh[]
  readonly landmarkIds: ReadonlySet<string>
  readonly cellSize: number

  #geometry: THREE.BufferGeometry
  #material: THREE.MeshBasicMaterial
  #boxCount = 0
  #rejectedBoxes = 0
  #matrixBytes = 0
  #disposed = false

  constructor(options: LandmarkShadowProxyOptions) {
    const cellSize = options.cellSize ?? DEFAULT_CELL_SIZE
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new Error("LandmarkShadowProxy cellSize must be finite and > 0")
    }
    this.cellSize = cellSize

    const cells = new Map<string, Cell>()
    const landmarkIds = new Set<string>()
    for (const collider of options.colliders) {
      if (!validCollider(collider)) {
        this.#rejectedBoxes++
        continue
      }
      if (collider.lm) landmarkIds.add(collider.lm)
      const x = Math.floor(collider.x / cellSize)
      const z = Math.floor(collider.z / cellSize)
      const key = `${x}:${z}`
      let cell = cells.get(key)
      if (!cell) {
        cell = { x, z, boxes: [] }
        cells.set(key, cell)
      }
      cell.boxes.push(collider)
      this.#boxCount++
    }
    if (this.#boxCount === 0) {
      throw new Error("LandmarkShadowProxy received no valid collider boxes")
    }
    this.landmarkIds = landmarkIds

    this.#geometry = createUnitBoxGeometry()
    this.#material = new THREE.MeshBasicMaterial({ color: 0xffffff })
    this.#material.name = "landmarkShadowProxy.depth"
    this.#material.toneMapped = false
    this.group.name = "landmarkShadowProxy"
    this.group.matrixAutoUpdate = false
    setShadowOnlyLayer(this.group, SHADOW_LAYERS.FAR_PROXY)

    const meshes: THREE.InstancedMesh[] = []
    const ordered = Array.from(cells.values()).sort((a, b) => a.z - b.z || a.x - b.x)
    for (const cell of ordered) {
      const mesh = new THREE.InstancedMesh(this.#geometry, this.#material, cell.boxes.length)
      mesh.name = `landmarkShadowProxy:${cell.x}:${cell.z}`
      mesh.castShadow = true
      mesh.receiveShadow = false
      mesh.frustumCulled = true
      mesh.matrixAutoUpdate = false
      setShadowOnlyLayer(mesh, SHADOW_LAYERS.FAR_PROXY)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      const matrices = mesh.instanceMatrix.array as Float32Array
      for (let i = 0; i < cell.boxes.length; i++) {
        writeColliderMatrix(matrices, i * 16, cell.boxes[i])
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingBox()
      mesh.computeBoundingSphere()
      this.#matrixBytes += matrices.byteLength
      this.group.add(mesh)
      meshes.push(mesh)
    }
    this.meshes = meshes
  }

  stats(): LandmarkShadowProxyStats {
    return {
      cellSize: this.cellSize,
      cells: this.meshes.length,
      landmarks: this.landmarkIds.size,
      boxes: this.#boxCount,
      rejectedBoxes: this.#rejectedBoxes,
      drawsPerShadowPass: this.meshes.length,
      trianglesPerShadowPass: this.#boxCount * BOX_TRIANGLES,
      matrixBytes: this.#matrixBytes
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.group.removeFromParent()
    for (const mesh of this.meshes) mesh.dispose()
    this.group.clear()
    this.#geometry.dispose()
    this.#material.dispose()
  }
}

export function createLandmarkShadowProxy(
  options: LandmarkShadowProxyOptions
): LandmarkShadowProxy {
  return new LandmarkShadowProxy(options)
}
