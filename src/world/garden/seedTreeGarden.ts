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
const LOD_OPTS = { lod1Dist: 40, lod2Dist: 90 };

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
type FarSet = { group: THREE.Group; branches: FarBranchBucket[]; cards: FarCardBucket[]; triangles: number };

/** Build the species' static far tier over all slots (grove recipe: bark →
 *  InstancedMesh over slots, card InstancedMeshes → flattened k×N with tiled
 *  per-instance attributes). */
function buildFarSet(lod2: THREE.Object3D, slots: Slot[], name: string): FarSet {
  const group = new THREE.Group();
  group.name = name;
  const N = slots.length;
  const branches: FarBranchBucket[] = [];
  const cards: FarCardBucket[] = [];
  let triangles = 0;
  const slotM = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const card = new THREE.Matrix4();
  lod2.updateMatrixWorld(true);

  lod2.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const geoTris = (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;

    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const src = mesh as THREE.InstancedMesh;
      const k = src.count;
      const total = k * N;
      const geo = src.geometry.clone();
      for (const [attrName, attr] of Object.entries(src.geometry.attributes)) {
        const a = attr as THREE.InstancedBufferAttribute;
        if (!a.isInstancedBufferAttribute) continue;
        const arr = new (a.array.constructor as new (n: number) => typeof a.array)(total * a.itemSize);
        for (let slot = 0; slot < N; slot++) {
          arr.set(a.array.subarray(0, k * a.itemSize), slot * k * a.itemSize);
        }
        geo.setAttribute(attrName, new THREE.InstancedBufferAttribute(arr, a.itemSize));
      }
      // frozen card-transform snapshot (the source mesh belongs to the live template)
      const cardMats = new Float32Array(k * 16);
      for (let j = 0; j < k; j++) {
        src.getMatrixAt(j, card);
        cardMats.set(card.elements, j * 16);
      }
      const im = new THREE.InstancedMesh(geo, src.material, total);
      const bucket: FarCardBucket = { im, k, base: mesh.matrixWorld.clone(), cardMats };
      for (let slot = 0; slot < N; slot++) writeFarCardSlot(bucket, slots[slot], slot, false);
      im.name = `${name}_${mesh.name || "cards"}`;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      group.add(im);
      cards.push(bucket);
      triangles += geoTris * total;
    } else {
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, N);
      const bucket: FarBranchBucket = { im, base: mesh.matrixWorld.clone() };
      for (let slot = 0; slot < N; slot++) {
        slotMatrix(slots[slot], slotM);
        tmp.multiplyMatrices(slotM, bucket.base);
        im.setMatrixAt(slot, tmp);
      }
      im.name = `${name}_${mesh.name || "bark"}`;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      group.add(im);
      branches.push(bucket);
      triangles += geoTris * N;
    }
  });
  return { group, branches, cards, triangles };
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
  // one bad rebin must not take down the render loop — disable and report
  let rebinBroken = false;
  const update = (camera: THREE.Camera) => {
    if (rebinBroken) return;
    try {
      near.update(camera);
    } catch (e) {
      rebinBroken = true;
      console.error("[sfbg] near-tier rebin failed — far tier stays static:", e);
    }
  };

  // Self-drive the rebin off the render loop: far branch meshes are
  // frustumCulled=false, so one of them renders every frame — its
  // onBeforeRender hands us the live camera with zero caller plumbing.
  // Shadow passes invoke it too, with the sun's OrthographicCamera; only the
  // perspective gameplay camera may steer the rebin.
  const anyRuntime = runtimes.find(Boolean);
  const driver = anyRuntime?.farSet.branches[0]?.im ?? anyRuntime?.farSet.cards[0]?.im;
  if (driver) {
    driver.onBeforeRender = (_renderer, _scene, camera) => {
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) update(camera);
    };
  }

  return {
    group,
    update,
    stats: { species: speciesBuilt, instances, farTriangles: Math.round(farTriangles) }
  };
}
