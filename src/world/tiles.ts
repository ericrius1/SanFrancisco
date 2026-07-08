import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { CONFIG } from "../config";
import { createFacadeMaterial, BASEY_OFFSET, BASEY_SCALE, TOPH_SCALE } from "./facade";
import { createRoadMaterial, createParkMaterial } from "./streets";
import { createCrownMaterial } from "./salesforceCrown";
import { applyLandmarkFixes } from "./landmarkFixes";
import type { WorldMap } from "./heightmap";

export type BuildingCollider = {
  i: number;
  p: number;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  // yaw trig, patched in at load: the physics queries rotate into every box's
  // frame each test, and sin/cos per collider per query dominates dense tiles
  cosYaw: number;
  sinYaw: number;
  // sub-box ordinal, patched in at load: concave footprints bake to several
  // boxes sharing one `i` (courtyards must not be solid), so "key:i" alone no
  // longer names a unique physics body — "key:i:s" does
  s: number;
  vol: number;
};

type Manifest = {
  tile: number;
  tilesX: number;
  tilesZ: number;
  minX: number;
  minZ: number;
  tiles: Record<string, { b: number; r: number; g: number; p: number }>;
};

type LoadedTile = {
  key: string;
  group: THREE.Group;
  slot: FacadeSlot | null;
  colliders: BuildingCollider[] | null;
  // meshes not yet attached to the group: a whole tile uploading its geometry in
  // one frame is a visible spike, so children re-attach one per frame instead
  pendingParts?: THREE.Object3D[];
  // park ground (grn_) held back while the player is high — a plane climb should
  // upload only the skyline, not the (up to 379k-vert) lawn meshes. Attached one
  // per frame once the player descends (see #drainAttach / #resumeDetail).
  detailParts?: THREE.Object3D[];
  // tree scatter owed once the tile is whole AND the player is low
  needsGreens?: boolean;
};

// a pooled facade material + its alive texture: the facade shader is by far the
// most expensive node graph in the scene, and the node-builder cache is keyed by
// material *instance* — a fresh material per tile means a full WGSL codegen every
// time a tile streams in. Pooled slots are reused across tiles so steady-state
// flying compiles nothing. The texture is fixed at the manifest-wide max building
// count so any tile fits any slot.
type FacadeSlot = {
  tex: THREE.DataTexture;
  data: Uint8Array;
  mat: THREE.MeshStandardNodeMaterial;
};

// a parsed tile waiting for its main-thread finalize (materials, scene add = GPU
// upload); drained one per frame so a burst of finished loads can't stack several
// uploads into a single frame
type ReadyTile = { key: string; group: THREE.Group | null; colliders: BuildingCollider[] };

// precomputed per-manifest-tile scan entry (avoids Object.keys + string parsing every scan)
type TileEntry = { key: string; cx: number; cz: number; d2: number };

// concurrent GLB loads: meshopt decode rides a 4-worker pool (see useWorkers below),
// so this caps how many decodes can be queued on it at once
const MAX_IN_FLIGHT = 4;
// meshopt decompression workers: without them decodeGltfBufferAsync runs the WASM
// decode synchronously on the main thread — the biggest single hitch per tile load
MeshoptDecoder.useWorkers(4);

// collider JSON parse lives in its own worker (see colliderWorker.ts); replies
// come back as transferred Float64Arrays keyed by request id
const COLLIDER_FIELDS = 13;
const colliderWorker = new Worker(new URL("./colliderWorker.ts", import.meta.url), { type: "module" });
const colliderWaiters = new Map<number, (list: BuildingCollider[]) => void>();
let colliderReqId = 0;
colliderWorker.onmessage = (e: MessageEvent<{ id: number; buf: Float64Array | null }>) => {
  const { id, buf } = e.data;
  const resolve = colliderWaiters.get(id);
  colliderWaiters.delete(id);
  if (!resolve) return;
  if (!buf) return resolve([]);
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
  resolve(list);
};
function fetchColliders(url: string): Promise<BuildingCollider[]> {
  return new Promise((resolve) => {
    const id = ++colliderReqId;
    colliderWaiters.set(id, resolve);
    colliderWorker.postMessage({ id, url });
  });
}

