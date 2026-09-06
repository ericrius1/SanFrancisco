// Wildflower ring — the flowers, as a player-following field co-located with the
// wildlands grass, and now placed by the SAME GPU ground-cover runtime
// (groundcover/gpuGrassPlacement.ts) over the SAME kind of paged ecology field.
// A ladder of concentric layers scatters candidates on the canonical world grid,
// samples the baked flower field (flowerField.ts), and compacts survivors into
// storage buffers that a per-frame frustum cull draws indirectly. Blooms share
// the grass's exact wind (groundSway + WIND_DIR), trample field, instance-data
// contract, and — the point of this pass — its distance dissolve, so grass and
// flowers grow in and out of the field by one definition instead of two.
//
// Two things the old CPU ring could not do, and this one does:
//  · GROW IN. Every clump carries a stable rank, so each one leaves its LOD band
//    at its own distance (rankDissolve.ts) — geometry scaling up out of the
//    ground and back down into it, not a dithered coverage mask and not a ring
//    sweeping through the meadow. The same window feeds the cull, so a bloom is
//    always already zero-sized by the time it is dropped.
//  · REACH. The scatter no longer costs CPU per candidate, so the ladder runs to
//    the configured reach in continuously-graded rings instead of the old hard
//    sampling bands, whose 1.6 → 6 → 18 m spacing steps re-rolled every bloom at
//    120 m and 360 m each time the player crossed one.
//
// LOOK (chasing momentchan/false-earth's luminous roses, our own wildflowers): real
// 3D curved layered petals with true normals + a translucent MeshSSS material + a
// fresnel rim glow + a pale-centre→saturated-edge colour ramp, so blooms read as
// dimensional, back-lit, glowing cups — not flat cards. Nearby instances remain
// small 3–5-stem botanical clumps; distance tiers redistribute that detail into
// simplified species silhouettes and tiny static accents.

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  float,
  Fn,
  instanceIndex,
  int,
  Loop,
  mix,
  normalGeometry,
  normalView,
  positionGeometry,
  positionLocal,
  positionViewDirection,
  select,
  sin,
  uniform,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { groundSway, groundSwayFlow, groundSwayLite, WIND_DIR } from "../groundcover/sway";
import { DISPLACERS, MAX_DISPLACERS } from "../groundcover/displacers";
import { fadeAroundInstanceAnchor, instanceAnchorWorld, worldOffsetToModelLocal } from "../groundcover/instanceDeform";
import { hash2, smoothstep } from "../groundcover/scatter";
import type { GroundcoverInstanceSource } from "../groundcover/bladeGrass";
import {
  createGpuGrassPlacement,
  type GpuGrassLayerInput,
  type GpuGrassPlacement,
  type GpuGrassStyleContext
} from "../groundcover/gpuGrassPlacement";
import { rankAnnulusGrowth, rankHandoffRadius, type RankAnnulus } from "../groundcover/rankDissolve";
import { SHADOW_LAYERS } from "../shadows/shadowLayers";
import { nearAnyWildRegion } from "./layout";
import { createFlowerFields, FLOWER_FIELD_HALF_EXTENT, FLOWER_HORIZON_HALF_EXTENT } from "./flowerField";
import {
  FAR_HEIGHT_SCALE,
  FLOWER_SPECIES_IDS,
  ROOT_FOOTPRINT_RADIUS,
  HEADS_PER_CLUMP,
  KEEP_CEILING,
  MID_HEADS_PER_CLUMP,
  PALETTES,
  type AuthoredFlowerSpecies
} from "./flowerSpecies";
import { optionalRenderer } from "../../app/rendererRegistry";
import { governorEffects, onGovernorChange } from "../../render/adaptiveResolution";
import { applyGroundcoverAtmosphere } from "../groundcover/foliageAtmosphere";
import type { GardenTerrain } from "../garden/layout";
import {
  EXPOSURE_REBASE,
  FLOWER_REACH_MAX,
  FLOWER_REACH_MIN,
  FLOWER_TUNING
} from "../../config";

type N = any;

export type { AuthoredFlowerSpecies } from "./flowerSpecies";

export type AuthoredFlowerPlacement = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  species: AuthoredFlowerSpecies;
  /** Authored-only silhouette. These never add GPU rungs to the wildland field. */
  form?: AuthoredFlowerForm;
  /** Stable 0..1 colour variation within the species palette. */
  tint?: number;
};

export type AuthoredFlowerPalette = { a: number; b: number };

/** Distinct alien bloom geometry available to compact authored gardens. */
export type AuthoredFlowerForm = "starbell" | "prism-orchid" | "moon-cup";

export type AuthoredFlowerFormDefinition = {
  /** Lazy form-specific geometry builder. Called only when a patch places it. */
  build(): THREE.BufferGeometry;
  heads: number;
};

const AUTHORED_FORM_REGISTRY = new Map<AuthoredFlowerForm, AuthoredFlowerFormDefinition>();

/**
 * Registers an optional authored silhouette without adding it to wildland GPU
 * rungs. Feature chunks call this immediately before creating their patch.
 */
export function registerAuthoredFlowerForm(
  form: AuthoredFlowerForm,
  definition: AuthoredFlowerFormDefinition
): void {
  AUTHORED_FORM_REGISTRY.set(form, definition);
}

// ---- geometry: real 3D curved petals -------------------------------------------
// A petal is a curved ruled strip that grows +Z outward from the origin and arcs
// up in +Y, with a petal-shaped width profile and TRUE surface normals — so a bloom
// reads as a layered 3D cup that catches light, not a flat card. Every part bakes
// aHead (1 = petal, 0 = stem) + aG (0 at the bloom centre → 1 at the petal tip, for
// the colour ramp); aSway (tip-weighted wind) is added after the merge.

type Ring = { count: number; pitch: number; len: number; wid: number; rise: number; close: number; cup: number; out: number; spin?: number };

/** One soft curved petal in canonical frame (root at origin, growing +Z, arcing +Y).
 *  Three columns across the width so the petal SCOOPS (edges lift by `cup`) like a real
 *  cupped petal, `segs` rows along the length for a smooth curl + rounded tip, and
 *  smoothed normals — no hard facets, so it reads soft and catches light gently. */
