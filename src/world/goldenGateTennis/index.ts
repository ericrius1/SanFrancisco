import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import type { GroundTopOverlay, WorldMap } from "../heightmap";
import { enableLocalShadowLayer } from "../shadows/shadowLayers";
import { buildClubhouse, type ClubhouseBuild } from "./clubhouse";
import { createClubhouseNpcs, type ClubhouseNpcs } from "./npcs";
import {
  DEFAULT_GAMEPLAY_COURT_REF,
  GOLDMAN_COURTS,
  GOLDMAN_NORTHEAST_POD_OUTLINE,
  GOLDMAN_PATHS,
  GOLDMAN_SITE_OUTLINE,
  HIPPIE_HILL_OUTLINE,
  type GoldmanCourtRef,
  type GoldmanCourtSpec,
  type GoldmanPathSpec,
  type GoldmanPickleballCourtRef,
  type GoldmanXZ
} from "./layout";

export * from "./layout";

export type GoldmanCourtAnchor = {
  ref: GoldmanCourtRef;
  kind: GoldmanCourtSpec["kind"];
  name: string;
  x: number;
  y: number;
  z: number;
  /** Long-axis heading from world +Z toward +X. */
  yaw: number;
  playWidth: number;
  playLength: number;
  padWidth: number;
  padLength: number;
};

export type GoldenGateTennisSiteOptions = {
  /**
   * The playable layer owns this court, so the static pad, paint and net are
   * omitted. `undefined` reserves 14B; `null` renders every decorative court.
   */
  reservedCourtRef?: GoldmanPickleballCourtRef | null;
  /** Optional stepped/query physics for perimeter fences and court nets. */
  physics?: Physics;
  /** Day/night provider for the clubhouse crowd; omitted = always day. */
  daylight?: () => boolean;
};

// The real center is terraced into a slope. A deep foundation lets every flat
// surveyed pad sit above the baked terrain without floating side gaps.
const COURT_PAD_THICKNESS = 1.75;
const COURT_PAD_TOP = 0.03;
const COURT_PAINT_LIFT = 0.05;
const COURT_SURFACE_LIFT = COURT_PAINT_LIFT + 0.035 / 2;
const LINE_LIFT = 0.073;
const PATH_LIFT = 0.055;
const FENCE_HEIGHT = 3.05; // the city operations plan specifies a 10 ft perimeter fence
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function localPoint(court: GoldmanCourtSpec, lateral: number, along: number): { x: number; z: number } {
  const c = Math.cos(court.yaw);
  const s = Math.sin(court.yaw);
  return {
    x: court.x + c * lateral + s * along,
    z: court.z - s * lateral + c * along
  };
}

/** Terrace each pad above the highest host-terrain sample under its footprint. */
function courtGrade(map: WorldMap, court: GoldmanCourtSpec): number {
  const hx = court.padWidth * 0.5;
  const hz = court.padLength * 0.5;
  let highest = -Infinity;
  for (let iz = 0; iz <= 8; iz++) {
    const along = THREE.MathUtils.lerp(-hz, hz, iz / 8);
    for (let ix = 0; ix <= 5; ix++) {
      const lateral = THREE.MathUtils.lerp(-hx, hx, ix / 5);
      const p = localPoint(court, lateral, along);
      highest = Math.max(highest, map.baseGroundTop(p.x, p.z));
    }
  }
  return highest + 0.025;
}

function courtLocal(court: GoldmanCourtSpec, x: number, z: number): { lateral: number; along: number } {
  const dx = x - court.x;
  const dz = z - court.z;
  const c = Math.cos(court.yaw);
  const s = Math.sin(court.yaw);
  return { lateral: dx * c - dz * s, along: dx * s + dz * c };
}

/** Physics/player grounding that exactly matches the visible terraced pads
 *  and the clubhouse interior floor (incl. its door ramps). */
function installSiteGrounding(
  map: WorldMap,
  grades: ReadonlyMap<GoldmanCourtRef, number>,
  clubhouse: ClubhouseBuild
) {
  const overlay: GroundTopOverlay = (x, z, base) => {
    const interior = clubhouse.groundTopAt(x, z, base);
    if (interior !== null) return interior;
    for (const court of GOLDMAN_COURTS) {
      const local = courtLocal(court, x, z);
      if (Math.abs(local.lateral) > court.padWidth / 2 || Math.abs(local.along) > court.padLength / 2) continue;
      const grade = grades.get(court.ref)!;
      const onPaint =
        Math.abs(local.lateral) <= court.playWidth / 2 && Math.abs(local.along) <= court.playLength / 2;
      return grade + (onPaint ? COURT_SURFACE_LIFT : COURT_PAD_TOP);
    }
    return base;
  };
  map.setGroundTopOverlay(overlay);
  return overlay;
}

