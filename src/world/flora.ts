import * as THREE from "three/webgpu";
import { attribute, float, hash, instanceIndex, positionLocal, sin, time, vec3 } from "three/tsl";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldMap } from "./heightmap";

type N = any;

/**
 * Flora: the vegetation layer. Three cooperating systems share one small
 * library of hand-shaped low-poly trees (displaced, flat-shaded — crafted
 * silhouettes instead of stacked perfect cones):
 *
 *  - a tree bank of 5 species × variants (conifer/redwood, Monterey cypress,
 *    coast live oak, eucalyptus, palm) plus understory bushes and grass tufts
 *  - NEAR-FIELD DENSIFIER: deterministic cell-hashed instanced trees + bushes
 *    that follow the camera around the Marin headlands, thickening the far
 *    forest only where you can actually see trunks
 *  - PARK SCATTER: each streamed tile's `grn_` meshes get one merged tree
 *    mesh (streams in/out with the tile) and a 4 m grass-height mask
 *  - GRASS FIELD: one instanced mesh of wind-blown tufts rebuilt around the
 *    camera — golden-green over Marin ground, lush green wherever a park
 *    mask says there's lawn — plus a wildflower pool riding the same rebuild
 *
 * Tree crowns are branch lattices under alpha-tested leaf-card sprays (a
 * procedural atlas, one shared material) — airy silhouettes up close, with
 * visible limbs carrying the foliage instead of cartoon canopy blobs.
 *
 * Everything is cosmetic (no physics bodies), deterministic (same world for
 * every client), and pure mix-style shader math — no If() branches.
 */

// Marin: everything north of the Golden Gate's landfall
export const MARIN = { minX: -6300, maxX: -2700, minZ: -7800, maxZ: -5000 };
const BRIDGE_LANDING = { x: -3150, z: -5100 };

// grass field (camera-following)
const GRASS_CAP = 7500;
const GRASS_CELL = 4;
const GRASS_R = 92;
const GRASS_REBUILD_DIST = 8;
const FLOWER_CAP = 700;

// near-field Marin trees (camera-following)
const NEAR_R = 360;
const NEAR_CELL = 26;
const NEAR_REBUILD_DIST = 18;
const NEAR_CAPS = { conifer: 900, cypress: 340, oak: 340, bush: 1260 } as const;

// park scatter
const PARK_TREE_AREA = 250; // one tree per ~250 m² of lawn
const PARK_TREE_CAP = 620;

const MASK_SENTINEL = -32768;

// no-flora zones: custom layers own these floors (a draped park strip crosses
// the Pier 15 deck, and grass through the Exploratorium floor breaks the place)
const NO_FLORA = [
  { cx: 4084.7, cz: -1271.5, yaw: -2.523, hu: 190, hv: 48 }, // Exploratorium: full Pier 15 deck
  { cx: -388, cz: -1426, yaw: 0, hu: 46, hv: 46 } // Palace of Fine Arts: no trees silhouetting the columns (colonnade r33), no grass through the rotunda court
].map((b) => ({ cx: b.cx, cz: b.cz, cos: Math.cos(b.yaw), sin: Math.sin(b.yaw), hu: b.hu, hv: b.hv }));

function inNoFlora(x: number, z: number): boolean {
  for (const b of NO_FLORA) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    const u = dx * b.cos + dz * b.sin;
    const v = dz * b.cos - dx * b.sin;
    if (Math.abs(u) < b.hu && Math.abs(v) < b.hv) return true;
  }
  return false;
}

/** Deterministic layout — the same flora grows every session, every client. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Position-keyed jitter: duplicated vertices (non-indexed icospheres) get the
 * exact same displacement, so shapes stay watertight and flat shading shows
 * facets instead of cracks.
 */
function posJit(x: number, y: number, z: number, seed: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 53.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Vertex-paint a geometry, with optional position-keyed brightness streaks. */
function paint(g: THREE.BufferGeometry, hex: number, jitter = 0, seed = 1): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const p = g.getAttribute("position");
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const m = jitter > 0 ? 1 - jitter / 2 + posJit(p.getX(i), p.getY(i), p.getZ(i), seed) * jitter : 1;
    colors[i * 3] = c.r * m;
    colors[i * 3 + 1] = c.g * m;
    colors[i * 3 + 2] = c.b * m;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  // painted parts are solid — park their UVs on the atlas' opaque tile so the
  // shared alpha-tested leaf material never eats a trunk fragment
  const uv = g.getAttribute("uv");
  if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, SOLID_U, SOLID_V);
  return g;
}

/* ------------------------------------------------------------------------ */
/* foliage atlas + leaf cards                                                 */
/* ------------------------------------------------------------------------ */

// 2×2 atlas tiles in UV space (flipY canvas): lower-left corner of each tile
const TILE_LEAF = 0;
// tile 1 = needle sprays (kept in the atlas, currently unused — conifers stay pure cones)
const TILE_WISP = 2;
const TILE_UV = [
  { u: 0.0, v: 0.5 }, // broadleaf clusters (canvas top-left)
  { u: 0.5, v: 0.5 }, // needle sprays (canvas top-right)
  { u: 0.0, v: 0.0 } // hanging wisps (canvas bottom-left)
];
// centre of the solid tile (canvas bottom-right) — constant UV = mip 0 = pure white
const SOLID_U = 0.75;
const SOLID_V = 0.25;

let atlasTex: THREE.CanvasTexture | null = null;

/**
 * Procedural white-on-transparent leaf atlas: broadleaf clusters, needle
 * sprays, hanging wisps, and one solid tile for trunks/cones/branches. Drawn in
 * milliseconds at boot; vertex colors supply all hue. RGB is flattened to
 * white everywhere so mipmap averaging against transparent texels never
 * produces dark halos around leaves.
 */
