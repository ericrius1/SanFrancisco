// Procedural building interior — a PURE FUNCTION of (seed, footprint, floors).
//
// Nothing is stored: the whole interior is regenerated on demand when the player
// approaches (<40 m) and thrown away when they leave (>80 m). Because that
// build/dispose cycle runs constantly for the ~40 buildings resident around the
// player, the whole thing is authored against a hard perf contract (see
// interiorProps.ts): TWO shared geometries, module-level singleton materials, no
// THREE lights — interior illumination is emissive materials only.
//
// Determinism: identical (seed, dims, floors) ⇒ byte-identical geometry &
// colliders on every visit and on every multiplayer client. All variation flows
// from a single mulberry32 stream seeded by `seed`; call ORDER is fixed.
//
// Building-local, Y-up metres: origin = base centre, +x along the length (front
// span), -z toward the OPEN storefront (entrance), +y up. The host places the
// returned group under a Group carrying the building's world pos + Y-yaw and
// rotates the returned local AABB colliders by the same yaw.
//
// What gets built:
//   • Ground floor = a SHOP, one of four types chosen by seed — convenience
//     store, noodle/tea house, electronics stall, herbalist — each with its own
//     wall tint, fittings, goods and neon storefront sign.
//   • Upper floors = small apartments / offices, furnished and lit, reached by a
//     real switchback stair. The front wall closes the facade (with glowing
//     windows); side/back walls are visual only because the building's exterior
//     perimeter colliders already seal those sides for the full height — so the
//     interior adds only genuinely-new colliders (floors, stairs, furniture).
//   • A stair shaft in the back-right corner threads every built floor; a solid
//     staircase fills each shaft level, so there is no open pit to fall through.
//
// To keep the resident-building physics/mesh budget bounded, at most the ground
// floor + 3 upper floors are furnished on tall buildings (you can climb to floor
// 4); the exterior renders the full height regardless.
import * as THREE from "three/webgpu";
import {
  type LocalBox, type Build,
  box, cyl, rng, pick,
  matFloor, matFloorWood, matCeil, matRail, matPartition,
  matWallCool, matWallWarm, matWallTech, matWallHerb,
  matWood, matWoodDark, matMetal, matDark, matWhite, matFabric,
  matLampWarm, matLampCool, matScreen, matEmber,
  NEON,
  ceilingStrip, windowGlow, signBoard, counter, shelfUnit,
  drawerWall, screenWall, fridge, bistroSet, bed, desk, wardrobe, stairFlight,
} from "./interiorProps";

export type { LocalBox };

export interface InteriorSpec {
  seed: number;
  /** footprint half-extents in metres (x along length, z along width) */
  halfX: number;
  halfZ: number;
  storeyH: number;   // one storey, metres
  floors: number;    // total storeys of the building
}

export interface BuiltInterior {
  group: THREE.Group;
  colliders: LocalBox[];
  /** number of visible meshes, for perf reporting */
  meshCount: number;
}

const INSET = 0.35;   // pull the interior shell inside the facade
const WALL = 0.12;    // interior wall half-thickness (visual skins)
const MAX_FLOORS = 3; // ground + up to 2 furnished upper floors (mesh/collider budget)

// stairwell footprint (back-right corner), resolved per building
interface Shaft { x0: number; x1: number; zc: number; hz: number; ok: boolean; }

/** shared layout context handed to every room/shop builder */
interface Ctx {
  b: Build; rand: () => number;
  ix: number; iz: number; frontZ: number; backZ: number; roomH: number;
  shaft: Shaft;
  /** max x a back-wall prop may reach before it would foul the stair shaft */
  backLimit: number;
}

