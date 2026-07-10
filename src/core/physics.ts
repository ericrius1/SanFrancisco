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
import type { WorldMap } from "../world/heightmap";
import type { BuildingCollider, TileStreamer } from "../world/tiles";
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
  // frame from step() instead of all at once on the recenter frame
  #refineQueue: { wx: number; wz: number; d: number }[] = [];
  #refineSub = 0;
  #refineSub2 = 0;
  #carpetCX = NaN;
  #carpetCZ = NaN;

  // one entry per materialised BOX — concave buildings bake to several boxes
  // sharing an `i` (tiles.ts patches in the sub-ordinal `s`), so bodies key by
  // "key:i:s" while alive state stays per-building on "key:i"
  #buildingBodies = new Map<number, { key: string; i: number; s: number }>();
  #bodyByBuilding = new Map<string, number>(); // "key:i:s" -> handle
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
  // CityGen exact-poly wall + interior boxes are created on the STEPPED world
  // (world/citygen/stream/ring.ts), so they're invisible to #solids — the query
  // world every raycast (paint, world cursor, aim reticle) consults via
  // raycastWorld. The ring mirrors each of its boxes here through addQuerySolid,
  // keyed by the stepped-body handle, so a ray strikes citygen geometry exactly
  // where the baked twin has been suppressed.
  #querySolids = new Map<number, number>(); // caller id (stepped handle) -> #solids handle
  // baked OBBs streamed around the player collider anchor, decoupled from the
  // visual tile stream (see buildingColliderIndex.ts). Null until create()
  // finishes loading the manifest.
  #colliderIndex: BuildingColliderIndex | null = null;
  #anchorList: ColliderAnchor[] = []; // reused per body update — no per-tick alloc
  #bodyTiles: BodyTileSource<BuildingCollider>[] = []; // reused merged tile source
  #tick = 0;

  private constructor(map: WorldMap, tiles: TileStreamer) {
    this.map = map;
    this.tiles = tiles;
  }

  static async create(map: WorldMap, tiles: TileStreamer): Promise<Physics> {
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
    };
    // runtime solid add/drop on full suppress or revive (mesh-only suppression
    // keeps the collider, so tiles never fires it for that)
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

  step(dt: number, playerPos: THREE.Vector3) {
    this.#tick++;
    this.#updateCarpet(playerPos);
    this.#drainRefine();
    if (this.#tick % 12 === 0) this.#updateBuildingBodies(playerPos);

    // 2 solver substeps: every mover here is velocity-driven (cars, player,
    // boat springs), so the solver only reconciles contacts — 4 substeps was
    // a 240 Hz solver nobody could see, at double the wasm cost. A crash into a
    // wall/vehicle is resolved entirely by the contact solver — it just stops
    // you; there are no crash effects, projectiles, or building damage.
    this.world.step(dt, 2);
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

  /** Player collider anchor (#0, full radius). Reused array — no per-tick alloc. */
  #gatherAnchors(playerPos: THREE.Vector3): ColliderAnchor[] {
    const out = this.#anchorList;
    out.length = 0;
    out.push({ x: playerPos.x, z: playerPos.z, r: CONFIG.colliderRadius });
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
   *  looking) can't have been suppressed, so they're always alive. */
  #bodyIsAlive = (key: string, i: number): boolean =>
    this.#tileColliders.has(key) ? this.tiles.isAlive(key, i) : true;

  #updateBuildingBodies(playerPos: THREE.Vector3) {
    const budget = CONFIG.maxActiveBuildingBodies;
    const anchors = this.#gatherAnchors(playerPos);
    // stream baked OBBs around the player anchor so nearby buildings have data
    this.#colliderIndex?.update(anchors);

    // rank every alive building within the anchor's radius by min wall distance
    // (footprint edge, not centre) so the closest facades get a static body.
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
      // A building the CityGen ring suppressed (alive→0) drops out of selectBody-
      // Candidates so it's never re-`wanted`, but distance-only eviction keeps its
      // ALREADY-materialised stepped body alive while the player stays close — the
      // loose baked box (~1–1.6 m proud of the exact-poly LOD wall the ring swapped
      // in) then blocks the walker with nothing visible there (a PHANTOM; the query
      // twin was already dropped via onBuildingAlive → ray-blind mirror). Evict on
      // death, not just distance, so the baked body is gone the instant the exact
      // walls take over and returns when the ring retires them (alive→1/255).
      if (!c || hold === Infinity || !this.#bodyIsAlive(info.key, info.i) || (!wanted.has(id) && hold > cutoff * 1.2 + 10)) {
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
      return { point, normal, kind };
    }
    const point = new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    return { point, normal: new THREE.Vector3(...bestN!), kind: "building" };
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
   * (full suppress or revive). Keeps #solids in step with the visual
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
    if (existing !== undefined) this.#solids.destroyBody(existing);
    this.#querySolids.set(id, this.#makeSolid(box.x, box.y, box.z, box.hx, box.hy, box.hz, box.yaw ?? 0, box.quat));
  }

  /** Drop a previously registered extra query solid (no-op if the id is unknown). */
  removeQuerySolid(id: number): void {
    const h = this.#querySolids.get(id);
    if (h === undefined) return;
    this.#solids.destroyBody(h);
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
