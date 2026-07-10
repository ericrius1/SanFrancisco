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
// dimensional, back-lit, glowing cups — not flat cards. Plus per-clump + per-rotation
// colour variation so a patch isn't copy-pasted.

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  attribute,
  float,
  Fn,
  Loop,
  mix,
  modelWorldMatrix,
  normalView,
  positionLocal,
  positionViewDirection,
  uniform,
  vec3,
  vec4
} from "three/tsl";
import { groundSway, WIND_DIR } from "../groundcover/sway";
import { DISPLACERS, MAX_DISPLACERS } from "../groundcover/displacers";
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

/** Merge the parts, bias petal normals toward the sky (so cupped petals still catch
 *  skylight instead of going black — same trick the grass uses), and bake aSway. */
function finalizeBloom(parts: THREE.BufferGeometry[], totalH: number): THREE.BufferGeometry {
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const head = g.getAttribute("aHead");
  const sway = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getY(i) / totalH));
    sway[i] = t * t;
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
  g.setAttribute("aSway", new THREE.Float32BufferAttribute(sway, 1));
  return g;
}

/** 0 poppy — the hero: a lush, many-petalled, layered ranunculus-form bloom. Five
 *  rings of small cupped petals, each ring tighter + more upright toward the centre,
 *  spun by irregular offsets so the packing reads natural, not radially symmetric. */
function poppyGeometry(): THREE.BufferGeometry {
  const stemH = 0.5;
  const parts = makeStem(stemH, 0.02);
  bloomRings(parts, stemH + 0.02, [
    { count: 8, pitch: 0.12, len: 0.2, wid: 0.17, rise: 0.32, close: 0.12, cup: 0.5, out: 0.022 },
    { count: 8, pitch: 0.42, len: 0.16, wid: 0.14, rise: 0.46, close: 0.26, cup: 0.7, out: 0.016, spin: 0.4 },
    { count: 7, pitch: 0.78, len: 0.13, wid: 0.12, rise: 0.58, close: 0.36, cup: 0.9, out: 0.011, spin: 0.85 },
    { count: 6, pitch: 1.12, len: 0.095, wid: 0.1, rise: 0.7, close: 0.46, cup: 1.1, out: 0.007, spin: 0.25 },
    { count: 5, pitch: 1.45, len: 0.06, wid: 0.08, rise: 0.8, close: 0.55, cup: 1.3, out: 0.004, spin: 0.6 }
  ], 4);
  return finalizeBloom(parts, stemH + 0.24);
}

/** 1 lupine — tall spike of stacked cupped florets. */
function lupineGeometry(): THREE.BufferGeometry {
  const stemH = 0.34, spikeH = 0.44, tiers = 8;
  const parts = makeStem(stemH, 0.02);
  const floret = makePetal(0.075, 0.07, 0.55, 0.35, 0.7, 3);
  for (let t = 0; t < tiers; t++) {
    const frac = t / (tiers - 1);
    const y = stemH + frac * spikeH;
    const r = 0.018 + 0.05 * (1 - frac * 0.7);
    for (let i = 0; i < 5; i++) parts.push(layPetal(floret, 0.65, (i / 5) * Math.PI * 2 + t * 0.7, y, r));
  }
  floret.dispose();
  return finalizeBloom(parts, stemH + spikeH);
}

/** 2 yarrow — short stem + a domed umbel of tiny florets. */
function yarrowGeometry(): THREE.BufferGeometry {
  const stemH = 0.3;
  const parts = makeStem(stemH, 0.02);
  const flo = makePetal(0.05, 0.05, 0.3, 0.2, 0.5, 2);
  const n = 13;
  for (let i = 0; i < n; i++) {
    const a = i * 2.399; // golden-angle spread
    const rr = 0.015 + 0.075 * Math.sqrt(i / n);
    parts.push(layPetal(flo, 0.5, a, stemH + 0.02, rr));
  }
  flo.dispose();
  return finalizeBloom(parts, stemH + 0.08);
}

