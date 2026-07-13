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
// dimensional, back-lit, glowing cups — not flat cards. Each GPU instance is a small
// 3–5-stem botanical clump: substantially more visible flower heads for the same four
// draws, with the old single-bloom triangle budget redistributed across hero + simpler
// satellite blooms instead of multiplying the scatter count.

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  attribute,
  cameraPosition,
  float,
  Fn,
  Loop,
  mix,
  normalView,
  positionLocal,
  positionViewDirection,
  uniform,
  vec3
} from "three/tsl";
import { groundSway, WIND_DIR } from "../groundcover/sway";
import { DISPLACERS, MAX_DISPLACERS } from "../groundcover/displacers";
import { fadeAroundInstanceAnchor, instanceAnchorWorld, worldOffsetToModelLocal } from "../groundcover/instanceDeform";
import { hash2, smoothstep, worleyClump } from "../groundcover/scatter";
import { flowerDriftAt, grassyGround, nearAnyWildRegion, wildRegionAt } from "./layout";
import type { GardenTerrain } from "../garden/layout";
import { EXPOSURE_REBASE, FLOWER_TUNING } from "../../config";

type N = any;

// bloom base palettes (per-instance tint lerps within [a,b] by a hash)
const PALETTES: { a: number; b: number }[] = [
  { a: 0xff5a1e, b: 0xe23c14 }, // 0 poppy — california orange
  { a: 0x6a5cc4, b: 0x8f7ad8 }, // 1 lupine — blue-violet
  { a: 0xf3ead2, b: 0xf7d65a }, // 2 yarrow — cream→gold
  { a: 0xffc31e, b: 0xffd94a } // 3 goldfield — bright gold
];

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

// Flower heads remain clearly readable nearby, where their movement spans
// several pixels. Farther out, even a few centimetres of sway makes the bright
// petals jump between pixels after their thin stems disappear. Ease that motion
// away before the flowers become sub-pixel so they keep reading as planted.
const FLOWER_WIND_FULL_DISTANCE = 14;
const FLOWER_WIND_ZERO_DISTANCE = 46;

// ---- material ------------------------------------------------------------------

const STEM_COL = vec3(0.12, 0.22, 0.09);

type FlowerMaterialState = {
  material: THREE.MeshSSSNodeMaterial;
  focus: THREE.Vector2;
  reach: N;
};

