/**
 * Cached Starlink GP (general perturbations) element sets from CelesTrak.
 * Served to the client as JSON OMM records for SGP4 propagation.
 *
 * Prefer SpaceX-derived supplemental Starlink data (more timely than radar
 * catalog fits). Fall back to the catalog GROUP dump. CelesTrak asks clients
 * to keep responses for ~2 hours — we honor that and serve stale on failure.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CACHE_PATH = path.join(ROOT, "..", ".data", "starlink-gp-cache.json")

const FETCH_TIMEOUT_MS = 20_000
const FRESH_MS = 2 * 60 * 60 * 1000
const STALE_MS = 24 * 60 * 60 * 1000
const MAX_BYTES = 12 * 1024 * 1024
const USER_AGENT =
  process.env.SF_STARLINK_USER_AGENT ||
  "sanfrancisco-open-world/0.1 (realtime starlink sky; set SF_STARLINK_USER_AGENT for contact)"

const SOURCES = [
  {
    id: "sup-starlink",
    url: "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=JSON"
  },
  {
    id: "gp-starlink",
    url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=JSON"
  }
]

/** @type {{ body: string, fetchedAtMs: number, source: string, count: number } | null} */
let memory = null
/** @type {Promise<{ body: string, fetchedAtMs: number, source: string, count: number }> | null} */
let inflight = null
let lastFailureLog = 0

function isOmmArray(value) {
  return Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === "object"
}

async function readDiskCache() {
  try {
    const text = await readFile(CACHE_PATH, "utf8")
    const parsed = JSON.parse(text)
    if (
      !parsed ||
      typeof parsed.body !== "string" ||
      typeof parsed.fetchedAtMs !== "number" ||
      !isOmmArray(JSON.parse(parsed.body))
    ) {
      return null
    }
    return {
      body: parsed.body,
      fetchedAtMs: parsed.fetchedAtMs,
      source: typeof parsed.source === "string" ? parsed.source : "disk",
      count: Number(parsed.count) || 0
    }
  } catch {
    return null
  }
}

async function writeDiskCache(entry) {
  try {
    await mkdir(path.dirname(CACHE_PATH), { recursive: true })
    await writeFile(
      CACHE_PATH,
      JSON.stringify({
        fetchedAtMs: entry.fetchedAtMs,
        source: entry.source,
        count: entry.count,
        body: entry.body
      })
    )
  } catch {
    // Privacy mode / read-only deploy: memory cache still serves the session.
  }
}

async function fetchSource(source) {
  const response = await fetch(source.url, {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT
    },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`${source.id} ${response.status}`)
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`${source.id} too large`)
  // CelesTrak returns a plaintext note when the GROUP dump has not changed
  // since the caller's last download — treat that as a soft failure.
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    throw new Error(`${source.id} non-json (${trimmed.slice(0, 48).replace(/\s+/g, " ")})`)
  }
  const data = JSON.parse(text)
  if (!isOmmArray(data)) throw new Error(`${source.id} empty`)
  return {
    body: JSON.stringify(data),
    fetchedAtMs: Date.now(),
    source: source.id,
    count: data.length
  }
}

async function refresh() {
  let lastError = null
  for (const source of SOURCES) {
    try {
      const entry = await fetchSource(source)
      memory = entry
      void writeDiskCache(entry)
      return entry
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error("starlink sources unavailable")
}

/**
 * @returns {Promise<{ body: string, fetchedAtMs: number, source: string, count: number, stale: boolean }>}
 */
export async function starlinkGpPayload() {
  const now = Date.now()
  if (memory && now - memory.fetchedAtMs < FRESH_MS) {
    return { ...memory, stale: false }
  }
  if (!memory) memory = await readDiskCache()
  if (memory && now - memory.fetchedAtMs < FRESH_MS) {
    return { ...memory, stale: false }
  }
  if (inflight) return inflight.then((entry) => ({ ...entry, stale: false }))

  inflight = (async () => {
    try {
      return await refresh()
    } catch (error) {
      if (memory && now - memory.fetchedAtMs < STALE_MS) return memory
      const disk = memory ?? (await readDiskCache())
      if (disk && now - disk.fetchedAtMs < STALE_MS) {
        memory = disk
        return disk
      }
      if (now - lastFailureLog > 60_000) {
        lastFailureLog = now
        console.warn("[starlink] GP feed unavailable:", error)
      }
      throw error
    } finally {
      inflight = null
    }
  })()

  const entry = await inflight
  return { ...entry, stale: now - entry.fetchedAtMs >= FRESH_MS }
}
