// Procedural building interior — a PURE FUNCTION of (seed, footprint, floors).
// Nothing is stored: the whole interior is regenerated on demand when the player
// approaches and thrown away when they leave. This is the mechanism that has to
// scale to ~95k buildings, so it is written for real even with one building.
//
// Everything is authored in BUILDING-LOCAL, Y-up metres:
//   origin = building base centre, +x = along the length (front wall span),
//   -z = toward the front (open storefront / entrance), +y = up.
// The host places the returned group under an outer Group carrying the building's
// world position + Y-yaw. Colliders are returned as local AABBs; the host rotates
// them by the same yaw.
//
// LIGHTING: no THREE lights are created (the app has a fixed LightPool; changing
// the scene light count forces a ~7s pipeline rebuild). Interior light is emissive
// ceiling strips only — bright under the app's tonemapping.
//
// GEOMETRY: every piece reuses ONE shared unit BoxGeometry scaled per-mesh, so a
// build/dispose cycle allocates no geometry and dispose is just detach — the thing
// that lets this run every frame for many buildings.
import * as THREE from "three/webgpu";

/** local axis-aligned box collider (building-local metres, pre-yaw) */
export interface LocalBox {
  x: number; y: number; z: number;   // centre
  hx: number; hy: number; hz: number; // half extents
}

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

// ---- shared, permanent resources (never disposed) -------------------------
const UNIT = new THREE.BoxGeometry(1, 1, 1);

// Interior surfaces are LIGHT-coloured: this renderer has no GI, so emissive quads
// don't illuminate the room — the walls only read via the scene hemisphere/ambient,
// which needs a bright albedo to catch. A faint self-emissive keeps them off pure
// black when the sun is shadowed out by the ceiling.
const matWall = new THREE.MeshStandardMaterial({
  color: 0xcabfae, roughness: 0.94, metalness: 0,
  emissive: new THREE.Color(0x3a352c), emissiveIntensity: 1,
});
const matFloor = new THREE.MeshStandardMaterial({
  color: 0x9c8e78, roughness: 0.88, metalness: 0.02,
  emissive: new THREE.Color(0x2a251d), emissiveIntensity: 1,
});
const matStair = new THREE.MeshStandardMaterial({
  color: 0xb0a48c, roughness: 0.82, metalness: 0.04,
  emissive: new THREE.Color(0x2e281f), emissiveIntensity: 1,
});
const matProp = new THREE.MeshStandardMaterial({
  color: 0xc09258, roughness: 0.72, metalness: 0.05,
  emissive: new THREE.Color(0x4a3418), emissiveIntensity: 1,
});
const matRail = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.5, metalness: 0.6 });
// emissive "strip lights" — the visible light source inside. Warm, very bright so
// they read as glowing tubes under the app's tonemapping.
const matLamp = new THREE.MeshStandardMaterial({
  color: 0x000000, roughness: 1, metalness: 0,
  emissive: new THREE.Color(0xfff2d0), emissiveIntensity: 14.0,
});
// a couple of accent lamps in a seed-picked hue so rooms differ (shop-sign glow)
function accentLamp(hue: number): THREE.MeshStandardMaterial {
  const c = new THREE.Color().setHSL(hue, 0.8, 0.6);
  return new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 1, metalness: 0,
    emissive: c, emissiveIntensity: 10.0,
  });
}