function foliageAtlas(): THREE.CanvasTexture {
  if (atlasTex) return atlasTex;
  const S = 512;
  const T = S / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const rnd = mulberry32(7331);
  ctx.fillStyle = "#fff";
  // broadleaf cluster: overlapping ellipse leaves, dense centre, ragged rim
  ctx.save();
  ctx.translate(T / 2, T / 2);
  for (let i = 0; i < 64; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.pow(rnd(), 0.6) * 92;
    ctx.save();
    ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
    ctx.rotate(rnd() * Math.PI * 2);
    ctx.globalAlpha = 0.85 + rnd() * 0.15;
    ctx.beginPath();
    ctx.ellipse(0, 0, 10 + rnd() * 8, 19 + rnd() * 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  // needle spray: short radiating strokes
  ctx.save();
  ctx.translate(T + T / 2, T / 2);
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  for (let i = 0; i < 90; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.pow(rnd(), 0.7) * 68;
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    const na = a + (rnd() - 0.5) * 0.9;
    const len = 22 + rnd() * 22;
    ctx.globalAlpha = 0.8 + rnd() * 0.2;
    ctx.lineWidth = 4.5 + rnd() * 3.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(na) * len, y + Math.sin(na) * len);
    ctx.stroke();
  }
  ctx.restore();
  // wisps: long thin leaves hanging mostly downward (eucalyptus)
  ctx.save();
  ctx.translate(T / 2, T + T / 2);
  for (let i = 0; i < 42; i++) {
    ctx.save();
    ctx.translate((rnd() - 0.5) * 165, (rnd() - 0.5) * 165);
    ctx.rotate((rnd() - 0.5) * 1.1 + Math.PI / 2);
    ctx.globalAlpha = 0.8 + rnd() * 0.2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 5.5 + rnd() * 3.5, 20 + rnd() * 16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  // solid tile: fully opaque — alphaTest never fires for solid geometry
  ctx.globalAlpha = 1;
  ctx.fillRect(T + 1, T + 1, T - 2, T - 2);
  // flatten RGB to white so mip averaging with transparent (rgb 0) texels
  // can't darken leaf rims
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
  ctx.putImageData(img, 0, 0);
  atlasTex = new THREE.CanvasTexture(canvas);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.anisotropy = 4;
  return atlasTex;
}

/**
 * Leaf-card shell: alpha-tested quads scattered over a foliage clump's
 * surface. Normals are radial (bent slightly along each card's spine) so the
 * whole cluster shades like one rounded mass instead of a pile of flat
 * stickers — the LAAS cluster-card trick, minus the baked impostors. Both
 * windings are emitted so a FrontSide material shows both faces without the
 * DoubleSide backface normal flip.
 */
function leafCards(
  cx: number,
  cy: number,
  cz: number,
  r: number,
  count: number,
  rnd: () => number,
  hexA: number,
  hexB: number,
  tile: number,
  opts: { flatten?: number; droop?: number; out?: number; wMul?: number; hMul?: number } = {}
): THREE.BufferGeometry {
  const flatten = opts.flatten ?? 0.75;
  const droop = opts.droop ?? 0;
  const outTilt = opts.out ?? 0.55;
  const wMul = opts.wMul ?? 1;
  const hMul = opts.hMul ?? 1;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvA: number[] = [];
  const col: number[] = [];
  const d = new THREE.Vector3();
  const right = new THREE.Vector3();
  const spine = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const nb = new THREE.Vector3();
  const nt = new THREE.Vector3();
  const c = new THREE.Color();
  const base = TILE_UV[tile];
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let i = 0; i < count; i++) {
    do {
      d.set(rnd() * 2 - 1, (rnd() * 2 - 1) * flatten, rnd() * 2 - 1);
    } while (d.lengthSq() < 0.05);
    d.normalize();
    const rad = r * (0.7 + rnd() * 0.35);
    const px = cx + d.x * rad;
    const py = cy + d.y * rad * flatten;
    const pz = cz + d.z * rad;
    tmp.set(0, 1, 0);
    if (Math.abs(d.y) > 0.88) tmp.set(1, 0, 0);
    right.crossVectors(tmp, d).normalize();
    // random roll around the outward axis
    const roll = (rnd() - 0.5) * 1.6;
    spine.crossVectors(d, right);
    right.multiplyScalar(Math.cos(roll)).addScaledVector(spine, Math.sin(roll)).normalize();
    spine.crossVectors(d, right).normalize();
    if (spine.y < 0) spine.negate(); // spines grow up-and-out, never into the trunk
    spine.addScaledVector(d, outTilt);
    spine.y -= droop;
    spine.normalize();
    const w = r * (1.0 + rnd() * 0.6) * wMul;
    const h = r * (1.05 + rnd() * 0.65) * hMul;
    corners[0].set(px, py, pz).addScaledVector(right, -w / 2);
    corners[1].set(px, py, pz).addScaledVector(right, w / 2);
    corners[2].copy(corners[0]).addScaledVector(spine, h).addScaledVector(right, w * 0.08);
    corners[3].copy(corners[1]).addScaledVector(spine, h).addScaledVector(right, -w * 0.08);
    nb.copy(d).addScaledVector(spine, -0.35).normalize();
    nt.copy(d).addScaledVector(spine, 0.35).normalize();
    c.set(lerpHex(hexA, hexB, rnd()));
    const b = 0.52 + (d.y * 0.5 + 0.5) * 0.3; // sun side brighter, never washed out
    const mirror = rnd() < 0.5;
    const u0 = base.u + (mirror ? 0.46 : 0.04);
    const u1 = base.u + (mirror ? 0.04 : 0.46);
    const v0 = base.v + 0.04;
    const v1 = base.v + 0.46;
    const uvs = [
      [u0, v0],
      [u1, v0],
      [u0, v1],
      [u1, v1]
    ];
    // both windings of the same quad — FrontSide shows both faces, lit alike
    for (const order of [
      [0, 1, 2, 1, 3, 2],
      [2, 1, 0, 2, 3, 1]
    ]) {
      for (const k of order) {
        const cp = corners[k];
        pos.push(cp.x, cp.y, cp.z);
        const n = k < 2 ? nb : nt;
        nrm.push(n.x, n.y, n.z);
        uvA.push(uvs[k][0], uvs[k][1]);
        const bb = k < 2 ? b * 0.82 : b; // card bases sit deeper in shade
        col.push(c.r * bb, c.g * bb, c.b * bb);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvA), 2));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
  return g;
}

/** Tapered cylinder between two points; used for authored branch structure. */
function branchSegment(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r0: number,
  r1: number,
  hex: number,
  seed: number,
  sides = 6
): THREE.BufferGeometry {
  const start = new THREE.Vector3(ax, ay, az);
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, false);
  g.translate(0, len / 2, 0);
  dir.normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  g.translate(start.x, start.y, start.z);
  return paint(g, hex, 0.34, seed);
}

/** Small faceted knot/crown filler; large broadleaf canopies use branches instead. */
function blob(r: number, seed: number, hex: number, flatten = 0.75, jag = 0.26): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 1);
  const p = g.getAttribute("position");
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    const m = 1 + (posJit(v.x, v.y, v.z, seed) - 0.5) * 2 * jag;
    p.setXYZ(i, v.x * m, v.y * m * flatten, v.z * m);
  }
  return paint(g, hex, 0.22, seed + 9);
}

/** Roughen a cone's base ring — jagged skirts read as branches, not lampshades. */
function jagBase(g: THREE.BufferGeometry, seed: number, radial: number, droop: number) {
  const p = g.getAttribute("position");
  let minY = Infinity;
  for (let i = 0; i < p.count; i++) minY = Math.min(minY, p.getY(i));
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > minY + 1e-4) continue;
    const x = p.getX(i);
    const z = p.getZ(i);
    const m = 1 + (posJit(x, 0, z, seed) - 0.5) * 2 * radial;
    p.setXYZ(i, x * m, minY - posJit(z, 1, x, seed) * droop, z * m);
  }
}

function lerpHex(a: number, b: number, t: number): number {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}

/** Redwood/conifer: tapered trunk, 5 tilted jagged cone tiers, shade→sun tint. */
function coniferGeometry(rnd: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cards: THREE.BufferGeometry[] = [];
  const trunkH = 7 + rnd() * 2.5;
  const trunk = paint(new THREE.CylinderGeometry(0.24, 0.85, trunkH, 7), 0x4b3526, 0.35, rnd() * 100);
  trunk.translate(0, trunkH / 2, 0);
  parts.push(trunk);
  const layers = 5;
  let y = trunkH * 0.55;
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const r = (4.5 - t * 3.1) * (0.9 + rnd() * 0.22);
    const h = 6.4 - t * 2.6;
    const cone = new THREE.ConeGeometry(r, h, 9, 1, true);
    jagBase(cone, rnd() * 100, 0.22, h * 0.14);
    paint(cone, lerpHex(0x27462e, 0x578a4b, t * (0.8 + rnd() * 0.35)), 0.18, rnd() * 100);
    cone.rotateX((rnd() - 0.5) * 0.12);
    cone.rotateZ((rnd() - 0.5) * 0.12);
    const ox = (rnd() - 0.5) * 0.7;
    const oz = (rnd() - 0.5) * 0.7;
    cone.translate(ox, y + h / 2, oz);
    parts.push(cone);
    // no leaf cards on conifers — needle sprays fought the hard cone
    // silhouette and read as a second overlapping tree (seen live)
    y += 2.9 - t * 0.7;
  }
  return finalizeTree(parts, cards, rnd);
}