// ---- shell: three visual wall skins (+ optional collidable front wall) ------
function shellWalls(ctx: Ctx, wallMat: THREE.Material, y0: number, withFront: boolean) {
  const { b, ix, iz, frontZ, backZ, roomH } = ctx;
  const cy = y0 + roomH / 2;
  box(b, wallMat, 0, cy, backZ, ix, roomH / 2, WALL);         // back
  box(b, wallMat, -ix, cy, 0, WALL, roomH / 2, iz);           // left
  box(b, wallMat, ix, cy, 0, WALL, roomH / 2, iz);            // right
  // lit "windows" flush inside the side walls
  windowGlow(b, -ix + 0.03, y0 + roomH * 0.52, 0, 0.02, roomH * 0.24, iz * 0.42);
  windowGlow(b, ix - 0.03, y0 + roomH * 0.52, 0, 0.02, roomH * 0.24, iz * 0.42);
  if (withFront) {
    // upper floors close the facade with a collidable wall + glowing window band
    box(b, wallMat, 0, cy, frontZ, ix, roomH / 2, WALL, true);
    windowGlow(b, 0, y0 + roomH * 0.55, frontZ + 0.04, ix * 0.82, roomH * 0.3, 0.02);
  }
}

// ---- floor slab with a rectangular hole for the stair shaft -----------------
function slabWithHole(ctx: Ctx, y: number, s: Shaft) {
  const { b, ix, frontZ, backZ } = ctx;
  const t = 0.1;
  const hx0 = s.x0 - 0.12, hx1 = s.x1 + 0.12;
  const hz0 = s.zc - s.hz, hz1 = s.zc + s.hz;
  const fD = hz0 - frontZ;                                    // front strip
  if (fD > 0.05) box(b, matFloor, 0, y, frontZ + fD / 2, ix, t, fD / 2, true);
  const bD = backZ - hz1;                                     // back strip
  if (bD > 0.05) box(b, matFloor, 0, y, hz1 + bD / 2, ix, t, bD / 2, true);
  const lW = hx0 + ix;                                        // left strip
  if (lW > 0.05) box(b, matFloor, -ix + lW / 2, y, s.zc, lW / 2, t, s.hz, true);
  const rW = ix - hx1;                                        // right strip
  if (rW > 0.05) box(b, matFloor, hx1 + rW / 2, y, s.zc, rW / 2, t, s.hz, true);
  // a central balustrade in front of the shaft — blocks the mid-drop but leaves
  // ~0.6 m open at each end (x0/x1) so either stair-flight direction can enter.
  const gw = (hx1 - hx0) / 2 - 0.6;
  if (gw > 0.15) box(b, matRail, (hx0 + hx1) / 2, y + 0.5, hz0, gw, 0.5, 0.04, true);
}

// ===========================================================================
// GROUND-FLOOR SHOPS
// ===========================================================================
function frontSign(ctx: Ctx, hue: number) {
  const { b, ix, roomH, frontZ } = ctx;
  signBoard(b, NEON[hue], 0, roomH - 0.55, frontZ + 0.28, Math.min(ix * 0.6, 2.6), 0.28);
}
function ceilingRow(ctx: Ctx, mat = matLampWarm) {
  const { b, ix, iz, roomH } = ctx;
  const y = roomH - 0.14;
  ceilingStrip(b, 0, y, -iz * 0.45, ix * 0.62, mat);
  ceilingStrip(b, 0, y, 0, ix * 0.62, mat);
  ceilingStrip(b, 0, y, iz * 0.45, ix * 0.62, mat);
}

function shopConvenience(ctx: Ctx) {
  const { b, rand, ix, frontZ, backZ, backLimit } = ctx;
  ceilingRow(ctx, matLampCool);
  frontSign(ctx, 2); // cyan
  const cx = -ix + 1.0;
  counter(b, 0, cx, frontZ + 0.85, 0.85, 0.45, 1.0);
  box(b, matDark, cx - 0.4, 1.12, frontZ + 0.85, 0.14, 0.06, 0.1);   // register
  box(b, matScreen, cx - 0.4, 1.22, frontZ + 0.78, 0.11, 0.07, 0.02);
  fridge(b, 0, Math.min(-ix * 0.15, backLimit - 0.7), backZ - 0.45, 0.7, 0.36, 1.95);
  const gHx = Math.min(ix * 0.42, 1.5);                             // gondola aisles
  for (const rz of [-ctx.iz * 0.12, ctx.iz * 0.32]) {
    shelfUnit(b, rand, 0, Math.max(-ix + gHx + 0.3, -ix * 0.3), rz, gHx, 0.28, 1.5);
  }
}

