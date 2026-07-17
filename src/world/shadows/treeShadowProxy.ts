import * as THREE from "three/webgpu"
import { attribute, floor, fract, instanceIndex, positionGeometry, positionLocal, positionWorld, smoothstep, vec3 } from "three/tsl"
import { setLocalFarShadowOnly } from "./shadowLayers"

type N = any

const DEFAULT_CELL_SIZE = 96
const TRUNK_SIDES = 6
const CROWN_SIDES = 8
/** Fallback canopy coverage when a species carries no measured density. */
const DEFAULT_COVER = 0.66
/** World-space size of one shadow perforation cell (m). */
const HOLE_CELL = 0.55

export type TreeShadowProfile = Readonly<{
  /** Template-local base offset. Slots already include their authored sink. */
  baseY: number
  height: number
  crownDiameter: number
  /**
   * Canopy coverage 0..1 — the fraction of sunlight the crown blocks. Drives
   * the perforated shadow mask so airy species throw lighter, gappier shade.
   */
  cover?: number
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

/**
 * Depth-only proxy material that reads as a CANOPY instead of a solid blob:
 *   • the crown silhouette gets per-vertex/per-instance radial jitter so no
 *     two trees share the same convex spindle outline;
 *   • the crown depth write is perforated by a world-anchored hash mask whose
 *     keep-fraction is the species' canopy coverage — PCF then averages the
 *     holes into dappled light instead of a filled ellipse.
 * World-anchored cells keep the cached local/far shadow maps stable across
 * re-renders; the trunk (unit Y < 0.3) always stays solid.
 */
function createProxyMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff })
  material.name = "treeShadowProxy.depth"
  material.toneMapped = false

  const crownness: N = smoothstep(0.28, 0.34, (positionGeometry as N).y)
  const seed: N = (positionGeometry as N).xyz
    .dot(vec3(12.9898, 78.233, 37.719))
    .add((instanceIndex as N).toFloat().mul(0.618034))
  const lumpA: N = fract(seed.sin().mul(43758.5453)).sub(0.5)
  const lumpB: N = fract(seed.add(19.19).sin().mul(24634.6345)).sub(0.5)
  const xz: N = (positionGeometry as N).xz
  const radial: N = xz.div(xz.length().max(0.06))
  const bump: N = vec3(
    radial.x.mul(lumpA).mul(0.2),
    lumpB.mul(0.12),
    radial.y.mul(lumpA).mul(0.2)
  ).mul(crownness)
  material.positionNode = (positionLocal as N).add(bump)

  const cover: N = attribute("aShadowCover", "float")
  const cell: N = floor((positionWorld as N).xyz.div(HOLE_CELL))
  const hash: N = fract(cell.dot(vec3(127.1, 311.7, 74.7)).sin().mul(43758.5453))
  ;(material as N).maskShadowNode = hash.lessThan(cover).or(crownness.lessThan(0.5))
  return material
}

function acquireSharedGeometry(): THREE.BufferGeometry {
  if (!sharedGeometry) sharedGeometry = createUnitTreeGeometry()
  sharedUsers++
  return sharedGeometry
}

function releaseSharedResources(): void {
  sharedUsers--
  if (sharedUsers > 0) return
  sharedGeometry?.dispose()
  sharedGeometry = null
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
  #ownedMaterial: THREE.MeshBasicMaterial | null = null
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
      const unitGeometry = acquireSharedGeometry()
      this.#ownsSharedResources = true
      // A fresh (not cloned) material per streamed proxy: material.dispose
      // gives Three's WebGPU backend the exact ownership boundary it listens
      // for, and identical node graphs dedupe into one cached pipeline.
      const material = createProxyMaterial()
      material.name = `${material.name}:${options.name}`
      this.#ownedMaterial = material
      const position = new THREE.Vector3()
      const rotation = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      const matrix = new THREE.Matrix4()
      const up = new THREE.Vector3(0, 1, 0)
      const ordered = Array.from(cells.values()).sort((a, b) => a.z - b.z || a.x - b.x)
      for (const cell of ordered) {
        // Per-cell geometry clone (66 verts) so the per-instance canopy-cover
        // channel can ride an instanced attribute of the cell's exact count.
        const geometry = unitGeometry.clone()
        const coverAttr = new THREE.InstancedBufferAttribute(new Float32Array(cell.instances.length), 1)
        geometry.setAttribute("aShadowCover", coverAttr)
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
          coverAttr.setX(i, THREE.MathUtils.clamp(profile.cover ?? DEFAULT_COVER, 0.2, 0.95))
        }
        mesh.instanceMatrix.needsUpdate = true
        coverAttr.needsUpdate = true
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
    this.#ownedMaterial?.dispose()
    this.#ownedMaterial = null
    if (this.#ownsSharedResources) releaseSharedResources()
  }
}

export function createTreeShadowProxy(options: TreeShadowProxyOptions): TreeShadowProxy {
  return new TreeShadowProxy(options)
}