/** Monterey cypress: leaning trunk, wind-flattened branch tiers stacked downwind. */
function cypressGeometry(rnd: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cards: THREE.BufferGeometry[] = [];
  const lean = 0.1 + rnd() * 0.14;
  const trunkH = 3.4 + rnd() * 1.2;
  const trunk = paint(new THREE.CylinderGeometry(0.26, 0.52, trunkH, 7), 0x5c4432, 0.3, rnd() * 100);
  trunk.translate(0, trunkH / 2, 0);
  trunk.rotateZ(-lean);
  parts.push(trunk);
  const shades = [0x3a5a35, 0x4b6f3e, 0x5b7f46];
  const crownX = trunkH * Math.sin(lean);
  const n = 4;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const sx = crownX * 0.52 + (rnd() - 0.5) * 0.18;
    const sy = trunkH * (0.68 + t * 0.18);
    const sz = (rnd() - 0.5) * 0.28;
    const bx = crownX + 0.9 + t * 1.9 + (rnd() - 0.5) * 0.45;
    const by = trunkH + 0.05 + t * 1.45 + rnd() * 0.4;
    const bz = (rnd() - 0.5) * (0.85 + t * 0.7);
    const tipX = bx + 0.75 + rnd() * 0.55;
    const tipY = by + 0.1 + rnd() * 0.45;
    const tipZ = bz + (rnd() - 0.5) * 0.85;
    const wood = lerpHex(0x51412f, 0x776247, t * 0.45);
    parts.push(branchSegment(sx, sy, sz, bx, by, bz, 0.14 - t * 0.025, 0.06, wood, rnd() * 100, 5));
    parts.push(branchSegment(bx, by, bz, tipX, tipY, tipZ, 0.07, 0.025, wood, rnd() * 100, 5));
    cards.push(
      leafCards(bx, by + 0.05, bz, 1.1 + rnd() * 0.2, 9, rnd, shades[i % shades.length], 0x648a4c, TILE_LEAF, {
        flatten: 0.45,
        out: 0.72,
        wMul: 0.82,
        hMul: 0.78
      })
    );
    cards.push(
      leafCards(tipX, tipY, tipZ, 0.85 + rnd() * 0.18, 7, rnd, lerpHex(shades[i % shades.length], 0x263f25, 0.16), 0x6f9652, TILE_LEAF, {
        flatten: 0.42,
        out: 0.75,
        wMul: 0.72,
        hMul: 0.72
      })
    );
  }
  return finalizeTree(parts, cards, rnd);
}

/** Coast live oak: stout trunk, visible limb network, layered leaf sprays. */
function oakGeometry(rnd: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cards: THREE.BufferGeometry[] = [];
  const trunk = paint(new THREE.CylinderGeometry(0.4, 0.68, 2.6, 7), 0x54402e, 0.35, rnd() * 100);
  trunk.translate(0, 1.3, 0);
  parts.push(trunk);
  const b1 = paint(new THREE.CylinderGeometry(0.14, 0.24, 1.8, 5), 0x54402e, 0.3, rnd() * 100);
  b1.rotateZ(0.7);
  b1.translate(0.85, 2.7, 0.1);
  parts.push(b1);
  const b2 = paint(new THREE.CylinderGeometry(0.13, 0.22, 1.6, 5), 0x54402e, 0.3, rnd() * 100);
  b2.rotateZ(-0.6);
  b2.rotateY(1.9);
  b2.translate(-0.7, 2.65, -0.25);
  parts.push(b2);
  const limbs: [number, number, number, number, number, number, number, number][] = [
    [0.05, 2.35, 0, 1.55, 3.25, 0.55, 0.24, 0.1],
    [-0.05, 2.35, -0.05, -1.45, 3.32, -0.55, 0.22, 0.095],
    [0, 2.5, 0, 0.45, 3.75, 1.55, 0.2, 0.085],
    [0, 2.55, -0.02, -0.55, 3.68, -1.45, 0.2, 0.085],
    [0, 2.65, 0, 0.1, 4.25, 0.08, 0.18, 0.075]
  ];
  for (const [ax, ay, az, bx0, by0, bz0, r0, r1] of limbs) {
    const bx = bx0 + (rnd() - 0.5) * 0.35;
    const by = by0 + (rnd() - 0.5) * 0.25;
    const bz = bz0 + (rnd() - 0.5) * 0.35;
    const wood = lerpHex(0x4b3828, 0x6a5239, rnd() * 0.35);
    parts.push(branchSegment(ax, ay, az, bx, by, bz, r0, r1, wood, rnd() * 100, 6));
    const baseAng = Math.atan2(bz, bx);
    const twigs = by > 4 ? 3 : 2;
    for (let j = 0; j < twigs; j++) {
      const spread = (j - (twigs - 1) / 2) * 0.64 + (rnd() - 0.5) * 0.28;
      const len = 0.75 + rnd() * 0.65;
      const a = baseAng + spread;
      const tx = bx + Math.cos(a) * len;
      const ty = by + 0.22 + rnd() * 0.5;
      const tz = bz + Math.sin(a) * len;
      parts.push(branchSegment(bx, by, bz, tx, ty, tz, r1 * 0.78, 0.025, wood, rnd() * 100, 5));
      cards.push(
        leafCards(tx, ty, tz, 0.9 + rnd() * 0.28, 9, rnd, 0x3f6238, 0x6d9250, TILE_LEAF, {
          flatten: 0.62,
          out: 0.78,
          wMul: 0.74,
          hMul: 0.72
        })
      );
    }
    cards.push(
      leafCards(bx, by + 0.08, bz, 1.02 + rnd() * 0.25, 8, rnd, 0x385832, 0x668c4b, TILE_LEAF, {
        flatten: 0.58,
        out: 0.72,
        wMul: 0.78,
        hMul: 0.72
      })
    );
  }
  return finalizeTree(parts, cards, rnd);
}

/** Eucalyptus: tall pale streaked trunk, high branchlets with drooping leaves. */
function eucalyptusGeometry(rnd: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cards: THREE.BufferGeometry[] = [];
  const trunkH = 9 + rnd() * 2.5;
  const lean = (rnd() - 0.5) * 0.12;
  const trunk = paint(new THREE.CylinderGeometry(0.22, 0.5, trunkH, 7), 0xb3a48d, 0.4, rnd() * 100);
  trunk.translate(0, trunkH / 2, 0);
  trunk.rotateZ(lean);
  parts.push(trunk);
  const shades = [0x7f9b73, 0x94ad80, 0x86a276];
  const crownX = -Math.sin(lean) * trunkH;
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 1.0 + rnd() * 1.45;
    const sx = crownX * (0.48 + rnd() * 0.22);
    const sy = trunkH * (0.68 + rnd() * 0.18);
    const sz = (rnd() - 0.5) * 0.45;
    const gx = crownX + Math.cos(a) * d;
    const gy = trunkH - 1.2 + rnd() * 2.25;
    const gz = Math.sin(a) * d;
    const tx = gx + Math.cos(a + (rnd() - 0.5) * 0.7) * (0.55 + rnd() * 0.45);
    const ty = gy + 0.2 + rnd() * 0.35;
    const tz = gz + Math.sin(a + (rnd() - 0.5) * 0.7) * (0.55 + rnd() * 0.45);
    const wood = lerpHex(0x9d907a, 0x665944, rnd() * 0.25);
    parts.push(branchSegment(sx, sy, sz, gx, gy, gz, 0.105, 0.045, wood, rnd() * 100, 6));
    parts.push(branchSegment(gx, gy, gz, tx, ty, tz, 0.052, 0.02, wood, rnd() * 100, 5));
    // long drooping wisps — sage foliage hangs off the crown
    cards.push(
      leafCards(gx, gy, gz, 0.95 + rnd() * 0.2, 9, rnd, lerpHex(shades[i % shades.length], 0x55684a, 0.45), 0x78946e, TILE_WISP, {
        flatten: 0.8,
        out: 0.55,
        droop: 0.7,
        wMul: 0.46,
        hMul: 1.05
      })
    );
    cards.push(
      leafCards(tx, ty, tz, 0.72 + rnd() * 0.16, 6, rnd, lerpHex(shades[i % shades.length], 0x4b6242, 0.35), 0x89a179, TILE_WISP, {
        flatten: 0.78,
        out: 0.58,
        droop: 0.78,
        wMul: 0.42,
        hMul: 1.0
      })
    );
  }
  return finalizeTree(parts, cards, rnd);
}

