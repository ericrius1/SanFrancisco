import {
  buildFarOcclusionFloatField,
  packFarOcclusionHalf,
  type PackedFarOccluders
} from "./farOcclusionCore"

type InitMessage = {
  type: "init"
  width: number
  height: number
  minX: number
  minZ: number
  texelSize: number
  terrain: Float32Array
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

let config: Omit<InitMessage, "type" | "terrain"> | null = null
let terrain: Float32Array | null = null
const occluderSets = new Map<string, PackedFarOccluders>()

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data
  if (message.type === "init") {
    const { terrain: nextTerrain, type: _type, ...nextConfig } = message
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
