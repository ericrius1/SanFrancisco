import * as THREE from "three/webgpu";
import type { GroundTopOverlay, WorldMap } from "../heightmap";
import { registerGrindRails, unregisterGrindRails, type GrindRail } from "../../vehicles/skate";
import {
  BOWL,
  carveDepth,
  DECK,
  FUNBOX,
  HALFPIPE_DECK_E,
  HALFPIPE_DECK_W,
  HUBBA,
  HUBBA_BOTTOM,
  LEDGE_E,
  LEDGE_W,
  obstacleHeight,
  padBlend,
  RAILS,
  STAIRS,
  TRANSITIONS,
  transitionHeight,
  WEDGES,
  type Box,
  type LocalRail,
  type Transition,
  type Wedge
} from "./layout";
import { SKATE_PLAZA_CENTER, SKATE_PLAZA_PAD, SKATE_PLAZA_RADIUS, SKATE_PLAZA_YAW } from "./meta";

const RAIL_OWNER = "skate-plaza";
/** Slab resolution for the drawn concrete. 1 m keeps the bowl's dish smooth
 *  without faceting; anything coarser turns the transition into origami. */
const PAD_STEP = 1.0;
/** How far the kerb skirt drops below the terrain it meets. */
const SKIRT = 0.6;

/**
 * The Golden Gate Park skate plaza.
 *
 * A graded granite square with a kerb lip, dropped on the real terrain: the
 * SAME height function drives the drawn slab, every obstacle, and the ground
 * overlay that walkers, cars and skateboards all stand on, so the collision
 * surface can never diverge from the granite. On top of that it registers its
 * grind lines with the shared rail registry (vehicles/skate/rails.ts) — which
 * is the entire contract for making something in this world grindable.
 *
 * Everything here is procedural: a handful of shared materials and about a
 * dozen box/extrude geometries. Nothing is fetched.
 */
export class SkatePlaza {
  readonly group = new THREE.Group();
  #map: WorldMap;
  #overlay: GroundTopOverlay | null = null;
  #deckY = 0;
  #geometries = new Set<THREE.BufferGeometry>();
  #materials: THREE.Material[] = [];
  #disposed = false;

  constructor(map: WorldMap) {
    this.#map = map;
    this.group.name = "skate_plaza";
    this.group.position.set(SKATE_PLAZA_CENTER.x, 0, SKATE_PLAZA_CENTER.z);
    this.group.rotation.y = SKATE_PLAZA_YAW;

    // Grade level: the highest ground under the slab, so no hillock pokes
    // through the granite. Sampled BEFORE the overlay is installed, which is
    // also why `base` inside the overlay is never fed back into itself.
    this.#deckY = this.#gradeLevel() + 0.1;

    this.#buildSlab();
    this.#buildObstacles();
    this.#buildRails();
    this.#installOverlay();
    registerGrindRails(RAIL_OWNER, this.#worldRails());
  }

  /** Graded concrete level (world Y). The tutorial reads it to tell whether
   *  the player is actually down in the bowl. */
  get deckLevel(): number {
    return this.#deckY;
  }

  /** Plaza-local → world (the group's own transform, evaluated by hand so the
   *  overlay can run without touching the scene graph). */
  #toWorld(lx: number, lz: number, out: { x: number; z: number }) {
    const c = Math.cos(SKATE_PLAZA_YAW);
    const s = Math.sin(SKATE_PLAZA_YAW);
    out.x = SKATE_PLAZA_CENTER.x + lx * c + lz * s;
    out.z = SKATE_PLAZA_CENTER.z - lx * s + lz * c;
  }

  #gradeLevel(): number {
    const p = { x: 0, z: 0 };
    let top = -Infinity;
    const { hx, hz } = SKATE_PLAZA_PAD;
    for (let lz = -hz; lz <= hz; lz += 3) {
      for (let lx = -hx; lx <= hx; lx += 3) {
        this.#toWorld(lx, lz, p);
        top = Math.max(top, this.#map.groundTop(p.x, p.z));
      }
    }
    return Number.isFinite(top) ? top : 0;
  }

  /** Graded slab height (no obstacles) at a plaza-local point. */
  #padHeight(lx: number, lz: number, base: number): number {
    const blend = padBlend(lx, lz);
    if (blend <= 0) return base;
    return base + SKATE_PLAZA_PAD.kerb + (this.#deckY - base - SKATE_PLAZA_PAD.kerb) * blend;
  }

