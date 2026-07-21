// Wildflower ring — the flowers, as a player-following ring co-located with the
// wildlands grass (grassField.ts). It re-scatters a dense patch around the player
// as they move, so cost is fixed regardless of region size and it's free outside
// the nature regions. This REPLACES the old static flowerField: density and the
// clump↔scatter balance are now live-tunable, and — the whole point — the flowers
// share the grass's exact wind (groundSway + WIND_DIR) and trample field, so grass
// and blooms lean the same way at the same time instead of fighting.
//
// Placement borrows the "False Earth" article's Voronoi clustering (scatter.ts's
// worleyClump): every cell asks which clump centre owns it and how deep in it sits,
// so you get real single-species patches with sparse mixed singles between them —
// wildflowers in a field, not an even sprinkle. Designed superbloom meadows still
// bloom hard up close via flowerDriftAt (the old FLOWER_DRIFTS as a density boost).
//
// LOOK (chasing momentchan/false-earth's luminous roses, our own wildflowers): real
// 3D curved layered petals with true normals + a translucent MeshSSS material + a
// fresnel rim glow + a pale-centre→saturated-edge colour ramp, so blooms read as
// dimensional, back-lit, glowing cups — not flat cards. Nearby GPU instances remain
// small 3–5-stem botanical clumps; distance tiers redistribute that detail into
// simplified species silhouettes and tiny static accents, spatially bucketed so
// off-camera meadow sectors actually cull.

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  abs,
  atomicAdd,
  atomicStore,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  float,
  Fn,
  If,
  instanceIndex,
  int,
  Loop,
  mix,
  normalGeometry,
  normalView,
  positionGeometry,
  positionLocal,
  positionViewDirection,
  sin,
  smoothstep as smoothstepNode,
  storage,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { groundSway, groundSwayFlow, groundSwayLite, WIND_DIR } from "../groundcover/sway";
import { DISPLACERS, MAX_DISPLACERS } from "../groundcover/displacers";
import { fadeAroundInstanceAnchor, instanceAnchorWorld, worldOffsetToModelLocal } from "../groundcover/instanceDeform";
import { fitGroundY } from "../groundcover/grounding";
import { hash2, r2Offset, smoothstep, worleyClump } from "../groundcover/scatter";
import { flowerDriftAt, grassyGround, nearAnyWildRegion, wildRegionAt } from "./layout";
import { releaseRendererAttribute, requireRenderer } from "../../app/rendererRegistry";
import type { GardenTerrain } from "../garden/layout";
import {
  EXPOSURE_REBASE,
  FLOWER_REACH_MAX,
  FLOWER_REACH_MIN,
  FLOWER_TUNING
} from "../../config";

type N = any;

// bloom base palettes (per-instance tint lerps within [a,b] by a hash)
const PALETTES: { a: number; b: number }[] = [
  { a: 0xff5a1e, b: 0xe23c14 }, // 0 poppy — california orange
  { a: 0x6a5cc4, b: 0x8f7ad8 }, // 1 lupine — blue-violet
  { a: 0xf3ead2, b: 0xf7d65a }, // 2 yarrow — cream→gold
  { a: 0xffc31e, b: 0xffd94a } // 3 goldfield — bright gold
];

export type AuthoredFlowerSpecies = "poppy" | "lupine" | "yarrow" | "goldfield";

export type AuthoredFlowerPlacement = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  species: AuthoredFlowerSpecies;
  /** Stable 0..1 colour variation within the species palette. */
  tint?: number;
};

export type AuthoredFlowerPalette = { a: number; b: number };

// which species favour which region, and (index 0) the clump-dominant pick order
const REGION_FLOWERS: Record<string, readonly number[]> = {
  ggpark: [0, 1, 2, 3],
  presidio: [1, 2, 0, 1],
  marin: [0, 0, 3, 1], // poppy-heavy golden hills + goldfields
  twinpeaks: [1, 2, 0, 3]
};
const DEFAULT_PAL: readonly number[] = [0, 1, 2, 3];

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
const HEADS_PER_CLUMP = [3, 3, 3, 5] as const;

// Geometry and deformation are now distance-graded. Hero clumps keep the full
// curved, layered botanical meshes and interactive trample. Mid clumps keep a
// recognizable species silhouette with 60–80% fewer triangles and one-sine
// sway. The distant field is a shared 6-triangle static accent, where stems and
// petal layering are sub-pixel anyway. Adjacent tiers overlap and scale through
// noisy handoff bands in the shader instead of hard-switching at a ring edge.
const HERO_FADE_START = 13;
const HERO_FADE_END = 19;
const MID_FADE_START = HERO_FADE_START;
const MID_FADE_END = HERO_FADE_END;
const MID_FADE_OUT_START = 43;
const MID_FADE_OUT_END = 51;
const FAR_FADE_START = MID_FADE_OUT_START;
const FAR_FADE_END = MID_FADE_OUT_END;
const LOD_NOISE_METRES = 1.5;
const HERO_SAMPLE_END = HERO_FADE_END + LOD_NOISE_METRES + 1;
const MID_SAMPLE_START = MID_FADE_START - LOD_NOISE_METRES - 1;
const MID_SAMPLE_END = MID_FADE_OUT_END + LOD_NOISE_METRES + 1;
const FAR_SAMPLE_START = FAR_FADE_START - LOD_NOISE_METRES - 1;

