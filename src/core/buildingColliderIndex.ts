// Canonical citywide building-collider service.
//
// Collider JSON is fetched and parsed once in colliderWorker, then shared by
// physics and the visual TileStreamer. Local physics work always outranks the
// much larger visual/shadow ring, and the complete fetch -> hydrate pipeline is
// bounded so a post-reveal radius expansion cannot burst dozens of callbacks
// onto the main thread.

import { yieldToFrame } from "./cooperativeWork";
import type { BuildingCollider } from "../world/tiles";

// i,p,x,y,z,hx,hy,hz,yaw,cosYaw,sinYaw,s,vol
const COLLIDER_FIELDS = 13;

// Baked OBBs can overhang their owning 800 m tile by just over 102 m. Loading
// 200 m beyond tile bounds covers the 72 m arrival-safety disk plus that
// overhang, with a small data-growth margin. This is generic map data geometry,
// not a location-specific exception.
const LOAD_REACH = 200;
const EVICT_REACH = 500;
const MAX_LOADS_PER_UPDATE = 4;
const MAX_PIPELINE_JOBS = 2;
const MAX_VISUAL_PIPELINE_JOBS = 1;
const REQUEST_TIMEOUT_MS = 8_000;
const WORKER_FETCH_TIMEOUT_MS = 6_000;
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = 220;
const HYDRATE_SLICE_MS = 1.5;
const LOCAL_PRIORITY = 0;
const VISUAL_PRIORITY = 1;

type Manifest = {
  tile: number;
  minX: number;
  minZ: number;
  tiles: Record<string, { b?: number }>;
};
type TileState = "loading" | "ready" | "failed";
type InternalTileStatus = {
  state: TileState;
  attempts: number;
  error: string | null;
  priority: number;
  version: number;
};
type WorkerReply = {
  id: number;
  buf: Float64Array | null;
  ok?: boolean;
  error?: string;
};
type LoadRequest = {
  id: number;
  key: string;
  attempt: number;
  priority: number;
  version: number;
  timer: ReturnType<typeof setTimeout>;
};
type QueuedLoad = {
  key: string;
  attempt: number;
  priority: number;
  version: number;
  sequence: number;
};
type HydrationJob = Omit<LoadRequest, "timer"> & { buf: Float64Array };
type TileListener = (key: string, colliders: BuildingCollider[]) => void;

export type BuildingColliderTileStatus = Readonly<{
  state: "unloaded" | TileState;
  settled: boolean;
  success: boolean;
  attempts: number;
  error: string | null;
}>;

export class BuildingColliderIndex {
  /** One canonical object array per resident collider tile. */
  readonly tiles = new Map<string, BuildingCollider[]>();

  /** Increments only when canonical tile content is published or retired. */
  revision = 0;

  #tileSize = 800;
  #half = 400;
  #keys: { key: string; cx: number; cz: number }[] = [];
  #knownKeys = new Set<string>();
  #expectedBuildings = new Map<string, number>();
  #status = new Map<string, InternalTileStatus>();
  #worker: Worker | null = null;
  #requests = new Map<number, LoadRequest>();
  #queue = new Map<string, QueuedLoad>();
  #hydrationQueue: HydrationJob[] = [];
  #activeHydration: HydrationJob | null = null;
  #hydrating = false;
  #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #retainedVisualKeys = new Set<string>();
  #anchorLoadKeys = new Set<string>();
  #anchorKeepKeys = new Set<string>();
  #localFailureRetry = new Set<string>();
  #listeners = new Set<TileListener>();
  #reqId = 0;
  #version = 0;
  #sequence = 0;
  #ready = false;