/** Palm: curving segmented trunk, drooping tapered fronds. */
function palmGeometry(rnd: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const segs = 6;
  const curve = (rnd() - 0.5) * 0.09;
  let topX = 0;
  for (let i = 0; i < segs; i++) {
    const seg = paint(new THREE.CylinderGeometry(0.16, 0.21, 1.35, 6), 0x8d7a5c, 0.35, rnd() * 100 + i);
    topX = curve * i * i;
    seg.translate(topX, i * 1.25 + 0.65, 0);
    parts.push(seg);
  }
  const topY = segs * 1.25 + 0.2;
  const crown = blob(0.34, rnd() * 100, 0x6b5638, 0.9, 0.2);
  crown.translate(topX, topY, 0);
  parts.push(crown);
  const fronds = 9;
  for (let i = 0; i < fronds; i++) {
    const f = new THREE.PlaneGeometry(0.55, 3.0, 1, 3);
    f.rotateX(-Math.PI / 2); // lie along +Z
    const p = f.getAttribute("position");
    for (let j = 0; j < p.count; j++) {
      const t = (p.getZ(j) + 1.5) / 3.0; // 0 at butt, 1 at tip
      p.setX(j, p.getX(j) * (1 - t * 0.75));
      p.setY(j, 0.35 * t - t * t * 1.5);
      p.setZ(j, p.getZ(j) + 1.5);
    }
    paint(f, lerpHex(0x557d3b, 0x79a54f, rnd()), 0.2, rnd() * 100);
    f.rotateY((i / fronds) * Math.PI * 2 + rnd() * 0.5);
    f.translate(topX, topY, 0);
    parts.push(f);
    // fronds are single planes — bake the reversed winding so a FrontSide
    // material shows both faces (the merged park material is no longer DoubleSide)
    const back = f.clone();
    const idx = back.getIndex()!;
    for (let j = 0; j < idx.count; j += 3) {
      const sw = idx.getX(j);
      idx.setX(j, idx.getX(j + 2));
      idx.setX(j + 2, sw);
    }
    parts.push(back);
  }
  return finalizeTree(parts, [], rnd);
}

/** Understory bush: twig fan with leaf sprays, no solid ball core. */
function bushGeometry(rnd: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cards: THREE.BufferGeometry[] = [];
  const r = 0.85 + rnd() * 0.5;
  const stems = 7 + Math.floor(rnd() * 3);
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * Math.PI * 2 + (rnd() - 0.5) * 0.55;
    const d = r * (0.38 + rnd() * 0.55);
    const tx = Math.cos(a) * d;
    const ty = r * (0.45 + rnd() * 0.55);
    const tz = Math.sin(a) * d;
    const midX = tx * (0.32 + rnd() * 0.18);
    const midY = ty * 0.46;
    const midZ = tz * (0.32 + rnd() * 0.18);
    const wood = lerpHex(0x4a3829, 0x63513a, rnd() * 0.35);
    parts.push(branchSegment(0, 0.08, 0, midX, midY, midZ, 0.045, 0.025, wood, rnd() * 100, 5));
    parts.push(branchSegment(midX, midY, midZ, tx, ty, tz, 0.026, 0.012, wood, rnd() * 100, 5));
    cards.push(
      leafCards(tx, ty, tz, r * (0.42 + rnd() * 0.15), 5, rnd, 0x40603a, 0x6a904f, TILE_LEAF, {
        flatten: 0.55,
        out: 0.72,
        wMul: 0.7,
        hMul: 0.68
      })
    );
  }
  return finalizeTree(parts, cards, rnd);
}

/**
 * Merge parts → flat-shaded, sway-weighted tree. aSway rises from the base to
 * the crown (the wind grabs foliage, not roots), aPhase de-syncs neighbours,
 * and a vertical ambient gradient grounds the silhouette. Leaf cards merge in
 * AFTER the flat-shading normal recompute — their hand-set radial normals are
 * the whole trick and must survive.
 */
function finalizeTree(parts: THREE.BufferGeometry[], cards: THREE.BufferGeometry[], rnd: () => number): THREE.BufferGeometry {
  // cylinders/cones are indexed, icospheres aren't — de-index everything, which
  // also gives per-face vertices for true flat shading after the merge
  const soup = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const solid = mergeGeometries(soup);
  for (const p of parts) p.dispose();
  for (const p of soup) if (p !== solid) p.dispose();
  solid.computeVertexNormals();
  let g = solid;
  if (cards.length > 0) {
    g = mergeGeometries([solid, ...cards]);
    solid.dispose();
    for (const cg of cards) cg.dispose();
  }
  const p = g.getAttribute("position");
  const col = g.getAttribute("color");
  let maxY = 0;
  for (let i = 0; i < p.count; i++) maxY = Math.max(maxY, p.getY(i));
  const sway = new Float32Array(p.count);
  const phase = new Float32Array(p.count).fill(rnd() * 6.283);
  for (let i = 0; i < p.count; i++) {
    const ny = THREE.MathUtils.clamp(p.getY(i) / maxY, 0, 1);
    sway[i] = Math.pow(THREE.MathUtils.clamp((p.getY(i) - 1.2) / (maxY * 0.85 - 1.2), 0, 1), 1.4);
    const shade = 0.8 + 0.4 * ny;
    col.setXYZ(i, col.getX(i) * shade, col.getY(i) * shade, col.getZ(i) * shade);
  }
  g.setAttribute("aSway", new THREE.BufferAttribute(sway, 1));
  g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  return g;
}

/**
 * Grass tuft: 5 individually-shaped blades — tapered 2-segment strips with a
 * quadratic tip bend, leaning outward from the tuft centre. Every blade is
 * duplicated with reversed winding so a FrontSide material shows both faces
 * WITHOUT the DoubleSide backface normal flip; normals stay up-dominant (with
 * a hint of sideways for shape) so blades take the lawn's lighting instead of
 * going black when viewed from behind.
 */
function grassTuftGeometry(): THREE.BufferGeometry {
  const rnd = mulberry32(4242);
  const parts: THREE.BufferGeometry[] = [];
  const blades = 5;
  for (let i = 0; i < blades; i++) {
    const h = 0.5 + rnd() * 0.42;
    const q = new THREE.PlaneGeometry(0.085, h, 1, 2);
    q.translate(0, h / 2, 0);
    const qp = q.getAttribute("position");
    const bend = (0.35 + rnd() * 0.5) * h; // quadratic tip curve
    for (let j = 0; j < qp.count; j++) {
      const t = qp.getY(j) / h;
      qp.setX(j, qp.getX(j) * (1 - t * 0.82)); // taper to a near-point tip
      qp.setZ(j, t * t * bend);
      qp.setY(j, qp.getY(j) - t * t * bend * 0.25); // bent blades sag a little
    }
    const a = (i / blades) * Math.PI * 2 + rnd() * 1.2;
    q.rotateY(a);
    const rr = 0.04 + rnd() * 0.13; // blades fan out from the tuft centre
    q.translate(Math.sin(a) * rr, 0, Math.cos(a) * rr);
    parts.push(q);
    const back = q.clone();
    const idx = back.getIndex()!;
    for (let j = 0; j < idx.count; j += 3) {
      const sw = idx.getX(j);
      idx.setX(j, idx.getX(j + 2));
      idx.setX(j + 2, sw);
    }
    parts.push(back);
  }
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const p = g.getAttribute("position");
  const uv = g.getAttribute("uv");
  const colors = new Float32Array(p.count * 3);
  const normals = g.getAttribute("normal");
  const sway = new Float32Array(p.count);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const t = uv.getY(i); // 0 base, 1 tip (survives the bend, unlike y)
    const b = 0.52 + t * 0.72; // deep AO at the base → bright tip
    colors[i * 3] = b * (1 + t * 0.16); // tips shift warm toward straw
    colors[i * 3 + 1] = b * (1 + t * 0.05);
    colors[i * 3 + 2] = b * (1 - t * 0.1);
    v.set(p.getX(i) * 1.6, 1, p.getZ(i) * 1.6).normalize(); // up-dominant, faintly rounded
    normals.setXYZ(i, v.x, v.y, v.z);
    sway[i] = t * t * 1.15; // tips ride the wind, bases stay planted
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.setAttribute("aSway", new THREE.BufferAttribute(sway, 1));
  g.setAttribute("aPhase", new THREE.BufferAttribute(new Float32Array(p.count), 1)); // per-instance hash supplies phase
  return g;
}