// tiny deterministic PRNG (mulberry32) — pure function of seed
function rng(seed: number): () => number {
  let a = (seed | 0) + 0x6d2b79f5;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** helper: add a scaled unit box mesh + register a matching collider */
function block(
  g: THREE.Group, colliders: LocalBox[] | null, mat: THREE.Material,
  x: number, y: number, z: number, hx: number, hy: number, hz: number,
  cast = false,
): THREE.Mesh {
  const m = new THREE.Mesh(UNIT, mat);
  m.position.set(x, y, z);
  m.scale.set(hx * 2, hy * 2, hz * 2);
  m.castShadow = cast;
  m.receiveShadow = true;
  g.add(m);
  if (colliders) colliders.push({ x, y, z, hx, hy, hz });
  return m;
}

/**
 * Build the interior. Deterministic: same spec ⇒ identical geometry & colliders.
 */
export function buildInterior(spec: InteriorSpec): BuiltInterior {
  const { seed, halfX, halfZ, storeyH, floors } = spec;
  const rand = rng(seed);
  const g = new THREE.Group();
  g.name = "generatedInterior";
  const colliders: LocalBox[] = [];

  // inset the interior shell a little inside the facade so the exterior kit walls
  // remain visible from outside and the interior reads as a separate room.
  const INSET = 0.35;
  const ix = halfX - INSET;   // interior half-length
  const iz = halfZ - INSET;   // interior half-depth
  const WALL = 0.15;          // interior wall half-thickness
  const frontZ = -iz;         // open storefront side
  const backZ = iz;

  // ground-floor room height: one storey, but clamp so the door reads human-scale
  const roomH = Math.min(storeyH, 3.4);

  // ---- floor slab ---------------------------------------------------------
  block(g, colliders, matFloor, 0, 0.05, 0, ix, 0.05, iz);

  // ---- room shell: back + two sides, FRONT LEFT OPEN (entrance) -----------
  block(g, colliders, matWall, 0, roomH / 2, backZ, ix, roomH / 2, WALL, true);        // back
  block(g, colliders, matWall, -ix, roomH / 2, 0, WALL, roomH / 2, iz, true);           // left
  block(g, colliders, matWall, ix, roomH / 2, 0, WALL, roomH / 2, iz, true);            // right
  // a low front bulkhead over the entrance (lintel) so the opening reads as a door,
  // not a missing wall — leaves a walk-in gap below.
  const lintelH = 0.4;
  block(g, colliders, matWall, 0, roomH - lintelH / 2, frontZ, ix, lintelH / 2, WALL, true);

  // ---- ceiling / upper floor slab, with a stair hole near the back-right --
  const upperY = roomH;
  const holeHX = Math.min(1.4, ix * 0.5);   // stair-hole half length (x)
  const holeHZ = Math.min(1.6, iz * 0.5);   // stair-hole half depth (z)
  const holeCX = ix - holeHX - 0.1;         // hole hugs the right wall
  const holeCZ = backZ - holeHZ - 0.1;      // …and the back wall
  // Build the slab as 4 border strips around the rectangular hole so the hole is open.
  // strip along front of hole (covers z from frontZ..holeCZ-holeHZ, full x)
  const canUpper = floors >= 2 && ix > 1.6 && iz > 1.8;
  if (canUpper) {
    const slabT = 0.12;
    const y = upperY;
    // front strip (z < hole)
    const frontDepth = (holeCZ - holeHZ) - frontZ;
    if (frontDepth > 0.05) {
      block(g, colliders, matFloor, 0, y, frontZ + frontDepth / 2, ix, slabT, frontDepth / 2);
    }
    // back strip (z > hole)
    const backDepth = backZ - (holeCZ + holeHZ);
    if (backDepth > 0.05) {
      block(g, colliders, matFloor, 0, y, (holeCZ + holeHZ) + backDepth / 2, ix, slabT, backDepth / 2);
    }
    // left strip (beside hole, spanning the hole's z range)
    const leftW = (holeCX - holeHX) - (-ix);
    if (leftW > 0.05) {
      block(g, colliders, matFloor, -ix + leftW / 2, y, holeCZ, leftW / 2, slabT, holeHZ);
    }
    // right strip (between hole and right wall) — usually tiny
    const rightW = ix - (holeCX + holeHX);
    if (rightW > 0.05) {
      block(g, colliders, matFloor, (holeCX + holeHX) + rightW / 2, y, holeCZ, rightW / 2, slabT, holeHZ);
    }
    // upper-floor shell walls (back + right) so floor 2 reads as a room, not a shelf
    block(g, colliders, matWall, 0, y + roomH / 2, backZ, ix, roomH / 2, WALL, true);
    block(g, colliders, matWall, ix, y + roomH / 2, 0, WALL, roomH / 2, iz, true);
    block(g, colliders, matWall, -ix, y + roomH / 2, 0, WALL, roomH / 2, iz, true);
    // upper-floor ceiling cap
    block(g, colliders, matFloor, 0, y + roomH, 0, ix, slabT, iz);

    // railing around the open sides of the stair hole (visual + fall guard)
    const railY = y + 0.5;
    block(g, colliders, matRail, holeCX, railY, holeCZ - holeHZ, holeHX, 0.5, 0.05); // front rail
    block(g, colliders, matRail, holeCX - holeHX, railY, holeCZ, 0.05, 0.5, holeHZ); // left rail

    // ---- straight stair from ground to upper slab -----------------------
    // runs along z (front→back) inside the hole footprint, hugging the right wall
    const steps = Math.max(6, Math.round(roomH / 0.28));
    const rise = roomH / steps;
    const runZ = (2 * holeHZ) / steps;   // total run fits the hole depth
    const stairX = holeCX;
    const stairHX = holeHX * 0.9;
    for (let s = 0; s < steps; s++) {
      const topY = rise * (s + 1);
      const z = (holeCZ - holeHZ) + runZ * (s + 0.5);
      // each step is a solid box from floor up to its tread (so you can't clip under)
      block(g, colliders, matStair, stairX, topY / 2, z, stairHX, topY / 2, runZ / 2 + 0.02);
    }
  } else {
    // single-storey: plain ceiling cap (no hole)
    block(g, colliders, matFloor, 0, upperY, 0, ix, 0.12, iz);
  }

  // ---- emissive strip lights (no THREE lights!) ---------------------------
  // ground floor: two ceiling strips
  const lampZs = [-iz * 0.4, iz * 0.3];
  for (const lz of lampZs) {
    block(g, null, matLamp, 0, roomH - 0.16, lz, ix * 0.7, 0.06, 0.18);
  }
  if (canUpper) {
    block(g, null, matLamp, 0, upperY + roomH - 0.16, 0, ix * 0.7, 0.06, 0.18);
  }
  // a seed-hued accent lamp box on the back wall (shop sign glow)
  const accent = accentLamp(rand());
  block(g, null, accent, (rand() - 0.5) * ix, roomH * 0.55, backZ - WALL - 0.05, 0.5, 0.35, 0.06);

  // ---- a few deterministic props (counter, shelves, boxes) ----------------
  const nProps = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < nProps; i++) {
    const pw = 0.4 + rand() * 0.7;
    const pd = 0.4 + rand() * 0.7;
    const ph = 0.3 + rand() * 0.5;  // counter/shelf height ≤ ~1.6 m, never a monolith
    // keep props against the left/back, clear of the entrance and stair
    const px = -ix + WALL + pw + rand() * (ix * 0.5);
    const pz = -iz * 0.3 + rand() * (iz * 0.9);
    block(g, colliders, matProp, px, ph, pz, pw, ph, pd, false);
  }

  return { group: g, colliders, meshCount: g.children.length };
}
