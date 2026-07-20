// Terrain tile streamer (M14 — docs/VOID_STREAM_REWRITE.md "Data-concentric
// world").
//
// Drives the terrainTileWorker: nearest-first outward from the ring
// coordinator's focus (the anchor set at spawn / teleport commit) and the live
// player position, in-flight cap 4, anchor 3×3 absolute priority. Decoded
// tiles land in a queue and install bounded — at most ONE tile's CPU write +
// clipmap GPU sub-rect install per update() call — so streaming never owns a
// frame. `map.terrainResidentRadiusAround` (fed by these installs) joins the
// ring coordinator's residency min, so the materialize front never sweeps
// onto overview-only ground.
import type * as THREE from "three/webgpu";
import { CONFIG } from "../config";
import { tracer } from "../core/hitchTracer";
import { prefetched, type TerrainTileData, type WorldMap } from "./heightmap";
import type { TerrainClipmap } from "./terrainClipmap";

type TerrainManifest = {
  tile: number;
  tilesX: number;
  tilesZ: number;
  tiles: Record<string, { bytes: number }>;
};

type WorkerReply =
  | ({ id: number; ok: true } & TerrainTileData & { ix: number; iz: number })
  | { id: number; ok: false; missing: boolean; error: string };

const MAX_IN_FLIGHT = 4;
// Fetch reach around the sweep focus: comfortably beyond the ring
// coordinator's SETTLE_CAP + SETTLE_OVERSHOOT so terrain residency never
// becomes the reason a sweep cannot settle.
const FOCUS_STREAM_RADIUS = 3980;
// Fetch reach around the live player, beyond the visual draw ring.
const PLAYER_STREAM_MARGIN = 400;
// Installs whose tile rect lies within this range of the player or anchor are
// physics-relevant: commit the coalesced groundRevision bump so the carpet /
// terrain patch re-place on the promoted ground. Distant installs discard the
// bump — the next carpet recenter samples the fresh lattice anyway — so a
// streaming session cannot rebuild the physics patch every frame.
const REVISION_BUMP_RADIUS = 1200;
// Priority order recompute cadence, in update() calls (~0.5 s at 60 Hz).
const ORDER_REFRESH_CALLS = 30;
const MAX_CLIENT_ATTEMPTS = 3;
// Manifest fetch retries (network-blip tolerance) before the terminal
// fail-open. Backoff: 1 s, 2 s between attempts.
const MANIFEST_ATTEMPTS = 3;
// Tiles marked unavailable by transient fetch failures are re-probed on this
// cadence (and on every re-anchor) so an offline blip cannot pin overview
// ground for the whole session.
const UNAVAILABLE_REPROBE_MS = 60_000;
// Bounded re-attempts for a failed clipmap GPU sub-rect install (item: an
// exception mid-applyTileRegion must not leave the GPU on overview forever).
const MAX_GPU_INSTALL_ATTEMPTS = 3;

export class TerrainTileStreamer {
  readonly #map: WorldMap;
  readonly #clipmap: TerrainClipmap;
  readonly #renderer: THREE.WebGPURenderer;
  readonly #onAnchorInstalled: (() => void) | null;
  #manifest: TerrainManifest | null = null;
  #manifestFailed = false;
  #worker: Worker | null = null;
  #requestId = 0;
  #inFlight = new Map<number, { key: string; ix: number; iz: number }>();
  #requested = new Set<string>(); // in-flight or decoded-awaiting-install
  #decoded: ({ ix: number; iz: number } & TerrainTileData)[] = [];
  #attempts = new Map<string, number>();
  // Session-transient unavailable marks (fetch failures) — recoverable, unlike
  // #manifestAbsent (keys the manifest itself does not list — permanent).
  #unavailable = new Map<string, { ix: number; iz: number }>();
  #manifestAbsent = new Set<string>();
  #lastUnavailableReprobeAt = 0;
  // Failed GPU sub-rect installs awaiting a bounded retry (CPU lattice already
  // holds the real tile; only the clipmap blit needs re-running).
  #gpuRetryQueue: { ix: number; iz: number }[] = [];
  #gpuRetryAttempts = new Map<string, number>();
  // Revision-bump coalescing across an install burst (anchor-ring tiles can
  // install several times inside one task): flushed once per microtask.
  #bumpFlushQueued = false;
  #burstWantsCommit = false;
  #anchorX = Number.NaN;
  #anchorZ = Number.NaN;
  #anchorKey: string | null = null;
  #anchorRing = new Set<string>();
  #anchorInstalledFired = false;
  #order: { ix: number; iz: number }[] = [];
  #orderStale = true;
  #callsSinceOrder = 0;
  #playerX = Number.NaN;
  #playerZ = Number.NaN;
  #installed = 0;
  #lastInstallMs = 0;

