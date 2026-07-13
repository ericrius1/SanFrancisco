import * as THREE from "three/webgpu"
import { setLocalFarShadowOnly } from "./shadowLayers"

const DEFAULT_CELL_SIZE = 96
const TRUNK_SIDES = 6
const CROWN_SIDES = 8

export type TreeShadowProfile = Readonly<{
  /** Template-local base offset. Slots already include their authored sink. */
  baseY: number
  height: number
  crownDiameter: number
}>

export type TreeShadowInstance = Readonly<{
  x: number
  y: number
  z: number
  yaw: number
  scale: number
  profile: TreeShadowProfile
}>

export type TreeShadowProxyOptions = Readonly<{
  name: string
  instances: readonly TreeShadowInstance[]
  /** World-space microcell width. */
  cellSize?: number
}>

type BuildCell = { x: number; z: number; instances: TreeShadowInstance[] }

let sharedGeometry: THREE.BufferGeometry | null = null
let sharedMaterial: THREE.MeshBasicMaterial | null = null
let sharedUsers = 0

/**
 * One position-only unit tree: a tapered six-sided trunk and a faceted crown.
 * The crown spans one unit in X/Z and the whole tree spans 0..1 in Y, allowing
 * every species to use the same pipeline while its instance matrix carries the
 * measured height and canopy width. At 66 triangles per tree this is cheaper
 * and substantially more stable than animated alpha-card depth.
 */
function createUnitTreeGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []

  const addRing = (y: number, radius: number, sides: number): number => {
    const start = positions.length / 3
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2
      positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
    }
    return start
  }
  const joinRings = (lower: number, upper: number, sides: number) => {
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides
      indices.push(lower + i, lower + next, upper + next, lower + i, upper + next, upper + i)
    }
  }

  const trunkBottom = addRing(0, 0.065, TRUNK_SIDES)
  const trunkTop = addRing(0.6, 0.045, TRUNK_SIDES)
  joinRings(trunkBottom, trunkTop, TRUNK_SIDES)
  const trunkTopCenter = positions.length / 3
  positions.push(0, 0.6, 0)
  for (let i = 0; i < TRUNK_SIDES; i++) {
    indices.push(trunkTop + i, trunkTopCenter, trunkTop + ((i + 1) % TRUNK_SIDES))
  }

  const crownBottom = addRing(0.3, 0.14, CROWN_SIDES)
  const crownMiddle = addRing(0.58, 0.5, CROWN_SIDES)
  const crownUpper = addRing(0.82, 0.34, CROWN_SIDES)
  joinRings(crownBottom, crownMiddle, CROWN_SIDES)
  joinRings(crownMiddle, crownUpper, CROWN_SIDES)
  const crownBottomCenter = positions.length / 3
  positions.push(0, 0.3, 0)
  const crownTop = positions.length / 3
  positions.push(0, 1, 0)
  for (let i = 0; i < CROWN_SIDES; i++) {
    const next = (i + 1) % CROWN_SIDES
    indices.push(crownBottomCenter, crownBottom + i, crownBottom + next)
    indices.push(crownUpper + i, crownTop, crownUpper + next)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function acquireSharedResources(): readonly [THREE.BufferGeometry, THREE.MeshBasicMaterial] {
  if (!sharedGeometry) sharedGeometry = createUnitTreeGeometry()
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
    sharedMaterial.name = "treeShadowProxy.depth"
    sharedMaterial.toneMapped = false
  }
  sharedUsers++
  return [sharedGeometry, sharedMaterial]
}

function releaseSharedResources(): void {
  sharedUsers--
  if (sharedUsers > 0) return
  sharedGeometry?.dispose()
  sharedMaterial?.dispose()
  sharedGeometry = null
  sharedMaterial = null
  sharedUsers = 0
}

/** Measure the grown LOD once; no species-specific shadow tuning is required. */
export function measureTreeShadowProfile(root: THREE.Object3D): TreeShadowProfile {
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)
  if (bounds.isEmpty()) return { baseY: 0, height: 8, crownDiameter: 5 }
  const size = bounds.getSize(new THREE.Vector3())
  const height = Math.max(1, size.y)
  return {
    baseY: Number.isFinite(bounds.min.y) ? bounds.min.y : 0,
    height,
    crownDiameter: THREE.MathUtils.clamp(Math.max(0.75, size.x, size.z), 0.75, height * 1.6)
  }
}

