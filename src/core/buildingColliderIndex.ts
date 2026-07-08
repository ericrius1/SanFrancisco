// Citywide building-collider index — the baked OBBs decoupled from the visual
// TileStreamer.
//
// The visual streamer only holds collider data for tiles rendered near the human
// player (draw radius), so an AI car anchored elsewhere (another player's region
// in multiplayer, or the 260–380 m gap between the collider radius and a car's
// NEAR tier) has NO building data around it and drives straight through walls.
//
// This index streams the same baked `public/data/colliders/tile_*.json` OBBs on
// a coarse wide grid around EVERY collider anchor, independent of what's visually
// loaded. It reuses the existing colliderWorker so the fetch + JSON parse + trig
// patch stay off the main thread. Physics merges its tiles with the visual ones
// (visual copy wins where both exist, so demolition/suppression state is honoured
// wherever the player can actually see the building; a building only ever streams
// here for regions no one is looking at, where nothing can be demolished).

import type { BuildingCollider } from "../world/tiles";

// doubles per box in the colliderWorker reply: i,p,x,y,z,hx,hy,hz,yaw,cos,sin,s,vol.
// Mirrored here (not imported) so this module never pulls the worker's top-level
// `self.onmessage` into the main thread.
const COLLIDER_FIELDS = 13;

// tile-centre reach (added to the tile half-span) for loading / evicting: a car
// anchor with a ~60 m radius sitting near a tile edge still needs the neighbour
// tile resident, and the evict band is well past the load band so a car idling on
// a boundary never thrashes a tile in and out.
const LOAD_REACH = 160;
const EVICT_REACH = 460;
const MAX_LOADS_PER_UPDATE = 2; // throttle: at most this many fetches kicked off per tick

type Manifest = { tile: number; minX: number; minZ: number; tiles: Record<string, unknown> };

export class BuildingColliderIndex {
  /** key → baked OBBs (patched with cosYaw/sinYaw/s). Read by physics. */
  tiles = new Map<string, BuildingCollider[]>();

  #tileSize = 800;
  #half = 400;
  #keys: { key: string; cx: number; cz: number }[] = [];
  #loading = new Set<string>();
  #loaded = new Set<string>(); // completed loads (possibly empty tiles)
  #worker: Worker | null = null;
  #waiters = new Map<number, string>();
  #reqId = 0;
  #ready = false;

  async init(): Promise<void> {
    const manifest = (await (await fetch("/data/manifest.json")).json()) as Manifest;
    this.#tileSize = manifest.tile;
    this.#half = manifest.tile / 2;
    for (const key of Object.keys(manifest.tiles)) {
      const [ix, iz] = key.split("_").map(Number);
      this.#keys.push({
        key,
        cx: manifest.minX + ix * this.#tileSize + this.#half,
        cz: manifest.minZ + iz * this.#tileSize + this.#half
      });
    }
    this.#worker = new Worker(new URL("../world/colliderWorker.ts", import.meta.url), { type: "module" });
    this.#worker.onmessage = (e: MessageEvent<{ id: number; buf: Float64Array | null }>) => this.#onWorker(e.data);
    this.#ready = true;
  }

  /**
   * Ensure OBBs are resident for every manifest tile within LOAD_REACH of any
   * anchor and evict tiles past EVICT_REACH of all anchors. Cheap: a couple of
   * squared-distance scans and at most MAX_LOADS_PER_UPDATE fetches queued.
   */
  update(anchors: readonly { x: number; z: number }[]): void {
    if (!this.#ready || anchors.length === 0) return;
    const loadR = this.#half + LOAD_REACH;
    const evictR = this.#half + EVICT_REACH;
    const loadR2 = loadR * loadR;
    const evictR2 = evictR * evictR;
    let started = 0;
    for (const k of this.#keys) {
      let min2 = Infinity;
      for (const a of anchors) {
        const dx = k.cx - a.x;
        const dz = k.cz - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < min2) min2 = d2;
      }
      const has = this.#loaded.has(k.key) || this.#loading.has(k.key);
      if (min2 <= loadR2) {
        if (!has && started < MAX_LOADS_PER_UPDATE) {
          this.#startLoad(k.key);
          started++;
        }
      } else if (min2 > evictR2 && this.#loaded.has(k.key) && !this.#loading.has(k.key)) {
        this.tiles.delete(k.key);
        this.#loaded.delete(k.key);
      }
    }
  }

  #startLoad(key: string): void {
    if (!this.#worker) return;
    this.#loading.add(key);
    const id = ++this.#reqId;
    this.#waiters.set(id, key);
    this.#worker.postMessage({ id, url: `/data/colliders/tile_${key}.json` });
  }

  #onWorker(data: { id: number; buf: Float64Array | null }): void {
    const key = this.#waiters.get(data.id);
    this.#waiters.delete(data.id);
    if (key === undefined) return;
    this.#loading.delete(key);
    this.#loaded.add(key);
    const buf = data.buf;
    if (!buf) {
      this.tiles.set(key, []);
      return;
    }
    const n = (buf.length / COLLIDER_FIELDS) | 0;
    const list: BuildingCollider[] = new Array(n);
    for (let k = 0; k < n; k++) {
      const o = k * COLLIDER_FIELDS;
      list[k] = {
        i: buf[o],
        p: buf[o + 1],
        x: buf[o + 2],
        y: buf[o + 3],
        z: buf[o + 4],
        hx: buf[o + 5],
        hy: buf[o + 6],
        hz: buf[o + 7],
        yaw: buf[o + 8],
        cosYaw: buf[o + 9],
        sinYaw: buf[o + 10],
        s: buf[o + 11],
        vol: buf[o + 12]
      };
    }
    this.tiles.set(key, list);
  }

  dispose(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.tiles.clear();
    this.#loaded.clear();
    this.#loading.clear();
    this.#waiters.clear();
    this.#ready = false;
  }
}
