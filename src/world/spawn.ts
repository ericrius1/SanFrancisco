import type { WorldMap } from "./heightmap";

type SpawnPoint = { x: number; z: number; heading: number };
type ManifestLike = {
  tile: number;
  minX: number;
  minZ: number;
  tiles?: Record<string, unknown>;
};
type SpawnWaiter = {
  resolve: (selected: number) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

let worker: Worker | null = null;
let requestId = 0;
const waiters = new Map<number, SpawnWaiter>();
const abortError = () => new DOMException("Spawn resolution superseded", "AbortError");
const SPAWN_QUERY_TIMEOUT_MS = 15_000;

function rejectAllSpawnWaiters(error: unknown): void {
  for (const waiter of waiters.values()) {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    waiter.reject(error);
  }
  waiters.clear();
  worker?.terminate();
  worker = null;
}

function spawnWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./spawnWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<
    { id: number; ok: true; selected: number } | { id: number; ok: false; error: string }
  >) => {
    const waiter = waiters.get(event.data.id);
    if (!waiter) return;
    waiters.delete(event.data.id);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    if (event.data.ok) waiter.resolve(event.data.selected);
    else waiter.reject(new Error(event.data.error));
  };
  worker.onerror = (event) => {
    event.preventDefault();
    rejectAllSpawnWaiters(event.error ?? new Error(event.message || "Spawn worker failed"));
  };
  worker.onmessageerror = () => rejectAllSpawnWaiters(new Error("Spawn worker response could not be decoded"));
  return worker;
}

function querySpawn(urls: string[], candidates: Float64Array, clearance: number, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) return Promise.reject(abortError());
  const id = ++requestId;
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiter = waiters.get(id);
      if (!waiter) return;
      waiters.delete(id);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      try { worker?.postMessage({ type: "cancel", id }); } catch { /* worker is already gone */ }
      reject(new Error(`Spawn resolution timed out after ${SPAWN_QUERY_TIMEOUT_MS}ms`));
    }, SPAWN_QUERY_TIMEOUT_MS);
    const waiter: SpawnWaiter = { resolve, reject, timer, signal };
    if (signal) {
      waiter.abort = () => {
        if (!waiters.delete(id)) return;
        clearTimeout(timer);
        try { worker?.postMessage({ type: "cancel", id }); } catch { /* worker is already gone */ }
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
    }
    waiters.set(id, waiter);
    try {
      spawnWorker().postMessage({ type: "query", id, urls, candidates, clearance }, [candidates.buffer]);
    } catch (error) {
      clearTimeout(timer);
      waiters.delete(id);
      if (signal && waiter.abort) signal.removeEventListener("abort", waiter.abort);
      reject(error);
    }
  });
}

/** Resolve a point onto open ground without collider fetch/parse/search work on the main thread. */
export async function findOpenSpawn(
  map: WorldMap,
  manifest: ManifestLike,
  want: SpawnPoint,
  clearance = 12,
  maxRadius = 200,
  options: { signal?: AbortSignal } = {}
): Promise<SpawnPoint> {
  const ix = Math.floor((want.x - manifest.minX) / manifest.tile);
  const iz = Math.floor((want.z - manifest.minZ) / manifest.tile);
  const urls: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const key = `${ix + dx}_${iz + dz}`;
      // Static SPA hosts commonly return index.html with HTTP 200 for an absent
      // edge neighbour. The visual manifest is the authoritative existence
      // index, so never ask the worker to parse those fallback pages as JSON.
      if (!manifest.tiles || key in manifest.tiles) urls.push(`/data/colliders/tile_${key}.json`);
    }
  }

  const points: { x: number; z: number; bridge: boolean }[] = [];
  const addCandidate = (x: number, z: number) => {
    const bridge = map.bridgeDeck(x, z) > -Infinity;
    if (bridge || !map.isWater(x, z)) points.push({ x, z, bridge });
  };
  addCandidate(want.x, want.z);
  for (let radius = 3; radius <= maxRadius; radius += 3) {
    for (let step = 0; step < 24; step++) {
      const angle = (step / 24) * Math.PI * 2;
      addCandidate(want.x + Math.cos(angle) * radius, want.z + Math.sin(angle) * radius);
    }
  }
  if (points.length === 0) {
    throw new Error(`No non-water spawn candidate found within ${maxRadius}m`);
  }

  const candidates = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const offset = i * 3;
    candidates[offset] = point.x;
    candidates[offset + 1] = point.z;
    candidates[offset + 2] = point.bridge ? 1 : 0;
  }
  const selected = await querySpawn(urls, candidates, clearance, options.signal);
  const point = selected >= 0 ? points[selected] : null;
  if (!point) throw new Error(`No movement-safe spawn found within ${maxRadius}m`);
  return { x: point.x, z: point.z, heading: want.heading };
}
