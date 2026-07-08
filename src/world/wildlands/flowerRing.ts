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
// Look upgrades over the old cards: structural petal normals (kept from each petal's
// lay angle, not flattened to "all up") so blooms read dimensional, plus per-clump
// and per-rotation colour variation so a patch isn't copy-pasted.

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { attribute, float, Fn, Loop, mix, modelWorldMatrix, positionLocal, uniform, vec3, vec4 } from "three/tsl";
import { groundSway, WIND_DIR } from "../groundcover/sway";
import { DISPLACERS, MAX_DISPLACERS } from "../groundcover/displacers";
import { hash2, smoothstep, worleyClump } from "../groundcover/scatter";
import { flowerDriftAt, grassyGround, wildRegionAt } from "./layout";
import type { GardenTerrain } from "../garden/layout";
import { FLOWER_TUNING } from "../../config";

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

// ---- geometry ------------------------------------------------------------------

/** Add a card and its reverse-wound twin so a FrontSide material shows both faces. */
function pushBothWindings(parts: THREE.BufferGeometry[], q: THREE.BufferGeometry) {
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

/** Bake the head mask (bloom vs stem) + wind-sway tip weight, and give the bloom
 *  STRUCTURAL normals: keep each petal's built-in outward tilt (from the angle it
 *  was laid at) and only lift it toward the sky, instead of flattening every normal
 *  to straight up — that flat look was half of why the old flowers read as paper. */
function finalize(g: THREE.BufferGeometry, stemH: number, totalH: number): THREE.BufferGeometry {
  const p = g.getAttribute("position");
  const normals = g.getAttribute("normal");
  const head = new Float32Array(p.count);
  const sway = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    head[i] = y > stemH - 0.02 ? 1 : 0;
    let nx = normals.getX(i) * 0.55;
    let ny = normals.getY(i) * 0.55 + 0.55;
    let nz = normals.getZ(i) * 0.55;
    const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
    nx *= inv; ny *= inv; nz *= inv;
    normals.setXYZ(i, nx, ny, nz);
    const t = Math.min(1, Math.max(0, y / totalH));
    sway[i] = t * t; // tip leans most (matches the grass's bladeT^2)
  }
  g.setAttribute("aHead", new THREE.BufferAttribute(head, 1));
  g.setAttribute("aSway", new THREE.BufferAttribute(sway, 1));
  return g;
}

/** A ring of `n` petals radiating from the stem top at height `y`. `tilt` raises the
 *  tips (0 = flat daisy, ~0.85 = cupped poppy). Petals overlap so the outline reads
 *  as a round bloom, not a hard cross. */
function radialPetals(parts: THREE.BufferGeometry[], n: number, petalW: number, petalL: number, y: number, tilt: number) {
  for (let i = 0; i < n; i++) {
    const petal = new THREE.PlaneGeometry(petalW, petalL);
    petal.translate(0, petalL / 2, 0); // root at origin, tip outward
    petal.rotateX(-Math.PI / 2 + tilt); // lay outward (flat), tip up by `tilt`
    petal.translate(0, y, 0);
    petal.rotateY((i / n) * Math.PI * 2 + i * 0.6); // spread + a little jitter
    pushBothWindings(parts, petal);
  }
}

function stemCards(stemH: number, w: number, rot: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 2; i++) {
    const s = new THREE.PlaneGeometry(w, stemH);
    s.translate(0, stemH / 2, 0);
    s.rotateY((i * Math.PI) / 2 + rot);
    pushBothWindings(parts, s);
  }
  return parts;
}

/** 0 poppy — tall stem + a full cupped bloom (two offset rings read round + layered). */
function poppyGeometry(): THREE.BufferGeometry {
  const stemH = 0.5;
  const parts = stemCards(stemH, 0.03, 0.3);
  radialPetals(parts, 7, 0.18, 0.2, stemH + 0.02, 0.5);
  radialPetals(parts, 5, 0.13, 0.15, stemH + 0.07, 0.85); // inner cupped ring
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return finalize(g, stemH, stemH + 0.2);
}

/** 1 lupine — tall spike with a stacked column of florets. */
function lupineGeometry(): THREE.BufferGeometry {
  const stemH = 0.34;
  const parts = stemCards(stemH, 0.028, 0.5);
  const spikeH = 0.42;
  const tiers = 7;
  for (let t = 0; t < tiers; t++) {
    const frac = t / (tiers - 1);
    const r = 0.075 * (1 - frac * 0.7); // taper toward the tip
    const y = stemH + frac * spikeH;
    for (let i = 0; i < 3; i++) {
      const f = new THREE.PlaneGeometry(0.09, 0.07);
      f.rotateX(-0.5);
      f.translate(0, y, r);
      f.rotateY((i * Math.PI * 2) / 3 + t * 0.7);
      pushBothWindings(parts, f);
    }
  }
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return finalize(g, stemH, stemH + spikeH);
}

/** 2 yarrow — short stem + a flat-topped umbel of tiny florets. */
function yarrowGeometry(): THREE.BufferGeometry {
  const stemH = 0.32;
  const parts = stemCards(stemH, 0.03, 0.7);
  const cap = new THREE.PlaneGeometry(0.17, 0.17);
  cap.rotateX(-Math.PI / 2);
  cap.translate(0, stemH + 0.02, 0);
  pushBothWindings(parts, cap);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const d = new THREE.PlaneGeometry(0.055, 0.055);
    d.rotateX(-Math.PI / 2 + 0.15);
    d.translate(Math.cos(a) * 0.055, stemH + 0.05, Math.sin(a) * 0.055);
    pushBothWindings(parts, d);
  }
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return finalize(g, stemH, stemH + 0.07);
}

/** 3 goldfield — low daisy for carpeting drifts: a flat 8-petal star. */
function goldfieldGeometry(): THREE.BufferGeometry {
  const stemH = 0.16;
  const parts = stemCards(stemH, 0.02, 0.9);
  radialPetals(parts, 8, 0.06, 0.08, stemH + 0.005, 0.12);
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return finalize(g, stemH, stemH + 0.05);
}

const BUILDERS = [poppyGeometry, lupineGeometry, yarrowGeometry, goldfieldGeometry];

// ---- material ------------------------------------------------------------------

const STEM_COL = vec3(0.12, 0.22, 0.09);
const FLOWER_FADE_FOCUS = uniform(new THREE.Vector2(1e6, 1e6));
const FLOWER_REACH_U = uniform(80);

let sharedMaterial: THREE.MeshStandardNodeMaterial | null = null;
function flowerMaterial(): THREE.MeshStandardNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0, side: THREE.FrontSide });
  const swayW: N = attribute("aSway", "float");
  const headMask: N = attribute("aHead", "float");
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
  mat.colorNode = mix(STEM_COL, bloomV, headMask);
  // self-lit petals so a drift reads as a colour wash even in dusk shade
  mat.emissiveNode = bloomV.mul(headMask).mul(0.4);

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
