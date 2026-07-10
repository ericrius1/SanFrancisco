// SeedThree-powered garden trees with per-instance LOD, following the app's own
// grove design (vendor/SeedThree/src/main.js updateForest/rebinForest) adapted
// to a 600-tree garden:
//
//  · FAR TIER — every slot of a species is one static instanced set of the
//    grown tree's LOD2 meshes (bark tube InstancedMesh + flattened k×N card
//    InstancedMeshes with tiled per-instance attributes). Built once; the only
//    later writes are zero/restore of single slots as they enter/leave the
//    near tier (partial buffer uploads via addUpdateRange).
//  · NEAR TIER — the closest slots (≤ NEAR_MAX within NEAR_RADIUS of the
//    camera) are real THREE.LOD clones of the hero tree (geometry + materials
//    shared with the template), so up close you get LOD0/LOD1 with the app's
//    real leaf/bark materials and distance switching for free. Their far-tier
//    instance is zero-scaled while the clone exists.
//
// WIND IS ON (SeedThree default strength). Why this works without the app's
// forest twin materials:
//  · near clones are plain object hierarchies — barkWindPosition/
//    foliageWindPosition read modelWorldMatrix per clone, so phase and
//    amplitude are correct; the heading rotates with each tree's yaw, which
//    reads as natural per-tree variance rather than error.
//  · far instances share the hero materials: card aWindVec/aAnchorPos are the
//    hero-baked values tiled per slot, so bark and cards stay mutually
//    consistent within every tree (no leaf detachment); all instances of a
//    species share one phase field, invisible at LOD2 distances.
//
// Textures served from public/seedthree (copied per-species from
// vendor/SeedThree/assets — both gitignored).

import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { createTree } from "../../../vendor/SeedThree/src/api/seedthree.js";
import { type GardenTree } from "./layout";
import { applyGrassTuning } from "./grassTuning";

// garden species id → SeedThree design. tree_fern (id 3) has no SeedThree
// analog and keeps the in-repo procedural mesh; its entry here is null.
export type SeedTreeDesign = {
  species: string;
  seed: number;
  controls?: Record<string, unknown>;
  /** sink the trunk base this far (× slot scale) into the ground */
  sink: number;
  /** false → never promote to a hero clone (stays instanced at every range).
   *  Rosette species: their CAP-preallocated instanced buffers make a deep
   *  THREE.LOD clone take SECONDS (measured 16s for joshuaTree), and their
   *  far-tier rosettes are real geometry anyway. */
  nearClones?: boolean;
} | null;

export const SEED_TREE_DESIGNS: SeedTreeDesign[] = [
  // 0 coast redwood → tall douglas fir, densified toward a redwood-grove read
  {
    species: "douglasFir",
    seed: 11,
    controls: { height: 27, branchDensity: 34, leavesPerBranch: 22, leafColorize: 0x496835, leafTintAmount: 0.42 },
    sink: 0.25
  },
  // 1 magnolia → tulip poplar; keep the crown leafy instead of pale/blossom-white
  { species: "tulipPoplar", seed: 22, controls: { height: 9, leafColorize: 0x66783f, leafTintAmount: 0.58 }, sink: 0.2 },
  // 2 monterey cypress → gnarly ponderosa pine, fuller canopy
  { species: "pine", seed: 33, controls: { height: 12, branchDensity: 30, leavesPerBranch: 20, leafColorize: 0x3f5f34, leafTintAmount: 0.45 }, sink: 0.25 },
  // 3 tree fern → keep procedural (no SeedThree analog)
  null,
  // 4 coast live oak → white oak
  { species: "whiteOak", seed: 44, controls: { height: 12, leafColorize: 0x4c6735, leafTintAmount: 0.52 }, sink: 0.25 },
  // 5 japanese maple → red maple
  { species: "redMaple", seed: 55, controls: { height: 7, leafColorize: 0x744a38, leafTintAmount: 0.42 }, sink: 0.2 },
  // 6 eucalyptus → tall pale american beech
  { species: "americanBeech", seed: 66, controls: { height: 17, leafColorize: 0x5a6b3d, leafTintAmount: 0.5 }, sink: 0.25 },
  // 7 chilean palm → joshua tree (closest rosette-crowned form)
  { species: "joshuaTree", seed: 77, controls: { trunkHeight: 3.4, armLength: 1.15 }, sink: 0.2, nearClones: false }
];