function composeBoxMatrix(
  matrix: THREE.Matrix4,
  x: number,
  y: number,
  z: number,
  yaw: number,
  sx: number,
  sy: number,
  sz: number
) {
  const position = new THREE.Vector3(x, y, z);
  const rotation = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw);
  matrix.compose(position, rotation, new THREE.Vector3(sx, sy, sz));
}

function makeCourtBoxes(
  specs: readonly GoldmanCourtSpec[],
  grades: ReadonlyMap<GoldmanCourtRef, number>,
  playingArea: boolean
): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: playingArea ? 0x285b46 : 0x668b6e,
    roughness: 0.9,
    metalness: 0
  });
  const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
  mesh.name = playingArea ? "goldman_court_playing_surfaces" : "goldman_court_runoff_pads";
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < specs.length; i++) {
    const court = specs[i];
    const y = grades.get(court.ref)!;
    composeBoxMatrix(
      matrix,
      court.x,
      playingArea ? y + COURT_PAINT_LIFT : y + COURT_PAD_TOP - COURT_PAD_THICKNESS / 2,
      court.z,
      court.yaw,
      playingArea ? court.playWidth : court.padWidth,
      playingArea ? 0.035 : COURT_PAD_THICKNESS,
      playingArea ? court.playLength : court.padLength
    );
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  return mesh;
}

type LineBox = { x: number; z: number; yaw: number; sx: number; sz: number; y: number };

function addCourtLine(
  out: LineBox[],
  court: GoldmanCourtSpec,
  y: number,
  lateral: number,
  along: number,
  sx: number,
  sz: number
) {
  const p = localPoint(court, lateral, along);
  out.push({ x: p.x, z: p.z, yaw: court.yaw, sx, sz, y });
}

function courtLines(court: GoldmanCourtSpec, y: number, out: LineBox[]) {
  const w = court.playWidth;
  const l = court.playLength;
  const lw = 0.055;
  // perimeter
  addCourtLine(out, court, y, -w / 2, 0, lw, l);
  addCourtLine(out, court, y, w / 2, 0, lw, l);
  addCourtLine(out, court, y, 0, -l / 2, w, lw);
  addCourtLine(out, court, y, 0, l / 2, w, lw);
  if (court.kind === "tennis") {
    const singlesHalf = 4.115;
    const service = 6.4;
    addCourtLine(out, court, y, -singlesHalf, 0, lw, l);
    addCourtLine(out, court, y, singlesHalf, 0, lw, l);
    addCourtLine(out, court, y, 0, -service, singlesHalf * 2, lw);
    addCourtLine(out, court, y, 0, service, singlesHalf * 2, lw);
    addCourtLine(out, court, y, 0, 0, lw, service * 2);
  } else {
    const kitchen = 2.134;
    addCourtLine(out, court, y, 0, -kitchen, w, lw);
    addCourtLine(out, court, y, 0, kitchen, w, lw);
    addCourtLine(out, court, y, 0, (-l / 2 - kitchen) / 2, lw, l / 2 - kitchen);
    addCourtLine(out, court, y, 0, (l / 2 + kitchen) / 2, lw, l / 2 - kitchen);
  }
}

function makeCourtLines(specs: readonly GoldmanCourtSpec[], grades: ReadonlyMap<GoldmanCourtRef, number>) {
  const boxes: LineBox[] = [];
  for (const court of specs) courtLines(court, grades.get(court.ref)! + LINE_LIFT, boxes);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xf5f1dc, roughness: 0.72, metalness: 0 }),
    boxes.length
  );
  mesh.name = "goldman_court_lines";
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < boxes.length; i++) {
    const line = boxes[i];
    composeBoxMatrix(matrix, line.x, line.y, line.z, line.yaw, line.sx, 0.018, line.sz);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  return mesh;
}