/**
 * Wildflower: crossed stem quads + a petal head (two crossed quads and a top
 * cap). Stem vertex colors are olive so instanceColor tints the head hard and
 * the stem barely; normals point up like the grass so flowers take the lawn's
 * light. Reversed-winding duplicates, same as the tufts.
 */
function flowerGeometry(): THREE.BufferGeometry {
  const rnd = mulberry32(9182);
  const parts: THREE.BufferGeometry[] = [];
  const stemH = 0.42;
  const push = (q: THREE.BufferGeometry) => {
    parts.push(q);
    const back = q.clone();
    const idx = back.getIndex()!;
    for (let j = 0; j < idx.count; j += 3) {
      const sw = idx.getX(j);
      idx.setX(j, idx.getX(j + 2));
      idx.setX(j + 2, sw);
    }
    parts.push(back);
  };
  for (let i = 0; i < 2; i++) {
    const s = new THREE.PlaneGeometry(0.032, stemH);
    s.translate(0, stemH / 2, 0);
    s.rotateY((i * Math.PI) / 2 + rnd());
    push(s);
  }
  for (let i = 0; i < 2; i++) {
    const petal = new THREE.PlaneGeometry(0.15, 0.13);
    petal.translate(0, stemH + 0.02, 0);
    petal.rotateY((i * Math.PI) / 2 + 0.4);
    push(petal);
  }
  const cap = new THREE.PlaneGeometry(0.15, 0.15);
  cap.rotateX(-Math.PI / 2);
  cap.translate(0, stemH + 0.06, 0);
  push(cap);
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const p = g.getAttribute("position");
  const normals = g.getAttribute("normal");
  const colors = new Float32Array(p.count * 3);
  const sway = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const head = y > stemH - 0.045;
    colors[i * 3] = head ? 1 : 0.26;
    colors[i * 3 + 1] = head ? 1 : 0.5;
    colors[i * 3 + 2] = head ? 1 : 0.2;
    normals.setXYZ(i, 0, 1, 0);
    const t = Math.min(1, Math.max(0, y / stemH));
    sway[i] = t * t;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.setAttribute("aSway", new THREE.BufferAttribute(sway, 1));
  g.setAttribute("aPhase", new THREE.BufferAttribute(new Float32Array(p.count), 1));
  return g;
}

export type TreeKind = "conifer" | "cypress" | "oak" | "eucalyptus" | "palm" | "bush";
const BUILDERS: Record<TreeKind, (rnd: () => number) => THREE.BufferGeometry> = {
  conifer: coniferGeometry,
  cypress: cypressGeometry,
  oak: oakGeometry,
  eucalyptus: eucalyptusGeometry,
  palm: palmGeometry,
  bush: bushGeometry
};
const VARIANTS = 4;

let bank: Record<TreeKind, THREE.BufferGeometry[]> | null = null;

/** The shared species bank: VARIANTS pre-built geometries per kind. */
export function treeBank(): Record<TreeKind, THREE.BufferGeometry[]> {
  if (bank) return bank;
  bank = {} as Record<TreeKind, THREE.BufferGeometry[]>;
  const kinds = Object.keys(BUILDERS) as TreeKind[];
  for (let k = 0; k < kinds.length; k++) {
    const list: THREE.BufferGeometry[] = [];
    for (let v = 0; v < VARIANTS; v++) list.push(BUILDERS[kinds[k]](mulberry32(k * 1009 + v * 77 + 5)));
    bank[kinds[k]] = list;
  }
  return bank;
}

/** Wind sway. Instanced pools add a per-instance phase on top of aPhase. */
function makeSwayMaterial(amp: number, instanced: boolean, doubleSide: boolean, leafMap = false): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide
  });
  if (leafMap) {
    // leaf cards punch their shapes out of the shared atlas; solid parts sit
    // on the opaque tile so the alphaTest never bites them
    mat.map = foliageAtlas();
    mat.alphaTest = 0.24;
  }
  const sway: N = attribute("aSway", "float");
  let ph: N = attribute("aPhase", "float");
  if (instanced) ph = ph.add((hash(instanceIndex) as N).mul(6.283));
  const gust: N = (sin(time.mul(0.9).add(ph)) as N).mul(0.6).add((sin(time.mul(0.27).add(ph.mul(0.7))) as N).mul(0.4));
  const cross: N = sin(time.mul(0.71).add(ph.mul(1.31)));
  // slow amplitude envelope — calm spells and gusts instead of a metronome
  const gustAmp: N = (sin(time.mul(0.16).add(ph.mul(0.41))) as N).mul(0.35).add(0.8);
  mat.positionNode = (positionLocal as N).add(
    vec3(gust.mul(amp), float(0), cross.mul(amp * 0.8)).mul(sway).mul(gustAmp)
  );
  mat.envMapIntensity = 0.5;
  return mat;
}

let sharedInstanced: THREE.MeshStandardNodeMaterial | null = null;
let sharedMerged: THREE.MeshStandardNodeMaterial | null = null;

/** One material for every instanced tree pool (Marin far forest + near-field). */
export function treeMaterialInstanced(): THREE.MeshStandardNodeMaterial {
  if (!sharedInstanced) sharedInstanced = makeSwayMaterial(0.34, true, false, true);
  return sharedInstanced;
}

/**
 * One material for every merged park-tile tree mesh. FrontSide: palm fronds
 * and leaf cards bake reversed windings instead — DoubleSide here doubled the
 * fragment bill for every park tree in view.
 */
function treeMaterialMerged(): THREE.MeshStandardNodeMaterial {
  if (!sharedMerged) sharedMerged = makeSwayMaterial(0.34, false, false, true);
  return sharedMerged;
}

const noRaycast = () => {};

type ManifestLike = { tile: number; minX: number; minZ: number };

// park-tile scatter job, drained one slice per frame
type FloraJob = {
  key: string;
  group: THREE.Group;
  tris?: number[];
  cdf?: number[];
  area?: number;
  masked?: boolean;
  plant?: {
    rnd: () => number;
    taken: Set<string>;
    pieces: THREE.BufferGeometry[];
    // interim merges of ~PLANT_MERGE_BATCH pieces each: a single 500-tree merge
    // costs ~25 ms, so it's paid in batches across slices instead
    merged: THREE.BufferGeometry[];
    attempts: number;
    count: number;
    north: boolean;
  };
};

// per-frame time budget for one scatter slice — half a 120 Hz frame
const PLANT_BUDGET_MS = 4;
const PLANT_MERGE_BATCH = 128;

type NearPool = {
  kind: TreeKind;
  mesh: THREE.InstancedMesh;
  cap: number;
  n: number;
};

export class Flora {
  #map: WorldMap;
  #manifest: ManifestLike;
  #maskW: number;
  #masks = new Map<string, Int16Array>();
  // per-tile merged park-tree meshes, kept so they can be hidden when high
  #tileTrees = new Map<string, THREE.Mesh>();

  #grass: THREE.InstancedMesh;
  #flowers: THREE.InstancedMesh;
  #grassCenter = new THREE.Vector2(1e9, 1e9);