const MID_HEADS_PER_CLUMP = [2, 2, 2, 2] as const;

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

// A flower's existing yaw-derived colour variance also gives every clump a free,
// deterministic edge phase. Each clump fades through an 18 m window, while that
// window ends at a different point across the outermost 8 m. The combined 26 m
// transition dissolves into irregular singles instead of drawing a circular rim;
// no bloom extends beyond the configured reach.
export const FLOWER_ROTATION_SHADE_AMPLITUDE = 0.117;
export const FLOWER_EDGE_FADE_BAND_METRES = 18;
export const FLOWER_EDGE_STAGGER_METRES = 8;

function flowerRotationShade(yaw: number): number {
  return 1 + Math.cos(yaw) * 0.1 + Math.sin(yaw) * 0.06;
}

/** CPU mirror of the shader edge window, used by deterministic contracts and
 *  visual probes. Production packs the same yaw shade into aFlowerAnchor.w. */
export function flowerEdgeFadeWindow(reach: number, yaw: number): { start: number; end: number } {
  const shade = flowerRotationShade(yaw);
  const phase = THREE.MathUtils.clamp(
    0.5 - ((shade - 1) / FLOWER_ROTATION_SHADE_AMPLITUDE) * 0.5,
    0,
    1
  );
  const end = reach - phase * FLOWER_EDGE_STAGGER_METRES;
  return { start: end - FLOWER_EDGE_FADE_BAND_METRES, end };
}

// ---- material ------------------------------------------------------------------

const STEM_COL = vec3(0.12, 0.22, 0.09);

type FlowerMaterialState = {
  material: THREE.MeshSSSNodeMaterial | THREE.MeshStandardNodeMaterial;
  focus: THREE.Vector2;
  reach: N;
};

type FlowerRenderTier = "authored" | "hero" | "mid" | "far";

/** Storage handles for the GPU-culled ring tiers. The vertex shader resolves
 *  the real instance through `visibleIndices[base + instanceIndex]`, written by
 *  the per-frame frustum pass, and reconstructs the transform from packed data
 *  instead of an instance matrix. */
type FlowerIndirectSource = {
  /** vec4 — anchor xyz (world) + yaw. */
  data0: N;
  /** vec4 — scale xz, scale y, rotation shade, bucket id. */
  data1: N;
  /** vec4 — bloom rgb + conservative cull radius. */
  data2: N;
  /** uint — shared compacted visible-index buffer. */
  visibleIndices: N;
  /** uint uniform — first slot of this bucket's visible region. */
  base: N;
};

