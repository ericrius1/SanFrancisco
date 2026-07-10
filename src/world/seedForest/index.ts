// SeedForest — chunked SeedThree tree renderer for large regions.
//
// The botanical garden proved the two-tier recipe (instanced LOD2 far sets +
// a small pool of real THREE.LOD hero clones near the camera). That version is
// ONE static patch with frustumCulled=false — fine for a 620×520 m garden,
// fatal across Marin. This engine keeps the exact same far-set math but:
//
//  · slots are grouped into CHUNKS (~176 m): one instanced far set per chunk,
//    with a real per-mesh boundingSphere so regular frustum culling works,
//    plus a distance cutoff so a hillside grove 2 km away costs nothing.
//  · far tier casts NO shadows by default (shadows are this app's #1 GPU cost;
//    the few near hero clones still cast, which is what your eye checks).
//  · the near-tier rebin self-drives off a tiny always-rendered driver mesh
//    (the garden drove off a frustumCulled=false far mesh; chunked meshes can
//    all be culled while near clones must still manage themselves).
//
// Consumers hand in designs + slot lists; the engine owns rendering + LOD.

import * as THREE from "three/webgpu";
import { growTemplate, type GrownTemplate, type SeedTreeDesignSpec } from "./templates";

export type { SeedTreeDesignSpec } from "./templates";

export type SeedForestSlot = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** index into the designs array passed to createSeedForest */
  design: number;
};

export type SeedForestOptions = {
  name: string;
  /** far-set chunk edge, metres (default 176) */
  chunkSize?: number;
  /** chunks beyond this distance from the camera are hidden entirely (default 520) */
  visibleDistance?: number;
  /** far tier shadow casting (default false — near clones always cast) */
  farCastShadow?: boolean;
  nearRadius?: number; // default 58
  nearExitRadius?: number; // default 66
  nearMax?: number; // default 24
};

export type SeedForest = {
  group: THREE.Group;
  /** Resolves after every design and far-tier chunk has been added to `group`. */
  ready: Promise<void>;
  /** call once per frame with the view position — drives chunk distance culling */
  update(focus: { x: number; z: number }): void;
  stats: { designs: number; instances: number; chunks: number; farTriangles: number; nearActive(): number };
};

const REBIN_MS = 250;
const REBIN_MOVE_SQ = 4;
const ZERO_SCALE = 1e-6; // hidden far slot (0 breaks normal matrices)
const UP = new THREE.Vector3(0, 1, 0);

type Slot = SeedForestSlot & { index: number; chunk: string };

function slotMatrix(s: Slot, out: THREE.Matrix4, scale: number): THREE.Matrix4 {
  return out.compose(
    new THREE.Vector3(s.x, s.y, s.z),
    new THREE.Quaternion().setFromAxisAngle(UP, s.yaw),
    new THREE.Vector3(scale, scale, scale)
  );
}

// ---- far tier: static instanced LOD2, per chunk (garden's grove recipe) -------

type FarBranchBucket = { im: THREE.InstancedMesh; base: THREE.Matrix4 };
type FarCardBucket = { im: THREE.InstancedMesh; k: number; base: THREE.Matrix4; cardMats: Float32Array };
type FarSet = { branches: FarBranchBucket[]; cards: FarCardBucket[]; triangles: number };

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

