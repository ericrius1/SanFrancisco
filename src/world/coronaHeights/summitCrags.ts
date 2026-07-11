// Corona Heights summit crags — the jagged red radiolarian-chert outcrops that
// crown the hill. The real summit is a spine of steeply tilted chert beds
// running roughly NW–SE: fractured rust-red slabs weathering to tan on their
// sun-facing tops, dark maroon crevices between beds, a bare compacted-dirt
// viewing platform, and a talus of angular scree shed around each crag's base.
//
// Everything here is deterministic (hash-seeded) and built once at world load:
// one merged flat-shaded mesh for every crag, one instanced mesh for scree, one
// terrain-conforming dirt skin for the platform. Hero crags register box
// colliders so walkers, vehicles, paint rays and the grab tool treat them as
// real obstacles (and so avatars can be posed on top for cinematics).

import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import type { WorldMap } from "../heightmap";
import { CORONA_TRAILS, type CoronaXZ } from "./layout";

type Vec3 = { x: number; y: number; z: number };

export type CragSpec = {
  x: number;
  z: number;
  /** Strike direction of the bedding, radians about +y. */
  yaw: number;
  /** Footprint length along strike, metres. */
  length: number;
  /** Tallest tip above local ground, metres. */
  height: number;
  beds: number;
  seed: number;
  /** Force one central bed to keep a level, sittable top (cinematic perch). */
  flatTop?: boolean;
  /** Skip physics/query registration (purely decorative fragments). */
  decorative?: boolean;
};

/** Summit viewing platform — bare eroded dirt, no grass/flowers/legacy rocks. */
export const SUMMIT_PLATFORM = { x: 412, z: 2760, rx: 16, rz: 12 } as const;

/** Hand-laid to match the real park: the main climbing crag sits just north of
 * the platform, a second mass NW along the same strike, low spurs east and
 * southwest. All positions were checked against CORONA_TRAILS for clearance. */
export const SUMMIT_CRAGS: readonly CragSpec[] = [
  { x: 412, z: 2748, yaw: -0.52, length: 7.4, height: 4.3, beds: 9, seed: 101, flatTop: true },
  { x: 403.5, z: 2740.5, yaw: -0.62, length: 5.2, height: 3.1, beds: 7, seed: 102 },
  { x: 432, z: 2764, yaw: 0.92, length: 5.4, height: 2.6, beds: 6, seed: 103 },
  { x: 396, z: 2769, yaw: -0.74, length: 4.4, height: 2.1, beds: 5, seed: 104 },
  // Sittable perch blocks on the platform's south rim, facing downtown.
  { x: 405.5, z: 2765.5, yaw: -0.4, length: 3.1, height: 0.75, beds: 4, seed: 105, flatTop: true, decorative: true },
  { x: 417.5, z: 2765.8, yaw: 0.2, length: 3.3, height: 0.85, beds: 4, seed: 106, flatTop: true, decorative: true }
] as const;

/** Low decorative spurs continuing the bedding spine between/beyond the heroes. */
const SPINE_OUTCROPS: readonly CragSpec[] = [
  { x: 407.5, z: 2744, yaw: -0.55, length: 2.8, height: 1.1, beds: 4, seed: 201, decorative: true },
  { x: 398.5, z: 2736.5, yaw: -0.6, length: 2.4, height: 0.85, beds: 3, seed: 202, decorative: true },
  { x: 418.5, z: 2752.5, yaw: -0.5, length: 2.9, height: 1.15, beds: 4, seed: 203, decorative: true },
  { x: 424.5, z: 2757, yaw: 0.4, length: 2.2, height: 0.8, beds: 3, seed: 204, decorative: true },
  { x: 391, z: 2762, yaw: -0.7, length: 2.1, height: 0.75, beds: 3, seed: 205, decorative: true },
  { x: 401, z: 2775.5, yaw: -0.35, length: 1.9, height: 0.6, beds: 3, seed: 206, decorative: true },
  { x: 421.5, z: 2745.5, yaw: -0.48, length: 2.4, height: 0.95, beds: 3, seed: 207, decorative: true },
  { x: 437.5, z: 2770, yaw: 0.85, length: 2.3, height: 0.8, beds: 3, seed: 208, decorative: true }
] as const;

