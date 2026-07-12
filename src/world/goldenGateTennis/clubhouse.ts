import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldMap } from "../heightmap";
import type { GoldmanXZ } from "./layout";

/**
 * Taube Family Clubhouse — enterable rebuild of EHDD's low horizontal pavilion
 * (https://ehdd.com/project/golden-gate-park-tennis-center/): a long thin bar
 * with a solid park-facing west wall, a broad flat roof, and a full-height
 * glass ribbon looking east over the courts.
 *
 * The surveyed OSM footprint (way 959594549) is a bar that flares into a
 * south-west service wedge. The enterable interior is the rectified bar,
 * framed off the footprint's straight east edge so the glass ribbon lands
 * exactly where the old solid extrude put it; the wedge stays as a solid low
 * annex so the park-side silhouette survives the hollowing.
 *
 * Interior grounding is NOT handled here — the site's shared ground-top
 * overlay (index.ts) walks the player onto `floorTop` inside the bar and down
 * the door ramps, exactly the way the terraced court pads work.
 */

/** Local frame of the enterable bar. +u = east (toward the courts), +v =
 * south along the bar. Yaw follows the OSM east edge (v0 -> v7), which drifts
 * ~1.7 deg west going south. */
export const CLUBHOUSE_FRAME = {
  cx: -1363.78,
  cz: 2197.26,
  yaw: -0.02922,
  halfW: 4.1,
  halfL: 28.0
} as const;

// Door gaps are wall openings, not door leaves — always walkable. The player
// capsule is ~0.6 m wide; both openings stay >= 2 m clear.
export const CLUBHOUSE_DOOR_EAST = { v: -14.3, halfWidth: 1.1 } as const; // court-side entry, on the clubhouse-court-link path
export const CLUBHOUSE_DOOR_WEST = { v: -16.0, halfWidth: 1.0 } as const; // park entrance, inside the existing fence opening
const RAMP_LENGTH = 3.2;
const WALL_TOP = 3.4; // interior ceiling height over the floor
const WALL_SKIRT = 1.5; // walls run below the floor so the slope never shows a gap
const SILL_H = 0.82; // glass ribbon sill on the court side
const HEAD_Y = 2.95; // glass ribbon head; header band above it

const COS = Math.cos(CLUBHOUSE_FRAME.yaw);
const SIN = Math.sin(CLUBHOUSE_FRAME.yaw);

export function clubhouseToWorld(u: number, v: number): { x: number; z: number } {
  return {
    x: CLUBHOUSE_FRAME.cx + u * COS + v * SIN,
    z: CLUBHOUSE_FRAME.cz - u * SIN + v * COS
  };
}

export function clubhouseToLocal(x: number, z: number): { u: number; v: number } {
  const du = x - CLUBHOUSE_FRAME.cx;
  const dz = z - CLUBHOUSE_FRAME.cz;
  return { u: du * COS - dz * SIN, v: du * SIN + dz * COS };
}

/** Yawed static collider box, in the same shape registerStaticBox consumes. */
export type ClubhouseColliderSpec = {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
};

export type ClubhouseBuild = {
  /** World-space root: frame-local bar + world-space annex wedge. */
  group: THREE.Group;
  /** Interior walking surface (world y). */
  floorTop: number;
  colliders: ClubhouseColliderSpec[];
  /** Ground-top overlay contribution: floor inside the bar, ramps at the two
   * doors, null anywhere the clubhouse doesn't own the ground. */
  groundTopAt(x: number, z: number, base: number): number | null;
};

/* --------------------------------------------------- geometry batch helpers */

function box(
  list: THREE.BufferGeometry[],
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  ry = 0,
  rz = 0
) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  list.push(g);
}