function makePetal(len: number, wid: number, rise: number, close: number, cup: number, segs: number): THREE.BufferGeometry {
  const pos: number[] = [], head: number[] = [], grad: number[] = [], idx: number[] = [];
  const point = (u: number): [number, number] => {
    const z = len * u * (1 - close * smoothstep(0.45, 1, u) * 0.5); // outward, curls in near the tip
    const y = rise * len * (1 - Math.cos(u * Math.PI * 0.5)); // arcs upward
    return [y, z];
  };
  for (let s = 0; s <= segs; s++) {
    const u = s / segs;
    const [y, z] = point(u);
    // rounded, full outline (pow < 1 fattens it, +min keeps the tip from a sharp point)
    const halfW = wid * 0.5 * (0.06 + 0.98 * Math.pow(Math.sin(Math.min(1, u * 1.02) * Math.PI), 0.7));
    for (let c = -1; c <= 1; c++) {
      const x = c * halfW;
      const yc = y + cup * halfW * (c * c); // edges (c=±1) lift → scooped cross-section
      pos.push(x, yc, z);
      head.push(1);
      grad.push(u);
    }
  }
  for (let s = 0; s < segs; s++) {
    for (let c = 0; c < 2; c++) {
      const a = s * 3 + c, b = s * 3 + c + 1, d = (s + 1) * 3 + c, e = (s + 1) * 3 + c + 1;
      idx.push(a, b, e, a, e, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aHead", new THREE.Float32BufferAttribute(head, 1));
  g.setAttribute("aG", new THREE.Float32BufferAttribute(grad, 1));
  g.setIndex(idx);
  g.computeVertexNormals(); // smooth shading across the scooped surface
  return g;
}

/** Clone a petal into place: push it out from centre, pitch it up (openness), spin
 *  it around the bloom, lift to the stem top. */
function layPetal(src: THREE.BufferGeometry, pitch: number, spin: number, y: number, outR: number): THREE.BufferGeometry {
  const p = src.clone();
  if (outR) p.translate(0, 0, outR);
  p.rotateX(-pitch);
  p.rotateY(spin);
  p.translate(0, y, 0);
  return p;
}

function bloomRings(parts: THREE.BufferGeometry[], y: number, rings: Ring[], segs: number) {
  for (const r of rings) {
    const petal = makePetal(r.len, r.wid, r.rise, r.close, r.cup, segs);
    for (let i = 0; i < r.count; i++) {
      const spin = (i / r.count) * Math.PI * 2 + (r.spin ?? 0);
      parts.push(layPetal(petal, r.pitch, spin, y, r.out));
    }
    petal.dispose();
  }
}

/** Two crossed tapered strips — a thin stem. aHead 0 → stays a matte green, no glow. */
function makeStem(h: number, w: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const segs = 3;
  for (let k = 0; k < 2; k++) {
    const pos: number[] = [], nor: number[] = [], head: number[] = [], grad: number[] = [], idx: number[] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const halfW = w * 0.5 * (1 - t * 0.55);
      pos.push(-halfW, t * h, 0, halfW, t * h, 0);
      nor.push(0, 0, 1, 0, 0, 1);
      head.push(0, 0);
      grad.push(0, 0);
    }
    for (let s = 0; s < segs; s++) {
      const aI = s * 2, cI = (s + 1) * 2;
      idx.push(aI, aI + 1, cI, aI + 1, cI + 1, cI);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute("aHead", new THREE.Float32BufferAttribute(head, 1));
    g.setAttribute("aG", new THREE.Float32BufferAttribute(grad, 1));
    g.setIndex(idx);
    g.rotateY((k * Math.PI) / 2);
    parts.push(g);
  }
  return parts;
}

/** A tiny faceted 3D flower disc. Six top triangles and twelve side triangles give
 *  poppies and daisies a readable pollen centre without spending sphere geometry. */
function makeCentre(radius: number, y: number, height = radius * 0.42): THREE.BufferGeometry {
  const sides = 6;
  const pos: number[] = [0, y + height, 0];
  const idx: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pos.push(Math.sin(a) * radius, y, Math.cos(a) * radius);
  }
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    idx.push(0, 1 + i, 1 + next);
  }
  // A narrower lower ring makes the disc a shallow pollen dome, not a flat hexagon.
  const lowerStart = pos.length / 3;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pos.push(Math.sin(a) * radius * 0.72, y - height * 0.36, Math.cos(a) * radius * 0.72);
  }
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    idx.push(1 + i, lowerStart + i, lowerStart + next, 1 + i, lowerStart + next, 1 + next);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aHead", new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1));
  g.setAttribute("aG", new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(0.04), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Merge the parts, bias petal normals toward the sky (so cupped petals still catch
 *  skylight instead of going black — same trick the grass uses), and bake aSway. */
function finalizeBloom(parts: THREE.BufferGeometry[], totalH: number): THREE.BufferGeometry {
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const head = g.getAttribute("aHead");
  // xyz = tip weight, wind sample offset x, wind sample offset z. Packing the
  // per-stem phase beside tip weight keeps the WebGPU pipeline at eight buffers.
  const sway = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getY(i) / totalH));
    sway[i * 3] = t * t;
    if (head.getX(i) > 0.5) {
      // lift toward +Y so the petal reads dimensional (keeps some of its own tilt for
      // the fresnel rim) but is lit by the sky rather than shadowed to black
      let nx = nor.getX(i) * 0.5;
      let ny = nor.getY(i) * 0.5 + 0.62;
      let nz = nor.getZ(i) * 0.5;
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      nor.setXYZ(i, nx * inv, ny * inv, nz * inv);
    }
  }
  g.setAttribute("aSway", new THREE.Float32BufferAttribute(sway, 3));
  return g;
}

type ClumpFlower = {
  geometry: THREE.BufferGeometry;
  x: number;
  z: number;
  scale?: number;
  yaw?: number;
  windPhase?: number;
  windGain?: number;
};

/** Merge several complete flowers into one instanced clump. The packed wind offset
 *  samples the canonical ground-cover sway at a slightly different phase per stem,
 *  so stalks breathe together with the grass without moving as a rigid bouquet. */
