import {
  buildFarOcclusionFloatField,
  packFarOcclusionHalf,
  type PackedFarOccluders
} from "./farOcclusionCore"

type InitMessage = {
  type: "init"
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  cellsPerTexel: number
  minX: number
  minZ: number
  texelSize: number
  groundTops: Float32Array
  minimumSunSlope: number
  contactRadiusMeters: number
  contactHeightMeters: number
  contactClearanceMeters: number
}

type SetMessage = { type: "set"; key: string; occluders: PackedFarOccluders }
type DeleteMessage = { type: "delete"; key: string }
type BuildMessage = {
  type: "build"
  generation: number
  contentRevision: number
  sunX: number
  sunY: number
  sunZ: number
}

type WorkerMessage = InitMessage | SetMessage | DeleteMessage | BuildMessage

let config: Omit<InitMessage, "type" | "groundTops" | "sourceWidth" | "sourceHeight" | "cellsPerTexel"> | null = null
let terrain: Float32Array | null = null
const occluderSets = new Map<string, PackedFarOccluders>()

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data
  if (message.type === "init") {
    const {
      groundTops,
      sourceWidth,
      sourceHeight,
      cellsPerTexel,
      type: _type,
      ...nextConfig
    } = message
    const nextTerrain = new Float32Array(message.width * message.height)
    for (let z = 0; z < message.height; z++) {
      const sourceZ0 = z * cellsPerTexel
      const sourceZ1 = Math.min(sourceHeight, sourceZ0 + cellsPerTexel)
      for (let x = 0; x < message.width; x++) {
        const sourceX0 = x * cellsPerTexel
        const sourceX1 = Math.min(sourceWidth, sourceX0 + cellsPerTexel)
        let maximum = -Infinity
        for (let sourceZ = sourceZ0; sourceZ < sourceZ1; sourceZ++) {
          const row = sourceZ * sourceWidth
          for (let sourceX = sourceX0; sourceX < sourceX1; sourceX++) {
            const value = groundTops[row + sourceX]
            if (Number.isFinite(value) && value > maximum) maximum = value
          }
        }
        nextTerrain[z * message.width + x] = Number.isFinite(maximum) ? maximum : 0
      }
    }
    terrain = nextTerrain
    config = nextConfig
    return
  }
  if (message.type === "set") {
    occluderSets.set(message.key, message.occluders)
    return
  }
  if (message.type === "delete") {
    occluderSets.delete(message.key)
    return
  }
  if (!config || !terrain) return

  const started = performance.now()
  try {
    const field = buildFarOcclusionFloatField({
      ...config,
      terrain,
      occluderSets: occluderSets.values(),
      sunX: message.sunX,
      sunY: message.sunY,
      sunZ: message.sunZ
    })
    const data = packFarOcclusionHalf(field.data)
    ;(self as unknown as Worker).postMessage({
      type: "built",
      generation: message.generation,
      contentRevision: message.contentRevision,
      sunX: message.sunX,
      sunY: message.sunY,
      sunZ: message.sunZ,
      data,
      buildMs: performance.now() - started,
      occluders: field.occluders,
      occupiedTexels: field.occupiedTexels
    }, [data.buffer])
  } catch (error) {
    ;(self as unknown as Worker).postMessage({
      type: "failed",
      generation: message.generation,
      contentRevision: message.contentRevision,
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
