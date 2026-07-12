import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALACE_LAGOON, type WorldMap } from "./heightmap";

// Palace of Fine Arts centre (game frame), mirrors blender_city.py.
const CX = -388;
const CZ = -1426;

// Stone palette lifted from blender_city.py (PFA_COLOR / PFA_TRIM), pushed
// through the same sRGB->linear the baker uses so the runtime peristyle reads
// identically to the baked rotunda it wraps.
const STONE = new THREE.Color(0xc7b299).convertSRGBToLinear(); // PFA_COLOR
const TRIM = new THREE.Color(0xd8c7ac).convertSRGBToLinear(); // PFA_TRIM
const FIGURE = new THREE.Color(0x9a8a72).convertSRGBToLinear(); // attic sculpture block
const SHAFT = new THREE.Color(0x8b5f58).convertSRGBToLinear(); // muted Pompeian rose
const RELIEF = new THREE.Color(0xaa967d).convertSRGBToLinear();
const TRUNK = new THREE.Color(0x44392e).convertSRGBToLinear();
const LEAF_DARK = new THREE.Color(0x173a2b).convertSRGBToLinear();
const LEAF_MID = new THREE.Color(0x2e5c3b).convertSRGBToLinear();
const LEAF_LIGHT = new THREE.Color(0x58744a).convertSRGBToLinear();
const PAD_DARK = new THREE.Color(0x315844).convertSRGBToLinear();
const PAD_LIGHT = new THREE.Color(0x54755a).convertSRGBToLinear();
const LILY = new THREE.Color(0xe4b8aa).convertSRGBToLinear();

// The peristyle is NOT a ring around the rotunda. Historic descriptions call it
// two detached wings following the western shore of the lagoon, and the real OSM
// gallery footprints (8_9:571/572) preserve those north/south arcs. Both are
// therefore struck from the lagoon centre at ~112 m radius, with a clear central
// break behind the rotunda. Angles are in the game x/z frame.
const PERISTYLE_RADIUS = 112;
const PERISTYLE_SPANS = [
  { a0: (112 * Math.PI) / 180, a1: (165 * Math.PI) / 180, columns: 17 }, // north wing
  { a0: (195 * Math.PI) / 180, a1: (238 * Math.PI) / 180, columns: 14 } // south wing
] as const;

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

function blob(
  out: THREE.BufferGeometry[],
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  c: THREE.Color,
  detail = 1
) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  paint(geo, c);
  geo.scale(sx, sy, sz);
  geo.translate(x, y, z);
  out.push(geo);
}

function torus(
  out: THREE.BufferGeometry[],
  x: number,
  y: number,
  z: number,
  radius: number,
  tubeRadius: number,
  c: THREE.Color
) {
  const geo = new THREE.TorusGeometry(radius, tubeRadius, 6, 48).toNonIndexed();
  paint(geo, c);
  geo.rotateX(Math.PI / 2);
  geo.translate(x, y, z);
  out.push(geo);
}