function fract(v: number) {
  return v - Math.floor(v);
}

function hash(a: number, b: number, c = 0) {
  return fract(Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453123);
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function pointSegmentDistance(x: number, z: number, a: CoronaXZ, b: CoronaXZ) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const ll = dx * dx + dz * dz;
  const t = ll > 1e-6 ? clamp01(((x - a[0]) * dx + (z - a[1]) * dz) / ll) : 0;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

function distanceToTrails(x: number, z: number) {
  let best = Infinity;
  for (const trail of CORONA_TRAILS) {
    for (let i = 0; i < trail.points.length - 1; i++) {
      best = Math.min(best, pointSegmentDistance(x, z, trail.points[i], trail.points[i + 1]));
    }
  }
  return best;
}

/** Extra height the platform skin holds above WorldMap.groundTop at (x,z).
 * 0 outside the platform. Single source of truth so the trail ribbons, step
 * ties and scree can ride ON the dirt instead of drowning under it — the skin
 * must sit well proud of the baked park lawn, whose CDT drape can exceed the
 * bilinear ground query by 20+ cm on the summit folds. */
export function summitPlatformLift(x: number, z: number) {
  const p = SUMMIT_PLATFORM;
  const q = ((x - p.x) / p.rx) ** 2 + ((z - p.z) / p.rz) ** 2;
  if (q >= 1) return 0;
  return 0.18 + 0.14 * (1 - smoothEdge(q));
}

/** True where the summit treatment owns the ground: existing scatter systems
 * (grass tufts, wildflowers, the mid-slope dodecahedron rocks) call this to
 * stay off the bare platform and out of every crag's footprint. */
export function summitKeepOut(x: number, z: number, margin = 0) {
  const p = SUMMIT_PLATFORM;
  const q = ((x - p.x) / (p.rx + margin)) ** 2 + ((z - p.z) / (p.rz + margin)) ** 2;
  if (q < 1) return true;
  for (const crag of [...SUMMIT_CRAGS, ...SPINE_OUTCROPS]) {
    const reach = crag.length * 0.75 + margin;
    if ((x - crag.x) ** 2 + (z - crag.z) ** 2 < reach * reach) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Geology palette
// ---------------------------------------------------------------------------

const BED_RUST = new THREE.Color(0xa85f45);
const BED_MAROON = new THREE.Color(0x8a4a3a);
const BED_PALE = new THREE.Color(0xb37a58);
const TOP_WEATHER = new THREE.Color(0xd2ab7a);
const CREVICE = new THREE.Color(0x6b3f33);
const LICHEN = new THREE.Color(0x9aa678);
const SKIRT_DUST = new THREE.Color(0xb08a63);

// ---------------------------------------------------------------------------
// Crag mesh
// ---------------------------------------------------------------------------

/** Append one crag's bed slabs to the shared position/color arrays.
 * Each bed is a jittered hexahedron with a mid ring (three corner levels), so
 * the flat-shaded facets bulge and pinch instead of reading as boxes. */
function appendCrag(map: WorldMap, spec: CragSpec, positions: number[], colors: number[]) {
  const s = spec.seed;
  // Spine normal (horizontal, perpendicular to the average strike): beds stack
  // along this even though each bed's own basis fans a few degrees off it.
  // Matches the +n side of each bed's u × v basis so the interior-face test
  // below stays consistent with the stacking order.
  const snx = -Math.sin(spec.yaw);
  const snz = Math.cos(spec.yaw);
  const tilt = 0.2 + hash(s, 1) * 0.18; // 11°–22° off vertical, all beds share it

  const K = spec.beds;
  const color = new THREE.Color();
  const base = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };

  // Cumulative bed offsets along the bed normal, centred on the spec origin.
  const thick: number[] = [];
  let total = 0;
  for (let k = 0; k < K; k++) {
    const t = (0.26 + hash(s, 11, k) * 0.34) * Math.min(1, spec.length / 5);
    thick.push(t);
    total += t;
  }
  let walk = -total / 2;

  const flatBed = spec.flatTop ? Math.floor(K / 2) : -1;

  for (let k = 0; k < K; k++) {
    const t = thick[k];
    const off = walk + t / 2;
    walk += t;
    // Each bed's strike fans a few degrees off the crag average so the fins
    // splay and the silhouette changes with every viewing angle.
    const yawK = spec.yaw + (hash(s, 9, k) - 0.5) * (k === flatBed ? 0.04 : 0.14);
    const ux = Math.cos(yawK);
    const uz = Math.sin(yawK);
    const wx = -uz;
    const wz = ux;
    const vx = wx * Math.sin(tilt);
    const vy = Math.cos(tilt);
    const vz = wz * Math.sin(tilt);
    // Bed normal = u × v with u = (ux, 0, uz), v = (vx, vy, vz).
    const crx = -uz * vy;
    const cry = uz * vx - ux * vz;
    const crz = ux * vy;
    const crl = Math.hypot(crx, cry, crz) || 1;
    const nrx = crx / crl;
    const nry = cry / crl;
    const nrz = crz / crl;
    const sBed = K > 1 ? k / (K - 1) : 0.5;
    // Crest curve peaks slightly off-centre, each bed jags well below it — with
    // occasional deep notches so the skyline reads as separate fins, not a wall.
    const crest = spec.height * (0.5 + 0.5 * Math.sin(Math.PI * clamp01(0.12 + sBed * 0.76)));
    let h = crest * (0.5 + 0.5 * hash(s, 13, k));
    if (hash(s, 14, k) < 0.28 && k !== flatBed) h *= 0.38;
    if (k === flatBed) h = spec.height;
    const L = spec.length * (0.58 + 0.42 * Math.sin(Math.PI * clamp01(0.1 + sBed * 0.8))) * (0.82 + hash(s, 17, k) * 0.34);
    const cu = (hash(s, 19, k) - 0.5) * spec.length * 0.3;
    const tipSkew = (hash(s, 23, k) - 0.5) * L * 0.42;
    const tipTaper = k === flatBed ? 0.86 : 0.35 + hash(s, 29, k) * 0.38;
    const midBulge = 0.98 + (hash(s, 31, k) - 0.35) * 0.24;
    const cxw = spec.x + snx * off;
    const czw = spec.z + snz * off;
    const gy = map.groundTop(cxw, czw);
    const sink = 1.7;

    // Four corner levels (buried base → two mid rings → tip) sampled at three
    // stations along strike. Mid-station vertices bump in/out along the bed
    // normal so the broad fracture walls break into light-catching facets
    // instead of one flat unlit slab.
    const levels = [
      { h: -sink, taper: 1.06, skew: 0, li: 0 },
      { h: Math.max(0.18, h * (0.32 + (hash(s, 36, k) - 0.5) * 0.14)), taper: midBulge, skew: tipSkew * 0.25, li: 1 },
      { h: Math.max(0.3, h * (0.68 + (hash(s, 37, k) - 0.5) * 0.16)), taper: (midBulge + tipTaper) / 2, skew: tipSkew * 0.6, li: 2 },
      { h, taper: tipTaper, skew: tipSkew, li: 3 }
    ];
    const stations = [-1, 0, 1];
    // Per-station heights for the two upper rings: the top edge saws up and
    // down along strike (per-station, not per-bed) so the crest reads jagged
    // even face-on to the broad wall. The mid ring stays safely below the tip.
    const hvGrid: number[][] = levels.map(() => [0, 0, 0]);
    for (let si = 0; si < 3; si++) {
      const flat = k === flatBed;
      const tip = flat ? levels[3].h : levels[3].h * (0.66 + hash(s, 51, k * 5 + si) * 0.5);
      const mid2 = Math.min(flat ? levels[2].h : levels[2].h * (0.84 + hash(s, 52, k * 5 + si) * 0.32), tip * 0.82);
      hvGrid[0][si] = levels[0].h;
      hvGrid[1][si] = Math.min(levels[1].h, mid2 * 0.7);
      hvGrid[2][si] = mid2;
      hvGrid[3][si] = tip;
    }
    // corner[level][station][sn] = Vec3
    const corner: Vec3[][][] = [];
    for (const lv of levels) {
      const li = lv.li;
      const rowU: Vec3[][] = [];
      for (let si = 0; si < stations.length; si++) {
        const su = stations[si];
        const rowN: Vec3[] = [];
        for (const sn of [-1, 1]) {
          const flatTip = li === 3 && k === flatBed;
          const jAmp = flatTip ? 0.05 : 0.12 + 0.07 * Math.min(1, spec.height / 3);
          const salt = k * 24 + si * 8 + (su + 1) * 2 + (sn + 1) / 2;
          const jx = (hash(s, 41 + li, salt) - 0.5) * 2 * jAmp;
          const jy = (hash(s, 43 + li, salt) - 0.5) * 2 * jAmp * (flatTip ? 0.3 : 1);
          const jz = (hash(s, 47 + li, salt) - 0.5) * 2 * jAmp;
          // Mid stations bulge/pinch across the bed thickness (fracture relief).
          const bump = si === 1 && li > 0 && li < 3 ? (hash(s, 49 + li, salt) - 0.4) * t * 0.55 : 0;
          const hv = hvGrid[li][si];
          const along = su * (L / 2) * lv.taper + cu + lv.skew;
          rowN.push({
            x: cxw + ux * along + vx * hv + nrx * ((sn * t) / 2 + sn * bump) + jx,
            y: gy + vy * hv + jy,
            z: czw + uz * along + vz * hv + nrz * ((sn * t) / 2 + sn * bump) + jz
          });
        }
        rowU.push(rowN);
      }
      corner.push(rowU);
    }

    // Base colour for the whole bed (thick ribbon-package alternation).
    const pick = hash(s, 53, k);
    base.copy(pick < 0.45 ? BED_RUST : pick < 0.8 ? BED_MAROON : BED_PALE);
    base.offsetHSL((hash(s, 59, k) - 0.5) * 0.02, (hash(s, 61, k) - 0.5) * 0.08, (hash(s, 67, k) - 0.5) * 0.06);

    let quadIdx = 0;
    const pushTri = (a: Vec3, b: Vec3, c: Vec3) => {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      // Face normal for geologic colouring.
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const abz = b.z - a.z;
      const acx = c.x - a.x;
      const acy = c.y - a.y;
      const acz = c.z - a.z;
      let fnx = aby * acz - abz * acy;
      let fny = abz * acx - abx * acz;
      let fnz = abx * acy - aby * acx;
      const fl = Math.hypot(fnx, fny, fnz) || 1;
      fnx /= fl;
      fny /= fl;
      fnz /= fl;
      const midY = (a.y + b.y + c.y) / 3;
      const hRel = clamp01((midY - gy) / Math.max(0.4, h));
      color.copy(base);
      // Bed-parallel faces that look INTO a neighbouring slab are shaded
      // fracture gaps; the outermost walls stay exterior rock (this is what
      // keeps the crag from reading as one dark monolith).
      const bedDot = fnx * nrx + fny * nry + fnz * nrz;
      const interior = (bedDot > 0.6 && k < K - 1) || (bedDot < -0.6 && k > 0);
      if (interior) color.lerp(CREVICE, 0.32 * (1 - hRel * 0.45));
      // Weather-bleached patches on any exposed wall — chert pales unevenly.
      if (!interior) color.lerp(BED_PALE, hash(s, 69, k * 31 + quadIdx) * 0.3);
      // Strike-end fracture faces stay in the dark maroon family.
      const endDot = Math.abs(fnx * ux + fnz * uz);
      if (endDot > 0.72 && !interior) color.lerp(BED_MAROON, 0.4);
      // Sun-weathered tan on up-facing facets — the lightest surfaces on the rock.
      if (fny > 0.35) color.lerp(TOP_WEATHER, clamp01((fny - 0.35) / 0.65) * (0.55 + hash(s, 71, k * 37 + quadIdx) * 0.3));
      // Sparse sage lichen on exposed upper WALL facets — never on the sittable
      // tip caps (they read as green carpets from above).
      const isCap = fny > 0.8;
      if (!isCap && fny > 0.15 && hRel > 0.35 && hash(s, 73, k * 41 + quadIdx) < 0.1) color.lerp(LICHEN, 0.38);
      // Dust skirt where the rock meets the dirt.
      if (hRel < 0.2) color.lerp(SKIRT_DUST, (1 - hRel / 0.2) * 0.5);
      // Facet-to-facet mottling, strongest on the broad walls, keyed per quad so
      // triangle pairs stay whole facets.
      const mottle = Math.abs(bedDot) > 0.6 ? 0.13 : 0.08;
      color.offsetHSL(0, 0, (hash(s, 79, k * 43 + quadIdx) - 0.5) * mottle);
      // Albedo floor: shade-side facets should read as dim rust under sky
      // ambient, never as black holes. Crevices may sit a touch lower.
      color.getHSL(hsl);
      const floor = interior ? 0.24 : 0.3;
      if (hsl.l < floor) color.offsetHSL(0, 0, floor - hsl.l);
      for (let vtx = 0; vtx < 3; vtx++) colors.push(color.r, color.g, color.b);
    };

    const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
      pushTri(a, b, c);
      pushTri(a, c, d);
      quadIdx++;
    };
    const P = (li: number, si: number, sn: number) => corner[li][si][(sn + 1) / 2];
    for (let li = 0; li < 3; li++) {
      // Broad fracture walls (±n), two facet columns per row.
      for (let si = 0; si < 2; si++) {
        quad(P(li, si, 1), P(li, si + 1, 1), P(li + 1, si + 1, 1), P(li + 1, si, 1));
        quad(P(li, si + 1, -1), P(li, si, -1), P(li + 1, si, -1), P(li + 1, si + 1, -1));
      }
      // ±u end faces
      quad(P(li, 0, -1), P(li, 0, 1), P(li + 1, 0, 1), P(li + 1, 0, -1));
      quad(P(li, 2, 1), P(li, 2, -1), P(li + 1, 2, -1), P(li + 1, 2, 1));
    }
    // Tip cap + (buried) base cap, split along strike.
    for (let si = 0; si < 2; si++) {
      quad(P(3, si, 1), P(3, si + 1, 1), P(3, si + 1, -1), P(3, si, -1));
      quad(P(0, si, -1), P(0, si + 1, -1), P(0, si + 1, 1), P(0, si, 1));
    }
  }
}

function makeCragMesh(map: WorldMap) {
  const positions: number[] = [];
  const colors: number[] = [];
  for (const spec of [...SUMMIT_CRAGS, ...SPINE_OUTCROPS]) appendCrag(map, spec, positions, colors);
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
    // Sky-bounce stand-in: keeps shade-side facets reading as dark maroon rock
    // instead of black voids (the crag's albedo is dark enough that the scene
    // hemisphere light alone can't hold them).
    emissive: 0x241310,
    emissiveIntensity: 1
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "corona_summit_chert_crags";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Colliders
// ---------------------------------------------------------------------------

function registerCragColliders(map: WorldMap, physics: Physics) {
  for (const spec of SUMMIT_CRAGS) {
    if (spec.decorative && spec.height < 0.6) continue;
    const groundY = map.groundTop(spec.x, spec.z);
    const boxes: { hx: number; hy: number; hz: number; lift: number }[] =
      spec.height > 1.6
        ? [
            { hx: spec.length * 0.42, hy: spec.height * 0.3, hz: spec.length * 0.3, lift: spec.height * 0.3 - 0.5 },
            { hx: spec.length * 0.3, hy: spec.height * 0.22, hz: spec.length * 0.22, lift: spec.height * 0.72 - spec.height * 0.22 }
          ]
        : [{ hx: spec.length * 0.42, hy: spec.height * 0.5, hz: spec.length * 0.32, lift: spec.height * 0.5 - 0.25 }];
    for (const b of boxes) {
      const y = groundY + b.lift;
      const body = physics.world.createBox({
        type: BodyType.Static,
        position: [spec.x, y, spec.z],
        halfExtents: [b.hx, b.hy, b.hz],
        friction: 0.85
      });
      physics.world.setBodyTransform(body, [spec.x, y, spec.z], [0, Math.sin(spec.yaw / 2), 0, Math.cos(spec.yaw / 2)]);
      physics.addQuerySolid(body, { x: spec.x, y, z: spec.z, hx: b.hx, hy: b.hy, hz: b.hz, yaw: spec.yaw });
    }
  }
}

// ---------------------------------------------------------------------------
// Bare-dirt summit platform
// ---------------------------------------------------------------------------

function valueNoise(x: number, z: number, cell: number, salt: number) {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const sm = (v: number) => v * v * (3 - 2 * v);
  const ax = sm(fx - ix);
  const az = sm(fz - iz);
  const a = lerp(hash(ix, iz, salt), hash(ix + 1, iz, salt), ax);
  const b = lerp(hash(ix, iz + 1, salt), hash(ix + 1, iz + 1, salt), ax);
  return lerp(a, b, az);
}

function nearestCragDistance(x: number, z: number) {
  let best = Infinity;
  for (const crag of SUMMIT_CRAGS) best = Math.min(best, Math.hypot(x - crag.x, z - crag.z) - crag.length * 0.4);
  return best;
}

/** Terrain-conforming skin: eroded pinkish-tan hardpan with gravel speckle,
 * redder chert dust ringing each crag, feathering back to dry-grass colours at
 * the rim. Sits above the coarse hill skin, below the trail ribbons. */
function makePlatformSkin(map: WorldMap) {
  const { x: px, z: pz, rx, rz } = SUMMIT_PLATFORM;
  const step = 1.1;
  const nx = Math.ceil((rx * 2) / step) + 1;
  const nz = Math.ceil((rz * 2) / step) + 1;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const inside = new Uint8Array(nx * nz);
  const hardpan = new THREE.Color(0xb08a63);
  const pinkDust = new THREE.Color(0xa06a4c);
  const gravel = new THREE.Color(0x7f5f45);
  const dryGrass = new THREE.Color(0x8b833f);
  const color = new THREE.Color();
  for (let gz = 0; gz < nz; gz++) {
    const z = pz - rz + gz * step;
    for (let gx = 0; gx < nx; gx++) {
      const x = px - rx + gx * step;
      const i = gz * nx + gx;
      const q = ((x - px) / rx) ** 2 + ((z - pz) / rz) ** 2;
      // Smooth-noise rim (not per-cell hash): a wandering organic boundary with
      // no axis-aligned stair-steps and no dropped-cell holes for the baked
      // lawn to poke through.
      inside[i] = q < 1 + (valueNoise(x, z, 5.5, 227) - 0.5) * 0.2 ? 1 : 0;
      positions[i * 3] = x;
      positions[i * 3 + 1] = map.groundTop(x, z) + Math.max(0.18, summitPlatformLift(x, z));
      positions[i * 3 + 2] = z;
      const grain = valueNoise(x, z, 3.2, 211);
      const mottle = valueNoise(x, z, 4.2, 219);
      const fine = valueNoise(x, z, 1.7, 223);
      const cragRing = clamp01(1 - nearestCragDistance(x, z) / 5);
      color.copy(hardpan).offsetHSL(0, 0, (grain - 0.5) * 0.11);
      // Mid-scale (2–5 m) trampled-dust patches, hue as well as value.
      color.lerp(pinkDust, clamp01(mottle - 0.3) * 0.65);
      color.lerp(gravel, clamp01(0.45 - mottle) * 0.5);
      color.lerp(pinkDust, cragRing * (0.5 + grain * 0.25));
      if (fine > 0.6) color.lerp(gravel, 0.45); // gravel speckle
      color.lerp(dryGrass, smoothEdge(q) * 0.9);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
  }
  const indices: number[] = [];
  for (let gz = 0; gz < nz - 1; gz++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      if (inside[a] && inside[b] && inside[c]) indices.push(a, c, b);
      if (inside[b] && inside[c] && inside[d]) indices.push(b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    })
  );
  mesh.name = "corona_summit_platform";
  mesh.receiveShadow = true;
  return mesh;
}

function smoothEdge(q: number) {
  const t = clamp01((q - 0.62) / 0.38);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Scree / talus
// ---------------------------------------------------------------------------

function makeShardGeometry() {
  // Irregular flat-bottomed shard: an angular five-vertex chunk, non-indexed
  // so every facet shades flat like the parent crags.
  const p = [
    [-0.5, 0, -0.32],
    [0.55, 0, -0.4],
    [0.38, 0, 0.5],
    [-0.42, 0, 0.42],
    [0.04, 0.62, 0.02]
  ];
  const tris = [
    [0, 1, 4],
    [1, 2, 4],
    [2, 3, 4],
    [3, 0, 4],
    [1, 0, 2],
    [0, 3, 2]
  ];
  const positions: number[] = [];
  for (const [a, b, c] of tris) positions.push(...p[a], ...p[b], ...p[c]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeScree(map: WorldMap) {
  const capacity = 300;
  const mesh = new THREE.InstancedMesh(
    makeShardGeometry(),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0, flatShading: true }),
    capacity
  );
  mesh.name = "corona_summit_scree";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const sources = [...SUMMIT_CRAGS, ...SPINE_OUTCROPS];
  let count = 0;
  for (let i = 0; i < 1600 && count < capacity; i++) {
    const src = sources[Math.floor(hash(i, 1, 301) * sources.length) % sources.length];
    const a = hash(i, 2, 307) * Math.PI * 2;
    // Talus density decays away from the crag base.
    const r = src.length * 0.42 + Math.pow(hash(i, 3, 311), 1.6) * 5.5;
    const x = src.x + Math.cos(a) * r;
    const z = src.z + Math.sin(a) * r * 0.9;
    if (distanceToTrails(x, z) < 1.9) continue;
    // Talus belongs on the bare dirt and around the crag feet — scattering it
    // out onto the grass flanks reads as red confetti.
    const lift = summitPlatformLift(x, z);
    const nearFoot = Math.hypot(x - src.x, z - src.z) < src.length * 0.42 + 3.5;
    if (lift === 0 && !nearFoot) continue;
    const y = map.groundTop(x, z);
    if (y < 132) continue;
    // Bigger blocks shed close to the crag foot, crumbs further out; every
    // shard sits slightly sunk so no dark underside edge floats over the dirt.
    const away = clamp01((Math.hypot(x - src.x, z - src.z) - src.length * 0.42) / 5.5);
    const size = (0.09 + Math.pow(hash(i, 5, 313), 2.2) * 0.55) * (1.25 - away * 0.75);
    dummy.position.set(x, y + lift - size * 0.06, z);
    dummy.rotation.set((hash(i, 7) - 0.5) * 0.4, hash(i, 11) * Math.PI * 2, (hash(i, 13) - 0.5) * 0.4);
    dummy.scale.set(size * (0.8 + hash(i, 17) * 0.7), size * (0.5 + hash(i, 19) * 0.6), size * (0.8 + hash(i, 23) * 0.7));
    dummy.updateMatrix();
    mesh.setMatrixAt(count, dummy.matrix);
    const pick = hash(i, 29);
    color.copy(pick < 0.42 ? BED_RUST : pick < 0.72 ? BED_MAROON : pick < 0.9 ? TOP_WEATHER : SKIRT_DUST);
    color.offsetHSL(0, 0, (hash(i, 31) - 0.5) * 0.12);
    mesh.setColorAt(count, color);
    count++;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------

export function makeSummitCrags(map: WorldMap, physics: Physics) {
  const group = new THREE.Group();
  group.name = "corona_summit_crags";
  group.add(makePlatformSkin(map));
  group.add(makeCragMesh(map));
  group.add(makeScree(map));
  registerCragColliders(map, physics);
  return group;
}
