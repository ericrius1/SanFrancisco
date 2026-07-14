import * as THREE from "three/webgpu"
import type { BuildingCollider } from "../tiles"
import { yieldToFrame } from "../../core/cooperativeWork"
import { setLocalFarShadowOnly } from "./shadowLayers"

const DEFAULT_CELL_SIZE = 128
const BOX_TRIANGLES = 12

type VisibilityCallback = (buildingIndex: number, tileKey: string) => boolean

export type TileShadowProxyOptions = Readonly<{
  tileKey: string
  colliders: readonly BuildingCollider[]
  buildingCount: number
  isBuildingVisible: VisibilityCallback
  /** World-space microcell width; 128 m is the measured default. */
  cellSize?: number
}>

export type TileShadowProxyStats = {
  tileKey: string
  cellSize: number
  cells: number
  buildings: number
  visibleBuildings: number
  boxes: number
  visibleBoxes: number
  hiddenBoxes: number
  rejectedColliders: number
  drawsPerShadowPass: number
  trianglesPerShadowPass: number
  matrixBytes: number
}

type BuildEntry = { collider: BuildingCollider; ref: number }
type BuildCell = { x: number; z: number; entries: BuildEntry[] }
type RuntimeCell = {
  mesh: THREE.InstancedMesh
  baseMatrices: Float32Array
  dirty: boolean
}

type PreparedTileShadowProxy = {
  cells: RuntimeCell[]
  meshes: THREE.InstancedMesh[]
  buildingVisible: Uint8Array
  buildingOffsets: Uint32Array
  buildingRefs: Uint32Array
  refCell: Uint32Array
  refSlot: Uint32Array
  visibleBuildings: number
  visibleBoxes: number
  rejectedColliders: number
  ownsSharedResources: boolean
  ownedMaterial: THREE.MeshBasicMaterial | null
}

let sharedGeometry: THREE.BufferGeometry | null = null
let sharedMaterial: THREE.MeshBasicMaterial | null = null
let sharedResourceUsers = 0

function createUnitBoxGeometry(): THREE.BufferGeometry {
  // Eight vertices rather than BoxGeometry's 24: shadow depth needs positions,
  // not separate face normals/UVs.
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

function acquireSharedResources(): readonly [THREE.BufferGeometry, THREE.MeshBasicMaterial] {
  if (!sharedGeometry) sharedGeometry = createUnitBoxGeometry()
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
    sharedMaterial.name = "tileShadowProxy.depth"
    sharedMaterial.toneMapped = false
  }
  sharedResourceUsers++
  return [sharedGeometry, sharedMaterial]
}

function releaseSharedResources(): void {
  sharedResourceUsers--
  if (sharedResourceUsers > 0) return
  sharedGeometry?.dispose()
  sharedMaterial?.dispose()
  sharedGeometry = null
  sharedMaterial = null
  sharedResourceUsers = 0
}

function validCollider(collider: BuildingCollider, buildingCount: number): boolean {
  return Number.isInteger(collider.i) && collider.i >= 0 && collider.i < buildingCount &&
    Number.isFinite(collider.x) && Number.isFinite(collider.y) && Number.isFinite(collider.z) &&
    Number.isFinite(collider.hx) && Number.isFinite(collider.hy) && Number.isFinite(collider.hz) &&
    Number.isFinite(collider.cosYaw) && Number.isFinite(collider.sinYaw) &&
    collider.hx > 0 && collider.hy > 0 && collider.hz > 0
}

