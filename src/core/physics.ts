import * as THREE from "three/webgpu";
import {
  BodyType,
  createBox3D,
  type Box3D,
  type PhysicsWorld,
  type RayCastHit
} from "./box3dWorld";
// Re-exported so the ~20 gameplay/vehicle modules depend on the physics facade
// rather than the underlying engine package directly.
export { BodyType, TRANSFORM_STRIDE, TransformBatch } from "./box3dWorld";
export type {
  PhysicsWorld,
  Transform,
  BodyVelocity,
  CapsuleShape,
  HumanRagdoll,
  BodyTypeValue,
  Vec3,
  Quat
} from "./box3dWorld";
import { CONFIG } from "../config";
import { tracer } from "./hitchTracer";
import type { WorldMap } from "../world/heightmap";
import type { BuildingRayRefiner } from "./buildingRayRefine";
import type { BuildingCollider, TileStreamer } from "../world/tiles";
import { BuildingColliderIndex } from "./buildingColliderIndex";
import {
  selectBodyCandidates,
  anchorInsideCollider,
  anchorHold,
  obbPlanarDistance,
  type ColliderAnchor,
  type BodyTileSource
} from "./buildingBodies";
import {
  buildTerrainCollisionPatch,
  terrainPatchAnchor,
  terrainPatchCovers,
  type TerrainCollisionPatch
} from "./terrainCollisionPatch";

const pointScratch = new THREE.Vector3();
const slabUp = new THREE.Vector3(0, 1, 0);
const slabNormal = new THREE.Vector3();
const slabQuat = new THREE.Quaternion();

// Ground-carpet refinement: a slab is one tilted plane, so it gets sunk by its
// worst corner overshoot to never poke above the street. Past this much sink
// the player visibly clips into the visual terrain, so the cell is instead
// re-covered with smaller slabs from the pools below (full slab stays as a
// sunk backstop underneath — pool exhaustion degrades, never drops the floor).
const CARPET_SINK_CAP = 0.35;
const CARPET_SUB_SLABS = 144; // 4m slabs -> 36 refinable 8m cells
const CARPET_SUB2_SLABS = 96; // 2m slabs -> 24 refinable 4m quarters

// Teleport arrival needs only a movement-safe local bubble before controls
// unlock. The rest of the steady 260 m gameplay neighborhood can fill behind it.
const ARRIVAL_COLLISION_RADIUS = 72;
// Owner tiles contain baked OBBs that can extend ~102 m past their 800 m cell.
// Requiring every manifest cell within 200 m of an arrival covers those boxes
// while the actual body-safety disk remains the intentionally small 72 m.
const ARRIVAL_COLLIDER_OWNER_REACH = 200;

// Visual tiles span kilometres; camera/cursor/paint queries do not. Keep baked
// visual-tile OBB mirrors in a compact local bubble with hysteresis.
const QUERY_SOLID_LOAD_RADIUS = 340;
const QUERY_SOLID_EVICT_RADIUS = 430;
const QUERY_FOCUS_STEP = 24;

// Authoritative Box3D mutations stay on the main thread in strict count + time
// batches. Count limits prevent fast machines from creating an avalanche inside
// a permissive wall-time sample.
const BODY_ATTACH_PER_FRAME = 10;
const BODY_RETIRE_PER_FRAME = 16;
const BODY_MUTATION_MS = 0.8;
// A discontinuous arrival is already held behind an opaque cover. Materialise
// only its 72 m fail-closed safety set in a larger, still wall-time-bounded
// slice so low first-frame cadence cannot stretch 50 tiny Box3D inserts across
// several seconds. The ordinary 260 m neighborhood keeps the steady cap above.
const ARRIVAL_BODY_ATTACH_PER_FRAME = 64;
const ARRIVAL_BODY_MUTATION_MS = 6;
const QUERY_ATTACH_PER_FRAME = 10;
const QUERY_RETIRE_PER_FRAME = 20;
const QUERY_MUTATION_MS = 0.65;

export type CollisionArrivalStatus = Readonly<{
  epoch: number;
  current: boolean;
  active: boolean;
  groundReady: boolean;
  colliderDataReady: boolean;
  buildingBodiesReady: boolean;
  ready: boolean;
  pendingColliderTiles: number;
  failedColliderTiles: number;
  pendingBuildingBodies: number;
}>;

type CollisionArrival = {
  epoch: number;
  x: number;
  y: number;
  z: number;
  active: boolean;
  requiredTiles: string[];
};

type BodyAttach = { id: string; key: string; c: BuildingCollider; d: number };
type QuerySolidAttach = {
  generation: number;
  id: string;
  key: string;
  c: BuildingCollider;
  d: number;
};

// One baked always-resident box (bridge deck/rail segment, or a landmark proxy)
// as served by data/landmark-colliders.json.
type LandmarkBox = { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw?: number };

export class Physics {
  box3d!: Box3D;
  world!: PhysicsWorld;
  map: WorldMap;
  tiles: TileStreamer;

  #carpet: number[] = [];
  #carpetSub: number[] = []; // 4m refinement slabs (parked until assigned)
  #carpetSub2: number[] = []; // 2m refinement slabs for genuine steps
  #carpetSubUsed = 0; // high-water of currently-placed (non-parked) sub slabs
  #carpetSub2Used = 0;
  // cells awaiting refinement + placement cursors: pass 2 drains ~1ms per
  // rendered frame from maintainStreaming() instead of all at once on recenter
  #refineQueue: { wx: number; wz: number; d: number }[] = [];
  #refineSub = 0;
  #refineSub2 = 0;
  #carpetCX = NaN;
  #carpetCZ = NaN;
  #carpetGroundRevision = -1;
  // One indexed, shared-edge surface replaces the ordinary overlapping carpet
  // boxes. The boxes remain pooled as a capability/discontinuity fallback.
  #terrainPatchBody: number | null = null;
  #terrainPatch: TerrainCollisionPatch | null = null;
  #terrainPatchGroundRevision = -1;
  #terrainPatchAvailable = true;

  // one entry per materialised BOX — concave buildings bake to several boxes
  // sharing an `i` (tiles.ts patches in the sub-ordinal `s`), so bodies key by
  // "key:i:s" while alive state stays per-building on "key:i"
  #buildingBodies = new Map<number, { key: string; i: number; s: number }>();
  #bodyByBuilding = new Map<string, number>(); // "key:i:s" -> handle
  #tileColliders = new Map<string, BuildingCollider[]>();
  #desiredBodyIds = new Set<string>();
  #bodyAttachQueue: BodyAttach[] = []; // descending distance; nearest pops first
  #bodyRetireQueue: number[] = [];
  #bodyRetireSet = new Set<number>();
  #buildingPlanDirty = true;

  // Query-only world of static SOLIDS — nearby alive building boxes, plus the
  // always-resident bridge + landmark boxes. Never stepped: box3d seeds a body's
  // broadphase AABB at shape-create time, so castRayClosest answers immediately
  // (verified). This is the single geometry authority behind raycastWorld — the
  // hand-rolled OBB slab test is gone, and the bridge is a real solid here rather
  // than a heightfield plane, so shots hit its deck/rails/underside at any angle.
  #solids!: PhysicsWorld;
  #solidByBuilding = new Map<string, number[]>(); // "key:i" -> its sub-box handles
  #solidByCollider = new Map<string, number>(); // "key:i:s" -> handle
  #solidOwner = new Map<number, { id: string; key: string; i: number; s: number; c: BuildingCollider }>();
  #solidTileIndex = new Map<string, Set<number>>(); // tile key -> handles it owns
  #solidQueue: QuerySolidAttach[] = []; // descending distance; nearest pops first
  #solidQueuedIds = new Set<string>();
  #solidRetireQueue: number[] = [];
  #solidRetireSet = new Set<number>();
  #solidGeneration = 0;
  #queryFocusX = NaN;
  #queryFocusZ = NaN;
  // Query-world mirrors used by raycasts. Stepped landmark/bridge support comes
  // from the same boxes in canonical per-tile collider data (including b=0
  // open-water bridge cells), so arrival readiness is owned by that one stream.
  #landmarkSolids: number[] = [];
  #landmarkQueryHydrated = false; // guards duplicate mirrors when initColliderServices retries
  #solidRay: RayCastHit = { handle: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, distance: 0 };
  // CityGen exact-poly wall + interior boxes are created on the STEPPED world
  // (world/citygen/stream/ring.ts), so they're invisible to #solids — the query
  // world every raycast (paint, world cursor, aim reticle) consults via
  // raycastWorld. The ring mirrors each of its boxes here through addQuerySolid,
  // keyed by the stepped-body handle, so a ray strikes citygen geometry exactly
  // where the baked twin has been suppressed.
  #querySolids = new Map<number, number>(); // caller id (stepped handle) -> #solids handle
  // Classification of each #solids body for raycastWorld's refinement step:
  // baked-tile building boxes carry their tile key + building index (so a hit can
  // ask tiles whether the baked mesh is actually DRAWN there), citygen mirrors are
  // tagged "citygen" (tight exact-poly walls, already flush with the visible
  // mesh). Landmark boxes stay untagged — the box is the authority for them.
  #solidTag = new Map<number, { key: string; i: number } | "citygen">();
  // Optional refiner (core/buildingRayRefine.ts, needs the scene): re-tests
  // building box hits against the RENDERED citygen geometry so paint/golf rays
  // land on the visible wall instead of the ~2m-oversized baked OBB.
  #rayRefiner: BuildingRayRefiner | null = null;
  #advOrigin = new THREE.Vector3(); // scratch for the continue-past-box re-cast
  // baked OBBs streamed around the player collider anchor, decoupled from the
  // visual tile stream (see buildingColliderIndex.ts). Null until create()
  // finishes loading the manifest.
  #colliderIndex: BuildingColliderIndex | null = null;
  #colliderIndexRevision = -1;
  #anchorList: ColliderAnchor[] = []; // reused per body update — no per-tick alloc
  #indexAnchorList: ColliderAnchor[] = []; // active focus + prepared destination
  #bodyTiles: BodyTileSource<BuildingCollider>[] = []; // reused merged tile source
  #collisionEpoch = 0;
  #arrival: CollisionArrival | null = null;
  #arrivalSelectionEpoch = -1;
  #arrivalSelectionComplete = false;
  #arrivalSafeBodyIds = new Set<string>();
  #activeFocus = { x: NaN, y: NaN, z: NaN };
  #tick = 0;