// Hero-clone LOD switch distances (passed to buildTree so every level exists
// with these thresholds baked into the returned THREE.LOD).
//
// LOD2 DIET: in this garden LOD2 is exclusively the far-tier instancing source
// — near clones are demoted back to instances at NEAR_EXIT_RADIUS (66 m), well
// inside lod2Dist (90 m), so no clone ever DISPLAYS LOD2. That means its
// budget can sit far below SeedThree's 15% default with zero near-view change:
//  · lod2Pct 4    → the branch budget solver drives bark tubes to their
//                   3-sided / ring-stride floor (~6.2k → ~2k tris per oak).
//  · lod2Prune .55 → more of the thinnest twig tubes (and their cluster
//                   cards) drop; the top-20% crown band is never pruned, so
//                   the silhouette holds at ≥58 m.
//  · lod2Density .8 → rosette species only (joshua): thins far rosette rings.
// The near view (LOD0 <40 m, LOD1 40–90 m) is untouched.
const LOD_OPTS = { lod1Dist: 40, lod2Dist: 90, lod2Pct: 4, lod2Prune: 0.55, lod2Density: 0.8 };

// Far-tier cluster-card subsample: keep this fraction of each tree's foliage
// cards in the instanced far tier, growing the survivors by 1/√keep so the
// canopy holds its visual mass (SpeedTree's "fewer and bigger"). Cards are
// base-anchored quads, so scaling the geometry grows each spray in place
// around its twig anchor. Applies to the flat cluster-card foliage only —
// joshua rosette cones are real geometry and keep every instance.
const FAR_CARD_KEEP = 0.57;
const FAR_CARD_GROW = 1 / Math.sqrt(FAR_CARD_KEEP);

// Joshua rosette cones are real geometry (no growth compensation — growing a
// cone reads as a fatter spike, not a denser rosette); a mild subsample only.
const FAR_CONE_KEEP = 0.72;

// Far bark importance decimation: the LOD2 tube mesh is already at SeedThree's
// 3-sided / ring-stride floor, so its remaining cost is RING COUNT — hundreds
// of thin twig tubes that are sub-pixel behind the foliage cards at ≥58 m.
// Sort the indexed triangles by area (tube radius × ring spacing) and keep the
// largest FAR_BARK_KEEP fraction, but never cut below FAR_BARK_AREA_FLOOR of
// the total surface area — trunk and limb tubes always survive intact.
const FAR_BARK_KEEP = 0.4;
const FAR_BARK_AREA_FLOOR = 0.88;

const _dA = new THREE.Vector3();
const _dB = new THREE.Vector3();
const _dC = new THREE.Vector3();

/** Returns a clone of `geo` whose index keeps only the biggest triangles (see
 *  FAR_BARK_KEEP). Non-indexed geometry is returned as a plain clone. */
function decimateBarkByArea(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = geo.clone();
  const index = out.index;
  const pos = out.attributes.position as THREE.BufferAttribute;
  if (!index || !pos) return out;
  const triCount = index.count / 3;
  const areas = new Float32Array(triCount);
  let totalArea = 0;
  for (let t = 0; t < triCount; t++) {
    _dA.fromBufferAttribute(pos, index.getX(t * 3));
    _dB.fromBufferAttribute(pos, index.getX(t * 3 + 1));
    _dC.fromBufferAttribute(pos, index.getX(t * 3 + 2));
    _dB.sub(_dA);
    _dC.sub(_dA);
    const area = _dB.cross(_dC).length() * 0.5;
    areas[t] = area;
    totalArea += area;
  }
  const order = Array.from({ length: triCount }, (_, t) => t).sort((a, b) => areas[b] - areas[a]);
  const minKeep = Math.ceil(triCount * FAR_BARK_KEEP);
  const areaTarget = totalArea * FAR_BARK_AREA_FLOOR;
  let kept = 0;
  let areaKept = 0;
  while (kept < triCount && (kept < minKeep || areaKept < areaTarget)) {
    areaKept += areas[order[kept]];
    kept++;
  }
  if (kept >= triCount) return out;
  const src = index.array;
  const arr = new (src.constructor as new (n: number) => typeof src)(kept * 3);
  for (let j = 0; j < kept; j++) {
    const t = order[j] * 3;
    arr[j * 3] = src[t];
    arr[j * 3 + 1] = src[t + 1];
    arr[j * 3 + 2] = src[t + 2];
  }
  out.setIndex(new THREE.BufferAttribute(arr, 1));
  return out;
}

