import * as THREE from "three/webgpu";
import { BodyType, TRANSFORM_STRIDE } from "../core/physics";
import type { TransformBatch } from "../core/physics";
import { CONFIG } from "../config";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";

/**
 * Whimsical physics toys, everywhere. Two layers:
 *
 *  - Curated SITES at the landmarks: big set pieces (crate henges, jenga
 *    gardens, balloon bouquets, trampoline lawns) that toast a "Discovered"
 *    message the first time you wander in.
 *  - Ambient CLUSTERS: small toy arrangements (mini towers, domino runs,
 *    snoozing ragdolls, gem caches...) continuously conjured on open ground
 *    around the player, wherever they roam, and recycled behind them. The city
 *    is never empty.
 *
 * Everything dynamic renders through instanced pools — one draw call per
 * shape. Each active zone gets its own static floor slab because the physics
 * ground carpet only exists right around the player. Spawn points are checked
 * against building-collider OBBs so toys never materialise inside towers.
 */

export type PropShape = "crate" | "ball" | "plank" | "gem" | "orb";

type Prop = {
  handle: number;
  shape: PropShape;
  slot: number;
  half: THREE.Vector3;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  color: THREE.Color;
  gravityScale: number;
};

type Pool = {
  shape: PropShape;
  mesh: THREE.InstancedMesh;
  props: Prop[];
  cap: number;
};

type BalloonString = { a: Prop; b: Prop };
type BouncePad = { x: number; z: number; y: number; r: number; mesh: THREE.Mesh; squash: number };
type Bone = { handle: number; group: THREE.Group };
type Ragdoll = { human: number; bones: Bone[] };

/** One active pocket of toys (a landmark site or an ambient cluster). */
type Zone = {
  kind: "site" | "cluster";
  name?: string;
  x: number;
  z: number;
  r: number;
  /** Bodies spawn asleep (frozen, no floor needed); the zone wakes when the
   * player is close enough that the ground carpet is underneath it. */
  awake: boolean;
  joints: number[];
  handles: Set<number>;
  ragdolls: Ragdoll[];
  pads: BouncePad[];
  strings: BalloonString[];
};

const SHAPE_DEFS: Record<
  PropShape,
  { half: [number, number, number]; density: number; friction: number; restitution: number; rollingResistance?: number; palette: string[] }
> = {
  crate: { half: [0.42, 0.42, 0.42], density: 1, friction: 0.62, restitution: 0.12, palette: ["#c98d4e", "#b07a42", "#d6a05e", "#8f6236"] },
  ball: { half: [0.38, 0.38, 0.38], density: 0.8, friction: 0.5, restitution: 0.62, rollingResistance: 0.015, palette: ["#ff5f5f", "#ffc44d", "#5fd47f", "#59b7ff", "#c78cff"] },
  plank: { half: [1.1, 0.075, 0.3], density: 0.9, friction: 0.6, restitution: 0.1, palette: ["#d8b98a", "#c7a878", "#e0c294"] },
  gem: { half: [0.4, 0.4, 0.4], density: 1.2, friction: 0.45, restitution: 0.3, palette: ["#ff4d88", "#4dc3ff", "#7dff9a", "#ffd23d", "#b06bff"] },
  orb: { half: [0.62, 0.62, 0.62], density: 0.22, friction: 0.4, restitution: 0.68, rollingResistance: 0.01, palette: ["#ffb3c8", "#a8e4ff", "#c9ffc4", "#fff3ad", "#e0c4ff"] }
};

const SPHERES: ReadonlySet<PropShape> = new Set(["ball", "gem", "orb"]);
const POOL_CAP: Record<PropShape, number> = { crate: 256, ball: 160, plank: 160, gem: 128, orb: 128 };

const MAX_CLUSTERS = 7;
const CLUSTER_MIN = 30;
const CLUSTER_MAX = 150;
const CLUSTER_DROP = 260;

/** Helpers a zone's build function uses; dx/dz are zone-local metres. */
export type SiteBuilder = {
  ground: (dx: number, dz: number) => number;
  spawn: (shape: PropShape, dx: number, dz: number, lift?: number, rot?: THREE.Quaternion) => Prop | undefined;
  tower: (dx: number, dz: number, width?: number, height?: number) => void;
  pyramid: (dx: number, dz: number, base?: number) => void;
  jenga: (dx: number, dz: number, layers?: number) => void;
  dominoes: (dx: number, dz: number, angle?: number, count?: number) => void;
  henge: (dx: number, dz: number, radius?: number, gates?: number) => void;
  ballpit: (dx: number, dz: number, count?: number) => void;
  balloons: (dx: number, dz: number, count?: number) => void;
  worm: (dx: number, dz: number, segments?: number) => void;
  totem: (dx: number, dz: number, pieces?: number) => void;
  ragdoll: (dx: number, dz: number, lift?: number) => void;
  pad: (dx: number, dz: number, r?: number) => void;
};