function flowerMaterial(tier: FlowerRenderTier, indirect?: FlowerIndirectSource): FlowerMaterialState {
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

  // Indirect tiers fetch packed instance data through the frustum-culled index
  // buffer; hoist each vec4 into a var so reuse doesn't re-emit buffer loads.
  const trueIndex: N | null = indirect
    ? (indirect.visibleIndices.element(uint(instanceIndex).add(indirect.base)) as N).toVar()
    : null;
  const d0: N | null = indirect ? (indirect.data0.element(trueIndex) as N).toVar() : null;
  const d1: N | null = indirect ? (indirect.data1.element(trueIndex) as N).toVar() : null;
  const d2: N | null = indirect ? (indirect.data2.element(trueIndex) as N).toVar() : null;

  // positionNode runs after the instance matrix in Three r185. Keep the exact
  // mesh-local instance translation available so LOD scales around the root,
  // never around the world's origin. W carries precomputed yaw colour variance.
  const flowerAnchor: N | null = indirect ? null : attribute("aFlowerAnchor", "vec4");
  const anchorLocal: N = indirect ? d0.xyz : flowerAnchor.xyz;
  // Ring meshes sit at the world origin, so the packed anchor IS world space.
  const anchorWorld: N = indirect ? d0.xyz : instanceAnchorWorld(anchorLocal);
  const focus = new THREE.Vector2(1e6, 1e6);
  const focusU: N = uniform(focus);
  const reachU: N = uniform(110);

  // COLOUR-FROM-ROTATION (the article's cheap-variation trick): a flower's yaw
  // nudges its brightness, so a patch of the same species + tint still varies bloom
  // to bloom for free — packed beside the anchor, no extra buffer or pass.
  const rotShade: N = indirect ? d1.z : flowerAnchor.w;
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

  // Indirect mode reconstructs rotation in-shader (no instance matrix), so the
  // lit normal must be yaw-rotated and pushed through a vertex-stage varying.
  const yawCos: N | null = indirect ? (cos(d0.w) as N).toVar() : null;
  const yawSin: N | null = indirect ? (sin(d0.w) as N).toVar() : null;
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
  const windWorld: N = vec3(flowXZ.x, 0, flowXZ.y)
    .mul(tier === "mid" ? 0.065 : tier === "far" ? 0 : 0.11)
    .mul(swayW)
    .mul(windDamp)
    .mul(windLod);
  const dipWorld: N = vec3(0, crush.mul(-0.4).mul(swayW), 0); // head sinks when stepped on

  const dist: N = anchorWorld.xz.sub(focusU).length();
  const rotationVariance: N = rotShade
    .sub(1)
    .div(FLOWER_ROTATION_SHADE_AMPLITUDE)
    .clamp(-1, 1);

  // Broad, staggered outer fade. Stable per-clump windows break the radial edge
  // into scattered singles while keeping the configured reach a hard outer cap.
  // Let the brighter rotation variants survive longest at the sparse horizon.
  const edgePhase: N = rotationVariance.mul(-0.5).add(0.5);
  const edgeEnd: N = reachU.sub(edgePhase.mul(FLOWER_EDGE_STAGGER_METRES));
  const ringFade: N = tier === "authored"
    ? float(1)
    : smoothstepNode(edgeEnd.sub(FLOWER_EDGE_FADE_BAND_METRES), edgeEnd, dist).oneMinus();

  // W is already a deterministic yaw-derived variance. Reuse it to slide the
  // LOD thresholds by ±1.5 m: the handoff is a noisy band, never a visible ring.
  // CPU tier membership is also focus-relative, so orbit/free cameras cannot
  // fade the only submitted tier away and open a flowerless hole at the player.
  const lodNoise: N = rotationVariance.mul(LOD_NOISE_METRES);
  const lodFade: N = tier === "hero"
    ? smoothstepNode(float(HERO_FADE_START).add(lodNoise), float(HERO_FADE_END).add(lodNoise), dist).oneMinus()
    : tier === "mid"
      ? smoothstepNode(float(MID_FADE_START).add(lodNoise), float(MID_FADE_END).add(lodNoise), dist)
          .mul(smoothstepNode(float(MID_FADE_OUT_START).add(lodNoise), float(MID_FADE_OUT_END).add(lodNoise), dist).oneMinus())
      : tier === "far"
        ? smoothstepNode(float(FAR_FADE_START).add(lodNoise), float(FAR_FADE_END).add(lodNoise), dist)
        : float(1);
  // Reach and LOD are intentionally separate effects. The configured reach is
  // the ONLY thing allowed to grow a flower up from its root. LOD handoffs used
  // to multiply geometry by `lodFade`, which made the hero clumps visibly bloom
  // at 13–19 m no matter how far the reach slider was pushed. Keep every LOD at
  // full size and dither its coverage instead, so detail changes without a near
  // growth ring while the real outer edge still grows at the configured reach.
  const growthFade: N = ringFade;
  if (indirect) {
    mat.opacityNode = vertexStage(lodFade);
    mat.alphaHash = true;
  }

  if (indirect) {
    // Reconstruct the instance transform from packed data: outer reach growth
    // shrinks toward the root at the geometry origin, then yaw-rotate and
    // translate to the world anchor. LOD coverage never changes the transform.
    // Wind/trample offsets are world-space and the ring meshes sit at the
    // origin, so they apply directly.
    const shaped: N = vec3(
      (positionGeometry as N).x.mul(d1.x),
      (positionGeometry as N).y.mul(d1.y),
      (positionGeometry as N).z.mul(d1.x)
    ).mul(growthFade);
    const placed: N = vec3(
      shaped.x.mul(yawCos).sub(shaped.z.mul(yawSin)).add(d0.x) as N,
      shaped.y.add(d0.y) as N,
      shaped.x.mul(yawSin).add(shaped.z.mul(yawCos)).add(d0.z) as N
    );
    mat.positionNode = placed.add(windWorld.add(dipWorld).mul(growthFade));
  } else {
    const scaled: N = fadeAroundInstanceAnchor(positionLocal as N, anchorLocal, growthFade);
    const offsetLocal: N = worldOffsetToModelLocal(windWorld.add(dipWorld).mul(growthFade));
    mat.positionNode = scaled.add(offsetLocal);
  }
  mat.envMapIntensity = tier === "far" ? 0.25 : 0.5;
  return { material: mat, focus, reach: reachU };
}

// ---- ring ----------------------------------------------------------------------