function flowerClump(flowers: ClumpFlower[]): THREE.BufferGeometry {
  for (const [i, flower] of flowers.entries()) {
    const g = flower.geometry;
    const scale = flower.scale ?? 1;
    g.scale(scale, scale, scale);
    g.rotateY(flower.yaw ?? 0);
    g.translate(flower.x, 0, flower.z);

    const sway = g.getAttribute("aSway");
    const gain = flower.windGain ?? 1;
    // This is a phase-space offset, not a positional deformation. A few metres is
    // enough to separate the dual-frequency sway while retaining the shared gust.
    const phase = flower.windPhase ?? i * 1.7;
    for (let v = 0; v < sway.count; v++) {
      sway.setXYZ(v, sway.getX(v) * gain, Math.cos(phase) * 1.8, Math.sin(phase) * 1.8);
    }
  }
  const merged = mergeGeometries(flowers.map((f) => f.geometry));
  for (const flower of flowers) flower.geometry.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Geometry primitives for optional authored-form chunks. These are the same
 * stem/petal/clump compiler used by native flowers, exposed so a lazy feature
 * can contribute silhouettes without duplicating botanical rendering code.
 */
export const AUTHORED_FLOWER_GEOMETRY_KIT = {
  makeStem,
  bloomRings,
  makeCentre,
  finalizeBloom,
  flowerClump
} as const;

/** A poppy bloom, with detail concentrated in the nearby hero and cheaper satellite
 *  flowers. Both remain genuinely curved, layered 3D geometry. */
function singlePoppy(stemH: number, hero: boolean): THREE.BufferGeometry {
  const parts = makeStem(stemH, 0.032);
  if (hero) {
    bloomRings(parts, stemH + 0.02, [
      { count: 8, pitch: 0.15, len: 0.2, wid: 0.17, rise: 0.34, close: 0.12, cup: 0.55, out: 0.022 },
      { count: 7, pitch: 0.58, len: 0.145, wid: 0.13, rise: 0.5, close: 0.28, cup: 0.78, out: 0.013, spin: 0.4 },
      { count: 5, pitch: 1.08, len: 0.09, wid: 0.09, rise: 0.7, close: 0.48, cup: 1.1, out: 0.006, spin: 0.85 }
    ], 3);
    parts.push(makeCentre(0.037, stemH + 0.025));
  } else {
    bloomRings(parts, stemH + 0.015, [
      { count: 7, pitch: 0.2, len: 0.17, wid: 0.145, rise: 0.36, close: 0.14, cup: 0.58, out: 0.018 },
      { count: 5, pitch: 0.84, len: 0.1, wid: 0.09, rise: 0.62, close: 0.38, cup: 0.9, out: 0.007, spin: 0.5 }
    ], 2);
    parts.push(makeCentre(0.032, stemH + 0.02));
  }
  return finalizeBloom(parts, stemH + 0.24);
}

/** 0 poppy — an asymmetric three-bloom clump: one layered hero plus two lighter,
 *  differently tilted satellites. It costs slightly less than the old one-head mesh. */
function poppyGeometry(): THREE.BufferGeometry {
  return flowerClump([
    { geometry: singlePoppy(0.5, true), x: 0, z: 0, yaw: 0.2, windPhase: 0.3, windGain: 1.02 },
    { geometry: singlePoppy(0.44, false), x: 0.22, z: 0.1, scale: 0.86, yaw: 2.4, windPhase: 2.2, windGain: 0.84 },
    { geometry: singlePoppy(0.4, false), x: -0.17, z: 0.16, scale: 0.79, yaw: 4.6, windPhase: 4.4, windGain: 1.14 }
  ]);
}

/** One lupine spike. Satellite spikes use fewer tiers and lower-order curved florets. */
function singleLupine(stemH: number, spikeH: number, tiers: number, petals: number, segs: number): THREE.BufferGeometry {
  const parts = makeStem(stemH, 0.03);
  const floret = makePetal(0.075, 0.07, 0.55, 0.35, 0.7, segs);
  for (let t = 0; t < tiers; t++) {
    const frac = t / (tiers - 1);
    const y = stemH + frac * spikeH;
    const r = 0.018 + 0.05 * (1 - frac * 0.7);
    for (let i = 0; i < petals; i++) parts.push(layPetal(floret, 0.65, (i / petals) * Math.PI * 2 + t * 0.7, y, r));
  }
  floret.dispose();
  return finalizeBloom(parts, stemH + spikeH);
}

/** 1 lupine — three differently tall spikes, cheaper overall than the former single
 *  40-floret spike but much fuller in silhouette. */
function lupineGeometry(): THREE.BufferGeometry {
  return flowerClump([
    { geometry: singleLupine(0.34, 0.44, 7, 4, 2), x: 0, z: 0, yaw: 0.1, windPhase: 0.5, windGain: 1.12 },
    { geometry: singleLupine(0.3, 0.34, 5, 4, 1), x: 0.18, z: 0.1, scale: 0.88, yaw: 2.2, windPhase: 2.6, windGain: 0.86 },
    { geometry: singleLupine(0.28, 0.31, 5, 4, 1), x: -0.16, z: 0.14, scale: 0.82, yaw: 4.4, windPhase: 4.8, windGain: 1.2 }
  ]);
}

/** One yarrow stem + domed umbel of tiny florets. */
function singleYarrow(stemH: number, n: number, segs: number): THREE.BufferGeometry {
  const parts = makeStem(stemH, 0.028);
  const flo = makePetal(0.05, 0.05, 0.3, 0.2, 0.5, segs);
  for (let i = 0; i < n; i++) {
    const a = i * 2.399; // golden-angle spread
    const rr = 0.015 + 0.075 * Math.sqrt(i / n);
    parts.push(layPetal(flo, 0.5, a, stemH + 0.02, rr));
  }
  flo.dispose();
  return finalizeBloom(parts, stemH + 0.08);
}

/** 2 yarrow — three airy umbels at staggered heights. The satellites have fewer
 *  length segments, which is invisible at their scale but preserves real 3D scoops. */
function yarrowGeometry(): THREE.BufferGeometry {
  return flowerClump([
    { geometry: singleYarrow(0.34, 9, 2), x: 0, z: 0, windPhase: 0.7, windGain: 1.08 },
    { geometry: singleYarrow(0.29, 6, 1), x: 0.18, z: 0.08, scale: 0.87, yaw: 2.1, windPhase: 2.7, windGain: 0.82 },
    { geometry: singleYarrow(0.27, 6, 1), x: -0.15, z: 0.14, scale: 0.8, yaw: 4.2, windPhase: 4.9, windGain: 1.16 }
  ]);
}

/** One goldfield daisy. Satellites keep a 3-column scoop but only one length segment. */
function singleGoldfield(stemH: number, petals: number, segs: number, hero: boolean): THREE.BufferGeometry {
  const parts = makeStem(stemH, 0.024);
  bloomRings(parts, stemH + 0.005, [
    { count: petals, pitch: hero ? 0.2 : 0.26, len: hero ? 0.08 : 0.068, wid: hero ? 0.048 : 0.044, rise: 0.3, close: 0.06, cup: 0.55, out: 0.006 }
  ], segs);
  parts.push(makeCentre(hero ? 0.033 : 0.028, stemH + 0.012));
  return finalizeBloom(parts, stemH + 0.07);
}

/** 3 goldfield — five small daisies make a carpeting tuft. Its five-head silhouette
 *  costs only ~36% more triangles than the old single two-ring daisy. */
function goldfieldGeometry(): THREE.BufferGeometry {
  return flowerClump([
    { geometry: singleGoldfield(0.19, 10, 2, true), x: 0, z: 0, yaw: 0.2, windPhase: 0.2, windGain: 1.0 },
    { geometry: singleGoldfield(0.16, 6, 1, false), x: 0.14, z: 0.06, scale: 0.88, yaw: 1.5, windPhase: 1.6, windGain: 0.8 },
    { geometry: singleGoldfield(0.15, 6, 1, false), x: -0.12, z: 0.1, scale: 0.82, yaw: 2.8, windPhase: 2.9, windGain: 1.14 },
    { geometry: singleGoldfield(0.14, 6, 1, false), x: 0.07, z: -0.13, scale: 0.78, yaw: 4.1, windPhase: 4.2, windGain: 0.92 },
    { geometry: singleGoldfield(0.13, 6, 1, false), x: -0.12, z: -0.1, scale: 0.74, yaw: 5.4, windPhase: 5.5, windGain: 1.2 }
  ]);
}

const BUILDERS = [poppyGeometry, lupineGeometry, yarrowGeometry, goldfieldGeometry];

// Geometry and deformation are distance-graded. Hero clumps keep the full curved,
// layered botanical meshes and interactive trample. Mid clumps keep a recognizable
// species silhouette with 60–80% fewer triangles and one-sine sway. Beyond that
// the field becomes a shared 6-triangle accent, where stems and petal layering are
// sub-pixel anyway — first at a 2× cell to hold real density, then at an 8× cell
// for the horizon wash.
//
// Each rung owns an annulus, and hands off to the next through the shared
// rank dissolve: hero and mid scatter at BIT-IDENTICAL anchors (same stride, same
// hashes), so their bands partition one set of clumps — a bloom shrinks into the
// ground as its hero form leaves and its mid form rises out of the same spot.
const FLOWER_SPACING = 1.6; // canonical wildflower cell (coarser than grass)

type FlowerGrade = RankAnnulus & { visibleRadius: number; gridStride: number };

const HERO_GRADE: FlowerGrade = { visibleRadius: 26, fadeBand: 10, gridStride: 1 };
const MID_GRADE: FlowerGrade = {
  visibleRadius: 56,
  fadeBand: 16,
  gridStride: 1,
  minRadius: rankHandoffRadius(HERO_GRADE.visibleRadius, HERO_GRADE.fadeBand),
  innerBand: HERO_GRADE.fadeBand
};
// The accent rungs keep the FULL 1.6 m cell out to 140 m — the old ring dropped
// to a 6 m cell at 120 m, which is where its density visibly fell away. Only
// past that, where a bloom is well under a pixel, does the cell coarsen; each
// coarser rung widens its accents by the square root of its cell ratio so the
// colour it lays down per square metre stays put.
const FAR_GRADE: FlowerGrade = {
  visibleRadius: 140,
  fadeBand: 30,
  gridStride: 1,
  minRadius: rankHandoffRadius(MID_GRADE.visibleRadius, MID_GRADE.fadeBand),
  innerBand: MID_GRADE.fadeBand
};
const DIST_GRADE: FlowerGrade = {
  visibleRadius: 195,
  fadeBand: 40,
  gridStride: 4,
  minRadius: rankHandoffRadius(FAR_GRADE.visibleRadius, FAR_GRADE.fadeBand),
  innerBand: FAR_GRADE.fadeBand
};
const HORIZON_GRADE: FlowerGrade = {
  visibleRadius: FLOWER_REACH_MAX,
  fadeBand: 110,
  gridStride: 10,
  minRadius: rankHandoffRadius(DIST_GRADE.visibleRadius, DIST_GRADE.fadeBand),
  innerBand: DIST_GRADE.fadeBand
};

/** A sparse rung stands in for a denser one; widen its accents to match the ink. */
const gradeRepresentation = (grade: FlowerGrade): number => Math.sqrt(grade.gridStride);

function simplePoppy(stemH: number): THREE.BufferGeometry {
  const parts = makeStem(stemH, 0.03);
  bloomRings(parts, stemH + 0.015, [
    { count: 6, pitch: 0.28, len: 0.16, wid: 0.135, rise: 0.4, close: 0.18, cup: 0.64, out: 0.014 }
  ], 1);
  parts.push(makeCentre(0.029, stemH + 0.018));
  return finalizeBloom(parts, stemH + 0.19);
}

function midPoppyGeometry(): THREE.BufferGeometry {
  return flowerClump([
    { geometry: simplePoppy(0.47), x: 0, z: 0, yaw: 0.2, windPhase: 0.3 },
    { geometry: simplePoppy(0.39), x: 0.19, z: 0.11, scale: 0.82, yaw: 2.7, windPhase: 2.4 }
  ]);
}

function midLupineGeometry(): THREE.BufferGeometry {
  return flowerClump([
    { geometry: singleLupine(0.32, 0.38, 5, 3, 1), x: 0, z: 0, windPhase: 0.4 },
    { geometry: singleLupine(0.27, 0.29, 4, 3, 1), x: 0.17, z: 0.11, scale: 0.82, yaw: 2.5, windPhase: 2.8 }
  ]);
}

function midYarrowGeometry(): THREE.BufferGeometry {
  return flowerClump([
    { geometry: singleYarrow(0.32, 5, 1), x: 0, z: 0, windPhase: 0.6 },
    { geometry: singleYarrow(0.27, 4, 1), x: 0.16, z: 0.09, scale: 0.8, yaw: 2.4, windPhase: 2.9 }
  ]);
}

function midGoldfieldGeometry(): THREE.BufferGeometry {
  return flowerClump([
    { geometry: singleGoldfield(0.18, 6, 1, false), x: 0, z: 0, windPhase: 0.2 },
    { geometry: singleGoldfield(0.14, 5, 1, false), x: 0.13, z: 0.08, scale: 0.8, yaw: 2.6, windPhase: 2.7 }
  ]);
}

const MID_BUILDERS = [midPoppyGeometry, midLupineGeometry, midYarrowGeometry, midGoldfieldGeometry];

/** Two crossed single-triangle stems plus two crossed bloom diamonds. At 50+
 *  metres this retains a planted coloured fleck without carrying the twelve
 *  subdivided stem triangles that were invisible at that screen size. */
function farAccentGeometry(): THREE.BufferGeometry {
  const pos = [
    // Two tapered stem silhouettes (one triangle in each crossed plane).
    -0.015, 0, 0, 0.015, 0, 0, 0, 0.39, 0,
    0, 0, -0.015, 0, 0, 0.015, 0, 0.39, 0,
    // Two crossed bloom diamonds.
    -0.09, 0.38, 0, 0, 0.43, 0, 0.09, 0.38, 0, 0, 0.33, 0,
    0, 0.38, -0.09, 0, 0.43, 0, 0, 0.38, 0.09, 0, 0.33, 0
  ];
  const head = new Float32Array(14);
  head.fill(1, 6);
  const grad = new Float32Array(14);
  grad.fill(0.72, 6);
  const accent = new THREE.BufferGeometry();
  accent.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  accent.setAttribute("aHead", new THREE.Float32BufferAttribute(head, 1));
  accent.setAttribute("aG", new THREE.Float32BufferAttribute(grad, 1));
  accent.setIndex([
    0, 1, 2,
    3, 4, 5,
    6, 9, 7, 7, 9, 8,
    10, 13, 11, 11, 13, 12
  ]);
  accent.computeVertexNormals();
  return finalizeBloom([accent], 0.45);
}

// Flower heads remain clearly readable nearby, where their movement spans
// several pixels. Farther out, even a few centimetres of sway makes the bright
// petals jump between pixels after their thin stems disappear. Ease that motion
// away before the flowers become sub-pixel so they keep reading as planted.
const FLOWER_WIND_FULL_DISTANCE = 14;
const FLOWER_WIND_ZERO_DISTANCE = 46;

// COLOUR-FROM-ROTATION (the article's cheap-variation trick): a flower's yaw
// nudges its brightness, so a patch of the same species + tint still varies bloom
// to bloom for free — no extra buffer, no extra pass. Placed clumps recover it
// from the yaw they already unpack; authored beds bake it into aFlowerAnchor.w.
function flowerRotationShade(yaw: number): number {
  return 1 + Math.cos(yaw) * 0.1 + Math.sin(yaw) * 0.06;
}

// ---- material ------------------------------------------------------------------

const STEM_COL = vec3(0.12, 0.22, 0.09);

type FlowerMaterialState = {
  material: THREE.MeshSSSNodeMaterial | THREE.MeshStandardNodeMaterial;
  focus: THREE.Vector2;
};

type FlowerRenderTier = "authored" | "hero" | "mid" | "far";

/** A placed rung reads the shared ground-cover instance planes through the
 *  frustum-culled visible-index indirection, exactly as a blade layer does:
 *  transforms = anchor xyz + yaw · shapes = spread, height, wind gain, live
 *  outer radius · colors = bloom rgb + dissolve rank. */
type FlowerPlacedSource = {
  indirect: GroundcoverInstanceSource;
  grade: FlowerGrade;
};

function flowerMaterial(tier: FlowerRenderTier, placed?: FlowerPlacedSource): FlowerMaterialState {
  const indirect = placed?.indirect ?? null;
  // True SSS is reserved for hero/authored petals where translucency covers
  // enough pixels to read. Mid/far tiers use a cheaper standard node material,
  // retaining the colour ramp and rim lift without paying SSS over the field.
  const usesSss = tier === "authored" || tier === "hero";
  const mat: THREE.MeshSSSNodeMaterial | THREE.MeshStandardNodeMaterial = usesSss
    ? new THREE.MeshSSSNodeMaterial()
    : new THREE.MeshStandardNodeMaterial();
  mat.side = THREE.DoubleSide;
  mat.roughness = tier === "far" ? 0.72 : 0.5;
  mat.metalness = 0;
  const swayData: N = attribute("aSway", "vec3");
  const swayW: N = swayData.x;
  const windOffset: N = swayData.yz;
  const headMask: N = attribute("aHead", "float");
  const grad: N = attribute("aG", "float"); // 0 bloom centre → 1 petal tip

  // Placed rungs fetch instance data through the frustum-culled index buffer;
  // hoist each vec4 into a var so reuse doesn't re-emit buffer loads.
  const trueIndex: N | null = indirect
    ? (indirect.visibleIndices.element(instanceIndex) as N).toVar()
    : null;
  /** anchor xyz + yaw */
  const d0: N | null = indirect ? (indirect.transforms.element(trueIndex) as N).toVar() : null;
  /** spread, height, wind gain, live outer radius */
  const d1: N | null = indirect ? (indirect.shapes.element(trueIndex) as N).toVar() : null;
  /** bloom rgb + dissolve rank */
  const d2: N | null = indirect ? (indirect.colors.element(trueIndex) as N).toVar() : null;

  // Authored beds still draw as InstancedMesh, where positionNode runs AFTER the
  // instance matrix in Three r185: keep the exact mesh-local instance translation
  // available so any shrink pivots around the root and not the world origin.
  // Its W carries the baked yaw colour variance a placed rung recovers in-shader.
  const flowerAnchor: N | null = indirect ? null : attribute("aFlowerAnchor", "vec4");
  const anchorLocal: N = indirect ? d0.xyz : flowerAnchor.xyz;
  // Ring meshes sit at the world origin, so the packed anchor IS world space.
  const anchorWorld: N = indirect ? d0.xyz : instanceAnchorWorld(anchorLocal);
  const focus = new THREE.Vector2(1e6, 1e6);
  const focusU: N = uniform(focus);

  // Placed rungs reconstruct rotation in-shader (no instance matrix), so yaw is
  // unpacked once here and reused by the colour shade, the lit normal and the
  // transform below.
  const yawCos: N | null = indirect ? (cos(d0.w) as N).toVar() : null;
  const yawSin: N | null = indirect ? (sin(d0.w) as N).toVar() : null;
  // COLOUR-FROM-ROTATION: recovered from the yaw already unpacked (placed) or
  // baked beside the anchor (authored) — either way it costs no extra data.
  const rotShade: N = indirect
    ? float(1).add(yawCos.mul(0.1)).add(yawSin.mul(0.06))
    : flowerAnchor.w;
  // Fragment stages cannot key storage reads off instanceIndex — route the
  // shaded bloom colour through a vertex-stage varying in indirect mode.
  const bloomV: N = indirect
    ? vertexStage(d2.xyz.mul(rotShade))
    : (attribute("aBloom", "vec3") as N).mul(rotShade);
  // Petal COLOUR RAMP: just a small luminous lift at the very centre → the SATURATED
  // bloom over most of the petal (a soft glow without washing the flower out — pale
  // reads as sickly in a bright daylit meadow, unlike the reference's dark scene).
  const core: N = mix(bloomV, vec3(1.0, 0.95, 0.86), 0.34);
  const petalCol: N = mix(core, bloomV, (grad as N).pow(0.55));
  mat.colorNode = mix(STEM_COL, petalCol, headMask);

  // The lit normal must be yaw-rotated and pushed through a vertex-stage varying.
  let litNormalView: N = normalView as N;
  if (indirect) {
    const inverseScaled: N = vec3(
      (normalGeometry as N).x.div(d1.x.max(1e-4)),
      (normalGeometry as N).y.div(d1.y.max(1e-4)),
      (normalGeometry as N).z.div(d1.x.max(1e-4))
    );
    const rotated: N = vec3(
      inverseScaled.x.mul(yawCos).sub(inverseScaled.z.mul(yawSin)) as N,
      inverseScaled.y as N,
      inverseScaled.x.mul(yawSin).add(inverseScaled.z.mul(yawCos)) as N
    );
    litNormalView = vertexStage((cameraViewMatrix as N).mul(vec4(rotated, 0)).xyz) as N;
    mat.normalNode = litNormalView.normalize();
  }

  // FRESNEL RIM: grazing petal edges glow, the way a back-lit petal's rim lights up.
  const facing: N = litNormalView.normalize().dot((positionViewDirection as N).normalize()).abs();
  const rim: N = facing.oneMinus().pow(2.6);
  // Emissive keeps blooms luminous (a colour wash even in shade) with a brighter rim
  // edge — the reference blooms read self-lit, not lit only by where the sun happens
  // to hit them. Combined with the sky-biased normals + SSS this glows without going flat.
  // authored at the reference exposure — rebased (config.EXPOSURE_REBASE)
  const emissiveGain = tier === "far" ? 0.24 : tier === "mid" ? 0.34 : 0.42;
  mat.emissiveNode = petalCol.mul(rim.mul(0.5).add(emissiveGain)).mul(headMask).mul(EXPOSURE_REBASE);

  // Translucency: petals let colour through when back-lit; stems stay opaque green.
  if (usesSss) {
    const sss = mat as THREE.MeshSSSNodeMaterial;
    sss.thicknessColorNode = petalCol.mul(0.9).mul(headMask);
    sss.thicknessDistortionNode = uniform(0.45);
    sss.thicknessAmbientNode = uniform(0.24);
    sss.thicknessAttenuationNode = uniform(1.0);
    sss.thicknessPowerNode = uniform(3.0);
    sss.thicknessScaleNode = uniform(9.0);
  }

  // SHARED trample — read the same displacer field the grass reads, so walking a
  // drift presses hero blooms down as the grass flattens. The 12-displacer loop
  // is deliberately absent from mid/far shaders, where that response is invisible.
  const interactive = tier === "authored" || tier === "hero";
  const crush: N = interactive
    ? (Fn(() => {
        const c = (float(0) as N).toVar();
        Loop(MAX_DISPLACERS, ({ i }: { i: N }) => {
          const d = (DISPLACERS as N).element(i);
          const len = anchorWorld.xz.sub(d.xy).length().max(1e-4);
          const infl = d.z.sub(len).div(d.z.max(1e-4)).clamp(0, 1);
          c.addAssign(infl.mul(infl).mul(d.w));
        });
        return c.min(1);
      }) as N)()
    : float(0);

  // SHARED wind — form every offset in world space, then map that VECTOR (w=0)
  // through only the mesh world inverse. The instance transform already ran.
  // Every stalk in a clump still uses the one canonical grass/flower wind, but its
  // baked phase-space offset prevents all 3–5 stems from behaving like one rigid mesh.
  const swayAmt: N = tier === "mid"
    ? groundSwayLite(anchorWorld.xz.add(windOffset))
    : interactive
      ? groundSway(anchorWorld.xz.add(windOffset))
      : float(0);
  const windDamp: N = float(1).sub(crush.mul(0.7));
  const cameraDist: N = anchorWorld.distance(cameraPosition);
  const windLod: N = tier === "authored"
    ? cameraDist
        .sub(FLOWER_WIND_FULL_DISTANCE)
        .div(FLOWER_WIND_ZERO_DISTANCE - FLOWER_WIND_FULL_DISTANCE)
        .clamp(0, 1)
        .oneMinus()
    : float(1);
  // Hero/authored blooms ride the swirling flow field; the cheaper mid/far tiers
  // keep the single prevailing heading (far's amplitude is 0 anyway).
  const flowXZ: N = tier === "mid" || tier === "far"
    ? vec2(WIND_DIR.x, WIND_DIR.z).mul(swayAmt)
    : groundSwayFlow(anchorWorld.xz.add(windOffset));
  // A placed clump carries its own wind gain (taller stems catch more), exactly
  // as a blade cluster does through the same `shapes.z` slot.
  const windGain: N = indirect ? d1.z : float(1);
  const windWorld: N = vec3(flowXZ.x, 0, flowXZ.y)
    .mul(tier === "mid" ? 0.065 : tier === "far" ? 0 : 0.11)
    .mul(swayW)
    .mul(windGain)
    .mul(windDamp)
    .mul(windLod);
  const dipWorld: N = vec3(0, crush.mul(-0.4).mul(swayW), 0); // head sinks when stepped on

  // GROW IN / GROW OUT. One shared window (rankDissolve.ts), read here to shrink
  // the clump toward its root and read again by this rung's cull pass to drop it.
  // The rung's own annulus and the instance's stable rank set the distance, so
  // adjacent rungs partition the same clumps instead of cross-fading a whole
  // ring at once — no LOD bloom at the player, no dithered coverage, no pop.
  const growthFade: N = placed
    ? rankAnnulusGrowth(anchorWorld.xz.sub(focusU).length(), d2.w, {
      visibleRadius: d1.w,
      fadeBand: placed.grade.fadeBand,
      minRadius: placed.grade.minRadius,
      innerBand: placed.grade.innerBand
    })
    : float(1);

  if (indirect) {
    // Reconstruct the instance transform from packed data: the dissolve shrinks
    // toward the root at the geometry origin, then yaw-rotate and translate to
    // the world anchor. Wind/trample offsets are world-space and the ring meshes
    // sit at the origin, so they apply directly.
    const shaped: N = vec3(
      (positionGeometry as N).x.mul(d1.x),
      (positionGeometry as N).y.mul(d1.y),
      (positionGeometry as N).z.mul(d1.x)
    ).mul(growthFade);
    const world: N = vec3(
      shaped.x.mul(yawCos).sub(shaped.z.mul(yawSin)).add(d0.x) as N,
      shaped.y.add(d0.y) as N,
      shaped.x.mul(yawSin).add(shaped.z.mul(yawCos)).add(d0.z) as N
    );
    mat.positionNode = world.add(windWorld.add(dipWorld).mul(growthFade));
  } else {
    const scaled: N = fadeAroundInstanceAnchor(positionLocal as N, anchorLocal, growthFade);
    const offsetLocal: N = worldOffsetToModelLocal(windWorld.add(dipWorld).mul(growthFade));
    mat.positionNode = scaled.add(offsetLocal);
  }
  mat.envMapIntensity = tier === "far" ? 0.25 : 0.5;
  applyGroundcoverAtmosphere(mat);
  return { material: mat, focus };
}

// ---- ring ----------------------------------------------------------------------

// The beauty camera sees this layer; the half-resolution ink prepass does not.
// Tiny animated petals otherwise become unstable depth/normal outlines.
const BEAUTY_ONLY_LAYER = SHADOW_LAYERS.BEAUTY_ONLY;

type Row = { x: number; y: number; z: number; yaw: number; sx: number; sy: number; r: number; g: number; b: number };

const FLOWER_DEFORM_BOUNDS_MARGIN = 0.65;

function writeFlowerInstances(mesh: THREE.InstancedMesh, list: readonly Row[], computeBounds = false) {
  const m = mesh.instanceMatrix.array as Float32Array;
  const bloomAttr = mesh.geometry.getAttribute("aBloom") as THREE.InstancedBufferAttribute;
  const anchorAttr = mesh.geometry.getAttribute("aFlowerAnchor") as THREE.InstancedBufferAttribute;
  const bloom = bloomAttr.array as Float32Array;
  const anchor = anchorAttr.array as Float32Array;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    dummy.position.set(f.x, f.y, f.z);
    dummy.rotation.set(0, f.yaw, 0);
    dummy.scale.set(f.sx, f.sy, f.sx);
    dummy.updateMatrix();
    dummy.matrix.toArray(m, i * 16);
    bloom[i * 3] = f.r;
    bloom[i * 3 + 1] = f.g;
    bloom[i * 3 + 2] = f.b;
    anchor[i * 4] = f.x;
    anchor[i * 4 + 1] = f.y;
    anchor[i * 4 + 2] = f.z;
    anchor[i * 4 + 3] = flowerRotationShade(f.yaw);
  }
  mesh.count = list.length;
  mesh.instanceMatrix.needsUpdate = true;
  bloomAttr.needsUpdate = true;
  anchorAttr.needsUpdate = true;
  if (computeBounds) {
    if (list.length === 0) {
      mesh.boundingBox = new THREE.Box3().makeEmpty();
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    } else {
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      mesh.boundingBox?.expandByScalar(FLOWER_DEFORM_BOUNDS_MARGIN);
      if (mesh.boundingSphere) mesh.boundingSphere.radius += FLOWER_DEFORM_BOUNDS_MARGIN;
    }
  }
}