type SiteDef = { name: string; x: number; z: number; r: number; build: (s: SiteBuilder) => void };

// Discovery sites at real landmarks (local metre frame from meta.json). The
// centre is nudged to open ground at activation, so being a few metres off a
// plaza is fine.
const SITES: SiteDef[] = [
  {
    name: "Embarcadero playground",
    x: 4340, z: -420, r: 46,
    build: (s) => {
      s.tower(-14, -6, 3, 5);
      s.dominoes(4, 10, 2.4, 12);
      s.ballpit(16, -12, 14);
      s.balloons(-4, -18, 5);
      s.pad(10, 18, 2.4);
      s.ragdoll(-8, 14, 1.4);
      s.worm(20, 8, 6);
    }
  },
  {
    name: "Ferry Building jenga garden",
    x: 4405, z: -560, r: 40,
    build: (s) => {
      s.jenga(-10, 0, 12);
      s.jenga(12, 8, 9);
      s.balloons(0, -14, 4);
      s.totem(6, 16);
      s.pad(-16, 12, 2.2);
    }
  },
  {
    name: "Transamerica pyramid pups",
    x: 3680, z: 90, r: 38,
    build: (s) => {
      s.pyramid(0, 0, 4);
      s.pyramid(-14, 10, 3);
      for (let i = 0; i < 6; i++) s.spawn("gem", -8 + i * 3, -12, 0.6);
      s.ragdoll(10, -8, 1.4);
    }
  },
  {
    name: "Telegraph Hill rollers",
    x: 3320, z: -1290, r: 44,
    build: (s) => {
      for (let i = 0; i < 8; i++) s.spawn("ball", -12 + i * 3.2, -6 + (i % 3) * 4, 0.8);
      for (let i = 0; i < 4; i++) s.spawn("orb", -6 + i * 5, 10, 1.2);
      s.totem(14, -8);
      s.worm(-16, 12, 7);
    }
  },
  {
    name: "Palace of Fine Arts henge",
    x: -388, z: -1380, r: 42,
    build: (s) => {
      s.henge(0, 0, 6, 5);
      s.balloons(14, 10, 5);
      s.ragdoll(-12, 8, 1.4);
      s.pad(-6, -14, 2.4);
    }
  },
  {
    name: "Marina Green bounce lawn",
    x: -700, z: -2390, r: 46,
    build: (s) => {
      s.pad(-12, 0, 2.6);
      s.pad(0, 8, 2.6);
      s.pad(12, -4, 2.6);
      s.ballpit(4, -14, 16);
      s.balloons(-16, 12, 6);
      s.ragdoll(6, 14, 1.4);
    }
  },
  {
    name: "Union Square stack district",
    x: 3880, z: 240, r: 42,
    build: (s) => {
      s.tower(-10, -8, 3, 4);
      s.tower(12, 4, 2, 6);
      s.dominoes(-6, 8, 0.8, 14);
      s.henge(14, -14, 5, 4);
      s.worm(0, 18, 6);
    }
  },
  {
    name: "Golden Gate vista camp",
    x: -2900, z: -1860, r: 40,
    build: (s) => {
      s.jenga(0, 0, 10);
      s.balloons(-12, 8, 5);
      s.ragdoll(10, -6, 1.4);
      s.ragdoll(14, 4, 1.4);
      s.pad(-8, -12, 2.4);
    }
  },
  {
    name: "Sutro slope derby",
    x: -782, z: 3780, r: 44,
    build: (s) => {
      for (let i = 0; i < 10; i++) s.spawn("ball", -14 + i * 3, -4 + (i % 4) * 3, 0.9);
      s.totem(10, 12);
      s.dominoes(-10, 14, 1.2, 12);
    }
  },
  {
    name: "Alcatraz contraband stash",
    x: 1848, z: -4028, r: 34,
    build: (s) => {
      s.tower(0, 0, 2, 4);
      for (let i = 0; i < 5; i++) s.spawn("gem", -8 + i * 3.4, 8, 0.6);
      s.balloons(6, -8, 4);
    }
  }
];

