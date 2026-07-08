import * as THREE from "three/webgpu";
import {
  BodyType,
  createBox3D,
  type Box3D,
  type ContactHitEvent,
  type PhysicsWorld,
  type RayCastHit,
  type TransformBatch
} from "./box3dWorld";
// Re-exported so the ~20 gameplay/vehicle modules depend on the physics facade
// rather than the underlying engine package directly.
export { BodyType, TRANSFORM_STRIDE, TransformBatch } from "./box3dWorld";
export type {
  ContactHitEvent,
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
import type { WorldMap } from "../world/heightmap";
import type { BuildingCollider, TileStreamer } from "../world/tiles";
import { buildingTone } from "../world/facade";
import { BuildingColliderIndex } from "./buildingColliderIndex";
import {
  selectBodyCandidates,
  obbContainsXZ,
  anchorHold,
  type ColliderAnchor,
  type BodyTileSource
} from "./buildingBodies";

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

export type Debris = {
  handle: number;
  hx: number;
  hy: number;
  hz: number;
  color: THREE.Color;
  baseY: number; // parent building's base height, so chunk facades keep their floor lines
  bid: number; // parent building id, so chunks keep the same lit-window pattern
  // frozen spawn pose (centre + building yaw): the shader evaluates the facade in
  // this frame so the pattern rides the tumbling chunk instead of scrolling
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  age: number;
  seed: number; // 0..1, staggers this chunk's lights-out moment within the spread
};

export type Projectile = {
  handle: number;
  age: number;
  seed: number; // 0..1, varies the tracer shader per shot
  prev: [number, number, number]; // last step's position, for the building sweep
};

// One baked always-resident box (bridge deck/rail segment, or a landmark proxy)
// as served by data/landmark-colliders.json.
type LandmarkBox = { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw?: number };

export class Physics {
  box3d!: Box3D;
  world!: PhysicsWorld;
  map: WorldMap;
  tiles: TileStreamer;

  debris: Debris[] = [];
  debrisDirty = false;
  projectiles: Projectile[] = [];

  onExplosion: (pos: THREE.Vector3, radius: number) => void = () => {};
  onFracture: (pos: THREE.Vector3, volume: number, height: number) => void = () => {};
  onHardImpact: (pos: THREE.Vector3, speed: number) => void = () => {};

  #carpet: number[] = [];
  #carpetSub: number[] = []; // 4m refinement slabs (parked until assigned)
  #carpetSub2: number[] = []; // 2m refinement slabs for genuine steps
  #carpetSubUsed = 0; // high-water of currently-placed (non-parked) sub slabs
  #carpetSub2Used = 0;
  // cells awaiting refinement + placement cursors: pass 2 drains ~1ms per
  // frame from step() instead of all at once on the recenter frame
  #refineQueue: { wx: number; wz: number; d: number }[] = [];
  #refineSub = 0;
  #refineSub2 = 0;
  #carpetCX = NaN;
  #carpetCZ = NaN;

  // temporary static slabs under fracture sites: the ground carpet only exists
  // around the player, so distant rubble needs its own floor to land on
  #rubbleFloors: { handle: number; age: number }[] = [];

  // one entry per materialised BOX — concave buildings bake to several boxes
  // sharing an `i` (tiles.ts patches in the sub-ordinal `s`), so bodies key by
  // "key:i:s" while damage/alive state stays per-building on "key:i"
  #buildingBodies = new Map<number, { key: string; i: number; s: number }>();
  #bodyByBuilding = new Map<string, number>(); // "key:i:s" -> handle
  // cumulative structural damage in kJ, "key:i" -> damage; a building collapses
  // when this passes its volume-scaled strength (see CONFIG.buildingHp*)
  #damage = new Map<string, number>();
  #tileColliders = new Map<string, BuildingCollider[]>();

  // Query-only world of static SOLIDS — every alive building box, plus the
  // always-resident bridge + landmark boxes. Never stepped: box3d seeds a body's
  // broadphase AABB at shape-create time, so castRayClosest answers immediately
  // (verified). This is the single geometry authority behind raycastWorld — the
  // hand-rolled OBB slab test is gone, and the bridge is a real solid here rather
  // than a heightfield plane, so shots hit its deck/rails/underside at any angle.
  #solids!: PhysicsWorld;
  #solidByBuilding = new Map<string, number[]>(); // "key:i" -> its sub-box handles
  #solidTileIndex = new Map<string, string[]>(); // tile key -> "key:i" it owns (bulk unload)
  #landmarkSolids: number[] = []; // boot-resident bridge + landmark box handles
  #solidRay: RayCastHit = { handle: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, distance: 0 };
  // baked OBBs streamed around every collider anchor, decoupled from the visual
  // tile stream, so AI cars far from the player still have building data (see
  // buildingColliderIndex.ts). Null until create() finishes loading the manifest.
  #colliderIndex: BuildingColliderIndex | null = null;
  // extra collider anchors beyond the player (AI cars, active vehicles). Provided
  // by main.ts via setColliderAnchors; each returned point pulls building bodies
  // + index tiles into existence around it.
  #colliderAnchors: (() => THREE.Vector3[]) | null = null;
  #anchorList: ColliderAnchor[] = []; // reused per body update — no per-tick alloc
  #bodyTiles: BodyTileSource<BuildingCollider>[] = []; // reused merged tile source
  #vehicleHandles = new Set<number>();
  #debrisBatch: TransformBatch | null = null;
  #tick = 0;

  private constructor(map: WorldMap, tiles: TileStreamer) {
    this.map = map;
    this.tiles = tiles;
  }

  static async create(map: WorldMap, tiles: TileStreamer): Promise<Physics> {
    const p = new Physics(map, tiles);
    p.box3d = await createBox3D();
    p.world = p.box3d.createWorld([...CONFIG.gravity]);
    p.world.setHitEventThreshold(2.5);
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

    tiles.onTileColliders = (key, colliders) => {
      p.#tileColliders.set(key, colliders);
      p.#addTileSolids(key, colliders);
    };
    tiles.onTileUnload = (key) => {
      p.#tileColliders.delete(key);
      p.#removeTileSolids(key);
      for (const [handle, info] of p.#buildingBodies) {
        if (info.key === key) {
          p.world.destroyBody(handle);
          p.#buildingBodies.delete(handle);
          p.#bodyByBuilding.delete(`${info.key}:${info.i}:${info.s}`);
        }
      }
      for (const id of p.#damage.keys()) {
        if (id.startsWith(`${key}:`)) p.#damage.delete(id);
      }
    };
    // runtime solid add/drop on full suppress, revive, or fracture (mesh-only
    // suppression keeps the collider, so tiles never fires it for that)
    tiles.onBuildingAlive = (key, index, alive) => p.#setBuildingSolidAlive(key, index, alive);

    // always-resident bridge + landmark solids: a fixed ~860-box set that no
    // longer rides the per-tile stream, so open-water bridge spans (whose tiles
    // aren't in the manifest) get a real collider. Best-effort — a failed fetch
    // just leaves them ghost, exactly as before this system existed.
    try {
      const res = await fetch("/data/landmark-colliders.json");
      if (res.ok) {
        for (const b of (await res.json()) as LandmarkBox[]) {
          p.#landmarkSolids.push(p.#makeSolid(b.x, b.y, b.z, b.hx, b.hy, b.hz, b.yaw ?? 0));
        }
      }
    } catch (err) {
      console.warn("[physics] landmark/bridge solids unavailable — bridge stays ghost", err);
    }

    // citywide collider index: baked OBBs around every anchor, decoupled from the
    // visual tile stream. Best-effort — a failed manifest load just leaves the
    // index null and physics falls back to visual-only (the prior behaviour).
    try {
      const index = new BuildingColliderIndex();
      await index.init();
      p.#colliderIndex = index;
    } catch (err) {
      console.warn("[physics] collider index disabled — visual-only building bodies", err);
    }
    return p;
  }

  /**
   * Register a provider of extra collider anchors (AI cars / active vehicles).
   * The player is always anchor #0; each point this returns pulls building static
   * bodies + citywide-index tiles into existence around it, so agents elsewhere in
   * the city collide with buildings instead of clipping through them.
   */
  setColliderAnchors(provider: () => THREE.Vector3[]) {
    this.#colliderAnchors = provider;
  }

  registerVehicle(handle: number) {
    this.#vehicleHandles.add(handle);
    this.world.setBodyHitEvents(handle, true);
  }

  unregisterVehicle(handle: number) {
    this.#vehicleHandles.delete(handle);
  }

  step(dt: number, playerPos: THREE.Vector3) {
    this.#tick++;
    this.#updateCarpet(playerPos);
    this.#drainRefine();
    if (this.#tick % 12 === 0) this.#updateBuildingBodies(playerPos);

    // 2 solver substeps: every mover here is velocity-driven (cars, player,
    // boat springs), so the solver only reconciles contacts — 4 substeps was
    // a 240 Hz solver nobody could see, at double the wasm cost
    this.world.step(dt, 2);

    // impacts
    for (const ev of this.world.readHitEvents(96)) {
      this.#handleHit(ev);
    }

    // projectile sweep vs building footprints: buildings beyond the active-body
    // radius (or with a deferred body) have no physics box, so a bullet would
    // sail straight through them — test the flight segment against the collider
    // OBBs directly and detonate on the wall it crosses
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      const t = this.world.getBodyTransform(pr.handle);
      const hit = this.sweepBuildings(pr.prev, t.position);
      if (hit) {
        const v = this.world.getBodyVelocity(pr.handle).linear;
        this.projectiles.splice(i, 1);
        this.world.destroyBody(pr.handle);
        this.detonateProjectile(hit, new THREE.Vector3(v[0], v[1], v[2]));
      } else {
        pr.prev[0] = t.position[0];
        pr.prev[1] = t.position[1];
        pr.prev[2] = t.position[2];
      }
    }

    // rubble floors expire once their debris is gone
    for (let i = this.#rubbleFloors.length - 1; i >= 0; i--) {
      const fl = this.#rubbleFloors[i];
      fl.age += dt;
      if (fl.age > CONFIG.debrisLifetime + 1) {
        this.world.destroyBody(fl.handle);
        this.#rubbleFloors.splice(i, 1);
      }
    }

    // debris lifecycle
    let removed = false;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age > CONFIG.debrisLifetime) {
        this.world.destroyBody(d.handle);
        this.debris.splice(i, 1);
        removed = true;
      }
    }
    if (removed) this.debrisDirty = true;

    // projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.age += dt;
      if (pr.age > 7) {
        this.world.destroyBody(pr.handle);
        this.projectiles.splice(i, 1);
      }
    }
  }

  debrisTransforms(): Float32Array | null {
    if (this.debris.length === 0) return null;
    if (this.debrisDirty || !this.#debrisBatch) {
      this.#debrisBatch?.dispose();
      this.#debrisBatch = this.world.createTransformBatch(this.debris.map((d) => d.handle));
      this.debrisDirty = false;
    }
    return this.#debrisBatch.read();
  }

  // ------------------------------------------------------------------ ground

  #updateCarpet(playerPos: THREE.Vector3) {
    const cell = CONFIG.carpetCell;
    const cx = Math.round(playerPos.x / cell);
    const cz = Math.round(playerPos.z / cell);
    if (cx === this.#carpetCX && cz === this.#carpetCZ) return;
    this.#carpetCX = cx;
    this.#carpetCZ = cz;

    // pass 1: every 8m cell gets its plane slab. Refined cells keep it too —
    // a sunk backstop underneath, so pool exhaustion degrades instead of
    // opening a hole in the floor.
    const half = (CONFIG.carpetSize - 1) / 2;
    const needy: { wx: number; wz: number; d: number }[] = [];
    let k = 0;
    for (let gz = -half; gz <= half; gz++) {
      for (let gx = -half; gx <= half; gx++) {
        const wx = (cx + gx) * cell;
        const wz = (cz + gz) * cell;
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
        this.world.setBodyTransform(this.#carpetSub[i], [0, -3000 - i * 5, 0], [0, 0, 0, 1]);
      }
      for (let i = sub2; i < this.#carpetSub2Used; i++) {
        this.world.setBodyTransform(this.#carpetSub2[i], [0, -6000 - i * 5, 0], [0, 0, 0, 1]);
      }
      this.#carpetSubUsed = sub;
      this.#carpetSub2Used = sub2;
    }
  }

  // a slab is one tilted plane over its cell: on curving hills its corners
  // can overshoot the real road — an invisible wall at bumper height. Sink
  // it by the worst corner excess so it never pokes above the street
  // (vehicles ride their own height spring; only walk/debris rest on the
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

  /** Planar distance from a point to a collider's footprint edge (0 inside). */
  #obbPlanarDistance(c: BuildingCollider, x: number, z: number): number {
    const dx = x - c.x;
    const dz = z - c.z;
    const ex = Math.max(0, Math.abs(dx * c.cosYaw - dz * c.sinYaw) - c.hx);
    const ez = Math.max(0, Math.abs(dx * c.sinYaw + dz * c.cosYaw) - c.hz);
    return Math.hypot(ex, ez);
  }

  /** Player (anchor #0, full radius) + every registered extra anchor (AI cars /
   *  vehicles, tight radius). Reused array — no per-tick allocation. */
  #gatherAnchors(playerPos: THREE.Vector3): ColliderAnchor[] {
    const out = this.#anchorList;
    out.length = 0;
    out.push({ x: playerPos.x, z: playerPos.z, r: CONFIG.colliderRadius });
    const provider = this.#colliderAnchors;
    if (provider) {
      for (const p of provider()) out.push({ x: p.x, z: p.z, r: CONFIG.carColliderRadius });
    }
    return out;
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
        if (this.#tileColliders.has(key)) continue; // visual copy already added (and alive-gated)
        const [cx, cz] = this.tiles.keyToCenter(key);
        src.push({ key, cx, cz, colliders });
      }
    }
    return src;
  }

  /** A building is alive when its visual tile says so; index-only tiles (no one
   *  looking) can't have been demolished, so they're always alive. */
  #bodyIsAlive = (key: string, i: number): boolean =>
    this.#tileColliders.has(key) ? this.tiles.isAlive(key, i) : true;

  #updateBuildingBodies(playerPos: THREE.Vector3) {
    const budget = CONFIG.maxActiveBuildingBodies;
    const anchors = this.#gatherAnchors(playerPos);
    // stream baked OBBs around every anchor so far-off cars have building data
    this.#colliderIndex?.update(anchors);

    // rank every alive building within ANY anchor's radius by min wall distance
    // to any anchor (footprint edge, not centre). Cars anchor themselves, so a
    // facade beside a car 300 m from the player — outside the old player-only
    // 260 m radius — now gets a body instead of being driven straight through.
    const tiles = this.#mergedBodyTiles();
    const kept = selectBodyCandidates(anchors, tiles, budget, this.#bodyIsAlive, this.tiles.manifest.tile);

    // when the budget saturates, everything past the cutoff is fair game to
    // evict — with hysteresis so bodies don't churn at the boundary
    const cutoff = kept.length === budget && budget > 0 ? kept[kept.length - 1].d : Infinity;
    const wanted = new Set<string>();
    for (const cand of kept) wanted.add(`${cand.key}:${cand.c.i}:${cand.c.s}`);

    for (const [handle, info] of this.#buildingBodies) {
      const id = `${info.key}:${info.i}:${info.s}`;
      const c = this.#findCollider(info.key, info.i, info.s);
      // hold = min wall distance to any anchor whose OUTER band still covers it;
      // Infinity once the box has left every anchor's band (old d > rOut test)
      const hold = c ? anchorHold(c, anchors, 1.35) : Infinity;
      if (!c || hold === Infinity || (!wanted.has(id) && hold > cutoff * 1.2 + 10)) {
        this.world.destroyBody(handle);
        this.#buildingBodies.delete(handle);
        this.#bodyByBuilding.delete(id);
      }
    }

    for (const cand of kept) {
      if (this.#buildingBodies.size >= budget) return;
      const { key, c } = cand;
      const id = `${key}:${c.i}:${c.s}`;
      if (this.#bodyByBuilding.has(id)) continue;
      // never materialise a box around an anchor already inside its footprint:
      // some OBBs overhang plazas, and a dynamic body spawned inside a static box
      // gets pinned by the solver. Defer it — the next update creates it once the
      // anchor steps out.
      let insideAny = false;
      for (const a of anchors) {
        if (obbContainsXZ(c, a.x, a.z, 2.5)) {
          insideAny = true;
          break;
        }
      }
      if (insideAny) continue;
      const yaw = c.yaw;
      const handle = this.world.createBox({
        type: BodyType.Static,
        position: [c.x, c.y, c.z],
        halfExtents: [c.hx, c.hy, c.hz],
        friction: 0.7
      });
      this.world.setBodyTransform(handle, [c.x, c.y, c.z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
      this.#buildingBodies.set(handle, { key, i: c.i, s: c.s });
      this.#bodyByBuilding.set(id, handle);
    }
  }

  /** The building's box nearest (x, z) — multi-box buildings pick the wall that was actually hit. */
  #nearestBoxFor(key: string, i: number, x: number, z: number): BuildingCollider | null {
    let best: BuildingCollider | null = null;
    let bd = Infinity;
    for (const c of this.#tileColliders.get(key) ?? []) {
      if (c.i !== i) continue;
      const d = this.#obbPlanarDistance(c, x, z);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
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
   * Nearest vertical building face along (dirX, dirZ) from pos, within maxDist.
   * Returns the outward face normal and the building's rooftop height — the
   * wall-climbing query. Only x/z slabs are tested (you climb walls, not roofs).
   */
  wallAhead(
    pos: THREE.Vector3,
    dirX: number,
    dirZ: number,
    maxDist: number
  ): { dist: number; nx: number; nz: number; top: number } | null {
    let best: { dist: number; nx: number; nz: number; top: number } | null = null;
    for (const [key, colliders] of this.#tileColliders) {
      const [tcx, tcz] = this.tiles.keyToCenter(key);
      if (Math.hypot(tcx - pos.x, tcz - pos.z) > this.tiles.manifest.tile * 0.75 + maxDist + 60) continue;
      for (const c of colliders) {
        // must be beside the wall vertically (not above the roof)
        if (pos.y < c.y - c.hy - 1 || pos.y > c.y + c.hy + 0.5) continue;
        const cdx = c.x - pos.x;
        const cdz = c.z - pos.z;
        const reach = Math.max(c.hx, c.hz) + maxDist + 2;
        if (cdx * cdx + cdz * cdz > reach * reach) continue;
        if (!this.tiles.isAlive(key, c.i)) continue;

        const cos = c.cosYaw;
        const sin = c.sinYaw;
        const ox = (pos.x - c.x) * cos - (pos.z - c.z) * sin;
        const oz = (pos.x - c.x) * sin + (pos.z - c.z) * cos;
        const dx = dirX * cos - dirZ * sin;
        const dz = dirX * sin + dirZ * cos;

        let tmin = 0;
        let tmax = maxDist;
        let axis = -1;
        let sign = 1;
        let miss = false;
        for (const [o, d, h, ax] of [
          [ox, dx, c.hx, 0],
          [oz, dz, c.hz, 1]
        ] as const) {
          if (Math.abs(d) < 1e-9) {
            if (Math.abs(o) > h) {
              miss = true;
              break;
            }
            continue;
          }
          let t0 = (-h - o) / d;
          let t1 = (h - o) / d;
          const s = d > 0 ? -1 : 1; // entering face's outward normal along this axis
          if (t0 > t1) [t0, t1] = [t1, t0];
          if (t0 > tmin) {
            tmin = t0;
            axis = ax;
            sign = s;
          }
          tmax = Math.min(tmax, t1);
          if (tmin > tmax) {
            miss = true;
            break;
          }
        }
        if (miss || axis === -1 || tmin > maxDist) continue;
        if (!best || tmin < best.dist) {
          const lnx = axis === 0 ? sign : 0;
          const lnz = axis === 1 ? sign : 0;
          // local → world: rotate by +yaw (inverse of the world→local above)
          best = { dist: tmin, nx: lnx * cos + lnz * sin, nz: -lnx * sin + lnz * cos, top: c.y + c.hy };
        }
      }
    }
    return best;
  }

  /**
   * Earliest intersection of the segment p0→p1 with any alive building OBB
   * (slab test in each box's yaw frame). Returns the world-space hit point.
   */
  sweepBuildings(p0: [number, number, number], p1: ArrayLike<number>): THREE.Vector3 | null {
    const dxs = p1[0] - p0[0];
    const dys = p1[1] - p0[1];
    const dzs = p1[2] - p0[2];
    const segLen = Math.hypot(dxs, dzs);
    const midX = (p0[0] + p1[0]) / 2;
    const midZ = (p0[2] + p1[2]) / 2;

    // visual tiles (alive-gated) raced against index-only tiles (buildings in
    // regions no one is looking at, so nothing there can be demolished) — the
    // latter is why an AI car far from the player still stops at walls.
    let bestT = this.#sweepTiles(this.#tileColliders, true, p0, dxs, dys, dzs, segLen, midX, midZ, Infinity);
    const idx = this.#colliderIndex;
    if (idx) bestT = this.#sweepTiles(idx.tiles, false, p0, dxs, dys, dzs, segLen, midX, midZ, bestT);
    if (bestT === Infinity) return null;
    return new THREE.Vector3(p0[0] + dxs * bestT, p0[1] + dys * bestT, p0[2] + dzs * bestT);
  }

  /** Slab-sweep p0→(p0+d) against one map of tiles, returning the earliest tmin
   *  (≤ prevBest). `gate` alive-gates through the visual tile stream; index-only
   *  tiles pass everything (a building no one can see can't be demolished). */
  #sweepTiles(
    tiles: ReadonlyMap<string, BuildingCollider[]>,
    gate: boolean,
    p0: [number, number, number],
    dxs: number,
    dys: number,
    dzs: number,
    segLen: number,
    midX: number,
    midZ: number,
    prevBest: number
  ): number {
    let bestT = prevBest;
    const tileCull = this.tiles.manifest.tile * 0.75 + segLen + 120;
    for (const [key, colliders] of tiles) {
      if (!gate && this.#tileColliders.has(key)) continue; // visual copy already swept
      const [tcx, tcz] = this.tiles.keyToCenter(key);
      if (Math.hypot(tcx - midX, tcz - midZ) > tileCull) continue;
      for (const c of colliders) {
        const cdx = c.x - midX;
        const cdz = c.z - midZ;
        const reach = c.hx + c.hz + segLen;
        if (cdx * cdx + cdz * cdz > reach * reach) continue;
        if (gate && !this.tiles.isAlive(key, c.i)) continue;

        // segment into the box's local (yaw-aligned) frame: R_y(-yaw) * offset
        const cos = c.cosYaw;
        const sin = c.sinYaw;
        const ox = (p0[0] - c.x) * cos - (p0[2] - c.z) * sin;
        const oz = (p0[0] - c.x) * sin + (p0[2] - c.z) * cos;
        const oy = p0[1] - c.y;
        const dx = dxs * cos - dzs * sin;
        const dz = dxs * sin + dzs * cos;
        const dy = dys;

        let tmin = 0;
        let tmax = 1;
        let miss = false;
        for (const [o, d, h] of [
          [ox, dx, c.hx],
          [oy, dy, c.hy],
          [oz, dz, c.hz]
        ] as const) {
          if (Math.abs(d) < 1e-9) {
            if (Math.abs(o) > h) {
              miss = true;
              break;
            }
            continue;
          }
          let t0 = (-h - o) / d;
          let t1 = (h - o) / d;
          if (t0 > t1) [t0, t1] = [t1, t0];
          tmin = Math.max(tmin, t0);
          tmax = Math.min(tmax, t1);
          if (tmin > tmax) {
            miss = true;
            break;
          }
        }
        if (!miss && tmin < bestT) bestT = tmin;
      }
    }
    return bestT;
  }

  /**
   * Nearest world surface along a ray: static SOLIDS (buildings + bridge +
   * landmarks) via one broadphase-accelerated cast over the never-stepped
   * #solids world, raced against the analytic terrain heightfield. Returns the
   * world hit point, outward surface normal, and what was struck. `kind: "water"`
   * means the ray landed on open bay rather than land. The bridge is a real solid
   * here (deck + rails + underside), so it is hit at any angle — not a top plane.
   */
  raycastWorld(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number
  ): { point: THREE.Vector3; normal: THREE.Vector3; kind: "building" | "ground" | "water" } | null {
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

    // --- terrain: coarse march + bisection refine on the sign flip. Uses the raw
    // heightfield, NOT effectiveGround — the bridge deck is a solid above (cast
    // separately), so it must not also appear here as a phantom plane.
    let groundT = Infinity;
    if (dir.y < 0.35) {
      // rays angled well upward can't land on the heightfield
      const step = 3;
      let prevT = 0;
      let prevAbove = origin.y - this.map.groundHeight(origin.x, origin.z) > 0;
      const limit = Math.min(maxDist, bestT);
      for (let t = step; t <= limit + step; t += step) {
        const tt = Math.min(t, limit);
        const x = origin.x + dir.x * tt;
        const z = origin.z + dir.z * tt;
        const above = origin.y + dir.y * tt - this.map.groundHeight(x, z) > 0;
        if (prevAbove && !above) {
          let lo = prevT;
          let hi = tt;
          for (let i = 0; i < 8; i++) {
            const m = (lo + hi) / 2;
            const my = origin.y + dir.y * m;
            if (my - this.map.groundHeight(origin.x + dir.x * m, origin.z + dir.z * m) > 0) lo = m;
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
      return { point, normal, kind };
    }
    const point = new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    return { point, normal: new THREE.Vector3(...bestN!), kind: "building" };
  }

  // ------------------------------------------------- world-solid query bodies

  /** Create one static box in the #solids query world; yaw via SetTransform
   * (which also seeds the broadphase AABB). Returns its handle. */
  #makeSolid(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number): number {
    const h = this.#solids.createBox({ type: BodyType.Static, position: [x, y, z], halfExtents: [hx, hy, hz] });
    if (yaw) this.#solids.setBodyTransform(h, [x, y, z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    return h;
  }

  /** Mirror a freshly streamed tile's ALIVE building colliders into #solids.
   * Landmark boxes (i beyond the OSM building count) are skipped — they are
   * always-resident (loaded once at boot), so the stream must not double them. */
  #addTileSolids(key: string, colliders: BuildingCollider[]): void {
    const nB = this.tiles.manifest.tiles[key]?.b ?? 0;
    const owned: string[] = [];
    for (const c of colliders) {
      if (c.i >= nB) continue; // landmark — boot-resident
      if (!this.tiles.isAlive(key, c.i)) continue; // suppressed / dead at load
      const bk = `${key}:${c.i}`;
      let arr = this.#solidByBuilding.get(bk);
      if (!arr) {
        arr = [];
        this.#solidByBuilding.set(bk, arr);
        owned.push(bk);
      }
      arr.push(this.#makeSolid(c.x, c.y, c.z, c.hx, c.hy, c.hz, c.yaw));
    }
    if (owned.length) this.#solidTileIndex.set(key, owned);
  }

  /** Drop every building solid a tile owns when it unloads. */
  #removeTileSolids(key: string): void {
    const owned = this.#solidTileIndex.get(key);
    if (!owned) return;
    for (const bk of owned) {
      const arr = this.#solidByBuilding.get(bk);
      if (arr) for (const h of arr) this.#solids.destroyBody(h);
      this.#solidByBuilding.delete(bk);
    }
    this.#solidTileIndex.delete(key);
  }

  /** Add/drop a single building's solid when its alive state flips at runtime
   * (full suppress, revive, or fracture). Keeps #solids in step with the visual
   * alive flags the old per-ray isAlive test used to consult. */
  #setBuildingSolidAlive(key: string, i: number, alive: boolean): void {
    const bk = `${key}:${i}`;
    const arr = this.#solidByBuilding.get(bk);
    if (alive) {
      if (arr && arr.length) return; // already present
      const cols = this.#tileColliders.get(key);
      if (!cols) return;
      const fresh: number[] = [];
      for (const c of cols) if (c.i === i) fresh.push(this.#makeSolid(c.x, c.y, c.z, c.hx, c.hy, c.hz, c.yaw));
      if (fresh.length) {
        this.#solidByBuilding.set(bk, fresh);
        const owned = this.#solidTileIndex.get(key) ?? [];
        if (!owned.includes(bk)) {
          owned.push(bk);
          this.#solidTileIndex.set(key, owned);
        }
      }
    } else if (arr) {
      for (const h of arr) this.#solids.destroyBody(h);
      this.#solidByBuilding.set(bk, []); // keep the entry so the tile index still owns it
    }
  }

  /** true distance from a point to the OBB surface, in the box's yaw frame (0 inside) */
  #obbDistance(c: BuildingCollider, p: THREE.Vector3): number {
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const cos = c.cosYaw;
    const sin = c.sinYaw;
    const ex = Math.max(0, Math.abs(dx * cos - dz * sin) - c.hx);
    const ez = Math.max(0, Math.abs(dx * sin + dz * cos) - c.hz);
    const ey = Math.max(0, Math.abs(p.y - c.y) - c.hy);
    return Math.sqrt(ex * ex + ez * ez + ey * ey);
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

  // ------------------------------------------------------------- destruction

  #handleHit(ev: ContactHitEvent) {
    const point = new THREE.Vector3(...ev.point);

    // projectile impact -> detonate
    const prIndex = this.projectiles.findIndex((p) => p.handle === ev.bodyA || p.handle === ev.bodyB);
    if (prIndex >= 0) {
      const pr = this.projectiles[prIndex];
      const v = this.world.getBodyVelocity(pr.handle).linear;
      this.projectiles.splice(prIndex, 1);
      this.world.destroyBody(pr.handle);
      this.detonateProjectile(point, new THREE.Vector3(v[0], v[1], v[2]));
      return;
    }

    const aBuilding = this.#buildingBodies.get(ev.bodyA);
    const bBuilding = this.#buildingBodies.get(ev.bodyB);
    const aVehicle = this.#vehicleHandles.has(ev.bodyA);
    const bVehicle = this.#vehicleHandles.has(ev.bodyB);

    const building = aBuilding ?? bBuilding;
    const vehicleInvolved = aVehicle || bVehicle;

    if (building && vehicleInvolved && ev.approachSpeed > CONFIG.chipSpeed) {
      const vehicleHandle = aVehicle ? ev.bodyA : ev.bodyB;
      const vel = this.world.getBodyVelocity(vehicleHandle);
      const v = new THREE.Vector3(...vel.linear);
      // energy driven into the wall, in kJ — approach speed (not full velocity)
      // so a high-speed scrape along a facade stays cosmetic
      const mass = this.world.getBodyMass(vehicleHandle);
      const energy = (0.5 * mass * ev.approachSpeed * ev.approachSpeed) / 1000;

      if (energy > CONFIG.crashBoomEnergy) {
        // a crash this hard reads as a bomb: detonate and let the blast decide
        this.explode(point);
        return;
      }

      // below chipEnergy the wall doesn't even scuff — a body or hoverboard
      // slamming a facade bounces off clean, only vehicle-mass hits leave marks
      if (energy > CONFIG.chipEnergy) {
        // survivable crash: gouge chips out of the facade at the impact point
        this.chipBuilding(building.key, building.i, point, v, energy);

        // structural damage: taps below the floor stay cosmetic forever, heavy
        // rams wear a building down until it gives (sheds go fast, towers never)
        const structural = energy - CONFIG.damageFloor;
        if (structural > 0) {
          const collider = this.#tileColliders.get(building.key)?.find((c) => c.i === building.i);
          if (collider) {
            const id = `${building.key}:${building.i}`;
            const damage = (this.#damage.get(id) ?? 0) + structural;
            const hp = CONFIG.buildingHpBase + collider.vol * CONFIG.buildingHpPerM3;
            if (damage > hp) {
              this.fractureBuilding(building.key, building.i, point, v.multiplyScalar(0.6));
            } else {
              this.#damage.set(id, damage);
            }
          }
        }
      }
      if (ev.approachSpeed > 9) this.onHardImpact(point, ev.approachSpeed);
    } else if (vehicleInvolved && ev.approachSpeed > 9) {
      this.onHardImpact(point, ev.approachSpeed);
    }
  }

  /**
   * Knock a few chunks out of the facade where a crash landed, leaving the
   * building itself standing — a drone strike leaves a scar, not a crater.
   */
  chipBuilding(key: string, index: number, at: THREE.Vector3, impactVel: THREE.Vector3, energy: number, sizeScale = 1) {
    if (!this.tiles.isAlive(key, index)) return;
    const c = this.#nearestBoxFor(key, index, at.x, at.z);
    if (!c) return;

    const base = c.y - c.hy;
    const color = buildingTone(index, c.p);

    // outward normal of the face that was hit, from the impact point's dominant
    // axis in the building's yaw frame (roof hits eject upward instead)
    const cos = c.cosYaw;
    const sin = c.sinYaw;
    const lx = (at.x - c.x) * cos - (at.z - c.z) * sin;
    const lz = (at.x - c.x) * sin + (at.z - c.z) * cos;
    let nx: number;
    let nz: number;
    if (Math.abs(lx) / c.hx > Math.abs(lz) / c.hz) {
      const s = Math.sign(lx) || 1;
      nx = s * cos;
      nz = -s * sin;
    } else {
      const s = Math.sign(lz) || 1;
      nx = s * sin;
      nz = s * cos;
    }
    const roofHit = at.y > c.y + c.hy - 0.6;

    const pieces = Math.min(2 + Math.floor(Math.min(6, energy / 20)), CONFIG.maxDebris - this.debris.length);
    for (let i = 0; i < pieces; i++) {
      // fist-to-cinderblock sized shards, biased small (projectile bursts
      // scale them up into proper wall chunks)
      const jx = (0.16 + Math.random() * 0.34) * sizeScale;
      const jy = (0.14 + Math.random() * 0.3) * sizeScale;
      const jz = (0.16 + Math.random() * 0.34) * sizeScale;
      const px = at.x + nx * 0.45 + (Math.random() - 0.5) * 1.4;
      const py = Math.max(base + jy, at.y + (roofHit ? 0.4 : (Math.random() - 0.5) * 1.2));
      const pz = at.z + nz * 0.45 + (Math.random() - 0.5) * 1.4;
      const bodyHandle = this.world.createBox({
        type: BodyType.Dynamic,
        position: [px, py, pz],
        halfExtents: [jx, jy, jz],
        density: 0.32,
        friction: 0.62,
        restitution: 0.12
      });
      // shards spray off the wall and back toward the impactor
      const kick = 2.2 + Math.random() * 3.2;
      this.world.setBodyVelocity(
        bodyHandle,
        [
          nx * kick - impactVel.x * 0.12 + (Math.random() - 0.5) * 2,
          (roofHit ? 3 : 1.2) + Math.random() * 1.8,
          nz * kick - impactVel.z * 0.12 + (Math.random() - 0.5) * 2
        ],
        [(Math.random() - 0.5) * 7, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 7]
      );

      const shade = 0.8 + Math.random() * 0.24;
      this.debris.push({
        handle: bodyHandle,
        hx: jx,
        hy: jy,
        hz: jz,
        color: color.clone().multiplyScalar(shade),
        baseY: base,
        bid: index,
        sx: px,
        sy: py,
        sz: pz,
        yaw: c.yaw,
        age: 0,
        seed: Math.random()
      });
    }
    if (pieces > 0) this.debrisDirty = true;
  }

  fractureBuilding(key: string, index: number, at?: THREE.Vector3, push?: THREE.Vector3) {
    const collider = this.tiles.killBuilding(key, index);
    if (!collider) return;

    // remove every static box of the building if active (concave footprints
    // materialise as several bodies sharing this key:i)
    this.#damage.delete(`${key}:${index}`);
    for (const [handle, info] of this.#buildingBodies) {
      if (info.key === key && info.i === index) {
        this.world.destroyBody(handle);
        this.#buildingBodies.delete(handle);
        this.#bodyByBuilding.delete(`${info.key}:${info.i}:${info.s}`);
      }
    }

    const c = collider;
    const base = c.y - c.hy;
    const fullH = c.hy * 2;
    // the exact masonry tone the facade shader gave this building, so chunks match
    const color = buildingTone(index, c.p);

    // chunk grid scales with the building (capped so one tower can't eat the budget)
    let floors = Math.max(2, Math.min(8, Math.round(fullH / 4.5)));
    let splitX = Math.max(1, Math.min(3, Math.round(c.hx / 4)));
    let splitZ = Math.max(1, Math.min(3, Math.round(c.hz / 4)));
    while (floors * splitX * splitZ > 48) {
      if (floors > 3) floors--;
      else if (splitX >= splitZ && splitX > 1) splitX--;
      else if (splitZ > 1) splitZ--;
      else break;
    }
    const cos = c.cosYaw;
    const sin = c.sinYaw;
    const pieceH = fullH / floors;
    const phx = c.hx / splitX;
    const phz = c.hz / splitZ;
    const pushLen = push ? push.length() : 0;

    // a static slab under the site so rubble far from the player still lands
    const floorHandle = this.world.createBox({
      type: BodyType.Static,
      position: [c.x, base - 1.5, c.z],
      halfExtents: [c.hx + 14, 1.5, c.hz + 14],
      friction: 0.8
    });
    this.world.setBodyTransform(floorHandle, [c.x, base - 1.5, c.z], [0, Math.sin(c.yaw / 2), 0, Math.cos(c.yaw / 2)]);
    this.#rubbleFloors.push({ handle: floorHandle, age: 0 });

    for (let f = 0; f < floors; f++) {
      for (let ix = 0; ix < splitX; ix++) {
        for (let iz = 0; iz < splitZ; iz++) {
          if (this.debris.length >= CONFIG.maxDebris) break;
          const lu = -c.hx + phx * (2 * ix + 1);
          const lv = -c.hz + phz * (2 * iz + 1);
          const wx = c.x + lu * cos - lv * sin;
          const wz = c.z + lu * sin + lv * cos;
          const wy = base + pieceH * (f + 0.5);
          // irregular piece sizes so the pile can't restack into a tidy tower
          const jx = phx * (0.68 + Math.random() * 0.3);
          const jy = pieceH * (0.34 + Math.random() * 0.16);
          const jz = phz * (0.68 + Math.random() * 0.3);
          const bodyHandle = this.world.createBox({
            type: BodyType.Dynamic,
            position: [wx, wy, wz],
            halfExtents: [jx, jy, jz],
            density: 0.32,
            friction: 0.62,
            restitution: 0.04
          });
          this.world.setBodyTransform(bodyHandle, [wx, wy, wz], [0, Math.sin(c.yaw / 2), 0, Math.cos(c.yaw / 2)]);

          // collapse read: lower floors kick outward hard (the base blows out),
          // upper floors drop into them with the shove, everything tumbling
          const lever = (f + 0.5) / floors;
          const rx = wx - c.x;
          const rz = wz - c.z;
          const rl = Math.hypot(rx, rz) || 1;
          const scatter = (1.2 + Math.random() * 2.2) * (1.3 - lever * 0.6);
          const vx = (push ? push.x * lever * 0.6 : 0) + (rx / rl) * scatter + (Math.random() - 0.5) * 1.8;
          const vz = (push ? push.z * lever * 0.6 : 0) + (rz / rl) * scatter + (Math.random() - 0.5) * 1.8;
          const vy = pushLen * 0.06 * lever + Math.random() * 0.8 - f * 0.25; // upper floors start dropping into the ones below
          this.world.setBodyVelocity(
            bodyHandle,
            [vx, vy, vz],
            [(Math.random() - 0.5) * 4.5, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4.5]
          );

          const shade = 0.86 + Math.random() * 0.22;
          this.debris.push({
            handle: bodyHandle,
            hx: jx,
            hy: jy,
            hz: jz,
            color: color.clone().multiplyScalar(shade),
            baseY: base,
            bid: index,
            sx: wx,
            sy: wy,
            sz: wz,
            yaw: c.yaw,
            age: 0,
            seed: Math.random()
          });
        }
      }
    }
    this.debrisDirty = true;
    this.onFracture(at ?? new THREE.Vector3(c.x, base, c.z), c.vol, fullH);
  }

  /**
   * Projectile burst: full blast impulse and fireball, but the damage stays
   * cosmetic — the facade it hit loses a chunk, nothing collapses. Whole-
   * building demolition is reserved for heavier ordnance than a tracer.
   */
  detonateProjectile(pos: THREE.Vector3, vel: THREE.Vector3) {
    const radius = CONFIG.explosionRadius;
    this.world.explode([pos.x, pos.y, pos.z], radius, radius * 0.6, CONFIG.explosionImpulse);

    // gouge the nearest facade caught in the blast (direct hits and near misses)
    let best: { key: string; i: number; d: number } | null = null;
    const reach = radius * 0.5;
    for (const [key, colliders] of this.#tileColliders) {
      const [tcx, tcz] = this.tiles.keyToCenter(key);
      if (Math.hypot(tcx - pos.x, tcz - pos.z) > reach + this.tiles.manifest.tile) continue;
      for (const c of colliders) {
        if (!this.tiles.isAlive(key, c.i)) continue;
        const d = this.#obbDistance(c, pos);
        if (d < reach && (!best || d < best.d)) best = { key, i: c.i, d };
      }
    }
    if (best) this.chipBuilding(best.key, best.i, pos, vel, CONFIG.projectileChip, 1.9);
    this.onExplosion(pos, radius);
  }

  explode(pos: THREE.Vector3, radius = CONFIG.explosionRadius) {
    this.world.explode([pos.x, pos.y, pos.z], radius, radius * 0.6, CONFIG.explosionImpulse);

    // fracture buildings caught in the blast
    const hits: { key: string; i: number; d: number; c: BuildingCollider }[] = [];
    for (const [key, colliders] of this.#tileColliders) {
      const [tcx, tcz] = this.tiles.keyToCenter(key);
      if (Math.hypot(tcx - pos.x, tcz - pos.z) > radius + this.tiles.manifest.tile) continue;
      for (const c of colliders) {
        if (!this.tiles.isAlive(key, c.i)) continue;
        const d = this.#obbDistance(c, pos);
        if (d < radius) hits.push({ key, i: c.i, d, c });
      }
    }
    hits.sort((a, b) => a.d - b.d);
    for (const h of hits.slice(0, 6)) {
      const dir = new THREE.Vector3(h.c.x - pos.x, 2, h.c.z - pos.z).normalize().multiplyScalar(14);
      this.fractureBuilding(h.key, h.i, pos, dir);
    }
    this.onExplosion(pos, radius);
  }

  fireProjectile(origin: THREE.Vector3, dir: THREE.Vector3, inheritVel?: THREE.Vector3): Projectile {
    const handle = this.world.createSphere({
      type: BodyType.Dynamic,
      position: [origin.x, origin.y, origin.z],
      radius: CONFIG.projectileRadius,
      density: 7,
      friction: 0.4,
      restitution: 0.1,
      bullet: true
    });
    this.world.setBodyGravityScale(handle, 0.32);
    const v = dir.clone().normalize().multiplyScalar(CONFIG.projectileSpeed);
    // shots fired from a moving craft carry its momentum, so they track where
    // you're flying instead of falling behind the dive
    if (inheritVel) v.addScaledVector(inheritVel, 0.9);
    this.world.setBodyVelocity(handle, [v.x, v.y, v.z]);
    this.world.setBodyHitEvents(handle, true);
    const projectile: Projectile = { handle, age: 0, seed: Math.random(), prev: [origin.x, origin.y, origin.z] };
    this.projectiles.push(projectile);
    return projectile;
  }
}
