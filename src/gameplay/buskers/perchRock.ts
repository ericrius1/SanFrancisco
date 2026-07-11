import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";

/**
 * The buskers' perch: a broad flat-topped chert boulder they sit on, legs
 * dangling over the front (-Z) lip. Same weathered red-radiolarian palette and
 * flat-shaded faceting as the Corona Heights summit crags, so it reads as a
 * piece of the hill rather than a prop — a low, wide slab with a level sittable
 * cap and a buried base that tucks into any slope we drop it on.
 *
 * Placeless by design (like the whole trio): the base sinks well below the
 * group origin so a hillside never floats it, and setColliderTransform re-pins
 * the walkable box wherever setPlacement moves it.
 */

export const PERCH = {
  width: 5.0, // X — full width of the flat cap
  depth: 1.45, // Z — front-to-back of the cap (half the original slab so it doesn't fill the shot)
  top: 1.3 // cap surface height above the group origin (ground contact point)
} as const;

const SINK = 1.7; // how far the buried base drops below the origin
const SEG = 20; // angular facets around the boulder
const SUPER_N = 4; // superellipse exponent → rounded-rectangle cap (straight front edge for the seats)

export type BuskerPerch = {
  group: THREE.Group;
  /** re-anchor the static collider after setPlacement */
  setColliderTransform: (x: number, y: number, z: number, yaw: number) => void;
  dispose: () => void;
};

// Chert palette — identical hues to src/world/coronaHeights/summitCrags.ts so
// the perch and the summit read as the same rock.
const BED_RUST = new THREE.Color(0xa85f45);
const BED_MAROON = new THREE.Color(0x8a4a3a);
const BED_PALE = new THREE.Color(0xb37a58);
const TOP_WEATHER = new THREE.Color(0xd2ab7a);
const SKIRT_DUST = new THREE.Color(0xb08a63);
const LICHEN = new THREE.Color(0x9aa678);

function fract(v: number) {
  return v - Math.floor(v);
}
function hash(a: number, b: number, c = 0) {
  return fract(Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453123);
}
function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

type Vec3 = { x: number; y: number; z: number };

/** Rounded-rectangle outline point (superellipse) at parameter angle θ, semi-
 * axes ax/az. n=4 gives near-straight edges with softened corners so the three
 * seats along the front (-Z) share a level lip. */
function outline(theta: number, ax: number, az: number): { x: number; z: number } {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const e = 2 / SUPER_N;
  return {
    x: ax * Math.sign(c) * Math.abs(c) ** e,
    z: az * Math.sign(s) * Math.abs(s) ** e
  };
}

/** Build the boulder mesh: a stack of jittered rings (buried base → belly →
 * shoulder → flat cap) skinned with flat-shaded chert facets, capped on top by
 * a level fan the buskers sit on. */