// small ambient arrangements conjured around the player on open ground
const CLUSTER_KINDS: ((s: SiteBuilder) => void)[] = [
  (s) => s.tower(0, 0, 2, 3),
  (s) => {
    for (let i = 0; i < 3; i++) s.spawn("ball", -2 + i * 2, i % 2, 0.7);
    s.spawn("gem", 1, -2, 0.6);
  },
  (s) => {
    for (let i = 0; i < 5; i++) s.spawn("gem", Math.cos((i / 5) * 6.28) * 2.2, Math.sin((i / 5) * 6.28) * 2.2, 0.6);
  },
  (s) => s.balloons(0, 0, 4),
  (s) => s.dominoes(-4, 0, Math.random() * 6.28, 9),
  (s) => s.jenga(0, 0, 7),
  (s) => s.totem(0, 0, 4),
  (s) => {
    s.pad(0, 0, 2.2);
    s.spawn("orb", 2.5, 1, 1.2);
    s.spawn("orb", -2, 2, 1.2);
  },
  (s) => {
    s.ragdoll(0, 0, 1.2);
    s.spawn("crate", 1.6, 0.6, 0.5);
    s.spawn("ball", -1.4, 1, 0.6);
  },
  (s) => {
    for (let i = 0; i < 4; i++) s.spawn("orb", -2 + (i % 2) * 2.4, -1 + Math.floor(i / 2) * 2.4, 0.8 + i * 0.5);
  },
  (s) => s.worm(0, 0, 5),
  (s) => s.pyramid(0, 0, 3)
];

export class Props {
  zeroG = false;
  onDiscover: (name: string) => void = () => {};
  /** Fires just BEFORE a body is destroyed, so ropes/grabs can let go safely. */
  onWillRemoveBody: (handle: number) => void = () => {};

  #physics: Physics;
  #map: WorldMap;
  #scene: THREE.Scene;
  #pools: Record<PropShape, Pool>;
  #all = new Map<number, Prop>();
  #cullBuf: Prop[] = []; // reused each frame to defer despawn past Map iteration
  #batch: TransformBatch | null = null;
  #batchProps: Prop[] = [];
  #batchBones: Bone[] = [];
  #batchDirty = true;
  #tick = 0;
  #clusterTimer = 0.5;

  #zones: Zone[] = [];
  #activeSite: string | null = null;
  #discovered = new Set<string>();
  #stringLines: THREE.LineSegments;
  #padGeo = new THREE.CylinderGeometry(1, 1.2, 0.4, 20);
  #padMat = new THREE.MeshStandardMaterial({ color: "#ff7ab0", roughness: 0.55 });
  #padTopMat = new THREE.MeshStandardMaterial({ color: "#ffd7e8", roughness: 0.4 });

