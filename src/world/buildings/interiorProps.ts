// Shared toolkit for procedural building interiors (see interior.ts).
//
// PERF CONTRACT (load-bearing — the streaming ring builds/disposes these every
// time the player crosses 40 m near ~40 resident buildings):
//   • Exactly TWO shared BufferGeometries live here (a unit box + a unit cylinder).
//     Every prop is one of those geometries scaled/positioned per-mesh — a build
//     allocates ZERO geometry, and dispose is just detaching the group.
//   • Every material is a module-level singleton created ONCE and reused across
//     all buildings for all time. No material is ever created per-build or
//     per-mesh. Colour variety comes from picking out of fixed palettes by seed.
//   • No THREE lights anywhere — the app has a fixed LightPool and any added
//     light forces a ~7 s scene-wide pipeline rebuild. Interior light is emissive
//     materials only (ceiling tubes, neon signs, screens, fridge/window glow),
//     bright enough to read under the app's tonemapping.
//
// Everything is authored in BUILDING-LOCAL, Y-up metres: origin = base centre,
// +x along the length (front span), -z toward the open storefront, +y up. Every
// composite prop takes a floor base `y0` and adds it to all of its Y coordinates
// (meshes AND colliders) so the same prop code furnishes any storey correctly.
import * as THREE from "three/webgpu";

/** local axis-aligned box collider (building-local metres, pre-yaw) */
export interface LocalBox {
  x: number; y: number; z: number;   // centre
  hx: number; hy: number; hz: number; // half extents
}

// ---- the only two geometries in the whole interior system ------------------
export const UNIT = new THREE.BoxGeometry(1, 1, 1);
export const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);

// A build target: the group meshes are added to + the collider list they feed.
export interface Build {
  g: THREE.Group;
  col: LocalBox[];
}

// ---------------------------------------------------------------------------
// Materials — all module-level singletons. This renderer has NO global
// illumination and interiors are sealed by a ceiling, so the scene barely lights
// the inside. Every surface therefore carries a moderate SELF-emissive of its
// own albedo (`lit`) so the room reads as a warm, lived-in diorama at any time of
// day; pure light sources (`glow`) have a black albedo so only the emissive term
// shows, and burn much brighter for highlights (lamps, neon, screens).
// ---------------------------------------------------------------------------
function lit(color: number, rough: number, glowFrac = 0.45, metal = 0) {
  return new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal,
    emissive: new THREE.Color(color), emissiveIntensity: glowFrac,
  });
}
function glow(emissive: number, ei: number) {
  return new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 1, metalness: 0,
    emissive: new THREE.Color(emissive), emissiveIntensity: ei,
  });
}

// structural
export const matFloor = lit(0x9c8e78, 0.9, 0.55, 0.02);
export const matFloorWood = lit(0x7c5330, 0.82, 0.6, 0.02);
export const matCeil = lit(0xb3ab9c, 0.95, 0.42);
export const matStair = lit(0xb0a48c, 0.82, 0.62, 0.04);
export const matRail = lit(0x4c515c, 0.5, 0.4, 0.6);
export const matPartition = lit(0xd7d2c6, 0.94, 0.52);
// shop / room wall tints
export const matWallCool = lit(0xd8d4cb, 0.94, 0.54);
export const matWallWarm = lit(0xcdb493, 0.92, 0.58);
export const matWallTech = lit(0x59636f, 0.7, 0.6, 0.1);
export const matWallHerb = lit(0xc6ad82, 0.9, 0.58);

// furniture / props
export const matWood = lit(0xb27a44, 0.7, 0.62, 0.03);
export const matWoodDark = lit(0x714c2b, 0.72, 0.6);
export const matMetal = lit(0xbcc0c6, 0.34, 0.52, 0.85);
export const matDark = lit(0x474c54, 0.6, 0.54, 0.2); // plastic/electronics
export const matWhite = lit(0xe6e3da, 0.6, 0.62);     // ceramic / porcelain
export const matFabric = [
  lit(0xb0524f, 0.95, 0.72),  // red
  lit(0x4c6f9c, 0.95, 0.72),  // blue
  lit(0x548b60, 0.95, 0.72),  // green
  lit(0xc39a45, 0.95, 0.72),  // mustard
  lit(0x8a5f8d, 0.95, 0.72),  // plum
  lit(0xa6a69c, 0.95, 0.72),  // grey
];
export const matGoods = [
  lit(0xd0442f, 0.7, 0.82), // red
  lit(0x2fbf6c, 0.7, 0.82), // green
  lit(0x3a80c4, 0.7, 0.82), // blue
  lit(0xe0b81e, 0.7, 0.82), // yellow
  lit(0xe06010, 0.7, 0.82), // orange
  lit(0xecf0f1, 0.7, 0.7),  // white
];