/**
 * Static authored flower patch for landmark gardens and compact parks. It uses
 * the exact same curved 3D clumps, SSS lighting, wind and trample material as
 * the player-following wildlands ring; only placement ownership differs.
 */
export function createAuthoredFlowerPatch(
  placements: readonly AuthoredFlowerPlacement[],
  options: {
    name: string;
    palettes?: Partial<Record<AuthoredFlowerSpecies | AuthoredFlowerForm, AuthoredFlowerPalette>>;
  }
) {
  const group = new THREE.Group();
  group.name = options.name;
  const materialState = flowerMaterial("authored");
  // Authored patches are spatially bounded by their owner and use its range
  // gate — no distance dissolve, so the focus is inert for them.
  materialState.focus.set(0, 0);
  const material = materialState.material;
  // Existing authored gardens pay nothing for sky-only silhouettes: construct
  // only the extra forms this compact patch actually places.
  const usedForms = [...new Set(
    placements.flatMap((placement) => placement.form ? [placement.form] : [])
  )];
  const formDefinitions = usedForms.map((form) => {
    const definition = AUTHORED_FORM_REGISTRY.get(form);
    if (!definition) {
      throw new Error(`[vegetation:${options.name}] authored flower form '${form}' is not registered`);
    }
    return definition;
  });
  const geoms = [
    ...BUILDERS.map((builder) => builder()),
    ...formDefinitions.map((definition) => definition.build())
  ];
  const speciesIds: readonly (AuthoredFlowerSpecies | AuthoredFlowerForm)[] = [
    ...FLOWER_SPECIES_IDS,
    ...usedForms
  ];
  const speciesIndex = new Map(speciesIds.map((id, index) => [id, index] as const));
  const nativeSpeciesIndex = new Map(FLOWER_SPECIES_IDS.map((id, index) => [id, index] as const));
  const rows: Row[][] = geoms.map(() => []);
  const colorA = new THREE.Color();
  const colorB = new THREE.Color();
  const color = new THREE.Color();

  placements.forEach((placement, index) => {
    const form = placement.form ?? placement.species;
    const species = speciesIndex.get(form);
    if (species === undefined) return;
    const nativeSpecies = nativeSpeciesIndex.get(placement.species) ?? 0;
    const fallback = PALETTES[nativeSpecies];
    const palette = options.palettes?.[form] ?? options.palettes?.[placement.species] ?? fallback;
    const tint = placement.tint ?? hash2(Math.floor(placement.x * 10), Math.floor(placement.z * 10), index + 883);
    colorA.setHex(palette.a);
    colorB.setHex(palette.b);
    color.copy(colorA).lerp(colorB, tint).multiplyScalar(0.9 + tint * 0.18);
    rows[species].push({
      x: placement.x,
      y: placement.y,
      z: placement.z,
      yaw: placement.yaw,
      sx: placement.scale,
      sy: placement.scale * (0.88 + tint * 0.22),
      r: color.r,
      g: color.g,
      b: color.b
    });
  });

  let instances = 0;
  let heads = 0;
  let submittedTriangles = 0;
  const meshes: THREE.InstancedMesh[] = [];
  geoms.forEach((geometry, species) => {
    const list = rows[species];
    if (list.length === 0) {
      geometry.dispose();
      return;
    }
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.name = `${options.name}_${speciesIds[species]}`;
    mesh.layers.set(BEAUTY_ONLY_LAYER);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const bloom = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    const anchor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
    bloom.setUsage(THREE.StaticDrawUsage);
    anchor.setUsage(THREE.StaticDrawUsage);
    geometry.setAttribute("aBloom", bloom);
    geometry.setAttribute("aFlowerAnchor", anchor);
    writeFlowerInstances(mesh, list, true);
    group.add(mesh);
    meshes.push(mesh);
    const triangles = (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
    instances += list.length;
    const speciesId = speciesIds[species];
    const nativeHeadIndex = nativeSpeciesIndex.get(speciesId as AuthoredFlowerSpecies);
    const headsPerClump = nativeHeadIndex === undefined
      ? AUTHORED_FORM_REGISTRY.get(speciesId as AuthoredFlowerForm)?.heads ?? 0
      : HEADS_PER_CLUMP[nativeHeadIndex];
    heads += list.length * headsPerClump;
    submittedTriangles += list.length * triangles;
  });

  return {
    group,
    stats: { instances, heads, submittedTriangles, draws: meshes.length },
    dispose() {
      for (const mesh of meshes) mesh.geometry.dispose();
      material.dispose();
      group.removeFromParent();
      group.clear();
    }
  };
}


// ---- placed ladder ---------------------------------------------------------------

/** Seat a clump on the lowest point of its footprint, a few centimetres proud of
 *  it, and refuse ground that breaks by more than a stem's worth across the span. */
const ROOT_MAX_RISE = 0.78;
const ROOT_SINK = 0.035;
/** Ground taps for the shared accent rungs, whose species varies per instance. */
const ACCENT_FOOTPRINT_RADIUS = 0.28;
/** Three vec4 instance planes, matching the shared ground-cover arena. */
const FLOWER_INSTANCE_BYTES = 12 * Float32Array.BYTES_PER_ELEMENT;
/** Retarget the placement after the player moves this far. */
const FLOWER_STREAM_STEP = 6;
/** Instance slots reserved per candidate on the shared accent rungs. */
const ACCENT_CAPACITY_FRACTION = 0.85;

// Palettes as LINEAR working-space colour, resolved once so the placement shader
// can carry them as literals instead of another storage buffer.
const PALETTE_LINEAR = PALETTES.map(({ a, b }) => ({
  a: new THREE.Color().setHex(a),
  b: new THREE.Color().setHex(b)
}));

const speciesBloom = (species: number, tint: N): N => {
  const { a, b } = PALETTE_LINEAR[species];
  return mix(vec3(a.r, a.g, a.b), vec3(b.r, b.g, b.b), tint);
};

/** Palette for a species only known at runtime (the shared accent rungs). */
const dynamicBloom = (speciesId: N, tint: N): N => {
  let bloom: N = speciesBloom(PALETTE_LINEAR.length - 1, tint);
  for (let species = PALETTE_LINEAR.length - 2; species >= 0; species--) {
    bloom = select(speciesId.equal(int(species)), speciesBloom(species, tint), bloom);
  }
  return bloom;
};

const dynamicHeightScale = (speciesId: N): N => {
  let scale: N = float(FAR_HEIGHT_SCALE[FAR_HEIGHT_SCALE.length - 1]);
  for (let species = FAR_HEIGHT_SCALE.length - 2; species >= 0; species--) {
    scale = select(speciesId.equal(int(species)), float(FAR_HEIGHT_SCALE[species]), scale);
  }
  return scale;
};

/** The baked field's packed B channel: species id in the integer part, its clump's
 *  brightness seed in the fraction. Read from the NEAREST tap so neither drifts. */
const unpackSpecies = (ctx: GpuGrassStyleContext): { id: N; seed: N } => {
  const packed = (ctx.ecoNearest.z.mul(4) as N).toVar();
  return { id: int(packed), seed: packed.fract() };
};

/** Roll this candidate against the baked keep shape × the live density knob, and
 *  (for a species-specific rung) against the species its clump belongs to. */
function flowerSelect(species: number | null) {
  return (ctx: GpuGrassStyleContext): N => {
    const keep = ctx.density.mul(ctx.ecoNearest.y).clamp(0, KEEP_CEILING);
    const rolled = ctx.hash01(ctx.gx, ctx.gz, 23).lessThanEqual(keep) as N;
    if (species === null) return rolled;
    return rolled.and(unpackSpecies(ctx).id.equal(int(species)));
  };
}

/**
 * One clump's shape and bloom colour. Detail rungs carry the species silhouette
 * at its authored size; the accent rungs stand in for a sparser grid, so they
 * widen by the square root of their cell ratio and take the species' relative
 * height — a distant lupine spike still reads taller than a goldfield tuft.
 */
function flowerStyle(grade: FlowerGrade, species: number | null) {
  const representation = gradeRepresentation(grade);
  const accent = species === null;
  return (ctx: GpuGrassStyleContext) => {
    const { id, seed } = unpackSpecies(ctx);
    const tint = ctx.hash01(ctx.gx, ctx.gz, 41);
    const baseSpread = ctx.ecoNearest.w.add(ctx.hash01(ctx.gx, ctx.gz, 37).mul(0.5));
    const baseHeight = baseSpread.mul(float(0.85).add(tint.mul(0.3)));
    const heightScale = accent
      ? dynamicHeightScale(id)
      : float(1);
    const spread = accent
      ? baseSpread.mul(float(0.88).add(heightScale.mul(0.12))).mul(representation)
      : baseSpread;
    const height = accent ? baseHeight.mul(heightScale).mul(representation) : baseHeight;
    const bloom = (accent ? dynamicBloom(id, tint) : speciesBloom(species, tint))
      .mul(float(0.88).add(seed.mul(0.24))); // per-clump brightness
    return {
      spread,
      height,
      yaw: ctx.hash01(ctx.gx, ctx.gz, 31).mul(Math.PI * 2),
      // Taller stems catch more wind, exactly as a blade cluster's gain does.
      wind: float(0.88).add(baseHeight.mul(0.24)),
      color: bloom
    };
  };
}

export type FlowerRing = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  /** Per-frame GPU frustum cull against the render camera (cheap; no readback). */
  cullFrame(camera: THREE.Camera): void;
  /** Force a re-bake + re-place at the last focus (the debug panel calls this on
   *  a slider change; clump shaping is baked into the field, so it re-pages). */
  refresh(): void;
  /** Resolves once the near ladder has been placed for the latest focus. */
  whenCriticalReady(): Promise<void>;
  dispose(): void;
  stats: {
    /** Live clump instances (kept as `count` for existing diagnostics). */
    count: number;
    reach: number;
    /** Apparent flower heads/spikes/umbels represented by those clump instances. */
    heads: number;
    /** Instanced geometry triangles submitted by live clumps, before clipping. */
    submittedTriangles: number;
    /** Static triangles in one clump mesh for each of the four species. */
    trianglesPerClump: readonly number[];
    trianglesPerClumpByLod: {
      hero: readonly number[];
      mid: readonly number[];
      far: number;
    };
    /** Submitted GPU instances, including the rank-dissolve handoff bands. */
    submittedInstances: number;
    lodInstances: { hero: number; mid: number; far: number; dist: number; horizon: number };
    draws: number;
    reservedInstances: number;
    reservedInstanceBytes: number;
    droppedByCapacity: number;
    instanceCapPerSpecies: number;
    /** Paged ecology state, mirroring the grass field's streaming surface. */
    field: { ready: boolean; pendingCells: number; sampledCells: number };
  };
};

