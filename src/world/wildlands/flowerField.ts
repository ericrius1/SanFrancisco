// Wildflower renderer — four species with real silhouettes, planted from the
// noise-banded drifts in layout.ts. Each species is a small crossed-card mesh
// (baked both windings so it reads from every angle on a FrontSide material);
// per-instance bloom tint via instanceColor; heads carry a gentle emissive so a
// superbloom still glows at dusk. Wind sway rides the SHARED windGustGlobal
// envelope (garden/wind.ts) so flowers, grass, and trees breathe together.
//
// Chunked exactly like seedForest: one InstancedMesh per (species, chunk) with a
// real boundingSphere for frustum culling plus a distance cutoff, castShadow
// off (thousands of blooms; shadows would double cost for no read).

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { attribute, float, hash, instanceIndex, mix, positionLocal, sin, time, vec3 } from "three/tsl";
import { windGustGlobal } from "../garden/wind";
import type { WildFlower } from "./layout";

type N = any;

// bloom base palettes (per-instance tint lerps within [a,b] by WildFlower.tint)
const PALETTES: { a: number; b: number; glow: number }[] = [
  { a: 0xff5a1e, b: 0xe23c14, glow: 0xff7a2a }, // 0 poppy — california orange
  { a: 0x6a5cc4, b: 0x8f7ad8, glow: 0x9a86e0 }, // 1 lupine — blue-violet
  { a: 0xf3ead2, b: 0xf7d65a, glow: 0xfff0c0 }, // 2 yarrow — cream→gold
  { a: 0xffc31e, b: 0xffd94a, glow: 0xffe66a } // 3 goldfield — bright gold
];

const STEM = 0x3a5a24;

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

/** Bake the head mask (bloom vs stem) + wind sway weight. Colour comes from the
 *  per-instance `aBloom` (bloom) or a constant stem green in the material — the
 *  bloom is also emissive so it reads as a colour splash in any light. Upright
 *  normals so petals take the open sky. */
function finalize(g: THREE.BufferGeometry, stemH: number, totalH: number): THREE.BufferGeometry {
  const p = g.getAttribute("position");
  const normals = g.getAttribute("normal");
  const head = new Float32Array(p.count);
  const sway = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    head[i] = y > stemH - 0.02 ? 1 : 0;
    normals.setXYZ(i, 0, 1, 0);
    const t = Math.min(1, Math.max(0, y / totalH));
    sway[i] = t * t;
  }
  g.setAttribute("aHead", new THREE.BufferAttribute(head, 1));
  g.setAttribute("aSway", new THREE.BufferAttribute(sway, 1));
  return g;
}

/** A ring of `n` petals radiating from the stem top at height `y`. `tilt` raises
 *  the tips (0 = flat daisy, ~0.6 = cupped poppy). Petals overlap so the outline
 *  reads as a round bloom, not a hard cross. */
function radialPetals(
  parts: THREE.BufferGeometry[],
  n: number,
  petalW: number,
  petalL: number,
  y: number,
  tilt: number
) {
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

/** 0 poppy — tall stem + a full 6-petal cupped bloom (two offset rings read
 *  round + layered, like a real poppy cup). */
function poppyGeometry(): THREE.BufferGeometry {
  const stemH = 0.5;
  const parts = stemCards(stemH, 0.03, 0.3);
  radialPetals(parts, 6, 0.17, 0.19, stemH + 0.02, 0.5);
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
  // flat cap
  const cap = new THREE.PlaneGeometry(0.16, 0.16);
  cap.rotateX(-Math.PI / 2);
  cap.translate(0, stemH + 0.02, 0);
  pushBothWindings(parts, cap);
  // scattered floret dots lifting off the cap for a corymb read
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const d = new THREE.PlaneGeometry(0.05, 0.05);
    d.rotateX(-Math.PI / 2);
    d.translate(Math.cos(a) * 0.05, stemH + 0.05, Math.sin(a) * 0.05);
    pushBothWindings(parts, d);
  }
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return finalize(g, stemH, stemH + 0.07);
}

/** 3 goldfield — low daisy for carpeting drifts: a flat 7-petal star so the
 *  ground reads as a wash of little gold flowers, not scattered dark specks. */
function goldfieldGeometry(): THREE.BufferGeometry {
  const stemH = 0.16;
  const parts = stemCards(stemH, 0.02, 0.9);
  radialPetals(parts, 7, 0.055, 0.075, stemH + 0.005, 0.08);
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return finalize(g, stemH, stemH + 0.05);
}

const BUILDERS = [poppyGeometry, lupineGeometry, yarrowGeometry, goldfieldGeometry];

// ---- material ------------------------------------------------------------------

const STEM_COL = vec3(0.11, 0.2, 0.08);