function makeNets(specs: readonly GoldmanCourtSpec[], anchors: ReadonlyMap<GoldmanCourtRef, GoldmanCourtAnchor>) {
  const panels = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x1b2420,
      roughness: 0.82,
      metalness: 0.08,
      transparent: true,
      opacity: 0.58,
      depthWrite: false
    }),
    specs.length
  );
  panels.name = "goldman_court_nets";
  const posts = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.045, 0.045, 1, 6),
    new THREE.MeshStandardMaterial({ color: 0x1b211f, roughness: 0.6, metalness: 0.35 }),
    specs.length * 2
  );
  posts.name = "goldman_court_net_posts";
  const matrix = new THREE.Matrix4();
  let postIndex = 0;
  for (let i = 0; i < specs.length; i++) {
    const court = specs[i];
    const anchor = anchors.get(court.ref)!;
    const height = court.kind === "tennis" ? 0.96 : 0.88;
    composeBoxMatrix(matrix, court.x, anchor.y + height / 2, court.z, court.yaw, court.playWidth + 0.65, height, 0.035);
    panels.setMatrixAt(i, matrix);
    for (const side of [-1, 1]) {
      const p = localPoint(court, side * (court.playWidth / 2 + 0.32), 0);
      composeBoxMatrix(matrix, p.x, anchor.y + height / 2, p.z, 0, 1, height + 0.16, 1);
      posts.setMatrixAt(postIndex++, matrix);
    }
  }
  panels.instanceMatrix.needsUpdate = true;
  posts.instanceMatrix.needsUpdate = true;
  panels.computeBoundingSphere();
  posts.computeBoundingSphere();
  panels.castShadow = true;
  posts.castShadow = true;
  enableLocalShadowLayer(panels);
  enableLocalShadowLayer(posts);
  return [panels, posts] as const;
}

function densify(points: readonly GoldmanXZ[], spacing = 4): GoldmanXZ[] {
  const dense: GoldmanXZ[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing));
    for (let k = 0; k < n; k++) {
      if (i > 0 && k === 0) continue;
      const t = k / n;
      dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  dense.push(points[points.length - 1]);
  return dense;
}

function makePaths(map: WorldMap, paths: readonly GoldmanPathSpec[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const path of paths) {
    const pts = densify(path.points);
    const base = positions.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dz = next[1] - prev[1];
      const inv = 1 / (Math.hypot(dx, dz) || 1);
      const nx = -dz * inv * (path.width / 2);
      const nz = dx * inv * (path.width / 2);
      for (const side of [-1, 1]) {
        const x = pts[i][0] + nx * side;
        const z = pts[i][1] + nz * side;
        positions.push(x, map.groundTop(x, z) + PATH_LIFT, z);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x77746b, roughness: 0.96, metalness: 0 })
  );
  mesh.name = "goldman_paths";
  mesh.receiveShadow = true;
  return mesh;
}

type FenceRun = { points: readonly GoldmanXZ[]; closed: boolean };

function isFenceOpening(x: number, z: number): boolean {
  if (x < -1354 && z > 2160 && z < 2232) return true; // clubhouse/main west entrance
  if (Math.hypot(x + 1328.34, z - 2267.42) < 2.7) return true; // central-spine south gate
  if (Math.hypot(x + 1294.97, z - 2130.5) < 2.35) return true; // north mini-court approach
  return false;
}

function makeFences(map: WorldMap, runs: readonly FenceRun[]) {
  const cells: { x: number; y: number; z: number; yaw: number; length: number }[] = [];
  const posts: { x: number; y: number; z: number }[] = [];
  for (const run of runs) {
    const source = run.closed ? [...run.points, run.points[0]] : [...run.points];
    const pts = densify(source, 3.2);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const x = (a[0] + b[0]) / 2;
      const z = (a[1] + b[1]) / 2;
      // The clubhouse itself completes the west perimeter; do not fence through it.
      if (isFenceOpening(x, z)) continue;
      const ground = map.groundTop(x, z);
      cells.push({ x, y: ground + FENCE_HEIGHT / 2, z, yaw: -Math.atan2(dz, dx), length: Math.hypot(dx, dz) });
      posts.push({ x: a[0], y: map.groundTop(a[0], a[1]) + FENCE_HEIGHT / 2, z: a[1] });
    }
  }
  const panels = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x26362e,
      roughness: 0.68,
      metalness: 0.32,
      transparent: true,
      opacity: 0.3,
      depthWrite: false
    }),
    cells.length
  );
  panels.name = "goldman_perimeter_fence_mesh";
  const postMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.075, 1, 0.075),
    new THREE.MeshStandardMaterial({ color: 0x202b25, roughness: 0.58, metalness: 0.42 }),
    posts.length
  );
  postMesh.name = "goldman_perimeter_fence_posts";
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    composeBoxMatrix(matrix, cell.x, cell.y, cell.z, cell.yaw, cell.length, FENCE_HEIGHT, 0.025);
    panels.setMatrixAt(i, matrix);
  }
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    composeBoxMatrix(matrix, post.x, post.y, post.z, 0, 1, FENCE_HEIGHT + 0.12, 1);
    postMesh.setMatrixAt(i, matrix);
  }
  panels.instanceMatrix.needsUpdate = true;
  postMesh.instanceMatrix.needsUpdate = true;
  panels.computeBoundingSphere();
  postMesh.computeBoundingSphere();
  return [panels, postMesh] as const;
}

