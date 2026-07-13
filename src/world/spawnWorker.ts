type SpawnQuery = {
  type: "query";
  id: number;
  urls: string[];
  candidates: Float64Array;
  clearance: number;
};

type SpawnCancel = { type: "cancel"; id: number };

type RawCollider = { x: number; z: number; hx: number; hz: number; yaw: number };
type Collider = RawCollider & { cos: number; sin: number };
type SpawnReply =
  | { id: number; ok: true; selected: number }
  | { id: number; ok: false; error: string };

const CELL = 64;
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_ATTEMPTS = 2;
const FETCH_RETRY_MS = 180;
const MAX_CACHE_ENTRIES = 48;
// Only resolved data is cached. An in-flight fetch belongs to its query and can
// therefore be aborted immediately when a newer teleport supersedes it.
const cache = new Map<string, Collider[]>();
const active = new Map<number, AbortController>();
const cancelled = new Set<number>();

function cacheGet(url: string): Collider[] | undefined {
  const value = cache.get(url);
  if (!value) return undefined;
  cache.delete(url);
  cache.set(url, value);
  return value;
}

function cachePut(url: string, value: Collider[]): void {
  cache.delete(url);
  cache.set(url, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function loadOnce(url: string, signal: AbortSignal): Promise<Collider[]> {
  const cached = cacheGet(url);
  if (cached) return cached;
  const response = await fetch(url, { signal });
  // Edge-of-map neighbours legitimately do not exist.
  if (response.status === 404) {
    cachePut(url, []);
    return [];
  }
  if (!response.ok) throw new Error(`Collider request failed (HTTP ${response.status})`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    // Vite/static-host history fallback for a nonexistent edge tile.
    cachePut(url, []);
    return [];
  }
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error("Collider response was not an array");
  const colliders = (raw as RawCollider[]).map((c) => ({
    ...c,
    cos: Math.cos(c.yaw),
    sin: Math.sin(c.yaw)
  }));
  cachePut(url, colliders);
  return colliders;
}

async function load(url: string, signal: AbortSignal): Promise<Collider[]> {
  let lastError: unknown = new Error("Collider request failed");
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await loadOnce(url, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(done, FETCH_RETRY_MS * attempt);
          signal.addEventListener("abort", aborted, { once: true });
          function done() {
            signal.removeEventListener("abort", aborted);
            resolve();
          }
          function aborted() {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          }
        });
      }
    }
  }
  throw lastError;
}

const cellKey = (ix: number, iz: number) => `${ix}:${iz}`;

function buildIndex(colliders: Collider[], clearance: number): Map<string, Collider[]> {
  const cells = new Map<string, Collider[]>();
  for (const collider of colliders) {
    const ex = Math.abs(collider.cos) * collider.hx + Math.abs(collider.sin) * collider.hz + clearance;
    const ez = Math.abs(collider.sin) * collider.hx + Math.abs(collider.cos) * collider.hz + clearance;
    const minX = Math.floor((collider.x - ex) / CELL);
    const maxX = Math.floor((collider.x + ex) / CELL);
    const minZ = Math.floor((collider.z - ez) / CELL);
    const maxZ = Math.floor((collider.z + ez) / CELL);
    for (let ix = minX; ix <= maxX; ix++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        const key = cellKey(ix, iz);
        const list = cells.get(key);
        if (list) list.push(collider);
        else cells.set(key, [collider]);
      }
    }
  }
  return cells;
}

function openAt(index: Map<string, Collider[]>, x: number, z: number, clearance: number): boolean {
  const nearby = index.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!nearby) return true;
  for (const collider of nearby) {
    const dx = x - collider.x;
    const dz = z - collider.z;
    const lx = Math.abs(dx * collider.cos - dz * collider.sin) - collider.hx;
    const lz = Math.abs(dx * collider.sin + dz * collider.cos) - collider.hz;
    if (Math.max(lx, lz) < clearance) return false;
  }
  return true;
}

function reply(message: SpawnReply): void {
  (self as unknown as Worker).postMessage(message);
}

self.onmessage = async (event: MessageEvent<SpawnQuery | SpawnCancel>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled.add(message.id);
    active.get(message.id)?.abort();
    active.delete(message.id);
    // Bound the response-race tombstone rather than retaining one id per cut.
    setTimeout(() => cancelled.delete(message.id), 30_000);
    return;
  }

  const { id, urls, candidates, clearance } = message;
  const controller = new AbortController();
  active.set(id, controller);
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const colliders = (await Promise.all(urls.map((url) => load(url, controller.signal)))).flat();
    if (cancelled.delete(id) || controller.signal.aborted) return;
    const index = buildIndex(colliders, clearance);
    let selected = -1;
    for (let i = 0; i < candidates.length; i += 3) {
      if (candidates[i + 2] > 0 || openAt(index, candidates[i], candidates[i + 1], clearance)) {
        selected = i / 3;
        break;
      }
    }
    if (!cancelled.delete(id)) reply({ id, ok: true, selected });
  } catch (error) {
    if (cancelled.delete(id) || controller.signal.aborted && !active.has(id)) return;
    const message = controller.signal.aborted
      ? `Spawn validation timed out after ${FETCH_TIMEOUT_MS}ms`
      : error instanceof Error ? error.message : "Spawn validation failed";
    reply({ id, ok: false, error: message });
  } finally {
    clearTimeout(timer);
    active.delete(id);
  }
};