function beam(
  out: THREE.BufferGeometry[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  c: THREE.Color
) {
  const delta = b.clone().sub(a);
  const geo = new THREE.CylinderGeometry(radius, radius, delta.length(), 6).toNonIndexed();
  paint(geo, c);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  out.push(geo);
}

function leaf(
  out: THREE.BufferGeometry[],
  x: number,
  y: number,
  z: number,
  length: number,
  heading: number,
  lift: number,
  c: THREE.Color
) {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  paint(geo, c);
  geo.scale(length * 0.24, length * 0.055, length);
  geo.rotateX(lift);
  geo.rotateY(heading);
  geo.translate(x, y, z);
  out.push(geo);
}

function lilyPad(
  out: THREE.BufferGeometry[],
  x: number,
  y: number,
  z: number,
  radius: number,
  yaw: number,
  c: THREE.Color
) {
  const geo = new THREE.CircleGeometry(radius, 10).toNonIndexed();
  paint(geo, c);
  geo.rotateX(-Math.PI / 2);
  geo.rotateY(yaw);
  geo.scale(1, 1, 0.72);
  geo.translate(x, y, z);
  out.push(geo);
}

function rand(seed: number): number {
  const x = Math.sin(seed * 91.733 + 14.17) * 43758.5453;
  return x - Math.floor(x);
}

function colPoint(t: number): { x: number; z: number } {
  return {
    x: PALACE_LAGOON.x + Math.cos(t) * PERISTYLE_RADIUS,
    z: PALACE_LAGOON.z + Math.sin(t) * PERISTYLE_RADIUS
  };
}

/**
 * Runtime Palace of Fine Arts peristyle — the grand curved colonnade that in
 * real life sweeps around the lagoon behind the rotunda. The OSM data carries
 * this as ordinary buildings (tile 8_9, ids 570/571/572...), so the streamer
 * renders it as a windowed apartment wall; those are suppressed by the caller
 * and this open row of classical columns stands in their place:
 *
 *  - fluted-look shafts on square plinths, level Corinthian capitals,
 *  - separate entablature + cornice runs for the north and south wings,
 *  - four-column pavilion clusters carrying the iconic planter/attic boxes.
 *
 * Two merged meshes (architecture + garden planting), no per-frame update.
 * Ground is sampled per column so bases meet the terrain; the entablature stays
 * level and the planted lagoon edge follows the authored waterline.
 */
export function createPalaceColonnade(map: WorldMap): THREE.Group {
  const g0 = map.effectiveGround(CX, CZ);
  const group = new THREE.Group();
  group.name = "palace_peristyle";

  const stone: THREE.BufferGeometry[] = [];
  const planting: THREE.BufferGeometry[] = [];

  type PeristylePoint = { x: number; z: number; t: number; cluster: boolean };
  const spans: PeristylePoint[][] = PERISTYLE_SPANS.map((span) => {
    const mid = Math.floor((span.columns - 1) / 2);
    const pts: PeristylePoint[] = [];
    for (let k = 0; k < span.columns; k++) {
      const t = span.a0 + ((span.a1 - span.a0) * k) / (span.columns - 1);
      const p = colPoint(t);
      pts.push({ x: p.x, z: p.z, t, cluster: k === 0 || k === mid || k === span.columns - 1 });
    }
    return pts;
  });

  const appendColumn = (x: number, z: number, scale = 1) => {
    const gc = Math.min(map.effectiveGround(x, z), g0 + 0.5);
    const base = gc - 0.8; // sink so no gap where terrain dips
    box(stone, x, base + (g0 + 0.7 - base) / 2, z, 3.0 * scale, g0 + 0.7 - base, 3.0 * scale, TRIM);
    box(stone, x, g0 + 0.92, z, 2.55 * scale, 0.44, 2.55 * scale, STONE);
    tube(stone, x, g0 + 1.14, z, g0 + 1.78, 1.42 * scale, 1.28 * scale, 12, TRIM);
    tube(stone, x, g0 + 1.78, z, g0 + SHAFT_TOP, 1.22 * scale, 1.02 * scale, 12, SHAFT);
    tube(stone, x, g0 + 13.66, z, g0 + SHAFT_TOP, 1.3 * scale, 1.16 * scale, 12, TRIM);
    tube(stone, x, g0 + SHAFT_TOP, z, g0 + CAP_TOP - 0.35, 1.18 * scale, 1.8 * scale, 12, TRIM);
    tube(stone, x, g0 + CAP_TOP - 0.35, z, g0 + CAP_TOP, 1.85 * scale, 1.52 * scale, 8, STONE);
    box(stone, x, g0 + CAP_TOP + 0.18, z, 3.3 * scale, 0.36, 3.3 * scale, TRIM);
  };

  // Regular bays use one column; the ends and midpoint of each detached wing
  // use the documented four-column clusters under large planter/attic boxes.
  for (const span of spans) for (const p of span) {
    if (!p.cluster) {
      appendColumn(p.x, p.z);
      continue;
    }
    const tx = -Math.sin(p.t), tz = Math.cos(p.t);
    const rx = Math.cos(p.t), rz = Math.sin(p.t);
    for (const tangent of [-1.75, 1.75]) for (const radial of [-1.5, 1.5]) {
      appendColumn(p.x + tx * tangent + rx * radial, p.z + tz * tangent + rz * radial, 1.06);
    }
  }

  // --- entablature + cornice: each wing is independent across the centre gap ---
  for (const span of spans) for (let k = 0; k < span.length - 1; k++) {
    const a = span[k];
    const b = span[k + 1];
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const half = Math.hypot(b.x - a.x, b.z - a.z) / 2 + 0.9;
    const yaw = -Math.atan2(b.z - a.z, b.x - a.x); // box local +x along the chord
    box(stone, mx, g0 + (CAP_TOP + ENTAB_TOP) / 2, mz, half * 2, ENTAB_TOP - CAP_TOP, 2.1, STONE, yaw); // architrave/frieze
    box(stone, mx, g0 + 16.35, mz, half * 2, 0.34, 2.28, RELIEF, yaw); // shadowed relief band
    box(stone, mx, g0 + (ENTAB_TOP + CORNICE_TOP) / 2, mz, half * 2, CORNICE_TOP - ENTAB_TOP, 2.7, TRIM, yaw); // cornice lip

    // Deep dentils make the cornice silhouette read even at lagoon distance.
    for (let d = -2; d <= 2; d++) {
      const f = d / 5;
      box(
        stone,
        mx + (b.x - a.x) * f,
        g0 + ENTAB_TOP - 0.22,
        mz + (b.z - a.z) * f,
        0.42,
        0.44,
        2.72,
        RELIEF,
        yaw
      );
    }
  }

  // Great planter boxes over every four-column cluster are the peristyle's
  // defining skyline rhythm in both the historic report and reference photos.
  for (const span of spans) for (const p of span) {
    if (!p.cluster) continue;
    const yaw = -(p.t + Math.PI / 2);
    box(stone, p.x, g0 + (CORNICE_TOP + ATTIC_TOP + 0.8) / 2, p.z, 7.2, ATTIC_TOP + 0.8 - CORNICE_TOP, 5.2, STONE, yaw);
    box(stone, p.x, g0 + 19.55, p.z, 5.8, 1.18, 5.35, RELIEF, yaw);
    box(stone, p.x, g0 + ATTIC_TOP + 0.92, p.z, 7.55, 0.34, 5.6, TRIM, yaw);
    tube(stone, p.x, g0 + ATTIC_TOP + 1.08, p.z, g0 + ATTIC_TOP + 3.05, 0.62, 0.38, 7, FIGURE);
    blob(stone, p.x, g0 + ATTIC_TOP + 3.36, p.z, 0.4, 0.47, 0.4, FIGURE, 0);
  }

  // The baked rotunda carries the big arch/dome silhouette. These runtime
  // layers add the high-frequency classical detail the distant baked mesh lacks:
  // inset frieze panels, cornice rings, dentils and parapet figures.
  torus(stone, CX, g0 + 24.45, CZ, 16.72, 0.32, TRIM);
  torus(stone, CX, g0 + 27.55, CZ, 17.2, 0.34, TRIM);
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const x = CX + Math.cos(a) * 17.08;
    const z = CZ + Math.sin(a) * 17.08;
    const tangentYaw = -(a + Math.PI / 2);
    if (k % 3 !== 0) {
      box(stone, x, g0 + 25.9, z, 3.78, 1.95, 0.28, k % 2 ? RELIEF : STONE, tangentYaw);
      box(stone, CX + Math.cos(a) * 17.27, g0 + 25.9, CZ + Math.sin(a) * 17.27, 1.28, 0.78, 0.16, FIGURE, tangentYaw);
    }
    box(stone, x, g0 + 27.05, z, 0.48, 0.46, 1.18, RELIEF, tangentYaw);
  }

  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    const x = CX + Math.cos(a) * 15.55;
    const z = CZ + Math.sin(a) * 15.55;
    box(stone, x, g0 + 28.35, z, 1.45, 0.34, 1.45, TRIM, -a);
    tube(stone, x, g0 + 28.52, z, g0 + 30.65, 0.52, 0.3, 7, FIGURE);
    blob(stone, x, g0 + 30.98, z, 0.34, 0.42, 0.34, FIGURE, 0);
  }

  // Raised dome ribs restore the strong vertical cadence visible in the real
  // copper roof. Short straight chords are visually smooth at this scale while
  // keeping the embellishment cheap and merged with the rest of the stonework.
  const domeProfile = [
    { y: 31.65, r: 14.15 },
    { y: 35.2, r: 13.2 },
    { y: 38.55, r: 11.25 },
    { y: 41.8, r: 8.9 },
    { y: 44.55, r: 6.15 },
    { y: 46.55, r: 2.1 }
  ];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    for (let p = 0; p < domeProfile.length - 1; p++) {
      const d0 = domeProfile[p];
      const d1 = domeProfile[p + 1];
      beam(
        stone,
        new THREE.Vector3(CX + Math.cos(a) * d0.r, g0 + d0.y, CZ + Math.sin(a) * d0.r),
        new THREE.Vector3(CX + Math.cos(a) * d1.r, g0 + d1.y, CZ + Math.sin(a) * d1.r),
        0.16,
        TRIM
      );
    }
  }

  // Deep, asymmetric planting beds frame the rotunda like the real lagoon-side
  // gardens. Tree crowns are clustered low-poly solids: one merged draw, stable
  // silhouettes and no alpha-sorting shimmer against the fog.
  const trees = [
    { x: -354, z: -1457, h: 13.5, s: 1.0 },
    { x: -358, z: -1384, h: 11.5, s: 0.86 },
    { x: -424, z: -1471, h: 10.5, s: 0.82 },
    { x: -426, z: -1384, h: 9.5, s: 0.76 },
    { x: -439, z: -1428, h: 12.5, s: 0.9 }
  ];
  trees.forEach((tree, ti) => {
    const ground = map.effectiveGround(tree.x, tree.z);
    tube(planting, tree.x, ground - 0.2, tree.z, ground + tree.h * 0.62, 0.55 * tree.s, 0.34 * tree.s, 7, TRUNK);
    for (let k = 0; k < 14; k++) {
      const a = rand(ti * 19 + k) * Math.PI * 2;
      const radial = (0.8 + rand(ti * 31 + k + 7) * 2.7) * tree.s;
      const y = ground + tree.h * (0.48 + rand(ti * 43 + k + 13) * 0.46);
      const c = k % 3 === 0 ? LEAF_MID : LEAF_DARK;
      blob(
        planting,
        tree.x + Math.cos(a) * radial,
        y,
        tree.z + Math.sin(a) * radial,
        (1.65 + rand(k + ti * 5) * 1.15) * tree.s,
        (1.95 + rand(k + ti * 7) * 1.45) * tree.s,
        (1.65 + rand(k + ti * 11) * 1.15) * tree.s,
        c,
        1
      );
    }
  });

  // Foundation shrubs soften the hard plinth and hide terrain seams without
  // closing the eastern arrival path through the principal arch.
  for (let k = 0; k < 26; k++) {
    const a = (k / 26) * Math.PI * 2 + 0.12;
    if (Math.cos(a) > 0.72) continue;
    const r = 19.6 + rand(k + 70) * 3.5;
    const x = CX + Math.cos(a) * r;
    const z = CZ + Math.sin(a) * r;
    const ground = map.effectiveGround(x, z);
    const s = 1.2 + rand(k + 90) * 1.15;
    blob(planting, x, ground + s * 0.62, z, s, s * 0.72, s, k % 4 ? LEAF_DARK : LEAF_MID, 1);
  }

  // Broad-leaf foreground banks on the lagoon's east edge reproduce the dark,
  // layered foreground of the reference view and give the water a natural rim.
  for (let bank = 0; bank < 16; bank++) {
    const a = THREE.MathUtils.lerp(-1.12, 1.12, bank / 15) + (rand(bank + 120) - 0.5) * 0.08;
    const x = PALACE_LAGOON.x + Math.cos(a) * PALACE_LAGOON.radiusX * 1.01;
    const z = PALACE_LAGOON.z + Math.sin(a) * PALACE_LAGOON.radiusZ * 1.01;
    const ground = Math.max(PALACE_LAGOON.surfaceY + 0.04, map.effectiveGround(x, z));
    for (let k = 0; k < 7; k++) {
      const heading = a + Math.PI / 2 + (rand(bank * 17 + k + 140) - 0.5) * 1.2;
      const length = 1.25 + rand(bank * 23 + k + 180) * 1.35;
      leaf(
        planting,
        x + (rand(bank * 29 + k + 220) - 0.5) * 3.8,
        ground + 0.18 + rand(bank * 37 + k + 260) * 0.28,
        z + (rand(bank * 41 + k + 300) - 0.5) * 3.8,
        length,
        heading,
        -0.2 - rand(bank * 43 + k + 340) * 0.42,
        k % 3 === 0 ? LEAF_LIGHT : k % 2 ? LEAF_DARK : LEAF_MID
      );
    }
  }

  // Quiet lily-pad drifts break up the lagoon's empty center while leaving a
  // broad, mirror-like reflection lane between the east shore and rotunda.
  for (let k = 0; k < 42; k++) {
    const a = rand(k + 410) * Math.PI * 2;
    const f = Math.sqrt(0.18 + rand(k + 470) * 0.7);
    const x = PALACE_LAGOON.x + Math.cos(a) * PALACE_LAGOON.radiusX * f;
    const z = PALACE_LAGOON.z + Math.sin(a) * PALACE_LAGOON.radiusZ * f;
    if (x > -318 && Math.abs(z - PALACE_LAGOON.z) < 28) continue;
    const r = 0.5 + rand(k + 530) * 0.85;
    lilyPad(planting, x, PALACE_LAGOON.surfaceY + 0.2, z, r, rand(k + 590) * Math.PI * 2, k % 3 ? PAD_DARK : PAD_LIGHT);
    if (k % 9 === 0) blob(planting, x, PALACE_LAGOON.surfaceY + 0.37, z, 0.22, 0.13, 0.22, LILY, 1);
  }

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  const mesh = new THREE.Mesh(mergeGeometries(stone, false)!, mat);
  mesh.name = "palace_peristyle_stone";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  const plantMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, side: THREE.DoubleSide });
  const plantMesh = new THREE.Mesh(mergeGeometries(planting, false)!, plantMat);
  plantMesh.name = "palace_garden_planting";
  plantMesh.castShadow = true;
  plantMesh.receiveShadow = true;
  group.add(plantMesh);

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