function flowerMaterial(): FlowerMaterialState {
  // MeshSSS (same family as the grass) so petals are TRANSLUCENT — light passes
  // through them and they glow when back-lit, the ethereal look from the reference.
  const mat = new THREE.MeshSSSNodeMaterial();
  mat.side = THREE.DoubleSide;
  mat.roughness = 0.5;
  mat.metalness = 0;
  const swayData: N = attribute("aSway", "vec3");
  const swayW: N = swayData.x;
  const windOffset: N = swayData.yz;
  const headMask: N = attribute("aHead", "float");
  const grad: N = attribute("aG", "float"); // 0 bloom centre → 1 petal tip
  const bloom: N = attribute("aBloom", "vec3"); // per-instance bloom colour
  // positionNode runs after the instance matrix in Three r185. Keep the exact
  // mesh-local instance translation available so LOD scales around the root,
  // never around the world's origin. W carries precomputed yaw colour variance.
  const flowerAnchor: N = attribute("aFlowerAnchor", "vec4");
  const anchorLocal: N = flowerAnchor.xyz;
  const anchorWorld: N = instanceAnchorWorld(anchorLocal);
  const focus = new THREE.Vector2(1e6, 1e6);
  const focusU: N = uniform(focus);
  const reachU: N = uniform(80);

  // COLOUR-FROM-ROTATION (the article's cheap-variation trick): a flower's yaw
  // nudges its brightness, so a patch of the same species + tint still varies bloom
  // to bloom for free — packed beside the anchor, no extra buffer or pass.
  const rotShade: N = flowerAnchor.w;
  const bloomV: N = bloom.mul(rotShade);
  // Petal COLOUR RAMP: just a small luminous lift at the very centre → the SATURATED
  // bloom over most of the petal (a soft glow without washing the flower out — pale
  // reads as sickly in a bright daylit meadow, unlike the reference's dark scene).
  const core: N = mix(bloomV, vec3(1.0, 0.95, 0.86), 0.34);
  const petalCol: N = mix(core, bloomV, (grad as N).pow(0.55));
  mat.colorNode = mix(STEM_COL, petalCol, headMask);

  // FRESNEL RIM: grazing petal edges glow, the way a back-lit petal's rim lights up.
  const facing: N = (normalView as N).normalize().dot((positionViewDirection as N).normalize()).abs();
  const rim: N = facing.oneMinus().pow(2.6);
  // Emissive keeps blooms luminous (a colour wash even in shade) with a brighter rim
  // edge — the reference blooms read self-lit, not lit only by where the sun happens
  // to hit them. Combined with the sky-biased normals + SSS this glows without going flat.
  // authored at the reference exposure — rebased (config.EXPOSURE_REBASE)
  mat.emissiveNode = petalCol.mul(rim.mul(0.5).add(0.42)).mul(headMask).mul(EXPOSURE_REBASE);

  // Translucency: petals let colour through when back-lit; stems stay opaque green.
  mat.thicknessColorNode = petalCol.mul(0.9).mul(headMask);
  mat.thicknessDistortionNode = uniform(0.45);
  mat.thicknessAmbientNode = uniform(0.24);
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(3.0);
  mat.thicknessScaleNode = uniform(9.0);

  // SHARED trample — read the same displacer field the grass reads, so walking a
  // drift presses the blooms down as the grass flattens (head dips, wind damps).
  const crush: N = (Fn(() => {
    const c = (float(0) as N).toVar();
    Loop(MAX_DISPLACERS, ({ i }: { i: N }) => {
      const d = (DISPLACERS as N).element(i);
      const len = anchorWorld.xz.sub(d.xy).length().max(1e-4);
      const infl = d.z.sub(len).div(d.z.max(1e-4)).clamp(0, 1);
      c.addAssign(infl.mul(infl).mul(d.w));
    });
    return c.min(1);
  }) as N)();

  // SHARED wind — form every offset in world space, then map that VECTOR (w=0)
  // through only the mesh world inverse. The instance transform already ran.
  // Every stalk in a clump still uses the one canonical grass/flower wind, but its
  // baked phase-space offset prevents all 3–5 stems from behaving like one rigid mesh.
  const swayAmt: N = groundSway(anchorWorld.xz.add(windOffset));
  const windDamp: N = float(1).sub(crush.mul(0.7));
  const windLod: N = anchorWorld
    .distance(cameraPosition)
    .sub(FLOWER_WIND_FULL_DISTANCE)
    .div(FLOWER_WIND_ZERO_DISTANCE - FLOWER_WIND_FULL_DISTANCE)
    .clamp(0, 1)
    .oneMinus();
  const windWorld: N = vec3(WIND_DIR.x, 0, WIND_DIR.z)
    .mul(swayAmt)
    .mul(0.11)
    .mul(swayW)
    .mul(windDamp)
    .mul(windLod);
  const dipWorld: N = vec3(0, crush.mul(-0.4).mul(swayW), 0); // head sinks when stepped on

  // Fade toward the ring rim (shared idea with the grass) so blooms shrink to nothing
  // at the edge instead of popping in as the ring re-scatters.
  const dist: N = anchorWorld.xz.sub(focusU).length();
  const fade: N = reachU.sub(dist).div(reachU.mul(0.16).max(1)).clamp(0, 1);

  const scaled: N = fadeAroundInstanceAnchor(positionLocal as N, anchorLocal, fade);
  const offsetLocal: N = worldOffsetToModelLocal(windWorld.add(dipWorld).mul(fade));
  mat.positionNode = scaled.add(offsetLocal);
  mat.envMapIntensity = 0.5;
  return { material: mat, focus, reach: reachU };
}

// ---- ring ----------------------------------------------------------------------

