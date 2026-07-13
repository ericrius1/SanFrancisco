import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { CONFIG } from "../config";
import { tracer } from "../core/hitchTracer";
import { createFacadeMaterial, BASEY_OFFSET, BASEY_SCALE, TOPH_SCALE } from "./facade";
import { createRoadMaterial, createParkMaterial } from "./streets";
import { createCrownMaterial } from "./salesforceCrown";
import { applyLandmarkFixes } from "./landmarkFixes";
import type { WorldMap } from "./heightmap";
import { prefetched } from "./heightmap";
import { createTileShadowProxy, type TileShadowProxy } from "./shadows/tileShadowProxy";
import {
  createLandmarkShadowProxy,
  type LandmarkShadowCollider,
  type LandmarkShadowProxy
} from "./shadows/landmarkShadowProxy";
import { enableShadowLayer, SHADOW_LAYERS } from "./shadows/shadowLayers";
import type { StaticShadowScope } from "./shadows/clipmapShadowNode";

// Includes the 48 m local receiver square plus low-sun caster reach and one
// microcell. Changes beyond this cannot affect the cached local projection.
const LOCAL_SHADOW_INVALIDATE_RADIUS = 220;

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
  shadowProxy: TileShadowProxy | null;
  // meshes not yet attached to the group: a whole tile uploading its geometry in
  // one frame is a visible spike, so children re-attach one per frame instead
  pendingParts?: THREE.Object3D[];
  // park ground (grn_) held back while the player is high — a plane climb should
  // upload only the skyline, not the (up to 379k-vert) lawn meshes. Drained
  // once the player descends, at a catch-up rate for the first few frames so
  // it doesn't trickle in tile by tile (see #drainAttach / #resumeDetail).
  detailParts?: THREE.Object3D[];
};

// a pooled facade material + its alive texture: the facade shader is by far the
// most expensive node graph in the scene, and the node-builder cache is keyed by
// material *instance* — a fresh material per tile means a full WGSL codegen every
// time a tile streams in. Pooled slots are reused across tiles so steady-state
// flying compiles nothing. The texture is fixed at the manifest-wide max building
// count so any tile fits any slot. Each slot holds NEAR (brick/weather noise) and
// FAR (flat masonry) materials sharing one alive texture; tiles swap by distance.
type FacadeSlot = {
  tex: THREE.DataTexture;
  data: Uint8Array;
  matNear: THREE.MeshStandardNodeMaterial;
  matFar: THREE.MeshStandardNodeMaterial;
  /** Which material is currently bound to this tile's building meshes. */
  far: boolean;
};

// Swap facade detail material past this distance (m). Hysteresis avoids flicker.
const FACADE_FAR_ENTER = 280;
const FACADE_FAR_EXIT = 240;

// a parsed tile waiting for its main-thread finalize (materials, scene add = GPU
// upload); drained one per frame so a burst of finished loads can't stack several
// uploads into a single frame
type ReadyTile = { key: string; group: THREE.Group | null; colliders: BuildingCollider[] };

// precomputed per-manifest-tile scan entry (avoids Object.keys + string parsing every scan)
type TileEntry = { key: string; cx: number; cz: number; d2: number };

// concurrent GLB loads: meshopt decode rides a 4-worker pool (see useWorkers below),
// so this caps how many decodes can be queued on it at once
const MAX_IN_FLIGHT = 4;
// raised in-flight cap while the player is moving fast (see #fastStream) — at
// plane/boost speed the ~1150m fog veil can otherwise be outrun before tiles land
const MAX_IN_FLIGHT_FAST = 6;
// boot turbo (behind the opaque loading cover): saturate the network + decode
// pool — nothing is on screen, so decode-queue pressure can't hitch anything
const MAX_IN_FLIGHT_TURBO = 8;
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

