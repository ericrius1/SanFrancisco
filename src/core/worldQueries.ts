import * as THREE from "three/webgpu";
import { BodyType, type PhysicsWorld, type RayCastHit } from "./box3dWorld";
import type { Physics } from "./physics";

/**
 * The decoupled world-query service. One place every system asks "what does this
 * ray hit in the world?" — paint, the in-world cursor, and anything later (AI
 * perception, click-to-select, explosions). Nothing owns the entity hit-test but
 * this module.
 *
 * Backing store: a dedicated box3d **query world** (a second PhysicsWorld in the
 * same box3d module, never stepped). Every raycastable entity gets one kinematic
 * proxy shape (box/sphere/capsule) that we move each frame; queries run through
 * box3d's own broadphase-accelerated `castRayClosest` ("Cast Ray"). Moving a
 * proxy updates its broadphase AABB immediately, so the un-stepped world still
 * answers correctly. Static world (buildings/terrain/water) stays in the proven
 * hand-rolled `physics.raycastWorld` and is *raced* here — so one `raycast()`
 * covers everything the caller could point at.
 *
 * Grass/flowers are deliberately never registered.
 */

export type EntityKind =
  | "vehicle"
  | "mount"
  | "avatar"
  | "player"
  | "creature"
  | "tree"
  | "prop"
  | "building"
  | "terrain"
  | "water";

/** One closest hit from `raycast`. Reused instance — copy what you need before
 * the next query. `entityId` is -1 for static-world hits; `object` is the real
 * mesh for entity hits (precise splat / selection), null for world/proxy hits. */
export type QueryHit = {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  kind: EntityKind;
  entityId: number;
  object: THREE.Object3D | null;
};

export type ProxyShape =
  | { form: "box"; hx: number; hy: number; hz: number }
  | { form: "sphere"; radius: number }
  | { form: "capsule"; halfHeight: number; radius: number };

export type ProxySpec = {
  /** Stable entity id (net id, or a synthetic id assigned by the caller). */
  id: number;
  kind: EntityKind;
  shape: ProxyShape;
  /** Real mesh — returned on a hit for precise splat placement / selection. */
  object?: THREE.Object3D;
  /** The local player's own body: the cursor skips it, paint still lets remote
   * shots land on it. */
  self?: boolean;
  /** Initial world position (defaults to origin; moveProxy sets it each frame). */
  position?: [number, number, number];
};

export type RaycastOpts = {
  /** Skip the local player's own proxy (cursor). */
  ignoreSelf?: boolean;
  /** Skip a specific entity id — the paintball's own shooter. */
  ignoreId?: number;
};

// Query category bits: bit0 = ordinary world entity, bit1 = the local self
// proxy. Casts pick a mask to include/exclude self without touching the entity
// list (see MASK_* below).
const CAT_ENTITY = 1n;
const CAT_SELF = 2n;
const MASK_ALL = CAT_ENTITY | CAT_SELF; // paint: a remote ball may hit me
const MASK_NO_SELF = CAT_ENTITY; // cursor: never rest on my own body

type ProxyRecord = { id: number; kind: EntityKind; object: THREE.Object3D | null };

export class WorldQueries {
  #physics: Physics;
  #q: PhysicsWorld; // dedicated query world — created here, never stepped
  #records = new Map<number, ProxyRecord>(); // body handle -> entity record