  async init(existingManifest?: Manifest): Promise<void> {
    let manifest = existingManifest;
    if (!manifest) {
      const response = await fetch("/data/manifest.json");
      if (!response.ok) throw new Error(`collider manifest HTTP ${response.status}`);
      manifest = (await response.json()) as Manifest;
    }
    this.#tileSize = manifest.tile;
    this.#half = manifest.tile / 2;
    for (const key of Object.keys(manifest.tiles)) {
      this.#knownKeys.add(key);
      this.#expectedBuildings.set(key, manifest.tiles[key]?.b ?? 0);
      const [ix, iz] = key.split("_").map(Number);
      this.#keys.push({
        key,
        cx: manifest.minX + ix * this.#tileSize + this.#half,
        cz: manifest.minZ + iz * this.#tileSize + this.#half
      });
    }
    this.#ready = true;
  }

  subscribe(listener: TileListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getTile(key: string): BuildingCollider[] | undefined {
    return this.tiles.get(key);
  }

  /** Keep collider metadata for an actually resident visual tile. */
  retainTile(key: string): void {
    if (!this.#knownKeys.has(key)) return;
    this.#retainedVisualKeys.add(key);
    if (this.#ready && !this.#status.has(key)) this.#startLoad(key, VISUAL_PRIORITY);
  }

  /** Release a visual lease. Local physics anchors may still retain the tile. */
  releaseTile(key: string): void {
    if (!this.#retainedVisualKeys.delete(key)) return;
    if (!this.#anchorKeepKeys.has(key)) this.#cancelAndEvict(key);
  }

  isTileSettled(key: string): boolean {
    const state = this.#status.get(key)?.state;
    return state === "ready" || state === "failed";
  }

  isTileReady(key: string): boolean {
    return this.#status.get(key)?.state === "ready";
  }

  didTileFail(key: string): boolean {
    return this.#status.get(key)?.state === "failed";
  }

  getTileStatus(key: string): BuildingColliderTileStatus {
    const status = this.#status.get(key);
    const state = status?.state ?? "unloaded";
    return {
      state,
      settled: state === "ready" || state === "failed",
      success: state === "ready",
      attempts: status?.attempts ?? 0,
      error: status?.error ?? null
    };
  }

  /** Explicit arrival recovery; explicit retries receive local priority. */
  retryTile(key: string): boolean {
    if (!this.#ready || !this.#knownKeys.has(key) || !this.didTileFail(key)) return false;
    this.#cancelAndEvict(key, false);
    this.#startLoad(key, LOCAL_PRIORITY);
    return true;
  }

  /**
   * Prime every owner tile whose bounds can contribute an OBB to the local
   * physics bubble. Point-to-AABB distance handles corners correctly. A wider
   * keep band avoids boundary churn.
   */
  update(anchors: readonly { x: number; z: number }[]): void {
    if (!this.#ready) return;
    const loadR2 = LOAD_REACH * LOAD_REACH;
    const evictR2 = EVICT_REACH * EVICT_REACH;
    this.#anchorLoadKeys.clear();
    this.#anchorKeepKeys.clear();
    let started = 0;

    for (const tile of this.#keys) {
      let min2 = Infinity;
      for (const anchor of anchors) {
        const dx = Math.max(0, Math.abs(tile.cx - anchor.x) - this.#half);
        const dz = Math.max(0, Math.abs(tile.cz - anchor.z) - this.#half);
        min2 = Math.min(min2, dx * dx + dz * dz);
      }
      if (min2 <= evictR2) this.#anchorKeepKeys.add(tile.key);
      if (min2 <= loadR2) {
        this.#anchorLoadKeys.add(tile.key);
        const status = this.#status.get(tile.key);
        if (!status && started < MAX_LOADS_PER_UPDATE) {
          this.#startLoad(tile.key, LOCAL_PRIORITY);
          started++;
        } else if (status?.state === "failed" && !this.#localFailureRetry.has(tile.key)) {
          // A visual-only failure may have happened kilometres before this tile
          // mattered to gameplay. Give its first local-demand epoch one fresh,
          // still-bounded retry cycle; remaining in range cannot loop retries.
          this.#localFailureRetry.add(tile.key);
          this.retryTile(tile.key);
        } else if (status?.state === "loading" && status.priority !== LOCAL_PRIORITY) {
          this.#setPriority(tile.key, LOCAL_PRIORITY);
        }
      }
    }

    // Cancel stale fetches from rapid cuts. A retained visual tile is demoted to
    // the single low-priority lane; work for a tile with no remaining owner is
    // discarded before it can hydrate thousands of objects.
    for (const [key, status] of [...this.#status]) {
      if (this.#anchorLoadKeys.has(key)) continue;
      if (this.#retainedVisualKeys.has(key)) {
        if (status.state === "loading" && status.priority !== VISUAL_PRIORITY) {
          this.#setPriority(key, VISUAL_PRIORITY);
        }
        continue;
      }
      if (!this.#anchorKeepKeys.has(key)) this.#cancelAndEvict(key);
    }
    for (const key of [...this.#localFailureRetry]) {
      if (!this.#anchorLoadKeys.has(key)) this.#localFailureRetry.delete(key);
    }
    this.#pump();
  }

  #startLoad(key: string, priority: number): void {
    if (!this.#ready || this.#status.has(key) || !this.#knownKeys.has(key)) return;
    const version = ++this.#version;
    this.#status.set(key, {
      state: "loading",
      attempts: 0,
      error: null,
      priority,
      version
    });
    this.#enqueue(key, 1, priority, version);
  }

  #enqueue(key: string, attempt: number, priority: number, version: number): void {
    const status = this.#status.get(key);
    if (!this.#ready || status?.state !== "loading" || status.version !== version) return;
    const prior = this.#queue.get(key);
    this.#queue.set(key, {
      key,
      attempt,
      priority: Math.min(priority, prior?.priority ?? priority),
      version,
      sequence: prior?.sequence ?? ++this.#sequence
    });
    status.priority = Math.min(status.priority, priority);
    this.#pump();
  }

  #setPriority(key: string, priority: number): void {
    const status = this.#status.get(key);
    if (status?.state !== "loading" || status.priority === priority) return;
    status.priority = priority;
    const queued = this.#queue.get(key);
    if (queued) {
      queued.priority = priority;
      this.#pump();
      return;
    }

    // A stale active network request can otherwise occupy both local lanes for
    // its full timeout. Cancel and requeue it without consuming a retry.
    for (const request of this.#requests.values()) {
      if (request.key !== key || request.version !== status.version) continue;
      clearTimeout(request.timer);
      this.#requests.delete(request.id);
      this.#postCancel(request.id);
      this.#enqueue(key, request.attempt, priority, request.version);
      return;
    }
    // A transferred payload already being cooperatively hydrated is cheap and
    // bounded; let that final stage finish instead of throwing the data away.
  }

  #pump(): void {
    if (!this.#ready) return;
    while (this.#pipelineCount() < MAX_PIPELINE_JOBS) {
      const lowCount = this.#lowPriorityPipelineCount();
      let next: QueuedLoad | null = null;
      for (const candidate of this.#queue.values()) {
        if (candidate.priority === VISUAL_PRIORITY && lowCount >= MAX_VISUAL_PIPELINE_JOBS) continue;
        if (
          !next ||
          candidate.priority < next.priority ||
          (candidate.priority === next.priority && candidate.sequence < next.sequence)
        ) next = candidate;
      }
      if (!next) return;
      this.#queue.delete(next.key);
      this.#dispatchLoad(next);
    }
  }

  #pipelineCount(): number {
    return this.#requests.size + this.#hydrationQueue.length + (this.#activeHydration ? 1 : 0);
  }

  #lowPriorityPipelineCount(): number {
    let count = 0;
    for (const request of this.#requests.values()) if (request.priority === VISUAL_PRIORITY) count++;
    for (const job of this.#hydrationQueue) if (job.priority === VISUAL_PRIORITY) count++;
    if (this.#activeHydration?.priority === VISUAL_PRIORITY) count++;
    return count;
  }

  #dispatchLoad(queued: QueuedLoad): void {
    const status = this.#status.get(queued.key);
    if (status?.state !== "loading" || status.version !== queued.version) return;
    let worker: Worker;
    try {
      worker = this.#ensureWorker();
    } catch (error) {
      this.#retryOrFail(queued.key, queued.attempt, queued.version, this.#message(error));
      return;
    }

    const id = ++this.#reqId;
    status.attempts = queued.attempt;
    status.priority = queued.priority;
    const timer = setTimeout(() => this.#onRequestTimeout(id), REQUEST_TIMEOUT_MS);
    const request: LoadRequest = { id, ...queued, timer };
    this.#requests.set(id, request);
    try {
      worker.postMessage({
        id,
        url: `/data/colliders/tile_${queued.key}.json`,
        timeoutMs: WORKER_FETCH_TIMEOUT_MS,
        maxAttempts: 1
      });
    } catch (error) {
      this.#recoverWorker(error);
    }
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("../world/colliderWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (this.#worker === worker) this.#onWorker(event.data);
    };
    worker.onerror = (event) => {
      if (this.#worker !== worker) return;
      event.preventDefault();
      this.#recoverWorker(event.error ?? new Error(event.message || "collider worker failed"));
    };
    worker.onmessageerror = () => {
      if (this.#worker === worker) this.#recoverWorker(new Error("collider worker message decode failed"));
    };
    this.#worker = worker;
    return worker;
  }

  #onWorker(data: WorkerReply): void {
    const request = this.#requests.get(data.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.#requests.delete(data.id);
    const status = this.#status.get(request.key);
    if (status?.state !== "loading" || status.version !== request.version) {
      this.#pump();
      return;
    }

    const buf = data.buf;
    const succeeded = data.ok ?? buf !== null;
    if (!succeeded || !buf) {
      this.#retryOrFail(request.key, request.attempt, request.version, data.error ?? "collider worker returned no payload");
      this.#pump();
      return;
    }
    if (buf.length % COLLIDER_FIELDS !== 0) {
      this.#retryOrFail(request.key, request.attempt, request.version, "collider payload has an invalid stride");
      this.#pump();
      return;
    }
    const count = (buf.length / COLLIDER_FIELDS) | 0;
    if (count === 0 && (this.#expectedBuildings.get(request.key) ?? 0) > 0) {
      this.#retryOrFail(request.key, request.attempt, request.version, "collider payload was empty for a building tile");
      this.#pump();
      return;
    }
    this.#hydrationQueue.push({
      id: request.id,
      key: request.key,
      attempt: request.attempt,
      priority: request.priority,
      version: request.version,
      buf
    });
    void this.#drainHydrations();
  }

  async #drainHydrations(): Promise<void> {
    if (this.#hydrating) return;
    this.#hydrating = true;
    try {
      while (this.#ready && this.#hydrationQueue.length > 0) {
        const job = this.#hydrationQueue.shift()!;
        this.#activeHydration = job;
        const status = this.#status.get(job.key);
        if (status?.state !== "loading" || status.version !== job.version) {
          this.#activeHydration = null;
          this.#pump();
          continue;
        }
        const count = (job.buf.length / COLLIDER_FIELDS) | 0;
        const list: BuildingCollider[] = new Array(count);
        let sliceStarted = performance.now();
        for (let k = 0; k < count; k++) {
          const o = k * COLLIDER_FIELDS;
          list[k] = {
            i: job.buf[o], p: job.buf[o + 1], x: job.buf[o + 2], y: job.buf[o + 3], z: job.buf[o + 4],
            hx: job.buf[o + 5], hy: job.buf[o + 6], hz: job.buf[o + 7], yaw: job.buf[o + 8],
            cosYaw: job.buf[o + 9], sinYaw: job.buf[o + 10], s: job.buf[o + 11], vol: job.buf[o + 12]
          };
          if ((k & 63) === 63 && performance.now() - sliceStarted >= HYDRATE_SLICE_MS) {
            await yieldToFrame();
            sliceStarted = performance.now();
          }
        }
        const current = this.#status.get(job.key);
        if (current?.state === "loading" && current.version === job.version) {
          this.tiles.set(job.key, list);
          this.#status.set(job.key, {
            state: "ready",
            attempts: job.attempt,
            error: null,
            priority: job.priority,
            version: job.version
          });
          this.revision++;
          for (const listener of this.#listeners) listener(job.key, list);
        }
        this.#activeHydration = null;
        this.#pump();
      }
    } finally {
      this.#activeHydration = null;
      this.#hydrating = false;
      this.#pump();
    }
  }

  #onRequestTimeout(id: number): void {
    if (!this.#requests.has(id)) return;
    this.#recoverWorker(new Error(`collider worker timed out after ${REQUEST_TIMEOUT_MS}ms`));
  }

  #recoverWorker(error: unknown): void {
    const message = this.#message(error);
    const pending = [...this.#requests.values()];
    this.#requests.clear();
    for (const request of pending) clearTimeout(request.timer);
    this.#worker?.terminate();
    this.#worker = null;
    if (!this.#ready) return;
    for (const request of pending) {
      this.#retryOrFail(request.key, request.attempt, request.version, message);
    }
    this.#pump();
  }

  #retryOrFail(key: string, attempt: number, version: number, error: string): void {
    const status = this.#status.get(key);
    if (!this.#ready || status?.state !== "loading" || status.version !== version) return;
    status.attempts = attempt;
    status.error = error;
    if (attempt >= MAX_LOAD_ATTEMPTS) {
      this.tiles.delete(key);
      this.#status.set(key, { ...status, state: "failed", attempts: attempt, error });
      console.warn(`[physics] collider tile ${key} failed after ${attempt} attempts: ${error}`);
      return;
    }

    const prior = this.#retryTimers.get(key);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.#retryTimers.delete(key);
      const current = this.#status.get(key);
      if (current?.state !== "loading" || current.version !== version) return;
      this.#enqueue(key, attempt + 1, current.priority, version);
    }, RETRY_BASE_MS * attempt);
    this.#retryTimers.set(key, timer);
  }

  #cancelAndEvict(key: string, pump = true): void {
    const status = this.#status.get(key);
    const version = status?.version;
    const timer = this.#retryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#retryTimers.delete(key);
    this.#queue.delete(key);
    for (const request of [...this.#requests.values()]) {
      if (request.key !== key || (version !== undefined && request.version !== version)) continue;
      clearTimeout(request.timer);
      this.#requests.delete(request.id);
      this.#postCancel(request.id);
    }
    for (let i = this.#hydrationQueue.length - 1; i >= 0; i--) {
      if (this.#hydrationQueue[i].key === key) this.#hydrationQueue.splice(i, 1);
    }
    const hadTile = this.tiles.delete(key);
    this.#status.delete(key);
    if (hadTile) this.revision++;
    if (pump) this.#pump();
  }

  #postCancel(id: number): void {
    try {
      this.#worker?.postMessage({ type: "cancel", id });
    } catch {
      // A later pump/recovery recreates a broken channel; cancellation is best effort.
    }
  }

  #message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  dispose(): void {
    this.#ready = false;
    for (const request of this.#requests.values()) clearTimeout(request.timer);
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#worker?.terminate();
    this.#worker = null;
    this.tiles.clear();
    this.#status.clear();
    this.#requests.clear();
    this.#queue.clear();
    this.#hydrationQueue.length = 0;
    this.#activeHydration = null;
    this.#retryTimers.clear();
    this.#retainedVisualKeys.clear();
    this.#anchorLoadKeys.clear();
    this.#anchorKeepKeys.clear();
    this.#localFailureRetry.clear();
    this.#listeners.clear();
  }
}