// emissive light sources
export const matLampWarm = glow(0xfff2d0, 16);
export const matLampCool = glow(0xe6eeff, 14);
export const matScreen = glow(0x9fd0ff, 6.5);
export const matScreenWarm = glow(0xffd59a, 5.5);
export const matFridge = glow(0xd2ecff, 4);
export const matWindow = glow(0xdbe4ee, 1.8);   // neutral, dim — avoids a teal cast
export const matEmber = glow(0xff7a2a, 4.6);
// neon sign palette (fixed hues; pick by seed)
export const NEON = [
  glow(0xff2d4a, 9),   // red
  glow(0xff3ea0, 9),   // magenta
  glow(0x28e0ff, 9),   // cyan
  glow(0x39ff7a, 8.5), // green
  glow(0xffa020, 9),   // orange
  glow(0xffd23a, 9),   // gold
];

// ---- tiny deterministic PRNG (mulberry32) — pure function of seed -----------
export function rng(seed: number): () => number {
  let a = (seed | 0) + 0x6d2b79f5;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function pick<T>(arr: T[], rand: () => number): T {
  return arr[(rand() * arr.length) | 0];
}

// ---- primitive placers ------------------------------------------------------
/** scaled unit box; optionally registers a matching AABB collider */
export function box(
  b: Build, mat: THREE.Material,
  x: number, y: number, z: number, hx: number, hy: number, hz: number,
  collide = false, cast = false,
): THREE.Mesh {
  const m = new THREE.Mesh(UNIT, mat);
  m.position.set(x, y, z);
  m.scale.set(hx * 2, hy * 2, hz * 2);
  m.castShadow = cast;
  m.receiveShadow = true;
  b.g.add(m);
  if (collide) b.col.push({ x, y, z, hx, hy, hz });
  return m;
}
/** scaled unit cylinder (axis = y). rarely collides (round decor) */
export function cyl(
  b: Build, mat: THREE.Material,
  x: number, y: number, z: number, r: number, hy: number, rz = r,
): THREE.Mesh {
  const m = new THREE.Mesh(CYL, mat);
  m.position.set(x, y, z);
  m.scale.set(r * 2, hy * 2, rz * 2);
  m.receiveShadow = true;
  b.g.add(m);
  return m;
}

// ---------------------------------------------------------------------------
// Composite props. `y0` = floor base height; added to every Y so one prop
// furnishes any storey. `rand` keeps goods/colours deterministic per seed.
// ---------------------------------------------------------------------------

/** warm ceiling tube light (emissive, no collider) */
export function ceilingStrip(b: Build, x: number, y: number, z: number, hx: number, mat = matLampWarm) {
  box(b, mat, x, y, z, hx, 0.05, 0.16);
}

/** a lit "window" panel flush inside a wall (emissive daylight, no collider) */
export function windowGlow(b: Build, x: number, y: number, z: number, hx: number, hy: number, hz: number, mat = matWindow) {
  box(b, mat, x, y, z, hx, hy, hz);
}

/** a wall-mounted glowing sign board facing -z (the storefront) */
export function signBoard(b: Build, mat: THREE.Material, x: number, y: number, z: number, hx: number, hy: number) {
  box(b, matDark, x, y, z + 0.02, hx + 0.06, hy + 0.06, 0.04); // dark frame behind
  box(b, mat, x, y, z, hx, hy, 0.03);                          // glowing face
}

/** a shop counter (collider) with a wood body + darker top lip */
export function counter(b: Build, y0: number, x: number, z: number, hx: number, hz: number, h = 1.0, mat = matWood) {
  box(b, mat, x, y0 + h * 0.5, z, hx, h * 0.5, hz, true);
  box(b, matWoodDark, x, y0 + h + 0.03, z, hx + 0.03, 0.04, hz + 0.03);
}

/** a gondola shelf unit filled with colourful goods. One collider (the base). */
export function shelfUnit(
  b: Build, rand: () => number, y0: number,
  x: number, z: number, hx: number, hz: number, h: number,
  frameMat = matDark,
) {
  hx = Math.min(hx, 1.6);   // caps keep goods count bounded on huge footprints
  box(b, frameMat, x, y0 + h * 0.5, z, hx, h * 0.5, hz, true, true);
  const shelves = Math.min(Math.max(2, Math.round(h / 0.55)), 4);
  for (let s = 1; s <= shelves; s++) {
    const sy = y0 + (h / (shelves + 1)) * s;
    box(b, matWoodDark, x, sy, z, hx - 0.02, 0.025, hz - 0.02);
    const n = Math.min(Math.max(2, Math.floor((hx * 2) / 0.34)), 6);
    for (let i = 0; i < n; i++) {
      const gx = x - hx + 0.18 + i * ((hx * 2 - 0.36) / Math.max(1, n - 1));
      const gh = 0.1 + rand() * 0.14;
      const mat = pick(matGoods, rand);
      if (rand() < 0.35) cyl(b, mat, gx, sy + 0.025 + gh, z, 0.07, gh);
      else box(b, mat, gx, sy + 0.025 + gh, z, 0.08, gh, Math.min(hz - 0.05, 0.12));
    }
  }
}

/** apothecary drawer cabinet: grid of little wood fronts. One collider. */
export function drawerWall(b: Build, y0: number, x: number, z: number, hx: number, yTop: number, faceDir = -1) {
  hx = Math.min(hx, 1.9);
  const h = yTop;
  box(b, matWoodDark, x, y0 + h * 0.5, z, hx, h * 0.5, 0.22, true, true);
  const cols = Math.min(Math.max(3, Math.floor((hx * 2) / 0.42)), 5);
  const rows = Math.min(Math.max(3, Math.floor(h / 0.42)), 4);
  const cw = (hx * 2) / cols, rh = (h - 0.2) / rows;
  const fz = z + faceDir * 0.24;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dx = x - hx + cw * (c + 0.5);
      const dy = y0 + 0.16 + rh * (r + 0.5);
      box(b, matWood, dx, dy, fz, cw * 0.42, rh * 0.42, 0.03);      // drawer front
      box(b, matMetal, dx, dy, fz + faceDir * 0.02, 0.05, 0.02, 0.02); // pull
    }
  }
}

