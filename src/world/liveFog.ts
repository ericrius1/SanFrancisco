import {
  liveFogFreshness,
  type LiveFogBias
} from "./fogWeather"
import { normalizeLiveFog, type LiveFogPayload } from "./liveFogModel"

const CACHE_KEY = "sf-live-fog-v1"
const POLL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 7000

export type LiveFogFeedMeta = {
  receivedAtMs: number
  source: string
  satellite: string
}

export type LiveFogSink = {
  acceptLiveFog(bias: LiveFogBias, meta: LiveFogFeedMeta): void
  setLiveFogStatus(
    status: "procedural" | "loading" | "live" | "stale" | "offline",
    detail: string
  ): void
}

function readCachedPayload(): LiveFogPayload | null {
  try {
    const payload = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as LiveFogPayload | null
    if (!payload || payload.version !== 1) return null
    const bias = normalizeLiveFog(payload)
    if (!bias || liveFogFreshness(bias, Date.now()) <= 0) return null
    return payload
  } catch {
    return null
  }
}

function saveCachedPayload(payload: LiveFogPayload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
  } catch {
    // Privacy mode/quota: weather remains live for this session.
  }
}

function sourceLabel(payload: LiveFogPayload): string {
  const sources = Object.entries(payload.sources)
    .filter(([, source]) => source.ok)
    .map(([name]) => name === "nwsGrid" ? "NWS" : name === "metar" ? "METAR" : name)
  return sources.length ? sources.join(" + ") : "live weather"
}

function applyPayload(sink: LiveFogSink, payload: LiveFogPayload, cached: boolean) {
  const bias = normalizeLiveFog(payload)
  if (!bias) throw new Error("live weather response had no usable fresh fog readings")
  sink.acceptLiveFog(bias, {
    receivedAtMs: Date.now(),
    source: sourceLabel(payload),
    satellite: payload.satellite?.available ? "GOES mask" : "GOES mask pending"
  })
  sink.setLiveFogStatus(
    payload.stale ? "stale" : "live",
    `${bias.label}${cached ? " · local cache" : ""}`
  )
}

/**
 * Begin the optional post-reveal feed. Procedural weather is already rendering;
 * neither this module nor its request participates in the boot critical path.
 */
export function startLiveFogFeed(sink: LiveFogSink): () => void {
  let stopped = false
  let timer = 0
  let polling = false
  let request: AbortController | null = null

  const cached = readCachedPayload()
  if (cached) {
    try {
      applyPayload(sink, cached, true)
    } catch {
      sink.setLiveFogStatus("procedural", "cached weather was unusable")
    }
  } else {
    sink.setLiveFogStatus("loading", "procedural now · requesting SF observations")
  }

  const schedule = () => {
    if (stopped) return
    window.clearTimeout(timer)
    const jitter = 0.9 + Math.random() * 0.2
    timer = window.setTimeout(() => void poll(), POLL_MS * jitter)
  }

  const poll = async () => {
    if (stopped || polling) return
    if (document.visibilityState === "hidden") {
      schedule()
      return
    }
    polling = true
    const controller = new AbortController()
    request = controller
    const timeout = window.setTimeout(() => controller.abort("weather timeout"), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch("/api/weather/fog", { signal: controller.signal })
      if (!response.ok) throw new Error(`weather endpoint ${response.status}`)
      const payload = await response.json() as LiveFogPayload
      applyPayload(sink, payload, false)
      saveCachedPayload(payload)
    } catch (error) {
      if (!stopped) {
        sink.setLiveFogStatus(
          "offline",
          `last good fades to procedural · ${error instanceof Error ? error.message : "request failed"}`
        )
      }
    } finally {
      window.clearTimeout(timeout)
      if (request === controller) request = null
      polling = false
      schedule()
    }
  }

  const resume = () => {
    if (stopped || document.visibilityState === "hidden" || polling) return
    window.clearTimeout(timer)
    void poll()
  }
  window.addEventListener("online", resume)
  document.addEventListener("visibilitychange", resume)
  void poll()

  return () => {
    stopped = true
    window.clearTimeout(timer)
    request?.abort("weather feed stopped")
    window.removeEventListener("online", resume)
    document.removeEventListener("visibilitychange", resume)
  }
}