// Near-tier budget: how many full-quality hero clones may exist at once, and
// how far out a slot qualifies. Slight exit hysteresis stops boundary flicker.
const NEAR_RADIUS = 58;
const NEAR_EXIT_RADIUS = 66;
const NEAR_MAX = 24;
// Rebin throttle, camera movement gate (m²) — same shape as the app's rebin.
const REBIN_MS = 250;
const REBIN_MOVE_SQ = 4;

const ZERO_SCALE = 1e-6; // far-slot "hidden" scale (0 breaks normal matrices)
const FOLIAGE_MESH_RE = /leaf|foliage|card|cluster|rosette|frond/i;
const FAR_CARD_TINT = new THREE.Color(0x4e623a);

type ShadeableFoliageMaterial = THREE.Material & {
  color?: THREE.Color;
  roughness?: number;
  metalness?: number;
  thicknessColorNode?: { mul?: (v: number) => unknown };
  thicknessDistortionNode?: unknown;
  thicknessAmbientNode?: unknown;
  thicknessPowerNode?: unknown;
  thicknessScaleNode?: unknown;
};

function shadeSeedTreeFoliage(root: THREE.Object3D) {
  const seen = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const foliageLike =
      FOLIAGE_MESH_RE.test(mesh.name) ||
      materials.some((material) => {
        const m = material as ShadeableFoliageMaterial;
        return FOLIAGE_MESH_RE.test(m.name) || Boolean(m.thicknessColorNode || m.userData?.gltfDiffuseTransmission);
      });
    if (!foliageLike) return;
    for (const raw of materials) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      const material = raw as ShadeableFoliageMaterial;

      if (material.color?.isColor) {
        material.color.multiplyScalar(0.5).lerp(FAR_CARD_TINT, 0.45);
      }
      if (typeof material.roughness === "number") material.roughness = Math.max(material.roughness, 0.96);
      if (typeof material.metalness === "number") material.metalness = 0;
      if (material.thicknessColorNode?.mul) {
        material.thicknessColorNode = material.thicknessColorNode.mul(0.3) as ShadeableFoliageMaterial["thicknessColorNode"];
      }
      if ("thicknessDistortionNode" in material) material.thicknessDistortionNode = uniform(0.18);
      if ("thicknessAmbientNode" in material) material.thicknessAmbientNode = uniform(0.025);
      if ("thicknessPowerNode" in material) material.thicknessPowerNode = uniform(8.5);
      if ("thicknessScaleNode" in material) material.thicknessScaleNode = uniform(0.75);
      material.needsUpdate = true;
    }
  });
}

const textureLoader = new THREE.TextureLoader();
async function loadTexture(path: string, { srgb }: { srgb: boolean }): Promise<THREE.Texture | null> {
  try {
    const t = await textureLoader.loadAsync(`/${path}`);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  } catch {
    return null; // optional maps 404 → material factories handle it
  }
}

type Slot = {
  species: number;
  index: number; // index within the species' slot list
  x: number;
  y: number; // trunk-base y (sink applied)
  z: number;
  yaw: number;
  scale: number;
  nearClone: boolean;
};

function slotMatrix(s: Slot, out: THREE.Matrix4, scale = s.scale): THREE.Matrix4 {
  const pos = new THREE.Vector3(s.x, s.y, s.z);
  const quat = new THREE.Quaternion().setFromAxisAngle(UP, s.yaw);
  return out.compose(pos, quat, new THREE.Vector3(scale, scale, scale));
}

const UP = new THREE.Vector3(0, 1, 0);

// ---- far tier: static instanced LOD2 ---------------------------------------