  #own<T extends THREE.BufferGeometry>(g: T): T {
    this.#geometries.add(g);
    return g;
  }

  #mat<T extends THREE.Material>(m: T): T {
    this.#materials.push(m);
    return m;
  }

  // --------------------------------------------------------------- granite --
  #buildSlab() {
    const { hx, hz, taper } = SKATE_PLAZA_PAD;
    const X = hx + taper;
    const Z = hz + taper;
    const nx = Math.ceil((2 * X) / PAD_STEP);
    const nz = Math.ceil((2 * Z) / PAD_STEP);
    const geometry = this.#own(new THREE.PlaneGeometry(2 * X, 2 * Z, nx, nz));
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const p = { x: 0, z: 0 };
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      this.#toWorld(lx, lz, p);
      // The bowl is part of the SLAB, not a separate mesh: it is a hole, and a
      // hole has to be the ground itself or the skater rolls over thin air.
      pos.setY(i, this.#padHeight(lx, lz, this.#map.groundTop(p.x, p.z)) + carveDepth(lx, lz));
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();

    const granite = this.#mat(
      new THREE.MeshStandardMaterial({ color: 0x9a9a97, roughness: 0.86, metalness: 0.02 })
    );
    const slab = new THREE.Mesh(geometry, granite);
    slab.receiveShadow = true;
    this.group.add(slab);

    // Kerb skirt: a ring of vertical quads under the slab's boundary, so the
    // lip reads as a real edge instead of a floating sheet of stone.
    const skirtMat = this.#mat(
      new THREE.MeshStandardMaterial({ color: 0x6f6f6d, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide })
    );
    const ring: number[] = [];
    const step = PAD_STEP;
    const push = (lx: number, lz: number) => {
      this.#toWorld(lx, lz, p);
      const y = this.#padHeight(lx, lz, this.#map.groundTop(p.x, p.z));
      ring.push(lx, y, lz, lx, y - SKIRT, lz);
    };
    for (let lx = -X; lx <= X; lx += step) push(lx, -Z);
    for (let lz = -Z; lz <= Z; lz += step) push(X, lz);
    for (let lx = X; lx >= -X; lx -= step) push(lx, Z);
    for (let lz = Z; lz >= -Z; lz -= step) push(-X, lz);
    const skirt = this.#own(new THREE.BufferGeometry());
    skirt.setAttribute("position", new THREE.Float32BufferAttribute(ring, 3));
    const idx: number[] = [];
    for (let i = 0; i + 3 < ring.length / 3; i += 2) {
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    skirt.setIndex(idx);
    skirt.computeVertexNormals();
    const skirtMesh = new THREE.Mesh(skirt, skirtMat);
    skirtMesh.receiveShadow = true;
    this.group.add(skirtMesh);
  }

  // ------------------------------------------------------------- obstacles --
  #buildObstacles() {
    const concrete = this.#mat(
      new THREE.MeshStandardMaterial({ color: 0xb3b0a8, roughness: 0.9, metalness: 0.02 })
    );
    const stone = this.#mat(
      new THREE.MeshStandardMaterial({ color: 0x7c7f86, roughness: 0.55, metalness: 0.08 })
    );
    const paint = this.#mat(
      new THREE.MeshStandardMaterial({ color: 0xe4c15a, roughness: 0.7, metalness: 0.03 })
    );
    // Pool tile. Every bowl worth skating has it, and from the air it is the
    // one thing that says "skatepark" rather than "car park with a dent".
    const tile = this.#mat(
      new THREE.MeshStandardMaterial({ color: 0x7fb4c4, roughness: 0.34, metalness: 0.05 })
    );

    const addBox = (b: Box, material: THREE.Material, base = 0) => {
      const geometry = this.#own(
        new THREE.BoxGeometry(b.x1 - b.x0, b.h - base, b.z1 - b.z0)
      );
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        (b.x0 + b.x1) / 2,
        this.#deckY + base + (b.h - base) / 2,
        (b.z0 + b.z1) / 2
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };

    addBox(DECK, concrete);
    addBox(HALFPIPE_DECK_W, concrete);
    addBox(HALFPIPE_DECK_E, concrete);
    addBox(FUNBOX, concrete);
    // Ledges are the good stone — waxed granite blocks with a steel edge cap.
    for (const ledge of [LEDGE_W, LEDGE_E]) {
      addBox(ledge, stone);
      const cap = this.#own(new THREE.BoxGeometry(ledge.x1 - ledge.x0, 0.04, 0.1));
      const capMesh = new THREE.Mesh(cap, paint);
      capMesh.position.set(
        (ledge.x0 + ledge.x1) / 2,
        this.#deckY + ledge.h + 0.01,
        ledge.z0 + 0.06
      );
      this.group.add(capMesh);
    }

    // Wedges: a side-view profile extruded across, so the drawn surface is the
    // very same ramp the overlay describes.
    for (const w of WEDGES) this.#addWedge(w, concrete);

    // Half-pipe walls, same idea with a curved profile.
    for (const t of TRANSITIONS) this.#addTransition(t, concrete);

    // Stairs.
    for (let i = 1; i <= STAIRS.steps; i++) {
      const z0 = STAIRS.z0 + ((i - 1) / STAIRS.steps) * (STAIRS.z1 - STAIRS.z0);
      const z1 = STAIRS.z0 + (i / STAIRS.steps) * (STAIRS.z1 - STAIRS.z0);
      addBox({ x0: STAIRS.x0, x1: STAIRS.x1, z0, z1, h: (i / STAIRS.steps) * STAIRS.h }, concrete);
    }

    // The hubba: a sloped stone ledge beside the stairs, drawn as a prism.
    this.#addHubba(stone);
    this.#addBowlPaint(tile);
  }

  #addWedge(w: Wedge, material: THREE.Material) {
    const shape = new THREE.Shape();
    const run = w.axis === "x" ? w.x1 - w.x0 : w.z1 - w.z0;
    shape.moveTo(0, 0);
    shape.lineTo(run, 0);
    if (w.rise === 1) shape.lineTo(run, w.h);
    else shape.lineTo(0, w.h);
    shape.closePath();
    const depth = w.axis === "x" ? w.z1 - w.z0 : w.x1 - w.x0;
    const geometry = this.#own(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }));
    const mesh = new THREE.Mesh(geometry, material);
    if (w.axis === "x") {
      // profile plane is (x, y), extruded along +z
      mesh.position.set(w.x0, this.#deckY, w.z0);
    } else {
      // profile plane is (run, y): yawing −90° sends the run along +z and the
      // extrusion along −x, so the origin is the ramp's +x edge.
      mesh.rotation.y = -Math.PI / 2;
      mesh.position.set(w.x1, this.#deckY, w.z0);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /** One curved ramp wall, extruded across its width. */
  #addTransition(t: Transition, material: THREE.Material) {
    const shape = new THREE.Shape();
    // Profile in (run, height): flat bottom, back wall at the lip, then the
    // arc back down — the SAME curve `transitionHeight` gives the overlay.
    shape.moveTo(t.run, 0);
    shape.lineTo(0, 0);
    shape.lineTo(0, t.h);
    const N = 16;
    for (let i = N; i >= 0; i--) {
      const d = (i / N) * t.run;
      shape.lineTo(t.run - d, transitionHeight(t, d));
    }
    shape.closePath();
    const acrossLo = t.axis === "x" ? t.z0 : t.x0;
    const acrossHi = t.axis === "x" ? t.z1 : t.x1;
    const geometry = this.#own(
      new THREE.ExtrudeGeometry(shape, { depth: acrossHi - acrossLo, bevelEnabled: false })
    );
    const mesh = new THREE.Mesh(geometry, material);
    // Shape-x is the run measured DOWN from the lip, so the origin sits at the
    // lip end and the arc climbs back toward it.
    if (t.axis === "x") {
      if (t.rise === -1) mesh.position.set(t.x0, this.#deckY, acrossLo);
      else {
        mesh.rotation.y = Math.PI;
        mesh.position.set(t.x1, this.#deckY, acrossHi);
      }
    } else {
      mesh.rotation.y = -Math.PI / 2;
      mesh.position.set(acrossHi, this.#deckY, t.rise === -1 ? t.z0 : t.z1);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /** The bowl's walls are in the slab; this is the tiled band around its floor,
   *  which keeps the dish from reading as a grey smudge from across the park. */
  #addBowlPaint(material: THREE.Material) {
    const floor = Math.max(0.5, BOWL.radius - BOWL.wall);
    const geometry = this.#own(new THREE.RingGeometry(floor * 0.82, floor, 40, 1));
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(BOWL.cx, this.#deckY - BOWL.depth + 0.012, BOWL.cz);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  #addHubba(material: THREE.Material) {
    const run = HUBBA.z1 - HUBBA.z0;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(run, 0);
    shape.lineTo(run, HUBBA.h);
    shape.lineTo(0, HUBBA_BOTTOM);
    shape.closePath();
    const geometry = this.#own(
      new THREE.ExtrudeGeometry(shape, { depth: HUBBA.x1 - HUBBA.x0, bevelEnabled: false })
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.y = -Math.PI / 2; // extrudes along −x from the +x face
    mesh.position.set(HUBBA.x1, this.#deckY, HUBBA.z0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // ----------------------------------------------------------------- rails --
  #buildRails() {
    const steel = this.#mat(
      new THREE.MeshStandardMaterial({ color: 0xc4ccd2, roughness: 0.22, metalness: 0.9 })
    );
    const barGeo = this.#own(new THREE.CylinderGeometry(0.045, 0.045, 1, 10, 1, true));
    const copingGeo = this.#own(new THREE.CylinderGeometry(0.07, 0.07, 1, 12, 1, true));
    const postGeo = this.#own(new THREE.CylinderGeometry(0.03, 0.03, 1, 8));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const r of RAILS) {
      if (!r.draw) continue;
      a.set(r.ax, this.#deckY + r.ay, r.az);
      b.set(r.bx, this.#deckY + r.by, r.bz);
      const bar = new THREE.Mesh(r.kind === "coping" ? copingGeo : barGeo, steel);
      bar.position.copy(a).lerp(b, 0.5);
      bar.scale.set(1, a.distanceTo(b), 1);
      bar.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        b.clone().sub(a).normalize()
      );
      bar.castShadow = true;
      this.group.add(bar);
      if (r.posts === false) continue; // coping is bolted to the concrete
      // Posts down to whatever the bar is standing on.
      const posts = Math.max(2, Math.round(a.distanceTo(b) / 2.6));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        const px = r.ax + (r.bx - r.ax) * t;
        const pz = r.az + (r.bz - r.az) * t;
        const py = r.ay + (r.by - r.ay) * t;
        const ground = obstacleHeight(px, pz);
        const height = Math.max(0.05, py - ground);
        const post = new THREE.Mesh(postGeo, steel);
        post.position.set(px, this.#deckY + ground + height / 2, pz);
        post.scale.set(1, height, 1);
        this.group.add(post);
      }
    }
  }

  #worldRails(): GrindRail[] {
    const p = { x: 0, z: 0 };
    return RAILS.map((r: LocalRail) => {
      this.#toWorld(r.ax, r.az, p);
      const ax = p.x;
      const az = p.z;
      this.#toWorld(r.bx, r.bz, p);
      return {
        id: `${RAIL_OWNER}:${r.id}`,
        ax,
        ay: this.#deckY + r.ay,
        az,
        bx: p.x,
        by: this.#deckY + r.by,
        bz: p.z,
        kind: r.kind,
        lift: r.lift
      } satisfies GrindRail;
    });
  }

  // --------------------------------------------------------------- ground --
  #installOverlay() {
    const cx = SKATE_PLAZA_CENTER.x;
    const cz = SKATE_PLAZA_CENTER.z;
    const c = Math.cos(SKATE_PLAZA_YAW);
    const s = Math.sin(SKATE_PLAZA_YAW);
    const r2 = SKATE_PLAZA_RADIUS * SKATE_PLAZA_RADIUS;
    const deckY = this.#deckY;
    const kerb = SKATE_PLAZA_PAD.kerb;
    const overlay: GroundTopOverlay = (x, z, base) => {
      // Early-out first: this runs on every ground query in the whole city.
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz > r2) return base;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const blend = padBlend(lx, lz);
      if (blend <= 0) return base;
      const pad = base + kerb + (deckY - base - kerb) * blend;
      if (blend < 1) return pad;
      // Inside the graded slab the park owns the surface outright: ramps raise
      // it, the bowl digs it, and the two never overlap by construction.
      const dip = carveDepth(lx, lz);
      if (dip < 0) return deckY + dip;
      return Math.max(pad, deckY + obstacleHeight(lx, lz));
    };
    this.#map.setGroundTopOverlay(overlay);
    this.#overlay = overlay;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    unregisterGrindRails(RAIL_OWNER);
    if (this.#overlay) this.#map.clearGroundTopOverlay(this.#overlay);
    this.#overlay = null;
    this.group.removeFromParent();
    for (const g of this.#geometries) g.dispose();
    for (const m of this.#materials) m.dispose();
    this.#geometries.clear();
    this.#materials.length = 0;
  }
}