function merged(list: THREE.BufferGeometry[], material: THREE.Material, name: string): THREE.Mesh {
  const geometry = mergeGeometries(list, false)!;
  for (const g of list) g.dispose();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

function polygonShape(points: readonly GoldmanXZ[], anchor: GoldmanXZ) {
  const shape = new THREE.Shape();
  for (let i = 0; i < points.length; i++) {
    const x = points[i][0] - anchor[0];
    const y = -(points[i][1] - anchor[1]);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/* ------------------------------------------------------------------- build */

export function buildClubhouse(map: WorldMap): ClubhouseBuild {
  const F = CLUBHOUSE_FRAME;

  // Floor terrace: like the court pads, sit above the highest baked terrain
  // sample under the BAR (not the full outline — the annex wedge runs uphill
  // toward the park and would hoist the lobby ~1.7 m over the court doors).
  // Dense 1 m sampling plus a drape margin: the GG Park lawns are CDT-draped
  // skins that ride slightly proud of the baked grid, and a lawn hump inside
  // the lobby reads far worse than the low door-ramp step this leaves.
  let grade = -Infinity;
  for (let v = -F.halfL; v <= F.halfL; v += 1) {
    for (let u = -F.halfW; u <= F.halfW; u += 1) {
      const p = clubhouseToWorld(u, v);
      grade = Math.max(grade, map.baseGroundTop(p.x, p.z));
    }
  }
  const floorTop = grade + 0.3;

  const root = new THREE.Group();
  root.name = "goldman_taube_family_clubhouse";
  const frame = new THREE.Group();
  frame.name = "goldman_clubhouse_bar";
  frame.position.set(F.cx, floorTop, F.cz);
  frame.rotation.y = F.yaw;
  root.add(frame);

  // Materials are per-build (the site is a singleton and dispose() traverses).
  const MAT_WALL = new THREE.MeshStandardMaterial({ color: 0xd8d0bb, roughness: 0.82, metalness: 0 });
  const MAT_ROOF = new THREE.MeshStandardMaterial({ color: 0x5a5547, roughness: 0.88, metalness: 0 });
  const MAT_FLOOR = new THREE.MeshStandardMaterial({ color: 0xa89272, roughness: 0.66, metalness: 0 });
  const MAT_DARK = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.5, metalness: 0.35 });
  const MAT_WOOD = new THREE.MeshStandardMaterial({ color: 0x8a6844, roughness: 0.7, metalness: 0 });
  const MAT_WHITE = new THREE.MeshStandardMaterial({ color: 0xece7db, roughness: 0.88, metalness: 0 });
  const MAT_ACCENT = new THREE.MeshStandardMaterial({ color: 0x2e5f49, roughness: 0.8, metalness: 0 });
  const MAT_GOLD = new THREE.MeshStandardMaterial({ color: 0xd9a93b, roughness: 0.32, metalness: 0.85 });
  const MAT_GLASS = new THREE.MeshStandardMaterial({
    color: 0x71919a,
    roughness: 0.18,
    metalness: 0.12,
    transparent: true,
    opacity: 0.42,
    depthWrite: false
  });
  const MAT_CASE_GLASS = new THREE.MeshStandardMaterial({
    color: 0xa9c4c9,
    roughness: 0.1,
    metalness: 0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false
  });
  // Fake interior lighting: bright unlit strips, never a THREE.Light. The
  // ceiling panel is unlit too — a lit Standard ceiling only receives the
  // hemisphere's ground bounce from below and reads as a mud-brown cave.
  const MAT_LIGHT = new THREE.MeshBasicMaterial({ color: 0xfff0cf });
  const MAT_CEILING = new THREE.MeshBasicMaterial({ color: 0xb5aea0 });

  const dE = CLUBHOUSE_DOOR_EAST;
  const dW = CLUBHOUSE_DOOR_WEST;
  const wallH = WALL_TOP + WALL_SKIRT;
  const wallCY = (WALL_TOP - WALL_SKIRT) / 2;

  /* ---- shell: walls / glass / roof / floor ---- */
  const walls: THREE.BufferGeometry[] = [];
  const darks: THREE.BufferGeometry[] = [];
  const glasses: THREE.BufferGeometry[] = [];
  const floors: THREE.BufferGeometry[] = [];

  // end walls
  box(walls, F.halfW * 2 + 0.34, wallH, 0.34, 0, wallCY, -F.halfL);
  box(walls, F.halfW * 2 + 0.34, wallH, 0.34, 0, wallCY, F.halfL);
  // solid park-facing west wall, split around the park entrance
  const wA = dW.v - dW.halfWidth;
  const wB = dW.v + dW.halfWidth;
  box(walls, 0.34, wallH, wA - -F.halfL, -F.halfW, wallCY, (-F.halfL + wA) / 2);
  box(walls, 0.34, wallH, F.halfL - wB, -F.halfW, wallCY, (wB + F.halfL) / 2);
  box(walls, 0.34, WALL_TOP - 2.35, 2 * dW.halfWidth, -F.halfW, (2.35 + WALL_TOP) / 2, dW.v); // west door header
  box(darks, 0.18, wallH, 0.18, -F.halfW, wallCY, wA - 0.09); // west door frame posts
  box(darks, 0.18, wallH, 0.18, -F.halfW, wallCY, wB + 0.09);

  // court-facing east side: low sill + header band + glass ribbon + mullions,
  // split around the main court entry
  const eA = dE.v - dE.halfWidth;
  const eB = dE.v + dE.halfWidth;
  const sillH = SILL_H + WALL_SKIRT;
  const sillCY = (SILL_H - WALL_SKIRT) / 2;
  box(walls, 0.34, sillH, eA - -F.halfL, F.halfW, sillCY, (-F.halfL + eA) / 2);
  box(walls, 0.34, sillH, F.halfL - eB, F.halfW, sillCY, (eB + F.halfL) / 2);
  box(walls, 0.34, WALL_TOP - HEAD_Y, F.halfL * 2, F.halfW, (HEAD_Y + WALL_TOP) / 2, 0); // header band, continuous
  const glassH = HEAD_Y - SILL_H;
  const glassCY = (SILL_H + HEAD_Y) / 2;
  box(glasses, 0.1, glassH, eA - -F.halfL, F.halfW + 0.03, glassCY, (-F.halfL + eA) / 2);
  box(glasses, 0.1, glassH, F.halfL - eB, F.halfW + 0.03, glassCY, (eB + F.halfL) / 2);
  for (let v = -24; v <= 24; v += 4) {
    if (v > eA - 0.4 && v < eB + 0.4) continue;
    box(darks, 0.14, glassH, 0.14, F.halfW, glassCY, v);
  }
  box(darks, 0.18, wallH, 0.18, F.halfW, wallCY, eA - 0.1); // east door frame posts
  box(darks, 0.18, wallH, 0.18, F.halfW, wallCY, eB + 0.1);

  // flat overhanging roof; its underside IS the interior ceiling
  const roof = new THREE.Mesh(new THREE.BoxGeometry(F.halfW * 2 + 2.2, 0.32, F.halfL * 2 + 1.8), MAT_ROOF);
  roof.name = "goldman_clubhouse_low_roof";
  roof.position.set(0.5, WALL_TOP + 0.16, 0); // extra eave toward the courts
  roof.castShadow = true;
  frame.add(roof);

  // interior slab, visually distinct from the court paths
  box(floors, F.halfW * 2 - 0.06, 0.12, F.halfL * 2 - 0.06, 0, -0.06, 0);
  // door ramps down to whatever the terrain does outside (visual twin of the
  // grounding overlay's lerp; skipped when the ground already meets the floor)
  const gEast = map.baseGroundTop(clubhouseToWorld(F.halfW + RAMP_LENGTH, dE.v).x, clubhouseToWorld(F.halfW + RAMP_LENGTH, dE.v).z);
  const dropE = floorTop - gEast;
  if (dropE > 0.03) {
    box(floors, RAMP_LENGTH + 0.3, 0.12, dE.halfWidth * 2 + 0.5, F.halfW + RAMP_LENGTH / 2, -dropE / 2 - 0.04, dE.v, 0, -Math.atan2(dropE, RAMP_LENGTH));
  }
  const pW = clubhouseToWorld(-F.halfW - RAMP_LENGTH, dW.v);
  const dropW = floorTop - map.baseGroundTop(pW.x, pW.z);
  if (dropW > 0.03) {
    box(floors, RAMP_LENGTH + 0.3, 0.12, dW.halfWidth * 2 + 0.5, -F.halfW - RAMP_LENGTH / 2, -dropW / 2 - 0.04, dW.v, 0, Math.atan2(dropW, RAMP_LENGTH));
  }

  /* ---- interior: reception / pro shop / lounge ---- */
  const woods: THREE.BufferGeometry[] = [];
  const whites: THREE.BufferGeometry[] = [];
  const accents: THREE.BufferGeometry[] = [];
  const golds: THREE.BufferGeometry[] = [];
  const lights: THREE.BufferGeometry[] = [];

  // Reception desk faces the court entry (door at v = -14.3); the
  // receptionist NPC stands behind it against the towel wall.
  box(woods, 0.9, 1.02, 4.5, -0.72, 0.51, -13.5); // counter body
  box(woods, 1.1, 0.06, 4.8, -0.72, 1.05, -13.5); // counter top
  box(darks, 0.04, 0.3, 0.42, -0.62, 1.33, -12.5); // check-in monitor
  box(darks, 0.05, 0.14, 0.06, -0.62, 1.13, -12.5);
  for (const v of [-14.9, -12.2]) box(accents, 0.09, 0.3, 0.09, -0.5, 1.23, v); // ball-tube stacks on the counter

  // back wall: towel shelf behind reception
  box(woods, 0.05, 2.2, 3.8, -3.9, 1.1, -13.5);
  for (const y of [0.68, 1.28, 1.88]) box(woods, 0.42, 0.05, 3.8, -3.7, y, -13.5);
  for (let i = 0; i < 6; i++) {
    const y = 0.78 + (i % 3) * 0.6;
    const v = -14.6 + Math.floor(i / 3) * 1.4 + (i % 3) * 0.5;
    box(whites, 0.34, 0.16, 0.28, -3.7, y, v); // folded towel stacks
  }
  for (const v of [-12.4, -13.9]) box(accents, 0.09, 0.28, 0.09, -3.7, 0.85, v); // spare ball tubes

  // lounge along the glass: two benches + a low table, looking back into the room
  for (const v of [3.0, 9.6]) {
    box(woods, 0.5, 0.09, 1.9, 3.25, 0.44, v);
    for (const dv of [-0.82, 0.82]) box(darks, 0.06, 0.42, 0.06, 3.25, 0.21, v + dv);
  }
  box(woods, 0.72, 0.05, 1.12, 2.5, 0.42, 6.3);
  for (const [du, dv] of [[-0.3, -0.48], [0.3, -0.48], [-0.3, 0.48], [0.3, 0.48]] as const) {
    box(darks, 0.05, 0.4, 0.05, 2.5 + du, 0.2, 6.3 + dv);
  }

  // trophy case on the west wall: wood plinth, glass hood, three gold cups
  box(woods, 0.62, 0.95, 1.6, -3.55, 0.475, -3.0);
  box(golds, 0.02, 0.02, 0.02, 0, 0, 0); // merge seed so the gold list is never empty
  for (const v of [-3.5, -3.0, -2.5]) {
    const cup = new THREE.CylinderGeometry(0.055, 0.035, 0.16, 10);
    cup.translate(-3.55, 1.06, v);
    golds.push(cup);
    const bowl = new THREE.SphereGeometry(0.055, 10, 8);
    bowl.scale(1, 0.7, 1);
    bowl.translate(-3.55, 1.17, v);
    golds.push(bowl);
  }
  const caseGlass = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.82, 1.54), MAT_CASE_GLASS);
  caseGlass.name = "goldman_clubhouse_trophy_glass";
  caseGlass.position.set(-3.55, 1.36, -3.0);
  frame.add(caseGlass);

  // pro-shop corner at the south end: wall shelves, a gondola, leaning rackets
  box(woods, 0.05, 2.0, 5.6, -3.9, 1.0, 24.2);
  for (const y of [0.6, 1.2, 1.8]) box(woods, 0.44, 0.05, 5.6, -3.68, y, 24.2);
  for (let i = 0; i < 8; i++) {
    const list = i % 2 ? whites : accents;
    box(list, 0.3, 0.22, 0.24, -3.68, 0.74 + (i % 2) * 0.6, 21.9 + (i % 4) * 1.5); // boxed gear / apparel stacks
  }
  box(woods, 0.6, 1.1, 2.6, -0.5, 0.55, 24.5); // gondola
  for (let i = 0; i < 4; i++) {
    // display rackets: box handle + flattened torus head, leaning on the gondola
    const v = 23.5 + i * 0.65;
    const lean = 0.32;
    const handle = new THREE.BoxGeometry(0.035, 0.34, 0.035);
    handle.rotateZ(lean);
    handle.translate(-0.14, 1.27, v);
    darks.push(handle);
    const head = new THREE.TorusGeometry(0.115, 0.017, 6, 14);
    head.scale(1, 1.28, 1);
    head.rotateY(Math.PI / 2);
    head.rotateZ(lean);
    head.translate(-0.24, 1.55, v);
    darks.push(head);
  }

  // wall pennants over the west wall + a rug runner down the public corridor
  for (let i = 0; i < 6; i++) {
    const v = i < 3 ? -9 + i * 2.2 : 6.6 + (i - 3) * 2.2;
    box(i % 2 ? whites : accents, 0.04, 0.36, 0.26, -3.9, 2.45, v);
  }
  box(accents, 1.5, 0.025, 11.5, 2.0, 0.012, -11.5);
  box(accents, 1.5, 0.025, 13.5, 2.0, 0.012, 7.5);

  // ceiling panel hung under the roof slab, kept a clear 2 cm off the roof
  // underside (roof bottom sits at WALL_TOP exactly; coplanar = z-fight under
  // reversed-z)
  const ceilings: THREE.BufferGeometry[] = [];
  box(ceilings, F.halfW * 2 - 0.1, 0.04, F.halfL * 2 - 0.1, 0, WALL_TOP - 0.04, 0);

  // ceiling light strips (emissive boxes under the roof — the interior "glow")
  for (const v of [-18, 0, 18]) box(lights, 0.32, 0.05, 14, 0.4, WALL_TOP - 0.06, v);
  box(lights, 0.32, 0.05, 4.6, -1.6, WALL_TOP - 0.06, -13.5); // over reception

  const wallMesh = merged(walls, MAT_WALL, "goldman_clubhouse_walls");
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  const floorMesh = merged(floors, MAT_FLOOR, "goldman_clubhouse_floor");
  floorMesh.receiveShadow = true;
  const woodMesh = merged(woods, MAT_WOOD, "goldman_clubhouse_furniture");
  woodMesh.receiveShadow = true;
  frame.add(
    wallMesh,
    floorMesh,
    woodMesh,
    merged(darks, MAT_DARK, "goldman_clubhouse_frames"),
    merged(glasses, MAT_GLASS, "goldman_clubhouse_court_facing_glass"),
    merged(whites, MAT_WHITE, "goldman_clubhouse_soft_goods"),
    merged(accents, MAT_ACCENT, "goldman_clubhouse_accents"),
    merged(golds, MAT_GOLD, "goldman_clubhouse_trophies"),
    merged(ceilings, MAT_CEILING, "goldman_clubhouse_ceiling"),
    merged(lights, MAT_LIGHT, "goldman_clubhouse_light_strips")
  );

  // Solid south-west service wedge (the rest of the surveyed footprint) so the
  // park-side massing still reads like the built pavilion.
  const wedge: readonly GoldmanXZ[] = [
    [-1368.15, 2187.25],
    [-1376.75, 2211.21],
    [-1386.45, 2224.51],
    [-1377.68, 2227.76],
    [-1375.19, 2228.69],
    [-1368.9, 2227.2]
  ];
  const annexGeo = new THREE.ExtrudeGeometry(polygonShape(wedge, wedge[0]), {
    depth: 5.0,
    bevelEnabled: false,
    steps: 1
  });
  annexGeo.rotateX(-Math.PI / 2);
  annexGeo.translate(wedge[0][0], grade - 2.2, wedge[0][1]);
  const annex = new THREE.Mesh(annexGeo, MAT_WALL);
  annex.name = "goldman_clubhouse_annex";
  annex.castShadow = true;
  annex.receiveShadow = true;
  root.add(annex);

  /* ---- colliders ---- */
  const colliders: ClubhouseColliderSpec[] = [];
  const wallHY = wallH / 2;
  const wallY = floorTop + wallCY;
  const alongV = (u: number, v0: number, v1: number, hx: number, hy: number, cy: number) => {
    const p = clubhouseToWorld(u, (v0 + v1) / 2);
    colliders.push({ x: p.x, y: cy, z: p.z, hx, hy, hz: (v1 - v0) / 2, yaw: F.yaw });
  };
  const alongU = (u0: number, u1: number, v: number, hz: number, hy: number, cy: number) => {
    const p = clubhouseToWorld((u0 + u1) / 2, v);
    colliders.push({ x: p.x, y: cy, z: p.z, hx: (u1 - u0) / 2, hy, hz, yaw: F.yaw });
  };
  // shell: full-height everywhere except the two door gaps (glass is solid too)
  alongU(-F.halfW - 0.2, F.halfW + 0.2, -F.halfL, 0.18, wallHY, wallY);
  alongU(-F.halfW - 0.2, F.halfW + 0.2, F.halfL, 0.18, wallHY, wallY);
  alongV(-F.halfW, -F.halfL, wA, 0.18, wallHY, wallY);
  alongV(-F.halfW, wB, F.halfL, 0.18, wallHY, wallY);
  alongV(F.halfW, -F.halfL, eA, 0.18, wallHY, wallY);
  alongV(F.halfW, eB, F.halfL, 0.18, wallHY, wallY);
  // furniture the player could otherwise wade through
  const solid = (u: number, v: number, hx: number, hy: number, hz: number) => {
    const p = clubhouseToWorld(u, v);
    colliders.push({ x: p.x, y: floorTop + hy, z: p.z, hx, hy, hz, yaw: F.yaw });
  };
  solid(-0.72, -13.5, 0.56, 0.54, 2.4); // reception desk
  solid(-3.72, -13.5, 0.26, 1.1, 1.95); // towel shelf
  solid(-3.55, -3.0, 0.34, 0.9, 0.85); // trophy case
  solid(-3.72, 24.2, 0.26, 1.0, 2.85); // shop wall shelves
  solid(-0.5, 24.5, 0.34, 0.56, 1.35); // shop gondola
  solid(3.25, 3.0, 0.28, 0.24, 0.98); // benches
  solid(3.25, 9.6, 0.28, 0.24, 0.98);
  solid(2.5, 6.3, 0.4, 0.22, 0.6); // low table
  // annex wedge barriers (visual mass is an extrude; three edge boxes keep the
  // west perimeter closed without a full decomposition)
  const edge = (a: GoldmanXZ, b: GoldmanXZ) => {
    const x = (a[0] + b[0]) / 2;
    const z = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    colliders.push({
      x,
      y: grade + 0.6,
      z,
      hx: Math.hypot(dx, dz) / 2,
      hy: 2.4,
      hz: 0.6,
      yaw: -Math.atan2(dz, dx)
    });
  };
  edge(wedge[0], wedge[1]);
  edge(wedge[1], wedge[2]);
  edge(wedge[2], wedge[4]);

  /* ---- grounding overlay contribution ---- */
  const groundTopAt = (x: number, z: number, base: number): number | null => {
    const du = x - F.cx;
    const dz = z - F.cz;
    if (du * du + dz * dz > 1225) return null; // 35 m broad-phase around the bar
    const u = du * COS - dz * SIN;
    const v = du * SIN + dz * COS;
    if (Math.abs(v) > F.halfL) return null;
    if (Math.abs(u) <= F.halfW) return floorTop;
    if (u > F.halfW && u <= F.halfW + RAMP_LENGTH && Math.abs(v - dE.v) <= dE.halfWidth + 0.5) {
      const t = (u - F.halfW) / RAMP_LENGTH;
      return Math.max(base, floorTop + (base - floorTop) * t);
    }
    if (u < -F.halfW && u >= -F.halfW - RAMP_LENGTH && Math.abs(v - dW.v) <= dW.halfWidth + 0.5) {
      const t = (-F.halfW - u) / RAMP_LENGTH;
      return Math.max(base, floorTop + (base - floorTop) * t);
    }
    return null;
  };

  return { group: root, floorTop, colliders, groundTopAt };
}
