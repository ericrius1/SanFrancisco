import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { CONFIG } from "../config";
import { attachKtx2Loader } from "../render/textures";
import { tracer } from "../core/hitchTracer";
import {
  createFacadeMaterial,
  configureFacadeBatchMaterial,
  BASEY_OFFSET,
  BASEY_SCALE,
  TOPH_SCALE
} from "./facade";
import { createRoadMaterial, createParkMaterial } from "./streets";
import { createTileMeshBatch, type TileMeshBatch, type TileBatchHandle } from "./tileBatch";
import {
  applyBirthFade,
  configureBatchBirthFade,
  materializeField
} from "../render/materialize";
import { frontGate, type FrontGateHandle } from "../render/frontGate";
import { bumpNormal } from "./tslUtil";
import { registerTerrainFieldNormal } from "./groundcover/terrainFieldNormal";
import { createCrownMaterial } from "./salesforceCrown";
import { applyLandmarkFixes } from "./landmarkFixes";
import type { WorldMap } from "./heightmap";
import { prefetched } from "./heightmap";
import { createTileShadowProxyAsync, type TileShadowProxy } from "./shadows/tileShadowProxy";
import {
  createLandmarkShadowProxy,
  type LandmarkShadowCollider,
  type LandmarkShadowProxy
} from "./shadows/landmarkShadowProxy";
import { enableShadowLayer, SHADOW_LAYERS } from "./shadows/shadowLayers";
import type { StaticShadowScope } from "./shadows/clipmapShadowNode";
import {
  TERRAIN_CUTOUT_CAPACITY,
  TerrainClipmap,
  type TerrainCutoutSpec
} from "./terrainClipmap";

export type { TerrainCutoutSpec } from "./terrainClipmap";

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
  materials: TileMaterialSet | null;
  colliders: BuildingCollider[] | null;
  shadowProxy: TileShadowProxy | null;
  /** Arrival generation that most recently adopted this tile. */
  generation: number;
  /** Unique visual request id, used to reject a late collider reply after reload. */
  loadId: number;
  loadToken: TileLoadToken;
  // meshes not yet attached to the group: a whole tile uploading its geometry in
  // one frame is a visible spike, so children re-attach one per frame instead
  pendingParts?: THREE.Object3D[];
  // pier decks (grn_) held back while the player is high — a plane climb should
  // upload only the skyline. (Lawns render on the terrain clipmap now; grn_
  // meshes only carry piers.) Drained
  // once the player descends, at a catch-up rate for the first few frames so
  // it doesn't trickle in tile by tile (see #drainAttach / #resumeDetail).
  detailParts?: THREE.Object3D[];
  // road meshes waiting to be folded into the shared road BatchedMesh, one per
  // frame on the same attach cadence as bundle parts (a batch add is one GPU
  // arena upload). Each carries its dequantization matrix in mesh.matrixWorld.
  // A road that cannot fit the batch (full/exhausted) falls back into the bundle.
  pendingRoadParts?: THREE.Mesh[];
  // handles for road geometries already folded into the shared batch; freed on
  // unload so the batch releases the instance + returns the geometry slot.
  roadBatchHandles?: TileBatchHandle[];
  // building (bld_) mesh(es) waiting to be folded into the shared building
  // BatchedMesh — core cadence, same one-per-frame as pendingParts. A tile has
  // exactly one bld_ mesh (all its buildings merged, per-vertex _bid).
  pendingBuildingParts?: THREE.Mesh[];
  // handles for building geometries folded into the shared batch; freed on unload.
  buildingBatchHandles?: TileBatchHandle[];
  // handles for park (grn_ pier deck) geometries folded into the shared park
  // batch; freed on unload. grn_ meshes ride the DETAIL cadence (held back while
  // the player is high) and stay in tile.detailParts until folded in.
  parkBatchHandles?: TileBatchHandle[];
  // this tile's row in the shared alive ATLAS = its building batch instance id.
  // The facade batch material recovers the same row via the batch indirect index,
  // so the tile's per-building alive data lines up with its per-instance dequant
  // matrix. undefined until the bld mesh is folded in (or when it fell back).
  buildingRow?: number;
  // true once the bld mesh is in the shared batch; false when it fell back to the
  // per-tile bundle (batch full/arena exhausted). Gates the near/far facade LOD
  // swap, which only applies to bundle-resident facades.
  buildingBatched?: boolean;
  // M12: set while this tile is hidden by the front visibility gate (resident +
  // warmed but beyond the materialize front during a sweep). The handle's
  // show() reveals the tile; cancelled whenever another path takes over
  // visibility (unload, covered-arrival adopt, re-gate).
  frontGateHandle?: FrontGateHandle;
};

type TileLoadToken = {
  id: number;
  generation: number;
  attempt: number;
  visualInFlight: boolean;
  colliderSettled: boolean;
  colliders: BuildingCollider[] | null;
  finalized: boolean;
  discarded: boolean;
  collidersApplied: boolean;
  collidersPublished: boolean;
  colliderRetained: boolean;
  abortController: AbortController | null;
};

/** Structural interface implemented by BuildingColliderIndex. Keeping this
 * type here avoids a runtime import cycle while giving visuals and physics one
 * canonical decoded array per tile. */
export type TileColliderSource = {
  getTile(key: string): BuildingCollider[] | undefined;
  retainTile(key: string): void;
  releaseTile(key: string): void;
  subscribe(listener: (key: string, colliders: BuildingCollider[]) => void): () => void;
};

// A facade slot owns the tiny mutable alive texture used by one resident tile.
// Textures/data are pooled, but material instances are deliberately retired on
// every unload. WebGPU's render-object cache is keyed by material *and* geometry;
// keeping a material alive while feeding it hundreds of freshly parsed tile
// geometries retained the old pipelines/render objects after long-distance
// teleports. Rebuilding the two materials when a slot is recycled gives the
// renderer an explicit disposal boundary while preserving the cheap data pool.
type FacadeSlot = {
  tex: THREE.DataTexture;
  data: Uint8Array;
  matNear: THREE.MeshStandardNodeMaterial | null;
  matFar: THREE.MeshStandardNodeMaterial | null;
  /** Which material is currently bound to this tile's building meshes. */
  far: boolean;
};

type TileMaterialSet = {
  road: THREE.Material;
  park: THREE.Material;
  plain: THREE.Material;
  palace: THREE.Material;
  sutro: THREE.Material;
  all: THREE.Material[];
};

// Swap facade detail material past this distance (m). Hysteresis avoids flicker.
const FACADE_FAR_ENTER = 280;
const FACADE_FAR_EXIT = 240;
// A healthy residency set is much smaller than this. The cap prevents unusual
// radius/settings changes from turning the pool into an unbounded session cache.
const MAX_FACADE_SLOT_POOL = 64;

// Shared building-batch sizing. Capacity is the alive-atlas row count; 256 covers
// the whole city (184 building tiles) plus headroom, so even a maxed draw distance
// never overflows into bundle fallback. The vertex/index arena is sized to hold a
// full default-draw-distance residency without a mid-play setGeometrySize grow
// (measured worst case ~3.1M verts / 5.1M idx for a city-centre ring); the ceiling
// covers the entire baked city (~3.81M verts / 6.32M idx) for a maxed radius.
const BUILDING_BATCH_CAPACITY = 256;
const BUILDING_BATCH_INITIAL_VERTICES = 3_145_728;
const BUILDING_BATCH_INITIAL_INDICES = 5_242_880;
const BUILDING_BATCH_MAX_VERTICES = 4_718_592;
const BUILDING_BATCH_MAX_INDICES = 8_388_608;

// A parsed tile waiting for its main-thread finalize (materials, scene add = GPU
// upload). Collider decode is intentionally independent: destination visuals must
// never wait for physics data.
type ReadyTile = { key: string; group: THREE.Group | null; token: TileLoadToken };

type ReadyColliders = {
  key: string;
  token: TileLoadToken;
  colliderCursor: number;
  topOf: Map<number, number>;
  topEntries: [number, number][] | null;
  topCursor: number;
};
type ReadyShadowProxy = { key: string; token: TileLoadToken };

export type TileVisualPrimeResult = {
  generation: number;
  status: "ready" | "failed" | "superseded";
  requiredTileKeys: readonly string[];
  requiredTerrainKeys: readonly string[];
};

export type TileVisualPrime = {
  generation: number;
  requiredTileKeys: readonly string[];
  requiredTerrainKeys: readonly string[];
  ready: Promise<TileVisualPrimeResult>;
};

type ActiveVisualPrime = {
  generation: number;
  focusX: number;
  focusZ: number;
  requiredTileKeys: string[];
  requiredTileSet: Set<string>;
  requiredTerrainKeys: string[];
  resolve: (result: TileVisualPrimeResult) => void;
  settled: boolean;
};

// precomputed per-manifest-tile scan entry (avoids Object.keys + string parsing every scan)
type TileEntry = { key: string; cx: number; cz: number; d2: number };
type TileVisualFailure = {
  generation: number;
  attempts: number;
  retryAt: number;
  terminal: boolean;
  reason: string;
};

// concurrent GLB loads: meshopt decode rides a 4-worker pool (see useWorkers below),
// so this caps how many decodes can be queued on it at once
const MAX_IN_FLIGHT = 2;
// raised in-flight cap while the player is moving fast (see #fastStream) — at
// plane/boost speed the ~1150m fog veil can otherwise be outrun before tiles land
const MAX_IN_FLIGHT_FAST = 4;
// boot turbo (behind the opaque loading cover): saturate the network + decode
// pool — nothing is on screen, so decode-queue pressure can't hitch anything
const MAX_IN_FLIGHT_TURBO = 4;
// Soft cap across every arrival generation. A tiny, separately bounded reserve
// is available only to the current generation. Discontinuous arrivals abort
// stale fetches before parse when possible; the cap still bounds a decode that
// had already entered Meshopt/GLTF parsing when superseded.
const MAX_IN_FLIGHT_GLOBAL = MAX_IN_FLIGHT_TURBO + 2;
const MIN_CURRENT_IN_FLIGHT_RESERVE = 2;
const MAX_IN_FLIGHT_ABSOLUTE = MAX_IN_FLIGHT_GLOBAL + MIN_CURRENT_IN_FLIGHT_RESERVE;
const TILE_FETCH_TIMEOUT_MS = 15_000;
const TILE_RETRY_DELAYS_MS = [250, 800] as const;
const TILE_MAX_ATTEMPTS = TILE_RETRY_DELAYS_MS.length + 1;
// A first destination frame needs the tile cells intersecting the immediate
// camera/player neighbourhood, not the complete multi-kilometre draw ring.
// Staying just inside half a tile gives one cell at its centre, two across an edge and
// four around a corner, while still covering a useful local bubble.
const MINIMUM_VISUAL_RADIUS_CAP = 360;
// Arrival completion opens a modest 360-degree neighborhood first, then grows
// the ordinary draw ring in two quiet stages. This keeps a newly requested
// authored landmark ahead of tiles that cannot yet contribute to its view.
const BACKGROUND_STREAM_RADII = [1200, 2200] as const;
const BACKGROUND_STREAM_STAGE_MS = 1800;
// residentRadiusAround recompute cadence, in streamer ticks (~0.25 s at 60 Hz).
// One pass over ~205 manifest entries — cheap, but not per-frame-per-caller.
const RESIDENT_RADIUS_RECOMPUTE_TICKS = 15;
// The far selective map covers 512 m from focus; include collider overhang and
// a handoff margin. Citywide farOcclusion handles everything beyond this local
// proxy residency without constructing dozens of invisible InstancedMeshes.
const SHADOW_PROXY_RADIUS = 680;
const SHADOW_PROXY_EXIT_RADIUS = 900;
// Distant beauty tiles use their far facade path and citywide occlusion. Their
// collider JSON adds no gameplay safety, so only the local shadow/physics band
// may acquire a visual metadata lease.
const VISUAL_COLLIDER_RADIUS = 1000;
const COLLIDER_METADATA_SLICE = 256;
// meshopt decompression workers: without them decodeGltfBufferAsync runs the WASM
// decode synchronously on the main thread — the biggest single hitch per tile load
MeshoptDecoder.useWorkers(4);