function buildFarSet(
  lod2: THREE.Object3D,
  slots: Slot[],
  name: string,
  castShadow: boolean,
  sphere: THREE.Sphere,
  parent: THREE.Group
): FarSet {
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
      const cardMats = new Float32Array(k * 16);
      for (let j = 0; j < k; j++) {
        src.getMatrixAt(j, card);
        cardMats.set(card.elements, j * 16);
      }
      const im = new THREE.InstancedMesh(geo, src.material, total);
      const bucket: FarCardBucket = { im, k, base: mesh.matrixWorld.clone(), cardMats };
      for (let slot = 0; slot < N; slot++) writeFarCardSlot(bucket, slots[slot], slot, false);
      im.name = `${name}_${mesh.name || "cards"}`;
      im.castShadow = castShadow;
      im.receiveShadow = true;
      im.boundingSphere = sphere.clone(); // per-chunk sphere → real frustum culling
      im.frustumCulled = true;
      parent.add(im);
      cards.push(bucket);
      triangles += geoTris * total;
    } else {
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, N);
      const bucket: FarBranchBucket = { im, base: mesh.matrixWorld.clone() };
      for (let slot = 0; slot < N; slot++) {
        slotMatrix(slots[slot], slotM, slots[slot].scale);
        tmp.multiplyMatrices(slotM, bucket.base);
        im.setMatrixAt(slot, tmp);
      }
      im.name = `${name}_${mesh.name || "bark"}`;
      im.castShadow = castShadow;
      im.receiveShadow = true;
      im.boundingSphere = sphere.clone();
      im.frustumCulled = true;
      parent.add(im);
      branches.push(bucket);
      triangles += geoTris * N;
    }
  });
  return { branches, cards, triangles };
}

function setFarSlotHidden(farSet: FarSet, slot: Slot, indexInChunk: number, hidden: boolean) {
  for (const b of farSet.branches) {
    slotMatrix(slot, _wSlot, hidden ? ZERO_SCALE : slot.scale);
    _wTmp.multiplyMatrices(_wSlot, b.base);
    b.im.setMatrixAt(indexInChunk, _wTmp);
    b.im.instanceMatrix.addUpdateRange(indexInChunk * 16, 16);
    b.im.instanceMatrix.needsUpdate = true;
  }
  for (const b of farSet.cards) {
    writeFarCardSlot(b, slot, indexInChunk, hidden);
    b.im.instanceMatrix.addUpdateRange(indexInChunk * b.k * 16, b.k * 16);
    b.im.instanceMatrix.needsUpdate = true;
  }
}

// ---- chunks --------------------------------------------------------------------

type Chunk = {
  key: string;
  group: THREE.Group;
  cx: number;
  cz: number;
  /** per design id: the slots of that design in this chunk (chunk-local order) */
  byDesign: Map<number, { slots: Slot[]; farSet: FarSet }>;
};

// ---- public --------------------------------------------------------------------