function registerStaticBox(
  physics: Physics,
  bodies: number[],
  box: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number }
) {
  const body = physics.world.createBox({
    type: BodyType.Static,
    position: [box.x, box.y, box.z],
    halfExtents: [box.hx, box.hy, box.hz],
    friction: 0.72
  });
  const quat: [number, number, number, number] = [0, Math.sin(box.yaw / 2), 0, Math.cos(box.yaw / 2)];
  physics.world.setBodyTransform(body, [box.x, box.y, box.z], quat);
  physics.addQuerySolid(body, box);
  bodies.push(body);
}

function registerSiteColliders(
  map: WorldMap,
  physics: Physics,
  anchors: ReadonlyMap<GoldmanCourtRef, GoldmanCourtAnchor>,
  bodies: number[]
) {
  // Short panels follow the terrain closely, matching the rendered 10-ft runs.
  for (const run of [
    { points: GOLDMAN_SITE_OUTLINE, closed: true },
    { points: GOLDMAN_NORTHEAST_POD_OUTLINE, closed: true }
  ] as const) {
    const source = run.closed ? [...run.points, run.points[0]] : [...run.points];
    const pts = densify(source, 3.2);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const x = (a[0] + b[0]) / 2;
      const z = (a[1] + b[1]) / 2;
      if (isFenceOpening(x, z)) continue;
      registerStaticBox(physics, bodies, {
        x,
        y: map.groundTop(x, z) + FENCE_HEIGHT / 2,
        z,
        hx: Math.hypot(dx, dz) / 2,
        hy: FENCE_HEIGHT / 2,
        hz: 0.055,
        yaw: -Math.atan2(dz, dx)
      });
    }
  }
  // Nets are real waist-high obstacles for an exploring avatar. The reserved
  // 14B net is included here even though its visual belongs to the game layer.
  for (const court of GOLDMAN_COURTS) {
    const anchor = anchors.get(court.ref)!;
    const height = court.kind === "tennis" ? 0.96 : 0.88;
    registerStaticBox(physics, bodies, {
      x: court.x,
      y: anchor.y + height / 2,
      z: court.z,
      hx: court.playWidth / 2 + 0.32,
      hy: height / 2,
      hz: 0.045,
      yaw: court.yaw
    });
  }
}

function makeHippieHillEdge(map: WorldMap) {
  const path: GoldmanPathSpec = {
    name: "Hippie Hill edge",
    width: 1.7,
    points: [...HIPPIE_HILL_OUTLINE, HIPPIE_HILL_OUTLINE[0]]
  };
  const mesh = makePaths(map, [path]);
  mesh.name = "goldman_hippie_hill_edge_path";
  return mesh;
}

export class GoldenGateTennisSite {
  readonly group = new THREE.Group();
  readonly courtAnchors: ReadonlyMap<GoldmanCourtRef, GoldmanCourtAnchor>;
  readonly gameplayAnchor: GoldmanCourtAnchor;
  readonly reservedCourtRef: GoldmanPickleballCourtRef | null;
  #physics?: Physics;
  #bodies: number[] = [];
  #map: WorldMap;
  #groundOverlay?: GroundTopOverlay;
  #npcs?: ClubhouseNpcs;