// terrain / landmarks: PBR standard so the SkyMesh IBL and AO read on them.
// the bake palette is near-paper-white (~0.9); under the reference's photometric
// sun that saturates to pure white, so trim it into a concrete-like albedo — the
// material's color multiplies the baked vertex colours
// Node materials (not plain MeshStandardMaterial): the M5 materialize wrap
// assigns colorNode/emissiveNode onto per-residency clones, and node slots on
// plain materials are ignored by the WebGPU backend. Vertex colours still
// multiply AFTER a custom colorNode (NodeMaterial.setupDiffuseColor).
const plainMat = new THREE.MeshStandardNodeMaterial({
  color: 0x969390,
  vertexColors: true,
  roughness: 0.92,
  metalness: 0
});
const palaceMat = new THREE.MeshStandardNodeMaterial({
  color: 0xd8c8b4,
  vertexColors: true,
  roughness: 0.88,
  metalness: 0
});
const sutroMat = new THREE.MeshStandardNodeMaterial({
  color: 0xe4e1dc,
  vertexColors: true,
  roughness: 0.76,
  metalness: 0.12
});
const goldenGateMat = new THREE.MeshStandardNodeMaterial({
  color: 0xffb18a,
  vertexColors: true,
  roughness: 0.72,
  metalness: 0.08
});
// one shared TSL material per surface family (world-position keyed, so sharing is free)
const roadMat = createRoadMaterial();
const parkMat = createParkMaterial();

function createTileMaterialSet(birth: ReturnType<typeof materializeField.birthOf>): TileMaterialSet {
  // Three's WebGPU RenderObject registers a dispose listener on every source
  // material. A process-wide shared material therefore retains every streamed
  // mesh/render object ever paired with it. Per-residency clones preserve the
  // same shader/pipeline cache key while giving unload an exact release signal.
  //
  // M5: every clone carries the holo-birth mix keyed to this residency's shared
  // birth uniform (min(front, birth) — tiles streaming in after the front has
  // passed fade in instead of popping, forever). Uniform nodes differ per tile
  // but the graph SHAPE is identical, so the pipeline cache key is unchanged.
  const road = roadMat.clone();
  const park = parkMat.clone();
  const plain = plainMat.clone();
  const palace = palaceMat.clone();
  const sutro = sutroMat.clone();
  const all = [road, park, plain, palace, sutro];
  for (const mat of all) applyBirthFade(mat, { birth });
  return { road, park, plain, palace, sutro, all };
}

// M5 batched-fold birth channel: BatchedMesh has no per-instance custom
// attribute, so per-instance birth timestamps ride a tiny 1-row float
// DataTexture indexed by the batch instance id (the same row the indirect
// texture maps draws to — moduleLayer writeSlot precedent). Written ONCE at
// add; the shader ramps from the shared worldTime uniform, so there are zero
// per-frame CPU writes. Unwritten rows hold +1e9 (birth amount 0 → holo), but
// every row is stamped in the same frame its instance is added.
type BatchBirth = { tex: THREE.DataTexture; data: Float32Array };

function createBatchBirth(capacity: number): BatchBirth {
  const data = new Float32Array(capacity).fill(1e9);
  const tex = new THREE.DataTexture(data, capacity, 1, THREE.RedFormat, THREE.FloatType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, data };
}

function stampBatchBirth(birth: BatchBirth, instanceId: number): void {
  if (instanceId < 0 || instanceId >= birth.data.length) return;
  birth.data[instanceId] = materializeField.worldTime.value as number;
  birth.tex.needsUpdate = true; // three coalesces to one upload per render
}

const GOLDEN_GATE_ROAD_INSET = 1.15;
const BRIDGE_ROAD_SURFACE_OFFSET = 0.12;
const BRIDGE_ROAD_SEGMENT_M = 60;