function shopNoodle(ctx: Ctx) {
  const { b, rand, ix, frontZ, backZ, roomH, backLimit } = ctx;
  ceilingRow(ctx, matLampWarm);
  frontSign(ctx, rand() < 0.5 ? 0 : 4); // red / orange
  const kStart = -ix + 0.3, kHx = Math.min((backLimit - 0.2 - kStart) / 2, 3.0);
  const kx = kStart + kHx, kEnd = kx + kHx;
  counter(b, 0, kx, backZ - 0.4, kHx, 0.35, 0.95, rand() < 0.5 ? matMetal : matWood);
  const stoveX = kEnd - 0.5;
  box(b, matDark, stoveX, 0.98, backZ - 0.4, 0.3, 0.05, 0.3);        // hob
  box(b, matEmber, stoveX, 1.0, backZ - 0.4, 0.12, 0.02, 0.12);      // burner glow
  cyl(b, matMetal, stoveX, 1.16, backZ - 0.4, 0.15, 0.12);          // pot
  box(b, matDark, stoveX, roomH - 0.5, backZ - 0.4, 0.4, 0.18, 0.35); // extractor hood
  for (let i = 0; i < 3; i++)                                       // menu boards
    box(b, matLampWarm, kStart + 0.5 + i * (kHx * 2 / 3), roomH - 0.7, backZ - 0.75, 0.28, 0.16, 0.02);
  const nT = ix > 6 ? 3 : 2;                                        // bistro sets
  for (let i = 0; i < nT; i++)
    bistroSet(b, rand, 0, -ix + 1.1 + i * ((ix * 2 - 2.2) / Math.max(1, nT - 1)), frontZ + 1.2);
}

function shopElectronics(ctx: Ctx) {
  const { b, rand, ix, iz, frontZ, backZ, roomH, backLimit } = ctx;
  ceilingRow(ctx, matLampCool);
  frontSign(ctx, rand() < 0.5 ? 2 : 1); // cyan / magenta
  const wA = -ix + 0.3, wB = backLimit - 0.1;                     // wall of screens (hero)
  screenWall(b, rand, (wA + wB) / 2, backZ - 0.06, (wB - wA) / 2, 1.0, roomH - 0.3);
  const dHx = Math.min(ix * 0.7, 2.4);                              // glass display counter
  counter(b, 0, -ix * 0.1, frontZ + 0.8, dHx, 0.4, 0.95, matDark);
  box(b, matScreen, -ix * 0.1, 0.98, frontZ + 0.8, dHx - 0.1, 0.02, 0.35);
  const gHx = Math.min(ix * 0.6, 2);
  for (let i = 0; i < 4; i++)
    box(b, pick([matDark, matMetal], rand), -ix * 0.1 - gHx + i * (gHx * 2 / 3), 0.9, frontZ + 0.8, 0.12, 0.05, 0.16);
  shelfUnit(b, rand, 0, -ix + 0.5, -iz * 0.1, 0.35, 0.3, 1.6, matDark);
}