function landmarkColliderClass(meshName: string): string | null {
  if (meshName.startsWith("lm_bridge_goldengate")) return "goldengate";
  if (meshName.startsWith("lm_bridge_bay")) return "baybridge";
  if (meshName.startsWith("lm_salesforce")) return "salesforce";
  if (meshName.startsWith("lm_coit")) return "coit";
  if (meshName.startsWith("lm_palace")) return "palace";
  if (meshName.startsWith("lm_transamerica")) return "transamerica";
  if (meshName.startsWith("lm_ferry")) return "ferry";
  if (meshName.startsWith("lm_sutro")) return "sutro";
  if (meshName.startsWith("lm_alcatraz")) return "alcatraz";
  if (meshName.startsWith("lm_dragon_gate")) return "dragon_gate";
  return null;
}

/** Fill any collider-data coverage hole with one conservative world AABB.
 * Dragon Gate currently needs this path; grouping by class also degrades safely
 * if a future partial bake omits another landmark. */
function completeLandmarkShadowColliders(
  root: THREE.Object3D,
  colliders: readonly LandmarkShadowCollider[]
): LandmarkShadowCollider[] {
  const complete = [...colliders];
  const represented = new Set(
    colliders.map((collider) => collider.lm).filter((id): id is string => !!id)
  );
  const missingBounds = new Map<string, THREE.Box3>();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    const id = landmarkColliderClass(mesh.name);
    if (!id || represented.has(id)) return;
    const bounds = new THREE.Box3().setFromObject(mesh, true);
    if (bounds.isEmpty()) return;
    const aggregate = missingBounds.get(id);
    if (aggregate) aggregate.union(bounds);
    else missingBounds.set(id, bounds);
  });
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  for (const [lm, bounds] of missingBounds) {
    bounds.getCenter(center);
    bounds.getSize(size);
    complete.push({
      lm,
      x: center.x,
      y: center.y,
      z: center.z,
      hx: Math.max(0.25, size.x * 0.5),
      hy: Math.max(0.25, size.y * 0.5),
      hz: Math.max(0.25, size.z * 0.5),
      yaw: 0
    });
  }
  return complete;
}

/** Keep beauty geometry in LOCAL; FAR is retained only as the failure fallback. */
function setLandmarkBeautyFarFallback(root: THREE.Object3D, enabled: boolean): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    if (enabled) enableShadowLayer(mesh, SHADOW_LAYERS.FAR_PROXY);
    else mesh.layers.disable(SHADOW_LAYERS.FAR_PROXY);
  });
}

export class TileStreamer {
  manifest!: Manifest;
  loaded = new Map<string, LoadedTile>();
  terrain = new Map<string, THREE.Object3D>();
  landmarks: THREE.Object3D | null = null;
  landmarkShadowProxy: LandmarkShadowProxy | null = null;
  onTileColliders: (key: string, colliders: BuildingCollider[]) => void = () => {};
  onTileUnload: (key: string) => void = () => {};
  // fired when a building's SOLID state flips at runtime (full suppress / revive)
  // so the physics query world can add or drop its collider. Mesh-only
  // suppression keeps the collider, so it does NOT fire this.
  onBuildingAlive: (key: string, index: number, alive: boolean) => void = () => {};
  onShadowCastersChanged: (scope?: StaticShadowScope) => void = () => {};

  #loader = new GLTFLoader();
  #scene: THREE.Scene;
  #pending = new Set<string>();
  #tick = 0;
  #entries: TileEntry[] = [];
  #queue: TileEntry[] = [];
  #inFlight = 0;
  #px = 0;
  #pz = 0;
  // previous-frame position, for a speed estimate (see #fastStream in update())
  #prevPx = 0;
  #prevPz = 0;
  #hasPrevPos = false;
  #hasScanned = false;
  // parsed tiles awaiting finalize, drained one per frame
  #ready: ReadyTile[] = [];
  // tiles with pendingParts still attaching, one mesh per frame
  #attaching: string[] = [];
  // tiles whose park detail + tree scatter is held back until the player descends
  #deferred = new Set<string>();
  // true when the player is high enough that only buildings/roads should stream
  #highUp = false;
  // true for the frames right after a highUp→low descent, while #resumeDetail's
  // backlog is still draining faster than 1/frame (see update())
  #catchingUp = false;
  // true while moving fast enough to outrun the fog veil at the normal scan
  // cadence; hysteresis vs speed (mirrors the highUp altitude gate above) so a
  // speed hovering near the threshold can't thrash the scan interval / in-flight cap
  #fastStream = false;
  #maxInFlight = MAX_IN_FLIGHT;
  // out-of-range tiles awaiting dispose, drained one per frame
  #unloads = new Set<string>();
  // reusable facade material slots (see FacadeSlot)
  #slotPool: FacadeSlot[] = [];
  #aliveW = 4;