type FarBranchBucket = { im: THREE.InstancedMesh; base: THREE.Matrix4 };
type FarCardBucket = { im: THREE.InstancedMesh; k: number; base: THREE.Matrix4; cardMats: Float32Array };
// `group` is a WebGPU render bundle: a species' handful of bark/card instanced
// draws collapse to one cached command buffer, so the far tier stops paying
// per-draw encode. It is structurally static (slot hide/show writes instanceMatrix
// buffers, which flow through the bundle via the per-render refresh — no re-record).
// `sphere` is the species' world bounding sphere: the children are frustumCulled=false
// (a bundle records them once), so per-species frustum culling — the win the old
// per-mesh frustumCulled bought — is preserved by testing this sphere each frame and
// toggling group.visible (see cullFarSets); an invisible group is skipped whole.
type FarSet = { group: THREE.BundleGroup; branches: FarBranchBucket[]; cards: FarCardBucket[]; triangles: number; sphere: THREE.Sphere };

/** Deterministic, spatially-uniform card subset: golden-ratio stepping keeps
 *  every region of the canopy represented at any keep fraction. */
function pickCardSubset(k: number, keep: number): number[] {
  const pick: number[] = [];
  for (let j = 0; j < k; j++) {
    if (((j * 0.6180339887498949) % 1) < keep) pick.push(j);
  }
  return pick.length > 0 ? pick : [0];
}

/** Build the species' static far tier over all slots (grove recipe: bark →
 *  InstancedMesh over slots, card InstancedMeshes → flattened k×N with tiled
 *  per-instance attributes). The set is one render bundle (see FarSet); its
 *  children draw unconditionally, so a whole species zone stops rendering when
 *  the camera faces away via the group-level cull (cullFarSets) against the
 *  species bounding sphere over its slots (+canopy headroom) built here — the
 *  old un-culled far tier drew all ~4M far triangles from every angle. */
function buildFarSet(lod2: THREE.Object3D, slots: Slot[], name: string): FarSet {
  const group = new THREE.BundleGroup();
  group.name = name;
  const N = slots.length;
  const branches: FarBranchBucket[] = [];
  const cards: FarCardBucket[] = [];
  let triangles = 0;
  const slotM = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const card = new THREE.Matrix4();
  lod2.updateMatrixWorld(true);

  // Species bounding sphere over slot extents, with generous canopy headroom —
  // a too-big sphere only costs cull efficiency, never correctness.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of slots) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y + 40 * s.scale > maxY) maxY = s.y + 40 * s.scale;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }
  const sphere = new THREE.Sphere(
    new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 12
  );

  lod2.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;

    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const src = mesh as THREE.InstancedMesh;
      const k = src.count;
      // Cluster-card foliage gets subsampled + grown (see FAR_CARD_KEEP);
      // rosette cones get a mild subsample with no growth (FAR_CONE_KEEP);
      // any other instanced geometry keeps every instance.
      const isCards = mesh.name === "foliage";
      const isCone = /^cone\d+$/.test(mesh.name);
      const keep = isCards ? FAR_CARD_KEEP : isCone ? FAR_CONE_KEEP : 1;
      const pick = keep < 1 ? pickCardSubset(k, keep) : null;
      const kSub = pick ? pick.length : k;
      const total = kSub * N;
      const geo = src.geometry.clone();
      if (isCards && pick && FAR_CARD_GROW !== 1) geo.scale(FAR_CARD_GROW, FAR_CARD_GROW, FAR_CARD_GROW);
      for (const [attrName, attr] of Object.entries(src.geometry.attributes)) {
        const a = attr as THREE.InstancedBufferAttribute;
        if (!a.isInstancedBufferAttribute) continue;
        const one = new (a.array.constructor as new (n: number) => typeof a.array)(kSub * a.itemSize);
        for (let j = 0; j < kSub; j++) {
          const s = (pick ? pick[j] : j) * a.itemSize;
          for (let c = 0; c < a.itemSize; c++) one[j * a.itemSize + c] = a.array[s + c];
        }
        const arr = new (a.array.constructor as new (n: number) => typeof a.array)(total * a.itemSize);
        for (let slot = 0; slot < N; slot++) arr.set(one, slot * kSub * a.itemSize);
        geo.setAttribute(attrName, new THREE.InstancedBufferAttribute(arr, a.itemSize));
      }
      // frozen card-transform snapshot (the source mesh belongs to the live template)
      const cardMats = new Float32Array(kSub * 16);
      for (let j = 0; j < kSub; j++) {
        src.getMatrixAt(pick ? pick[j] : j, card);
        cardMats.set(card.elements, j * 16);
      }
      const im = new THREE.InstancedMesh(geo, src.material, total);
      const bucket: FarCardBucket = { im, k: kSub, base: mesh.matrixWorld.clone(), cardMats };
      for (let slot = 0; slot < N; slot++) writeFarCardSlot(bucket, slots[slot], slot, false);
      im.name = `${name}_${mesh.name || "cards"}`;
      // far tier never casts: at 66m+ a 2048-map cascade resolves no card shadow,
      // but 240 instanced draws x 3 cascades of encode was the meadow CPU bill.
      // Near hero clones still cast.
      im.castShadow = false;
      im.receiveShadow = true;
      geo.boundingSphere = sphere.clone();
      im.boundingSphere = sphere.clone();
      im.frustumCulled = false; // bundle child: culled at the group level (cullFarSets)
      group.add(im);
      cards.push(bucket);
      const geoTris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      triangles += geoTris * total;
    } else {
      // decimated clone (see decimateBarkByArea) so the far set carries its own
      // slimmed index + world-space bounding sphere without touching the
      // template geometry the near clones share
      const geo = decimateBarkByArea(mesh.geometry);
      geo.boundingSphere = sphere.clone();
      const im = new THREE.InstancedMesh(geo, mesh.material, N);
      const bucket: FarBranchBucket = { im, base: mesh.matrixWorld.clone() };
      for (let slot = 0; slot < N; slot++) {
        slotMatrix(slots[slot], slotM);
        tmp.multiplyMatrices(slotM, bucket.base);
        im.setMatrixAt(slot, tmp);
      }
      im.name = `${name}_${mesh.name || "bark"}`;
      im.castShadow = false; // far tier never casts (see cards note above)
      im.receiveShadow = true;
      im.boundingSphere = sphere.clone();
      im.frustumCulled = false; // bundle child: culled at the group level (cullFarSets)
      group.add(im);
      branches.push(bucket);
      const geoTris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      triangles += geoTris * N;
    }
  });
  return { group, branches, cards, triangles, sphere };
}