export function createSeedForest(
  designs: readonly SeedTreeDesignSpec[],
  slots: readonly SeedForestSlot[],
  options: SeedForestOptions
): SeedForest {
  const chunkSize = options.chunkSize ?? 176;
  const visDist = options.visibleDistance ?? 520;
  const nearRadius = options.nearRadius ?? 58;
  const nearExit = options.nearExitRadius ?? 66;
  const nearMax = options.nearMax ?? 24;

  const group = new THREE.Group();
  group.name = options.name;

  const stats = {
    designs: 0,
    instances: 0,
    chunks: 0,
    farTriangles: 0,
    nearActive: () => active.size
  };

  // bucket slots by chunk; trunk sink is applied HERE, once — far sets, the
  // hide/restore rewrite, and near clones all read the same sunk y after this
  const chunkSlots = new Map<string, Slot[]>();
  slots.forEach((s) => {
    const key = `${Math.floor(s.x / chunkSize)},${Math.floor(s.z / chunkSize)}`;
    const slot: Slot = { ...s, y: s.y - (designs[s.design]?.sink ?? 0) * s.scale, index: 0, chunk: key };
    const list = chunkSlots.get(key);
    if (list) list.push(slot);
    else chunkSlots.set(key, [slot]);
  });

  const chunks: Chunk[] = [];

  // Texture/pipeline warmup: the first time a design renders (hero clone OR far
  // set) its SeedThree textures upload — flying into a park used to land dozens
  // of copyExternalImageToTexture calls in one frame. After build, draw one
  // hidden clone of EVERY LOD level of one design per frame (y=-4000: clipped,
  // zero fragments, but bind/upload still happens) until all designs are warm.
  const warmQueue: number[] = [];
  let warmGroup: THREE.Group | null = null;
  let warmAge = 0;
  function stepWarmup() {
    if (warmGroup) {
      if (++warmAge >= 2) {
        group.remove(warmGroup); // cloned meshes share template geometry/materials — no dispose
        warmGroup = null;
      }
      return;
    }
    const d = warmQueue.shift();
    if (d === undefined) return;
    const t = templates[d];
    if (!t) return;
    warmGroup = new THREE.Group();
    warmGroup.position.set(0, -4000, 0);
    for (const lvl of (t.template as THREE.LOD).levels) {
      const m = lvl.object.clone();
      m.traverse((o) => (o.frustumCulled = false));
      warmGroup.add(m);
    }
    warmAge = 0;
    group.add(warmGroup);
  }
  const templates: (GrownTemplate | null)[] = designs.map(() => null);
  const pools: THREE.LOD[][] = designs.map(() => []);
  const allNearSlots: { slot: Slot; chunk: Chunk }[] = [];
  const active = new Map<string, { slot: Slot; chunk: Chunk; clone: THREE.LOD }>();

  // Hoisted above the async build IIFE below, which references it during boot.
  const lastFocus = { x: 1e9, z: 1e9 };

  // Async build: grow every design (grow-once cache), then build chunk far sets.
  // Slots render nothing until their design's template resolves — trees stream
  // in a species at a time, same as the garden.
  const ready = (async () => {
    for (let d = 0; d < designs.length; d++) {
      try {
        templates[d] = await growTemplate(designs[d]);
      } catch (e) {
        console.error(`[seedForest:${options.name}] design ${designs[d].species} failed to grow:`, e);
      }
    }
    let instances = 0;
    let tris = 0;
    let designUsed = new Set<number>();
    for (const [key, list] of chunkSlots) {
      const chunk: Chunk = {
        key,
        group: new THREE.Group(),
        cx: 0,
        cz: 0,
        byDesign: new Map()
      };
      chunk.group.name = `${options.name}_${key}`;
      // chunk bounding sphere over slot extents (+canopy headroom)
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const s of list) {
        if (s.x < minX) minX = s.x;
        if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y;
        if (s.y + 34 * s.scale > maxY) maxY = s.y + 34 * s.scale;
        if (s.z < minZ) minZ = s.z;
        if (s.z > maxZ) maxZ = s.z;
      }
      chunk.cx = (minX + maxX) / 2;
      chunk.cz = (minZ + maxZ) / 2;
      const sphere = new THREE.Sphere(
        new THREE.Vector3(chunk.cx, (minY + maxY) / 2, chunk.cz),
        Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 6
      );

      const byDesign = new Map<number, Slot[]>();
      for (const s of list) {
        const arr = byDesign.get(s.design);
        if (arr) arr.push(s);
        else byDesign.set(s.design, [s]);
      }
      for (const [d, dSlots] of byDesign) {
        const t = templates[d];
        if (!t) continue;
        dSlots.forEach((s, i) => (s.index = i));
        const farSet = buildFarSet(
          t.lod2,
          dSlots,
          `${options.name}_${designs[d].species}`,
          options.farCastShadow ?? false,
          sphere,
          chunk.group
        );
        chunk.byDesign.set(d, { slots: dSlots, farSet });
        instances += dSlots.length;
        tris += farSet.triangles;
        designUsed.add(d);
        if (t.design.nearClones !== false) {
          for (const s of dSlots) allNearSlots.push({ slot: s, chunk });
        }
      }
      chunks.push(chunk);
      group.add(chunk.group);
    }
    stats.designs = designUsed.size;
    stats.instances = instances;
    stats.chunks = chunks.length;
    stats.farTriangles = Math.round(tris);
    for (const d of designUsed) warmQueue.push(d); // stagger first-render texture uploads
    applyDistanceCull(lastFocus.x, lastFocus.z, true);
    console.log(
      `[seedForest] ${options.name} online: ${designUsed.size} designs, ${instances} trees, ${chunks.length} chunks, ~${(tris / 1e6).toFixed(1)}M far tris (culled per frame)`
    );
  })();

  // ---- near tier (garden's manager, over chunked slots) -----------------------

  let lastRebin = 0;
  const lastPos = new THREE.Vector3(1e9, 0, 0);
  let rebinBroken = false;

  function rebin(camera: THREE.Camera) {
    const now = performance.now();
    const camPos = (camera as THREE.PerspectiveCamera).position;
    if (now - lastRebin < REBIN_MS || camPos.distanceToSquared(lastPos) < REBIN_MOVE_SQ) return;
    lastRebin = now;
    lastPos.copy(camPos);

    const enterSq = nearRadius * nearRadius;
    const exitSq = nearExit * nearExit;
    const cand: { slot: Slot; chunk: Chunk; d2: number; key: string }[] = [];
    for (const entry of allNearSlots) {
      const dx = entry.slot.x - camPos.x;
      const dz = entry.slot.z - camPos.z;
      const d2 = dx * dx + dz * dz;
      const key = `${entry.slot.chunk}:${entry.slot.design}:${entry.slot.index}`;
      if (d2 < (active.has(key) ? exitSq : enterSq)) cand.push({ ...entry, d2, key });
    }
    cand.sort((a, b) => a.d2 - b.d2);
    const next = new Set<string>();
    for (let i = 0; i < Math.min(cand.length, nearMax); i++) next.add(cand[i].key);

    for (const [key, entry] of active) {
      if (next.has(key)) continue;
      group.remove(entry.clone);
      pools[entry.slot.design].push(entry.clone);
      const cd = entry.chunk.byDesign.get(entry.slot.design);
      if (cd) setFarSlotHidden(cd.farSet, entry.slot, entry.slot.index, false);
      active.delete(key);
    }
    // Cap hero swaps per rebin: entering a forest at speed used to promote a
    // whole ring of heroes at once (template clones + their first-render
    // uploads in one frame). Nearest-first fills within a few 250 ms rebins;
    // the far instances stay visible until each swap, so nothing pops empty.
    let added = 0;
    for (const c of cand) {
      if (added >= 4) break;
      if (!next.has(c.key) || active.has(c.key)) continue;
      const t = templates[c.slot.design];
      if (!t) continue;
      const clone = pools[c.slot.design].pop() ?? (t.template.clone() as THREE.LOD);
      clone.position.set(c.slot.x, c.slot.y, c.slot.z); // y already sunk at bucketing
      clone.quaternion.setFromAxisAngle(UP, c.slot.yaw);
      clone.scale.setScalar(c.slot.scale);
      group.add(clone);
      const cd = c.chunk.byDesign.get(c.slot.design);
      if (cd) setFarSlotHidden(cd.farSet, c.slot, c.slot.index, true);
      active.set(c.key, { slot: c.slot, chunk: c.chunk, clone });
      added++;
    }
  }

  // Self-driving rebin: a 2-triangle driver quad that always renders (parked far
  // underground, colorWrite off) hands us the live perspective camera every
  // frame. Shadow passes call onBeforeRender with the sun's ortho camera —
  // only the gameplay camera may steer the rebin.
  const driver = new THREE.Mesh(
    new THREE.PlaneGeometry(0.01, 0.01),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
  );
  driver.name = `${options.name}_rebin_driver`;
  driver.position.set(0, -4000, 0);
  driver.frustumCulled = false;
  driver.onBeforeRender = (_r, _s, camera) => {
    if (!(camera as THREE.PerspectiveCamera).isPerspectiveCamera || rebinBroken) return;
    try {
      stepWarmup(); // one design's textures/pipelines per frame until warm
      rebin(camera);
    } catch (e) {
      rebinBroken = true; // one bad rebin must not take down the render loop
      console.error(`[seedForest:${options.name}] rebin failed — far tier stays static:`, e);
    }
  };
  group.add(driver);

  // ---- chunk distance culling --------------------------------------------------

  function applyDistanceCull(x: number, z: number, force = false) {
    if (!force && Math.hypot(x - lastFocus.x, z - lastFocus.z) < 24) return;
    lastFocus.x = x;
    lastFocus.z = z;
    for (const c of chunks) {
      c.group.visible = Math.hypot(c.cx - x, c.cz - z) < visDist;
    }
  }

  return {
    group,
    ready,
    update(focus) {
      applyDistanceCull(focus.x, focus.z);
    },
    stats
  };
}