const RESAMPLE_STEP = 9; // re-scatter after the focus moves this far (m)
const SPACING = 1.6; // flower cell (coarser than grass — flowers are accents)
const MAX_REACH = 110;
// Keep one rebuild-step of invisible instances outside the visible ring. As the
// player moves, those flowers enter through the shader fade from zero instead
// of appearing at ~70% scale on the next deterministic re-scatter.
const SAMPLE_OVERSCAN = RESAMPLE_STEP;
const MAX_SAMPLE_REACH = MAX_REACH + SAMPLE_OVERSCAN;
// The beauty camera sees this layer; the half-resolution ink prepass does not.
// Tiny animated petals otherwise become unstable depth/normal outlines.
const BEAUTY_ONLY_LAYER = 31;
const CLUMP_SALT = 5171;

// keep-probability shape (before the density knob multiplies it)
const EVEN_PROB = 0.28; // clumpiness 0: a uniform moderate field
const CLUMP_PEAK = 0.85; // clumpiness 1: dense inside a clump
const CLUMP_FLOOR = 0.03; // clumpiness 1: sparse singles between clumps

type Row = { x: number; y: number; z: number; yaw: number; sx: number; sy: number; r: number; g: number; b: number };

export type FlowerRing = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  /** force an immediate re-scatter at the last focus (debug panel calls this on a slider change) */
  refresh(): void;
  stats: {
    /** GPU clump instances (kept as `count` for existing diagnostics). */
    count: number;
    /** Apparent flower heads/spikes/umbels represented by those clump instances. */
    heads: number;
    /** Instanced geometry triangles submitted by live clumps, before clipping. */
    submittedTriangles: number;
    /** Static triangles in one clump mesh for each of the four species. */
    trianglesPerClump: readonly number[];
    instanceCapPerSpecies: number;
  };
};