const _wSlot = new THREE.Matrix4();
const _wTmp = new THREE.Matrix4();
const _wCard = new THREE.Matrix4();

function writeFarCardSlot(bucket: FarCardBucket, slot: Slot, index: number, hidden: boolean) {
  slotMatrix(slot, _wSlot, hidden ? ZERO_SCALE : slot.scale);
  _wTmp.multiplyMatrices(_wSlot, bucket.base);
  for (let j = 0; j < bucket.k; j++) {
    _wCard.fromArray(bucket.cardMats, j * 16);
    _wCard.premultiply(_wTmp);
    bucket.im.setMatrixAt(index * bucket.k + j, _wCard);
  }
}

/** Hide/show one slot in every far bucket of its species (partial upload). */
function setFarSlotHidden(farSet: FarSet, slot: Slot, hidden: boolean) {
  for (const b of farSet.branches) {
    slotMatrix(slot, _wSlot, hidden ? ZERO_SCALE : slot.scale);
    _wTmp.multiplyMatrices(_wSlot, b.base);
    b.im.setMatrixAt(slot.index, _wTmp);
    b.im.instanceMatrix.addUpdateRange(slot.index * 16, 16);
    b.im.instanceMatrix.needsUpdate = true;
  }
  for (const b of farSet.cards) {
    writeFarCardSlot(b, slot, slot.index, hidden);
    b.im.instanceMatrix.addUpdateRange(slot.index * b.k * 16, b.k * 16);
    b.im.instanceMatrix.needsUpdate = true;
  }
}

// ---- near tier: hero THREE.LOD clones ---------------------------------------

type SpeciesRuntime = {
  template: THREE.LOD;
  farSet: FarSet;
  slots: Slot[];
  pool: THREE.LOD[];
  nearClones: boolean;
};