function createGoldenGateRoadSurface(map: WorldMap, material: THREE.Material = roadMat): THREE.Mesh | null {
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

  const mesh = new THREE.Mesh(geometry, material);
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
  terrainClipmap: TerrainClipmap | null = null;
  landmarks: THREE.Object3D | null = null;
  landmarkShadowProxy: LandmarkShadowProxy | null = null;
  onTileColliders: (key: string, colliders: BuildingCollider[]) => void = () => {};
  onTileUnload: (key: string) => void = () => {};
  // fired when a building's SOLID state flips at runtime (full suppress / revive)
  // so the physics query world can add or drop its collider. Mesh-only
  // suppression keeps the collider, so it does NOT fire this.
  onBuildingAlive: (key: string, index: number, alive: boolean) => void = () => {};
  onShadowCastersChanged: (scope?: StaticShadowScope) => void = () => {};
  /** Fired once per newly created tile batch (building/road/park) so the app
   *  can warm its render pipeline off the critical path (renderer.compileAsync)
   *  instead of paying a serial compile on the first live frame that draws it. */
  onBatchCreated: (mesh: THREE.BatchedMesh) => void = () => {};
  /** M10: fired at tile finalize with the tile's part meshes BEFORE any of them
   *  attaches, so the app can compile first-seen material/geometry signatures
   *  through the gated compileAsync. Without this the FIRST tile's bundle draw
   *  sync-created its whole material family's pipelines inside a live frame. */
  onTileFinalized: (meshes: THREE.Object3D[]) => void = () => {};
  /** M10: true while the render pipeline's exclusive compile gate is holding
   *  presented frames. While held, the LIVE (non-turbo) drain path pauses
   *  attach/finalize work: attaches during held frames dirty their bundles
   *  invisibly, and every dirty bundle then re-records (plus first-draw
   *  pipeline creations) in the single first live frame after the window —
   *  measured as a ~575 ms frame (38 bundle records + 45 pipelines) early in
   *  the sweep. Turbo (covered boot) intentionally ignores this. */
  isRenderHeld: () => boolean = () => false;

  #loader = new GLTFLoader();
  #scene: THREE.Scene;
  #pending = new Map<string, TileLoadToken>();
  // A fetch can be aborted, but GLTFLoader.parseAsync/Meshopt decode cannot.
  // Superseded tokens that already crossed that boundary stay counted here
  // until their parse settles. Otherwise every rapid arrival can start another
  // decode pool and turn latest-wins navigation into unbounded hidden work.
  #orphanTileLoads = new Set<TileLoadToken>();
  // Failed GLBs are never materialized as empty resident tiles. Required cells
  // get a bounded retry cycle and then fail the arrival explicitly; a new
  // arrival generation gets a fresh cycle.
  #visualFailures = new Map<string, TileVisualFailure>();
  #generation = 0;
  #nextLoadId = 0;
  #visualPrime: ActiveVisualPrime | null = null;
  #terrainCutouts = new Map<string, TerrainCutoutSpec>();
  #tick = 0;
  #entries: TileEntry[] = [];
  #queue: TileEntry[] = [];
  #px = 0;
  #pz = 0;
  // previous-frame position, for a speed estimate (see #fastStream in update())
  #prevPx = 0;
  #prevPz = 0;
  #hasPrevPos = false;
  #hasScanned = false;
  // parsed tiles awaiting finalize, drained one per frame
  #ready: ReadyTile[] = [];
  #colliderReady: ReadyColliders[] = [];
  #shadowProxyReady: ReadyShadowProxy[] = [];
  #shadowProxyBuildActive = false;
  #colliderSource: TileColliderSource | null = null;
  #unsubscribeColliderSource: (() => void) | null = null;
  #backgroundStage: number = BACKGROUND_STREAM_RADII.length;
  #backgroundRadius = Number.POSITIVE_INFINITY;
  #nextBackgroundStageAt = 0;
  // residentRadiusAround memo (reused object — no per-query allocation)
  #residentRadiusCache = { x: Number.NaN, z: Number.NaN, tick: -1e9, value: 0 };
  // tiles with pendingParts still attaching, one mesh per frame
  #attaching: string[] = [];
  // tiles whose dense park-surface detail is held back until the player descends
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
  // Shared road BatchedMesh: every resident tile's road_ mesh folds into one
  // owner (one pipeline bind, one indirect encode, per-instance frustum cull)
  // instead of one bundle draw per tile. Lazily created on the first road add,
  // after roadMat's terrain-field normal is wired in init().
  #roadBatch: TileMeshBatch | null = null;
  // Shared building BatchedMesh: every resident tile's bld_ mesh folds into one
  // owner, collapsing ~one facade draw per resident tile into a single indirect
  // encode. The blocker roads dodged — the facade material closes over a per-tile
  // "alive" texture and a modelScale-relative position — is solved here by (1) a
  // shared alive ATLAS, one row per batch instance addressed by the batch indirect
  // index + _bid column, and (2) folding the per-instance dequant matrix into the
  // BatchedMesh instance matrix so `positionLocal` is world-space and modelScale
  // drops out (see facade.ts configureFacadeBatchMaterial). Lazily created on the
  // first building add.
  #buildingBatch: TileMeshBatch | null = null;
  // The shared alive atlas backing the building batch: aliveW columns × capacity
  // rows, one row per live batch instance. Nearest-filtered, exact texel fetch —
  // no bleed between tile rows (roof-height alpha + rowFits masks depend on this).
  #buildingAtlas: THREE.DataTexture | null = null;
  #roadBatchAnnounced = false;
  #parkBatchAnnounced = false;
  #buildingAtlasData: Uint8Array | null = null;
  // per-instance birth timestamps for the three shared batches (M5)
  #buildingBirth: BatchBirth | null = null;
  #roadBirth: BatchBirth | null = null;
  #parkBirth: BatchBirth | null = null;
  // Shared park BatchedMesh: every resident tile's grn_ pier deck folds into one
  // owner (parkMat is world-position keyed with no per-tile data, so this reuses
  // the generic tileBatch exactly like roads). grn_ rides the detail cadence.
  #parkBatch: TileMeshBatch | null = null;

  // landmarks GLB still in flight (counts toward `busy` for the boot settle gate)
  #landmarksPending = false;
  #landmarkShadowProxyPending = false;
  // M12 front gate: always-resident landmark subtrees (top-level children of
  // landmarks.glb), each with a world-XZ bounds circle computed once at load.
  #landmarkGates: {
    obj: THREE.Object3D;
    x: number;
    z: number;
    r: number;
    handle?: FrontGateHandle;
  }[] = [];
  // Front gates for the landmark shadow-proxy cell meshes: a proxy must not
  // keep casting while its beauty landmark is front-hidden. Same shape as
  // #landmarkGates; rebuilt whenever the proxy (re)installs.
  #landmarkProxyGates: {
    obj: THREE.Object3D;
    x: number;
    z: number;
    r: number;
    handle?: FrontGateHandle;
  }[] = [];

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
    this.#loader.setMeshoptDecoder(MeshoptDecoder);
  }

  async init(map: WorldMap) {
    // Main-thread loader for landmarks.glb + every tile parse. Wire KTX2 before
    // the landmarks load below. Inert today (tile/landmark GLBs carry no basisu
    // textures); future-proofs them for tools/optimize-glb-textures.mjs.
    await attachKtx2Loader(this.#loader);
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
      // M5: landmarks are loaded at boot (always resident), so front-gating
      // alone suffices — per UNIQUE material, a holo-wrapped clone with a
      // front-only amount (no birth). The shared base materials must stay
      // unwrapped: they are also the clone SOURCES for per-tile material sets,
      // which get their own birth-keyed wrap in createTileMaterialSet.
      const landmarkHolo = new Map<THREE.Material, THREE.Material>();
      const holoLandmarkMaterial = (source: THREE.Material): THREE.Material => {
        let wrapped = landmarkHolo.get(source);
        if (!wrapped) {
          wrapped = source.clone();
          applyBirthFade(wrapped as THREE.MeshStandardNodeMaterial);
          landmarkHolo.set(source, wrapped);
        }
        return wrapped;
      };
      this.#loader.load("/tiles/landmarks.glb", (gltf) => {
        this.#landmarksPending = false;
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          if (mesh.name === "lm_salesforce_crown") {
            // the crown's LED display is world-position keyed; its bbox gives the
            // cylinder axis + display height range. Unique per mesh — wrap the
            // fresh instance directly (front-only), no clone needed.
            mesh.geometry.computeBoundingBox();
            const crown = createCrownMaterial(mesh.geometry.boundingBox!);
            applyBirthFade(crown);
            mesh.material = crown;
          } else if (mesh.name === "lm_bridge_goldengate") {
            mesh.material = holoLandmarkMaterial(goldenGateMat);
          } else {
            mesh.material = holoLandmarkMaterial(
              mesh.name.startsWith("lm_palace_")
                ? palaceMat
                : mesh.name.startsWith("lm_sutro_")
                  ? sutroMat
                  : plainMat
            );
          }
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          enableShadowLayer(mesh, SHADOW_LAYERS.LOCAL_STATIC);
          enableShadowLayer(mesh, SHADOW_LAYERS.FAR_PROXY);
        });
        applyLandmarkFixes(gltf.scene, map);
        const goldenGateRoad = createGoldenGateRoadSurface(map, holoLandmarkMaterial(roadMat));
        if (goldenGateRoad) gltf.scene.add(goldenGateRoad);
        // applyLandmarkFixes may add a new local caster (Coit footing).
        setLandmarkBeautyFarFallback(gltf.scene, true);
        this.landmarks = gltf.scene;
        this.#scene.add(gltf.scene);
        // M12: gate each top-level landmark subtree behind the materialize
        // front. Bounds circles computed once here (a handful of subtrees).
        gltf.scene.updateMatrixWorld(true);
        const box = new THREE.Box3();
        for (const child of gltf.scene.children) {
          box.makeEmpty();
          box.setFromObject(child);
          if (box.isEmpty()) continue;
          const x = (box.min.x + box.max.x) / 2;
          const z = (box.min.z + box.max.z) / 2;
          const r = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
          this.#landmarkGates.push({ obj: child, x, z, r });
        }
        this.#applyLandmarkFrontGate();
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
        // M12: gate the proxy cells behind the materialize front like the
        // beauty subtrees — a hidden landmark must not keep casting via its
        // proxy. Cell bounds come from each InstancedMesh's instanced bbox
        // (world space — proxy matrices are world-space, group is identity).
        for (const gate of this.#landmarkProxyGates) gate.handle?.cancel();
        this.#landmarkProxyGates.length = 0;
        for (const mesh of proxy.meshes) {
          const box = mesh.boundingBox;
          if (!box || box.isEmpty()) continue;
          const x = (box.min.x + box.max.x) / 2;
          const z = (box.min.z + box.max.z) / 2;
          const r = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
          this.#landmarkProxyGates.push({ obj: mesh, x, z, r });
        }
        this.#applyLandmarkFrontGate();
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

    // One persistent set of camera-centred GPU patches replaces the 25 streamed
    // terrain GLBs. Gameplay continues to query WorldMap directly, so visual and
    // collision heights still share the same canonical source.
    this.terrainClipmap = new TerrainClipmap(map);
    this.terrainClipmap.setCutouts([...this.#terrainCutouts.values()]);
    this.terrainClipmap.update(0, 0, true);
    this.terrain.set("terrain_clipmap", this.terrainClipmap.group);
    this.#scene.add(this.terrainClipmap.group);

    // Baked road ribbons and park lawns are flat-shaded CDT drapes; rebase
    // their bump on the clipmap's terrain lighting field so ground shading is
    // seamless (the height gate inside keeps piers/bridge decks on their own
    // normals). Must run before any residency clones or pipeline warmup.
    const groundBase = this.terrainClipmap.groundConformNormalBase();
    for (const mat of [roadMat, parkMat]) {
      mat.normalNode = bumpNormal(mat.userData.bumpHeightNode, groundBase);
      mat.needsUpdate = true;
    }
    // Groundcover (grass blades etc.) builds later, behind region deferral —
    // hand it the same lighting field so hillside cover shades with the hill.
    const clipmap = this.terrainClipmap;
    registerTerrainFieldNormal((worldXZ) => clipmap.worldFieldNormal(worldXZ));
  }

  keyToCenter(key: string): [number, number] {
    const [ix, iz] = key.split("_").map(Number);
    return [
      this.manifest.minX + ix * this.manifest.tile + this.manifest.tile / 2,
      this.manifest.minZ + iz * this.manifest.tile + this.manifest.tile / 2
    ];
  }

  /**
   * Connect the one canonical collider service after Physics initializes it.
   * Only finalized, live visual residencies hold a low-priority lease. Canonical
   * callbacks are staged through #colliderReady and revalidated by loadId before
   * any visual/physics/far-field observer is notified.
   */
  setColliderSource(source: TileColliderSource): void {
    if (this.#colliderSource === source) return;
    if (this.#colliderSource) {
      for (const tile of this.loaded.values()) {
        if (!tile.loadToken.colliderRetained) continue;
        this.#colliderSource.releaseTile(tile.key);
        tile.loadToken.colliderRetained = false;
      }
    }
    this.#unsubscribeColliderSource?.();
    this.#colliderSource = source;
    this.#unsubscribeColliderSource = source.subscribe((key, colliders) => {
      this.#receiveCanonicalColliders(key, colliders);
    });
    for (const tile of this.loaded.values()) this.#retainCanonicalColliders(tile.key, tile.loadToken);
  }

  /**
   * Outstanding visual streaming work, for the boot settle gate: queued/in-flight
   * GLBs, parsed-but-unfinalized tiles, meshes still attaching, pending
   * disposals, landmarks GLB and landmark shadow proxy. Reports
   * 1 before the first scan so a just-constructed streamer never reads as settled.
   * Intentionally excludes #deferred and does not wait on an in-flight collider
   * worker after its visual GLB finalized. Completed collider/shadow apply jobs
   * remain counted while queued so steady-state diagnostics still see them.
   */
  get busy(): number {
    if (!this.#hasScanned) return 1;
    return (
      this.#queue.length +
      this.#pending.size +
      this.#orphanTileLoads.size +
      this.#ready.length +
      this.#colliderReady.length +
      this.#shadowProxyReady.length +
      (this.#shadowProxyBuildActive ? 1 : 0) +
      this.#attaching.length +
      this.#unloads.size +
      (this.#landmarksPending ? 1 : 0) +
      (this.#landmarkShadowProxyPending ? 1 : 0)
    );
  }

  update(px: number, pz: number, highUp = false, turbo = false) {
    this.#tick++;
    // While a relocation is preparing, the authoritative player intentionally
    // remains frozen at the origin. Keep every scan, late-completion check and
    // distance priority focused on the destination until visual readiness hands
    // control back to the coordinator for the atomic commit.
    const focusX = this.#visualPrime?.focusX ?? px;
    const focusZ = this.#visualPrime?.focusZ ?? pz;
    this.#px = focusX;
    this.#pz = focusZ;
    this.terrainClipmap?.update(focusX, focusZ);
    // speed estimate (world units/sec): update() carries no dt, so this assumes
    // a steady ~60fps between calls — good enough to gate cadence, not physics
    if (this.#hasPrevPos) {
      const speed = Math.hypot(focusX - this.#prevPx, focusZ - this.#prevPz) * 60;
      this.#fastStream = this.#fastStream ? speed > 28 : speed > 40;
      this.#maxInFlight = turbo ? MAX_IN_FLIGHT_TURBO : this.#fastStream ? MAX_IN_FLIGHT_FAST : MAX_IN_FLIGHT;
    }
    this.#prevPx = focusX;
    this.#prevPz = focusZ;
    this.#hasPrevPos = true;
    if (!this.#visualPrime && this.#backgroundStage < BACKGROUND_STREAM_RADII.length) {
      if (this.#fastStream || performance.now() >= this.#nextBackgroundStageAt) {
        if (this.#fastStream) {
          this.#backgroundStage = BACKGROUND_STREAM_RADII.length;
          this.#backgroundRadius = Number.POSITIVE_INFINITY;
        } else {
          this.#backgroundStage++;
          this.#backgroundRadius = this.#backgroundStage < BACKGROUND_STREAM_RADII.length
            ? BACKGROUND_STREAM_RADII[this.#backgroundStage]
            : Number.POSITIVE_INFINITY;
          this.#nextBackgroundStageAt = performance.now() + BACKGROUND_STREAM_STAGE_MS;
        }
        this.#scan(focusX, focusZ);
      }
    }
    if (highUp !== this.#highUp) {
      this.#highUp = highUp;
      // descended: re-queue every tile whose dense park-surface detail was
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
    if (this.#tick % (turbo ? 5 : this.#fastStream ? 10 : 30) === 1) this.#scan(focusX, focusZ);
    // TURBO (boot, behind the opaque loading cover): nothing on screen, so
    // per-frame smoothness doesn't matter — drain finalizes/attaches/disposals
    // under a flat ms budget instead of one per frame, and let the scan above
    // run hotter. The cover only lifts once `busy` reaches 0 (see main.ts).
    if (turbo) {
      const deadline = performance.now() + 10;
      while (performance.now() < deadline) {
        let drained = this.#drainAttach() || this.#drainReady();
        if (!drained && !this.#visualPrime) {
          drained = this.#drainColliderReady() || this.#drainUnload();
        }
        if (!drained) break;
      }
      this.#checkVisualPrime();
      return;
    }
    // M10: presented frames are held (exclusive compile window) — pause the
    // live drain entirely so scene mutations can't accumulate unseen and land
    // as one giant record/first-draw frame when the window ends. Prime
    // completion still re-checks so a covered arrival can't stall on a warm.
    if (this.isRenderHeld()) {
      this.#checkVisualPrime();
      return;
    }
    // one mesh attach (GPU upload) OR one finalize OR one dispose per frame,
    // so tile streaming costs stay flat instead of spiking when loads land in
    // bursts. Exception: while #catchingUp, drain up to 4/frame so a
    // post-descent detail backlog (see #resumeDetail) clears in a handful of
    // frames instead of trickling in one mesh at a time.
    let spent = false;
    // Once the local visual minimum is ready, interleave old-region retirement
    // and deferred collider/shadow application with remaining visual uploads.
    // Neither can starve behind the full draw ring or re-form a burst.
    if (!spent && !this.#visualPrime && this.#tick % 4 === 0) {
      spent = this.#drainUnload();
    }
    if (!spent && !this.#visualPrime && this.#tick % 2 === 0) {
      spent = this.#drainColliderReady();
    }
    if (!spent) {
      for (let i = 0, n = this.#catchingUp ? 4 : 1; i < n; i++) {
        if (!this.#drainAttach()) { this.#catchingUp = false; break; }
        spent = true;
      }
    }
    if (!spent) spent = this.#drainReady();
    if (!spent && !this.#visualPrime) spent = this.#drainColliderReady();
    if (!spent && !this.#visualPrime) this.#drainUnload();
    // Latest-wins cuts may leave already-decoded work from an older generation.
    // Retire one stale/hidden unit at a low cadence under the opaque cover so it
    // cannot accumulate into a cleanup burst immediately after reveal.
    if (!spent && this.#visualPrime && this.#tick % 8 === 0) {
      this.#discardOneStaleTileReady() || this.#drainUnload();
    }
    this.#checkVisualPrime();
  }

  /** Re-evaluate load/unload immediately (e.g. after a draw-distance change). */
  forceScan() {
    if (this.#hasScanned) {
      this.terrainClipmap?.update(this.#px, this.#pz, true);
      this.#scan(this.#px, this.#pz);
    }
  }

  /**
   * Release a completed destination-minimum hold and resume the ordinary fixed
   * draw ring. World arrival calls this only after reveal and collision release,
   * so background Meshopt/decode work cannot steal the final interaction frames.
   */
  resumeBackgroundStreaming(): void {
    const prime = this.#visualPrime;
    if (!prime?.settled || prime.generation !== this.#generation) return;
    this.#visualPrime = null;
    this.beginBackgroundExpansion();
  }

  /** Restart the ordinary ring center-out after boot restores the user's full
   * draw distance or a covered arrival releases its destination hold. */
  beginBackgroundExpansion(): void {
    if (this.#visualPrime) return;
    this.#backgroundStage = 0;
    this.#backgroundRadius = BACKGROUND_STREAM_RADII[0];
    this.#nextBackgroundStageAt = performance.now() + BACKGROUND_STREAM_STAGE_MS;
    this.#scan(this.#px, this.#pz);
  }

  get backgroundStreamingDebug(): Readonly<{
    stage: number;
    radius: number;
    fullRadius: number;
  }> {
    return {
      stage: this.#backgroundStage,
      radius: this.#currentLoadRadius(),
      fullRadius: CONFIG.tileLoadRadius
    };
  }

  /**
   * Largest radius R around (x,z) such that every WANTED tile whose bounds
   * intersect the disc of radius R is fully attached (its pendingParts /
   * pendingRoadParts / pendingBuildingParts queues drained). "Wanted" mirrors
   * `#scan`'s own criterion — tile CENTER inside the current load radius — so
   * a rim tile whose bounds graze the disc but whose center sits outside is
   * (correctly) never counted as missing; the value is capped at
   * `#currentLoadRadius()` because beyond it nothing is requested, so nothing
   * constrains. Terminally failed tiles never attach and are deliberately
   * non-blocking (the ring coordinator's front must not stall forever on a
   * missing GLB; that area renders as the terrain fallback). Held-back park
   * DETAIL (`detailParts`, a deliberate high-altitude quality deferral) does
   * not block either. Terrain clipmap and landmarks are always resident.
   *
   * Cost: one pass over the manifest entries (~205 tiles), recomputed at most
   * every RESIDENT_RADIUS_RECOMPUTE_TICKS streamer ticks and cached — callers
   * may read it every frame.
   */
  residentRadiusAround(x: number, z: number): number {
    const cache = this.#residentRadiusCache;
    if (
      this.#tick - cache.tick < RESIDENT_RADIUS_RECOMPUTE_TICKS &&
      Math.abs(x - cache.x) < 1 &&
      Math.abs(z - cache.z) < 1
    ) {
      return cache.value;
    }
    cache.tick = this.#tick;
    cache.x = x;
    cache.z = z;
    if (!this.manifest || this.#entries.length === 0) {
      cache.value = 0;
      return 0;
    }
    tracer.count("tileResidencyScan");
    const half = this.manifest.tile * 0.5;
    let r = this.#currentLoadRadius();
    if (!Number.isFinite(r)) r = CONFIG.tileLoadRadius;
    const wantedR2 = r * r;
    for (const e of this.#entries) {
      const cdx = x - e.cx;
      const cdz = z - e.cz;
      if (cdx * cdx + cdz * cdz >= wantedR2) continue; // not wanted (see #scan)
      const dx = Math.max(0, Math.abs(cdx) - half);
      const dz = Math.max(0, Math.abs(cdz) - half);
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      const tile = this.loaded.get(e.key);
      const resident =
        tile !== undefined &&
        (tile.pendingParts?.length ?? 0) === 0 &&
        (tile.pendingRoadParts?.length ?? 0) === 0 &&
        (tile.pendingBuildingParts?.length ?? 0) === 0;
      if (resident) continue;
      if (this.#visualFailures.get(e.key)?.terminal) continue;
      r = Math.sqrt(d2);
    }
    cache.value = r;
    return r;
  }

  /**
   * Begin a destination-first visual arrival. This bypasses periodic movement
   * scans, gives the destination a fresh monotonic generation, and returns a
   * promise for only the local visual minimum. The caller releases the full
   * fixed-radius stream after its covered reveal/interaction milestone through
   * `resumeBackgroundStreaming()`.
   *
   * Collider JSON, shadow proxies and park detail deliberately do not gate the
   * promise. Callers can reveal a correct destination frame, hold movement, and
   * let the independently coordinated collision arrival unlock interaction.
   */
  primeAt(px: number, pz: number): TileVisualPrime {
    const previous = this.#visualPrime;
    if (previous && !previous.settled) this.#resolveVisualPrime(previous, "superseded");

    const generation = ++this.#generation;
    this.#px = px;
    this.#pz = pz;
    // A discontinuous relocation is not fast travel through every point between
    // the old and new positions. Reset the speed estimator so it cannot trigger
    // movement-stream heuristics or intermediate-region work.
    this.#prevPx = px;
    this.#prevPz = pz;
    this.#hasPrevPos = true;
    this.#fastStream = false;
    this.#maxInFlight = MAX_IN_FLIGHT;

    const minimumRadius = Math.min(MINIMUM_VISUAL_RADIUS_CAP, this.manifest.tile * 0.45);
    const radiusSq = minimumRadius * minimumRadius;
    const requiredTileKeys = this.#entries
      .filter((entry) => this.#distanceToTileBoundsSq(px, pz, entry) <= radiusSq)
      .sort((a, b) => {
        const ad = (px - a.cx) * (px - a.cx) + (pz - a.cz) * (pz - a.cz);
        const bd = (px - b.cx) * (px - b.cx) + (pz - b.cz) * (pz - b.cz);
        return ad - bd;
      })
      .map((entry) => entry.key);
    const requiredTerrainKeys = this.terrainClipmap ? ["terrain_clipmap"] : [];

    let resolve!: (result: TileVisualPrimeResult) => void;
    const ready = new Promise<TileVisualPrimeResult>((done) => { resolve = done; });
    const state: ActiveVisualPrime = {
      generation,
      focusX: px,
      focusZ: pz,
      requiredTileKeys,
      requiredTileSet: new Set(requiredTileKeys),
      requiredTerrainKeys,
      resolve,
      settled: false
    };
    this.#visualPrime = state;

    this.terrainClipmap?.update(px, pz, true);
    this.#adoptDestinationWork(px, pz, generation);
    this.#scan(px, pz);
    this.#checkVisualPrime();

    return {
      generation,
      requiredTileKeys: [...requiredTileKeys],
      requiredTerrainKeys: [...requiredTerrainKeys],
      ready
    };
  }

  #adoptDestinationWork(px: number, pz: number, generation: number): void {
    const prime = this.#visualPrime?.generation === generation ? this.#visualPrime : null;
    if (!prime) return;
    const tileLoadRadiusSq = CONFIG.tileLoadRadius * CONFIG.tileLoadRadius;
    for (const [key, token] of this.#pending) {
      // A pending full-ring request can occupy both current-generation decode
      // slots and delay the one-to-four cells that actually gate the cut. Reuse
      // overlapping minimum work; retire everything else until the prime lands.
      if (prime.requiredTileSet.has(key)) {
        token.generation = generation;
      } else {
        this.#cancelTileLoad(key, token);
      }
    }
    for (const tile of this.loaded.values()) {
      const [cx, cz] = this.keyToCenter(tile.key);
      const dx = px - cx;
      const dz = pz - cz;
      const destinationRelevant = dx * dx + dz * dz <= tileLoadRadiusSq;
      // M12: routed through the front gate — a destination-relevant tile that
      // still lies beyond the (about-to-refocus) front stays gate-managed.
      this.#applyTileVisibility(tile, destinationRelevant);
      if (!destinationRelevant) continue;
      tile.generation = generation;
      tile.loadToken.generation = generation;
      this.#queueColliderApply(tile.key, tile.loadToken);
    }
  }

  #distanceToTileBoundsSq(px: number, pz: number, entry: TileEntry): number {
    const half = this.manifest.tile * 0.5;
    const dx = Math.max(0, Math.abs(px - entry.cx) - half);
    const dz = Math.max(0, Math.abs(pz - entry.cz) - half);
    return dx * dx + dz * dz;
  }

  #checkVisualPrime(): void {
    const prime = this.#visualPrime;
    if (!prime || prime.settled || prime.generation !== this.#generation) return;
    for (const key of prime.requiredTileKeys) {
      const failure = this.#visualFailures.get(key);
      if (failure?.generation === prime.generation && failure.terminal) {
        this.#resolveVisualPrime(prime, "failed");
        return;
      }
      const tile = this.loaded.get(key);
      if (
        !tile ||
        (tile.pendingParts?.length ?? 0) > 0 ||
        (tile.pendingRoadParts?.length ?? 0) > 0 ||
        (tile.pendingBuildingParts?.length ?? 0) > 0
      ) return;
    }
    for (const name of prime.requiredTerrainKeys) {
      if (!this.terrain.has(name)) return;
    }
    this.#resolveVisualPrime(prime, "ready");
  }

  #resolveVisualPrime(prime: ActiveVisualPrime, status: TileVisualPrimeResult["status"]): void {
    if (prime.settled) return;
    prime.settled = true;
    // A successful minimum remains the current required-only hold until the
    // coordinator finishes reveal and collision release. Failed/old generations
    // cannot own future streaming and are cleared immediately.
    if (status !== "ready" && this.#visualPrime === prime) this.#visualPrime = null;
    prime.resolve({
      generation: prime.generation,
      status,
      requiredTileKeys: [...prime.requiredTileKeys],
      requiredTerrainKeys: [...prime.requiredTerrainKeys]
    });
  }

  #disposeObjectGeometry(object: THREE.Object3D | null): void {
    object?.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }

  /**
   * Hand a small oriented footprint from the GPU clipmap to authored
   * geometry. IDs make ownership explicit and let the feature undo its claim on
   * disposal or failed creation. A hard three-slot cap bounds terrain shader cost.
   */
  setTerrainCutout(id: string, cutout: TerrainCutoutSpec): void {
    if (!id) throw new Error("terrain cutout id must be non-empty");
    if (
      !Number.isFinite(cutout.centerX) ||
      !Number.isFinite(cutout.centerZ) ||
      !Number.isFinite(cutout.halfX) ||
      !Number.isFinite(cutout.halfZ) ||
      !Number.isFinite(cutout.yaw) ||
      cutout.halfX <= 0 ||
      cutout.halfZ <= 0
    ) {
      throw new Error(`terrain cutout ${id} must have finite positive bounds`);
    }
    if (!this.#terrainCutouts.has(id) && this.#terrainCutouts.size >= TERRAIN_CUTOUT_CAPACITY) {
      throw new Error(`terrain cutout capacity ${TERRAIN_CUTOUT_CAPACITY} exceeded by ${id}`);
    }
    this.#terrainCutouts.set(id, { ...cutout });
    this.terrainClipmap?.setCutouts([...this.#terrainCutouts.values()]);
    this.onShadowCastersChanged("all");
  }

  clearTerrainCutout(id: string): void {
    if (!this.#terrainCutouts.delete(id)) return;
    this.terrainClipmap?.setCutouts([...this.#terrainCutouts.values()]);
    this.onShadowCastersChanged("all");
  }

  /** Read-only diagnostics used by focused site/runtime probes. */
  get terrainCutoutDebug(): { capacity: number; active: readonly string[] } {
    return {
      capacity: TERRAIN_CUTOUT_CAPACITY,
      active: [...this.#terrainCutouts.keys()]
    };
  }

  #scan(px: number, pz: number) {
    this.#px = px;
    this.#pz = pz;
    this.#hasScanned = true;
    const loadRadius = this.#currentLoadRadius();
    const loadR2 = loadRadius * loadRadius;
    const unloadR2 = CONFIG.tileUnloadRadius * CONFIG.tileUnloadRadius;
    const required = this.#visualPrime?.generation === this.#generation
      ? this.#visualPrime.requiredTileSet
      : null;
    this.#queue.length = 0;
    const now = performance.now();
    for (const e of this.#entries) {
      e.d2 = (px - e.cx) * (px - e.cx) + (pz - e.cz) * (pz - e.cz);
      const loadedTile = this.loaded.get(e.key);
      if (loadedTile && e.d2 < loadR2 && loadedTile.generation !== this.#generation) {
        // M12: routed through the front gate (re-adopted tiles beyond a
        // sweeping front stay hidden until the front approaches).
        this.#applyTileVisibility(loadedTile, true);
        loadedTile.generation = this.#generation;
        loadedTile.loadToken.generation = this.#generation;
        this.#queueColliderApply(e.key, loadedTile.loadToken);
      }
      const isLoaded = this.loaded.has(e.key) || this.#pending.has(e.key);
      const failure = this.#visualFailures.get(e.key);
      const retryEligible =
        !failure ||
        failure.generation !== this.#generation ||
        (!failure.terminal && now >= failure.retryAt);
      if (
        e.d2 < loadR2 &&
        !isLoaded &&
        retryEligible &&
        (!required || required.has(e.key))
      ) {
        this.#queue.push(e);
      } else if (e.d2 > unloadR2 && this.loaded.has(e.key)) {
        this.#unloads.add(e.key);
      }
    }
    // An active prime admits only destination-minimum cells. Once it resolves,
    // the rebuilt fixed-radius queue remains nearest-first and place-agnostic.
    this.#queue.sort((a, b) => {
      const ar = required?.has(a.key) ? 0 : 1;
      const br = required?.has(b.key) ? 0 : 1;
      return ar === br ? a.d2 - b.d2 : ar - br;
    });
    this.#pump();
    // Facade near/far material swap: far tiles drop brick/weather noise ALU.
    // Hysteresis on enter/exit; BundleGroup re-records only when the bind changes.
    for (const tile of this.loaded.values()) {
      this.#retainCanonicalColliders(tile.key, tile.loadToken);
      if (!tile.slot) continue;
      const [cx, cz] = this.keyToCenter(tile.key);
      const d = Math.hypot(px - cx, pz - cz);
      const wantFar = tile.slot.far ? d > FACADE_FAR_EXIT : d >= FACADE_FAR_ENTER;
      if (this.#applyFacadeLod(tile, wantFar)) {
        (tile.group as THREE.BundleGroup).needsUpdate = true;
      }
      if (tile.shadowProxy && !this.#shadowProxyWanted(tile.key, SHADOW_PROXY_EXIT_RADIUS)) {
        tile.shadowProxy.dispose();
        tile.shadowProxy = null;
        this.onShadowCastersChanged(this.#shadowScopeForTile(tile.key));
      } else if (!tile.shadowProxy) {
        this.#queueShadowProxy(tile.key, tile.loadToken);
      }
    }
  }

  #pump() {
    const loadRadius = this.#currentLoadRadius();
    const loadR2 = loadRadius * loadRadius;
    const required = this.#visualPrime?.generation === this.#generation
      ? this.#visualPrime.requiredTileSet
      : null;
    let { current, total } = this.#tileInFlightCounts();
    while (
      current < this.#maxInFlight &&
      (
        total < MAX_IN_FLIGHT_GLOBAL ||
        (current < MIN_CURRENT_IN_FLIGHT_RESERVE && total < MAX_IN_FLIGHT_ABSOLUTE)
      ) &&
      this.#queue.length > 0
    ) {
      const e = this.#queue[0];
      // #scan already filters this queue. Keep the launch boundary defensive so
      // an async completion can never pump stale full-ring work during a prime.
      if (required && !required.has(e.key)) break;
      this.#queue.shift();
      if (this.loaded.has(e.key) || this.#pending.has(e.key)) continue;
      // the queue can be stale (player moved, radius shrank) — re-check before fetching
      const d2 = (this.#px - e.cx) * (this.#px - e.cx) + (this.#pz - e.cz) * (this.#pz - e.cz);
      if (d2 > loadR2) continue;
      this.#loadTile(e.key, this.#generation);
      current++;
      total++;
    }
  }

  #currentLoadRadius(): number {
    return this.#visualPrime
      ? CONFIG.tileLoadRadius
      : Math.min(CONFIG.tileLoadRadius, this.#backgroundRadius);
  }

  #tileInFlightCounts(): { current: number; total: number } {
    let current = 0;
    let total = 0;
    for (const token of this.#pending.values()) {
      if (!token.visualInFlight) continue;
      total++;
      if (token.generation === this.#generation) current++;
    }
    for (const token of this.#orphanTileLoads) {
      if (token.visualInFlight) total++;
    }
    return { current, total };
  }

  #loadTile(key: string, generation: number) {
    const controller = new AbortController();
    const priorFailure = this.#visualFailures.get(key);
    const attempt = priorFailure?.generation === generation ? priorFailure.attempts + 1 : 1;
    const token: TileLoadToken = {
      id: ++this.#nextLoadId,
      generation,
      attempt,
      visualInFlight: true,
      colliderSettled: false,
      colliders: null,
      finalized: false,
      discarded: false,
      collidersApplied: false,
      collidersPublished: false,
      colliderRetained: false,
      abortController: controller
    };
    this.#pending.set(key, token);

    // Visual fetch/decode and canonical collider loading are independent. The
    // main-thread visual finalize can reach the destination frame while physics
    // data continues in its bounded worker service.
    const enqueueVisual = (group: THREE.Group | null) => {
      token.visualInFlight = false;
      token.abortController = null;
      this.#orphanTileLoads.delete(token);
      if (token.discarded) {
        this.#disposeObjectGeometry(group);
        this.#pump();
        return;
      }
      this.#visualFailures.delete(key);
      this.#ready.push({ key, group, token });
      this.#pump();
    };

    const fetchTimer = setTimeout(() => controller.abort(), TILE_FETCH_TIMEOUT_MS);
    void fetch(`/tiles/tile_${key}.glb`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        clearTimeout(fetchTimer);
        if (token.discarded) return null;
        return this.#loader.parseAsync(buffer, "/tiles/");
      })
      .then((gltf) => enqueueVisual(gltf?.scene ?? null))
      .catch((error: unknown) => {
        clearTimeout(fetchTimer);
        // Abort-before-parse and failures during parse both have to release the
        // global decode slot. A discarded token still owns that slot until here.
        if (token.discarded) {
          enqueueVisual(null);
          return;
        }
        this.#recordVisualFailure(key, token, error);
      });
  }

  #recordVisualFailure(key: string, token: TileLoadToken, error: unknown): void {
    token.visualInFlight = false;
    token.abortController = null;
    token.discarded = true;
    this.#orphanTileLoads.delete(token);
    if (this.#pending.get(key) === token) this.#pending.delete(key);
    const terminal = token.attempt >= TILE_MAX_ATTEMPTS;
    const retryDelay = terminal ? 0 : TILE_RETRY_DELAYS_MS[token.attempt - 1];
    const reason = error instanceof Error ? error.message : String(error);
    this.#visualFailures.set(key, {
      generation: token.generation,
      attempts: token.attempt,
      retryAt: performance.now() + retryDelay,
      terminal,
      reason
    });
    if (terminal) {
      console.warn(`[tiles] ${key} unavailable after ${token.attempt} attempts: ${reason}`);
    }
    this.#checkVisualPrime();
    this.#pump();
  }

  #cancelTileLoad(key: string, token: TileLoadToken): void {
    if (token.discarded) return;
    token.discarded = true;
    token.abortController?.abort();
    token.abortController = null;
    if (this.#pending.get(key) === token) this.#pending.delete(key);
    if (token.visualInFlight) this.#orphanTileLoads.add(token);
  }

  #takeSlot(): FacadeSlot {
    const pooled = this.#slotPool.pop();
    if (pooled) {
      // Recreate node graphs only for a slot that is actually being reused.
      // Retirement itself stays allocation-free after disposal.
      pooled.matNear = createFacadeMaterial(pooled.tex, this.#aliveW, { detail: true });
      pooled.matFar = createFacadeMaterial(pooled.tex, this.#aliveW, { detail: false });
      return pooled;
    }
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

  #recycleSlot(slot: FacadeSlot): void {
    // Dispose the exact materials that were paired with this tile's geometries
    // before those geometries become unreachable. Three's WebGPU backend uses
    // this signal to release its material/geometry render-object associations.
    slot.matNear?.dispose();
    slot.matFar?.dispose();
    slot.matNear = null;
    slot.matFar = null;
    slot.far = false;
    if (this.#slotPool.length >= MAX_FACADE_SLOT_POOL) {
      slot.tex.dispose();
      return;
    }
    this.#slotPool.push(slot);
  }

  /** Bind near or far facade material on every building mesh in a tile. Returns
   *  true when the binding changed (caller must re-record the BundleGroup).
   *  Batched facades render through the shared always-detail batch material (which
   *  already cross-fades brick/weather to flat by distance), so they have no
   *  per-tile material to swap — only bundle-fallback tiles LOD-swap. A tile whose
   *  bld mesh is still queued for the batch also has nothing to swap yet. */
  #applyFacadeLod(tile: LoadedTile, wantFar: boolean): boolean {
    const slot = tile.slot;
    if (!slot || slot.far === wantFar) return false;
    if (tile.buildingBatched || (tile.pendingBuildingParts?.length ?? 0) > 0) return false;
    slot.far = wantFar;
    const mat = wantFar ? slot.matFar : slot.matNear;
    if (!mat) return false;
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

  #bestReadyIndex(): number {
    if (this.#ready.length === 0) return -1;
    const required = this.#visualPrime?.generation === this.#generation
      ? this.#visualPrime.requiredTileSet
      : null;
    let best = 0;
    let bestRank = Infinity;
    let bestDistance = Infinity;
    for (let i = 0; i < this.#ready.length; i++) {
      const item = this.#ready[i];
      const current = item.token.generation === this.#generation;
      const rank = current ? (required?.has(item.key) ? 0 : 1) : 2;
      const [cx, cz] = this.keyToCenter(item.key);
      const distance = (this.#px - cx) * (this.#px - cx) + (this.#pz - cz) * (this.#pz - cz);
      if (rank < bestRank || (rank === bestRank && distance < bestDistance)) {
        best = i;
        bestRank = rank;
        bestDistance = distance;
      }
    }
    if (this.#visualPrime && bestRank >= 2) return -1;
    return best;
  }

  /** Finalize one parsed tile: alive texture, materials, scene add. Returns false when idle. */
  #drainReady(): boolean {
    const index = this.#bestReadyIndex();
    if (index < 0) return false;
    const [{ key, group, token }] = this.#ready.splice(index, 1);
    if (this.#pending.get(key) === token) this.#pending.delete(key);
    // flown past while it sat in the queue? skip the scene add / GPU upload
    // entirely — the next scan reloads it if the player comes back
    const [cx, cz] = this.keyToCenter(key);
    const d2 = (this.#px - cx) * (this.#px - cx) + (this.#pz - cz) * (this.#pz - cz);
    if (token.generation !== this.#generation || d2 > CONFIG.tileUnloadRadius * CONFIG.tileUnloadRadius) {
      token.discarded = true;
      this.#disposeObjectGeometry(group);
      this.#pump();
      return true;
    }
    const colliders = token.colliderSettled ? (token.colliders ?? []) : null;
    const nB = Math.max(4, this.manifest.tiles[key].b);
    let slot: FacadeSlot | null = null;
    if (group) {
      // M5: one shared birth uniform per tile residency. Stamped now (the
      // first core mesh attaches next frame); forgotten on unload so a later
      // reload re-births. Content the front has not reached is still gated by
      // the front (min(front, birth)); content landing after the front passed
      // plays the ~1 s birth ramp instead of popping.
      const birth = materializeField.birthOf(`tile:${key}`);
      materializeField.markBorn(`tile:${key}`);
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
      for (const c of colliders ?? []) {
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
      // Facade slot materials are per-residency (recreated on pool reuse in
      // #takeSlot), so wiring the holo-birth mix here — before any mesh binds
      // them — keeps one graph shape while the birth uniform stays per-tile.
      applyBirthFade(slot.matNear!, { birth });
      applyBirthFade(slot.matFar!, { birth });
      const bMat = slot.far ? slot.matFar! : slot.matNear!;
      const materials = createTileMaterialSet(birth);
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
          mesh.material = materials.road;
          mesh.receiveShadow = true;
        } else if (mesh.name.startsWith("grn_")) {
          mesh.material = materials.park;
          mesh.receiveShadow = true;
        } else if (mesh.name.startsWith("lm_")) {
          // Authored landmarks now live in their geographic tile instead of
          // the always-resident landmark bundle. Palace keeps its warm stone
          // multiplier; Sutro stays near-neutral so its safety stripes read.
          mesh.material = mesh.name.startsWith("lm_palace_")
            ? materials.palace
            : mesh.name.startsWith("lm_sutro_")
              ? materials.sutro
              : materials.plain;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        } else {
          mesh.material = materials.plain;
          mesh.receiveShadow = true;
        }
      });
      // the group enters the scene empty; its meshes re-attach one per frame in
      // #drainAttach so a big tile can't upload all its geometry in one frame.
      // buildings (bld_) and roads (road_) fold into their shared BatchedMesh at
      // core cadence; landmarks/misc are "core" bundle meshes; park ground (grn_)
      // is "detail" (held back while the player is high). Compose the
      // dequantization matrices now so each batched instance can carry its world
      // transform into the arena.
      group.updateMatrixWorld(true);
      const core: THREE.Object3D[] = [];
      const detail: THREE.Object3D[] = [];
      const roadParts: THREE.Mesh[] = [];
      const buildingParts: THREE.Mesh[] = [];
      for (const o of group.children) {
        const mesh = o as THREE.Mesh;
        if (o.name.startsWith("grn_")) detail.push(o);
        else if (mesh.isMesh && o.name.startsWith("road_")) roadParts.push(mesh);
        else if (mesh.isMesh && mesh.geometry?.getAttribute("_bid")) buildingParts.push(mesh);
        else core.push(o);
      }
      group.clear();
      // static tile content renders as one WebGPU render bundle: ~40 per-building
      // draws per tile collapse to a cached command buffer, so per-frame encode
      // cost stops scaling with building count. Building hide/show (citygen swap)
      // rides the alive TEXTURE, never mesh structure, so the bundle
      // only re-records while the tile is still attaching parts.
      const bundle = new THREE.BundleGroup();
      bundle.name = `tile_${key}`;
      this.#scene.add(bundle);
      // Signature warm hook BEFORE the first part can attach (attach starts on
      // a later frame; the gated compile holds live frames while it runs).
      this.onTileFinalized([...core, ...detail, ...roadParts, ...buildingParts]);
      this.loaded.set(key, {
        key,
        group: bundle,
        slot,
        materials,
        colliders: null,
        shadowProxy: null,
        generation: token.generation,
        loadId: token.id,
        loadToken: token,
        pendingParts: core,
        detailParts: detail.length ? detail : undefined,
        pendingRoadParts: roadParts.length ? roadParts : undefined,
        pendingBuildingParts: buildingParts.length ? buildingParts : undefined
      });
      this.#attaching.push(key);
      // M12: a tile finalizing beyond the sweeping front starts hidden (empty
      // bundle now; batch instances folded in later start hidden via the
      // existing `!tile.group.visible` checks). Warm/attach work is untouched.
      this.#applyTileVisibility(this.loaded.get(key)!, true);
    } else {
      this.loaded.set(key, {
        key,
        group: new THREE.Group(),
        slot,
        materials: null,
        colliders: null,
        shadowProxy: null,
        generation: token.generation,
        loadId: token.id,
        loadToken: token
      });
    }
    token.finalized = true;
    this.#retainCanonicalColliders(key, token);
    this.#queueColliderApply(key, token);
    this.#pump();
    return true;
  }

  #discardOneStaleTileReady(): boolean {
    const index = this.#ready.findIndex((item) => item.token.generation !== this.#generation);
    if (index < 0) return false;
    const [{ key, group, token }] = this.#ready.splice(index, 1);
    if (this.#pending.get(key) === token) this.#pending.delete(key);
    token.discarded = true;
    this.#disposeObjectGeometry(group);
    this.#pump();
    return true;
  }

  #queueColliderApply(key: string, token: TileLoadToken): void {
    if (
      !token.colliderSettled ||
      !token.finalized ||
      token.discarded ||
      token.collidersApplied ||
      this.#colliderReady.some((item) => item.token === token)
    ) return;
    this.#colliderReady.push({
      key,
      token,
      colliderCursor: 0,
      topOf: new Map(),
      topEntries: null,
      topCursor: 0
    });
  }

  #retainCanonicalColliders(key: string, token: TileLoadToken): void {
    const source = this.#colliderSource;
    const tile = this.loaded.get(key);
    if (!source || !tile || tile.loadId !== token.id || token.discarded) return;
    if (!this.#shadowProxyWanted(key, VISUAL_COLLIDER_RADIUS)) return;
    if (!token.colliderRetained) {
      token.colliderRetained = true;
      source.retainTile(key);
    }
    const colliders = source.getTile(key);
    if (colliders) this.#receiveCanonicalColliders(key, colliders);
  }

  #receiveCanonicalColliders(key: string, colliders: BuildingCollider[]): void {
    const tile = this.loaded.get(key);
    if (!tile) return;
    const token = tile.loadToken;
    if (token.discarded || tile.loadId !== token.id || !token.colliderRetained) return;
    token.colliderSettled = true;
    token.colliders = colliders;
    this.#queueColliderApply(key, token);
  }

  /** Apply one bounded phase of a canonical collider payload. */
  #drainColliderReady(): boolean {
    if (this.#colliderReady.length === 0) return false;
    let index = this.#colliderReady.findIndex((item) => item.token.generation === this.#generation);
    if (index < 0) index = 0;
    const [work] = this.#colliderReady.splice(index, 1);
    const { key, token } = work;
    const tile = this.loaded.get(key);
    if (token.discarded || token.collidersApplied || !tile || tile.loadId !== token.id) {
      token.discarded = true;
      return true;
    }
    if (token.generation !== this.#generation || tile.generation !== token.generation) {
      // Keep the decoded payload dormant on its loaded tile. If normal movement
      // or a later prime makes that tile relevant again, #scan adopts and queues
      // this same token without another fetch.
      return true;
    }

    const colliders = token.colliders ?? [];
    if (!token.collidersPublished) {
      // Publish the canonical array alias first so physics/query safety does not
      // wait for cosmetic facade/shadow preparation. Far-field packing is a
      // separate callback phase from the work below.
      tile.colliders = colliders;
      token.collidersPublished = true;
      this.onTileColliders(key, colliders);
      this.#colliderReady.push(work);
      return true;
    }

    if (tile.slot && work.colliderCursor < colliders.length) {
      const data = tile.slot.data;
      const buildingCount = Math.max(4, this.manifest.tiles[key].b);
      const end = Math.min(colliders.length, work.colliderCursor + COLLIDER_METADATA_SLICE);
      for (; work.colliderCursor < end; work.colliderCursor++) {
        const collider = colliders[work.colliderCursor];
        if (collider.i < 0 || collider.i >= buildingCount) continue;
        const encodedBase = Math.max(
          0,
          Math.min(65535, Math.round((collider.y - collider.hy + BASEY_OFFSET) * BASEY_SCALE))
        );
        data[collider.i * 4 + 1] = encodedBase >> 8;
        data[collider.i * 4 + 2] = encodedBase & 255;
        work.topOf.set(
          collider.i,
          Math.max(work.topOf.get(collider.i) ?? -Infinity, collider.y + collider.hy)
        );
      }
      this.#colliderReady.push(work);
      return true;
    }

    if (tile.slot) {
      const data = tile.slot.data;
      work.topEntries ??= [...work.topOf];
      const end = Math.min(work.topEntries.length, work.topCursor + COLLIDER_METADATA_SLICE);
      for (; work.topCursor < end; work.topCursor++) {
        const [buildingIndex, top] = work.topEntries[work.topCursor];
        const offset = buildingIndex * 4;
        const base = (((data[offset + 1] << 8) | data[offset + 2]) / BASEY_SCALE) - BASEY_OFFSET;
        data[offset + 3] = Math.max(1, Math.min(254, Math.round((top - base) / TOPH_SCALE)));
      }
      if (work.topCursor < work.topEntries.length) {
        this.#colliderReady.push(work);
        return true;
      }
      tile.slot.tex.needsUpdate = true;
      // if this tile's facade is batched, publish the freshly decoded base/roof
      // heights into its shared alive-atlas row too
      this.#syncBuildingAtlasRow(tile);
    }

    token.collidersApplied = true;
    this.#queueShadowProxy(key, token);
    return true;
  }

  #shadowProxyWanted(key: string, radius = SHADOW_PROXY_RADIUS): boolean {
    const [cx, cz] = this.keyToCenter(key);
    const half = this.manifest.tile * 0.5;
    const dx = Math.max(0, Math.abs(cx - this.#px) - half);
    const dz = Math.max(0, Math.abs(cz - this.#pz) - half);
    return dx * dx + dz * dz <= radius * radius;
  }

  #queueShadowProxy(key: string, token: TileLoadToken): void {
    const tile = this.loaded.get(key);
    if (
      !tile || tile.loadId !== token.id || token.discarded || !token.collidersApplied ||
      !token.colliders?.length || tile.shadowProxy || !this.#shadowProxyWanted(key) ||
      this.#shadowProxyReady.some((item) => item.token === token)
    ) return;
    this.#shadowProxyReady.push({ key, token });
    this.#pumpShadowProxyBuild();
  }

  #pumpShadowProxyBuild(): void {
    if (this.#shadowProxyBuildActive) return;
    let work: ReadyShadowProxy | undefined;
    while ((work = this.#shadowProxyReady.shift())) {
      const tile = this.loaded.get(work.key);
      if (
        tile && tile.loadId === work.token.id && !work.token.discarded &&
        !tile.shadowProxy && this.#shadowProxyWanted(work.key)
      ) break;
      work = undefined;
    }
    if (!work) return;
    const { key, token } = work;
    const colliders = token.colliders ?? [];
    this.#shadowProxyBuildActive = true;
    void createTileShadowProxyAsync({
      tileKey: key,
      colliders,
      buildingCount: Math.max(4, this.manifest.tiles[key].b),
      isBuildingVisible: (buildingIndex) => this.#shadowBuildingVisible(key, buildingIndex)
    }).then((proxy) => {
      const tile = this.loaded.get(key);
      if (
        !tile || tile.loadId !== token.id || token.discarded || tile.shadowProxy ||
        !this.#shadowProxyWanted(key, SHADOW_PROXY_EXIT_RADIUS)
      ) {
        proxy.dispose();
        return;
      }
      tile.shadowProxy = proxy;
      // M12: mirror the tile's (possibly front-gated) visibility onto the
      // late-arriving proxy so a hidden tile never gains a live shadow caster.
      proxy.group.visible = tile.group.visible;
      this.#scene.add(proxy.group);
      this.onShadowCastersChanged(this.#shadowScopeForTile(key));
    }).catch((error) => {
      console.warn(`[tiles] shadow proxy ${key} unavailable`, error);
    }).finally(() => {
      this.#shadowProxyBuildActive = false;
      this.#pumpShadowProxyBuild();
    });
  }

  /** Attach one pending mesh (one GPU upload) per frame. Returns false when idle. */
  #drainAttach(): boolean {
    while (this.#attaching.length > 0) {
      const attachIndex = this.#bestAttachIndex();
      const key = this.#attaching[attachIndex];
      const tile = this.loaded.get(key);
      if (!tile) {
        // unloaded mid-attach (dispose handled by #unloadTile)
        this.#attaching.splice(attachIndex, 1);
        continue;
      }
      if (this.#visualPrime && tile.generation !== this.#generation) return false;
      // 1) core meshes (landmarks / misc): one GPU upload per frame
      if (tile.pendingParts && tile.pendingParts.length > 0) {
        tile.group.add(tile.pendingParts.shift()!);
        (tile.group as THREE.BundleGroup).needsUpdate = true; // structure changed → re-record bundle
        if (tile.pendingParts.length === 0) tile.pendingParts = undefined;
        tracer.count("tileAttach");
        return true;
      }
      // 1b) building meshes: fold one into the shared building batch per frame
      // (one arena upload + one alive-atlas row sync — core cadence, always stream)
      if (tile.pendingBuildingParts && tile.pendingBuildingParts.length > 0) {
        this.#attachBuildingPart(tile);
        if (tile.pendingBuildingParts.length === 0) tile.pendingBuildingParts = undefined;
        tracer.count("tileAttach");
        return true;
      }
      // 1c) road meshes: fold one into the shared road batch per frame (one arena
      // upload, same core cadence — roads always stream, never held back while high)
      if (tile.pendingRoadParts && tile.pendingRoadParts.length > 0) {
        this.#attachRoadPart(tile);
        if (tile.pendingRoadParts.length === 0) tile.pendingRoadParts = undefined;
        tracer.count("tileAttach");
        return true;
      }
      // 2) park detail (grn_ pier decks): fold one into the shared park batch per
      // frame — only while low, while high it stays off the GPU
      if (!this.#highUp && tile.detailParts && tile.detailParts.length > 0) {
        this.#attachParkPart(tile);
        if (tile.detailParts.length === 0) tile.detailParts = undefined;
        tracer.count("tileAttach");
        return true;
      }
      // 3) high, but park detail still owed: park the tile until descent
      if (this.#highUp && tile.detailParts && tile.detailParts.length > 0) {
        this.#deferred.add(key);
        this.#attaching.splice(attachIndex, 1);
        continue;
      }
      // 4) tile whole
      this.#attaching.splice(attachIndex, 1);
    }
    return false;
  }

  /** Lazily build the shared building batch: the alive ATLAS (aliveW × capacity,
   *  one row per instance), a shell facade material, the BatchedMesh, then wire the
   *  atlas-indexed facade node graph onto the material (needs the mesh's indirect
   *  texture, hence the after-construction configure). */
  #ensureBuildingBatch(): TileMeshBatch {
    if (this.#buildingBatch) return this.#buildingBatch;
    const cap = BUILDING_BATCH_CAPACITY;
    const data = new Uint8Array(this.#aliveW * cap * 4);
    // default every row to a benign "alive, base 0, never-mask" state so any
    // instance drawn before its tile's first sync reads sane values (rows are
    // fully overwritten from slot.data at attach, so this is only a safety net).
    data.fill(255);
    const enc0 = Math.round(BASEY_OFFSET * BASEY_SCALE);
    for (let i = 0; i < this.#aliveW * cap; i++) {
      data[i * 4 + 1] = enc0 >> 8;
      data[i * 4 + 2] = enc0 & 255;
    }
    const atlas = new THREE.DataTexture(data, this.#aliveW, cap, THREE.RGBAFormat, THREE.UnsignedByteType);
    // Nearest + no mipmaps: the facade material fetches exact texels (textureLoad),
    // but pin the sampler too so nothing can ever blur roof-height alpha / rowFits
    // across a tile-row boundary.
    atlas.magFilter = THREE.NearestFilter;
    atlas.minFilter = THREE.NearestFilter;
    atlas.generateMipmaps = false;
    atlas.needsUpdate = true;
    this.#buildingAtlas = atlas;
    this.#buildingAtlasData = data;
    // Shell material first; the batch's BatchedMesh needs a material, and the
    // material's per-instance atlas lookup needs the mesh's indirect texture.
    const mat = new THREE.MeshStandardNodeMaterial();
    const batch = createTileMeshBatch(this.#scene, {
      name: "tileBuildingBatch",
      material: mat,
      capacity: cap,
      initialVertices: BUILDING_BATCH_INITIAL_VERTICES,
      initialIndices: BUILDING_BATCH_INITIAL_INDICES,
      maxVertices: BUILDING_BATCH_MAX_VERTICES,
      maxIndices: BUILDING_BATCH_MAX_INDICES,
      receiveShadow: true
    });
    configureFacadeBatchMaterial(mat, atlas, batch.mesh);
    // M5 per-instance birth: wired after the facade graph, before the
    // onBatchCreated warm, so the compiled pipeline is the final one (C2/C7).
    this.#buildingBirth = createBatchBirth(cap);
    configureBatchBirthFade(mat, batch.mesh, this.#buildingBirth.tex);
    this.#buildingBatch = batch;
    this.onBatchCreated(batch.mesh);
    return batch;
  }

  /** Copy a batched tile's per-building alive data (its FacadeSlot authoring
   *  buffer) into its atlas ROW and mark the atlas for one re-upload. No-op for a
   *  tile that is not (yet) batched or has no slot. */
  #syncBuildingAtlasRow(tile: LoadedTile): void {
    if (tile.buildingRow === undefined || !tile.slot || !this.#buildingAtlasData || !this.#buildingAtlas) return;
    const rowBytes = this.#aliveW * 4;
    this.#buildingAtlasData.set(tile.slot.data, tile.buildingRow * rowBytes);
    this.#buildingAtlas.needsUpdate = true; // three coalesces to one upload per render
  }

  /** Fold one queued building mesh into the shared building batch (one GPU arena
   *  upload + one alive-atlas row sync), or fall back onto the per-tile bundle with
   *  the per-tile facade material if the batch is full/exhausted so the tile is
   *  never partially drawn. */
  #attachBuildingPart(tile: LoadedTile): void {
    const mesh = tile.pendingBuildingParts!.shift()!;
    const batch = this.#ensureBuildingBatch();
    // Drop the redundant uppercase _BID alias so every batched geometry presents
    // the identical attribute set {position, normal, _bid, color} — BatchedMesh
    // rejects a geometry whose attributes differ from the arena's reference.
    if (mesh.geometry.getAttribute("_bid") && mesh.geometry.getAttribute("_BID")) {
      mesh.geometry.deleteAttribute("_BID");
    }
    mesh.updateWorldMatrix(true, false);
    const handle = batch.add(mesh.geometry, mesh.matrixWorld);
    if (handle) {
      tile.buildingRow = handle.instanceId;
      tile.buildingBatched = true;
      stampBatchBirth(this.#buildingBirth!, handle.instanceId);
      (tile.buildingBatchHandles ??= []).push(handle);
      // publish this tile's alive data into its atlas row before the instance can
      // render (addInstance made it visible; no frame elapses before this sync)
      this.#syncBuildingAtlasRow(tile);
      // a building folded into a currently-hidden tile (non-destination during a
      // covered arrival) must start hidden — the batch is not under tile.group
      if (!tile.group.visible) handle.setVisible(false);
      mesh.geometry.dispose(); // the batch copied the geometry into its arena
    } else {
      // batch full/exhausted — keep this building on the per-tile bundle with its
      // own facade material (distance-picked, LOD-swappable like the old path)
      tile.buildingBatched = false;
      const bMat = tile.slot ? (tile.slot.far ? tile.slot.matFar : tile.slot.matNear) : null;
      if (bMat) mesh.material = bMat;
      tile.group.add(mesh);
      (tile.group as THREE.BundleGroup).needsUpdate = true;
    }
  }

  /** Mirror a tile's group visibility onto its batched building instances — they
   *  are not under tile.group, so a hidden tile must hide its instances too. */
  #setTileBuildingVisible(tile: LoadedTile, visible: boolean): void {
    if (!tile.buildingBatchHandles) return;
    for (const handle of tile.buildingBatchHandles) handle.setVisible(visible);
  }

  /** Fold one queued road mesh into the shared road batch (one GPU arena
   *  upload), or fall back into the tile bundle if the batch is full/exhausted
   *  so the tile is never partially drawn. */
  #attachRoadPart(tile: LoadedTile): void {
    const mesh = tile.pendingRoadParts!.shift()!;
    // Lazily create the batch after roadMat's terrain-field normal is wired in
    // init(). Its own clone gives the batched-pipeline variant a clean owner
    // while the shared roadMat keeps serving the GG bridge road + bundle
    // fallbacks. Capacity + arena cover a healthy residency ring; an unusually
    // dense district grows the arena once, then add() returns null (fallback).
    if (!this.#roadBatch) {
      const roadBatchMat = roadMat.clone();
      this.#roadBatch = createTileMeshBatch(this.#scene, {
        name: "tileRoadBatch",
        material: roadBatchMat,
        capacity: 192,
        initialVertices: 393_216,
        initialIndices: 1_048_576,
        maxVertices: 1_048_576,
        maxIndices: 2_621_440,
        receiveShadow: true
      });
      // M5 per-instance birth, wired before the onBatchCreated warm below
      this.#roadBirth = createBatchBirth(192);
      configureBatchBirthFade(roadBatchMat, this.#roadBatch.mesh, this.#roadBirth.tex);
    }
    if (!this.#roadBatchAnnounced) {
      this.#roadBatchAnnounced = true;
      this.onBatchCreated(this.#roadBatch.mesh);
    }
    mesh.updateWorldMatrix(true, false);
    const handle = this.#roadBatch.add(mesh.geometry, mesh.matrixWorld);
    if (handle) {
      stampBatchBirth(this.#roadBirth!, handle.instanceId);
      // a road folded into a currently-hidden tile (non-destination during a
      // covered arrival) must start hidden — the batch is not under tile.group
      if (!tile.group.visible) handle.setVisible(false);
      (tile.roadBatchHandles ??= []).push(handle);
      mesh.geometry.dispose(); // the batch copied the geometry into its arena
    } else {
      // batch full/exhausted — keep this road on the per-tile bundle (its
      // materials.road was already bound at finalize; frustumCulled=false too)
      tile.group.add(mesh);
      (tile.group as THREE.BundleGroup).needsUpdate = true;
    }
  }

  /** Mirror a tile's group visibility onto its batched road instances — they are
   *  not under tile.group, so a hidden tile must hide its instances too. */
  #setTileRoadVisible(tile: LoadedTile, visible: boolean): void {
    if (!tile.roadBatchHandles) return;
    for (const handle of tile.roadBatchHandles) handle.setVisible(visible);
  }

  /** Fold one queued park (grn_ pier deck) mesh into the shared park batch, or
   *  fall back onto the per-tile bundle if the batch is full/exhausted. parkMat is
   *  world-position keyed with no per-tile data, so this is the generic tileBatch
   *  path exactly like roads (just on the detail cadence). */
  #attachParkPart(tile: LoadedTile): void {
    const mesh = tile.detailParts!.shift() as THREE.Mesh;
    // grn_ pier decks are tiny (whole city < 8k verts / 23k idx); a small fixed
    // arena holds every resident deck without ever growing.
    if (!this.#parkBatch) {
      const parkBatchMat = parkMat.clone();
      this.#parkBatch = createTileMeshBatch(this.#scene, {
        name: "tileParkBatch",
        material: parkBatchMat,
        capacity: 64,
        initialVertices: 16_384,
        initialIndices: 49_152,
        maxVertices: 32_768,
        maxIndices: 98_304,
        receiveShadow: true
      });
      // M5 per-instance birth, wired before the onBatchCreated warm below
      this.#parkBirth = createBatchBirth(64);
      configureBatchBirthFade(parkBatchMat, this.#parkBatch.mesh, this.#parkBirth.tex);
    }
    if (!this.#parkBatchAnnounced) {
      this.#parkBatchAnnounced = true;
      this.onBatchCreated(this.#parkBatch.mesh);
    }
    mesh.updateWorldMatrix(true, false);
    const handle = this.#parkBatch.add(mesh.geometry, mesh.matrixWorld);
    if (handle) {
      stampBatchBirth(this.#parkBirth!, handle.instanceId);
      if (!tile.group.visible) handle.setVisible(false);
      (tile.parkBatchHandles ??= []).push(handle);
      mesh.geometry.dispose(); // the batch copied the geometry into its arena
    } else {
      // batch full/exhausted — keep this deck on the per-tile bundle (its
      // materials.park was already bound at finalize; frustumCulled=false too)
      tile.group.add(mesh);
      (tile.group as THREE.BundleGroup).needsUpdate = true;
    }
  }

  /** Mirror a tile's group visibility onto its batched park instances. */
  #setTileParkVisible(tile: LoadedTile, visible: boolean): void {
    if (!tile.parkBatchHandles) return;
    for (const handle of tile.parkBatchHandles) handle.setVisible(visible);
  }

  // ---- M12 front visibility gate ------------------------------------------
  // During a sweep, resident tiles beyond the materialize front stay hidden
  // (bundle group + batched instances + shadow proxy) and register with the
  // shared frontGate, which reveals them nearest-first under a per-frame
  // budget as the front approaches. Loading/attaching/warming is untouched —
  // this is visibility only, and the gate is inert once the sweep settles.

  /** Bounding circle for a tile's front-gate test (centre + half-diagonal). */
  #tileGateCircle(key: string): [number, number, number] {
    const [cx, cz] = this.keyToCenter(key);
    return [cx, cz, this.manifest.tile * Math.SQRT2 * 0.5];
  }

  #showTileVisuals(tile: LoadedTile): void {
    tile.group.visible = true;
    this.#setTileRoadVisible(tile, true);
    this.#setTileBuildingVisible(tile, true);
    this.#setTileParkVisible(tile, true);
    if (tile.shadowProxy) tile.shadowProxy.group.visible = true;
  }

  #hideTileVisuals(tile: LoadedTile): void {
    tile.group.visible = false;
    this.#setTileRoadVisible(tile, false);
    this.#setTileBuildingVisible(tile, false);
    this.#setTileParkVisible(tile, false);
    if (tile.shadowProxy) tile.shadowProxy.group.visible = false;
  }

  /** Route a "make this tile visible/hidden" decision through the front gate.
   *  Cancels any prior gate registration first so exactly one owner ever
   *  controls the tile's visibility (gate vs covered-arrival adopt). */
  #applyTileVisibility(tile: LoadedTile, wanted: boolean): void {
    tile.frontGateHandle?.cancel();
    tile.frontGateHandle = undefined;
    if (!wanted) {
      this.#hideTileVisuals(tile);
      return;
    }
    const [cx, cz, r] = this.#tileGateCircle(tile.key);
    if (frontGate.shouldHide(cx, cz, r)) {
      this.#hideTileVisuals(tile);
      tile.frontGateHandle = frontGate.hide(cx, cz, r, () => {
        tile.frontGateHandle = undefined;
        this.#showTileVisuals(tile);
      });
    } else {
      this.#showTileVisuals(tile);
    }
  }

  /** Re-apply the front gate to every loaded tile + landmark subtree after a
   *  front refocus (far teleport): content revealed by the previous sweep must
   *  re-hide when it now lies beyond the collapsed front at the destination.
   *  Tiles hidden by a covered-arrival adopt (visible=false WITHOUT a gate
   *  registration) keep that ownership untouched. No-op cost when the gate is
   *  inactive: shouldHide is false, so every tile just stays/becomes visible. */
  applyFrontGate(): void {
    for (const tile of this.loaded.values()) {
      if (!tile.group.visible && !tile.frontGateHandle) continue;
      this.#applyTileVisibility(tile, true);
    }
    this.#applyLandmarkFrontGate();
  }

  /** Gate the always-resident landmark subtrees (few — one bounds circle each,
   *  computed once at load). GG bridge's huge bounding circle admits it early;
   *  its holo material + M12 edge window keep the far spans black until the
   *  front actually reaches them. */
  #applyLandmarkFrontGate(): void {
    for (const gates of [this.#landmarkGates, this.#landmarkProxyGates]) {
      for (const gate of gates) {
        gate.handle?.cancel();
        gate.handle = undefined;
        if (frontGate.shouldHide(gate.x, gate.z, gate.r)) {
          gate.obj.visible = false;
          gate.handle = frontGate.hide(gate.x, gate.z, gate.r, () => {
            gate.handle = undefined;
            gate.obj.visible = true;
          });
        } else {
          gate.obj.visible = true;
        }
      }
    }
  }

  #bestAttachIndex(): number {
    const required = this.#visualPrime?.generation === this.#generation
      ? this.#visualPrime.requiredTileSet
      : null;
    let best = 0;
    let bestRank = Infinity;
    let bestDistance = Infinity;
    for (let i = 0; i < this.#attaching.length; i++) {
      const key = this.#attaching[i];
      const tile = this.loaded.get(key);
      const requiredHere = required?.has(key) === true;
      const corePending =
        (tile?.pendingParts?.length ?? 0) > 0 ||
        (tile?.pendingBuildingParts?.length ?? 0) > 0 ||
        (tile?.pendingRoadParts?.length ?? 0) > 0;
      const current = tile?.generation === this.#generation;
      const rank = corePending && requiredHere
        ? 0
        : corePending && current
          ? 1
          : requiredHere
            ? 2
            : current
              ? 3
              : 4;
      const [cx, cz] = this.keyToCenter(key);
      const distance = (this.#px - cx) * (this.#px - cx) + (this.#pz - cz) * (this.#pz - cz);
      if (rank < bestRank || (rank === bestRank && distance < bestDistance)) {
        best = i;
        bestRank = rank;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Descended: re-queue every tile whose dense park detail was held back. */
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
    tile.loadToken.discarded = true;
    // M12: drop any front-gate registration (a later reload re-gates fresh)
    tile.frontGateHandle?.cancel();
    tile.frontGateHandle = undefined;
    // next residency of this tile re-births (M5 steady-state streaming grace)
    materializeField.forgetBirth(`tile:${key}`);
    if (tile.loadToken.colliderRetained) {
      this.#colliderSource?.releaseTile(key);
      tile.loadToken.colliderRetained = false;
    }
    this.onTileUnload(key);
    this.#scene.remove(tile.group);
    // release this tile's road instances back to the shared batch — frees the
    // instance id and returns each geometry slot for the next district to reuse
    if (tile.roadBatchHandles) {
      for (const handle of tile.roadBatchHandles) handle.free();
      tile.roadBatchHandles = undefined;
    }
    // release this tile's building instance(s) + their alive-atlas row(s). free()
    // returns the instance id (= atlas row) for the next tile through this batch;
    // that tile fully overwrites the row from its own slot.data at attach, so no
    // stale alive data can be read.
    if (tile.buildingBatchHandles) {
      for (const handle of tile.buildingBatchHandles) handle.free();
      tile.buildingBatchHandles = undefined;
    }
    tile.buildingRow = undefined;
    tile.buildingBatched = false;
    // release this tile's park (grn_) instances back to the shared park batch
    if (tile.parkBatchHandles) {
      for (const handle of tile.parkBatchHandles) handle.free();
      tile.parkBatchHandles = undefined;
    }
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
    // (pendingRoadParts/pendingBuildingParts are meshes not yet folded into their
    // batch; batched geometry was already disposed at add and is released via the
    // handles above)
    for (const parked of [tile.pendingParts, tile.detailParts, tile.pendingRoadParts, tile.pendingBuildingParts]) {
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
    tile.pendingRoadParts = undefined;
    tile.pendingBuildingParts = undefined;
    this.#deferred.delete(key);
    // Keep only the tiny texture/data allocation. The material lifecycle is
    // per-residency so the WebGPU renderer can release old geometry pairings.
    if (tile.slot) {
      this.#recycleSlot(tile.slot);
    }
    for (const material of tile.materials?.all ?? []) material.dispose();
    tile.materials = null;
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
  suppressBuilding(key: string, index: number, opts?: { invalidateShadows?: boolean }) {
    this.#suppressed.add(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length) {
      tile.slot.data[index * 4] = 0;
      tile.slot.tex.needsUpdate = true;
      this.#syncBuildingAtlasRow(tile);
    }
    this.#syncShadowBuilding(key, index);
    // CityGen tier swaps draw an equivalent caster in the same footprint —
    // skipping the redraw there kills the per-swap local-shadow churn that
    // read as movement hitches (the stale map matches the twin's silhouette).
    if (opts?.invalidateShadows !== false) {
      this.onShadowCastersChanged(this.#shadowScopeForBuilding(key, index));
    }
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
  suppressBuildingMesh(key: string, index: number, opts?: { invalidateShadows?: boolean }) {
    this.#meshSuppressed.add(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length && tile.slot.data[index * 4] !== 0) {
      tile.slot.data[index * 4] = 1;
      tile.slot.tex.needsUpdate = true;
      this.#syncBuildingAtlasRow(tile);
    }
    this.#syncShadowBuilding(key, index);
    if (opts?.invalidateShadows !== false) {
      this.onShadowCastersChanged(this.#shadowScopeForBuilding(key, index));
    }
  }

  /** Undo suppressBuildingMesh — restore the baked mesh (alive flag → 255). */
  unsuppressBuildingMesh(key: string, index: number, opts?: { invalidateShadows?: boolean }) {
    this.#meshSuppressed.delete(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length && tile.slot.data[index * 4] === 1) {
      tile.slot.data[index * 4] = 255;
      tile.slot.tex.needsUpdate = true;
      this.#syncBuildingAtlasRow(tile);
    }
    this.#syncShadowBuilding(key, index);
    if (opts?.invalidateShadows !== false) {
      this.onShadowCastersChanged(this.#shadowScopeForBuilding(key, index));
    }
  }

  /** Undo suppressBuilding — restores the baked mesh + colliders. Used by the
   *  generated-building ring: an OSM building is suppressed only while its
   *  generated replacement is streamed in, and revived when the ring unloads it
   *  so the distant baked city has no holes. (Alive sentinel is 255.) */
  unsuppressBuilding(key: string, index: number, opts?: { invalidateShadows?: boolean }) {
    this.#suppressed.delete(`${key}:${index}`);
    const tile = this.loaded.get(key);
    if (tile?.slot && index >= 0 && index * 4 < tile.slot.data.length) {
      tile.slot.data[index * 4] = 255;
      tile.slot.tex.needsUpdate = true;
      this.#syncBuildingAtlasRow(tile);
    }
    this.#syncShadowBuilding(key, index);
    if (opts?.invalidateShadows !== false) {
      this.onShadowCastersChanged(this.#shadowScopeForBuilding(key, index));
    }
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