  #pools: NearPool[] = [];
  #nearCenter = new THREE.Vector2(1e9, 1e9);

  #mat4 = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();
  #axisY = new THREE.Vector3(0, 1, 0);
  #color = new THREE.Color();
  #colA = new THREE.Color();
  #colB = new THREE.Color();

  constructor(map: WorldMap, scene: THREE.Scene, manifest: ManifestLike) {
    this.#map = map;
    this.#manifest = manifest;
    this.#maskW = Math.ceil(manifest.tile / GRASS_CELL);

    const grassMat = makeSwayMaterial(0.13, true, false); // both faces baked into the geometry
    grassMat.roughness = 1;
    grassMat.envMapIntensity = 0.35;
    this.#grass = new THREE.InstancedMesh(grassTuftGeometry(), grassMat, GRASS_CAP);
    this.#grass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#grass.setColorAt(0, this.#color.set("#ffffff"));
    this.#grass.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.#grass.count = 0;
    this.#grass.frustumCulled = false;
    this.#grass.receiveShadow = true;
    this.#grass.raycast = noRaycast;
    scene.add(this.#grass);

    const flowerMat = makeSwayMaterial(0.09, true, false);
    flowerMat.roughness = 0.9;
    flowerMat.envMapIntensity = 0.35;
    this.#flowers = new THREE.InstancedMesh(flowerGeometry(), flowerMat, FLOWER_CAP);
    this.#flowers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#flowers.setColorAt(0, this.#color.set("#ffffff"));
    this.#flowers.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.#flowers.count = 0;
    this.#flowers.frustumCulled = false;
    this.#flowers.receiveShadow = true;
    this.#flowers.raycast = noRaycast;
    scene.add(this.#flowers);

    const b = treeBank();
    const mat = treeMaterialInstanced();
    for (const kind of ["conifer", "cypress", "oak", "bush"] as TreeKind[]) {
      const cap = NEAR_CAPS[kind as keyof typeof NEAR_CAPS];
      const mesh = new THREE.InstancedMesh(b[kind][1], mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.raycast = noRaycast;
      scene.add(mesh);
      this.#pools.push({ kind, mesh, cap, n: 0 });
    }
  }

  /* ------------------------------------------------------------------ */
  /* park scatter: called by the tile streamer when a tile lands          */
  /* ------------------------------------------------------------------ */

  buildMs: { key: string; ms: number }[] = [];

  // a 500-tree merge costs ~25 ms and tiles land in bursts — queue the work
  // and pay one small slice per frame (mask, then ~120 trees at a time)
  #jobs: FloraJob[] = [];

  onTileGreens(key: string, group: THREE.Group) {
    this.#jobs.push({ key, group });
  }

  #drainJob() {
    const job = this.#jobs[0];
    if (!job) return;
    const t0 = performance.now();
    if (!job.group.parent) {
      // tile streamed back out before we planted
      this.#jobs.shift();
      this.#masks.delete(job.key);
      if (job.plant) {
        for (const p of job.plant.pieces) p.dispose();
        for (const p of job.plant.merged) p.dispose();
      }
    } else if (job.tris === undefined) {
      // phase 1: world triangles + area cdf
      if (!this.#extractGreens(job)) this.#jobs.shift();
    } else if (!job.masked) {
      // phase 2: grass-height mask (its own slice — big parks rasterize slowly)
      this.#masks.set(job.key, this.#rasterizeMask(job.key, job.tris));
      job.masked = true;
    } else if (this.#plantSlice(job, t0 + PLANT_BUDGET_MS)) {
      this.#jobs.shift();
    }
    this.buildMs.push({ key: job.key, ms: Math.round(performance.now() - t0) });
    if (this.buildMs.length > 40) this.buildMs.shift();
  }

  /** Phase 1 of a tile job. Returns false when the tile has no usable lawn. */
  #extractGreens(job: FloraJob): boolean {
    const { group } = job;
    const greens: THREE.Mesh[] = [];
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.name.startsWith("grn_")) greens.push(mesh);
    });
    if (greens.length === 0) return false;