  private constructor(map: WorldMap, tiles: TileStreamer) {
    this.map = map;
    this.tiles = tiles;
  }

  /**
   * Void-boot core (docs/VOID_STREAM_REWRITE.md M3): the stepped world, query
   * world, ground carpet pools and tile hooks — everything `maintainStreaming`
   * and the CPU-carpet groundReady test need. The landmark query mirrors and
   * the canonical building-collider index are deferred to
   * `initColliderServices()` so the void phase never waits on them.
   */
  static async createCore(map: WorldMap, tiles: TileStreamer): Promise<Physics> {
    const p = new Physics(map, tiles);
    p.box3d = await createBox3D();
    p.world = p.box3d.createWorld([...CONFIG.gravity]);
    // separate, never-stepped world backing every world-solid query (see #solids)
    p.#solids = p.box3d.createWorld([0, 0, 0]);

    const n = CONFIG.carpetSize * CONFIG.carpetSize;
    for (let i = 0; i < n; i++) {
      p.#carpet.push(
        p.world.createBox({
          type: BodyType.Static,
          position: [0, -500 - i * 5, 0],
          halfExtents: [CONFIG.carpetCell * 0.62, 1.5, CONFIG.carpetCell * 0.62],
          friction: 0.8
        })
      );
    }
    // refinement pools: quarter (4m) and sixteenth (2m) slabs layered over
    // cells whose single plane would have to sink visibly far below the real
    // ground (see #updateCarpet). Parked deep underground until assigned.
    for (let i = 0; i < CARPET_SUB_SLABS; i++) {
      p.#carpetSub.push(
        p.world.createBox({
          type: BodyType.Static,
          position: [0, -3000 - i * 5, 0],
          halfExtents: [CONFIG.carpetCell * 0.31, 1.5, CONFIG.carpetCell * 0.31],
          friction: 0.8
        })
      );
    }
    for (let i = 0; i < CARPET_SUB2_SLABS; i++) {
      p.#carpetSub2.push(
        p.world.createBox({
          type: BodyType.Static,
          position: [0, -6000 - i * 5, 0],
          halfExtents: [CONFIG.carpetCell * 0.155, 1.5, CONFIG.carpetCell * 0.155],
          friction: 0.8
        })
      );
    }

    // Wire tile hooks from instance methods so private fields are only touched via
    // `this.#…`. esbuild rejects `p.#private` inside static-create arrow callbacks.
    p.#wireTileStreamerHooks(tiles);
    return p;
  }

  /**
   * Deferred boot completion (docs/VOID_STREAM_REWRITE.md M3): landmark query
   * mirrors + the canonical collider index. Runs in the background after
   * `createCore` — the collision-arrival status stays honestly "pending" (all
   * required tiles unresolved) until the index lands, and every consumer is
   * already null-safe against `#colliderIndex`.
   */
  async initColliderServices(): Promise<void> {
    // Always-resident bridge + landmark mirrors for the never-stepped query
    // world. Movement physics is deliberately not sourced here: the bake also
    // emits these boxes into canonical collider tiles, including explicit b=0
    // manifest cells over open-water bridge spans. That bounded tile stream is
    // therefore the single arrival-readiness and stepped-body authority.
    // Idempotent under boot's bounded retry (bootPhysics.ts): a collider-index
    // failure below re-enters this method, and the mirrors must not duplicate.
    if (!this.#landmarkQueryHydrated) {
      const landmarkController = new AbortController();
      const landmarkTimer = setTimeout(() => landmarkController.abort(), 4_000);
      try {
        const res = await fetch("/data/landmark-colliders.json", { signal: landmarkController.signal });
        if (res.ok) {
          for (const b of (await res.json()) as LandmarkBox[]) {
            this.#landmarkSolids.push(this.#makeSolid(b.x, b.y, b.z, b.hx, b.hy, b.hz, b.yaw ?? 0));
          }
          this.#landmarkQueryHydrated = true;
        }
      } catch (err) {
        console.warn("[physics] landmark/bridge query mirrors unavailable", err);
      } finally {
        clearTimeout(landmarkTimer);
      }
    }

    // One canonical service owns both physics and visual collider metadata. It
    // initializes from TileStreamer's already-loaded manifest, so there is no
    // second boot request and no misleading "visual-only" state after removing
    // the duplicate visual worker. Individual tile/network failures remain
    // explicit, retryable, and fail closed through the arrival status.
    const index = new BuildingColliderIndex();
    await index.init(this.tiles.manifest);
    this.#colliderIndex = index;
    this.tiles.setColliderSource(index);
  }

  /** Bind TileStreamer callbacks with `this.#` access (safe for esbuild). */
  #wireTileStreamerHooks(tiles: TileStreamer): void {
    tiles.onTileColliders = (key, colliders) => {
      this.#tileColliders.set(key, colliders);
      this.#buildingPlanDirty = true;
      // A visual tile can be kilometres away. Only enqueue OBBs intersecting the
      // current local query bubble.
      this.#enqueueLocalQueryTile(key, colliders);
    };
    tiles.onTileUnload = (key) => {
      this.#tileColliders.delete(key);
      this.#buildingPlanDirty = true;
      this.#retireTileSolids(key);
      for (const [handle, info] of this.#buildingBodies) {
        if (info.key === key) this.#queueBodyRetire(handle);
      }
    };
    // runtime solid add/drop on full suppress or revive (mesh-only suppression
    // keeps the collider, so tiles never fires it for that)
    tiles.onBuildingAlive = (key, index, alive) => {
      this.#buildingPlanDirty = true;
      this.#setBuildingSolidAlive(key, index, alive);
    };
  }

  /**
   * Prime destination collider data without moving the live collision focus.
   * Calling again supersedes the prior arrival; epochs never repeat within this
   * Physics instance, so stale async transition work cannot unlock a newer one.
   */
  prepareCollisionArrival(destination: Readonly<{ x: number; y?: number; z: number }>): number {
    const epoch = ++this.#collisionEpoch;
    const x = destination.x;
    const z = destination.z;
    const requiredTiles = this.#arrivalTileKeys(x, z);
    this.#arrival = {
      epoch,
      x,
      y: destination.y ?? this.map.effectiveGround(x, z),
      z,
      active: false,
      requiredTiles
    };
    // Terminal failures stay explicit so an arrival can fail closed, but a new
    // user-initiated attempt gets a fresh bounded retry instead of inheriting a
    // dead tile forever.
    for (const key of requiredTiles) {
      if (this.#colliderIndex?.didTileFail(key)) this.#colliderIndex.retryTile(key);
    }
    this.#arrivalSelectionEpoch = -1;
    this.#arrivalSelectionComplete = false;
    this.#arrivalSafeBodyIds.clear();
    this.#updateColliderIndex(this.#activeFocus);
    tracer.count("collisionArrivalPrepare");
    return epoch;
  }

  /** Switch the local collision focus after the player/camera teleport commit. */
  activateCollisionArrival(epoch: number): boolean {
    const arrival = this.#arrival;
    if (!arrival || arrival.epoch !== epoch) return false;
    arrival.active = true;
    this.#activeFocus.x = arrival.x;
    this.#activeFocus.y = arrival.y;
    this.#activeFocus.z = arrival.z;
    this.#arrivalSelectionEpoch = -1;
    this.#arrivalSelectionComplete = false;
    this.#arrivalSafeBodyIds.clear();
    this.#desiredBodyIds.clear();
    this.#bodyAttachQueue.length = 0;
    this.#buildingPlanDirty = true;
    this.#updateQuerySolidNeighborhood(this.#activeFocus, true);
    tracer.count("collisionArrivalActivate");
    return true;
  }

  /** Poll while controls are held; `ready` means ground + local building safety. */
  collisionArrivalStatus(epoch: number): CollisionArrivalStatus {
    const arrival = this.#arrival;
    const current = !!arrival && arrival.epoch === epoch;
    if (!arrival || !current) {
      return {
        epoch,
        current: false,
        active: false,
        groundReady: false,
        colliderDataReady: false,
        buildingBodiesReady: false,
        ready: false,
        pendingColliderTiles: 0,
        failedColliderTiles: 0,
        pendingBuildingBodies: 0
      };
    }

    let pendingColliderTiles = 0;
    let failedColliderTiles = 0;
    for (const key of arrival.requiredTiles) {
      if (this.#hasColliderTile(key)) continue;
      pendingColliderTiles++;
      if (this.#colliderIndex?.didTileFail(key)) failedColliderTiles++;
    }
    const colliderDataReady = pendingColliderTiles === 0;
    const groundReady = arrival.active && this.#groundReadyAt(arrival.x, arrival.z);
    let pendingBuildingBodies = 0;
    for (const id of this.#arrivalSafeBodyIds) {
      const handle = this.#bodyByBuilding.get(id);
      if (handle === undefined || this.#bodyRetireSet.has(handle)) pendingBuildingBodies++;
    }
    const buildingBodiesReady =
      arrival.active &&
      colliderDataReady &&
      this.#arrivalSelectionEpoch === epoch &&
      this.#arrivalSelectionComplete &&
      pendingBuildingBodies === 0;
    return {
      epoch,
      current: true,
      active: arrival.active,
      groundReady,
      colliderDataReady,
      buildingBodiesReady,
      ready: groundReady && buildingBodiesReady,
      pendingColliderTiles,
      failedColliderTiles,
      pendingBuildingBodies
    };
  }

  isCollisionArrivalReady(epoch: number): boolean {
    return this.collisionArrivalStatus(epoch).ready;
  }

  /**
   * Retire a successful one-shot arrival milestone before movement resumes.
   * Keeping the fixed destination alive after the player walks away makes its
   * ground test fail and incorrectly turns normal streaming into an every-frame
   * "pending arrival" rebuild. The steady player focus owns residency from this
   * point onward; already-created local bodies remain available to that plan.
   */
  completeCollisionArrival(epoch: number): boolean {
    const status = this.collisionArrivalStatus(epoch);
    if (!status.current || !status.ready) return false;
    this.#arrival = null;
    this.#arrivalSelectionEpoch = -1;
    this.#arrivalSelectionComplete = false;
    this.#arrivalSafeBodyIds.clear();
    this.#buildingPlanDirty = true;
    tracer.count("collisionArrivalComplete");
    return true;
  }

  /** Retry only terminally failed tiles for the current arrival. Each index
   * request keeps its own bounded attempt policy; callers also bound how many
   * fresh request cycles they initiate. */
  retryCollisionArrival(epoch: number): number {
    const arrival = this.#arrival;
    const index = this.#colliderIndex;
    if (!arrival || arrival.epoch !== epoch || !index) return 0;
    let restarted = 0;
    for (const key of arrival.requiredTiles) {
      if (index.didTileFail(key) && index.retryTile(key)) restarted++;
    }
    if (restarted > 0) this.#buildingPlanDirty = true;
    return restarted;
  }

  /**
   * Advance bounded collision-streaming work once per rendered frame. Keep this
   * outside the fixed-step catch-up loop: a slow frame may simulate three ticks,
   * but it must not also triple body/query creation or rebuild the arrival plan
   * three times. Calling this even when no fixed tick is due lets arrival
   * collision continue converging on high-refresh displays.
   */
  maintainStreaming(playerPos: THREE.Vector3): void {
    this.#tick++;
    this.#activeFocus.x = playerPos.x;
    this.#activeFocus.y = playerPos.y;
    this.#activeFocus.z = playerPos.z;
    this.#updateColliderIndex(playerPos);
    this.#updateTerrainPatch(playerPos);
    this.#updateCarpet(playerPos);
    this.#drainRefine();
    this.#updateQuerySolidNeighborhood(playerPos);
    const arrival = this.#arrival;
    const arrivalPending = !!arrival && arrival.active && !this.isCollisionArrivalReady(arrival.epoch);
    if (this.#buildingPlanDirty || arrivalPending || this.#tick % 12 === 0) {
      this.#updateBuildingBodies(playerPos);
    }
    this.#drainBuildingMutations();
    this.#drainTileSolids();
  }

  /** Advance only the deterministic stepped physics world. */
  step(dt: number): void {
    // 2 solver substeps: every mover here is velocity-driven (cars, player,
    // boat springs), so the solver only reconciles contacts — 4 substeps was
    // a 240 Hz solver nobody could see, at double the wasm cost. A crash into a
    // wall/vehicle is resolved entirely by the contact solver — it just stops
    // you; there are no crash effects, projectiles, or building damage.
    this.world.step(dt, 2);
  }

  // ------------------------------------------------------------------ ground

  /**
   * Rebuild only after the player crosses a coarse anchor boundary (or a runtime
   * ground overlay changes). The new body is created before the old one is
   * destroyed, so the stepped world never observes a frame with no near ground.
   * A platform/mesh failure permanently falls back to the established box carpet
   * for this session rather than making boot or movement fatal.
   */
  #updateTerrainPatch(playerPos: THREE.Vector3) {
    if (!this.#terrainPatchAvailable) return;
    const cx = terrainPatchAnchor(playerPos.x);
    const cz = terrainPatchAnchor(playerPos.z);
    const revision = this.map.groundRevision;
    const current = this.#terrainPatch;
    if (
      current &&
      current.centerX === cx &&
      current.centerZ === cz &&
      revision === this.#terrainPatchGroundRevision
    ) {
      return;
    }

    try {
      // groundTop deliberately excludes bridge decks: their authored, permanent
      // landmark bodies remain the collision authority while terrain continues
      // underneath. Sampling effectiveGround here would ramp the mesh from the
      // hillside/water up to a deck at each corridor edge.
      const next = buildTerrainCollisionPatch(this.map, cx, cz);
      if (next.indices.length < 3) throw new Error("terrain patch contained no safe triangles");
      const nextBody = this.world.createStaticMesh({
        position: [cx, 0, cz],
        vertices: next.vertices,
        indices: next.indices,
        friction: 0.8
      });
      const previousBody = this.#terrainPatchBody;
      this.#terrainPatchBody = nextBody;
      this.#terrainPatch = next;
      this.#terrainPatchGroundRevision = revision;
      if (previousBody !== null) this.world.destroyBody(previousBody);
      // Coverage/fallback decisions may change without the 8 m carpet anchor
      // changing, so force #updateCarpet to park or restore its pooled boxes.
      this.#carpetCX = NaN;
      this.#carpetCZ = NaN;
      tracer.count("terrainPatchBuild");
      tracer.count("terrainPatchTriangles", next.indices.length / 3);
      if (next.holeCount) tracer.count("terrainPatchHoles", next.holeCount);
    } catch (error) {
      if (this.#terrainPatchBody !== null) this.world.destroyBody(this.#terrainPatchBody);
      this.#terrainPatchBody = null;
      this.#terrainPatch = null;
      this.#terrainPatchAvailable = false;
      this.#carpetCX = NaN;
      this.#carpetCZ = NaN;
      console.warn("[physics] shared-edge terrain patch unavailable — retaining box carpet", error);
    }
  }

  #updateCarpet(playerPos: THREE.Vector3) {
    const cell = CONFIG.carpetCell;
    const cx = Math.round(playerPos.x / cell);
    const cz = Math.round(playerPos.z / cell);
    const revision = this.map.groundRevision;
    if (cx === this.#carpetCX && cz === this.#carpetCZ && revision === this.#carpetGroundRevision) return;
    this.#carpetCX = cx;
    this.#carpetCZ = cz;
    this.#carpetGroundRevision = revision;

    // Any refinements left from the previous anchor must leave immediately when
    // the shared mesh now covers them; otherwise a stale 4m box can reintroduce
    // the very seam the patch removes. At most 240 pooled transforms move here.
    this.#refineQueue.length = 0;
    for (let i = 0; i < this.#carpetSubUsed; i++) this.#parkSubSlab(this.#carpetSub[i], i, false);
    for (let i = 0; i < this.#carpetSub2Used; i++) this.#parkSubSlab(this.#carpetSub2[i], i, true);
    this.#carpetSubUsed = 0;
    this.#carpetSub2Used = 0;
    this.#refineSub = 0;
    this.#refineSub2 = 0;

    // Pass 1: ordinary cells are covered by one shared-edge mesh and their old
    // boxes are parked. Only a patch hole/boundary (or total mesh fallback) keeps
    // an 8m plane slab. Refined fallback cells keep that slab as a sunk backstop.
    const half = (CONFIG.carpetSize - 1) / 2;
    const needy: { wx: number; wz: number; d: number }[] = [];
    let k = 0;
    for (let gz = -half; gz <= half; gz++) {
      for (let gx = -half; gx <= half; gx++) {
        const wx = (cx + gx) * cell;
        const wz = (cz + gz) * cell;
        const patch = this.#terrainPatch;
        if (patch && terrainPatchCovers(patch, wx, wz, cell * 0.62)) {
          this.#parkBaseSlab(this.#carpet[k], k);
          k++;
          continue;
        }
        const sink = this.#placeSlab(this.#carpet[k], wx, wz, cell);
        if (sink > CARPET_SINK_CAP) {
          const dx = wx - playerPos.x;
          const dz = wz - playerPos.z;
          needy.push({ wx, wz, d: dx * dx + dz * dz });
        }
        k++;
      }
    }

    // pass 2 is deferred: placing every refinement slab here could eat most
    // of a 120Hz frame budget on each recenter, so #drainRefine spreads it
    // over the next frames, nearest cells first. Slabs from the previous
    // drain stay put meanwhile — they still match the terrain they sit on,
    // so stale coverage is harmless until overwritten or parked.
    needy.sort((a, b) => a.d - b.d);
    this.#refineQueue = needy;
    this.#refineSub = 0;
    this.#refineSub2 = 0;
  }

  #parkBaseSlab(handle: number, index: number): void {
    this.world.setBodyTransform(handle, [0, -500 - index * 5, 0], [0, 0, 0, 1]);
  }

  #parkSubSlab(handle: number, index: number, secondTier: boolean): void {
    const y = secondTier ? -6000 - index * 5 : -3000 - index * 5;
    this.world.setBodyTransform(handle, [0, y, 0], [0, 0, 0, 1]);
  }

  // re-cover the worst cells nearest the player with 4m slabs; quarters that
  // still sink hard (a genuine step: terrace edge, seawall lip, retaining
  // wall) recurse once to 2m so the clip band a walker can notice shrinks
  // from the whole 8m cell to ~2m along the step itself. Runs every frame,
  // budgeted to ~1ms, until the queue drains.
  #drainRefine() {
    const queue = this.#refineQueue;
    if (queue.length === 0) return;
    const cell = CONFIG.carpetCell;
    const q = cell / 4;
    const e = cell / 8;
    const t0 = performance.now();
    let sub = this.#refineSub;
    let sub2 = this.#refineSub2;
    while (queue.length > 0) {
      if (sub + 4 > CARPET_SUB_SLABS) {
        queue.length = 0;
        break;
      }
      const cellNeed = queue.shift()!;
      for (const [ox, oz] of [[-q, -q], [q, -q], [-q, q], [q, q]] as const) {
        const sink = this.#placeSlab(this.#carpetSub[sub++], cellNeed.wx + ox, cellNeed.wz + oz, cell / 2);
        if (sink > CARPET_SINK_CAP && sub2 + 4 <= CARPET_SUB2_SLABS) {
          for (const [px, pz] of [[-e, -e], [e, -e], [-e, e], [e, e]] as const) {
            this.#placeSlab(this.#carpetSub2[sub2++], cellNeed.wx + ox + px, cellNeed.wz + oz + pz, cell / 4);
          }
        }
      }
      if (performance.now() - t0 > 1) break;
    }
    this.#carpetSubUsed = Math.max(this.#carpetSubUsed, sub);
    this.#carpetSub2Used = Math.max(this.#carpetSub2Used, sub2);
    this.#refineSub = sub;
    this.#refineSub2 = sub2;
    if (queue.length === 0) {
      // drain complete: park the tail of a previous, larger refinement
      for (let i = sub; i < this.#carpetSubUsed; i++) {
        this.#parkSubSlab(this.#carpetSub[i], i, false);
      }
      for (let i = sub2; i < this.#carpetSub2Used; i++) {
        this.#parkSubSlab(this.#carpetSub2[i], i, true);
      }
      this.#carpetSubUsed = sub;
      this.#carpetSub2Used = sub2;
    }
  }

  // a slab is one tilted plane over its cell: on curving hills its corners
  // can overshoot the real road — an invisible wall at bumper height. Sink
  // it by the worst corner excess so it never pokes above the street
  // (vehicles ride their own height spring; only the walker rests on the
  // slab, and slightly-low beats blocked). Returns the sink so callers can
  // refine cells where "slightly" turned into visible ground-clipping.
  #placeSlab(handle: number, wx: number, wz: number, pitch: number): number {
    const ext = pitch * 0.62;
    const h = this.map.effectiveGround(wx, wz);
    this.map.normal(wx, wz, slabNormal, pitch * 0.5);
    slabQuat.setFromUnitVectors(slabUp, slabNormal).normalize(); // box3d traps on |q| != 1
    let sink = 0;
    for (const [dx, dz] of [[-ext, -ext], [ext, -ext], [-ext, ext], [ext, ext]] as const) {
      const planeY = h - (slabNormal.x * dx + slabNormal.z * dz) / slabNormal.y;
      const excess = planeY - this.map.effectiveGround(wx + dx, wz + dz);
      // >4m is a discontinuity (bridge deck edge, seawall), not hill curvature —
      // sinking for those would drop the whole slab out from under a walker
      if (excess > sink && excess < 4) sink = excess;
    }
    this.world.setBodyTransform(handle, [wx, h - 1.5 - sink, wz], [slabQuat.x, slabQuat.y, slabQuat.z, slabQuat.w]);
    return sink;
  }

  // -------------------------------------------------------------- buildings

  /** Manifest cells whose baked building OBBs can intersect the safety disk. */
  #arrivalTileKeys(x: number, z: number): string[] {
    const out: string[] = [];
    const half = this.tiles.manifest.tile * 0.5;
    for (const key of Object.keys(this.tiles.manifest.tiles)) {
      const [cx, cz] = this.tiles.keyToCenter(key);
      const dx = Math.max(0, Math.abs(cx - x) - half);
      const dz = Math.max(0, Math.abs(cz - z) - half);
      if (dx * dx + dz * dz <= ARRIVAL_COLLIDER_OWNER_REACH * ARRIVAL_COLLIDER_OWNER_REACH) out.push(key);
    }
    return out;
  }

  #hasColliderTile(key: string): boolean {
    const visual = this.#tileColliders.get(key);
    if (visual) return true;
    return this.#colliderIndex?.isTileReady(key) ?? false;
  }

  /** The patch supplies ordinary ground and the recentered carpet covers holes. */
  #groundReadyAt(x: number, z: number): boolean {
    const carpetReady =
      this.#carpetCX === Math.round(x / CONFIG.carpetCell) &&
      this.#carpetCZ === Math.round(z / CONFIG.carpetCell) &&
      this.#carpetGroundRevision === this.map.groundRevision;
    if (!carpetReady) return false;
    if (!this.#terrainPatchAvailable) return true;
    return (
      !!this.#terrainPatch &&
      this.#terrainPatch.centerX === terrainPatchAnchor(x) &&
      this.#terrainPatch.centerZ === terrainPatchAnchor(z) &&
      this.#terrainPatchGroundRevision === this.map.groundRevision
    );
  }

  /** During preparation retain the active origin and prime the destination. */
  #updateColliderIndex(playerPos: Readonly<{ x: number; y?: number; z: number }>): void {
    const index = this.#colliderIndex;
    if (!index) return;
    const anchors = this.#indexAnchorList;
    anchors.length = 0;
    if (Number.isFinite(playerPos.x) && Number.isFinite(playerPos.z)) {
      anchors.push({ x: playerPos.x, y: playerPos.y, z: playerPos.z, r: CONFIG.colliderRadius });
    }
    const arrival = this.#arrival;
    if (arrival && !arrival.active) {
      anchors.push({ x: arrival.x, y: arrival.y, z: arrival.z, r: ARRIVAL_COLLISION_RADIUS });
    }
    index.update(anchors);
    if (this.#colliderIndexRevision !== index.revision) {
      this.#colliderIndexRevision = index.revision;
      this.#buildingPlanDirty = true;
      this.#updateQuerySolidNeighborhood(this.#activeFocus, true);
    }
  }

  /** Player collider anchor (#0, full radius). Reused array — no per-tick alloc. */
  #gatherAnchors(playerPos: THREE.Vector3): ColliderAnchor[] {
    const out = this.#anchorList;
    out.length = 0;
    out.push({ x: playerPos.x, y: playerPos.y, z: playerPos.z, r: CONFIG.colliderRadius });
    return out;
  }

  /** DEBUG: every materialised building STATIC body as an oriented box, tagged by
   *  source (index = citywide baked index vs. visual tile stream). Feeds the "/"
   *  collider x-ray overlay so a body with no matching mesh is visible. */
  debugBuildingBodies(out: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number; index: boolean }[]): void {
    out.length = 0;
    for (const info of this.#buildingBodies.values()) {
      const c = this.#findCollider(info.key, info.i, info.s);
      if (!c) continue;
      out.push({ x: c.x, y: c.y, z: c.z, hx: c.hx, hy: c.hy, hz: c.hz, yaw: c.yaw, index: !this.#tileColliders.has(info.key) });
    }
  }

  /** DEBUG: every ACTIVE ground-carpet slab (8m cells + 4m/2m refinement pool)
   *  within `r` of (x, z) — centre/half-extents/quat straight from the stepped
   *  world. Parked slabs (deep underground) are skipped. Probe-only; no gameplay
   *  caller, no behaviour change. */
  debugCarpet(
    out: { x: number; y: number; z: number; hx: number; hy: number; hz: number; quat: [number, number, number, number]; kind: "cell" | "sub" | "sub2" }[],
    x: number,
    z: number,
    r: number
  ): void {
    out.length = 0;
    const t = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
    const scan = (handles: number[], count: number, he: number, kind: "cell" | "sub" | "sub2") => {
      for (let i = 0; i < count; i++) {
        this.world.getBodyTransform(handles[i], t);
        const [px, py, pz] = t.position;
        if (py < -100) continue; // parked pool slab
        if (Math.hypot(px - x, pz - z) > r) continue;
        out.push({ x: px, y: py, z: pz, hx: he, hy: 1.5, hz: he, quat: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]], kind });
      }
    };
    scan(this.#carpet, this.#carpet.length, CONFIG.carpetCell * 0.62, "cell");
    scan(this.#carpetSub, this.#carpetSubUsed, CONFIG.carpetCell * 0.31, "sub");
    scan(this.#carpetSub2, this.#carpetSub2Used, CONFIG.carpetCell * 0.155, "sub2");
  }

  /** Read-only terrain-patch telemetry for window.__sf.physics diagnostics. */
  get terrainPatchDebug() {
    const patch = this.#terrainPatch;
    return patch
      ? {
          active: true,
          centerX: patch.centerX,
          centerZ: patch.centerZ,
          step: patch.step,
          halfSize: patch.halfSize,
          vertices: patch.vertices.length / 3,
          triangles: patch.indices.length / 3,
          holes: patch.holeCount,
          minY: patch.minY,
          maxY: patch.maxY
        }
      : { active: false };
  }

  /** A building box by identity, from the visual tiles first then the index. */
  #findCollider(key: string, i: number, s: number): BuildingCollider | undefined {
    const visual = this.#tileColliders.get(key);
    if (visual) {
      const c = visual.find((col) => col.i === i && col.s === s);
      if (c) return c;
    }
    return this.#colliderIndex?.tiles.get(key)?.find((col) => col.i === i && col.s === s);
  }

  #hasColliderSource(key: string): boolean {
    return this.#tileColliders.has(key) || this.#colliderIndex?.tiles.has(key) === true;
  }

  #collidersForKey(key: string): BuildingCollider[] | undefined {
    return this.#tileColliders.get(key) ?? this.#colliderIndex?.tiles.get(key);
  }

  /** Merged tile source for a body/sweep query: visual tiles (alive-gated) plus
   *  index tiles for keys the player can't see. Reused array — no per-tick alloc. */
  #mergedBodyTiles(): BodyTileSource<BuildingCollider>[] {
    const src = this.#bodyTiles;
    src.length = 0;
    for (const [key, colliders] of this.#tileColliders) {
      const [cx, cz] = this.tiles.keyToCenter(key);
      src.push({ key, cx, cz, colliders });
    }
    const idx = this.#colliderIndex;
    if (idx) {
      for (const [key, colliders] of idx.tiles) {
        if (this.#tileColliders.has(key)) continue; // canonical alias already added (alive-gated)
        const [cx, cz] = this.tiles.keyToCenter(key);
        src.push({ key, cx, cz, colliders });
      }
    }
    return src;
  }

  /** Visual residency, not callback timing, makes suppression authoritative. */
  #bodyIsAlive = (key: string, i: number): boolean =>
    this.tiles.loaded.has(key) ? this.tiles.isAlive(key, i) : true;

  #updateBuildingBodies(playerPos: THREE.Vector3) {
    this.#buildingPlanDirty = false;
    const budget = CONFIG.maxActiveBuildingBodies;
    const anchors = this.#gatherAnchors(playerPos);

    // rank every alive building within the anchor's radius by min wall distance
    // (footprint edge, not centre). Ask for one overflow record so arrival never
    // claims its safety bubble is complete when the global cap cuts through it.
    const tiles = this.#mergedBodyTiles();
    const ranked = selectBodyCandidates(anchors, tiles, budget + 1, this.#bodyIsAlive, this.tiles.manifest.tile);
    const overflow = ranked.length > budget;
    const kept = overflow ? ranked.slice(0, budget) : ranked;

    // when the budget saturates, everything past the cutoff is fair game to
    // evict — with hysteresis so bodies don't churn at the boundary
    const cutoff = kept.length === budget && budget > 0 ? kept[kept.length - 1].d : Infinity;
    const wanted = this.#desiredBodyIds;
    wanted.clear();
    for (const cand of kept) wanted.add(`${cand.key}:${cand.c.i}:${cand.c.s}`);

    for (const [handle, info] of this.#buildingBodies) {
      const id = `${info.key}:${info.i}:${info.s}`;
      const c = this.#findCollider(info.key, info.i, info.s);
      // hold = min wall distance to any anchor whose OUTER band still covers it;
      // Infinity once the box has left every anchor's band (old d > rOut test)
      const hold = c ? anchorHold(c, anchors, 1.35) : Infinity;
      // A building the CityGen ring suppressed (alive→0) drops out of selectBody-
      // Candidates so it's never re-`wanted`, but distance-only eviction keeps its
      // ALREADY-materialised stepped body alive while the player stays close — the
      // loose baked box (~1–1.6 m proud of the exact-poly LOD wall the ring swapped
      // in) then blocks the walker with nothing visible there (a PHANTOM; the query
      // twin was already dropped via onBuildingAlive → ray-blind mirror). Evict on
      // death, not just distance, so the baked body is gone the instant the exact
      // walls take over and returns when the ring retires them (alive→1/255).
      if (!c || hold === Infinity || !this.#bodyIsAlive(info.key, info.i) || (!wanted.has(id) && hold > cutoff * 1.2 + 10)) {
        this.#queueBodyRetire(handle);
      } else this.#bodyRetireSet.delete(handle); // focus came back before retirement
    }

    const arrival = this.#arrival;
    const arrivalDataReady =
      !!arrival &&
      arrival.active &&
      arrival.requiredTiles.every((key) => this.#hasColliderTile(key));
    if (arrivalDataReady) {
      this.#arrivalSafeBodyIds.clear();
      this.#arrivalSelectionEpoch = arrival.epoch;
      this.#arrivalSelectionComplete = !overflow || ranked[budget].d > ARRIVAL_COLLISION_RADIUS;
    } else {
      this.#arrivalSelectionEpoch = -1;
      this.#arrivalSelectionComplete = false;
      this.#arrivalSafeBodyIds.clear();
    }

    const nextAttach: BodyAttach[] = [];
    for (const cand of kept) {
      const { key, c } = cand;
      const id = `${key}:${c.i}:${c.s}`;
      const existing = this.#bodyByBuilding.get(id);
      if (existing !== undefined) {
        this.#bodyRetireSet.delete(existing);
        if (arrivalDataReady && cand.d <= ARRIVAL_COLLISION_RADIUS) this.#arrivalSafeBodyIds.add(id);
        continue;
      }
      // Never materialise a box around an anchor actually inside its 3D volume:
      // some OBBs overhang plazas, and a dynamic body spawned inside a static box
      // gets pinned by the solver. This used to test XZ only, so an airborne board
      // directly ABOVE a roof was misclassified as embedded and the roof body was
      // deferred throughout the descent. Altitude-less auxiliary anchors retain
      // the conservative old behavior.
      let insideAny = false;
      for (const a of anchors) {
        if (anchorInsideCollider(c, a, 2.5)) {
          insideAny = true;
          break;
        }
      }
      if (insideAny) continue;
      if (arrivalDataReady && cand.d <= ARRIVAL_COLLISION_RADIUS) this.#arrivalSafeBodyIds.add(id);
      nextAttach.push({ id, key, c, d: cand.d });
    }
    // pop() returns nearest first without O(n) shifts.
    nextAttach.sort((a, b) => b.d - a.d);
    this.#bodyAttachQueue = nextAttach;
  }

  #queueBodyRetire(handle: number): void {
    if (!this.#buildingBodies.has(handle) || this.#bodyRetireSet.has(handle)) return;
    this.#bodyRetireSet.add(handle);
    this.#bodyRetireQueue.push(handle);
  }

  /** Incrementally swap origin bodies for destination bodies. Retirement gets a
   * short first slice to free budget, leaving the majority for nearest attaches. */
  #drainBuildingMutations(): void {
    const t0 = performance.now();
    const arrival = this.#arrival;
    const arrivalBurst = Boolean(
      arrival?.active && this.#arrivalSelectionEpoch === arrival.epoch
    );
    const attachLimit = arrivalBurst ? ARRIVAL_BODY_ATTACH_PER_FRAME : BODY_ATTACH_PER_FRAME;
    const mutationBudget = arrivalBurst ? ARRIVAL_BODY_MUTATION_MS : BODY_MUTATION_MS;
    let retired = 0;
    while (
      retired < BODY_RETIRE_PER_FRAME &&
      this.#bodyRetireQueue.length > 0 &&
      performance.now() - t0 < BODY_MUTATION_MS * 0.38
    ) {
      const handle = this.#bodyRetireQueue.pop()!;
      if (!this.#bodyRetireSet.delete(handle)) continue;
      const info = this.#buildingBodies.get(handle);
      if (!info) continue;
      const id = `${info.key}:${info.i}:${info.s}`;
      if (this.#desiredBodyIds.has(id) && this.#bodyIsAlive(info.key, info.i)) continue;
      this.world.destroyBody(handle);
      this.#buildingBodies.delete(handle);
      this.#bodyByBuilding.delete(id);
      retired++;
      tracer.count("buildingBodyRetire");
    }

    let attached = 0;
    while (
      attached < attachLimit &&
      this.#bodyAttachQueue.length > 0 &&
      performance.now() - t0 < mutationBudget
    ) {
      const job = this.#bodyAttachQueue.pop()!;
      // The burst exists only for controls-unlock safety. Leave the rest of the
      // steady collision neighborhood queued for normal post-arrival budgets.
      if (arrivalBurst && job.d > ARRIVAL_COLLISION_RADIUS) {
        this.#bodyAttachQueue.push(job);
        break;
      }
      if (!this.#desiredBodyIds.has(job.id) || this.#bodyByBuilding.has(job.id)) continue;
      if (!this.#bodyIsAlive(job.key, job.c.i)) continue;
      if (this.#buildingBodies.size >= CONFIG.maxActiveBuildingBodies) {
        this.#bodyAttachQueue.push(job);
        break;
      }
      const c = job.c;
      const yaw = c.yaw;
      const handle = this.world.createBox({
        type: BodyType.Static,
        position: [c.x, c.y, c.z],
        halfExtents: [c.hx, c.hy, c.hz],
        friction: 0.7
      });
      this.world.setBodyTransform(handle, [c.x, c.y, c.z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
      this.#buildingBodies.set(handle, { key: job.key, i: c.i, s: c.s });
      this.#bodyByBuilding.set(job.id, handle);
      attached++;
      tracer.count("buildingBodyAttach");
    }
    if (this.#bodyAttachQueue.length) tracer.count("buildingBodyQ", this.#bodyAttachQueue.length);
  }

  /** Highest alive-building rooftop within `radius` of (x, z); -Infinity if none. */
  highestBuildingTop(x: number, z: number, radius: number): number {
    let best = -Infinity;
    for (const [key, colliders] of this.#tileColliders) {
      const [tcx, tcz] = this.tiles.keyToCenter(key);
      if (Math.hypot(tcx - x, tcz - z) > radius + this.tiles.manifest.tile) continue;
      for (const c of colliders) {
        if (c.y + c.hy <= best) continue;
        if (Math.hypot(c.x - x, c.z - z) > radius + Math.max(c.hx, c.hz)) continue;
        if (!this.tiles.isAlive(key, c.i)) continue;
        best = c.y + c.hy;
      }
    }
    return best;
  }

  /** Is this point inside any alive building's collider OBB? */
  pointInBuilding(x: number, y: number, z: number, margin = 1): boolean {
    const p = pointScratch.set(x, y, z);
    for (const [key, colliders] of this.#tileColliders) {
      const [tcx, tcz] = this.tiles.keyToCenter(key);
      if (Math.hypot(tcx - x, tcz - z) > this.tiles.manifest.tile * 0.75 + 60) continue;
      for (const c of colliders) {
        if (!this.tiles.isAlive(key, c.i)) continue;
        if (this.#obbContains(c, p, margin)) return true;
      }
    }
    return false;
  }

  /**
   * Conservative camera-volume cast through the static query world. Five
   * parallel broadphase rays approximate a swept sphere without creating a
   * physics body or touching the stepped gameplay world. Returns metres from
   * `focus` to the first obstruction, or Infinity when the complete boom is
   * clear. Terrain is handled by the chase camera's existing endpoint clamp;
   * this query is deliberately building/bridge/landmark-only and allocation-free.
   */
  cameraObstructionDistance(
    focus: THREE.Vector3,
    desired: THREE.Vector3,
    radius: number
  ): number {
    let dx = desired.x - focus.x;
    let dy = desired.y - focus.y;
    let dz = desired.z - focus.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.001) return Infinity;
    dx /= length;
    dy /= length;
    dz /= length;

    // Camera-local right. For an almost-vertical boom, choose world X so the
    // offset frame remains defined instead of amplifying floating-point noise.
    let rx = -dz;
    let rz = dx;
    const rLen = Math.hypot(rx, rz);
    if (rLen < 0.001) {
      rx = 1;
      rz = 0;
    } else {
      rx /= rLen;
      rz /= rLen;
    }
    // Camera-local up = forward × right.
    const ux = dy * rz;
    const uy = dz * rx - dx * rz;
    const uz = -dy * rx;

    let nearest = Infinity;
    const cast = (ox: number, oy: number, oz: number) => {
      const hit = this.#solids.castRayClosest(
        focus.x + ox,
        focus.y + oy,
        focus.z + oz,
        dx,
        dy,
        dz,
        length,
        undefined,
        this.#solidRay
      );
      // A focus point can sit flush with a rooftop collider. Ignore contact
      // epsilon there; a real facade obstruction is always farther down-boom.
      // Only an ENTERING face blocks the boom. An offset ray can begin inside a
      // roof/parapet beside the subject; its first hit is then the exit face and
      // must not collapse the camera as though the wall were behind the player.
      const entering = hit ? hit.nx * dx + hit.ny * dy + hit.nz * dz < -0.01 : false;
      if (hit && entering && hit.distance > 0.08 && hit.distance < nearest) nearest = hit.distance;
    };

    cast(0, 0, 0);
    cast(rx * radius, 0, rz * radius);
    cast(-rx * radius, 0, -rz * radius);
    cast(ux * radius, uy * radius, uz * radius);
    cast(-ux * radius, -uy * radius, -uz * radius);
    return nearest;
  }

  /** Hand the scene-aware building-ray refiner to raycastWorld (see below). */
  setBuildingRayRefiner(refiner: BuildingRayRefiner | null): void {
    this.#rayRefiner = refiner;
  }

  /**
   * Nearest world surface along a ray: static SOLIDS (buildings + bridge +
   * landmarks) via one broadphase-accelerated cast over the never-stepped
   * #solids world, raced against the analytic terrain heightfield. Returns the
   * world hit point, outward surface normal, and what was struck. `kind: "water"`
   * means the ray landed on open bay rather than land. The bridge is a real solid
   * here (deck + rails + underside), so it is hit at any angle — not a top plane.
   *
   * Building hits are REFINED when a scene refiner is attached: a baked building
   * OBB overshoots the true footprint by up to ~2 m, so when the hit box's baked
   * mesh is hidden (the citygen ring draws the exact-footprint prism / detail
   * mesh in its place) the ray is re-tested against that rendered geometry near
   * the box hit. A triangle hit replaces the point/normal (splats sit ON the
   * visible wall, possibly a hair past `maxDist` — callers treat that as "about
   * to hit"); no triangle means the ray passed through bake overshoot (a gap
   * between buildings) and the cast CONTINUES past the loose box. Hits on
   * citygen's own tight walls, landmarks, or buildings whose baked mesh is
   * visible return unrefined — the box is (near enough) the visible surface.
   */
  raycastWorld(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number
  ): { point: THREE.Vector3; normal: THREE.Vector3; kind: "building" | "ground" | "water" } | null {
    let hit = this.#castWorldOnce(origin, dir, maxDist);
    const refiner = this.#rayRefiner;
    if (!refiner) return hit;
    let advance = 0;
    for (let iter = 0; iter < 4 && hit; iter++) {
      if (hit.kind !== "building" || hit.handle === undefined) return hit;
      const tag = this.#solidTag.get(hit.handle);
      // untagged (landmark) or citygen exact walls: the box already matches the
      // rendered surface — return as-is
      if (!tag || tag === "citygen") return hit;
      // baked facade still visible (non-citygen archetype / chunk not ready yet):
      // the box stays the authority — bld_* tile meshes are not raycast here
      if (!this.tiles.isBuildingMeshHidden(tag.key, tag.i)) return hit;
      const boxT = advance + hit.distance;
      const refined = refiner.refine(origin, dir, boxT);
      if (refined) return { point: refined.point, normal: refined.normal, kind: "building" };
      // no rendered surface near the box hit — the ray only clipped the bake's
      // overshoot; step just past the box face and keep casting
      advance = boxT + 0.05;
      if (advance >= maxDist) return null;
      hit = this.#castWorldOnce(
        this.#advOrigin.copy(origin).addScaledVector(dir, advance),
        dir,
        maxDist - advance
      );
    }
    return hit; // iteration cap: fall back to whatever the last cast said
  }

  /** One raw solids-vs-terrain cast (no refinement). `distance` is metres from
   * the (possibly advanced) cast origin; `handle` is set for building hits. */
  #castWorldOnce(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number
  ): { point: THREE.Vector3; normal: THREE.Vector3; kind: "building" | "ground" | "water"; distance: number; handle?: number } | null {
    // --- static solids: one broadphase cast over the never-stepped world (dir
    // is unit, so hit.distance is metres). Buildings, bridge + landmarks all live
    // here, so this single call replaces the old per-collider slab sweep.
    let bestT = Infinity;
    let bestN: [number, number, number] | null = null;
    const sHit = this.#solids.castRayClosest(
      origin.x,
      origin.y,
      origin.z,
      dir.x,
      dir.y,
      dir.z,
      maxDist,
      undefined,
      this.#solidRay
    );
    if (sHit) {
      bestT = sHit.distance;
      bestN = [sHit.nx, sHit.ny, sHit.nz];
    }
    let bestHandle: number | undefined = sHit?.handle;

    // Rare long interactions (notably camera-mode double-click at up to 2.5 km)
    // still need distant visible buildings even though they no longer deserve
    // thousands of resident Box3D query bodies. Use the old exact OBB slab math
    // only for those long casts; ordinary per-frame gameplay stays on broadphase.
    if (maxDist > QUERY_SOLID_EVICT_RADIUS) {
      const far = this.#castVisualTileObbs(origin, dir, Math.min(maxDist, bestT));
      if (far && far.distance < bestT) {
        bestT = far.distance;
        bestN = far.normal;
        bestHandle = undefined;
      }
    }

    // --- terrain: coarse march + bisection refine on the sign flip. Marches the
    // rendered top-ground surface (map.groundTop = terrain + draped park lawns),
    // NOT the raw heightfield — the raw field sits UNDER every lawn, so a shot
    // marching it lands beneath the visible grass and the splat is occluded. Also
    // NOT effectiveGround: the bridge deck is a solid above (cast separately), so
    // groundTop excludes it and it can't reappear here as a phantom plane.
    let groundT = Infinity;
    if (dir.y < 0.35) {
      // rays angled well upward can't land on the heightfield
      const step = 3;
      let prevT = 0;
      let prevAbove = origin.y - this.map.groundTop(origin.x, origin.z) > 0;
      const limit = Math.min(maxDist, bestT);
      for (let t = step; t <= limit + step; t += step) {
        const tt = Math.min(t, limit);
        const x = origin.x + dir.x * tt;
        const z = origin.z + dir.z * tt;
        const above = origin.y + dir.y * tt - this.map.groundTop(x, z) > 0;
        if (prevAbove && !above) {
          let lo = prevT;
          let hi = tt;
          for (let i = 0; i < 8; i++) {
            const m = (lo + hi) / 2;
            const my = origin.y + dir.y * m;
            if (my - this.map.groundTop(origin.x + dir.x * m, origin.z + dir.z * m) > 0) lo = m;
            else hi = m;
          }
          groundT = (lo + hi) / 2;
          break;
        }
        prevAbove = above;
        prevT = tt;
        if (tt >= limit) break;
      }
    }

    if (bestT === Infinity && groundT === Infinity) return null;
    if (groundT < bestT) {
      const point = new THREE.Vector3(
        origin.x + dir.x * groundT,
        origin.y + dir.y * groundT,
        origin.z + dir.z * groundT
      );
      const normal = this.map.normal(point.x, point.z, new THREE.Vector3());
      const kind = this.map.isWater(point.x, point.z) ? "water" : "ground";
      return { point, normal, kind, distance: groundT };
    }
    const point = new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    return { point, normal: new THREE.Vector3(...bestN!), kind: "building", distance: bestT, handle: bestHandle };
  }

  /** On-demand distant OBB cast. This preserves long camera-mode picking without
   * paying for far Box3D bodies during normal rendering or movement. */
  #castVisualTileObbs(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number
  ): { distance: number; normal: [number, number, number] } | null {
    let bestT = maxDist;
    let bestN: [number, number, number] | null = null;
    const midX = origin.x + (dir.x * maxDist) / 2;
    const midZ = origin.z + (dir.z * maxDist) / 2;
    for (const [key, colliders] of this.#tileColliders) {
      const [tcx, tcz] = this.tiles.keyToCenter(key);
      if (Math.hypot(tcx - midX, tcz - midZ) > this.tiles.manifest.tile * 0.75 + maxDist / 2 + 120) continue;
      for (const c of colliders) {
        const cdx = c.x - midX;
        const cdz = c.z - midZ;
        const reach = c.hx + c.hz + maxDist / 2;
        if (cdx * cdx + cdz * cdz > reach * reach || !this.tiles.isAlive(key, c.i)) continue;

        const cos = c.cosYaw;
        const sin = c.sinYaw;
        const ox = (origin.x - c.x) * cos - (origin.z - c.z) * sin;
        const oy = origin.y - c.y;
        const oz = (origin.x - c.x) * sin + (origin.z - c.z) * cos;
        const dx = dir.x * cos - dir.z * sin;
        const dy = dir.y;
        const dz = dir.x * sin + dir.z * cos;
        let tmin = 0;
        let tmax = bestT;
        let axis = -1;
        let sign = 1;
        let miss = false;
        for (const [o, d, half, ax] of [
          [ox, dx, c.hx, 0],
          [oy, dy, c.hy, 1],
          [oz, dz, c.hz, 2]
        ] as const) {
          if (Math.abs(d) < 1e-9) {
            if (Math.abs(o) > half) miss = true;
            if (miss) break;
            continue;
          }
          let t0 = (-half - o) / d;
          let t1 = (half - o) / d;
          const entrySign = d > 0 ? -1 : 1;
          if (t0 > t1) [t0, t1] = [t1, t0];
          if (t0 > tmin) {
            tmin = t0;
            axis = ax;
            sign = entrySign;
          }
          tmax = Math.min(tmax, t1);
          if (tmin > tmax) {
            miss = true;
            break;
          }
        }
        if (miss || axis < 0 || tmin >= bestT) continue;
        bestT = tmin;
        if (axis === 1) bestN = [0, sign, 0];
        else {
          const lnx = axis === 0 ? sign : 0;
          const lnz = axis === 2 ? sign : 0;
          bestN = [lnx * cos + lnz * sin, 0, -lnx * sin + lnz * cos];
        }
      }
    }
    return bestN ? { distance: bestT, normal: bestN } : null;
  }

  // ------------------------------------------------- world-solid query bodies

  /** Create one static box in the #solids query world; orientation via SetTransform
   * (which also seeds the broadphase AABB). A full `quat` wins over `yaw` (citygen
   * tilted stair ramps); otherwise the box is yawed about Y. Returns its handle. */
  #makeSolid(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number, quat?: readonly [number, number, number, number]): number {
    const h = this.#solids.createBox({ type: BodyType.Static, position: [x, y, z], halfExtents: [hx, hy, hz] });
    if (quat) this.#solids.setBodyTransform(h, [x, y, z], [quat[0], quat[1], quat[2], quat[3]]);
    else if (yaw) this.#solids.setBodyTransform(h, [x, y, z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    return h;
  }

  /** Rebuild the pending local set only after meaningful movement or a teleport. */
  #updateQuerySolidNeighborhood(focus: Readonly<{ x: number; z: number }>, force = false): void {
    if (!Number.isFinite(focus.x) || !Number.isFinite(focus.z)) return;
    const moved = Math.hypot(focus.x - this.#queryFocusX, focus.z - this.#queryFocusZ);
    if (!force && moved < QUERY_FOCUS_STEP) return;
    this.#queryFocusX = focus.x;
    this.#queryFocusZ = focus.z;
    this.#solidGeneration++;
    this.#solidQueue.length = 0;
    this.#solidQueuedIds.clear();

    // Existing bodies get a generous outer band so ordinary motion does not
    // churn them. Destruction is queued, never performed in this scan.
    for (const [handle, owner] of this.#solidOwner) {
      if (
        !this.#hasColliderSource(owner.key) ||
        !this.#bodyIsAlive(owner.key, owner.i) ||
        obbPlanarDistance(owner.c, focus.x, focus.z) > QUERY_SOLID_EVICT_RADIUS
      ) {
        this.#queueSolidRetire(handle);
      } else {
        this.#solidRetireSet.delete(handle);
      }
    }
    for (const [key, colliders] of this.#tileColliders) this.#enqueueLocalQueryTile(key, colliders, undefined, false);
    const index = this.#colliderIndex;
    if (index) {
      for (const [key, colliders] of index.tiles) {
        if (!this.#tileColliders.has(key)) this.#enqueueLocalQueryTile(key, colliders, undefined, false);
      }
    }
    this.#solidQueue.sort((a, b) => b.d - a.d);
  }

  /** Enqueue only boxes inside the active local query disk, nearest first. */
  #enqueueLocalQueryTile(
    key: string,
    colliders: BuildingCollider[],
    onlyBuilding?: number,
    sort = true
  ): void {
    if (!Number.isFinite(this.#queryFocusX) || !Number.isFinite(this.#queryFocusZ)) return;
    const [tcx, tcz] = this.tiles.keyToCenter(key);
    const half = this.tiles.manifest.tile * 0.5;
    const dx = Math.max(0, Math.abs(tcx - this.#queryFocusX) - half);
    const dz = Math.max(0, Math.abs(tcz - this.#queryFocusZ) - half);
    const tileReach = QUERY_SOLID_LOAD_RADIUS + 120; // tolerate large edge-crossing footprints
    if (dx * dx + dz * dz > tileReach * tileReach) return;
    for (const c of colliders) {
      if (onlyBuilding !== undefined && c.i !== onlyBuilding) continue;
      const d = obbPlanarDistance(c, this.#queryFocusX, this.#queryFocusZ);
      if (d > QUERY_SOLID_LOAD_RADIUS || !this.#bodyIsAlive(key, c.i)) continue;
      const id = `${key}:${c.i}:${c.s}`;
      const existing = this.#solidByCollider.get(id);
      if (existing !== undefined) {
        this.#solidRetireSet.delete(existing);
        continue;
      }
      if (this.#solidQueuedIds.has(id)) continue;
      this.#solidQueuedIds.add(id);
      this.#solidQueue.push({ generation: this.#solidGeneration, id, key, c, d });
    }
    if (sort) this.#solidQueue.sort((a, b) => b.d - a.d);
  }

  #queueSolidRetire(handle: number): void {
    if (!this.#solidOwner.has(handle) || this.#solidRetireSet.has(handle)) return;
    this.#solidRetireSet.add(handle);
    this.#solidRetireQueue.push(handle);
  }

  /** Tile unload only schedules retirement; a dense origin tile never dies in one frame. */
  #retireTileSolids(key: string): void {
    for (let i = this.#solidQueue.length - 1; i >= 0; i--) {
      const job = this.#solidQueue[i];
      if (job.key !== key) continue;
      this.#solidQueuedIds.delete(job.id);
      this.#solidQueue.splice(i, 1);
    }
    const owned = this.#solidTileIndex.get(key);
    if (owned) for (const handle of owned) this.#queueSolidRetire(handle);
  }

  #destroyTileSolid(handle: number): void {
    const owner = this.#solidOwner.get(handle);
    if (!owner) return;
    this.#solids.destroyBody(handle);
    this.#solidOwner.delete(handle);
    this.#solidByCollider.delete(owner.id);
    this.#solidTag.delete(handle);
    const bk = `${owner.key}:${owner.i}`;
    const arr = this.#solidByBuilding.get(bk);
    if (arr) {
      const at = arr.indexOf(handle);
      if (at >= 0) arr.splice(at, 1);
      if (arr.length === 0) this.#solidByBuilding.delete(bk);
    }
    const owned = this.#solidTileIndex.get(owner.key);
    if (owned) {
      owned.delete(handle);
      if (owned.size === 0) this.#solidTileIndex.delete(owner.key);
    }
  }

  /** Drain local query creates and stale destroys in bounded, main-thread batches. */
  #drainTileSolids(): void {
    const t0 = performance.now();
    let retired = 0;
    while (
      retired < QUERY_RETIRE_PER_FRAME &&
      this.#solidRetireQueue.length > 0 &&
      performance.now() - t0 < QUERY_MUTATION_MS * 0.35
    ) {
      const handle = this.#solidRetireQueue.pop()!;
      if (!this.#solidRetireSet.delete(handle)) continue;
      const owner = this.#solidOwner.get(handle);
      if (!owner) continue;
      if (
        this.#hasColliderSource(owner.key) &&
        this.#bodyIsAlive(owner.key, owner.i) &&
        obbPlanarDistance(owner.c, this.#queryFocusX, this.#queryFocusZ) <= QUERY_SOLID_EVICT_RADIUS
      ) {
        continue;
      }
      this.#destroyTileSolid(handle);
      retired++;
      tracer.count("tileSolidRetire");
    }

    let attached = 0;
    while (
      attached < QUERY_ATTACH_PER_FRAME &&
      this.#solidQueue.length > 0 &&
      performance.now() - t0 < QUERY_MUTATION_MS
    ) {
      const job = this.#solidQueue.pop()!;
      this.#solidQueuedIds.delete(job.id);
      if (job.generation !== this.#solidGeneration || !this.#hasColliderSource(job.key)) continue;
      if (this.#solidByCollider.has(job.id) || !this.#bodyIsAlive(job.key, job.c.i)) continue;
      if (obbPlanarDistance(job.c, this.#queryFocusX, this.#queryFocusZ) > QUERY_SOLID_LOAD_RADIUS) continue;
      const c = job.c;
      const h = this.#makeSolid(c.x, c.y, c.z, c.hx, c.hy, c.hz, c.yaw);
      this.#solidByCollider.set(job.id, h);
      this.#solidOwner.set(h, { id: job.id, key: job.key, i: c.i, s: c.s, c });
      const bk = `${job.key}:${c.i}`;
      const arr = this.#solidByBuilding.get(bk) ?? [];
      arr.push(h);
      this.#solidByBuilding.set(bk, arr);
      const owned = this.#solidTileIndex.get(job.key) ?? new Set<number>();
      owned.add(h);
      this.#solidTileIndex.set(job.key, owned);
      this.#solidTag.set(h, { key: job.key, i: c.i });
      attached++;
      tracer.count("tileSolids");
    }
    if (this.#solidQueue.length) tracer.count("tileSolidQ", this.#solidQueue.length);
  }

  /** Alive flips share the same bounded local queues; no synchronous bursts. */
  #setBuildingSolidAlive(key: string, i: number, alive: boolean): void {
    const arr = this.#solidByBuilding.get(`${key}:${i}`);
    if (!alive) {
      if (arr) for (const handle of arr) this.#queueSolidRetire(handle);
      return;
    }
    const cols = this.#collidersForKey(key);
    if (cols) this.#enqueueLocalQueryTile(key, cols, i);
  }

  /**
   * Register one extra static box into the #solids query world so raycastWorld —
   * and thus paint / the world cursor / the aim reticle — sees it. `id` is any
   * caller-stable key: the citygen ring passes its stepped-world body handle so
   * add/remove stay locked to the real collider. Re-registering an id replaces its
   * box. A full `box.quat` wins over `box.yaw` (citygen tilted stair ramps).
   */
  addQuerySolid(
    id: number,
    box: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw?: number; quat?: readonly [number, number, number, number] }
  ): void {
    const existing = this.#querySolids.get(id);
    if (existing !== undefined) { this.#solids.destroyBody(existing); this.#solidTag.delete(existing); }
    const h = this.#makeSolid(box.x, box.y, box.z, box.hx, box.hy, box.hz, box.yaw ?? 0, box.quat);
    this.#solidTag.set(h, "citygen");
    this.#querySolids.set(id, h);
  }

  /** Register a static triangle mesh in the query world. CityGen roofs use the
   * exact footprint mesh in both worlds so player contacts and paint/cursor rays
   * agree even for rotated or concave buildings. */
  addQueryMesh(
    id: number,
    mesh: { x: number; y: number; z: number; vertices: ArrayLike<number>; indices: ArrayLike<number> }
  ): void {
    const existing = this.#querySolids.get(id);
    if (existing !== undefined) this.#solids.destroyBody(existing);
    const handle = this.#solids.createStaticMesh({
      position: [mesh.x, mesh.y, mesh.z],
      vertices: mesh.vertices,
      indices: mesh.indices,
      friction: 0.8
    });
    this.#querySolids.set(id, handle);
  }

  /** Drop a previously registered extra query solid (no-op if the id is unknown). */
  removeQuerySolid(id: number): void {
    const h = this.#querySolids.get(id);
    if (h === undefined) return;
    this.#solids.destroyBody(h);
    this.#solidTag.delete(h);
    this.#querySolids.delete(id);
  }

  #obbContains(c: BuildingCollider, p: THREE.Vector3, margin: number): boolean {
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const cos = c.cosYaw;
    const sin = c.sinYaw;
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    return (
      Math.abs(lx) < c.hx + margin &&
      Math.abs(lz) < c.hz + margin &&
      p.y > c.y - c.hy - margin &&
      p.y < c.y + c.hy + margin
    );
  }
}