  // reused scratch so hot loops (paintballs) allocate nothing
  #hit: QueryHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    kind: "terrain",
    entityId: -1,
    object: null
  };
  #ray: RayCastHit = { handle: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, distance: 0 };

  constructor(physics: Physics) {
    this.#physics = physics;
    this.#q = physics.box3d.createWorld([0, 0, 0]); // no gravity; never stepped
  }

  // -- proxy lifecycle ------------------------------------------------------

  /** Add a raycastable proxy; returns a handle used by moveProxy/removeProxy. */
  addProxy(spec: ProxySpec): number {
    const cat = spec.self ? CAT_SELF : CAT_ENTITY;
    const pos = spec.position ?? [0, 0, 0];
    const s = spec.shape;
    let handle: number;
    if (s.form === "box") {
      handle = this.#q.createBox({
        type: BodyType.Kinematic,
        position: pos,
        halfExtents: [s.hx, s.hy, s.hz],
        categoryBits: cat
      });
    } else if (s.form === "sphere") {
      handle = this.#q.createSphere({
        type: BodyType.Kinematic,
        position: pos,
        radius: s.radius,
        categoryBits: cat
      });
    } else {
      handle = this.#q.createCapsule({
        type: BodyType.Kinematic,
        position: pos,
        halfHeight: s.halfHeight,
        radius: s.radius,
        categoryBits: cat
      });
    }
    this.#records.set(handle, { id: spec.id, kind: spec.kind, object: spec.object ?? null });
    return handle;
  }

  moveProxy(handle: number, px: number, py: number, pz: number, qx = 0, qy = 0, qz = 0, qw = 1): void {
    this.#q.setBodyTransform(handle, [px, py, pz], [qx, qy, qz, qw]);
  }

  removeProxy(handle: number): void {
    this.#q.destroyBody(handle);
    this.#records.delete(handle);
  }

  // -- queries --------------------------------------------------------------

  /**
   * Closest hit along the unit `dir` for up to `maxDist`, racing the entity
   * proxy world against the static world (buildings/terrain/water). Returns a
   * reused QueryHit (copy before the next call) or null.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, opts?: RaycastOpts): QueryHit | null {
    let best = Infinity;
    let found = false;
    const hit = this.#hit;

    // 1) entities via box3d broadphase cast (skipping self / the shooter)
    const eHit = this.#castEntity(origin, dir, maxDist, opts);
    if (eHit) {
      const rec = this.#records.get(eHit.handle);
      if (rec) {
        best = eHit.distance;
        found = true;
        hit.point.set(eHit.px, eHit.py, eHit.pz);
        hit.normal.set(eHit.nx, eHit.ny, eHit.nz);
        hit.distance = eHit.distance;
        hit.kind = rec.kind;
        hit.entityId = rec.id;
        hit.object = rec.object;
      }
    }

    // 2) static world: buildings + terrain + water (proven hand-rolled caster)
    const wHit = this.#physics.raycastWorld(origin, dir, maxDist);
    if (wHit) {
      const t = origin.distanceTo(wHit.point);
      if (t < best) {
        best = t;
        found = true;
        hit.point.copy(wHit.point);
        hit.normal.copy(wHit.normal);
        hit.distance = t;
        hit.kind = wHit.kind === "water" ? "water" : wHit.kind === "building" ? "building" : "terrain";
        hit.entityId = -1;
        hit.object = null;
      }
    }

    return found ? hit : null;
  }

  /** Entity-only closest cast, transparently skipping self and/or a given id by
   * advancing the origin past an ignored proxy and re-casting (bounded). */
  #castEntity(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, opts?: RaycastOpts): RayCastHit | null {
    const mask = opts?.ignoreSelf ? MASK_NO_SELF : MASK_ALL;
    const ignoreId = opts?.ignoreId;
    let advance = 0;
    for (let i = 0; i < 3; i++) {
      const h = this.#q.castRayClosest(
        origin.x + dir.x * advance,
        origin.y + dir.y * advance,
        origin.z + dir.z * advance,
        dir.x,
        dir.y,
        dir.z,
        maxDist - advance,
        mask,
        this.#ray
      );
      if (!h) return null;
      const rec = this.#records.get(h.handle);
      if (ignoreId == null || !rec || rec.id !== ignoreId) {
        h.distance += advance;
        return h;
      }
      // struck the entity we were told to ignore — step just past it and retry
      advance += h.distance + 0.02;
      if (advance >= maxDist) return null;
    }
    return null;
  }

  dispose(): void {
    this.#q.dispose();
    this.#records.clear();
  }
}

/**
 * A keyed set of proxies kept in sync with a live entity list each frame:
 * create on first sight, move while present, remove when a key stops appearing.
 * `begin()` → one `put(...)` per live entity → `end()`. A shape-signature change
 * (e.g. an avatar switching vehicle) recreates that proxy at the new size.
 */
export class ProxySet {
  #q: WorldQueries;
  #live = new Map<unknown, { handle: number; sig: string }>();
  #seen = new Set<unknown>();

  constructor(q: WorldQueries) {
    this.#q = q;
  }

  begin(): void {
    this.#seen.clear();
  }

  put(
    key: unknown,
    spec: Omit<ProxySpec, "position">,
    px: number,
    py: number,
    pz: number,
    qx = 0,
    qy = 0,
    qz = 0,
    qw = 1
  ): void {
    this.#seen.add(key);
    const s = spec.shape;
    const sig =
      spec.kind +
      (spec.self ? "!" : "") +
      (s.form === "box" ? `b${s.hx},${s.hy},${s.hz}` : s.form === "sphere" ? `s${s.radius}` : `c${s.halfHeight},${s.radius}`);
    let e = this.#live.get(key);
    if (!e || e.sig !== sig) {
      if (e) this.#q.removeProxy(e.handle);
      e = { handle: this.#q.addProxy({ ...spec, position: [px, py, pz] }), sig };
      this.#live.set(key, e);
    }
    this.#q.moveProxy(e.handle, px, py, pz, qx, qy, qz, qw);
  }

  end(): void {
    for (const [key, e] of this.#live) {
      if (!this.#seen.has(key)) {
        this.#q.removeProxy(e.handle);
        this.#live.delete(key);
      }
    }
  }
}