/** 3 goldfield — low daisy for carpeting drifts: a small cupped gold star. */
function goldfieldGeometry(): THREE.BufferGeometry {
  const stemH = 0.16;
  const parts = makeStem(stemH, 0.016);
  bloomRings(parts, stemH + 0.005, [
    { count: 11, pitch: 0.18, len: 0.075, wid: 0.045, rise: 0.28, close: 0.05, cup: 0.5, out: 0.006 },
    { count: 8, pitch: 0.5, len: 0.05, wid: 0.038, rise: 0.45, close: 0.2, cup: 0.7, out: 0.004, spin: 0.4 }
  ], 3);
  return finalizeBloom(parts, stemH + 0.07);
}

const BUILDERS = [poppyGeometry, lupineGeometry, yarrowGeometry, goldfieldGeometry];

// ---- material ------------------------------------------------------------------

const STEM_COL = vec3(0.12, 0.22, 0.09);
const FLOWER_FADE_FOCUS = uniform(new THREE.Vector2(1e6, 1e6));
const FLOWER_REACH_U = uniform(80);

let sharedMaterial: THREE.MeshSSSNodeMaterial | null = null;
function flowerMaterial(): THREE.MeshSSSNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  // MeshSSS (same family as the grass) so petals are TRANSLUCENT — light passes
  // through them and they glow when back-lit, the ethereal look from the reference.
  const mat = new THREE.MeshSSSNodeMaterial();
  mat.side = THREE.DoubleSide;
  mat.roughness = 0.5;
  mat.metalness = 0;
  const swayW: N = attribute("aSway", "float");
  const headMask: N = attribute("aHead", "float");
  const grad: N = attribute("aG", "float"); // 0 bloom centre → 1 petal tip
  const bloom: N = attribute("aBloom", "vec3"); // per-instance bloom colour
  // Per-instance (cosYaw, sinYaw, worldX, worldZ). We must carry the world anchor in
  // an attribute because modelWorldMatrix on an InstancedMesh is the MESH origin, not
  // the instance's — exactly how the grass passes its anchor (aGrassWind.zw).
  const inst: N = attribute("aInst", "vec4");

  // COLOUR-FROM-ROTATION (the article's cheap-variation trick): a flower's yaw
  // nudges its brightness, so a patch of the same species + tint still varies bloom
  // to bloom for free — no extra attribute, no extra pass.
  const rotShade: N = inst.x.mul(0.1).add(inst.y.mul(0.06)).add(1.0);
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

  const anchorWorld: N = (modelWorldMatrix as N).mul(vec4(inst.z, 0, inst.w, 1)).xz;

  // SHARED trample — read the same displacer field the grass reads, so walking a
  // drift presses the blooms down as the grass flattens (head dips, wind damps).
  const crush: N = (Fn(() => {
    const c = (float(0) as N).toVar();
    Loop(MAX_DISPLACERS, ({ i }: { i: N }) => {
      const d = (DISPLACERS as N).element(i);
      const len = anchorWorld.sub(d.xy).length().max(1e-4);
      const infl = d.z.sub(len).div(d.z.max(1e-4)).clamp(0, 1);
      c.addAssign(infl.mul(infl).mul(d.w));
    });
    return c.min(1);
  }) as N)();

  // SHARED wind — the exact grass sway signal, leaned along the shared WIND_DIR and
  // rotated into this instance's local frame via its (cos,sin) yaw so every flower
  // AND every grass blade lean the same world direction at the same phase/gust.
  const swayAmt: N = groundSway(anchorWorld);
  const wWorldX: N = swayAmt.mul(WIND_DIR.x);
  const wWorldZ: N = swayAmt.mul(WIND_DIR.z);
  const localX: N = wWorldX.mul(inst.x).sub(wWorldZ.mul(inst.y)); // R(-yaw) * worldWind
  const localZ: N = wWorldX.mul(inst.y).add(wWorldZ.mul(inst.x));
  const windDamp: N = float(1).sub(crush.mul(0.7));
  const windOffset: N = vec3(localX, float(0), localZ).mul(0.11).mul(swayW).mul(windDamp);
  const dip: N = vec3(0, crush.mul(-0.4).mul(swayW), 0); // head sinks when stepped on

  // Fade toward the ring rim (shared idea with the grass) so blooms shrink to nothing
  // at the edge instead of popping in as the ring re-scatters.
  const dist: N = anchorWorld.sub(FLOWER_FADE_FOCUS).length();
  const fade: N = (FLOWER_REACH_U as N).sub(dist).div((FLOWER_REACH_U as N).mul(0.16).max(1)).clamp(0, 1);

  mat.positionNode = (positionLocal as N).mul(fade).add(windOffset.mul(fade)).add(dip);
  mat.envMapIntensity = 0.5;
  sharedMaterial = mat;
  return mat;
}