function prepareTemplate(lodGroup: THREE.Object3D): THREE.LOD {
  const lod = lodGroup as THREE.LOD;
  // headless growth has no baked billboard, but filter defensively; also drop
  // app-only preview levels if any slipped through
  if (lod.levels) {
    for (let i = lod.levels.length - 1; i >= 0; i--) {
      const o = lod.levels[i].object;
      if (o.userData?.isBillboard || o.userData?.appOnly) lod.levels.splice(i, 1);
    }
  }
  lod.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return lod;
}

class NearTierManager {
  /** indexed by species id — entries for unmapped species are undefined */
  #runtimes: (SpeciesRuntime | undefined)[];
  #group: THREE.Group;
  #active = new Map<string, { slot: Slot; clone: THREE.LOD }>();
  #lastPos = new THREE.Vector3(1e9, 0, 0);
  #lastTime = 0;

  constructor(runtimes: (SpeciesRuntime | undefined)[], group: THREE.Group) {
    this.#runtimes = runtimes;
    this.#group = group;
  }

  update(camera: THREE.Camera, force = false) {
    const now = performance.now();
    const camPos = (camera as THREE.PerspectiveCamera).position;
    if (!force && (now - this.#lastTime < REBIN_MS || camPos.distanceToSquared(this.#lastPos) < REBIN_MOVE_SQ)) return;
    this.#lastTime = now;
    this.#lastPos.copy(camPos);

    // candidates within the near radius, closest first, capped
    const cand: { slot: Slot; d2: number; key: string }[] = [];
    const enterSq = NEAR_RADIUS * NEAR_RADIUS;
    const exitSq = NEAR_EXIT_RADIUS * NEAR_EXIT_RADIUS;
    for (const rt of this.#runtimes) {
      if (!rt || !rt.nearClones) continue;
      for (const slot of rt.slots) {
        const dx = slot.x - camPos.x;
        const dz = slot.z - camPos.z;
        const d2 = dx * dx + dz * dz;
        const key = `${slot.species}:${slot.index}`;
        const held = this.#active.has(key);
        if (slot.nearClone && d2 < (held ? exitSq : enterSq)) cand.push({ slot, d2, key });
      }
    }
    cand.sort((a, b) => a.d2 - b.d2);
    const next = new Set<string>();
    for (let i = 0; i < Math.min(cand.length, NEAR_MAX); i++) next.add(cand[i].key);

    // demote clones that fell out
    for (const [key, entry] of this.#active) {
      if (next.has(key)) continue;
      const rt = this.#runtimes[entry.slot.species]!;
      this.#group.remove(entry.clone);
      rt.pool.push(entry.clone);
      setFarSlotHidden(rt.farSet, entry.slot, false);
      this.#active.delete(key);
    }
    // promote new near slots
    for (const c of cand) {
      if (!next.has(c.key) || this.#active.has(c.key)) continue;
      const rt = this.#runtimes[c.slot.species]!;
      const clone = rt.pool.pop() ?? (rt.template.clone() as THREE.LOD);
      clone.position.set(c.slot.x, c.slot.y, c.slot.z);
      clone.quaternion.setFromAxisAngle(UP, c.slot.yaw);
      clone.scale.setScalar(c.slot.scale);
      this.#group.add(clone);
      setFarSlotHidden(rt.farSet, c.slot, true);
      this.#active.set(c.key, { slot: c.slot, clone });
    }
  }

  get activeCount() {
    return this.#active.size;
  }
}

// ---- public API --------------------------------------------------------------

export type SeedTreeGardenResult = {
  group: THREE.Group;
  /** call once per frame with the render camera — drives the near/far rebin */
  update: (camera: THREE.Camera) => void;
  stats: { species: number; instances: number; farTriangles: number };
};

/**
 * Grow one textured SeedThree hero per mapped species, build its static
 * instanced far tier over the deterministic slots, and start the near-tier
 * clone manager. Entries with a null design (tree fern) are procedural.
 */
export async function buildSeedTreeGarden(trees: GardenTree[]): Promise<SeedTreeGardenResult> {
  // Wind uniforms (shared by trees + grass) come from the persisted grass
  // tuning group — one source, so the debug sliders and reloads agree.
  applyGrassTuning();

  const bySpecies: GardenTree[][] = SEED_TREE_DESIGNS.map(() => []);
  for (const t of trees) {
    if (SEED_TREE_DESIGNS[t.species]) bySpecies[t.species]?.push(t);
  }

  const group = new THREE.Group();
  group.name = "sfbg_seedthree_trees";
  const runtimes: SpeciesRuntime[] = [];
  let instances = 0;
  let farTriangles = 0;
  let speciesBuilt = 0;

  // grow sequentially — each createTree is CPU-heavy; parallel just thrashes
  for (let id = 0; id < SEED_TREE_DESIGNS.length; id++) {
    const design = SEED_TREE_DESIGNS[id];
    const list = bySpecies[id];
    if (!design || list.length === 0) {
      runtimes.push(undefined as unknown as SpeciesRuntime); // keep index = species id
      continue;
    }
    const { group: lodGroup } = await createTree({
      species: design.species,
      seed: design.seed,
      controls: design.controls ?? {},
      lod: LOD_OPTS,
      loadTexture,
      assetsDir: "seedthree"
    });
    const template = prepareTemplate(lodGroup);
    shadeSeedTreeFoliage(template);
    const lod2 =
      template.levels?.find((l) => l.object.userData?.lodName === "LOD2")?.object ??
      template.levels?.[template.levels.length - 1]?.object ??
      template;

    const slots: Slot[] = list.map((t, i) => ({
      species: id,
      index: i,
      x: t.x,
      y: t.y - design.sink * t.scale,
      z: t.z,
      yaw: t.yaw,
      scale: t.scale,
      nearClone: t.nearClone !== false
    }));
    const farSet = buildFarSet(lod2, slots, `sfbg_far_${design.species}`);
    group.add(farSet.group);
    runtimes[id] = { template, farSet, slots, pool: [], nearClones: design.nearClones !== false };
    instances += slots.length;
    farTriangles += farSet.triangles;
    speciesBuilt++;
  }

  const near = new NearTierManager(runtimes, group);
  // Per-species far-tier frustum cull. The far meshes are bundle children
  // (frustumCulled=false), so the renderer no longer culls them per mesh — cull
  // the whole species bundle here against its world bounding sphere and toggle
  // group.visible (an invisible group is skipped before the bundle records/replays).
  // This keeps the exact culling the old per-mesh frustumCulled bought while the
  // draws collapse to one cached command buffer. Runs every frame (camera turns
  // faster than the rebin throttle); onBeforeRender applies it a frame later,
  // same 1-frame lag the existing rebin already lives with.
  const _cullFrustum = new THREE.Frustum();
  const _cullMat = new THREE.Matrix4();
  const cullFarSets = (camera: THREE.Camera) => {
    _cullMat.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse
    );
    _cullFrustum.setFromProjectionMatrix(_cullMat);
    for (const rt of runtimes) {
      if (!rt) continue;
      rt.farSet.group.visible = _cullFrustum.intersectsSphere(rt.farSet.sphere);
    }
  };
  // one bad rebin must not take down the render loop — disable and report
  let rebinBroken = false;
  const update = (camera: THREE.Camera) => {
    cullFarSets(camera);
    if (rebinBroken) return;
    try {
      near.update(camera);
    } catch (e) {
      rebinBroken = true;
      console.error("[sfbg] near-tier rebin failed — far tier stays static:", e);
    }
  };

  // Self-drive the rebin off the render loop. The far meshes are now
  // frustum-culled (species bounding spheres), so none of them is guaranteed
  // to render every frame — park a tiny always-rendered driver quad instead
  // (colorWrite off, far underground; same recipe as seedForest). Its
  // onBeforeRender hands us the live camera with zero caller plumbing.
  // Shadow passes invoke it too, with the sun's OrthographicCamera; only the
  // perspective gameplay camera may steer the rebin.
  const driver = new THREE.Mesh(
    new THREE.PlaneGeometry(0.01, 0.01),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
  );
  driver.name = "sfbg_seedthree_rebin_driver";
  driver.position.set(0, -4000, 0);
  driver.frustumCulled = false;
  driver.onBeforeRender = (_renderer, _scene, camera) => {
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) update(camera);
  };
  group.add(driver);

  return {
    group,
    update,
    stats: { species: speciesBuilt, instances, farTriangles: Math.round(farTriangles) }
  };
}