function writeColliderMatrix(target: Float32Array, offset: number, collider: BuildingCollider): void {
  const sx = collider.hx * 2
  const sy = collider.hy * 2
  const sz = collider.hz * 2
  const cos = collider.cosYaw
  const sin = collider.sinYaw
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

function copyMatrix(target: Float32Array, offset: number, source: Float32Array): void {
  for (let i = 0; i < 16; i++) target[offset + i] = source[offset + i]
}

function hideMatrix(target: Float32Array, offset: number, source: Float32Array): void {
  for (let i = 0; i < 12; i++) target[offset + i] = 0
  // Preserve its world position so the all-visible bound remains conservative.
  target[offset + 12] = source[offset + 12]
  target[offset + 13] = source[offset + 13]
  target[offset + 14] = source[offset + 14]
  target[offset + 15] = 1
}

/**
 * Cullable shadow-only massing for one baked 800 m tile.
 *
 * Collider boxes are grouped into small world-space cells. Suppression changes
 * zero only the affected instance matrices; mesh topology, bounds, and render
 * bundles never need rebuilding. `syncVisibility()` performs no allocations.
 */
export class TileShadowProxy {
  readonly tileKey: string
  readonly cellSize: number
  readonly group = new THREE.Group()
  readonly meshes: readonly THREE.InstancedMesh[]

  #cells: RuntimeCell[]
  #buildingVisible: Uint8Array
  #buildingOffsets: Uint32Array
  #buildingRefs: Uint32Array
  #refCell: Uint32Array
  #refSlot: Uint32Array
  #isBuildingVisible: VisibilityCallback
  #visibleBuildings = 0
  #visibleBoxes = 0
  #rejectedColliders = 0
  #disposed = false
  #ownsSharedResources = false
  #ownedMaterial: THREE.MeshBasicMaterial | null = null

  constructor(options: TileShadowProxyOptions, prepared?: PreparedTileShadowProxy) {
    if (!options.tileKey) throw new Error("TileShadowProxy requires a tileKey")
    if (!Number.isInteger(options.buildingCount) || options.buildingCount < 0) {
      throw new Error("buildingCount must be a non-negative integer")
    }
    const cellSize = options.cellSize ?? DEFAULT_CELL_SIZE
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error("cellSize must be finite and > 0")

    this.tileKey = options.tileKey
    this.cellSize = cellSize
    this.#isBuildingVisible = options.isBuildingVisible
    this.group.name = `tileShadowProxy:${this.tileKey}`
    this.group.matrixAutoUpdate = false
    setLocalFarShadowOnly(this.group)

    if (prepared) {
      this.#cells = prepared.cells
      this.meshes = prepared.meshes
      this.#buildingVisible = prepared.buildingVisible
      this.#buildingOffsets = prepared.buildingOffsets
      this.#buildingRefs = prepared.buildingRefs
      this.#refCell = prepared.refCell
      this.#refSlot = prepared.refSlot
      this.#visibleBuildings = prepared.visibleBuildings
      this.#visibleBoxes = prepared.visibleBoxes
      this.#rejectedColliders = prepared.rejectedColliders
      this.#ownsSharedResources = prepared.ownsSharedResources
      this.#ownedMaterial = prepared.ownedMaterial
      for (const mesh of prepared.meshes) this.group.add(mesh)
      return
    }

    const buildingCount = options.buildingCount
    const buildingCounts = new Uint32Array(buildingCount)
    const buildCells = new Map<string, BuildCell>()
    let validCount = 0

    for (let i = 0; i < options.colliders.length; i++) {
      const collider = options.colliders[i]
      if (!validCollider(collider, buildingCount)) {
        this.#rejectedColliders++
        continue
      }
      const cellX = Math.floor(collider.x / cellSize)
      const cellZ = Math.floor(collider.z / cellSize)
      const key = `${cellX}:${cellZ}`
      let cell = buildCells.get(key)
      if (!cell) {
        cell = { x: cellX, z: cellZ, entries: [] }
        buildCells.set(key, cell)
      }
      cell.entries.push({ collider, ref: validCount })
      buildingCounts[collider.i]++
      validCount++
    }

    this.#buildingVisible = new Uint8Array(buildingCount)
    this.#buildingOffsets = new Uint32Array(buildingCount + 1)
    for (let i = 0; i < buildingCount; i++) {
      this.#buildingOffsets[i + 1] = this.#buildingOffsets[i] + buildingCounts[i]
      const visible = options.isBuildingVisible(i, this.tileKey)
      this.#buildingVisible[i] = visible ? 1 : 0
      if (visible) {
        this.#visibleBuildings++
        this.#visibleBoxes += buildingCounts[i]
      }
    }
    this.#buildingRefs = new Uint32Array(validCount)
    this.#refCell = new Uint32Array(validCount)
    this.#refSlot = new Uint32Array(validCount)
    const cursors = this.#buildingOffsets.slice(0, buildingCount)

    const cells: RuntimeCell[] = []
    const meshes: THREE.InstancedMesh[] = []
    if (validCount > 0) {
      const [geometry, materialTemplate] = acquireSharedResources()
      this.#ownsSharedResources = true
      // Three WebGPU RenderObjects subscribe to material.dispose, not the
      // InstancedMesh dispose event. One proxy-owned clone lets retirement
      // release every microcell RenderObject without duplicating geometry.
      const material = materialTemplate.clone()
      material.name = `${materialTemplate.name}:${this.tileKey}`
      this.#ownedMaterial = material
      const orderedCells = Array.from(buildCells.values()).sort((a, b) => a.z - b.z || a.x - b.x)
      for (let cellIndex = 0; cellIndex < orderedCells.length; cellIndex++) {
        const build = orderedCells[cellIndex]
        const mesh = new THREE.InstancedMesh(geometry, material, build.entries.length)
        mesh.name = `tileShadowProxy:${this.tileKey}:${build.x}:${build.z}`
        mesh.castShadow = true
        mesh.receiveShadow = false
        mesh.frustumCulled = true
        mesh.matrixAutoUpdate = false
        setLocalFarShadowOnly(mesh)
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        const matrices = mesh.instanceMatrix.array as Float32Array
        const baseMatrices = new Float32Array(matrices.length)

        for (let slot = 0; slot < build.entries.length; slot++) {
          const entry = build.entries[slot]
          const offset = slot * 16
          writeColliderMatrix(baseMatrices, offset, entry.collider)
          copyMatrix(matrices, offset, baseMatrices)
          this.#refCell[entry.ref] = cellIndex
          this.#refSlot[entry.ref] = slot
          this.#buildingRefs[cursors[entry.collider.i]++] = entry.ref
        }

        // Bounds are intentionally calculated before suppression so later
        // visibility changes can never reveal an instance outside the cell bound.
        mesh.computeBoundingBox()
        mesh.computeBoundingSphere()
        for (let slot = 0; slot < build.entries.length; slot++) {
          if (this.#buildingVisible[build.entries[slot].collider.i] === 0) {
            hideMatrix(matrices, slot * 16, baseMatrices)
          }
        }
        mesh.instanceMatrix.needsUpdate = true
        this.group.add(mesh)
        cells.push({ mesh, baseMatrices, dirty: false })
        meshes.push(mesh)
      }
    }

    this.#cells = cells
    this.meshes = meshes
  }

  /** Poll the supplied visibility callback and update changed buildings only. */
  syncVisibility(): number {
    if (this.#disposed) return 0
    let changed = 0
    for (let i = 0; i < this.#buildingVisible.length; i++) {
      const visible = this.#isBuildingVisible(i, this.tileKey)
      if ((this.#buildingVisible[i] !== 0) === visible) continue
      this.#applyVisibility(i, visible)
      changed++
    }
    this.#flushDirtyCells()
    return changed
  }

  /** Update one known suppression change without scanning every building. */
  setBuildingVisible(buildingIndex: number, visible: boolean): boolean {
    if (this.#disposed || !Number.isInteger(buildingIndex) || buildingIndex < 0 || buildingIndex >= this.#buildingVisible.length) return false
    if ((this.#buildingVisible[buildingIndex] !== 0) === visible) return false
    this.#applyVisibility(buildingIndex, visible)
    this.#flushDirtyCells()
    return true
  }

  writeStats(target: TileShadowProxyStats): TileShadowProxyStats {
    const boxes = this.#buildingRefs.length
    target.tileKey = this.tileKey
    target.cellSize = this.cellSize
    target.cells = this.#cells.length
    target.buildings = this.#buildingVisible.length
    target.visibleBuildings = this.#visibleBuildings
    target.boxes = boxes
    target.visibleBoxes = this.#visibleBoxes
    target.hiddenBoxes = boxes - this.#visibleBoxes
    target.rejectedColliders = this.#rejectedColliders
    target.drawsPerShadowPass = this.#cells.length
    // Hidden instances are degenerate but remain in the instanced draw, so this
    // reports the structural vertex workload rather than only visible coverage.
    target.trianglesPerShadowPass = boxes * BOX_TRIANGLES
    let matrixBytes = this.#refCell.byteLength + this.#refSlot.byteLength + this.#buildingRefs.byteLength +
      this.#buildingOffsets.byteLength + this.#buildingVisible.byteLength
    for (let i = 0; i < this.#cells.length; i++) {
      matrixBytes += this.#cells[i].baseMatrices.byteLength
      matrixBytes += (this.#cells[i].mesh.instanceMatrix.array as Float32Array).byteLength
    }
    target.matrixBytes = matrixBytes
    return target
  }

  stats(): TileShadowProxyStats {
    return this.writeStats({
      tileKey: this.tileKey,
      cellSize: this.cellSize,
      cells: 0,
      buildings: 0,
      visibleBuildings: 0,
      boxes: 0,
      visibleBoxes: 0,
      hiddenBoxes: 0,
      rejectedColliders: 0,
      drawsPerShadowPass: 0,
      trianglesPerShadowPass: 0,
      matrixBytes: 0
    })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.group.removeFromParent()
    for (let i = 0; i < this.#cells.length; i++) this.#cells[i].mesh.dispose()
    this.group.clear()
    this.#ownedMaterial?.dispose()
    this.#ownedMaterial = null
    if (this.#ownsSharedResources) releaseSharedResources()
  }

  #applyVisibility(buildingIndex: number, visible: boolean): void {
    this.#buildingVisible[buildingIndex] = visible ? 1 : 0
    this.#visibleBuildings += visible ? 1 : -1
    const start = this.#buildingOffsets[buildingIndex]
    const end = this.#buildingOffsets[buildingIndex + 1]
    this.#visibleBoxes += visible ? end - start : start - end
    for (let i = start; i < end; i++) {
      const ref = this.#buildingRefs[i]
      const cell = this.#cells[this.#refCell[ref]]
      const offset = this.#refSlot[ref] * 16
      const matrices = cell.mesh.instanceMatrix.array as Float32Array
      if (visible) copyMatrix(matrices, offset, cell.baseMatrices)
      else hideMatrix(matrices, offset, cell.baseMatrices)
      cell.dirty = true
    }
  }

  #flushDirtyCells(): void {
    for (let i = 0; i < this.#cells.length; i++) {
      const cell = this.#cells[i]
      if (!cell.dirty) continue
      cell.mesh.instanceMatrix.needsUpdate = true
      cell.dirty = false
    }
  }
}

export function createTileShadowProxy(options: TileShadowProxyOptions): TileShadowProxy {
  return new TileShadowProxy(options)
}

/**
 * Build the same proxy without monopolising one displayed frame. Collider
 * validation/binning, matrix population and per-cell bounds are checkpointed;
 * the returned object is already complete and can be attached atomically.
 */
export async function createTileShadowProxyAsync(
  options: TileShadowProxyOptions
): Promise<TileShadowProxy> {
  if (!options.tileKey) throw new Error("TileShadowProxy requires a tileKey")
  if (!Number.isInteger(options.buildingCount) || options.buildingCount < 0) {
    throw new Error("buildingCount must be a non-negative integer")
  }
  const cellSize = options.cellSize ?? DEFAULT_CELL_SIZE
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error("cellSize must be finite and > 0")

  let sliceStarted = performance.now()
  const checkpoint = async () => {
    if (performance.now() - sliceStarted < 1.5) return
    await yieldToFrame()
    sliceStarted = performance.now()
  }

  const buildingCount = options.buildingCount
  const buildingCounts = new Uint32Array(buildingCount)
  const buildCells = new Map<string, BuildCell>()
  let validCount = 0
  let rejectedColliders = 0
  for (let i = 0; i < options.colliders.length; i++) {
    const collider = options.colliders[i]
    if (!validCollider(collider, buildingCount)) {
      rejectedColliders++
    } else {
      const cellX = Math.floor(collider.x / cellSize)
      const cellZ = Math.floor(collider.z / cellSize)
      const key = `${cellX}:${cellZ}`
      let cell = buildCells.get(key)
      if (!cell) {
        cell = { x: cellX, z: cellZ, entries: [] }
        buildCells.set(key, cell)
      }
      cell.entries.push({ collider, ref: validCount })
      buildingCounts[collider.i]++
      validCount++
    }
    if ((i & 127) === 127) await checkpoint()
  }

  const buildingVisible = new Uint8Array(buildingCount)
  const buildingOffsets = new Uint32Array(buildingCount + 1)
  let visibleBuildings = 0
  let visibleBoxes = 0
  for (let i = 0; i < buildingCount; i++) {
    buildingOffsets[i + 1] = buildingOffsets[i] + buildingCounts[i]
    const visible = options.isBuildingVisible(i, options.tileKey)
    buildingVisible[i] = visible ? 1 : 0
    if (visible) {
      visibleBuildings++
      visibleBoxes += buildingCounts[i]
    }
    if ((i & 255) === 255) await checkpoint()
  }

  const buildingRefs = new Uint32Array(validCount)
  const refCell = new Uint32Array(validCount)
  const refSlot = new Uint32Array(validCount)
  const cursors = buildingOffsets.slice(0, buildingCount)
  const cells: RuntimeCell[] = []
  const meshes: THREE.InstancedMesh[] = []
  let ownsSharedResources = false
  let ownedMaterial: THREE.MeshBasicMaterial | null = null

  try {
    if (validCount > 0) {
      const [geometry, materialTemplate] = acquireSharedResources()
      ownsSharedResources = true
      ownedMaterial = materialTemplate.clone()
      ownedMaterial.name = `${materialTemplate.name}:${options.tileKey}`
      const orderedCells = Array.from(buildCells.values()).sort((a, b) => a.z - b.z || a.x - b.x)
      for (let cellIndex = 0; cellIndex < orderedCells.length; cellIndex++) {
        const build = orderedCells[cellIndex]
        const mesh = new THREE.InstancedMesh(geometry, ownedMaterial, build.entries.length)
        mesh.name = `tileShadowProxy:${options.tileKey}:${build.x}:${build.z}`
        mesh.castShadow = true
        mesh.receiveShadow = false
        mesh.frustumCulled = true
        mesh.matrixAutoUpdate = false
        setLocalFarShadowOnly(mesh)
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        const matrices = mesh.instanceMatrix.array as Float32Array
        const baseMatrices = new Float32Array(matrices.length)

        for (let slot = 0; slot < build.entries.length; slot++) {
          const entry = build.entries[slot]
          const offset = slot * 16
          writeColliderMatrix(baseMatrices, offset, entry.collider)
          copyMatrix(matrices, offset, baseMatrices)
          refCell[entry.ref] = cellIndex
          refSlot[entry.ref] = slot
          buildingRefs[cursors[entry.collider.i]++] = entry.ref
        }
        mesh.computeBoundingBox()
        mesh.computeBoundingSphere()
        for (let slot = 0; slot < build.entries.length; slot++) {
          if (buildingVisible[build.entries[slot].collider.i] === 0) {
            hideMatrix(matrices, slot * 16, baseMatrices)
          }
        }
        mesh.instanceMatrix.needsUpdate = true
        cells.push({ mesh, baseMatrices, dirty: false })
        meshes.push(mesh)
        await checkpoint()
      }
    }

    return new TileShadowProxy(options, {
      cells,
      meshes,
      buildingVisible,
      buildingOffsets,
      buildingRefs,
      refCell,
      refSlot,
      visibleBuildings,
      visibleBoxes,
      rejectedColliders,
      ownsSharedResources,
      ownedMaterial
    })
  } catch (error) {
    for (const cell of cells) cell.mesh.dispose()
    ownedMaterial?.dispose()
    if (ownsSharedResources) releaseSharedResources()
    throw error
  }
}