    // world-space triangle soup + running area cdf
    const tris: number[] = []; // 9 floats per tri
    const cdf: number[] = [];
    let area = 0;
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    for (const mesh of greens) {
      const geo = mesh.geometry;
      const p = geo.getAttribute("position");
      const idx = geo.getIndex();
      const triCount = (idx ? idx.count : p.count) / 3;
      for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        va.fromBufferAttribute(p, i0).applyMatrix4(mesh.matrixWorld);
        vb.fromBufferAttribute(p, i1).applyMatrix4(mesh.matrixWorld);
        vc.fromBufferAttribute(p, i2).applyMatrix4(mesh.matrixWorld);
        e1.subVectors(vb, va);
        e2.subVectors(vc, va);
        const a2 = e1.cross(e2).length();
        if (!(a2 > 1e-6)) continue;
        tris.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
        area += a2 / 2;
        cdf.push(area);
      }
    }
    if (area < 30) return false;

    job.tris = tris;
    job.cdf = cdf;
    job.area = area;
    return true;
  }

  dropTile(key: string) {
    this.#masks.delete(key);
    this.#tileTrees.delete(key);
    this.#jobs = this.#jobs.filter((j) => j.key !== key);
  }

  /** Lawn-height mask: 4 m cells, Int16 decimetres (parks sit lifted off the heightmap). */
  #rasterizeMask(key: string, tris: number[]): Int16Array {
    const [ixs, izs] = key.split("_").map(Number);
    const ox = this.#manifest.minX + ixs * this.#manifest.tile;
    const oz = this.#manifest.minZ + izs * this.#manifest.tile;
    const w = this.#maskW;
    const mask = new Int16Array(w * w).fill(MASK_SENTINEL);
    for (let t = 0; t < tris.length; t += 9) {
      const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
      const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
      const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
      const minCx = Math.max(0, Math.floor((Math.min(ax, bx, cx) - ox) / GRASS_CELL));
      const maxCx = Math.min(w - 1, Math.floor((Math.max(ax, bx, cx) - ox) / GRASS_CELL));
      const minCz = Math.max(0, Math.floor((Math.min(az, bz, cz) - oz) / GRASS_CELL));
      const maxCz = Math.min(w - 1, Math.floor((Math.max(az, bz, cz) - oz) / GRASS_CELL));
      const d = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (Math.abs(d) < 1e-9) continue;
      for (let cz2 = minCz; cz2 <= maxCz; cz2++) {
        for (let cx2 = minCx; cx2 <= maxCx; cx2++) {
          const px = ox + (cx2 + 0.5) * GRASS_CELL;
          const pz = oz + (cz2 + 0.5) * GRASS_CELL;
          const w0 = ((bx - px) * (cz - pz) - (bz - pz) * (cx - px)) / d;
          const w1 = ((cx - px) * (az - pz) - (cz - pz) * (ax - px)) / d;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
          const y = w0 * ay + w1 * by + w2 * cy;
          mask[cz2 * w + cx2] = Math.max(mask[cz2 * w + cx2], Math.round(y * 10));
        }
      }
    }
    return mask;
  }

  /**
   * Plant trees of a tile job until the slice deadline, merging into one mesh
   * (a single draw that streams with the tile) on the final slice. Returns true
   * when the job is finished.
   */
  #plantSlice(job: FloraJob, deadline: number): boolean {
    const { key, tris, cdf, area } = job as Required<FloraJob>;
    if (!job.plant) {
      const [ixs, izs] = key.split("_").map(Number);
      const centerZ = this.#manifest.minZ + izs * this.#manifest.tile + this.#manifest.tile / 2;
      const count = Math.min(PARK_TREE_CAP, Math.floor(area / PARK_TREE_AREA));
      if (count === 0) return true;
      job.plant = {
        rnd: mulberry32(((ixs * 73856093) ^ (izs * 19349663)) >>> 0),
        taken: new Set<string>(),
        pieces: [],
        merged: [],
        attempts: 0,
        count,
        north: centerZ < -4600 // Marin side: no palms, more conifers
      };
    }
    const P = job.plant;
    // enough pieces piled up? spend this whole slice folding them into one
    // interim geometry instead of planting more
    if (P.pieces.length >= PLANT_MERGE_BATCH) {
      P.merged.push(mergeGeometries(P.pieces));
      for (const p of P.pieces) p.dispose();
      P.pieces.length = 0;
      return false;
    }
    const rnd = P.rnd;
    const north = P.north;
    const count = P.count;
    const taken = P.taken;
    const pieces = P.pieces;
    const b = treeBank();
    const n = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const planted = () => P.merged.length * PLANT_MERGE_BATCH + pieces.length;
    for (; P.attempts < count * 6 && planted() < count; P.attempts++) {
      if ((P.attempts & 15) === 0 && performance.now() > deadline) return false; // resume next frame
      if (pieces.length >= PLANT_MERGE_BATCH) return false; // fold on the next slice
      // area-weighted triangle pick
      const r = rnd() * area;
      let lo = 0;
      let hi = cdf.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      const t = lo * 9;
      let u = rnd();
      let v = rnd();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const px = tris[t] + (tris[t + 3] - tris[t]) * u + (tris[t + 6] - tris[t]) * v;
      const py = tris[t + 1] + (tris[t + 4] - tris[t + 1]) * u + (tris[t + 7] - tris[t + 1]) * v;
      const pz = tris[t + 2] + (tris[t + 5] - tris[t + 2]) * u + (tris[t + 8] - tris[t + 2]) * v;
      // steep bank? skip
      e1.set(tris[t + 3] - tris[t], tris[t + 4] - tris[t + 1], tris[t + 5] - tris[t + 2]);
      e2.set(tris[t + 6] - tris[t], tris[t + 7] - tris[t + 1], tris[t + 8] - tris[t + 2]);
      n.crossVectors(e1, e2).normalize();
      if (Math.abs(n.y) < 0.72) continue; // hill parks keep their trees; true cliffs don't
      if (inNoFlora(px, pz) || this.#map.lagoonWater(px, pz)) continue; // keep trees out of the lagoon
      // 6 m spacing grid
      const gk = `${Math.round(px / 6)}:${Math.round(pz / 6)}`;
      if (taken.has(gk)) continue;
      taken.add(gk);

      const roll = rnd();
      let kind: TreeKind;
      if (north) kind = roll < 0.42 ? "conifer" : roll < 0.68 ? "cypress" : roll < 0.86 ? "oak" : "bush";
      else if (roll < 0.3) kind = "oak";
      else if (roll < 0.48) kind = "cypress";
      else if (roll < 0.66) kind = "eucalyptus";
      else if (roll < 0.76) kind = "palm";
      else if (roll < 0.86) kind = "conifer";
      else kind = "bush"; // understory keeps lawns from reading as empty golf greens

      const proto = b[kind][Math.floor(rnd() * VARIANTS)];
      const g = proto.clone();
      (g.getAttribute("aPhase").array as Float32Array).fill(rnd() * 6.283);
      const s = kind === "bush" ? 1.0 + rnd() * 0.9 : (kind === "palm" ? 0.85 : 0.8) + rnd() * 0.55;
      this.#quat.setFromAxisAngle(this.#axisY, rnd() * Math.PI * 2);
      this.#mat4.compose(this.#pos.set(px, py - 0.15, pz), this.#quat, this.#scale.setScalar(s));
      g.applyMatrix4(this.#mat4);
      pieces.push(g);
    }
    if (planted() < count && P.attempts < count * 6) return false; // more slices to go
    const parts = [...P.merged, ...pieces];
    if (parts.length > 0) {
      // final merge: a handful of interim geometries + the tail — raw buffer
      // copies, far cheaper than merging hundreds of small pieces at once
      const merged = mergeGeometries(parts);
      for (const p of parts) p.dispose();
      const mesh = new THREE.Mesh(merged, treeMaterialMerged());
      mesh.name = `flora_${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.raycast = noRaycast;
      mesh.visible = !this.#hidden;
      job.group.add(mesh);
      this.#tileTrees.set(key, mesh);
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* camera-following systems                                             */
  /* ------------------------------------------------------------------ */

  /** Headless-verify hook: live instance counts per system. */
  get stats() {
    return {
      grass: this.#grass.count,
      flowers: this.#flowers.count,
      pools: this.#pools.map((p) => ({ kind: p.kind, n: p.n })),
      masks: this.#masks.size,
      jobs: this.#jobs.length,
      hidden: this.#hidden
    };
  }

  // way up in a plane, ground-level flora is subpixel: hide the camera-following
  // systems and stop paying for scatter jobs / rebuilds until the player descends.
  // jobs stay queued (dropTile prunes them when tiles stream out), so parks fill
  // back in on the way down.
  #hidden = false;

  update(viewPos: THREE.Vector3, highUp = false) {
    if (highUp) {
      if (!this.#hidden) {
        this.#hidden = true;
        this.#grass.visible = false;
        this.#flowers.visible = false;
        for (const p of this.#pools) p.mesh.visible = false;
        for (const m of this.#tileTrees.values()) m.visible = false;
      }
      return;
    }
    if (this.#hidden) {
      this.#hidden = false;
      this.#grass.visible = true;
      this.#flowers.visible = true;
      for (const p of this.#pools) p.mesh.visible = true;
      for (const m of this.#tileTrees.values()) m.visible = true;
    }
    this.#drainJob();
    const dxg = viewPos.x - this.#grassCenter.x;
    const dzg = viewPos.z - this.#grassCenter.y;
    if (dxg * dxg + dzg * dzg > GRASS_REBUILD_DIST * GRASS_REBUILD_DIST) {
      this.#grassCenter.set(viewPos.x, viewPos.z);
      this.#rebuildGrass(viewPos.x, viewPos.z);
    }
    const dxn = viewPos.x - this.#nearCenter.x;
    const dzn = viewPos.z - this.#nearCenter.y;
    if (dxn * dxn + dzn * dzn > NEAR_REBUILD_DIST * NEAR_REBUILD_DIST) {
      this.#nearCenter.set(viewPos.x, viewPos.z);
      this.#rebuildNearForest(viewPos.x, viewPos.z);
    }
  }

  /** Park lawn height at (x,z), or null when there's no lawn there. */
  #lawnHeight(x: number, z: number): number | null {
    const ix = Math.floor((x - this.#manifest.minX) / this.#manifest.tile);
    const iz = Math.floor((z - this.#manifest.minZ) / this.#manifest.tile);
    const mask = this.#masks.get(`${ix}_${iz}`);
    if (!mask) return null;
    const cx = Math.floor((x - this.#manifest.minX - ix * this.#manifest.tile) / GRASS_CELL);
    const cz = Math.floor((z - this.#manifest.minZ - iz * this.#manifest.tile) / GRASS_CELL);
    const v = mask[cz * this.#maskW + cx];
    if (v === MASK_SENTINEL || inNoFlora(x, z) || this.#map.lagoonWater(x, z)) return null;
    return v / 10;
  }

  /** Open Marin ground suitable for grass (and small trees). */
  #marinGround(x: number, z: number): number | null {
    if (x < MARIN.minX || x > MARIN.maxX || z < MARIN.minZ || z > MARIN.maxZ) return null;
    if (this.#map.isWater(x, z)) return null;
    const g = this.#map.groundHeight(x, z);
    if (g < 2) return null;
    const deck = this.#map.bridgeDeck(x, z);
    if (deck > -Infinity && Math.abs(deck - g) < 4) return null;
    if (Math.hypot(x - BRIDGE_LANDING.x, z - BRIDGE_LANDING.z) < 60) return null;
    return g;
  }

  #rebuildGrass(cx: number, cz: number) {
    const mesh = this.#grass;
    const fmesh = this.#flowers;
    let n = 0;
    let nf = 0;
    const minIx = Math.floor((cx - GRASS_R) / GRASS_CELL);
    const maxIx = Math.floor((cx + GRASS_R) / GRASS_CELL);
    const minIz = Math.floor((cz - GRASS_R) / GRASS_CELL);
    const maxIz = Math.floor((cz + GRASS_R) / GRASS_CELL);
    const inMarinBand =
      cx > MARIN.minX - GRASS_R && cx < MARIN.maxX + GRASS_R && cz > MARIN.minZ - GRASS_R && cz < MARIN.maxZ + GRASS_R;
    this.#colA.set(0x688f40); // lush lawn
    this.#colB.set(0xbfa75c); // Marin summer gold
    outer: for (let iz = minIz; iz <= maxIz; iz++) {
      for (let ix = minIx; ix <= maxIx; ix++) {
        const wx = ix * GRASS_CELL + GRASS_CELL / 2;
        const wz = iz * GRASS_CELL + GRASS_CELL / 2;
        const dx = wx - cx;
        const dz = wz - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > (GRASS_R + 3) * (GRASS_R + 3)) continue;
        // cheap cell gate: park mask first (SF), Marin ground second
        let marin = false;
        let baseY = this.#lawnHeight(wx, wz);
        if (baseY === null && inMarinBand) {
          baseY = this.#marinGround(wx, wz);
          if (baseY !== null) {
            // cliffs shed grass too
            if (Math.abs(this.#map.groundHeight(wx + 4, wz) - this.#map.groundHeight(wx - 4, wz)) > 5) continue;
            marin = true;
          }
        }
        if (baseY === null) continue;
        const rnd = mulberry32((((ix * 73856093) ^ (iz * 19349663)) >>> 0) + 11);
        const tufts = 3 + ((rnd() * 2.2) | 0);
        const fade = Math.min(1, (GRASS_R - Math.sqrt(d2)) / 16);
        if (fade <= 0.04) continue;
        for (let k = 0; k < tufts; k++) {
          const px = ix * GRASS_CELL + rnd() * GRASS_CELL;
          const pz = iz * GRASS_CELL + rnd() * GRASS_CELL;
          const y = marin ? this.#map.groundHeight(px, pz) : baseY;
          const s = (0.75 + rnd() * 0.7) * fade;
          this.#quat.setFromAxisAngle(this.#axisY, rnd() * Math.PI * 2);
          this.#mat4.compose(
            this.#pos.set(px, y - 0.04, pz),
            this.#quat,
            this.#scale.set(s, s * (0.8 + rnd() * 0.55), s)
          );
          mesh.setMatrixAt(n, this.#mat4);
          const gold = marin ? 0.35 + rnd() * 0.45 : 0.04 + rnd() * 0.22;
          this.#color.copy(this.#colA).lerp(this.#colB, gold);
          const v = 0.82 + rnd() * 0.24;
          mesh.setColorAt(n, this.#color.multiplyScalar(v));
          n++;
          if (n >= GRASS_CAP) break outer;
        }
        // wildflowers: California poppies over Marin gold, cottage colours on lawns
        if (nf < FLOWER_CAP && fade > 0.4 && rnd() < (marin ? 0.07 : 0.13)) {
          const fn = 1 + ((rnd() * 2.2) | 0);
          for (let k = 0; k < fn && nf < FLOWER_CAP; k++) {
            const px = ix * GRASS_CELL + rnd() * GRASS_CELL;
            const pz = iz * GRASS_CELL + rnd() * GRASS_CELL;
            const y = marin ? this.#map.groundHeight(px, pz) : baseY;
            const s = 0.75 + rnd() * 0.6;
            this.#quat.setFromAxisAngle(this.#axisY, rnd() * Math.PI * 2);
            this.#mat4.compose(
              this.#pos.set(px, y - 0.02, pz),
              this.#quat,
              this.#scale.set(s, s * (0.8 + rnd() * 0.5), s)
            );
            fmesh.setMatrixAt(nf, this.#mat4);
            const pick = rnd();
            if (marin) this.#color.setRGB(1, 0.42 + rnd() * 0.22, 0.06);
            else if (pick < 0.4) this.#color.setRGB(0.98, 0.93, 0.82);
            else if (pick < 0.7) this.#color.setRGB(0.78, 0.5, 0.95);
            else if (pick < 0.9) this.#color.setRGB(1, 0.75, 0.25);
            else this.#color.setRGB(0.95, 0.4, 0.55);
            fmesh.setColorAt(nf, this.#color);
            nf++;
          }
        }
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    fmesh.count = nf;
    fmesh.instanceMatrix.needsUpdate = true;
    if (fmesh.instanceColor) fmesh.instanceColor.needsUpdate = true;
  }

  /** Marin-only near-field: understory + extra canopy where trunks are visible. */
  #rebuildNearForest(cx: number, cz: number) {
    for (const p of this.#pools) p.n = 0;
    const inRange =
      cx > MARIN.minX - NEAR_R && cx < MARIN.maxX + NEAR_R && cz > MARIN.minZ - NEAR_R && cz < MARIN.maxZ + NEAR_R;
    if (inRange) {
      const minIx = Math.floor((cx - NEAR_R) / NEAR_CELL);
      const maxIx = Math.floor((cx + NEAR_R) / NEAR_CELL);
      const minIz = Math.floor((cz - NEAR_R) / NEAR_CELL);
      const maxIz = Math.floor((cz + NEAR_R) / NEAR_CELL);
      for (let iz = minIz; iz <= maxIz; iz++) {
        for (let ix = minIx; ix <= maxIx; ix++) {
          const wx = ix * NEAR_CELL + NEAR_CELL / 2;
          const wz = iz * NEAR_CELL + NEAR_CELL / 2;
          const dx = wx - cx;
          const dz = wz - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 > NEAR_R * NEAR_R) continue;
          const fade = Math.min(1, (NEAR_R - Math.sqrt(d2)) / 90);
          if (fade <= 0.05) continue;
          const rnd = mulberry32((((ix * 73856093) ^ (iz * 19349663)) >>> 0) + 77);
          const roll = rnd();
          const trees = roll < 0.3 ? 0 : roll < 0.62 ? 1 : roll < 0.88 ? 2 : 3;
          const bushes = (rnd() * 2.6) | 0;
          for (let k = 0; k < trees + bushes; k++) {
            const isBush = k >= trees;
            const px = ix * NEAR_CELL + rnd() * NEAR_CELL;
            const pz = iz * NEAR_CELL + rnd() * NEAR_CELL;
            const g = this.#marinGround(px, pz);
            if (g === null) continue;
            if (Math.abs(this.#map.groundHeight(px + 8, pz) - this.#map.groundHeight(px - 8, pz)) > 11) continue;
            if (Math.abs(this.#map.groundHeight(px, pz + 8) - this.#map.groundHeight(px, pz - 8)) > 11) continue;
            let pool: NearPool;
            if (isBush) pool = this.#pools[3];
            else {
              const kr = rnd();
              pool = kr < 0.62 ? this.#pools[0] : kr < 0.82 ? this.#pools[1] : this.#pools[2];
            }
            if (pool.n >= pool.cap) continue;
            const s = (isBush ? 0.7 + rnd() * 0.8 : 0.45 + rnd() * 0.6) * fade;
            this.#quat.setFromAxisAngle(this.#axisY, rnd() * Math.PI * 2);
            this.#mat4.compose(
              this.#pos.set(px, g - 0.35, pz),
              this.#quat,
              this.#scale.set(s, s * (0.85 + rnd() * 0.3), s)
            );
            pool.mesh.setMatrixAt(pool.n++, this.#mat4);
          }
        }
      }
    }
    for (const p of this.#pools) {
      p.mesh.count = p.n;
      p.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