  #tmpMat = new THREE.Matrix4();
  #tmpVec = new THREE.Vector3();
  #tmpScale = new THREE.Vector3(1, 1, 1);

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene) {
    this.#physics = physics;
    this.#map = map;
    this.#scene = scene;

    const geos: Record<PropShape, THREE.BufferGeometry> = {
      crate: new THREE.BoxGeometry(0.84, 0.84, 0.84),
      ball: new THREE.SphereGeometry(0.38, 18, 12),
      plank: new THREE.BoxGeometry(2.2, 0.15, 0.6),
      gem: new THREE.OctahedronGeometry(0.5, 0),
      orb: new THREE.SphereGeometry(0.62, 20, 14)
    };
    const mats: Record<PropShape, THREE.Material> = {
      crate: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.78 }),
      ball: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.35, metalness: 0.1 }),
      plank: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.8 }),
      gem: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.15, metalness: 0.6 }),
      orb: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.3 })
    };
    this.#pools = Object.fromEntries(
      (Object.keys(SHAPE_DEFS) as PropShape[]).map((shape) => {
        const mesh = new THREE.InstancedMesh(geos[shape], mats[shape], POOL_CAP[shape]);
        mesh.count = 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false; // instances roam; a stale bounding sphere would cull them
        // create the instanceColor attribute NOW so the first compiled pipeline
        // already includes it — adding it after a spawn leaves the cached WebGPU
        // shader colour-blind (white props)
        mesh.setColorAt(0, new THREE.Color("#ffffff"));
        mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
        scene.add(mesh);
        return [shape, { shape, mesh, props: [], cap: POOL_CAP[shape] }];
      })
    ) as unknown as Record<PropShape, Pool>;

    const stringGeo = new THREE.BufferGeometry();
    stringGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(96 * 6), 3));
    this.#stringLines = new THREE.LineSegments(
      stringGeo,
      new THREE.LineBasicMaterial({ color: 0xf5efdf, transparent: true, opacity: 0.85 })
    );
    this.#stringLines.frustumCulled = false;
    this.#stringLines.visible = false;
    scene.add(this.#stringLines);
  }

  get count() {
    return this.#all.size;
  }

  // ------------------------------------------------------------------ spawn

  spawn(
    shape: PropShape,
    position: THREE.Vector3,
    opts: { rotation?: THREE.Quaternion; gravityScale?: number; density?: number; zone?: Zone } = {}
  ): Prop | undefined {
    const pool = this.#pools[shape];
    if (pool.props.length >= pool.cap) return undefined;
    // never conjure a toy inside a building
    if (this.#physics.pointInBuilding(position.x, position.y, position.z, 0.3)) return undefined;
    const def = SHAPE_DEFS[shape];
    const w = this.#physics.world;

    let handle: number;
    if (SPHERES.has(shape)) {
      handle = w.createSphere({
        type: BodyType.Dynamic,
        position: [position.x, position.y, position.z],
        radius: def.half[0],
        density: opts.density ?? def.density,
        friction: def.friction,
        restitution: def.restitution,
        rollingResistance: def.rollingResistance
      });
    } else {
      handle = w.createBox({
        type: BodyType.Dynamic,
        position: [position.x, position.y, position.z],
        halfExtents: def.half,
        density: opts.density ?? def.density,
        friction: def.friction,
        restitution: def.restitution
      });
    }
    if (opts.rotation) {
      w.setBodyTransform(handle, [position.x, position.y, position.z], [opts.rotation.x, opts.rotation.y, opts.rotation.z, opts.rotation.w]);
    }
    const gravityScale = opts.gravityScale ?? 1;
    if (this.zeroG) w.setBodyGravityScale(handle, 0);
    else if (gravityScale !== 1) w.setBodyGravityScale(handle, gravityScale);

    const color = new THREE.Color(def.palette[Math.floor(Math.random() * def.palette.length)]);
    const prop: Prop = {
      handle,
      shape,
      slot: pool.props.length,
      half: new THREE.Vector3(...def.half),
      pos: position.clone(),
      quat: opts.rotation?.clone() ?? new THREE.Quaternion(),
      color,
      gravityScale
    };
    pool.props.push(prop);
    pool.mesh.count = pool.props.length;
    this.#tmpMat.compose(prop.pos, prop.quat, this.#tmpScale);
    pool.mesh.setMatrixAt(prop.slot, this.#tmpMat);
    pool.mesh.setColorAt(prop.slot, color);
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    this.#all.set(handle, prop);
    if (opts.zone) {
      opts.zone.handles.add(handle);
      // zone toys freeze until the player (with the ground carpet) shows up
      if (!opts.zone.awake) w.setBodyAwake(handle, false);
    }
    this.#batchDirty = true;
    return prop;
  }

  #despawn(prop: Prop) {
    const pool = this.#pools[prop.shape];
    if (!this.#all.delete(prop.handle)) return;
    this.onWillRemoveBody(prop.handle);
    this.#physics.world.destroyBody(prop.handle);
    const last = pool.props[pool.props.length - 1];
    pool.props.pop();
    if (last !== prop) {
      pool.props[prop.slot] = last;
      last.slot = prop.slot;
      this.#tmpMat.compose(last.pos, last.quat, this.#tmpScale);
      pool.mesh.setMatrixAt(last.slot, this.#tmpMat);
      pool.mesh.setColorAt(last.slot, last.color);
    }
    pool.mesh.count = pool.props.length;
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    this.#batchDirty = true;
  }

  #spawnRagdoll(position: THREE.Vector3, zone: Zone) {
    if (this.#physics.pointInBuilding(position.x, position.y, position.z, 0.5)) return;
    const w = this.#physics.world;
    const rag = w.spawnHuman([position.x, position.y, position.z], { frictionTorque: 4, hertz: 2, dampingRatio: 0.6 });
    const skin = ["#e8b48c", "#c98f66", "#f2c9a0"][Math.floor(Math.random() * 3)];
    const shirt = ["#3f7fd1", "#d15050", "#4fae62", "#9a5fd1"][Math.floor(Math.random() * 4)];
    const bones: Bone[] = [];
    for (let i = 0; i < rag.bones.length; i++) {
      const handle = rag.bones[i];
      const capsule = w.getBodyCapsule(handle);
      const group = new THREE.Group();
      if (capsule) {
        const from = new THREE.Vector3(...capsule.center1);
        const to = new THREE.Vector3(...capsule.center2);
        const axis = to.clone().sub(from);
        const len = axis.length();
        // bone 5 is the head in the upstream ragdoll ordering
        const colorHex = i === 5 ? skin : i <= 1 || i > 9 ? shirt : skin;
        const mesh = new THREE.Mesh(
          new THREE.CapsuleGeometry(capsule.radius, len, 3, 8),
          new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.7 })
        );
        mesh.castShadow = true;
        mesh.position.copy(from).add(to).multiplyScalar(0.5);
        if (len > 1e-5) mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
        group.add(mesh);
      }
      if (this.zeroG) w.setBodyGravityScale(handle, 0);
      if (!zone.awake) w.setBodyAwake(handle, false);
      const t = w.getBodyTransform(handle);
      group.position.set(...t.position);
      group.quaternion.set(...t.rotation);
      this.#scene.add(group);
      bones.push({ handle, group });
    }
    zone.ragdolls.push({ human: rag.human, bones });
    this.#batchDirty = true;
  }

  // ------------------------------------------------------------------ zones

  update(dt: number, playerPos: THREE.Vector3) {
    this.#tick++;
    if (this.#tick % 31 === 0) this.#checkSites(playerPos);
    this.#clusterTimer -= dt;
    if (this.#clusterTimer <= 0) {
      this.#clusterTimer = 0.7;
      this.#manageClusters(playerPos);
    }
    this.#sync();
    this.#updateStrings();
    this.#updatePads(dt);
  }

  #checkSites(p: THREE.Vector3) {
    for (const zone of [...this.#zones]) {
      const d = Math.hypot(p.x - zone.x, p.z - zone.z);
      // retire zones the player has left behind
      const drop = zone.kind === "site" ? zone.r + 140 : CLUSTER_DROP;
      if (d > drop) {
        this.#dropZone(zone);
        continue;
      }
      // wake toys only once the zone's whole footprint sits on the ground
      // carpet (awake bodies without a floor fall through the world); freeze
      // them in place again once the player wanders off
      const carpetHalf = (CONFIG.carpetSize * CONFIG.carpetCell) / 2;
      const wakeR = Math.max(10, carpetHalf - zone.r - 8);
      if (!zone.awake && d < wakeR) this.#setZoneAwake(zone, true);
      else if (zone.awake && d > wakeR + 18) this.#setZoneAwake(zone, false);
    }
    if (this.#activeSite === null) {
      for (const s of SITES) {
        if (Math.hypot(p.x - s.x, p.z - s.z) < s.r + 90) {
          this.#activateSite(s);
          break;
        }
      }
    }
  }

  /** Spiral out from (x, z) to the nearest spot clear of buildings and water. */
  #openSpot(x: number, z: number, clearance: number): { x: number; z: number } | null {
    for (let r = 0; r <= 60; r += 7) {
      const steps = r === 0 ? 1 : 10;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2 + r * 0.7;
        const cx = x + Math.cos(a) * r;
        const cz = z + Math.sin(a) * r;
        if (this.#map.isWater(cx, cz)) continue;
        const gy = this.#map.effectiveGround(cx, cz);
        if (!this.#physics.pointInBuilding(cx, gy + 1.2, cz, clearance)) return { x: cx, z: cz };
      }
    }
    return null;
  }

  #makeZone(kind: Zone["kind"], x: number, z: number, r: number, name?: string): Zone {
    // no floor bodies: toys spawn asleep and only wake once the player (and
    // therefore the ground carpet) is close enough to catch them
    const zone: Zone = { kind, name, x, z, r, awake: false, joints: [], handles: new Set(), ragdolls: [], pads: [], strings: [] };
    this.#zones.push(zone);
    return zone;
  }

  #setZoneAwake(zone: Zone, awake: boolean) {
    zone.awake = awake;
    const w = this.#physics.world;
    for (const h of zone.handles) w.setBodyAwake(h, awake);
    for (const rag of zone.ragdolls) {
      for (const bone of rag.bones) w.setBodyAwake(bone.handle, awake);
    }
  }

  #activateSite(site: SiteDef) {
    const spot = this.#openSpot(site.x, site.z, 4) ?? { x: site.x, z: site.z };
    const zone = this.#makeZone("site", spot.x, spot.z, site.r, site.name);
    this.#activeSite = site.name;
    site.build(this.#makeBuilder(zone));
    if (!this.#discovered.has(site.name)) {
      this.#discovered.add(site.name);
      this.onDiscover(site.name);
    }
  }

  #manageClusters(p: THREE.Vector3) {
    const clusters = this.#zones.filter((zn) => zn.kind === "cluster");
    if (clusters.length >= MAX_CLUSTERS) return;
    // one attempt per beat: random spot in the ring around the player
    const a = Math.random() * Math.PI * 2;
    const d = CLUSTER_MIN + Math.random() * (CLUSTER_MAX - CLUSTER_MIN);
    const x = p.x + Math.cos(a) * d;
    const z = p.z + Math.sin(a) * d;
    if (this.#map.isWater(x, z)) return;
    // keep clusters spread out (and off the active site)
    for (const zn of this.#zones) {
      if (Math.hypot(zn.x - x, zn.z - z) < zn.r + 24) return;
    }
    const spot = this.#openSpot(x, z, 3);
    if (!spot) return;
    const zone = this.#makeZone("cluster", spot.x, spot.z, 10);
    CLUSTER_KINDS[Math.floor(Math.random() * CLUSTER_KINDS.length)](this.#makeBuilder(zone));
    // a dud roll (everything landed in buildings) leaves an empty zone — drop it
    if (zone.handles.size === 0 && zone.ragdolls.length === 0 && zone.pads.length === 0) this.#dropZone(zone);
  }

  #dropZone(zone: Zone) {
    const idx = this.#zones.indexOf(zone);
    if (idx === -1) return;
    this.#zones.splice(idx, 1);
    const w = this.#physics.world;
    for (const j of zone.joints) w.destroyJoint(j); // before the bodies they bind
    for (const h of zone.handles) {
      const prop = this.#all.get(h);
      if (prop) this.#despawn(prop);
    }
    for (const rag of zone.ragdolls) {
      for (const bone of rag.bones) {
        this.onWillRemoveBody(bone.handle);
        w.destroyBody(bone.handle);
        this.#scene.remove(bone.group);
        bone.group.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          if (m.material) (m.material as THREE.Material).dispose();
        });
      }
    }
    for (const pad of zone.pads) this.#scene.remove(pad.mesh);
    if (zone.kind === "site") this.#activeSite = null;
    this.#batchDirty = true;
  }

  #makeBuilder(zone: Zone): SiteBuilder {
    const w = this.#physics.world;
    const ground = (dx: number, dz: number) => this.#map.effectiveGround(zone.x + dx, zone.z + dz);
    const spawnAt = (shape: PropShape, dx: number, dz: number, lift = 0.5, rot?: THREE.Quaternion) =>
      this.spawn(shape, this.#tmpVec.set(zone.x + dx, ground(dx, dz) + lift, zone.z + dz).clone(), { rotation: rot, zone });

    const h = SHAPE_DEFS.crate.half[0];
    const size = h * 2 + 0.02;

    const builder: SiteBuilder = {
      ground,
      spawn: spawnAt,
      tower: (dx, dz, width = 3, height = 5) => {
        const base = ground(dx, dz);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            for (let z = 0; z < width; z++)
              this.spawn("crate", new THREE.Vector3(
                zone.x + dx + (x - (width - 1) / 2) * size,
                base + h + 0.04 + y * size,
                zone.z + dz + (z - (width - 1) / 2) * size
              ), { zone });
      },
      pyramid: (dx, dz, base = 4) => {
        const gy = ground(dx, dz);
        for (let y = 0; y < base; y++) {
          const n = base - y;
          for (let x = 0; x < n; x++)
            for (let z = 0; z < n; z++)
              this.spawn("crate", new THREE.Vector3(
                zone.x + dx + (x - (n - 1) / 2) * size,
                gy + h + 0.04 + y * size,
                zone.z + dz + (z - (n - 1) / 2) * size
              ), { zone });
        }
      },
      jenga: (dx, dz, layers = 12) => {
        const t = SHAPE_DEFS.plank.half[1];
        const pw = SHAPE_DEFS.plank.half[2] * 2;
        const layerH = t * 2 + 0.01;
        const gy = ground(dx, dz);
        const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        for (let y = 0; y < layers; y++) {
          const cy = gy + t + 0.03 + y * layerH;
          for (let i = -1; i <= 1; i++) {
            const off = i * (pw + 0.02);
            const pos = y % 2
              ? new THREE.Vector3(zone.x + dx + off, cy, zone.z + dz)
              : new THREE.Vector3(zone.x + dx, cy, zone.z + dz + off);
            this.spawn("plank", pos, { rotation: y % 2 ? turned.clone() : undefined, zone });
          }
        }
      },
      dominoes: (dx, dz, angle = 0, count = 12) => {
        const d = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
        const face = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-d.z, d.x));
        const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
        const rot = face.multiply(upright);
        for (let i = 0; i < count; i++) {
          const px = dx + d.x * i * 1.35;
          const pz = dz + d.z * i * 1.35;
          this.spawn("plank", new THREE.Vector3(zone.x + px, ground(px, pz) + SHAPE_DEFS.plank.half[0] + 0.04, zone.z + pz), {
            rotation: rot.clone(),
            zone
          });
        }
      },
      henge: (dx, dz, radius = 5.5, gates = 5) => {
        const t = SHAPE_DEFS.plank.half[1];
        for (let g = 0; g < gates; g++) {
          const a = (g / gates) * Math.PI * 2;
          const gx = dx + Math.cos(a) * radius;
          const gz = dz + Math.sin(a) * radius;
          const gy = ground(gx, gz);
          const tan = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
          const gateRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-tan.z, tan.x));
          for (const side of [-0.7, 0.7]) {
            for (let y = 0; y < 2; y++) {
              this.spawn("crate", new THREE.Vector3(zone.x + gx + tan.x * side, gy + h + 0.03 + y * size, zone.z + gz + tan.z * side), {
                rotation: gateRot.clone(),
                zone
              });
            }
          }
          this.spawn("plank", new THREE.Vector3(zone.x + gx, gy + 2 * size + t + 0.04, zone.z + gz), { rotation: gateRot.clone(), zone });
        }
      },
      ballpit: (dx, dz, count = 16) => {
        const gy = ground(dx, dz);
        for (let i = 0; i < count; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * 2.4;
          this.spawn("ball", new THREE.Vector3(zone.x + dx + Math.cos(a) * r, gy + 1 + (i % 10) * 0.85, zone.z + dz + Math.sin(a) * r), { zone });
        }
      },
      balloons: (dx, dz, count = 5) => {
        const base = spawnAt("crate", dx, dz, h + 0.02);
        if (!base) return;
        const top = new THREE.Vector3(base.pos.x, base.pos.y + base.half.y, base.pos.z);
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2;
          const len = 2.1 + (i % 3) * 0.6;
          const bx = base.pos.x + Math.cos(a) * 0.7;
          const bz = base.pos.z + Math.sin(a) * 0.7;
          const balloon = this.spawn("orb", new THREE.Vector3(bx, top.y + len, bz), { density: 0.12, gravityScale: -0.45, zone });
          if (!balloon) break;
          zone.joints.push(
            w.createDistanceJoint(base.handle, balloon.handle, [top.x, top.y, top.z], [bx, top.y + len - 0.55, bz], {
              length: len - 0.5,
              hertz: 3.5,
              dampingRatio: 0.5
            })
          );
          zone.strings.push({ a: base, b: balloon });
        }
      },
      worm: (dx, dz, segments = 6) => {
        const gy = ground(dx, dz);
        const head = this.spawn("orb", new THREE.Vector3(zone.x + dx, gy + 0.7, zone.z + dz), { zone });
        if (!head) return;
        let prev = head;
        for (let i = 0; i < segments; i++) {
          const px = dx + 1.1 + i * 0.85;
          const seg = this.spawn("ball", new THREE.Vector3(zone.x + px, gy + 0.45, zone.z + dz), { zone });
          if (!seg) break;
          const midX = (prev.pos.x + seg.pos.x) / 2;
          zone.joints.push(w.createSphericalJoint(prev.handle, seg.handle, [midX, gy + 0.45, zone.z + dz], { hertz: 0 }));
          prev = seg;
        }
      },
      totem: (dx, dz, pieces = 5) => {
        const full: { shape: PropShape; h: number }[] = [
          { shape: "crate", h: 0.42 },
          { shape: "orb", h: 0.62 },
          { shape: "crate", h: 0.42 },
          { shape: "gem", h: 0.4 },
          { shape: "gem", h: 0.4 }
        ];
        const stack = full.slice(0, pieces);
        const gy = ground(dx, dz);
        let y = gy + 0.04;
        let prev: Prop | undefined;
        for (const part of stack) {
          const cy = y + part.h;
          const prop = this.spawn(part.shape, new THREE.Vector3(zone.x + dx, cy, zone.z + dz), { zone });
          if (!prop) return;
          if (prev) zone.joints.push(w.createSphericalJoint(prev.handle, prop.handle, [zone.x + dx, y, zone.z + dz], { hertz: 3, dampingRatio: 0.3 }));
          prev = prop;
          y = cy + part.h + 0.02;
        }
      },
      ragdoll: (dx, dz, lift = 1.4) => {
        this.#spawnRagdoll(new THREE.Vector3(zone.x + dx, ground(dx, dz) + lift, zone.z + dz), zone);
      },
      pad: (dx, dz, r = 2.4) => {
        const gy = ground(dx, dz);
        if (this.#physics.pointInBuilding(zone.x + dx, gy + 0.5, zone.z + dz, 1)) return;
        const mesh = new THREE.Mesh(this.#padGeo, this.#padMat);
        const topper = new THREE.Mesh(this.#padGeo, this.#padTopMat);
        topper.scale.set(0.82, 0.5, 0.82);
        topper.position.y = 0.22;
        mesh.add(topper);
        mesh.scale.set(r, 1, r);
        mesh.position.set(zone.x + dx, gy + 0.2, zone.z + dz);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.#scene.add(mesh);
        zone.pads.push({ x: zone.x + dx, z: zone.z + dz, y: gy + 0.42, r, mesh, squash: 0 });
      }
    };
    return builder;
  }

  // -------------------------------------------------------------- per frame

  /** Bounce pad under this position? Returns launch velocity, and squashes the pad. */
  padLaunch(pos: THREE.Vector3, vy: number): number | null {
    if (vy > 0.5) return null;
    for (const zone of this.#zones) {
      for (const pad of zone.pads) {
        if (Math.hypot(pos.x - pad.x, pos.z - pad.z) > pad.r) continue;
        if (pos.y < pad.y - 1 || pos.y > pad.y + 1.6) continue;
        pad.squash = 1;
        return Math.max(14, -vy * 1.35 + 8);
      }
    }
    return null;
  }

  /** Everything grabbable/tieable here, as generous hit-spheres for the pick ray. */
  collectPickables(out: { handle: number; x: number; y: number; z: number; r: number }[]) {
    for (const prop of this.#all.values()) {
      out.push({ handle: prop.handle, x: prop.pos.x, y: prop.pos.y, z: prop.pos.z, r: prop.half.length() + 0.35 });
    }
    for (const zone of this.#zones) {
      if (!zone.awake) continue; // frozen far-off toys would tunnel when yanked
      for (const rag of zone.ragdolls) {
        for (const bone of rag.bones) {
          out.push({
            handle: bone.handle,
            x: bone.group.position.x,
            y: bone.group.position.y,
            z: bone.group.position.z,
            r: 0.45
          });
        }
      }
    }
  }

  setZeroG(on: boolean) {
    this.zeroG = on;
    const w = this.#physics.world;
    for (const prop of this.#all.values()) {
      w.setBodyGravityScale(prop.handle, on ? 0 : prop.gravityScale);
    }
    for (const zone of this.#zones) {
      for (const rag of zone.ragdolls) {
        for (const bone of rag.bones) w.setBodyGravityScale(bone.handle, on ? 0 : 1);
      }
      // only toys with the carpet under them get the wake-up kick — sleeping
      // far-off zones would fall through the floorless world
      if (!zone.awake) continue;
      for (const h of zone.handles) {
        w.setBodyAwake(h, true);
        if (on) w.applyImpulse(h, [0, w.getBodyMass(h) * 1.2, 0]);
      }
      for (const rag of zone.ragdolls) {
        for (const bone of rag.bones) w.setBodyAwake(bone.handle, true);
      }
    }
  }

  #sync() {
    if (this.#batchDirty) {
      this.#batch?.dispose();
      this.#batchProps = [];
      this.#batchBones = [];
      const handles: number[] = [];
      for (const pool of Object.values(this.#pools)) {
        for (const prop of pool.props) {
          this.#batchProps.push(prop);
          handles.push(prop.handle);
        }
      }
      for (const zone of this.#zones) {
        for (const rag of zone.ragdolls) {
          for (const bone of rag.bones) {
            this.#batchBones.push(bone);
            handles.push(bone.handle);
          }
        }
      }
      this.#batch = handles.length ? this.#physics.world.createTransformBatch(handles) : null;
      this.#batchDirty = false;
    }
    if (!this.#batch) return;

    const data = this.#batch.read();
    let off = 0;
    for (const prop of this.#batchProps) {
      prop.pos.set(data[off], data[off + 1], data[off + 2]);
      prop.quat.set(data[off + 3], data[off + 4], data[off + 5], data[off + 6]);
      off += TRANSFORM_STRIDE;
      const pool = this.#pools[prop.shape];
      this.#tmpMat.compose(prop.pos, prop.quat, this.#tmpScale);
      pool.mesh.setMatrixAt(prop.slot, this.#tmpMat);
    }
    for (const pool of Object.values(this.#pools)) {
      if (pool.props.length) pool.mesh.instanceMatrix.needsUpdate = true;
    }
    for (const bone of this.#batchBones) {
      bone.group.position.set(data[off], data[off + 1], data[off + 2]);
      bone.group.quaternion.set(data[off + 3], data[off + 4], data[off + 5], data[off + 6]);
      off += TRANSFORM_STRIDE;
    }
    // cull anything knocked out of the world (collect first — #despawn mutates #all)
    let culled = 0;
    for (const prop of this.#all.values()) {
      if (prop.pos.y < -80) this.#cullBuf[culled++] = prop;
    }
    for (let i = 0; i < culled; i++) {
      const prop = this.#cullBuf[i];
      for (const zone of this.#zones) zone.handles.delete(prop.handle);
      this.#despawn(prop);
      this.#cullBuf[i] = null!;
    }
  }

  #updateStrings() {
    const attr = this.#stringLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    let n = 0;
    for (const zone of this.#zones) {
      for (const s of zone.strings) {
        if (n >= 96) break;
        arr[n * 6] = s.a.pos.x;
        arr[n * 6 + 1] = s.a.pos.y + s.a.half.y;
        arr[n * 6 + 2] = s.a.pos.z;
        arr[n * 6 + 3] = s.b.pos.x;
        arr[n * 6 + 4] = s.b.pos.y - s.b.half.y * 0.8;
        arr[n * 6 + 5] = s.b.pos.z;
        n++;
      }
    }
    this.#stringLines.visible = n > 0;
    if (n > 0) {
      this.#stringLines.geometry.setDrawRange(0, n * 2);
      attr.needsUpdate = true;
    }
  }

  #updatePads(dt: number) {
    for (const zone of this.#zones) {
      for (const pad of zone.pads) {
        if (pad.squash <= 0.001) continue;
        pad.squash = Math.max(0, pad.squash - dt * 4);
        const sy = 1 - Math.sin(pad.squash * Math.PI) * 0.55;
        pad.mesh.scale.set(pad.r * (1 + (1 - sy) * 0.3), sy, pad.r * (1 + (1 - sy) * 0.3));
      }
    }
  }
}