function shopHerbalist(ctx: Ctx) {
  const { b, rand, ix, iz, frontZ, backZ, roomH, backLimit } = ctx;
  ceilingRow(ctx, matLampWarm);
  frontSign(ctx, rand() < 0.5 ? 5 : 0); // gold / red
  const dStart = -ix + 0.3, dHx = Math.min((backLimit - 0.2 - dStart) / 2, 1.9); // drawer wall
  drawerWall(b, 0, dStart + dHx, backZ - 0.24, dHx, roomH - 0.5);
  const cx = -ix * 0.15, cHx = Math.min(ix * 0.55, 1.8);           // serving counter
  counter(b, 0, cx, frontZ + 1.0, cHx, 0.4, 1.0, matWood);
  box(b, matMetal, cx - cHx + 0.3, 1.0, frontZ + 1.0, 0.06, 0.05, 0.06);
  cyl(b, matMetal, cx - cHx + 0.3, 1.12, frontZ + 1.0, 0.1, 0.06);  // scale
  for (let i = 0; i < 5; i++)                                       // ceramic jars
    cyl(b, matWhite, cx - cHx + 0.6 + i * ((cHx * 2 - 0.9) / 4), 1.14, frontZ + 1.0, 0.06, 0.08);
  shelfUnit(b, rand, 0, -ix + 0.5, iz * 0.1, 0.35, 0.28, 1.5, matWoodDark);
}

// ===========================================================================
// UPPER FLOORS — apartments / offices
// ===========================================================================
function upperFloor(ctx: Ctx, y0: number) {
  const { b, rand, ix, iz, frontZ, backZ, roomH, shaft } = ctx;
  const office = rand() < 0.42;
  const wallMat = office ? matWallCool : matWallWarm;
  shellWalls(ctx, wallMat, y0, true);
  ceilingStrip(b, 0, y0 + roomH - 0.14, 0, ix * 0.6, office ? matLampCool : matLampWarm);
  if (iz > 2.0)
    ceilingStrip(b, 0, y0 + roomH - 0.14, -iz * 0.5, ix * 0.5, office ? matLampCool : matLampWarm);

  // optional partition splitting the front room, with a doorway gap; kept clear
  // of the back-right stair shaft
  if (ix > 3.6) {
    const px = ix * (rand() < 0.5 ? -0.2 : 0.15);
    const doorZ = frontZ + iz * 0.7;
    box(b, matPartition, px, y0 + roomH / 2, (frontZ + doorZ) / 2 - 0.2, WALL, roomH / 2, (doorZ - frontZ) / 2 - 0.2, true);
  }

  const backX = shaft.ok ? shaft.x0 - 0.4 : ix - 0.4;   // clear of the shaft

  if (office) {
    desk(b, rand, y0, Math.max(-ix + 0.9, backX - 2.6), frontZ + iz * 0.6, 1, false);
    if (ix > 5) desk(b, rand, y0, Math.min(backX - 0.9, ix * 0.1), frontZ + iz * 0.6, 1, false);
    shelfUnit(b, rand, y0, -ix + 0.5, backZ - 0.6, 0.35, 0.3, 1.5, matDark);
  } else {
    bed(b, rand, y0, -ix + 0.95, backZ - 0.85, 0.95, 0.55);
    wardrobe(b, y0, -ix + 0.5, frontZ + 0.6, 0.4, 0.28, 1.9);
    const tx = Math.min(0.2, backX - 1.0);                          // low table + stools
    box(b, matWood, tx, y0 + 0.42, frontZ + iz * 0.8, 0.5, 0.03, 0.35, true);
    cyl(b, matWoodDark, tx - 0.5, y0 + 0.24, frontZ + iz * 0.8, 0.16, 0.24);
    cyl(b, matWoodDark, tx + 0.5, y0 + 0.24, frontZ + iz * 0.8, 0.16, 0.24);
    box(b, matDark, ix - 0.06, y0 + 1.3, iz * 0.1, 0.03, 0.28, 0.5);  // wall TV
    box(b, matScreen, ix - 0.09, y0 + 1.3, iz * 0.1, 0.02, 0.24, 0.44);
    box(b, pick(matFabric, rand), tx, y0 + 0.02, frontZ + iz * 0.8, 0.9, 0.01, 0.7); // rug
  }
}