  constructor(map: WorldMap, options: GoldenGateTennisSiteOptions = {}) {
    this.group.name = "goldman_tennis_center";
    this.#map = map;
    this.reservedCourtRef = options.reservedCourtRef === undefined ? DEFAULT_GAMEPLAY_COURT_REF : options.reservedCourtRef;
    this.#physics = options.physics;

    const grades = new Map<GoldmanCourtRef, number>();
    const anchors = new Map<GoldmanCourtRef, GoldmanCourtAnchor>();
    for (const court of GOLDMAN_COURTS) {
      const grade = courtGrade(map, court);
      grades.set(court.ref, grade);
      anchors.set(court.ref, {
        ref: court.ref,
        kind: court.kind,
        name: court.name ?? `Goldman ${court.kind} court ${court.ref}`,
        x: court.x,
        y: grade + COURT_SURFACE_LIFT,
        z: court.z,
        yaw: court.yaw,
        playWidth: court.playWidth,
        playLength: court.playLength,
        padWidth: court.padWidth,
        padLength: court.padLength
      });
    }
    this.courtAnchors = anchors;
    this.gameplayAnchor = anchors.get(this.reservedCourtRef ?? DEFAULT_GAMEPLAY_COURT_REF)!;

    const visibleCourts = GOLDMAN_COURTS.filter((court) => court.ref !== this.reservedCourtRef);
    this.group.add(makeCourtBoxes(visibleCourts, grades, false));
    this.group.add(makeCourtBoxes(visibleCourts, grades, true));
    this.group.add(makeCourtLines(visibleCourts, grades));
    this.group.add(...makeNets(visibleCourts, anchors));
    this.group.add(makePaths(map, GOLDMAN_PATHS));
    const clubhouse = buildClubhouse(map);
    this.group.add(clubhouse.group);
    this.group.add(
      ...makeFences(map, [
        { points: GOLDMAN_SITE_OUTLINE, closed: true },
        { points: GOLDMAN_NORTHEAST_POD_OUTLINE, closed: true }
      ])
    );
    this.group.add(makeHippieHillEdge(map));

    if (this.#physics) {
      try {
        registerSiteColliders(map, this.#physics, anchors, this.#bodies);
        // Clubhouse walls + furniture: solid everywhere but the two doorways.
        for (const spec of clubhouse.colliders) registerStaticBox(this.#physics, this.#bodies, spec);
      } catch (error) {
        for (const body of this.#bodies) {
          this.#physics.removeQuerySolid(body);
          this.#physics.world.destroyBody(body);
        }
        this.#bodies.length = 0;
        throw error;
      }
    }
    this.#groundOverlay = installSiteGrounding(map, grades, clubhouse);

    // Clubhouse crowd samples the post-overlay ground for its outdoor
    // waypoints, so it must come after the grounding install.
    this.#npcs = createClubhouseNpcs({
      floorTop: clubhouse.floorTop,
      groundTop: (x, z) => map.groundTop(x, z),
      daylight: options.daylight
    });
    this.group.add(this.#npcs.group);
  }

  /** Per-frame clubhouse-crowd driver. One squared distance and an early
   * return when the player is far — safe to call unconditionally. */
  update(dt: number, elapsed: number, playerPos: THREE.Vector3) {
    this.#npcs?.update(dt, elapsed, playerPos.x, playerPos.z);
  }

  /** The site's grounding sheet (court terraces + clubhouse floor/ramps).
   *  WorldMap overlays now COMPOSE (heightmap.ts keeps a list), so the deferred
   *  Presidio golf overlay no longer evicts this one. Exposed for probes. */
  get groundOverlay(): GroundTopOverlay | undefined {
    return this.#groundOverlay;
  }

  getCourtAnchor(ref: GoldmanCourtRef): GoldmanCourtAnchor {
    const anchor = this.courtAnchors.get(ref);
    if (!anchor) throw new Error(`[goldman tennis] unknown court ref ${ref}`);
    return anchor;
  }

  setFoliageVisible(visible: boolean) {
    // Compatibility surface for the app-wide foliage toggle. Goldman/Hippie
    // Hill trees are owned by the deferred wildlands SeedForest now, so the
    // site itself has no foliage subtree to toggle.
    void visible;
  }

  addTo(scene: THREE.Scene): this {
    scene.add(this.group);
    // Fully static site: world matrices computed once, subtree leaves the
    // scene's per-frame matrix pass. Anything later parented under this group
    // would need a manual updateMatrixWorld(true).
    this.group.updateMatrixWorld(true);
    this.group.matrixWorldAutoUpdate = false;
    return this;
  }

  dispose() {
    // NPC rigs share rig.ts's geometry cache with the player — detach them
    // before the traverse below can dispose those shared boxes.
    this.#npcs?.dispose();
    this.#npcs = undefined;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    if (this.#physics) {
      for (const body of this.#bodies) {
        this.#physics.removeQuerySolid(body);
        this.#physics.world.destroyBody(body);
      }
      this.#bodies.length = 0;
    }
    if (this.#groundOverlay) this.#map.clearGroundTopOverlay(this.#groundOverlay);
    this.#groundOverlay = undefined;
    this.group.removeFromParent();
  }
}

export function createGoldenGateTennisSite(map: WorldMap, options?: GoldenGateTennisSiteOptions) {
  return new GoldenGateTennisSite(map, options);
}