// ---- ring ----------------------------------------------------------------------

const RESAMPLE_STEP = 9; // re-scatter after the focus moves this far (m)
const SPACING = 1.6; // flower cell (coarser than grass — flowers are accents)
const MAX_REACH = 110; // instance caps are sized for this worst case
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
  stats: { count: number };
};

export function createFlowerRing(map: GardenTerrain): FlowerRing {
  const group = new THREE.Group();
  group.name = "wildlands_flowers";
  const material = flowerMaterial();
  const geoms = BUILDERS.map((b) => b());

  const cellsAcross = (MAX_REACH * 2) / SPACING;
  const capPerSpecies = Math.ceil(cellsAcross * cellsAcross * 0.5);
  const meshes = geoms.map((geo, species) => {
    const mesh = new THREE.InstancedMesh(geo, material, capPerSpecies);
    mesh.name = `wildlands_flowers_sp${species}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // always right around the player
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const bloom = new THREE.InstancedBufferAttribute(new Float32Array(capPerSpecies * 3), 3);
    bloom.setUsage(THREE.StaticDrawUsage);
    const inst = new THREE.InstancedBufferAttribute(new Float32Array(capPerSpecies * 4), 4);
    inst.setUsage(THREE.StaticDrawUsage);
    mesh.geometry.setAttribute("aBloom", bloom);
    mesh.geometry.setAttribute("aInst", inst);
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
    const instAttr = mesh.geometry.getAttribute("aInst") as THREE.InstancedBufferAttribute;
    const bloom = bloomAttr.array as Float32Array;
    const inst = instAttr.array as Float32Array;
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
      inst[i * 4] = Math.cos(f.yaw);
      inst[i * 4 + 1] = Math.sin(f.yaw);
      inst[i * 4 + 2] = f.x;
      inst[i * 4 + 3] = f.z;
    }
    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true;
    bloomAttr.needsUpdate = true;
    instAttr.needsUpdate = true;
  }

  function resample(fx: number, fz: number) {
    const T = FLOWER_TUNING.values;
    const reach = Math.min(MAX_REACH, Math.max(20, T.reach as number));
    const density = Math.max(0, T.density as number);
    const clumpiness = Math.min(1, Math.max(0, T.clumpiness as number));
    const clumpSize = Math.max(2, T.clumpSize as number);
    FLOWER_REACH_U.value = reach;
    FLOWER_FADE_FOCUS.value.set(fx, fz);

    for (const list of rows) list.length = 0;
    const r2 = reach * reach;
    const gx0 = Math.floor((fx - reach) / SPACING);
    const gx1 = Math.ceil((fx + reach) / SPACING);
    const gz0 = Math.floor((fz - reach) / SPACING);
    const gz1 = Math.ceil((fz + reach) / SPACING);

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
        if (!grassyGround(map, px, pz)) continue;

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
      const dx = focus.x - last.x, dz = focus.z - last.z;
      if (dx * dx + dz * dz < RESAMPLE_STEP * RESAMPLE_STEP) return;
      last.x = focus.x;
      last.z = focus.z;
      // Region AABB early-out: the ~8k-cell worley scan used to run every 9 m
      // city-wide, even downtown where grassyGround rejects every cell. Outside
      // every wild region (+reach) skip the scan; one clearing write empties
      // the ring on the way out.
      if (!nearAnyWildRegion(focus.x, focus.z, MAX_REACH + 2)) {
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
      return { count };
    }
  };
}
