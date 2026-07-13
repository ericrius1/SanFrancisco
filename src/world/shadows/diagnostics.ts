/**
 * Low-overhead telemetry for shadow-map scheduling.
 *
 * Domains are registered once and keep their update history in typed-array ring
 * buffers. `beginFrame()` and `recordUpdate()` allocate nothing. Diagnostics UI
 * should create one snapshot buffer and reuse it with `writeSnapshot()`; the
 * convenient `snapshot()` helper intentionally allocates and is meant for
 * infrequent dev-console/probe reads.
 */

export const SHADOW_UPDATE_REASON = {
  INITIAL: 1 << 0,
  EVERY_FRAME: 1 << 1,
  ANCHOR_MOVED: 1 << 2,
  SUN_MOVED: 1 << 3,
  STREAM_CHANGED: 1 << 4,
  TELEPORT: 1 << 5,
  CAMERA_CHANGED: 1 << 6,
  CONFIG_CHANGED: 1 << 7,
  FORCED: 1 << 8
} as const

export type ShadowUpdateReason = number

export type ShadowDomainConfig = Readonly<{
  /** Stable identifier exposed to diagnostics and probes. */
  id: string
  /** Initial square-map resolution in texels. May be changed per update. */
  resolution: number
  /** Initial light-space world extent in metres. May be changed per update. */
  extentMeters: number
}>

export type ShadowUpdateRecord = Readonly<{
  reason: ShadowUpdateReason
  /** Light-space width of this shadow domain in world metres. */
  extentMeters: number
  /** Square shadow-map width/height in texels. */
  resolution: number
  /** Optional CPU encode/scheduling cost, when an owning pass measures it. */
  cpuMs?: number
}>

export type ShadowDomainSnapshot = {
  id: string
  updates: number
  lastUpdateFrame: number
  lastUpdateMs: number
  ageFrames: number
  ageMs: number
  reasonMask: ShadowUpdateReason
  reason: string
  extentMeters: number
  resolution: number
  texelMeters: number
  updateHz: number
  averageIntervalFrames: number
  averageCpuMs: number
  intervals1: number
  intervals2: number
  intervals4: number
  intervalsOther: number
}

export type ShadowDiagnosticsSnapshot = {
  frame: number
  nowMs: number
  domains: ShadowDomainSnapshot[]
}

type DomainState = {
  readonly id: string
  readonly frames: Float64Array
  readonly times: Float64Array
  readonly cpuTimes: Float32Array
  writeIndex: number
  sampleCount: number
  updates: number
  lastUpdateFrame: number
  lastUpdateMs: number
  reasonMask: ShadowUpdateReason
  extentMeters: number
  resolution: number
  texelMeters: number
}

const REASON_LABELS: ReadonlyArray<readonly [number, string]> = [
  [SHADOW_UPDATE_REASON.INITIAL, "initial"],
  [SHADOW_UPDATE_REASON.EVERY_FRAME, "every-frame"],
  [SHADOW_UPDATE_REASON.ANCHOR_MOVED, "anchor"],
  [SHADOW_UPDATE_REASON.SUN_MOVED, "sun"],
  [SHADOW_UPDATE_REASON.STREAM_CHANGED, "stream"],
  [SHADOW_UPDATE_REASON.TELEPORT, "teleport"],
  [SHADOW_UPDATE_REASON.CAMERA_CHANGED, "camera"],
  [SHADOW_UPDATE_REASON.CONFIG_CHANGED, "config"],
  [SHADOW_UPDATE_REASON.FORCED, "forced"]
]

function validPositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and > 0`)
  return value
}

export function formatShadowUpdateReason(mask: ShadowUpdateReason): string {
  if (mask === 0) return "none"
  let result = ""
  for (let i = 0; i < REASON_LABELS.length; i++) {
    const [bit, label] = REASON_LABELS[i]
    if ((mask & bit) === 0) continue
    result += result.length === 0 ? label : `+${label}`
  }
  return result || `unknown(${mask})`
}

/**
 * Tracks scheduling health independently of Three's renderer counters, which
 * do not account reliably for replayed render-bundle children.
 */
export class ShadowDiagnostics {
  readonly historySize: number
  readonly rateWindowMs: number

  #frame = 0
  #nowMs = 0
  #domains: DomainState[]
  #domainIndex = new Map<string, number>()

  constructor(
    configs: readonly ShadowDomainConfig[],
    options: Readonly<{ historySize?: number; rateWindowMs?: number }> = {}
  ) {
    if (configs.length === 0) throw new Error("ShadowDiagnostics requires at least one domain")
    this.historySize = Math.max(8, Math.trunc(options.historySize ?? 120))
    this.rateWindowMs = validPositive(options.rateWindowMs ?? 1000, "rateWindowMs")
    this.#domains = new Array<DomainState>(configs.length)

    for (let i = 0; i < configs.length; i++) {
      const config = configs[i]
      if (this.#domainIndex.has(config.id)) throw new Error(`Duplicate shadow domain: ${config.id}`)
      const resolution = Math.trunc(validPositive(config.resolution, `${config.id}.resolution`))
      const extentMeters = validPositive(config.extentMeters, `${config.id}.extentMeters`)
      this.#domainIndex.set(config.id, i)
      this.#domains[i] = {
        id: config.id,
        frames: new Float64Array(this.historySize),
        times: new Float64Array(this.historySize),
        cpuTimes: new Float32Array(this.historySize),
        writeIndex: 0,
        sampleCount: 0,
        updates: 0,
        lastUpdateFrame: -1,
        lastUpdateMs: Number.NEGATIVE_INFINITY,
        reasonMask: 0,
        extentMeters,
        resolution,
        texelMeters: extentMeters / resolution
      }
    }
  }

  get frame(): number {
    return this.#frame
  }

  get nowMs(): number {
    return this.#nowMs
  }

  /** Call once per presented/rendered frame before any domain update records. */
  beginFrame(frame: number, nowMs = performance.now()): void {
    if (!Number.isFinite(frame) || frame < 0) throw new Error("frame must be finite and >= 0")
    if (!Number.isFinite(nowMs)) throw new Error("nowMs must be finite")
    this.#frame = frame
    this.#nowMs = nowMs
  }

  /**
   * Record an actual shadow-map refresh, not merely a requested one. Positional
   * arguments avoid allocating an options object in the render loop.
   */
  recordUpdate(
    domainId: string,
    reason: ShadowUpdateReason,
    extentMeters: number,
    resolution: number,
    cpuMs = Number.NaN,
    completedAtMs = this.#nowMs
  ): void {
    if (!Number.isFinite(completedAtMs)) throw new Error("completedAtMs must be finite")
    const state = this.#domain(domainId)
    state.extentMeters = validPositive(extentMeters, `${domainId}.extentMeters`)
    state.resolution = Math.trunc(validPositive(resolution, `${domainId}.resolution`))
    state.texelMeters = state.extentMeters / state.resolution
    state.lastUpdateFrame = this.#frame
    state.lastUpdateMs = completedAtMs
    state.reasonMask = reason
    state.updates++

    const index = state.writeIndex
    state.frames[index] = this.#frame
    state.times[index] = completedAtMs
    state.cpuTimes[index] = Number.isFinite(cpuMs) ? cpuMs : Number.NaN
    state.writeIndex = (index + 1) % this.historySize
    if (state.sampleCount < this.historySize) state.sampleCount++
  }

  /** Allocate a stable buffer once, then pass it to `writeSnapshot()`. */
  createSnapshotBuffer(): ShadowDiagnosticsSnapshot {
    const domains = new Array<ShadowDomainSnapshot>(this.#domains.length)
    for (let i = 0; i < this.#domains.length; i++) {
      domains[i] = {
        id: this.#domains[i].id,
        updates: 0,
        lastUpdateFrame: -1,
        lastUpdateMs: Number.NEGATIVE_INFINITY,
        ageFrames: Number.POSITIVE_INFINITY,
        ageMs: Number.POSITIVE_INFINITY,
        reasonMask: 0,
        reason: "none",
        extentMeters: 0,
        resolution: 0,
        texelMeters: 0,
        updateHz: 0,
        averageIntervalFrames: 0,
        averageCpuMs: 0,
        intervals1: 0,
        intervals2: 0,
        intervals4: 0,
        intervalsOther: 0
      }
    }
    return { frame: 0, nowMs: 0, domains }
  }

  /** Refresh a previously-created snapshot without allocating arrays/objects. */
  writeSnapshot(target: ShadowDiagnosticsSnapshot, nowMs = this.#nowMs): ShadowDiagnosticsSnapshot {
    if (target.domains.length !== this.#domains.length) {
      throw new Error("Snapshot domain count does not match this ShadowDiagnostics instance")
    }
    target.frame = this.#frame
    target.nowMs = nowMs
    for (let i = 0; i < this.#domains.length; i++) this.#writeDomainSnapshot(this.#domains[i], target.domains[i], nowMs)
    return target
  }

  /** Convenient allocating snapshot for probes and occasional console reads. */
  snapshot(nowMs = this.#nowMs): ShadowDiagnosticsSnapshot {
    return this.writeSnapshot(this.createSnapshotBuffer(), nowMs)
  }

  reset(): void {
    this.#frame = 0
    this.#nowMs = 0
    for (let i = 0; i < this.#domains.length; i++) {
      const state = this.#domains[i]
      state.frames.fill(0)
      state.times.fill(0)
      state.cpuTimes.fill(0)
      state.writeIndex = 0
      state.sampleCount = 0
      state.updates = 0
      state.lastUpdateFrame = -1
      state.lastUpdateMs = Number.NEGATIVE_INFINITY
      state.reasonMask = 0
    }
  }

  #domain(id: string): DomainState {
    const index = this.#domainIndex.get(id)
    if (index === undefined) throw new Error(`Unknown shadow domain: ${id}`)
    return this.#domains[index]
  }

  #writeDomainSnapshot(state: DomainState, target: ShadowDomainSnapshot, nowMs: number): void {
    target.id = state.id
    target.updates = state.updates
    target.lastUpdateFrame = state.lastUpdateFrame
    target.lastUpdateMs = state.lastUpdateMs
    target.ageFrames = state.lastUpdateFrame < 0 ? Number.POSITIVE_INFINITY : this.#frame - state.lastUpdateFrame
    target.ageMs = state.lastUpdateFrame < 0 ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - state.lastUpdateMs)
    target.reasonMask = state.reasonMask
    target.reason = formatShadowUpdateReason(state.reasonMask)
    target.extentMeters = state.extentMeters
    target.resolution = state.resolution
    target.texelMeters = state.texelMeters
    target.updateHz = 0
    target.averageIntervalFrames = 0
    target.averageCpuMs = 0
    target.intervals1 = 0
    target.intervals2 = 0
    target.intervals4 = 0
    target.intervalsOther = 0

    const count = state.sampleCount
    if (count === 0) return
    const oldest = (state.writeIndex - count + this.historySize) % this.historySize
    const cutoffMs = nowMs - this.rateWindowMs
    let firstTime = Number.POSITIVE_INFINITY
    let lastTime = Number.NEGATIVE_INFINITY
    let firstFrame = 0
    let previousFrame = 0
    let windowCount = 0
    let intervalFrameSum = 0
    let intervalCount = 0
    let cpuSum = 0
    let cpuCount = 0

    for (let n = 0; n < count; n++) {
      const index = (oldest + n) % this.historySize
      const time = state.times[index]
      if (time < cutoffMs) continue
      const frame = state.frames[index]
      if (windowCount === 0) {
        firstTime = time
        firstFrame = frame
      } else {
        const interval = frame - previousFrame
        intervalFrameSum += interval
        intervalCount++
        if (interval === 1) target.intervals1++
        else if (interval === 2) target.intervals2++
        else if (interval === 4) target.intervals4++
        else target.intervalsOther++
      }
      previousFrame = frame
      lastTime = time
      windowCount++
      const cpuMs = state.cpuTimes[index]
      if (Number.isFinite(cpuMs)) {
        cpuSum += cpuMs
        cpuCount++
      }
    }

    if (windowCount >= 2 && lastTime > firstTime) {
      target.updateHz = ((windowCount - 1) * 1000) / (lastTime - firstTime)
    } else if (windowCount === 1 && nowMs > firstTime) {
      target.updateHz = 1000 / Math.max(this.rateWindowMs, nowMs - firstTime)
    }
    if (intervalCount > 0) target.averageIntervalFrames = intervalFrameSum / intervalCount
    else if (windowCount === 1) target.averageIntervalFrames = Math.max(0, this.#frame - firstFrame)
    if (cpuCount > 0) target.averageCpuMs = cpuSum / cpuCount
  }
}