  // landmarks GLB still in flight (counts toward `busy` for the boot settle gate)
  #landmarksPending = false;
  #landmarkShadowProxyPending = false;

  // terrain chunks: 5×5 grid, loaded/unloaded by player distance
  #terrainEntries: { name: string; cx: number; cz: number }[] = [];
  #terrainPending = new Set<string>();
  #terrainInFlight = 0;
  // max concurrent terrain loads (separate budget from building tiles)
  static readonly #TERRAIN_MAX_IN_FLIGHT = 2;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
    this.#loader.setMeshoptDecoder(MeshoptDecoder);
  }

  async init(map: WorldMap) {
    this.manifest = await (await prefetched("/data/manifest.json")).json();
    this.#entries = Object.keys(this.manifest.tiles).map((key) => {
      const [cx, cz] = this.keyToCenter(key);
      return { key, cx, cz, d2: 0 };
    });
    // alive textures are pool-shared across tiles, so they're sized once for the
    // biggest tile in the manifest
    for (const t of Object.values(this.manifest.tiles)) {
      this.#aliveW = Math.max(this.#aliveW, t.b);
    }
    // Landmarks are always resident (includes GG bridge at ~0.8 MB). Beauty
    // meshes initially retain FAR as a conservative fallback. Only after the
    // collider proxy is fully built do we atomically hand FAR ownership over.
    this.#landmarksPending = true;
    this.#landmarkShadowProxyPending = true;
    const landmarksReady = new Promise<THREE.Object3D | null>((resolve) => {
      this.#loader.load("/tiles/landmarks.glb", (gltf) => {
        this.#landmarksPending = false;
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
          enableShadowLayer(mesh, SHADOW_LAYERS.LOCAL_STATIC);
          enableShadowLayer(mesh, SHADOW_LAYERS.FAR_PROXY);
        });
        applyLandmarkFixes(gltf.scene, map);
        const goldenGateRoad = createGoldenGateRoadSurface(map);
        if (goldenGateRoad) gltf.scene.add(goldenGateRoad);
        // applyLandmarkFixes may add a new local caster (Coit footing).
        setLandmarkBeautyFarFallback(gltf.scene, true);
        this.landmarks = gltf.scene;
        this.#scene.add(gltf.scene);
        this.onShadowCastersChanged("all");
        resolve(gltf.scene);
      }, undefined, (err) => {
        // missing landmarks never wedge the boot settle gate (see `busy`)
        this.#landmarksPending = false;
        console.warn("[tiles] landmarks unavailable", err);
        resolve(null);
      });
    });
    const landmarkCollidersReady = prefetched("/data/landmark-colliders.json")
      .then(async (response) => {
        if (!response.ok) throw new Error(`landmark colliders HTTP ${response.status}`);
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) throw new Error("landmark collider payload is not an array");
        if (payload.length === 0) throw new Error("landmark collider payload is empty");
        return payload as LandmarkShadowCollider[];
      });
    void Promise.all([landmarksReady, landmarkCollidersReady])
      .then(([landmarkRoot, bakedColliders]) => {
        // A collider-only silhouette with no corresponding beauty landmark
        // would be a ghost shadow, so proxy ownership requires the GLB too.
        if (!landmarkRoot) throw new Error("landmark GLB unavailable");
        const colliders = completeLandmarkShadowColliders(landmarkRoot, bakedColliders);
        const proxy = createLandmarkShadowProxy({ colliders });
        const stats = proxy.stats();
        if (stats.rejectedBoxes > 0) {
          proxy.dispose();
          throw new Error(`landmark proxy rejected ${stats.rejectedBoxes} collider boxes`);
        }
        this.landmarkShadowProxy?.dispose();
        this.landmarkShadowProxy = proxy;
        this.#scene.add(proxy.group);
        setLandmarkBeautyFarFallback(landmarkRoot, false);
        this.#landmarkShadowProxyPending = false;
        console.info(
          `[shadows] landmark proxy: ${stats.boxes} boxes / ${stats.cells} cells / ` +
          `${stats.trianglesPerShadowPass} triangles`
        );
        this.onShadowCastersChanged("far");
      })
      .catch((err) => {
        // Beauty meshes were never removed from FAR, so this is a quality-safe
        // performance fallback rather than a missing-shadow failure.
        this.#landmarkShadowProxyPending = false;
        console.warn("[shadows] landmark proxy unavailable — retaining beauty FAR casters", err);
      });

    // Pre-compute the world-space centre of each 5×5 terrain chunk so
    // update() can distance-cull them without parsing tile names each frame.
    // The 5×5 grid evenly partitions the map AABB from meta.grid.
    const TERRAIN_GRID = 5;
    const { minX: gMinX, minZ: gMinZ, width: gW, height: gH, cellSize } = map.meta.grid;
    const terrWorldW = gW * cellSize;
    const terrWorldH = gH * cellSize;
    const chunkW = terrWorldW / TERRAIN_GRID;
    const chunkH = terrWorldH / TERRAIN_GRID;
    for (let tcx = 0; tcx < TERRAIN_GRID; tcx++) {
      for (let tcz = 0; tcz < TERRAIN_GRID; tcz++) {
        this.#terrainEntries.push({
          name: `terrain_${tcx}_${tcz}`,
          cx: gMinX + (tcx + 0.5) * chunkW,
          cz: gMinZ + (tcz + 0.5) * chunkH
        });
      }
    }
    // The first scan happens in update() once the player position is known.
  }

  keyToCenter(key: string): [number, number] {
    const [ix, iz] = key.split("_").map(Number);
    return [
      this.manifest.minX + ix * this.manifest.tile + this.manifest.tile / 2,
      this.manifest.minZ + iz * this.manifest.tile + this.manifest.tile / 2
    ];
  }

  /**
   * Outstanding streaming work, for the boot settle gate: queued/in-flight
   * loads, parsed-but-unfinalized tiles, meshes still attaching, pending
   * disposals, terrain chunks, landmarks GLB and landmark shadow proxy. Reports
   * 1 before the first scan so a just-constructed streamer never reads as settled.
   * Intentionally excludes #deferred — that's park detail held back by design
   * while the player is high, not work in progress.
   */
  get busy(): number {
    if (!this.#hasScanned) return 1;
    return (
      this.#queue.length +
      this.#pending.size +
      this.#ready.length +
      this.#attaching.length +
      this.#unloads.size +
      this.#terrainPending.size +
      (this.#landmarksPending ? 1 : 0) +
      (this.#landmarkShadowProxyPending ? 1 : 0)
    );
  }

  update(px: number, pz: number, highUp = false, turbo = false) {
    this.#tick++;
    this.#px = px;
    this.#pz = pz;
    // speed estimate (world units/sec): update() carries no dt, so this assumes
    // a steady ~60fps between calls — good enough to gate cadence, not physics
    if (this.#hasPrevPos) {
      const speed = Math.hypot(px - this.#prevPx, pz - this.#prevPz) * 60;
      this.#fastStream = this.#fastStream ? speed > 28 : speed > 40;
      this.#maxInFlight = turbo ? MAX_IN_FLIGHT_TURBO : this.#fastStream ? MAX_IN_FLIGHT_FAST : MAX_IN_FLIGHT;
    }
    this.#prevPx = px;
    this.#prevPz = pz;
    this.#hasPrevPos = true;
    if (highUp !== this.#highUp) {
      this.#highUp = highUp;
      // descended: re-queue every tile whose park detail / tree scatter was
      // held, and catch that backlog up faster than the usual 1/frame drain so
      // it doesn't visibly roll in tile by tile as the ground approaches
      if (!highUp) {
        this.#resumeDetail();
        this.#catchingUp = true;
      }
    }
    // building-tile scan: every 30 ticks (~0.5s) normally, every 10 while
    // #fastStream — otherwise plane/boost speed can outrun the ~1150m fog veil
    // and tiles pop in inside visible range
    if (this.#tick % (turbo ? 5 : this.#fastStream ? 10 : 30) === 1) this.#scan(px, pz);
    if (this.#tick % (turbo ? 15 : 60) === 2) this.#scanTerrain(px, pz);
    // TURBO (boot, behind the opaque loading cover): nothing on screen, so
    // per-frame smoothness doesn't matter — drain finalizes/attaches/disposals
    // under a flat ms budget instead of one per frame, and let the scan above
    // run hotter. The cover only lifts once `busy` reaches 0 (see main.ts).
    if (turbo) {
      const deadline = performance.now() + 10;
      while (performance.now() < deadline) {
        if (!this.#drainAttach() && !this.#drainReady() && !this.#drainUnload()) break;
      }
      return;
    }
    // one mesh attach (GPU upload) OR one finalize OR one dispose per frame,
    // so tile streaming costs stay flat instead of spiking when loads land in
    // bursts. Exception: while #catchingUp, drain up to 4/frame so a
    // post-descent detail backlog (see #resumeDetail) clears in a handful of
    // frames instead of trickling in one mesh at a time.
    let attached = false;
    for (let i = 0, n = this.#catchingUp ? 4 : 1; i < n; i++) {
      if (!this.#drainAttach()) { this.#catchingUp = false; break; }
      attached = true;
    }
    if (!attached && !this.#drainReady()) this.#drainUnload();
  }

  /** Re-evaluate load/unload immediately (e.g. after a draw-distance change). */
  forceScan() {
    if (this.#hasScanned) this.#scan(this.#px, this.#pz);
  }

  // terrain load radius: slightly larger than building tiles so the ground
  // backdrop is always present before buildings pop in
  static readonly #TERRAIN_LOAD_R = 3200;
  static readonly #TERRAIN_UNLOAD_R = 4000;

  #scanTerrain(px: number, pz: number) {
    const loadR2 = TileStreamer.#TERRAIN_LOAD_R * TileStreamer.#TERRAIN_LOAD_R;
    const unloadR2 = TileStreamer.#TERRAIN_UNLOAD_R * TileStreamer.#TERRAIN_UNLOAD_R;
    for (const e of this.#terrainEntries) {
      const d2 = (px - e.cx) * (px - e.cx) + (pz - e.cz) * (pz - e.cz);
      const loaded = this.terrain.has(e.name);
      const pending = this.#terrainPending.has(e.name);
      if (d2 < loadR2 && !loaded && !pending) {
        this.#loadTerrainChunk(e.name);
      } else if (d2 > unloadR2 && loaded) {
        const obj = this.terrain.get(e.name)!;
        this.terrain.delete(e.name);
        this.#scene.remove(obj);
        obj.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
        });
      }
    }
  }

  #loadTerrainChunk(name: string) {
    if (this.#terrainInFlight >= TileStreamer.#TERRAIN_MAX_IN_FLIGHT) return;
    // mark pending before the load so a slow GLB isn't re-queued every scan
    this.#terrainPending.add(name);
    this.#terrainInFlight++;
    this.#loader.load(
      `/tiles/${name}.glb`,
      (gltf) => {
        this.#terrainInFlight--;
        this.#terrainPending.delete(name);
        // flown out of range while decoding? drop without attaching
        if (!this.#terrainWanted(name)) {
          gltf.scene.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
          });
          this.#scanTerrain(this.#px, this.#pz);
          return;
        }
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            (o as THREE.Mesh).material = plainMat;
            o.receiveShadow = true;
          }
        });
        this.terrain.set(name, gltf.scene);
        this.#scene.add(gltf.scene);
        // retry others that were deferred by the in-flight cap
        this.#scanTerrain(this.#px, this.#pz);
      },
      undefined,
      () => {
        // missing chunk is non-fatal (ocean / out-of-coverage cells)
        this.#terrainInFlight--;
        this.#terrainPending.delete(name);
      }
    );
  }

  /** Still inside the unload radius? Used to abandon late-arriving terrain GLBs. */
  #terrainWanted(name: string): boolean {
    const e = this.#terrainEntries.find((t) => t.name === name);
    if (!e) return false;
    const dx = this.#px - e.cx;
    const dz = this.#pz - e.cz;
    return dx * dx + dz * dz < TileStreamer.#TERRAIN_UNLOAD_R * TileStreamer.#TERRAIN_UNLOAD_R;
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
    // nearest first, drained #maxInFlight at a time as loads finish (raised
    // while #fastStream — see update())
    this.#queue.sort((a, b) => a.d2 - b.d2);
    this.#pump();
    // Facade near/far material swap: far tiles drop brick/weather noise ALU.
    // Hysteresis on enter/exit; BundleGroup re-records only when the bind changes.
    for (const tile of this.loaded.values()) {
      if (!tile.slot) continue;
      const [cx, cz] = this.keyToCenter(tile.key);
      const d = Math.hypot(px - cx, pz - cz);
      const wantFar = tile.slot.far ? d > FACADE_FAR_EXIT : d >= FACADE_FAR_ENTER;
      if (this.#applyFacadeLod(tile, wantFar)) {
        (tile.group as THREE.BundleGroup).needsUpdate = true;
      }
    }
  }

  #pump() {
    const loadR2 = CONFIG.tileLoadRadius * CONFIG.tileLoadRadius;
    while (this.#inFlight < this.#maxInFlight && this.#queue.length > 0) {
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
    return {
      tex,
      data,
      matNear: createFacadeMaterial(tex, this.#aliveW, { detail: true }),
      matFar: createFacadeMaterial(tex, this.#aliveW, { detail: false }),
      far: false
    };
  }

  /** Bind near or far facade material on every building mesh in a tile. Returns
   *  true when the binding changed (caller must re-record the BundleGroup). */
  #applyFacadeLod(tile: LoadedTile, wantFar: boolean): boolean {
    const slot = tile.slot;
    if (!slot || slot.far === wantFar) return false;
    slot.far = wantFar;
    const mat = wantFar ? slot.matFar : slot.matNear;
    tile.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry.getAttribute("_bid") || mesh.geometry.getAttribute("_BID")) {
        mesh.material = mat;
      }
    });
    // pending/detail parts not yet in the group still need the right material
    for (const parked of [tile.pendingParts, tile.detailParts]) {
      if (!parked) continue;
      for (const part of parked) {
        part.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          if (mesh.geometry.getAttribute("_bid") || mesh.geometry.getAttribute("_BID")) {
            mesh.material = mat;
          }
        });
      }
    }
    return true;
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
      // Pick near/far by tile-centre distance at finalize; #scan refreshes as
      // the player moves (hysteresis — see FACADE_FAR_*).
      const [tcx, tcz] = this.keyToCenter(key);
      const td = Math.hypot(this.#px - tcx, this.#pz - tcz);
      slot.far = td >= FACADE_FAR_ENTER;
      const bMat = slot.far ? slot.matFar : slot.matNear;
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // tile content is static and drawn via a WebGPU render bundle (below):
        // the bundle records each child's draw once, so per-child frustum tests
        // would freeze whatever culling the record-time camera saw. Children
        // draw unconditionally; the whole tile is distance/radius managed.
        mesh.frustumCulled = false;
        const lowerBid = mesh.geometry.getAttribute("_bid");
        const bid = lowerBid ?? mesh.geometry.getAttribute("_BID");
        if (bid) {
          if (!lowerBid) mesh.geometry.setAttribute("_bid", bid); // normalize an uppercase _BID
          mesh.material = bMat;
          // Beauty facade bundles are deliberately excluded from selective
          // shadow cameras. Cullable collider microproxies own their massing.
          mesh.castShadow = false;
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
      // static tile content renders as one WebGPU render bundle: ~40 per-building
      // draws per tile collapse to a cached command buffer, so per-frame encode
      // cost stops scaling with building count. Building hide/show (citygen swap)
      // rides the alive TEXTURE, never mesh structure, so the bundle
      // only re-records while the tile is still attaching parts.
      const bundle = new THREE.BundleGroup();
      bundle.name = `tile_${key}`;
      this.#scene.add(bundle);
      const shadowProxy = colliders.length > 0
        ? createTileShadowProxy({
            tileKey: key,
            colliders,
            buildingCount: nB,
            isBuildingVisible: (index) => this.#shadowBuildingVisible(key, index)
          })
        : null;
      if (shadowProxy) this.#scene.add(shadowProxy.group);
      this.loaded.set(key, {
        key,
        group: bundle,
        slot,
        colliders,
        shadowProxy,
        pendingParts: core,
        detailParts: detail.length ? detail : undefined
      });
      if (shadowProxy) this.onShadowCastersChanged(this.#shadowScopeForTile(key));
      this.#attaching.push(key);
    } else {
      this.loaded.set(key, {
        key,
        group: new THREE.Group(),
        slot,
        colliders,
        shadowProxy: null
      });
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
        (tile.group as THREE.BundleGroup).needsUpdate = true; // structure changed → re-record bundle
        if (tile.pendingParts.length === 0) tile.pendingParts = undefined;
        tracer.count("tileAttach");
        return true;
      }
      // 2) park detail: only while low — while high it stays off the GPU
      if (!this.#highUp && tile.detailParts && tile.detailParts.length > 0) {
        tile.group.add(tile.detailParts.shift()!);
        (tile.group as THREE.BundleGroup).needsUpdate = true;
        if (tile.detailParts.length === 0) tile.detailParts = undefined;
        tracer.count("tileAttach");
        return true;
      }
      // 3) high, but park detail still owed: park the tile until descent
      if (this.#highUp && tile.detailParts && tile.detailParts.length > 0) {
        this.#deferred.add(key);
        this.#attaching.shift();
        continue;
      }
      // 4) tile whole
      this.#attaching.shift();
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

  /** Dispose one out-of-range tile per call. Returns false when idle. */
  #drainUnload(): boolean {
    const loadR2 = CONFIG.tileLoadRadius * CONFIG.tileLoadRadius;
    for (const key of this.#unloads) {
      this.#unloads.delete(key);
      if (!this.loaded.has(key)) continue; // already gone
      // circled back while it waited? keep it
      const [cx, cz] = this.keyToCenter(key);
      const d2 = (this.#px - cx) * (this.#px - cx) + (this.#pz - cz) * (this.#pz - cz);
      if (d2 < loadR2) continue;
      this.#unloadTile(key);
      return true;
    }
    return false;
  }

  #unloadTile(key: string) {
    const tile = this.loaded.get(key);
    if (!tile) return;
    this.loaded.delete(key);
    this.onTileUnload(key);
    this.#scene.remove(tile.group);
    if (tile.shadowProxy) {
      tile.shadowProxy.dispose();
      tile.shadowProxy = null;
      this.onShadowCastersChanged(this.#shadowScopeForTile(key));
    }
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
    // the alive texture + facade materials go back to the pool — reusing the
    // material instances keeps the node-builder cache hot (see FacadeSlot)
    if (tile.slot) {
      tile.slot.far = false;
      this.#slotPool.push(tile.slot);
    }
  }

  // buildings permanently replaced by custom layers (the Exploratorium builds
  // its own Pier 15 shed): mesh dies via the alive flag the moment the tile
  // lands, and physics skips them through the same isAlive gate suppression uses
  #suppressed = new Set<string>();
  // mesh hidden but COLLIDER kept alive (alive flag = 1, not 0). Used by the
  // CityGen ring so its own LOD/detail render in place of the baked mesh while the
  // accurate baked collider still catches cars + the player (no oversized proxy).
  #meshSuppressed = new Set<string>();

  #shadowBuildingVisible(key: string, index: number): boolean {
    const id = `${key}:${index}`;
    return !this.#suppressed.has(id) && !this.#meshSuppressed.has(id);
  }

  #syncShadowBuilding(key: string, index: number): void {
    this.loaded
      .get(key)
      ?.shadowProxy?.setBuildingVisible(index, this.#shadowBuildingVisible(key, index));
  }

  #shadowScopeForTile(key: string): StaticShadowScope {
    const [cx, cz] = this.keyToCenter(key);
    const halfDiagonal = this.manifest.tile / Math.SQRT2;
    return Math.hypot(this.#px - cx, this.#pz - cz) <=
      halfDiagonal + LOCAL_SHADOW_INVALIDATE_RADIUS
      ? "all"
      : "far";
  }

  #shadowScopeForBuilding(key: string, index: number): StaticShadowScope {
    const colliders = this.loaded.get(key)?.colliders;
    if (colliders) {
      const radiusSq = LOCAL_SHADOW_INVALIDATE_RADIUS * LOCAL_SHADOW_INVALIDATE_RADIUS;
      for (const collider of colliders) {
        if (collider.i !== index) continue;
        const dx = collider.x - this.#px;
        const dz = collider.z - this.#pz;
        if (dx * dx + dz * dz <= radiusSq) return "all";
      }
      return "far";
    }
    return this.#shadowScopeForTile(key);
  }

  /** Permanently hide a building (mesh + colliders) — survives tile reloads. */
  suppressBuilding(key: string, index: number) {
    this.#suppressed.add(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length) {
      tile.slot.data[index * 4] = 0;
      tile.slot.tex.needsUpdate = true;
    }
    this.#syncShadowBuilding(key, index);
    this.onShadowCastersChanged(this.#shadowScopeForBuilding(key, index));
    this.onBuildingAlive(key, index, false);
  }

  /** True when an authored landmark/site has permanently claimed this OSM
   *  footprint. Streaming replacement systems must leave these entries alone:
   *  reviving one would draw a generated house through the custom landmark. */
  isBuildingSuppressed(key: string, index: number): boolean {
    return this.#suppressed.has(`${key}:${index}`);
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
    this.#syncShadowBuilding(key, index);
    this.onShadowCastersChanged(this.#shadowScopeForBuilding(key, index));
  }

  /** Undo suppressBuildingMesh — restore the baked mesh (alive flag → 255). */
  unsuppressBuildingMesh(key: string, index: number) {
    this.#meshSuppressed.delete(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length && tile.slot.data[index * 4] === 1) {
      tile.slot.data[index * 4] = 255;
      tile.slot.tex.needsUpdate = true;
    }
    this.#syncShadowBuilding(key, index);
    this.onShadowCastersChanged(this.#shadowScopeForBuilding(key, index));
  }

  /** Undo suppressBuilding — restores the baked mesh + colliders. Used by the
   *  generated-building ring: an OSM building is suppressed only while its
   *  generated replacement is streamed in, and revived when the ring unloads it
   *  so the distant baked city has no holes. (Alive sentinel is 255.) */
  unsuppressBuilding(key: string, index: number) {
    this.#suppressed.delete(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length) {
      tile.slot.data[index * 4] = 255;
      tile.slot.tex.needsUpdate = true;
    }
    this.#syncShadowBuilding(key, index);
    this.onShadowCastersChanged(this.#shadowScopeForBuilding(key, index));
    this.onBuildingAlive(key, index, true);
  }

  /** True when this building's baked MESH is not drawn (fully suppressed, or
   *  mesh-only suppressed — the CityGen ring renders a prism/detail mesh in its
   *  place). Used by raycastWorld to decide whether a loose baked-collider hit
   *  should be refined onto the actually-rendered citygen surface. */
  isBuildingMeshHidden(key: string, index: number): boolean {
    const k = `${key}:${index}`;
    return this.#meshSuppressed.has(k) || this.#suppressed.has(k);
  }

  isAlive(key: string, index: number): boolean {
    const tile = this.loaded.get(key);
    if (!tile) return false;
    // landmark collider boxes ride in the tile files with i beyond the OSM
    // building count (bake-colliders LM_BASE): always alive
    if (index >= (this.manifest.tiles[key]?.b ?? 0)) return true;
    // alive flag: 255 = visible+solid, 1 = mesh-hidden but collider kept (CityGen
    // LOD tier), 0 = dead (fully suppressed). Non-zero = collidable.
    return !!tile.slot && tile.slot.data[index * 4] !== 0;
  }
}