/**
 * Static tree shadow massing independent of the beauty-tree LOD switches.
 * Instances are split into world-space microcells so both local and far shadow
 * cameras can reject whole groves before vertex work. There are no per-frame
 * writes and no beauty-camera draw calls.
 */
export class TreeShadowProxy {
  readonly group = new THREE.Group()
  readonly meshes: readonly THREE.InstancedMesh[]
  readonly cellSize: number
  readonly treeCount: number
  readonly rejectedCount: number

  #ownsSharedResources = false
  #disposed = false

  constructor(options: TreeShadowProxyOptions) {
    if (!options.name) throw new Error("TreeShadowProxy requires a name")
    const cellSize = options.cellSize ?? DEFAULT_CELL_SIZE
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error("cellSize must be finite and > 0")
    this.cellSize = cellSize
    this.group.name = options.name
    this.group.matrixAutoUpdate = false
    setLocalFarShadowOnly(this.group)

    const cells = new Map<string, BuildCell>()
    let rejected = 0
    for (const instance of options.instances) {
      const profile = instance.profile
      if (
        !Number.isFinite(instance.x) ||
        !Number.isFinite(instance.y) ||
        !Number.isFinite(instance.z) ||
        !Number.isFinite(instance.yaw) ||
        !Number.isFinite(instance.scale) ||
        instance.scale <= 0 ||
        !Number.isFinite(profile.baseY) ||
        !Number.isFinite(profile.height) ||
        !Number.isFinite(profile.crownDiameter) ||
        profile.height <= 0 ||
        profile.crownDiameter <= 0
      ) {
        rejected++
        continue
      }
      const cellX = Math.floor(instance.x / cellSize)
      const cellZ = Math.floor(instance.z / cellSize)
      const key = `${cellX}:${cellZ}`
      let cell = cells.get(key)
      if (!cell) {
        cell = { x: cellX, z: cellZ, instances: [] }
        cells.set(key, cell)
      }
      cell.instances.push(instance)
    }

    const meshes: THREE.InstancedMesh[] = []
    let treeCount = 0
    if (cells.size > 0) {
      const [geometry, material] = acquireSharedResources()
      this.#ownsSharedResources = true
      const position = new THREE.Vector3()
      const rotation = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      const matrix = new THREE.Matrix4()
      const up = new THREE.Vector3(0, 1, 0)
      const ordered = Array.from(cells.values()).sort((a, b) => a.z - b.z || a.x - b.x)
      for (const cell of ordered) {
        const mesh = new THREE.InstancedMesh(geometry, material, cell.instances.length)
        mesh.name = `${options.name}:${cell.x}:${cell.z}`
        mesh.castShadow = true
        mesh.receiveShadow = false
        mesh.frustumCulled = true
        mesh.matrixAutoUpdate = false
        setLocalFarShadowOnly(mesh)
        for (let i = 0; i < cell.instances.length; i++) {
          const instance = cell.instances[i]
          const profile = instance.profile
          position.set(instance.x, instance.y + profile.baseY * instance.scale, instance.z)
          rotation.setFromAxisAngle(up, instance.yaw)
          scale.set(
            profile.crownDiameter * instance.scale,
            profile.height * instance.scale,
            profile.crownDiameter * instance.scale
          )
          matrix.compose(position, rotation, scale)
          mesh.setMatrixAt(i, matrix)
        }
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingBox()
        mesh.computeBoundingSphere()
        this.group.add(mesh)
        meshes.push(mesh)
        treeCount += cell.instances.length
      }
    }

    this.meshes = meshes
    this.treeCount = treeCount
    this.rejectedCount = rejected
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.group.removeFromParent()
    for (const mesh of this.meshes) mesh.dispose()
    this.group.clear()
    if (this.#ownsSharedResources) releaseSharedResources()
  }
}

export function createTreeShadowProxy(options: TreeShadowProxyOptions): TreeShadowProxy {
  return new TreeShadowProxy(options)
}
