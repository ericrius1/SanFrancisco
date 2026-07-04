import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldMap } from "./heightmap";

// Palace of Fine Arts centre (game frame), shared with palaceGlow / blender_city.
const CX = -388;
const CZ = -1426;

// Stone palette lifted from blender_city.py (PFA_COLOR / PFA_TRIM), pushed
// through the same sRGB->linear the baker uses so the runtime peristyle reads
// identically to the baked rotunda it wraps.
const STONE = new THREE.Color(0xc7b299).convertSRGBToLinear(); // PFA_COLOR
const TRIM = new THREE.Color(0xd8c7ac).convertSRGBToLinear(); // PFA_TRIM
const FIGURE = new THREE.Color(0x9a8a72).convertSRGBToLinear(); // attic sculpture block

// The grand crescent. Game-frame angle t: point = (CX + cos t·r, CZ + sin t·r).
// Sweep the western arc (55°..285°, through 180°) so the colonnade wraps the
// far side of the rotunda and opens ~130° toward the lagoon to the east — the
// real peristyle's orientation. Radius 51 hugs the lagoon-facing inner edge of
// the OSM footprint (building 8_9:570) it replaces.
const ARC0 = (55 * Math.PI) / 180;
const ARC1 = (285 * Math.PI) / 180;
const RADIUS = 51;
const N_COLS = 34; // ~6 m column spacing along the arc

// Level entablature heights (metres above the palace plinth ground). Column
// tops stay flat regardless of terrain sag so the cornice runs true.
const SHAFT_TOP = 14.0;
const CAP_TOP = 15.4;
const ENTAB_TOP = 17.6;
const CORNICE_TOP = 18.3;
const ATTIC_TOP = 20.8;

/** Append a solid-colour vertical (or tilted) cylinder to the soup. */
function tube(
  out: THREE.BufferGeometry[],
  x: number,
  y0: number,
  z: number,
  y1: number,
  rBot: number,
  rTop: number,
  seg: number,
  c: THREE.Color
) {
  const h = y1 - y0;
  if (h <= 0) return;
  const geo = new THREE.CylinderGeometry(rTop, rBot, h, seg).toNonIndexed();
  paint(geo, c);
  geo.translate(x, y0 + h / 2, z);
  out.push(geo);
}

/** Append a solid-colour box (entablature runs, attic blocks). */
function box(
  out: THREE.BufferGeometry[],
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  c: THREE.Color,
  yaw = 0
) {
  const geo = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  paint(geo, c);
  if (yaw) geo.rotateY(yaw);
  geo.translate(x, y, z);
  out.push(geo);
}

function paint(geo: THREE.BufferGeometry, c: THREE.Color) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    col[v * 3] = c.r;
    col[v * 3 + 1] = c.g;
    col[v * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

function colPoint(t: number): { x: number; z: number } {
  return { x: CX + Math.cos(t) * RADIUS, z: CZ + Math.sin(t) * RADIUS };
}

/**
 * Runtime Palace of Fine Arts peristyle — the grand curved colonnade that in
 * real life sweeps around the lagoon behind the rotunda. The OSM data carries
 * this as ordinary buildings (tile 8_9, ids 570/571/572...), so the streamer
 * renders it as a windowed apartment wall; those are suppressed by the caller
 * and this open row of classical columns stands in their place:
 *
 *  - fluted-look shafts on square plinths, level Corinthian capitals,
 *  - a continuous entablature + cornice band riding the capitals,
 *  - the iconic attic blocks (abstracted "weeping maidens" sculpture boxes)
 *    over every fourth bay.
 *
 * Two merged meshes (stone shell + steel-free), no per-frame update. Ground is
 * sampled per column so bases meet the terrain; the entablature stays level.
 */
export function createPalaceColonnade(map: WorldMap): THREE.Group {
  const g0 = map.effectiveGround(CX, CZ);
  const group = new THREE.Group();
  group.name = "palace_peristyle";

  const stone: THREE.BufferGeometry[] = [];

  const pts: { x: number; z: number; t: number }[] = [];
  for (let k = 0; k < N_COLS; k++) {
    const t = ARC0 + ((ARC1 - ARC0) * k) / (N_COLS - 1);
    const p = colPoint(t);
    pts.push({ x: p.x, z: p.z, t });
  }

  // --- columns: plinth foot, tapered shaft (entasis), flared capital ---
  for (const p of pts) {
    const gc = Math.min(map.effectiveGround(p.x, p.z), g0 + 0.5);
    const base = gc - 0.8; // sink so no gap where terrain dips
    box(stone, p.x, base + (g0 + 0.7 - base) / 2, p.z, 3.0, g0 + 0.7 - base, 3.0, TRIM); // square plinth
    tube(stone, p.x, g0 + 0.7, p.z, g0 + SHAFT_TOP, 1.3, 1.1, 10, STONE); // shaft w/ slight entasis
    tube(stone, p.x, g0 + SHAFT_TOP, p.z, g0 + CAP_TOP, 1.1, 1.75, 10, TRIM); // capital flare
    box(stone, p.x, g0 + CAP_TOP + 0.18, p.z, 3.3, 0.36, 3.3, TRIM); // abacus
  }

  // --- entablature + cornice: straight beams chorded between column tops ---
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const half = Math.hypot(b.x - a.x, b.z - a.z) / 2 + 0.9;
    const yaw = -Math.atan2(b.z - a.z, b.x - a.x); // box local +x along the chord
    box(stone, mx, g0 + (CAP_TOP + ENTAB_TOP) / 2, mz, half * 2, ENTAB_TOP - CAP_TOP, 2.1, STONE, yaw); // architrave/frieze
    box(stone, mx, g0 + (ENTAB_TOP + CORNICE_TOP) / 2, mz, half * 2, CORNICE_TOP - ENTAB_TOP, 2.7, TRIM, yaw); // cornice lip
  }

  // --- attic sculpture blocks over every fourth bay (the peristyle silhouette)
  for (let k = 1; k < pts.length - 1; k += 4) {
    const a = pts[k];
    const b = pts[k + 1];
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
    box(stone, mx, g0 + (CORNICE_TOP + ATTIC_TOP) / 2, mz, 3.2, ATTIC_TOP - CORNICE_TOP, 2.6, STONE, yaw); // pedestal
    // outward-facing figure block (toward the lagoon-opposite outer face)
    const nx = mx - CX;
    const nz = mz - CZ;
    const nl = Math.hypot(nx, nz) || 1;
    box(stone, mx + (nx / nl) * 0.5, g0 + ATTIC_TOP + 0.9, mz + (nz / nl) * 0.5, 1.1, 2.0, 1.1, FIGURE, yaw);
  }

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  const mesh = new THREE.Mesh(mergeGeometries(stone, false)!, mat);
  mesh.name = "palace_peristyle_stone";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  return group;
}

/** OSM footprints (tile 8_9) the peristyle stands in for; caller suppresses. */
export const PALACE_RING_BUILDINGS: { key: string; index: number }[] = [
  { key: "8_9", index: 570 }, // the big curved exhibition-hall / peristyle band
  { key: "8_9", index: 571 }, // NE wing pavilion
  { key: "8_9", index: 572 }, // SW wing pavilion
  { key: "8_9", index: 573 }, // ornamental urn
  { key: "8_9", index: 574 } // ornamental urn
];