// terrain / landmarks: PBR standard so the SkyMesh IBL and AO read on them.
// the bake palette is near-paper-white (~0.9); under the reference's photometric
// sun that saturates to pure white, so trim it into a concrete-like albedo — the
// material's color multiplies the baked vertex colours
const plainMat = new THREE.MeshStandardMaterial({
  color: 0x969390,
  vertexColors: true,
  roughness: 0.92,
  metalness: 0
});
const goldenGateMat = new THREE.MeshStandardMaterial({
  color: 0xffb18a,
  vertexColors: true,
  roughness: 0.72,
  metalness: 0.08
});
// one shared TSL material per surface family (world-position keyed, so sharing is free)
const roadMat = createRoadMaterial();
const parkMat = createParkMaterial();

const GOLDEN_GATE_ROAD_INSET = 1.15;
const BRIDGE_ROAD_SURFACE_OFFSET = 0.12;
const BRIDGE_ROAD_SEGMENT_M = 60;

function createGoldenGateRoadSurface(map: WorldMap): THREE.Mesh | null {
  const bridge = map.meta.bridges.find((b) => b.name === "Golden Gate Bridge");
  if (!bridge) return null;

  const halfWidth = Math.max(1, bridge.width / 2 - GOLDEN_GATE_ROAD_INSET);
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < bridge.line.length - 1; i++) {
    const [x0, z0, y0] = bridge.line[i];
    const [x1, z1, y1] = bridge.line[i + 1];
    const segLen = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(segLen / BRIDGE_ROAD_SEGMENT_M));

    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const ax = x0 + (x1 - x0) * t0;
      const az = z0 + (z1 - z0) * t0;
      const ay = y0 + (y1 - y0) * t0 + BRIDGE_ROAD_SURFACE_OFFSET;
      const bx = x0 + (x1 - x0) * t1;
      const bz = z0 + (z1 - z0) * t1;
      const by = y0 + (y1 - y0) * t1 + BRIDGE_ROAD_SURFACE_OFFSET;
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz) || 1;
      const px = -dz / len;
      const pz = dx / len;
      const base = positions.length / 3;

      positions.push(
        ax + px * halfWidth, ay, az + pz * halfWidth,
        bx + px * halfWidth, by, bz + pz * halfWidth,
        bx - px * halfWidth, by, bz - pz * halfWidth,
        ax - px * halfWidth, ay, az - pz * halfWidth
      );
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, roadMat);
  mesh.name = "lm_bridge_goldengate_asphalt";
  mesh.receiveShadow = true;
  return mesh;
}

export class TileStreamer {
  manifest!: Manifest;
  loaded = new Map<string, LoadedTile>();
  terrain = new Map<string, THREE.Object3D>();
  landmarks: THREE.Object3D | null = null;
  onTileColliders: (key: string, colliders: BuildingCollider[]) => void = () => {};
  onTileUnload: (key: string) => void = () => {};
  // fired after a tile lands in the scene — the flora layer scatters trees/grass on its parks
  onTileGreens: (key: string, group: THREE.Group) => void = () => {};