export function createFlowerRing(map: GardenTerrain, excluded?: (x: number, z: number) => boolean): FlowerRing {
  const group = new THREE.Group();
  group.name = "wildlands_flowers";
  const materialState = flowerMaterial();
  const material = materialState.material;
  const geoms = BUILDERS.map((b) => b());
  const trianglesPerClump = geoms.map((g) => (g.index?.count ?? g.getAttribute("position").count) / 3);

  const cellsAcross = (MAX_SAMPLE_REACH * 2) / SPACING;
  const capPerSpecies = Math.ceil(cellsAcross * cellsAcross * 0.5);
  const meshes = geoms.map((geo, species) => {
    const mesh = new THREE.InstancedMesh(geo, material, capPerSpecies);
    mesh.name = `wildlands_flowers_sp${species}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // always right around the player
    mesh.layers.set(BEAUTY_ONLY_LAYER);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const bloom = new THREE.InstancedBufferAttribute(new Float32Array(capPerSpecies * 3), 3);
    bloom.setUsage(THREE.StaticDrawUsage);
    const anchor = new THREE.InstancedBufferAttribute(new Float32Array(capPerSpecies * 4), 4);
    anchor.setUsage(THREE.StaticDrawUsage);
    mesh.geometry.setAttribute("aBloom", bloom);
    mesh.geometry.setAttribute("aFlowerAnchor", anchor);
    mesh.count = 0;
    group.add(mesh);
    return mesh;
  });

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const a = new THREE.Color();
  const b = new THREE.Color();
  const rows: Row[][] = geoms.map(() => []);
  const last = { x: 1e9, z: 1e9 };
  let count = 0;

  function write(mesh: THREE.InstancedMesh, list: Row[]) {
    const m = mesh.instanceMatrix.array as Float32Array;
    const bloomAttr = mesh.geometry.getAttribute("aBloom") as THREE.InstancedBufferAttribute;
    const anchorAttr = mesh.geometry.getAttribute("aFlowerAnchor") as THREE.InstancedBufferAttribute;
    const bloom = bloomAttr.array as Float32Array;
    const anchor = anchorAttr.array as Float32Array;
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
      anchor[i * 4 + 3] = 1 + Math.cos(f.yaw) * 0.1 + Math.sin(f.yaw) * 0.06;
    }
    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true;
    bloomAttr.needsUpdate = true;
    anchorAttr.needsUpdate = true;
  }

  function resample(fx: number, fz: number) {
    const T = FLOWER_TUNING.values;
    const reach = Math.min(MAX_REACH, Math.max(20, T.reach as number));
    const density = Math.max(0, T.density as number);
    const clumpiness = Math.min(1, Math.max(0, T.clumpiness as number));
    const clumpSize = Math.max(2, T.clumpSize as number);
    materialState.reach.value = reach;

    for (const list of rows) list.length = 0;
    const sampleReach = reach + SAMPLE_OVERSCAN;
    const r2 = sampleReach * sampleReach;
    const gx0 = Math.floor((fx - sampleReach) / SPACING);
    const gx1 = Math.ceil((fx + sampleReach) / SPACING);
    const gz0 = Math.floor((fz - sampleReach) / SPACING);
    const gz1 = Math.ceil((fz + sampleReach) / SPACING);

    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const px = gx * SPACING + (hash2(gx, gz, 11) - 0.5) * SPACING * 0.9;
        const pz = gz * SPACING + (hash2(gx, gz, 17) - 0.5) * SPACING * 0.9;
        const dx = px - fx, dz = pz - fz;
        if (dx * dx + dz * dz > r2) continue;

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
        if (hash2(gx, gz, 23) > keep) continue;

        // expensive ground test only for cells that survived the keep roll
        if (excluded?.(px, pz) || !grassyGround(map, px, pz)) continue;

        const region = wildRegionAt(px, pz);
        const pal = (region && REGION_FLOWERS[region.id]) || DEFAULT_PAL;
        const inClump = clumpField > 0.4;
        let species: number;
        if (useDrift && drift.species >= 0) species = drift.species;
        else if (inClump) species = pal[Math.floor(wc.seed * pal.length) % pal.length]; // one dominant species per clump
        else species = pal[Math.floor(hash2(gx, gz, 29) * pal.length) % pal.length]; // singles are mixed
        const list = rows[species];
        if (list.length >= capPerSpecies) continue;

        const tint = hash2(gx, gz, 41);
        const pal2 = PALETTES[species];
        a.setHex(pal2.a);
        b.setHex(pal2.b);
        col.copy(a).lerp(b, tint).multiplyScalar(0.88 + wc.seed * 0.24); // per-clump brightness
        const sx = (inClump ? 0.9 : 0.72) + hash2(gx, gz, 37) * 0.5;
        list.push({
          x: px,
          y: map.groundHeight(px, pz) - 0.03,
          z: pz,
          yaw: hash2(gx, gz, 31) * Math.PI * 2,
          sx,
          sy: sx * (0.85 + tint * 0.3),
          r: col.r,
          g: col.g,
          b: col.b
        });
      }
    }

    count = 0;
    meshes.forEach((mesh, species) => {
      write(mesh, rows[species]);
      count += rows[species].length;
    });
  }

  return {
    group,
    update(focus) {
      // Keep fade centred on the live player every frame; only the deterministic
      // scatter itself is throttled by RESAMPLE_STEP.
      materialState.focus.set(focus.x, focus.z);
      const dx = focus.x - last.x, dz = focus.z - last.z;
      if (dx * dx + dz * dz < RESAMPLE_STEP * RESAMPLE_STEP) return;
      last.x = focus.x;
      last.z = focus.z;
      // Region AABB early-out: the ~8k-cell worley scan used to run every 9 m
      // city-wide, even downtown where grassyGround rejects every cell. Outside
      // every wild region (+reach) skip the scan; one clearing write empties
      // the ring on the way out.
      if (!nearAnyWildRegion(focus.x, focus.z, MAX_SAMPLE_REACH + 2)) {
        if (count > 0) {
          for (const list of rows) list.length = 0;
          meshes.forEach((mesh, species) => write(mesh, rows[species]));
          count = 0;
        }
        return;
      }
      resample(focus.x, focus.z);
    },
    refresh() {
      if (last.x < 1e8) resample(last.x, last.z);
    },
    get stats() {
      let heads = 0;
      let submittedTriangles = 0;
      for (let species = 0; species < rows.length; species++) {
        heads += rows[species].length * HEADS_PER_CLUMP[species];
        submittedTriangles += rows[species].length * trianglesPerClump[species];
      }
      return { count, heads, submittedTriangles, trianglesPerClump, instanceCapPerSpecies: capPerSpecies };
    }
  };
}