const RESAMPLE_STEP = 9; // re-scatter after the focus moves this far (m)
const SPACING = 1.6; // flower cell (coarser than grass — flowers are accents)
// Keep one rebuild-step of invisible instances outside the visible ring. As the
// player moves, those flowers enter through the shader fade from zero instead
// of appearing at ~70% scale on the next deterministic re-scatter.
const SAMPLE_OVERSCAN = RESAMPLE_STEP;
// Preserve the original full-density 110 m ring (plus overscan), then grow the
// field in progressively coarser world-space bands. Each far accent represents
// a larger patch, keeping the CPU scan and GPU instance pool nearly linear in
// visible detail instead of making a 10x radius cost 100x as much.
const SAMPLE_BANDS = [
  { end: 120, spacing: SPACING },
  { end: 360, spacing: 6 },
  { end: 1080, spacing: 18 },
  { end: 3240, spacing: 54 },
  { end: FLOWER_REACH_MAX + SAMPLE_OVERSCAN, spacing: 162 }
] as const;
// The beauty camera sees this layer; the half-resolution ink prepass does not.
// Tiny animated petals otherwise become unstable depth/normal outlines.
const BEAUTY_ONLY_LAYER = 31;
const CLUMP_SALT = 5171;

// keep-probability shape (before the density knob multiplies it)
const EVEN_PROB = 0.28; // clumpiness 0: a uniform moderate field
const CLUMP_PEAK = 0.85; // clumpiness 1: dense inside a clump
const CLUMP_FLOOR = 0.03; // clumpiness 1: sparse singles between clumps

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
    palettes?: Partial<Record<AuthoredFlowerSpecies, AuthoredFlowerPalette>>;
  }
) {
  const group = new THREE.Group();
  group.name = options.name;
  const materialState = flowerMaterial("authored");
  // Authored patches are spatially bounded by their owner and use its range
  // gate. Keep the ring-edge shader fade fully open for these static instances.
  materialState.focus.set(0, 0);
  materialState.reach.value = 1e7;
  const material = materialState.material;
  const geoms = BUILDERS.map((builder) => builder());
  const speciesIds: readonly AuthoredFlowerSpecies[] = ["poppy", "lupine", "yarrow", "goldfield"];
  const speciesIndex = new Map(speciesIds.map((id, index) => [id, index] as const));
  const rows: Row[][] = geoms.map(() => []);
  const colorA = new THREE.Color();
  const colorB = new THREE.Color();
  const color = new THREE.Color();

  placements.forEach((placement, index) => {
    const species = speciesIndex.get(placement.species);
    if (species === undefined) return;
    const fallback = PALETTES[species];
    const palette = options.palettes?.[placement.species] ?? fallback;
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
    heads += list.length * HEADS_PER_CLUMP[species];
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

export type FlowerRing = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  /** Per-frame GPU frustum cull against the render camera (cheap; no readback). */
  cullFrame(camera: THREE.Camera): void;
  /** force an immediate re-scatter at the last focus (debug panel calls this on a slider change) */
  refresh(): void;
  dispose(): void;
  stats: {
    /** GPU clump instances (kept as `count` for existing diagnostics). */
    count: number;
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
    /** Submitted GPU instances, including short cross-fade overlap bands. */
    submittedInstances: number;
    lodInstances: { hero: number; mid: number; far: number };
    draws: number;
    reservedInstances: number;
    reservedInstanceBytes: number;
    droppedByCapacity: number;
    instanceCapPerSpecies: number;
  };
};

type FlowerBucket = {
  mesh: THREE.Mesh;
  rows: Row[];
  capacity: number;
  /** First slot of this bucket's region in the shared data/visible buffers. */
  base: number;
  /** Bucket id baked into data1.w so the single cull pass can route slots. */
  index: number;
  triangles: number;
  /** Unscaled local bounding radius of the bucket geometry, for cull margins. */
  localRadius: number;
};

// GPU frustum culling replaced the old angular sector buckets: a per-frame
// compute pass tests every live clump against the camera and compacts the
// survivors into indirect draws, so each tier needs only one bucket per
// distinct geometry (hero/mid per species, far shared). Capacities preserve
// the previous reserve envelope (mid was 4 sectors × 1152 per species, far was
// 10 sectors × 1536).
const HERO_CAPACITY_PER_SPECIES = 640;
const MID_CAPACITY_PER_SPECIES = 4608;
const FAR_CAPACITY = 32768;
const FLOWER_INSTANCE_BYTES = 12 * Float32Array.BYTES_PER_ELEMENT; // 3 packed vec4s
/** World-space margin over the scaled cluster bound: wind sway + trample dip. */
const FLOWER_CULL_SLACK = 0.9;

const ROOT_FOOTPRINT_RADIUS = [0.31, 0.29, 0.27, 0.24] as const;
const ROOT_MAX_RISE = 0.78;
const ROOT_SINK = 0.035;
const FAR_HEIGHT_SCALE = [1, 1.28, 0.9, 0.68] as const;

export function createFlowerRing(map: GardenTerrain, excluded?: (x: number, z: number) => boolean): FlowerRing {
  // Lazily bound so CPU-side contracts can construct the ring headlessly; the
  // per-frame cull only runs inside the live frame loop where a renderer exists.
  let renderer: THREE.WebGPURenderer | null = null;
  const group = new THREE.Group();
  group.name = "wildlands_flowers";
  const heroGeometries = BUILDERS.map((builder) => builder());
  const midGeometries = MID_BUILDERS.map((builder) => builder());
  const farGeometry = farAccentGeometry();
  const trianglesPerClump = heroGeometries.map((geometry) =>
    (geometry.index?.count ?? geometry.getAttribute("position").count) / 3
  );
  const midTrianglesPerClump = midGeometries.map((geometry) =>
    (geometry.index?.count ?? geometry.getAttribute("position").count) / 3
  );
  const farTrianglesPerClump = (farGeometry.index?.count ?? farGeometry.getAttribute("position").count) / 3;

  // One bucket per distinct geometry; the per-frame GPU cull handles every
  // camera-facing decision per instance, so no angular sectoring is needed.
  const bucketSpecs = [
    ...heroGeometries.map((geometry, species) => ({
      name: `wildlands_flowers_hero_sp${species}`,
      tier: "hero" as FlowerRenderTier,
      geometry,
      capacity: HERO_CAPACITY_PER_SPECIES
    })),
    ...midGeometries.map((geometry, species) => ({
      name: `wildlands_flowers_mid_sp${species}`,
      tier: "mid" as FlowerRenderTier,
      geometry,
      capacity: MID_CAPACITY_PER_SPECIES
    })),
    {
      name: "wildlands_flowers_far",
      tier: "far" as FlowerRenderTier,
      geometry: farGeometry,
      capacity: FAR_CAPACITY
    }
  ];
  const totalCapacity = bucketSpecs.reduce((sum, spec) => sum + spec.capacity, 0);

  // Shared packed instance storage + the compacted visible-index buffer. CPU
  // rescatters rewrite the staging arrays every RESAMPLE_STEP metres; the cull
  // pass rewrites visibility every frame with zero readback.
  const data0Attr = new THREE.StorageInstancedBufferAttribute(totalCapacity, 4);
  const data1Attr = new THREE.StorageInstancedBufferAttribute(totalCapacity, 4);
  const data2Attr = new THREE.StorageInstancedBufferAttribute(totalCapacity, 4);
  const visibleAttr = new THREE.StorageBufferAttribute(new Uint32Array(totalCapacity), 1);
  const bucketBaseAttr = new THREE.StorageBufferAttribute(new Uint32Array(bucketSpecs.length), 1);
  const indirectData = new Uint32Array(bucketSpecs.length * 5);
  for (let index = 0; index < bucketSpecs.length; index++) {
    const geometry = bucketSpecs[index].geometry;
    indirectData[index * 5] = geometry.index?.count ?? geometry.getAttribute("position").count;
  }
  const indirect = new THREE.IndirectStorageBufferAttribute(indirectData, 1);
  const indirectStorage = storage(indirect, "uint", indirectData.length).toAtomic();
  const data0Read = storage(data0Attr, "vec4", totalCapacity).toReadOnly();
  const data1Read = storage(data1Attr, "vec4", totalCapacity).toReadOnly();
  const data2Read = storage(data2Attr, "vec4", totalCapacity).toReadOnly();
  const visibleRead = storage(visibleAttr, "uint", totalCapacity).toReadOnly();
  const visibleWrite = storage(visibleAttr, "uint", totalCapacity);
  const bucketBaseRead = storage(bucketBaseAttr, "uint", bucketSpecs.length).toReadOnly();

  const materialStates: FlowerMaterialState[] = [];
  let runningBase = 0;
  const allBuckets = bucketSpecs.map((spec, index): FlowerBucket => {
    const base = runningBase;
    runningBase += spec.capacity;
    (bucketBaseAttr.array as Uint32Array)[index] = base;
    if (!spec.geometry.boundingSphere) spec.geometry.computeBoundingSphere();
    const state = flowerMaterial(spec.tier, {
      data0: data0Read,
      data1: data1Read,
      data2: data2Read,
      visibleIndices: visibleRead,
      base: uniform(base, "uint")
    });
    materialStates.push(state);

    const geometry = new THREE.InstancedBufferGeometry();
    if (spec.geometry.index) geometry.setIndex(spec.geometry.index);
    for (const [attributeName, value] of Object.entries(spec.geometry.attributes)) {
      geometry.setAttribute(attributeName, value);
    }
    geometry.instanceCount = spec.capacity;
    geometry.setIndirect(indirect, index * 5 * Uint32Array.BYTES_PER_ELEMENT);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 24_000);

    const mesh = new THREE.Mesh(geometry, state.material);
    mesh.name = spec.name;
    mesh.frustumCulled = false;
    mesh.layers.set(BEAUTY_ONLY_LAYER);
    // Empty streaming pools stay out of the render list so WebGPU does not
    // compile every flower-tier pipeline during the initial world reveal.
    mesh.visible = false;
    // QA surface: contracts/probes read packed instance data through these
    // instead of the former per-mesh instanced attributes.
    mesh.userData.flowerBase = base;
    mesh.userData.flowerCapacity = spec.capacity;
    mesh.userData.flowerCount = 0;
    group.add(mesh);
    return {
      mesh,
      rows: [],
      capacity: spec.capacity,
      base,
      index,
      triangles: (spec.geometry.index?.count ?? spec.geometry.getAttribute("position").count) / 3,
      localRadius: spec.geometry.boundingSphere?.radius ?? 1
    };
  });
  const heroBuckets = allBuckets.slice(0, 4);
  const midBuckets = allBuckets.slice(4, 8);
  const farBucket = allBuckets[8];
  group.userData.flowerData0 = data0Attr.array;
  // QA surface: probes read the per-frame culled draw counts from this shared
  // indirect buffer (renderer.getArrayBufferAsync) to verify GPU frustum culling.
  group.userData.flowerIndirect = indirect;
  const reservedInstances = totalCapacity;
  const capPerSpecies =
    HERO_CAPACITY_PER_SPECIES +
    MID_CAPACITY_PER_SPECIES +
    Math.ceil(FAR_CAPACITY / PALETTES.length);

  // Per-frame culling: zero the draw counts, then route every live clump that
  // survives the frustum test into its bucket's compacted visible region.
  const cullViewProjection = uniform(new THREE.Matrix4());
  const cullProjScale = uniform(new THREE.Vector2(1, 1));
  const drawReset = Fn(() => {
    atomicStore(indirectStorage.element(instanceIndex.mul(uint(5)).add(uint(1))), uint(0));
  })().compute(bucketSpecs.length, [64]).setName("flowers draw reset");
  const cull = Fn(() => {
    const d1 = (data1Read.element(instanceIndex) as N).toVar();
    const bucket = int(d1.w);
    If(bucket.greaterThanEqual(int(0)), () => {
      const d0 = (data0Read.element(instanceIndex) as N).toVar();
      const radius = (data2Read.element(instanceIndex) as N).w.toVar();
      const center = vec3(d0.x, d0.y.add(radius.mul(0.5)), d0.z);
      const clip = ((cullViewProjection as N).mul(vec4(center, float(1))) as N).toVar();
      // Left/right/top/bottom planes with a projection-scaled world margin; no
      // near/far test (reversed-z safe — the ring reach already bounds range).
      const inFront = clip.w.greaterThan(radius.negate());
      const xIn = abs(clip.x).lessThan(clip.w.add(radius.mul(cullProjScale.x)));
      const yIn = abs(clip.y).lessThan(clip.w.add(radius.mul(cullProjScale.y)));
      If(inFront.and(xIn).and(yIn), () => {
        const slot = atomicAdd(indirectStorage.element(uint(bucket).mul(uint(5)).add(uint(1))), uint(1));
        visibleWrite.element(bucketBaseRead.element(uint(bucket)).add(slot)).assign(instanceIndex);
      });
    });
  })().compute(totalCapacity, [256]).setName("flowers cull");
  const cullPasses = [drawReset, cull];

  const col = new THREE.Color();
  const a = new THREE.Color();
  const b = new THREE.Color();
  const last = { x: 1e9, z: 1e9 };
  let count = 0;
  let heads = 0;
  let droppedByCapacity = 0;

  const sampleGround = (x: number, z: number) => map.groundHeight(x, z);

  function configuredReach(): number {
    return Math.min(
      FLOWER_REACH_MAX,
      Math.max(FLOWER_REACH_MIN, Number(FLOWER_TUNING.values.reach))
    );
  }

  function clearRows() {
    for (const bucket of allBuckets) bucket.rows.length = 0;
  }

  function uploadRows() {
    const stage0 = data0Attr.array as Float32Array;
    const stage1 = data1Attr.array as Float32Array;
    const stage2 = data2Attr.array as Float32Array;
    // A negative bucket id marks a dead slot; the cull pass skips them, so no
    // per-bucket live counters are needed.
    for (let slot = 0; slot < totalCapacity; slot++) stage1[slot * 4 + 3] = -1;
    for (const bucket of allBuckets) {
      for (let i = 0; i < bucket.rows.length; i++) {
        const row = bucket.rows[i];
        const slot = (bucket.base + i) * 4;
        stage0[slot] = row.x;
        stage0[slot + 1] = row.y;
        stage0[slot + 2] = row.z;
        stage0[slot + 3] = row.yaw;
        stage1[slot] = row.sx;
        stage1[slot + 1] = row.sy;
        stage1[slot + 2] = flowerRotationShade(row.yaw);
        stage1[slot + 3] = bucket.index;
        stage2[slot] = row.r;
        stage2[slot + 1] = row.g;
        stage2[slot + 2] = row.b;
        stage2[slot + 3] = bucket.localRadius * Math.max(row.sx, row.sy) + FLOWER_CULL_SLACK;
      }
      bucket.mesh.visible = bucket.rows.length > 0;
      bucket.mesh.userData.flowerCount = bucket.rows.length;
    }
    data0Attr.needsUpdate = true;
    data1Attr.needsUpdate = true;
    data2Attr.needsUpdate = true;
  }

  function pushRow(bucket: FlowerBucket, row: Row): boolean {
    if (bucket.rows.length >= bucket.capacity) {
      droppedByCapacity += 1;
      return false;
    }
    bucket.rows.push(row);
    return true;
  }

  function resample(fx: number, fz: number) {
    const T = FLOWER_TUNING.values;
    const reach = configuredReach();
    const density = Math.max(0, T.density as number);
    const clumpiness = Math.min(1, Math.max(0, T.clumpiness as number));
    const clumpSize = Math.max(2, T.clumpSize as number);
    for (const state of materialStates) state.reach.value = reach;

    clearRows();
    count = 0;
    heads = 0;
    droppedByCapacity = 0;
    const sampleReach = reach + SAMPLE_OVERSCAN;
    let bandStart = 0;
    for (let bandIndex = 0; bandIndex < SAMPLE_BANDS.length; bandIndex++) {
      const band = SAMPLE_BANDS[bandIndex];
      const bandEnd = Math.min(sampleReach, band.end);
      if (bandEnd <= bandStart) break;
      const spacing = band.spacing;
      const bandStart2 = bandStart * bandStart;
      const bandEnd2 = bandEnd * bandEnd;
      const gx0 = Math.floor((fx - bandEnd) / spacing);
      const gx1 = Math.ceil((fx + bandEnd) / spacing);
      const gz0 = Math.floor((fz - bandEnd) / spacing);
      const gz1 = Math.ceil((fz + bandEnd) / spacing);
      const saltOffset = bandIndex * 1009;

      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gz = gz0; gz <= gz1; gz++) {
          const jitter = r2Offset(gx, gz, 11 + saltOffset);
          const px = gx * spacing + (jitter.ox - 0.5) * spacing * 0.9;
          const pz = gz * spacing + (jitter.oz - 0.5) * spacing * 0.9;
          const dx = px - fx, dz = pz - fz;
          const distance2 = dx * dx + dz * dz;
          if (distance2 < bandStart2 || distance2 > bandEnd2) continue;

          // Voronoi clumping: how deep this cell sits in its nearest clump centre.
          const wc = worleyClump(px, pz, clumpSize * 1.7, CLUMP_SALT);
          const clumpField = smoothstep(clumpSize, 0, wc.d); // 1 at centre → 0 at rim
          // clumpiness blends an even field against tight clumps + sparse singles.
          const clumpyProb = CLUMP_FLOOR + (CLUMP_PEAK - CLUMP_FLOOR) * clumpField;
          const local = EVEN_PROB * (1 - clumpiness) + clumpyProb * clumpiness;

          // designed superbloom meadows: boost density where a drift covers this cell.
          const drift = flowerDriftAt(px, pz);
          const driftKeep = drift.boost > 0 ? density * drift.boost * 1.6 : 0;
          const baseKeep = density * local;
          const useDrift = driftKeep > baseKeep;
          const keep = Math.min(1, Math.max(baseKeep, driftKeep));
          if (hash2(gx, gz, 23 + saltOffset) > keep) continue;

          // expensive ground test only for cells that survived the keep roll
          if (excluded?.(px, pz) || !grassyGround(map, px, pz)) continue;

          const region = wildRegionAt(px, pz);
          const pal = (region && REGION_FLOWERS[region.id]) || DEFAULT_PAL;
          const inClump = clumpField > 0.4;
          let species: number;
          if (useDrift && drift.species >= 0) species = drift.species;
          else if (inClump) species = pal[Math.floor(wc.seed * pal.length) % pal.length]; // one dominant species per clump
          else species = pal[Math.floor(hash2(gx, gz, 29 + saltOffset) * pal.length) % pal.length]; // singles are mixed
          const tint = hash2(gx, gz, 41 + saltOffset);
          const pal2 = PALETTES[species];
          a.setHex(pal2.a);
          b.setHex(pal2.b);
          col.copy(a).lerp(b, tint).multiplyScalar(0.88 + wc.seed * 0.24); // per-clump brightness
          const sx = (inClump ? 0.9 : 0.72) + hash2(gx, gz, 37 + saltOffset) * 0.5;
          const y = fitGroundY(
            sampleGround,
            px,
            pz,
            ROOT_FOOTPRINT_RADIUS[species] * sx,
            ROOT_MAX_RISE,
            -ROOT_SINK
          );
          if (y === null) continue;

          const row: Row = {
            x: px,
            y,
            z: pz,
            yaw: hash2(gx, gz, 31 + saltOffset) * Math.PI * 2,
            sx,
            sy: sx * (0.85 + tint * 0.3),
            r: col.r,
            g: col.g,
            b: col.b
          };

          const distance = Math.sqrt(distance2);
          // A far accent stands in for a progressively larger patch. Scale it
          // continuously with distance so coarse-band boundaries never create
          // a visible size step as the player moves through the meadow.
          const representationScale = Math.sqrt(Math.max(1, distance / 120));
          let submitted = false;
          if (distance <= HERO_SAMPLE_END) submitted = pushRow(heroBuckets[species], row) || submitted;
          if (distance >= MID_SAMPLE_START && distance <= MID_SAMPLE_END) {
            submitted = pushRow(midBuckets[species], row) || submitted;
          }
          if (distance >= FAR_SAMPLE_START) {
            const speciesHeightScale = FAR_HEIGHT_SCALE[species];
            submitted = pushRow(farBucket, {
              ...row,
              sy: row.sy * speciesHeightScale * representationScale,
              sx: row.sx * (0.88 + speciesHeightScale * 0.12) * representationScale
            }) || submitted;
          }
          if (!submitted) continue;
          count += 1;
          heads += distance < (HERO_FADE_START + HERO_FADE_END) * 0.5
            ? HEADS_PER_CLUMP[species]
            : distance < (MID_FADE_OUT_START + MID_FADE_OUT_END) * 0.5
              ? MID_HEADS_PER_CLUMP[species]
              : 1;
        }
      }
      bandStart = band.end;
    }
    uploadRows();
  }

  return {
    group,
    update(focus) {
      // Keep fade centred on the live player every frame; only the deterministic
      // scatter itself is throttled by RESAMPLE_STEP.
      for (const state of materialStates) state.focus.set(focus.x, focus.z);
      const dx = focus.x - last.x, dz = focus.z - last.z;
      if (dx * dx + dz * dz < RESAMPLE_STEP * RESAMPLE_STEP) return;
      last.x = focus.x;
      last.z = focus.z;
      // Region AABB early-out: the multi-band Worley scan would otherwise run
      // every 9 m city-wide, even downtown where grassyGround rejects every cell.
      // Outside every wild region (+live reach), one clearing write empties it.
      if (!nearAnyWildRegion(focus.x, focus.z, configuredReach() + SAMPLE_OVERSCAN + 2)) {
        if (count > 0) {
          clearRows();
          uploadRows();
          count = 0;
          heads = 0;
        }
        return;
      }
      resample(focus.x, focus.z);
    },
    cullFrame(camera) {
      // Nothing live and already-cleared draw counts: skip the dispatch.
      if (count === 0) return;
      renderer ??= requireRenderer();
      camera.updateMatrixWorld();
      cullViewProjection.value.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      );
      cullProjScale.value.set(
        camera.projectionMatrix.elements[0],
        camera.projectionMatrix.elements[5]
      );
      renderer.compute(cullPasses);
    },
    refresh() {
      if (last.x < 1e8) resample(last.x, last.z);
    },
    dispose() {
      drawReset.dispose();
      cull.dispose();
      for (const bucket of allBuckets) {
        bucket.mesh.geometry.setIndirect(null);
        bucket.mesh.geometry.dispose();
      }
      for (const geometry of heroGeometries) geometry.dispose();
      for (const geometry of midGeometries) geometry.dispose();
      farGeometry.dispose();
      for (const state of materialStates) state.material.dispose();
      for (const attribute of [data0Attr, data1Attr, data2Attr, visibleAttr, bucketBaseAttr, indirect]) {
        releaseRendererAttribute(attribute);
      }
      group.removeFromParent();
      group.clear();
    },
    get stats() {
      const heroInstances = heroBuckets.reduce((sum, bucket) => sum + bucket.rows.length, 0);
      const midInstances = midBuckets.reduce((sum, bucket) => sum + bucket.rows.length, 0);
      const farInstances = farBucket.rows.length;
      const submittedTriangles =
        heroBuckets.reduce((sum, bucket) => sum + bucket.rows.length * bucket.triangles, 0) +
        midBuckets.reduce((sum, bucket) => sum + bucket.rows.length * bucket.triangles, 0) +
        farBucket.rows.length * farBucket.triangles;
      const submittedInstances = heroInstances + midInstances + farInstances;
      return {
        reach: configuredReach(),
        count,
        heads,
        submittedTriangles,
        trianglesPerClump,
        trianglesPerClumpByLod: {
          hero: trianglesPerClump,
          mid: midTrianglesPerClump,
          far: farTrianglesPerClump
        },
        submittedInstances,
        lodInstances: { hero: heroInstances, mid: midInstances, far: farInstances },
        draws: allBuckets.reduce((draws, bucket) => draws + (bucket.rows.length > 0 ? 1 : 0), 0),
        reservedInstances,
        reservedInstanceBytes: reservedInstances * FLOWER_INSTANCE_BYTES,
        droppedByCapacity,
        instanceCapPerSpecies: capPerSpecies
      };
    }
  };
}