/** grid wall of glowing screens (electronics hero). visual only. absolute Y. */
export function screenWall(
  b: Build, rand: () => number, x: number, z: number, hx: number, yLo: number, yHi: number, faceDir = -1,
) {
  hx = Math.min(hx, 4.0);
  const cols = Math.min(Math.max(3, Math.floor((hx * 2) / 0.9)), 7);
  const rows = Math.min(Math.max(2, Math.floor((yHi - yLo) / 0.8)), 3);
  const cw = (hx * 2) / cols, rh = (yHi - yLo) / rows;
  const fz = z + faceDir * 0.04;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sx = x - hx + cw * (c + 0.5);
      const sy = yLo + rh * (r + 0.5);
      const pw = cw * (0.42 + rand() * 0.06), ph = rh * (0.42 + rand() * 0.06);
      box(b, matDark, sx, sy, z, pw + 0.04, ph + 0.04, 0.03);
      box(b, rand() < 0.3 ? matScreenWarm : matScreen, sx, sy, fz, pw, ph, 0.02);
    }
  }
}

/** freestanding fridge with a cool glowing glass front (collider) */
export function fridge(b: Build, y0: number, x: number, z: number, hx: number, hz: number, h: number, faceDir = -1) {
  box(b, matDark, x, y0 + h * 0.5, z, hx, h * 0.5, hz, true, true);
  const fz = z + faceDir * (hz - 0.02);
  box(b, matFridge, x, y0 + h * 0.5, fz, hx - 0.08, h * 0.5 - 0.08, 0.02);
  for (let s = 1; s <= 2; s++) {
    const sy = y0 + (h / 3) * s;
    for (let i = 0; i < 4; i++) {
      cyl(b, [matGoods[2], matGoods[1], matGoods[3]][i % 3],
        x - hx + 0.16 + i * ((hx * 2 - 0.32) / 3), sy + 0.16, fz - faceDir * 0.04, 0.05, 0.16);
    }
  }
}