  constructor(options: {
    map: WorldMap;
    clipmap: TerrainClipmap;
    renderer: THREE.WebGPURenderer;
    /** Fired once, when the anchor (spawn) tile itself installs — bootMark("spawnTile"). */
    onAnchorInstalled?: () => void;
  }) {
    this.#map = options.map;
    this.#clipmap = options.clipmap;
    this.#renderer = options.renderer;
    this.#onAnchorInstalled = options.onAnchorInstalled ?? null;
    void this.#loadManifest();
  }

  /** Manifest fetch with bounded retries; terminal failure FAILS OPEN. */
  async #loadManifest(): Promise<void> {
    const url = "/data/terrain/terrain-manifest.json";
    for (let attempt = 0; attempt < MANIFEST_ATTEMPTS; attempt++) {
      try {
        const r = attempt === 0 ? await prefetched(url) : await fetch(url, { cache: "no-cache" });
        if (!r.ok) throw new Error(`terrain manifest HTTP ${r.status}`);
        const manifest = (await r.json()) as TerrainManifest;
        this.#manifest = manifest;
        this.#markManifestAbsent(manifest);
        this.#orderStale = true;
        this.#schedule();
        return;
      } catch (error) {
        if (attempt === MANIFEST_ATTEMPTS - 1) {
          // Terminal manifest failure: FAIL OPEN. Flipping terrainStreaming
          // off makes every isTileReal* query true and the resident radius
          // uncapped, so the boot spawn hold / far-arrival ground waits
          // release onto the overview ground (same story as a tile 404) —
          // the player must never be pinned at the load screen by a missing
          // manifest. update() no-ops from here on.
          this.#manifestFailed = true;
          this.#map.terrainStreaming = false;
          console.error(
            "[terrain-tiles] terrain manifest unavailable after " +
              `${MANIFEST_ATTEMPTS} attempts — failing open onto overview terrain ` +
              "(real 800 m tiles will NOT stream this session)",
            error
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  /** Any grid tile the manifest does not list can never be fetched — mark it
   *  unavailable immediately (fail open) so ground gating and the materialize
   *  front never wait on a key that will never arrive. Permanent (excluded
   *  from the transient-unavailable recovery). */
  #markManifestAbsent(manifest: TerrainManifest): void {
    const meta = this.#map.meta;
    const { width, height, cellSize } = meta.grid;
    const cells = Math.round(meta.tile / cellSize);
    let absent = 0;
    for (let iz = 0; iz < meta.tilesZ; iz++) {
      for (let ix = 0; ix < meta.tilesX; ix++) {
        if (ix * cells >= width || iz * cells >= height) continue;
        const key = `${ix}_${iz}`;
        if (manifest.tiles[key]) continue;
        this.#manifestAbsent.add(key);
        this.#map.markTileUnavailable(ix, iz);
        absent++;
      }
    }
    if (absent > 0) {
      console.error(
        `[terrain-tiles] manifest missing ${absent} grid tile${absent === 1 ? "" : "s"} — ` +
          "failing open onto overview ground for those regions"
      );
    }
  }

  /** Largest fully-real-terrain radius around (x, z); joins ring residency. */
  residentRadiusAround(x: number, z: number): number {
    return this.#map.terrainResidentRadiusAround(x, z);
  }

  /**
   * Re-anchor at a spawn / teleport destination: the anchor tile + its 3×3
   * ring take absolute priority, and in-flight fetches outside the new ring
   * are aborted (per-focus generation, M4 pattern) so the destination's
   * bandwidth is never spent finishing the previous focus first.
   */
  setAnchor(x: number, z: number): void {
    // A focus change is a natural recovery point: give transiently-failed
    // tiles a fresh chance before the destination's ground wait gates on them.
    this.#recoverUnavailable();
    this.#anchorX = x;
    this.#anchorZ = z;
    const { ix, iz } = this.#map.tileIndexAt(x, z);
    this.#anchorKey = `${ix}_${iz}`;
    this.#anchorRing.clear();
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.#anchorRing.add(`${ix + dx}_${iz + dz}`);
      }
    }
    for (const [id, entry] of [...this.#inFlight]) {
      if (this.#anchorRing.has(entry.key)) continue;
      this.#worker?.postMessage({ type: "cancel", id });
      this.#inFlight.delete(id);
      this.#requested.delete(entry.key);
    }
    this.#orderStale = true;
    this.#schedule();
  }

  /**
   * Per-frame driver (ringUpdate path). Installs at most one decoded tile,
   * then tops the fetch pipeline back up.
   */
  update(playerX: number, playerZ: number): void {
    if (!this.#map.terrainStreaming || this.#manifestFailed) return;
    this.#playerX = playerX;
    this.#playerZ = playerZ;
    // Slow re-probe of transiently-unavailable tiles (offline blip recovery).
    if (this.#unavailable.size > 0) {
      const now = performance.now();
      if (now - this.#lastUnavailableReprobeAt >= UNAVAILABLE_REPROBE_MS) {
        this.#lastUnavailableReprobeAt = now;
        this.#recoverUnavailable();
      }
    }
    // A pending GPU-blit retry consumes this frame's install budget.
    const gpuRetry = this.#gpuRetryQueue.shift();
    if (gpuRetry) {
      this.#applyGpuRegion(gpuRetry.ix, gpuRetry.iz);
    } else {
      const next = this.#decoded.shift();
      if (next) this.#install(next);
    }
    if (++this.#callsSinceOrder >= ORDER_REFRESH_CALLS) this.#orderStale = true;
    this.#schedule();
  }

  /** Reverse every transient markTileUnavailable (manifest-absent keys stay):
   *  the tiles rejoin the wanted set and refetch with a fresh attempt budget. */
  #recoverUnavailable(): void {
    if (this.#unavailable.size === 0) return;
    for (const [key, tile] of this.#unavailable) {
      if (this.#manifestAbsent.has(key)) continue; // permanent — never re-probe
      this.#map.clearTileUnavailable(tile.ix, tile.iz);
      this.#attempts.delete(key);
    }
    this.#unavailable.clear();
    this.#orderStale = true;
  }

  debug(): {
    installed: number;
    real: number;
    inFlight: number;
    queued: number;
    lastInstallMs: number;
  } {
    return {
      installed: this.#installed,
      real: this.#map.realTileCount,
      inFlight: this.#inFlight.size,
      queued: this.#decoded.length,
      lastInstallMs: Number(this.#lastInstallMs.toFixed(2))
    };
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("./terrainTileWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => this.#onReply(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      console.warn("[terrain-tiles] worker error", event.message);
      // Drop the in-flight book-keeping; the scheduler re-requests (bounded
      // by the per-tile attempt budget).
      for (const entry of this.#inFlight.values()) this.#requested.delete(entry.key);
      this.#inFlight.clear();
    };
    this.#worker = worker;
    return worker;
  }

  #onReply(reply: WorkerReply): void {
    const entry = this.#inFlight.get(reply.id);
    if (!entry) return;
    this.#inFlight.delete(reply.id);
    if (reply.ok) {
      // Anchor-ring tiles (≤9, spawn/teleport-critical) install the moment
      // they decode instead of waiting for the next ringUpdate tick — boot
      // control and far-arrival ground waits gate on the anchor tile being
      // REAL, and during boot the provisional loop may not be ticking yet.
      // Everything else keeps the strict one-install-per-frame budget.
      if (this.#anchorRing.has(entry.key)) this.#install(reply);
      else this.#decoded.push(reply);
      return;
    }
    this.#requested.delete(entry.key);
    const attempts = (this.#attempts.get(entry.key) ?? 0) + 1;
    this.#attempts.set(entry.key, attempts);
    if (reply.missing || attempts >= MAX_CLIENT_ATTEMPTS) {
      // Fail open: accept the overview data as final for this tile so ground
      // gating and the materialize front can never hang on absent data.
      console.warn(`[terrain-tiles] tile ${entry.key} unavailable (${reply.error}) — keeping overview ground`);
      this.#map.markTileUnavailable(entry.ix, entry.iz);
      // Recoverable: cleared on re-anchor / the slow re-probe (a genuinely
      // missing tile just re-marks itself after the next attempt budget).
      this.#unavailable.set(entry.key, { ix: entry.ix, iz: entry.iz });
    }
  }

  #tileRectDistance(ix: number, iz: number, x: number, z: number): number {
    const grid = this.#map.meta.grid;
    const tileMeters = this.#map.meta.tile;
    const cells = Math.round(tileMeters / grid.cellSize);
    const x0 = grid.minX + ix * tileMeters;
    const x1 = grid.minX + Math.min(grid.width, (ix + 1) * cells) * grid.cellSize;
    const z0 = grid.minZ + iz * tileMeters;
    const z1 = grid.minZ + Math.min(grid.height, (iz + 1) * cells) * grid.cellSize;
    const dx = Math.max(x0 - x, x - x1, 0);
    const dz = Math.max(z0 - z, z - z1, 0);
    return Math.hypot(dx, dz);
  }

  #refreshOrder(): void {
    const manifest = this.#manifest;
    if (!manifest) return;
    this.#orderStale = false;
    this.#callsSinceOrder = 0;
    const hasAnchor = Number.isFinite(this.#anchorX);
    const hasPlayer = Number.isFinite(this.#playerX);
    const playerRadius = CONFIG.tileLoadRadius + PLAYER_STREAM_MARGIN;
    const wanted: { ix: number; iz: number; d: number }[] = [];
    for (const key of Object.keys(manifest.tiles)) {
      const [ix, iz] = key.split("_").map(Number);
      if (this.#map.isTileReal(ix, iz) || this.#requested.has(key)) continue;
      let d = Infinity;
      if (hasAnchor) {
        const focusDistance = this.#tileRectDistance(ix, iz, this.#anchorX, this.#anchorZ);
        if (focusDistance <= FOCUS_STREAM_RADIUS) d = focusDistance;
      }
      if (hasPlayer) {
        const playerDistance = this.#tileRectDistance(ix, iz, this.#playerX, this.#playerZ);
        if (playerDistance <= playerRadius) d = Math.min(d, playerDistance);
      }
      if (!Number.isFinite(d)) continue;
      if (this.#anchorRing.has(key)) d -= key === this.#anchorKey ? 2e6 : 1e6;
      wanted.push({ ix, iz, d });
    }
    wanted.sort((a, b) => a.d - b.d);
    this.#order = wanted;
  }

  #schedule(): void {
    const manifest = this.#manifest;
    if (!manifest) return;
    if (this.#orderStale) this.#refreshOrder();
    while (this.#inFlight.size < MAX_IN_FLIGHT && this.#order.length > 0) {
      const next = this.#order.shift()!;
      const key = `${next.ix}_${next.iz}`;
      if (this.#map.isTileReal(next.ix, next.iz) || this.#requested.has(key)) continue;
      const terrain = this.#map.meta.terrain;
      if (!terrain) return;
      const id = ++this.#requestId;
      this.#requested.add(key);
      this.#inFlight.set(id, { key, ix: next.ix, iz: next.iz });
      this.#ensureWorker().postMessage({
        type: "fetch",
        id,
        url: `/data/terrain/tile_${key}.bin`,
        ix: next.ix,
        iz: next.iz,
        heightBase: terrain.heightBase,
        heightQuant: terrain.heightQuant
      });
    }
  }

  #install(tile: { ix: number; iz: number } & TerrainTileData): void {
    const key = `${tile.ix}_${tile.iz}`;
    this.#requested.delete(key);
    if (this.#map.isTileReal(tile.ix, tile.iz)) return;
    this.#map.installTile(tile.ix, tile.iz, tile);
    this.#applyGpuRegion(tile.ix, tile.iz);
    tracer.count("terrainTileInstall");
    this.#installed++;
    const nearPlayer = Number.isFinite(this.#playerX) &&
      this.#tileRectDistance(tile.ix, tile.iz, this.#playerX, this.#playerZ) < REVISION_BUMP_RADIUS;
    const nearAnchor = Number.isFinite(this.#anchorX) &&
      this.#tileRectDistance(tile.ix, tile.iz, this.#anchorX, this.#anchorZ) < REVISION_BUMP_RADIUS;
    // Coalesce: an anchor-ring decode burst can install several tiles inside
    // one task — flush a SINGLE commit/discard at the end of the burst
    // (microtask) instead of one bump per install.
    this.#burstWantsCommit ||= nearPlayer || nearAnchor;
    if (!this.#bumpFlushQueued) {
      this.#bumpFlushQueued = true;
      queueMicrotask(() => {
        this.#bumpFlushQueued = false;
        const commit = this.#burstWantsCommit;
        this.#burstWantsCommit = false;
        if (commit) this.#map.commitRevisionBump();
        else this.#map.discardRevisionBump();
      });
    }
    if (!this.#anchorInstalledFired && key === this.#anchorKey) {
      this.#anchorInstalledFired = true;
      this.#onAnchorInstalled?.();
    }
  }

  /** Clipmap GPU sub-rect install with exception safety: the CPU lattice is
   *  already the source of truth (installTile ran), so a throw here re-queues
   *  a bounded GPU-only retry instead of silently leaving the clipmap on
   *  overview data (CPU/GPU lockstep break). */
  #applyGpuRegion(ix: number, iz: number): void {
    const key = `${ix}_${iz}`;
    const cells = Math.round(this.#map.meta.tile / this.#map.meta.grid.cellSize);
    try {
      this.#lastInstallMs = this.#clipmap.applyTileRegion(
        this.#renderer,
        ix * cells,
        iz * cells,
        Math.min(cells, this.#map.meta.grid.width - ix * cells),
        Math.min(cells, this.#map.meta.grid.height - iz * cells)
      );
      this.#gpuRetryAttempts.delete(key);
    } catch (error) {
      const attempts = (this.#gpuRetryAttempts.get(key) ?? 0) + 1;
      this.#gpuRetryAttempts.set(key, attempts);
      if (attempts < MAX_GPU_INSTALL_ATTEMPTS) {
        console.warn(`[terrain-tiles] clipmap install failed for ${key} (attempt ${attempts}) — retrying`, error);
        this.#gpuRetryQueue.push({ ix, iz });
      } else {
        console.error(
          `[terrain-tiles] clipmap install failed terminally for ${key} — ` +
            "visual terrain keeps overview data for this tile (physics uses the real CPU lattice)",
          error
        );
      }
    }
  }
}