let sharedMaterial: THREE.MeshStandardNodeMaterial | null = null;
function flowerMaterial(): THREE.MeshStandardNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0, side: THREE.FrontSide });
  const swayW: N = attribute("aSway", "float");
  const headMask: N = attribute("aHead", "float");
  const bloom: N = attribute("aBloom", "vec3"); // per-instance bloom colour
  // stems green, petals their bloom colour — set as the base colour directly
  // (no vertexColors × instanceColor guessing).
  mat.colorNode = mix(STEM_COL, bloom, headMask);
  // SELF-LIT petals: the bloom emits its own colour so a drift reads as a wash of
  // orange/purple/gold even in dusk shade or under grass, instead of dark cards.
  mat.emissiveNode = (bloom as N).mul(headMask).mul(0.5);

  const ph: N = (hash(instanceIndex) as N).mul(6.283);
  // shared gust envelope drives amplitude — flowers gust with the grass/trees
  const g: N = (windGustGlobal as N).mul(0.9).add(0.35);
  const bend: N = (sin(time.mul(1.1).add(ph)) as N).mul(0.6).add((sin(time.mul(2.4).add(ph.mul(1.7))) as N).mul(0.4));
  const cross: N = sin(time.mul(0.8).add(ph.mul(1.3)));
  const amp = 0.06;
  mat.positionNode = (positionLocal as N).add(vec3(bend.mul(amp), float(0), cross.mul(amp * 0.7)).mul(swayW).mul(g));
  mat.envMapIntensity = 0.5;
  sharedMaterial = mat;
  return mat;
}

// ---- chunked field -------------------------------------------------------------

const CHUNK = 176;
const VIS_DIST = 340; // flowers are small — cull tighter than trees

export type FlowerField = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  stats: { flowers: number; chunks: number; draws: number };
};

export function createFlowerField(flowers: readonly WildFlower[]): FlowerField {
  const group = new THREE.Group();
  group.name = "wildlands_flowers";
  const material = flowerMaterial();
  const geoms = BUILDERS.map((b) => b());

  // bucket by chunk, then species
  const byChunk = new Map<string, WildFlower[]>();
  for (const f of flowers) {
    const key = `${Math.floor(f.x / CHUNK)},${Math.floor(f.z / CHUNK)}`;
    const list = byChunk.get(key);
    if (list) list.push(f);
    else byChunk.set(key, [f]);
  }

  const chunks: { group: THREE.Group; cx: number; cz: number }[] = [];
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const a = new THREE.Color();
  const bcol = new THREE.Color();
  let draws = 0;

  for (const [key, list] of byChunk) {
    const cGroup = new THREE.Group();
    cGroup.name = `wildlands_flowers_${key}`;
    const bySpecies: WildFlower[][] = geoms.map(() => []);
    for (const f of list) bySpecies[f.species]?.push(f);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const f of list) {
      if (f.x < minX) minX = f.x;
      if (f.x > maxX) maxX = f.x;
      if (f.z < minZ) minZ = f.z;
      if (f.z > maxZ) maxZ = f.z;
      if (f.y < minY) minY = f.y;
      if (f.y > maxY) maxY = f.y;
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const sphere = new THREE.Sphere(
      new THREE.Vector3(cx, (minY + maxY) / 2 + 0.5, cz),
      Math.hypot(maxX - minX, maxY - minY + 1, maxZ - minZ) / 2 + 1
    );

    bySpecies.forEach((fs, species) => {
      if (fs.length === 0) return;
      const mesh = new THREE.InstancedMesh(geoms[species], material, fs.length);
      mesh.name = `wildlands_flowers_${key}_sp${species}`;
      const pal = PALETTES[species];
      a.setHex(pal.a);
      bcol.setHex(pal.b);
      fs.forEach((f, i) => {
        dummy.position.set(f.x, f.y, f.z);
        dummy.rotation.set(0, f.yaw, 0);
        dummy.scale.set(f.scale, f.scale * (0.85 + f.tint * 0.3), f.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.copy(a).lerp(bcol, f.tint);
        mesh.setColorAt(i, color);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.boundingSphere = sphere.clone();
      mesh.frustumCulled = true;
      cGroup.add(mesh);
      draws++;
    });

    chunks.push({ group: cGroup, cx, cz });
    group.add(cGroup);
  }

  const lastFocus = { x: 1e9, z: 1e9 };
  function cull(x: number, z: number, force = false) {
    if (!force && Math.hypot(x - lastFocus.x, z - lastFocus.z) < 20) return;
    lastFocus.x = x;
    lastFocus.z = z;
    for (const c of chunks) c.group.visible = Math.hypot(c.cx - x, c.cz - z) < VIS_DIST;
  }
  cull(0, 0, true);

  return {
    group,
    update(focus) {
      cull(focus.x, focus.z);
    },
    stats: { flowers: flowers.length, chunks: chunks.length, draws }
  };
}