/** a small round bistro table + stools. visual only. */
export function bistroSet(b: Build, rand: () => number, y0: number, x: number, z: number) {
  cyl(b, matMetal, x, y0 + 0.36, z, 0.045, 0.36);
  cyl(b, matWhite, x, y0 + 0.74, z, 0.42, 0.03);
  const seats = 2 + (rand() < 0.5 ? 1 : 0);
  for (let i = 0; i < seats; i++) {
    const a = (i / seats) * Math.PI * 2 + rand();
    const sx = x + Math.cos(a) * 0.7, sz = z + Math.sin(a) * 0.7;
    cyl(b, matWoodDark, sx, y0 + 0.24, sz, 0.035, 0.24);
    cyl(b, pick(matFabric, rand), sx, y0 + 0.49, sz, 0.16, 0.03);
  }
}

/** a bed with frame (collider) + mattress + pillow + blanket */
export function bed(b: Build, rand: () => number, y0: number, x: number, z: number, hx: number, hz: number) {
  box(b, matWoodDark, x, y0 + 0.2, z, hx, 0.2, hz, true);
  const cloth = pick(matFabric, rand);
  box(b, matWhite, x, y0 + 0.46, z, hx - 0.04, 0.09, hz - 0.04);
  box(b, cloth, x, y0 + 0.52, z + hz * 0.2, hx - 0.04, 0.06, hz * 0.75);
  box(b, matWhite, x, y0 + 0.56, z - hz * 0.7, hx * 0.5, 0.06, hz * 0.2);
}

/** a desk (collider top) with a glowing monitor + chair */
export function desk(b: Build, rand: () => number, y0: number, x: number, z: number, faceDir = 1, warm = false) {
  box(b, matWood, x, y0 + 0.74, z, 0.7, 0.03, 0.4, true);
  box(b, matDark, x - 0.55, y0 + 0.37, z, 0.04, 0.37, 0.3);
  box(b, matDark, x + 0.55, y0 + 0.37, z, 0.04, 0.37, 0.3);
  box(b, matDark, x, y0 + 1.06, z + faceDir * 0.28, 0.32, 0.2, 0.03);
  box(b, warm ? matScreenWarm : matScreen, x, y0 + 1.06, z + faceDir * 0.24, 0.29, 0.17, 0.02);
  cyl(b, matDark, x, y0 + 0.86, z + faceDir * 0.28, 0.04, 0.08);
  box(b, matDark, x, y0 + 0.46, z - faceDir * 0.5, 0.22, 0.03, 0.22);
  box(b, pick(matFabric, rand), x, y0 + 0.72, z - faceDir * 0.66, 0.22, 0.24, 0.03);
}

/** a tall wardrobe / cabinet (collider) */
export function wardrobe(b: Build, y0: number, x: number, z: number, hx: number, hz: number, h: number, mat = matWood) {
  box(b, mat, x, y0 + h * 0.5, z, hx, h * 0.5, hz, true, true);
  box(b, matWoodDark, x, y0 + h * 0.5, z - hz - 0.005, hx * 0.5, h * 0.4, 0.01);
  cyl(b, matMetal, x + hx * 0.3, y0 + h * 0.5, z - hz - 0.02, 0.02, 0.06);
}

/**
 * One straight climbable stair flight from `baseY` up one storey. Runs along x
 * within [x0,x1], hugging z=`zc` (depth half `hz`). Each step is a solid box
 * from the flight base to its tread so the capsule can't clip under it. Returns
 * the number of step colliders added.
 */
export function stairFlight(
  b: Build,
  baseY: number, x0: number, x1: number, zc: number, hz: number,
  roomH: number, ascendPositive: boolean,
): number {
  const steps = Math.max(7, Math.round(roomH / 0.3));
  const rise = roomH / steps;
  const runX = (x1 - x0) / steps;
  for (let s = 0; s < steps; s++) {
    const topY = baseY + rise * (s + 1);
    const xc = ascendPositive ? x0 + runX * (s + 0.5) : x1 - runX * (s + 0.5);
    box(b, matStair, xc, (baseY + topY) / 2, zc, Math.abs(runX) / 2 + 0.02, (topY - baseY) / 2, hz, true);
  }
  // outer stringer panel (visual) along the back edge of the flight
  box(b, matWoodDark, (x0 + x1) / 2, baseY + roomH * 0.5, zc + hz - 0.01,
    Math.abs(x1 - x0) / 2, roomH * 0.5, 0.03);
  // newel post at the low end
  cyl(b, matRail, ascendPositive ? x0 : x1, baseY + 0.5, zc - hz + 0.08, 0.04, 0.5);
  return steps;
}
