// Terrain tile fetch + decode worker (M14 — docs/VOID_STREAM_REWRITE.md).
//
// spawnWorker.ts idioms: module worker, id-keyed requests, cancel via
// AbortController, bounded retries, fetch timeout. Fetches one SFTT tile
// (`/data/terrain/tile_IX_IZ.bin`, layout in
// feature-research/m14a-terrain-bake/audit.md), decodes it OFF the main thread
// (heights int16 → Float32 meters) and transfers the typed arrays back. Tiles
// install exactly once, so there is no cache.

// Module scope (spawnWorker.ts is compiled as a script; without this the two
// workers' top-level const names would collide during typecheck).
export {};

type TileFetch = {
  type: "fetch";
  id: number;
  url: string;
  ix: number;
  iz: number;
  heightBase: number;
  heightQuant: number;
};

type TileCancel = { type: "cancel"; id: number };

type TileReply =
  | {
    id: number;
    ok: true;
    ix: number;
    iz: number;
    cellsX: number;
    cellsZ: number;
    heights: Float32Array;
    surface: Uint8Array;
    deltaIndices: Uint32Array;
    deltaMm: Uint16Array;
  }
  | { id: number; ok: false; missing: boolean; error: string };

const FETCH_TIMEOUT_MS = 12_000;
const FETCH_ATTEMPTS = 2;
const FETCH_RETRY_MS = 200;
const active = new Map<number, AbortController>();
const cancelled = new Set<number>();

function decodeTile(buffer: ArrayBuffer, request: TileFetch): Omit<Extract<TileReply, { ok: true }>, "id" | "ok"> {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "SFTT") throw new Error(`Unexpected terrain tile magic "${magic}"`);
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`Unsupported terrain tile version ${version}`);
  const ix = view.getUint16(6, true);
  const iz = view.getUint16(8, true);
  if (ix !== request.ix || iz !== request.iz) {
    throw new Error(`Terrain tile index mismatch (${ix}_${iz} != ${request.ix}_${request.iz})`);
  }
  const cellsX = view.getUint16(10, true);
  const cellsZ = view.getUint16(12, true);
  const n = cellsX * cellsZ;
  if (buffer.byteLength < 14 + n * 3 + 4) throw new Error("Terrain tile truncated");
  const heights = new Float32Array(n);
  const { heightBase, heightQuant } = request;
  for (let i = 0; i < n; i++) heights[i] = heightBase + view.getInt16(14 + i * 2, true) * heightQuant;
  const surface = new Uint8Array(buffer.slice(14 + n * 2, 14 + n * 3));
  const deltaCount = view.getUint32(14 + n * 3, true);
  const deltaBase = 14 + n * 3 + 4;
  if (buffer.byteLength < deltaBase + deltaCount * 6) throw new Error("Terrain tile delta block truncated");
  const deltaIndices = new Uint32Array(deltaCount);
  const deltaMm = new Uint16Array(deltaCount);
  for (let k = 0; k < deltaCount; k++) {
    deltaIndices[k] = view.getUint32(deltaBase + k * 6, true);
    deltaMm[k] = view.getUint16(deltaBase + k * 6 + 4, true);
  }
  return { ix, iz, cellsX, cellsZ, heights, surface, deltaIndices, deltaMm };
}

async function fetchOnce(url: string, signal: AbortSignal): Promise<{ buffer: ArrayBuffer } | { missing: true }> {
  const response = await fetch(url, { signal });
  // Existence is manifest-gated, but a stale deploy may 404 (or a static SPA
  // host may return index.html) — report "missing" so the streamer fails open.
  if (response.status === 404) return { missing: true };
  if (!response.ok) throw new Error(`Terrain tile request failed (HTTP ${response.status})`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) return { missing: true };
  return { buffer: await response.arrayBuffer() };
}

async function load(url: string, signal: AbortSignal): Promise<{ buffer: ArrayBuffer } | { missing: true }> {
  let lastError: unknown = new Error("Terrain tile request failed");
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(url, signal);
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

function reply(message: TileReply, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<TileFetch | TileCancel>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled.add(message.id);
    active.get(message.id)?.abort();
    active.delete(message.id);
    setTimeout(() => cancelled.delete(message.id), 30_000);
    return;
  }

  const { id } = message;
  const controller = new AbortController();
  active.set(id, controller);
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const result = await load(message.url, controller.signal);
    if (cancelled.delete(id) || controller.signal.aborted) return;
    if ("missing" in result) {
      reply({ id, ok: false, missing: true, error: `Terrain tile ${message.ix}_${message.iz} not found` });
      return;
    }
    const decoded = decodeTile(result.buffer, message);
    reply(
      { id, ok: true, ...decoded },
      [decoded.heights.buffer, decoded.surface.buffer, decoded.deltaIndices.buffer, decoded.deltaMm.buffer]
    );
  } catch (error) {
    if (cancelled.delete(id) || controller.signal.aborted && !active.has(id)) return;
    const text = controller.signal.aborted
      ? `Terrain tile timed out after ${FETCH_TIMEOUT_MS}ms`
      : error instanceof Error ? error.message : "Terrain tile fetch failed";
    reply({ id, ok: false, missing: false, error: text });
  } finally {
    clearTimeout(timer);
    active.delete(id);
  }
};