type FlowerTierName = "hero" | "mid" | "far" | "dist" | "horizon";

type FlowerRung = {
  tier: FlowerTierName;
  species: number | null;
  grade: FlowerGrade;
  triangles: number;
  /** Candidate grid cells this rung tests each time placement retargets. */
  candidates: number;
  capacity: number;
  live: number;
};

export function createFlowerRing(
  map: GardenTerrain,
  excluded?: (x: number, z: number) => boolean,
  options: {
    /** App-wide frame-budget lane used to page the baked ecology. */
    schedule?: (job: () => void | "again") => void;
    sliceBudgetMs?: number;
    now?: () => number;
  } = {}
): FlowerRing {
  // Lazily bound so CPU-side contracts can construct the ring headlessly; the
  // placement and cull passes only run inside the live frame loop.
  let renderer: THREE.WebGPURenderer | null = null;
  const group = new THREE.Group();
  group.name = "wildlands_flowers";

  const heroGeometries = BUILDERS.map((builder) => builder());
  const midGeometries = MID_BUILDERS.map((builder) => builder());
  const farGeometry = farAccentGeometry();
  const triangleCount = (geometry: THREE.BufferGeometry) =>
    (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
  const trianglesPerClump = heroGeometries.map(triangleCount);
  const midTrianglesPerClump = midGeometries.map(triangleCount);
  const farTriangles = triangleCount(farGeometry);

  const fields = createFlowerFields(map, excluded, {
    schedule: options.schedule,
    sliceBudgetMs: options.sliceBudgetMs,
    now: options.now
  });

  // Live reach, shared by every rung: each clamps it by its own authored radius,
  // so one slider grows the whole ladder outward instead of only its last rung.
  const reachU: N = uniform(FLOWER_REACH_MIN);
  const materials: FlowerMaterialState[] = [];
  const rungs: FlowerRung[] = [];

  const detailRung = (
    tier: "hero" | "mid",
    grade: FlowerGrade,
    geometries: THREE.BufferGeometry[],
    triangles: number[]
  ): GpuGrassLayerInput[] =>
    geometries.map((geometry, species) => {
      rungs.push({ tier, species, grade, triangles: triangles[species], candidates: 0, capacity: 0, live: 0 });
      return {
        spec: {
          name: `${tier}_sp${species}`,
          gridStride: grade.gridStride,
          visibleRadius: grade.visibleRadius,
          fadeBand: grade.fadeBand,
          minRadius: grade.minRadius,
          innerBand: grade.innerBand,
          densityLayers: 1,
          groundFit: "lowest",
          groundFoot: ROOT_FOOTPRINT_RADIUS[species],
          groundSink: ROOT_SINK,
          slopeCull: ROOT_MAX_RISE
        },
        geometry,
        materialFor: (source: GroundcoverInstanceSource) => {
          const state = flowerMaterial(tier, { indirect: source, grade });
          materials.push(state);
          return state;
        },
        trianglesPerCluster: triangles[species],
        style: flowerStyle(grade, species),
        select: flowerSelect(species),
        radiusNode: reachU,
        // A superbloom drift forces ONE species across its whole ellipse, so at
        // the maximum density the dominant rung has to hold nearly every kept
        // candidate — reserve just past the baked keep ceiling.
        capacityFraction: KEEP_CEILING + 0.03
      } satisfies GpuGrassLayerInput;
    });

  const accentRung = (
    tier: "far" | "dist" | "horizon",
    grade: FlowerGrade,
    field?: ReturnType<typeof createFlowerFields>["horizon"]
  ): GpuGrassLayerInput => {
    rungs.push({ tier, species: null, grade, triangles: farTriangles, candidates: 0, capacity: 0, live: 0 });
    // The horizon rung reads a 12 m ecology, where a 30 cm footprint fit and a
    // stem-height slope cull resolve nothing: seat it on the interpolated
    // surface and let the ladder's inner rungs own the terrain-fitting rules.
    const coarse = tier === "horizon";
    return {
      spec: {
        name: tier,
        gridStride: grade.gridStride,
        visibleRadius: grade.visibleRadius,
        fadeBand: grade.fadeBand,
        minRadius: grade.minRadius,
        innerBand: grade.innerBand,
        densityLayers: 1,
        groundFit: coarse ? "average" : "lowest",
        groundFoot: ACCENT_FOOTPRINT_RADIUS,
        groundSink: ROOT_SINK,
        slopeCull: coarse ? 1e6 : ROOT_MAX_RISE
      },
      geometry: farGeometry,
      materialFor: (source: GroundcoverInstanceSource) => {
        // The `far` rung shares the mid rung's ground: it takes over from
        // swaying clumps at ~40 m, so it keeps the cheap one-sine wind rather
        // than standing dead still beside them. Only past ~100 m, where a few
        // centimetres of sway makes a bright petal jump between pixels, does the
        // ladder go static.
        const state = flowerMaterial(tier === "far" ? "mid" : "far", { indirect: source, grade });
        materials.push(state);
        return state;
      },
      trianglesPerCluster: farTriangles,
      style: flowerStyle(grade, null),
      select: flowerSelect(null),
      radiusNode: reachU,
      field,
      // Worst case is a maximum-density superbloom: the baked keep ceiling times
      // the plantable share of a wildlands region. Reserve past that — a rung
      // that overflows drops in grid order, which would carve a visible empty
      // quadrant rather than thinning evenly.
      capacityFraction: ACCENT_CAPACITY_FRACTION
    } satisfies GpuGrassLayerInput;
  };

  const inputs: GpuGrassLayerInput[] = [
    ...detailRung("hero", HERO_GRADE, heroGeometries, trianglesPerClump),
    ...detailRung("mid", MID_GRADE, midGeometries, midTrianglesPerClump),
    accentRung("far", FAR_GRADE),
    accentRung("dist", DIST_GRADE),
    accentRung("horizon", HORIZON_GRADE, fields.horizon)
  ];

  const gpu: GpuGrassPlacement = createGpuGrassPlacement(
    fields.near,
    inputs,
    FLOWER_SPACING,
    1,
    "wildlands_flowers"
  );
  for (const geometry of [...heroGeometries, ...midGeometries, farGeometry]) geometry.dispose();
  gpu.layers.forEach((layer, index) => {
    rungs[index].capacity = layer.capacity;
    rungs[index].candidates = layer.candidateSide * layer.candidateSide;
    // The beauty camera sees blooms; the half-resolution ink prepass must not.
    layer.mesh.layers.set(BEAUTY_ONLY_LAYER);
    // Empty pools stay out of the render list so WebGPU does not compile every
    // flower pipeline during the initial world reveal.
    layer.mesh.visible = false;
    layer.mesh.userData.flowerTier = rungs[index].tier;
    layer.mesh.userData.flowerSpecies = rungs[index].species;
    group.add(layer.mesh);
  });
  // QA surface: probes read the per-frame culled draw counts from this shared
  // indirect buffer (renderer.getArrayBufferAsync) to verify GPU frustum culling.
  group.userData.flowerIndirect = gpu.indirect;
  group.userData.flowerRungs = rungs;

  const reservedInstances = rungs.reduce((sum, rung) => sum + rung.capacity, 0);
  const speciesCapacity = rungs
    .filter((rung) => rung.species !== null)
    .reduce((sum, rung) => sum + rung.capacity, 0) / PALETTES.length;
  const accentCapacity = rungs
    .filter((rung) => rung.species === null)
    .reduce((sum, rung) => sum + rung.capacity, 0);
  const instanceCapPerSpecies = Math.ceil(speciesCapacity + accentCapacity / PALETTES.length);

  let disposed = false;
  let generation = 0;
  let activePromise: Promise<void> = Promise.resolve();
  let lastSyncX = Number.NaN;
  let lastSyncZ = Number.NaN;
  const lastFocus = { x: 1e9, z: 1e9 };
  // Compact finished at least once this residency. Per-frame cull used to
  // early-out on CPU live counts, which forced a MAP_READ every stream step.
  let placementReady = false;

  function configuredReach(): number {
    return Math.min(
      FLOWER_REACH_MAX,
      Math.max(FLOWER_REACH_MIN, Number(FLOWER_TUNING.values.reach))
    );
  }

  const clearLive = (): void => {
    for (const rung of rungs) rung.live = 0;
    for (const layer of gpu.layers) layer.mesh.visible = false;
    placementReady = false;
  };

  const requestGeneration = (focus: { x: number; z: number }, force = false): void => {
    if (disposed) return;
    if (
      !force && Number.isFinite(lastSyncX) &&
      Math.hypot(focus.x - lastSyncX, focus.z - lastSyncZ) < FLOWER_STREAM_STEP
    ) return;
    lastSyncX = focus.x;
    lastSyncZ = focus.z;
    const id = ++generation;
    const destination = { x: focus.x, z: focus.z };

    const run = (async () => {
      await fields.request(destination);
      if (disposed || id !== generation) return;
      gpu.focus.set(destination.x, destination.z);
      gpu.cullFocus.set(destination.x, destination.z);
      // Effective density = authored ceiling × governor foliage scale (1.0, or
      // 0.7 at L4). The tweakpane slider stays the ceiling; this only ever trims.
      gpu.density.value =
        Math.max(0, Number(FLOWER_TUNING.values.density)) * governorEffects().foliageScale;
      reachU.value = configuredReach();
      for (const material of materials) material.focus.set(destination.x, destination.z);
      // Headless placement contracts build the real graphs with no device; the
      // baked ecology above is the half they exercise.
      renderer ??= optionalRenderer();
      if (!renderer) return;

      // Reset and every rung's compactor share one command encoder, so rendering
      // can only ever observe the whole old field or the whole new one.
      await renderer.computeAsync([gpu.reset, ...gpu.layers.map((layer) => layer.compute), ...gpu.finalize]);
      if (disposed || id !== generation) return;
      // This frame's frustum pass may already have run against the previous
      // placement; re-cull immediately so the draw counts match the new buffers.
      renderer.compute(gpu.cullPasses);
      // Zero-instance indirect draws are free. Showing every rung after the
      // first compact avoids toggling visibility from a MAP_READ. Stats still
      // read back once per residency so probes have a real population.
      if (!placementReady) {
        const readback = await renderer.getArrayBufferAsync(gpu.liveCounts);
        if (disposed || id !== generation) return;
        const liveCounts = new Uint32Array(readback as ArrayBuffer);
        for (let index = 0; index < rungs.length; index++) {
          rungs[index].live = liveCounts[index] ?? 0;
        }
      }
      placementReady = true;
      for (const layer of gpu.layers) layer.mesh.visible = true;
    })();
    activePromise = run.catch((error) => {
      if (id === generation) console.warn("[flowers] placement failed", error);
    });
  };

  const waitForLatest = async (): Promise<void> => {
    while (!disposed) {
      const requested = activePromise;
      await requested;
      if (requested === activePromise) return;
    }
  };

  // Governor foliage axis: the L4 rung drops effective density to 0.7×. Re-place
  // only when the multiplier actually changes — the governor already enforces an
  // ~8 s dwell around L4 entry/exit, so this never churns on ordinary steps.
  let lastFoliageScale = governorEffects().foliageScale;
  const unsubscribeGovernor = onGovernorChange((effects) => {
    if (effects.foliageScale === lastFoliageScale) return;
    lastFoliageScale = effects.foliageScale;
    if (lastFocus.x < 1e8) requestGeneration(lastFocus, true);
  });

  return {
    group,
    update(focus) {
      lastFocus.x = focus.x;
      lastFocus.z = focus.z;
      // Keep the dissolve centred on the live player every frame; only the
      // placement itself is throttled by FLOWER_STREAM_STEP.
      for (const material of materials) material.focus.set(focus.x, focus.z);
      // Region AABB early-out: outside every wild region (+ live reach) there is
      // nothing to bake and nothing to draw, so the ecology never pages downtown.
      if (!nearAnyWildRegion(focus.x, focus.z, configuredReach() + FLOWER_STREAM_STEP + 2)) {
        generation++;
        group.visible = false;
        clearLive();
        lastSyncX = Number.NaN;
        lastSyncZ = Number.NaN;
        return;
      }
      group.visible = true;
      requestGeneration(focus);
    },
    cullFrame(camera) {
      if (disposed || !group.visible || !placementReady) return;
      renderer ??= optionalRenderer();
      if (!renderer) return;
      // The per-instance dissolve tracks the live player focus, matching each
      // material's shrink; keep the cull reading the same point every frame.
      gpu.cullFocus.set(lastFocus.x, lastFocus.z);
      gpu.updateCullCamera(camera);
      renderer.compute(gpu.cullPasses);
    },
    refresh() {
      // Clump shaping and species selection are baked into the ecology field, so
      // moving those sliders re-bakes rather than re-rolls.
      fields.invalidate();
      if (lastFocus.x < 1e8) requestGeneration(lastFocus, true);
    },
    whenCriticalReady: waitForLatest,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      unsubscribeGovernor();
      fields.dispose();
      gpu.dispose();
      for (const material of materials) material.material.dispose();
      group.removeFromParent();
      group.clear();
    },
    get stats() {
      let count = 0;
      let heads = 0;
      let submittedTriangles = 0;
      let draws = 0;
      let droppedByCapacity = 0;
      const lodInstances = { hero: 0, mid: 0, far: 0, dist: 0, horizon: 0 };
      for (const rung of rungs) {
        const live = Math.min(rung.capacity, rung.live);
        droppedByCapacity += Math.max(0, rung.live - rung.capacity);
        lodInstances[rung.tier] += live;
        count += live;
        submittedTriangles += live * rung.triangles;
        draws += live > 0 ? 1 : 0;
        heads += live * (
          rung.tier === "hero" ? HEADS_PER_CLUMP[rung.species ?? 0]
            : rung.tier === "mid" ? MID_HEADS_PER_CLUMP[rung.species ?? 0]
              : 1
        );
      }
      const field = fields.near.stats;
      return {
        count,
        reach: configuredReach(),
        heads,
        submittedTriangles,
        trianglesPerClump,
        trianglesPerClumpByLod: {
          hero: trianglesPerClump,
          mid: midTrianglesPerClump,
          far: farTriangles
        },
        submittedInstances: count,
        lodInstances,
        draws,
        reservedInstances,
        reservedInstanceBytes: reservedInstances * FLOWER_INSTANCE_BYTES,
        droppedByCapacity,
        instanceCapPerSpecies,
        field: {
          ready: field.ready,
          pendingCells: field.pendingCells,
          sampledCells: field.sampledCells
        }
      };
    }
  };
}

/** World-space half-extents of the two baked ecology squares, for contracts. */
export const FLOWER_LADDER = {
  hero: HERO_GRADE,
  mid: MID_GRADE,
  far: FAR_GRADE,
  dist: DIST_GRADE,
  horizon: HORIZON_GRADE,
  spacing: FLOWER_SPACING,
  nearHalfExtent: FLOWER_FIELD_HALF_EXTENT,
  horizonHalfExtent: FLOWER_HORIZON_HALF_EXTENT
} as const;