// ===========================================================================
export function buildInterior(spec: InteriorSpec): BuiltInterior {
  const { seed, halfX, halfZ, storeyH, floors } = spec;
  const rand = rng(seed);
  const g = new THREE.Group();
  g.name = "generatedInterior";
  const col: LocalBox[] = [];
  const b: Build = { g, col };

  const ix = halfX - INSET;
  const iz = halfZ - INSET;
  const frontZ = -iz;
  const backZ = iz;
  const roomH = Math.min(storeyH, 3.3);

  // stair shaft in the back-right corner, running along x (the longer axis)
  const swHZ = Math.min(1.35, Math.max(0.85, iz * 0.42));
  let swRun = Math.min(3.3, Math.max(2.0, ix * 0.85));
  swRun = Math.min(swRun, ix * 2 - 0.7);
  const shaft: Shaft = {
    x1: ix - 0.15,
    x0: ix - 0.15 - swRun,
    zc: backZ - swHZ - 0.05,
    hz: swHZ,
    ok: false,
  };
  const wantUpper = Math.min(floors, MAX_FLOORS) - 1;   // furnished upper floors
  shaft.ok = wantUpper >= 1 && ix > 2.0 && iz > 1.7 && swRun > 1.7 && shaft.x0 > -ix + 0.3;
  const upperBuilt = shaft.ok ? wantUpper : 0;

  const ctx: Ctx = {
    b, rand, ix, iz, frontZ, backZ, roomH, shaft,
    backLimit: shaft.ok ? shaft.x0 - 0.3 : ix - 0.3,
  };

  // ---- ground floor -------------------------------------------------------
  const shopType = (rand() * 4) | 0;
  const floorMat = [matFloor, matFloorWood, matFloor, matFloorWood][shopType];
  const shopWall = [matWallCool, matWallWarm, matWallTech, matWallHerb][shopType];
  // Thick ground slab: the building can sit on a flora/grass patch, and a thin
  // floor lets the blades poke through. After the whole interior is lifted by
  // LIFT (below) this fills world y∈[0, ~LIFT+0.06], burying the terrain.
  box(b, floorMat, 0, -0.13, 0, ix, 0.19, iz, true);            // ground slab
  shellWalls(ctx, shopWall, 0, false);                          // walls, front OPEN
  box(b, shopWall, 0, roomH - 0.2, frontZ, ix, 0.2, WALL);      // storefront lintel
  box(b, matWoodDark, -ix + 0.15, roomH / 2, frontZ, 0.15, roomH / 2, WALL + 0.02); // jambs
  box(b, matWoodDark, ix - 0.15, roomH / 2, frontZ, 0.15, roomH / 2, WALL + 0.02);

  if (shopType === 0) shopConvenience(ctx);
  else if (shopType === 1) shopNoodle(ctx);
  else if (shopType === 2) shopElectronics(ctx);
  else shopHerbalist(ctx);

  // ---- floors, stair, upper rooms -----------------------------------------
  if (upperBuilt >= 1) {
    for (let f = 1; f <= upperBuilt; f++) {
      slabWithHole(ctx, f * roomH, shaft);          // floor of storey f (stair hole)
      stairFlight(b, (f - 1) * roomH, shaft.x0, shaft.x1, shaft.zc, shaft.hz, roomH, f % 2 === 1);
    }
    for (let f = 1; f <= upperBuilt; f++) upperFloor(ctx, f * roomH);
    box(b, matCeil, 0, (upperBuilt + 1) * roomH, 0, ix, 0.1, iz, true);  // roof cap
  } else {
    box(b, matCeil, 0, roomH, 0, ix, 0.1, iz, true);            // single-storey cap
  }

  // Lift the whole interior so the ground floor sits above any terrain grass at
  // the building's base. One group offset + a matching collider shift keeps the
  // authoring simple and the physics correct.
  const LIFT = 0.26;
  g.position.y = LIFT;
  for (const cbx of col) cbx.y += LIFT;

  return { group: g, colliders: col, meshCount: g.children.length };
}