  #loader = new GLTFLoader();
  #scene: THREE.Scene;
  #pending = new Set<string>();
  #tick = 0;
  #entries: TileEntry[] = [];
  #queue: TileEntry[] = [];
  #inFlight = 0;
  #px = 0;
  #pz = 0;
  #hasScanned = false;
  // parsed tiles awaiting finalize, drained one per frame
  #ready: ReadyTile[] = [];
  // tiles with pendingParts still attaching, one mesh per frame
  #attaching: string[] = [];
  // tiles whose park detail + tree scatter is held back until the player descends
  #deferred = new Set<string>();
  // true when the player is high enough that only buildings/roads should stream
  #highUp = false;
  // out-of-range tiles awaiting dispose, drained one per frame
  #unloads = new Set<string>();
  // reusable facade material slots (see FacadeSlot)
  #slotPool: FacadeSlot[] = [];
  #aliveW = 4;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
    this.#loader.setMeshoptDecoder(MeshoptDecoder);
  }

  async init(map: WorldMap) {
    this.manifest = await (await fetch("/data/manifest.json")).json();
    this.#entries = Object.keys(this.manifest.tiles).map((key) => {
      const [cx, cz] = this.keyToCenter(key);
      return { key, cx, cz, d2: 0 };
    });
    // alive textures are pool-shared across tiles, so they're sized once for the
    // biggest tile in the manifest
    for (const t of Object.values(this.manifest.tiles)) {
      this.#aliveW = Math.max(this.#aliveW, t.b);
    }
    // landmarks always resident
    this.#loader.load("/tiles/landmarks.glb", (gltf) => {
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mesh.name === "lm_salesforce_crown") {
          // the crown's LED display is world-position keyed; its bbox gives the
          // cylinder axis + display height range
          mesh.geometry.computeBoundingBox();
          mesh.material = createCrownMaterial(mesh.geometry.boundingBox!);
        } else if (mesh.name === "lm_bridge_goldengate") {
          mesh.material = goldenGateMat;
        } else {
          mesh.material = plainMat;
        }
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      applyLandmarkFixes(gltf.scene, map);
      const goldenGateRoad = createGoldenGateRoadSurface(map);
      if (goldenGateRoad) gltf.scene.add(goldenGateRoad);
      this.landmarks = gltf.scene;
      this.#scene.add(gltf.scene);
    });
    // all terrain chunks (coarse, they're cheap and the map is the star) —
    // a fixed 5×5 grid matching the checked-in terrain_*.glb set in public/tiles
    const TERRAIN_GRID = 5;
    for (let cx = 0; cx < TERRAIN_GRID; cx++) {
      for (let cz = 0; cz < TERRAIN_GRID; cz++) {
        const name = `terrain_${cx}_${cz}`;
        this.#loader.load(
          `/tiles/${name}.glb`,
          (gltf) => {
            gltf.scene.traverse((o) => {
              if ((o as THREE.Mesh).isMesh) {
                (o as THREE.Mesh).material = plainMat;
                o.receiveShadow = true;
              }
            });
            this.terrain.set(name, gltf.scene);
            this.#scene.add(gltf.scene);
          },
          undefined,
          () => {} // a missing chunk is non-fatal
        );
      }
    }
  }

  keyToCenter(key: string): [number, number] {
    const [ix, iz] = key.split("_").map(Number);
    return [
      this.manifest.minX + ix * this.manifest.tile + this.manifest.tile / 2,
      this.manifest.minZ + iz * this.manifest.tile + this.manifest.tile / 2
    ];
  }

  update(px: number, pz: number, highUp = false) {
    this.#tick++;
    this.#px = px;
    this.#pz = pz;
    if (highUp !== this.#highUp) {
      this.#highUp = highUp;
      // descended: re-queue every tile whose park detail / tree scatter was held
      if (!highUp) this.#resumeDetail();
    }
    if (this.#tick % 30 === 1) this.#scan(px, pz);
    // one mesh attach (GPU upload) OR one finalize OR one dispose per frame,
    // so tile streaming costs stay flat instead of spiking when loads land in
    // bursts
    if (!this.#drainAttach() && !this.#drainReady()) this.#drainUnload();
  }

  /** Re-evaluate load/unload immediately (e.g. after a draw-distance change). */
  forceScan() {
    if (this.#hasScanned) this.#scan(this.#px, this.#pz);
  }

  #scan(px: number, pz: number) {
    this.#px = px;
    this.#pz = pz;
    this.#hasScanned = true;
    const loadR2 = CONFIG.tileLoadRadius * CONFIG.tileLoadRadius;
    const unloadR2 = CONFIG.tileUnloadRadius * CONFIG.tileUnloadRadius;
    this.#queue.length = 0;
    for (const e of this.#entries) {
      e.d2 = (px - e.cx) * (px - e.cx) + (pz - e.cz) * (pz - e.cz);
      const isLoaded = this.loaded.has(e.key) || this.#pending.has(e.key);
      if (e.d2 < loadR2 && !isLoaded) {
        this.#queue.push(e);
      } else if (e.d2 > unloadR2 && this.loaded.has(e.key)) {
        this.#unloads.add(e.key);
      }
    }
    // nearest first, drained MAX_IN_FLIGHT at a time as loads finish
    this.#queue.sort((a, b) => a.d2 - b.d2);
    this.#pump();
  }

  #pump() {
    const loadR2 = CONFIG.tileLoadRadius * CONFIG.tileLoadRadius;
    while (this.#inFlight < MAX_IN_FLIGHT && this.#queue.length > 0) {
      const e = this.#queue.shift()!;
      if (this.loaded.has(e.key) || this.#pending.has(e.key)) continue;
      // the queue can be stale (player moved, radius shrank) — re-check before fetching
      const d2 = (this.#px - e.cx) * (this.#px - e.cx) + (this.#pz - e.cz) * (this.#pz - e.cz);
      if (d2 > loadR2) continue;
      this.#loadTile(e.key);
    }
  }

  #loadTile(key: string) {
    this.#pending.add(key);
    this.#inFlight++;

    // fetch+decode done (workers) — the main-thread finalize waits its turn in
    // #ready; free the in-flight slot now so the network pipeline keeps moving
    const enqueue = (group: THREE.Group | null, colliders: BuildingCollider[]) => {
      this.#inFlight--;
      this.#ready.push({ key, group, colliders });
      this.#pump();
    };

    // fetch + parse + trig patch all happen in the collider worker; this promise
    // never rejects (worker replies with an empty list on any failure)
    const colliderReq = fetchColliders(`/data/colliders/tile_${key}.json`);
    this.#loader.load(
      `/tiles/tile_${key}.glb`,
      async (gltf) => enqueue(gltf.scene, await colliderReq),
      undefined,
      async () => enqueue(null, await colliderReq)
    );
  }

  #takeSlot(): FacadeSlot {
    const pooled = this.#slotPool.pop();
    if (pooled) return pooled;
    const data = new Uint8Array(this.#aliveW * 4);
    const tex = new THREE.DataTexture(data, this.#aliveW, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    return { tex, data, mat: createFacadeMaterial(tex, this.#aliveW) };
  }

  /** Finalize one parsed tile: alive texture, materials, scene add. Returns false when idle. */
  #drainReady(): boolean {
    const item = this.#ready.shift();
    if (!item) return false;
    const { key, group, colliders } = item;
    this.#pending.delete(key);
    // flown past while it sat in the queue? skip the scene add / GPU upload
    // entirely — the next scan reloads it if the player comes back
    const [cx, cz] = this.keyToCenter(key);
    const d2 = (this.#px - cx) * (this.#px - cx) + (this.#pz - cz) * (this.#pz - cz);
    if (group && d2 > CONFIG.tileUnloadRadius * CONFIG.tileUnloadRadius) {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      return true;
    }
    const nB = Math.max(4, this.manifest.tiles[key].b);
    let slot: FacadeSlot | null = null;
    if (group) {
      // RGBA per building: R = alive flag, G/B = base height (16-bit fixed point)
      // so the facade anchors storefronts and floor lines to each building's street.
      // the slot is pooled — reset the whole texture, not just this tile's nB entries
      slot = this.#takeSlot();
      const aliveData = slot.data;
      aliveData.fill(255);
      const enc0 = Math.round(BASEY_OFFSET * BASEY_SCALE); // baseY = 0 fallback
      for (let i = 0; i < this.#aliveW; i++) {
        aliveData[i * 4 + 1] = enc0 >> 8;
        aliveData[i * 4 + 2] = enc0 & 255;
      }
      // multi-box buildings: base = last box's floor (matches the facade's
      // historical anchor), top = tallest box, so the parapet window mask
      // never triggers below a real roof
      const topOf = new Map<number, number>();
      for (const c of colliders) {
        if (c.i < 0 || c.i >= nB) continue;
        const enc = Math.max(0, Math.min(65535, Math.round((c.y - c.hy + BASEY_OFFSET) * BASEY_SCALE)));
        aliveData[c.i * 4 + 1] = enc >> 8;
        aliveData[c.i * 4 + 2] = enc & 255;
        topOf.set(c.i, Math.max(topOf.get(c.i) ?? -Infinity, c.y + c.hy));
      }
      // roof height above base → alpha (TOPH_SCALE m steps; 255 stays the
      // "unknown, never mask" default for buildings without colliders)
      for (const [i, top] of topOf) {
        const base = (((aliveData[i * 4 + 1] << 8) | aliveData[i * 4 + 2]) / BASEY_SCALE) - BASEY_OFFSET;
        aliveData[i * 4 + 3] = Math.max(1, Math.min(254, Math.round((top - base) / TOPH_SCALE)));
      }
      for (let i = 0; i < nB; i++) {
        if (this.#suppressed.has(`${key}:${i}`)) aliveData[i * 4] = 0;         // mesh + collider off
        else if (this.#meshSuppressed.has(`${key}:${i}`)) aliveData[i * 4] = 1; // mesh off, collider kept
      }
      slot.tex.needsUpdate = true;
      const bMat = slot.mat;
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const lowerBid = mesh.geometry.getAttribute("_bid");
        const bid = lowerBid ?? mesh.geometry.getAttribute("_BID");
        if (bid) {
          if (!lowerBid) mesh.geometry.setAttribute("_bid", bid); // normalize an uppercase _BID
          mesh.material = bMat;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        } else if (mesh.name.startsWith("road_")) {
          mesh.material = roadMat;
          mesh.receiveShadow = true;
        } else if (mesh.name.startsWith("grn_")) {
          mesh.material = parkMat;
          mesh.receiveShadow = true;
        } else {
          mesh.material = plainMat;
          mesh.receiveShadow = true;
        }
      });
      // the group enters the scene empty; its meshes re-attach one per frame in
      // #drainAttach so a big tile can't upload all its geometry in one frame.
      // buildings + roads are "core" (always stream); park ground (grn_) is
      // "detail" — held back while the player is high (see #drainAttach).
      const core: THREE.Object3D[] = [];
      const detail: THREE.Object3D[] = [];
      for (const o of group.children) (o.name.startsWith("grn_") ? detail : core).push(o);
      group.clear();
      this.#scene.add(group);
      this.loaded.set(key, {
        key,
        group,
        slot,
        colliders,
        pendingParts: core,
        detailParts: detail.length ? detail : undefined,
        needsGreens: true
      });
      this.#attaching.push(key);
    } else {
      this.loaded.set(key, { key, group: new THREE.Group(), slot, colliders });
    }
    this.onTileColliders(key, colliders);
    return true;
  }

  /** Attach one pending mesh (one GPU upload) per frame. Returns false when idle. */
  #drainAttach(): boolean {
    while (this.#attaching.length > 0) {
      const key = this.#attaching[0];
      const tile = this.loaded.get(key);
      if (!tile) {
        // unloaded mid-attach (dispose handled by #unloadTile)
        this.#attaching.shift();
        continue;
      }
      // 1) core meshes (buildings/roads): one GPU upload per frame
      if (tile.pendingParts && tile.pendingParts.length > 0) {
        tile.group.add(tile.pendingParts.shift()!);
        if (tile.pendingParts.length === 0) tile.pendingParts = undefined;
        return true;
      }
      // 2) park detail: only while low — while high it stays off the GPU
      if (!this.#highUp && tile.detailParts && tile.detailParts.length > 0) {
        tile.group.add(tile.detailParts.shift()!);
        if (tile.detailParts.length === 0) tile.detailParts = undefined;
        return true;
      }
      // 3) high, but detail/scatter still owed: park the tile until descent
      if (this.#highUp && ((tile.detailParts && tile.detailParts.length > 0) || tile.needsGreens)) {
        this.#deferred.add(key);
        this.#attaching.shift();
        continue;
      }
      // 4) tile whole (low): scatter its trees once, then it's done
      this.#attaching.shift();
      if (tile.needsGreens) {
        tile.needsGreens = false;
        // flora scatters once the tile is whole — its park meshes are in place
        this.onTileGreens(key, tile.group);
        return true;
      }
    }
    return false;
  }

  /** Descended: re-queue every tile whose park detail / tree scatter was held back. */
  #resumeDetail() {
    for (const key of this.#deferred) {
      if (this.loaded.has(key)) this.#attaching.push(key);
    }
    this.#deferred.clear();
  }

  /** Dispose one out-of-range tile per frame. */
  #drainUnload() {
    const loadR2 = CONFIG.tileLoadRadius * CONFIG.tileLoadRadius;
    for (const key of this.#unloads) {
      this.#unloads.delete(key);
      if (!this.loaded.has(key)) continue; // already gone
      // circled back while it waited? keep it
      const [cx, cz] = this.keyToCenter(key);
      const d2 = (this.#px - cx) * (this.#px - cx) + (this.#pz - cz) * (this.#pz - cz);
      if (d2 < loadR2) continue;
      this.#unloadTile(key);
      return;
    }
  }

  #unloadTile(key: string) {
    const tile = this.loaded.get(key);
    if (!tile) return;
    this.loaded.delete(key);
    this.onTileUnload(key);
    this.#scene.remove(tile.group);
    tile.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
      }
    });
    // meshes still waiting in the attach queue never joined the group — free them too
    for (const parked of [tile.pendingParts, tile.detailParts]) {
      if (!parked) continue;
      for (const part of parked) {
        part.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) mesh.geometry.dispose();
        });
      }
    }
    tile.pendingParts = undefined;
    tile.detailParts = undefined;
    this.#deferred.delete(key);
    // the alive texture + facade material go back to the pool — reusing the
    // material instance is what keeps the node-builder cache hot (see FacadeSlot)
    if (tile.slot) this.#slotPool.push(tile.slot);
  }

  // buildings permanently replaced by custom layers (the Exploratorium builds
  // its own Pier 15 shed): mesh dies via the alive flag the moment the tile
  // lands, and physics skips them through the same isAlive gate fractures use
  #suppressed = new Set<string>();
  // mesh hidden but COLLIDER kept alive (alive flag = 1, not 0). Used by the
  // CityGen ring so its own LOD/detail render in place of the baked mesh while the
  // accurate baked collider still catches cars + the player (no oversized proxy).
  #meshSuppressed = new Set<string>();

  /** Permanently hide a building (mesh + colliders) — survives tile reloads. */
  suppressBuilding(key: string, index: number) {
    this.#suppressed.add(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length) {
      tile.slot.data[index * 4] = 0;
      tile.slot.tex.needsUpdate = true;
    }
  }

  /** Hide only the baked MESH (alive flag → 1); the baked collider stays live so
   *  physics still sees the real footprint. Survives tile reloads. */
  suppressBuildingMesh(key: string, index: number) {
    this.#meshSuppressed.add(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length && tile.slot.data[index * 4] !== 0) {
      tile.slot.data[index * 4] = 1;
      tile.slot.tex.needsUpdate = true;
    }
  }

  /** Undo suppressBuildingMesh — restore the baked mesh (alive flag → 255). */
  unsuppressBuildingMesh(key: string, index: number) {
    this.#meshSuppressed.delete(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length && tile.slot.data[index * 4] === 1) {
      tile.slot.data[index * 4] = 255;
      tile.slot.tex.needsUpdate = true;
    }
  }

  /** Undo suppressBuilding — restores the baked mesh + colliders. Used by the
   *  generated-building ring: an OSM building is suppressed only while its
   *  generated replacement is streamed in, and revived when the ring unloads it
   *  so the distant baked city has no holes. (Alive sentinel is 255; a building
   *  that was independently fractured stays down — killBuilding also writes 0.) */
  unsuppressBuilding(key: string, index: number) {
    this.#suppressed.delete(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length) {
      tile.slot.data[index * 4] = 255;
      tile.slot.tex.needsUpdate = true;
    }
  }

  /** Marks a building dead (collapses its mesh). Returns its collider if known. */
  killBuilding(key: string, index: number): BuildingCollider | null {
    const tile = this.loaded.get(key);
    if (!tile || !tile.slot) return null;
    if (index < 0 || index * 4 >= tile.slot.data.length) return null;
    if (tile.slot.data[index * 4] === 0) return null;
    tile.slot.data[index * 4] = 0;
    tile.slot.tex.needsUpdate = true;
    return tile.colliders?.find((c) => c.i === index) ?? null;
  }

  isAlive(key: string, index: number): boolean {
    const tile = this.loaded.get(key);
    if (!tile) return false;
    // landmark collider boxes ride in the tile files with i beyond the OSM
    // building count (bake-colliders LM_BASE): always alive, never
    // fracturable (killBuilding's range guard already returns null for them)
    if (index >= (this.manifest.tiles[key]?.b ?? 0)) return true;
    // alive flag: 255 = visible+solid, 1 = mesh-hidden but collider kept (CityGen
    // LOD tier), 0 = dead (fractured / fully suppressed). Non-zero = collidable.
    return !!tile.slot && tile.slot.data[index * 4] !== 0;
  }
}