function buildRockMesh(): THREE.Mesh {
  const ax0 = PERCH.width / 2;
  const az0 = PERCH.depth / 2;

  // Rings from the flat cap down to the buried base. Each ring carries TWO
  // scales on the cap outline: `side` (back + sides — the natural boulder bulge)
  // and `front` (the -Z seating face). The front rings tuck INWARD below the
  // lip so the wall undercuts the cap — nothing protrudes past the edge to catch
  // a dangling foot, and the buskers' legs hang in clear air over the drop.
  const RINGS = [
    { y: PERCH.top, side: 1.0, front: 1.0, jit: 0.05, cap: true }, // flat sittable cap (the overhanging lip)
    { y: PERCH.top - 0.3, side: 1.02, front: 0.85, jit: 0.09 }, // just under the lip: sides vertical, front undercut
    { y: PERCH.top * 0.4, side: 1.12, front: 0.9, jit: 0.15 }, // belly (bulges on the sides/back only)
    { y: -SINK, side: 0.98, front: 0.82, jit: 0.05 } // buried base tucks in all round
  ];

  // ring[j][i] = local-space vertex of ring j at segment i.
  const ring: Vec3[][] = RINGS.map((r, j) => {
    const pts: Vec3[] = [];
    for (let i = 0; i < SEG; i++) {
      const theta = (i / SEG) * Math.PI * 2;
      const o = outline(theta, ax0, az0); // cap-reference outline
      // frontness: 1 at the -Z front centre (under the dangling legs), 0 across
      // the back and sides — blends the front undercut into the side bulge.
      const f = clamp01(-o.z / az0);
      const s = r.side + (r.front - r.side) * f;
      const jx = (hash(j, i, 1) - 0.5) * 2 * r.jit;
      const jz = (hash(j, i, 2) - 0.5) * 2 * r.jit;
      // Keep the cap dead level for seating (tiny y wobble only); lower rings
      // heave more so the silhouette breaks into facets, not a lathe surface.
      const jy = r.cap ? (hash(j, i, 3) - 0.5) * 0.04 : (hash(j, i, 3) - 0.5) * 2 * r.jit * 0.8;
      pts.push({ x: o.x * s + jx, y: r.y + jy, z: o.z * s + jz });
    }
    return pts;
  });

  const positions: number[] = [];
  const colors: number[] = [];
  const base = new THREE.Color();
  const color = new THREE.Color();
  const vcol = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };
  let faceSeed = 0;

  const pushTri = (a: Vec3, b: Vec3, c: Vec3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    let fnx = aby * acz - abz * acy;
    let fny = abz * acx - abx * acz;
    let fnz = abx * acy - aby * acx;
    const fl = Math.hypot(fnx, fny, fnz) || 1;
    fnx /= fl; fny /= fl; fnz /= fl;
    const midY = (a.y + b.y + c.y) / 3;
    const hRel = clamp01((midY + SINK) / (PERCH.top + SINK));
    const up = Math.abs(fny);

    // Height-banded bedding: rust body, maroon mid-band, pale near the cap.
    const pick = hash(faceSeed, 53, 7);
    base.copy(hRel > 0.72 ? BED_PALE : hRel > 0.4 && pick < 0.5 ? BED_MAROON : BED_RUST);
    base.offsetHSL((hash(faceSeed, 59) - 0.5) * 0.02, (hash(faceSeed, 61) - 0.5) * 0.06, (hash(faceSeed, 67) - 0.5) * 0.05);
    color.copy(base);
    // Sun-weathered tan on up-facing facets (the cap + belly shelves catch it).
    if (fny > 0.35) color.lerp(TOP_WEATHER, clamp01((fny - 0.35) / 0.65) * (0.5 + hash(faceSeed, 71) * 0.3));
    // Sparse sage lichen on upper walls; never on the flat cap (green carpet from above).
    if (up < 0.7 && hRel > 0.4 && hash(faceSeed, 73) < 0.09) color.lerp(LICHEN, 0.34);
    // Dust skirt where the rock meets the dirt.
    if (hRel < 0.22) color.lerp(SKIRT_DUST, (1 - hRel / 0.22) * 0.5);
    // Facet mottle, keyed per face so the triangle pair stays one whole facet.
    color.offsetHSL(0, 0, (hash(faceSeed, 79) - 0.5) * 0.11);
    // Albedo floor: shade-side facets read as dim rust under sky ambient, never black.
    color.getHSL(hsl);
    if (hsl.l < 0.33) color.offsetHSL(0, 0, 0.33 - hsl.l);
    for (let v = 0; v < 3; v++) {
      vcol.copy(color).offsetHSL(0, 0, (hash(faceSeed, 83, v) - 0.5) * 0.06);
      colors.push(vcol.r, vcol.g, vcol.b);
    }
  };
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
    pushTri(a, b, c);
    pushTri(a, c, d);
    faceSeed++;
  };

  // Walls between successive rings, wound CCW seen from outside.
  for (let j = 0; j < ring.length - 1; j++) {
    const up = ring[j];
    const lo = ring[j + 1];
    for (let i = 0; i < SEG; i++) {
      const n = (i + 1) % SEG;
      quad(up[i], lo[i], lo[n], up[n]);
    }
  }

  // Flat top cap: fan from a (near-level) centre to the rim.
  const cap = ring[0];
  let cx = 0, cz = 0, cy = 0;
  for (const p of cap) { cx += p.x; cz += p.z; cy += p.y; }
  const centre: Vec3 = { x: cx / SEG, y: cy / SEG + 0.015, z: cz / SEG };
  for (let i = 0; i < SEG; i++) {
    const n = (i + 1) % SEG;
    pushTri(centre, cap[i], cap[n]);
    faceSeed++;
  }
  // Buried base cap so no hole shows from below on a steep drop.
  const bot = ring[ring.length - 1];
  const bc: Vec3 = { x: 0, y: -SINK - 0.1, z: 0 };
  for (let i = 0; i < SEG; i++) {
    const n = (i + 1) % SEG;
    pushTri(bc, bot[n], bot[i]);
    faceSeed++;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals(); // non-indexed → true flat facets
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.93,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide, // closed boulder; DoubleSide keeps any facet lit right regardless of winding
    // Sky-bounce stand-in (same as the crags): shade-side facets read as dark
    // rust under hemisphere light, never as black voids.
    emissive: 0x2d1a14,
    emissiveIntensity: 1
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "busker_perch_rock";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildPerchRock(physics: Physics | null): BuskerPerch {
  const group = new THREE.Group();
  const mesh = buildRockMesh();
  group.add(mesh);

  // One static box for the walkable cap (blocks walkers/vehicles, catches paint
  // and the grab ray). Kept just inside the rim so you can climb up beside the trio.
  const hx = (PERCH.width / 2) * 0.9;
  const hy = PERCH.top / 2;
  const hz = (PERCH.depth / 2) * 0.9;
  let body: number | null = null;
  if (physics) {
    body = physics.world.createBox({
      type: BodyType.Static,
      position: [0, hy, 0],
      halfExtents: [hx, hy, hz],
      friction: 0.85
    });
  }

  const setColliderTransform = (x: number, y: number, z: number, yaw: number) => {
    if (!physics || body === null) return;
    const cy = y + hy;
    physics.world.setBodyTransform(body, [x, cy, z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    physics.addQuerySolid(body, { x, y: cy, z, hx, hy, hz, yaw });
  };

  return {
    group,
    setColliderTransform,
    dispose: () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  };
}
