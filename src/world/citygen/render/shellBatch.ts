// Batched building SHELL layer — the "whole city walls in a dozen draws" path.
//
// The per-building wall/roof/trim/stoop/door geometry used to live in one
// THREE.BundleGroup PER building (render.ts). Bundles cache the CPU encode, but
// the GPU still EXECUTES every child draw every frame — measured 2,384 sub-draws
// for 378 detail buildings (~12.5 ms, the frame's biggest slice, linear in
// building count). This collapses them the same way moduleLayer.ts collapsed
// windows: one THREE.BatchedMesh per settled MATERIAL (a handful total), each
// holding every building's geometry for that material as a separate BatchedMesh
// geometry+instance. On this Metal/WebGPU backend BatchedMesh's multi-draw path
// renders N unique geometries far faster than N meshes (spike: 300 uniques at
// 2 ms vs 21 ms), AND — unlike the frustumCulled=false bundles — it frustum-culls
// per instance, so off-screen buildings stop being paid for. Both
// together break the linear-in-building-count wall so the detail COUNT can grow.
//
// Per-building CROSSFADE + body TINT ride a per-batch RGBA DataTexture indexed by
// the batch's own indirect draw id (getIndirectIndex, exactly as three's `batch`
// node maps it): rgb = painted-lady tint (walls), a = fade. Fading is one texel
// write per material it uses — no material clones, no re-record. The
// fade dithers in the OPAQUE pass via alphaHash (a==1 → no discard), staying in
// visual step with the instanced window layer, which fades the same way.
//
// BatchedMesh reuses deleted INSTANCE ids, but deleteGeometry does not reclaim
// its append-only vertex/index arena until optimize() performs a whole-buffer
// compaction. We therefore retain fixed geometry ranges as reusable slots and
// replace their contents with setGeometryAt(). Streaming through new districts
// remains bounded without ever compacting a live city in one visible frame.
import * as THREE from "three/webgpu";
import {
  float, int, ivec2, textureLoad, textureSize, instanceIndex, Fn,
} from "three/tsl";
import type { MeshData } from "../core/types";
import { wallPattern, WALL_EMISSIVE, type WallKind } from "../theme/materials";
import { cameraCutawayVisibility } from "../../../render/cameraCutaway";
import { applyBirthFade } from "../../../render/materialize";

// TSL node generics fight composition; `any` is this app's node-code idiom.
type N = any;

const DATA_W = 128; // data texture width; height grows with capacity

export interface ShellHandle {
  /** dithered crossfade: o<1 → alphaHash-discarded toward invisible; o≥1 opaque */
  setFade(o: number): void;
  /** show/hide the baked door leaf+back instances when the player opens the door */
  setDoorLeavesVisible(vis: boolean): void;
  /** hide/show EVERY instance this building owns in the batch (walls/roof/trim/
   *  stoop/doors) — the "look out the window" trick: while the player is inside,
   *  the exterior shell vanishes entirely so the real city shows through the
   *  interior's window holes instead of a painted parallax pane. */
  setShellHidden(hidden: boolean): void;
  free(): void;
}

export interface ShellBatchLayer {
  /** Add one building's shell meshes. `wallKind`/`tint` drive the per-instance
   *  wall colour; `matrix` is the proud transform (folded per instance). Returns
   *  null if any needed batch is full — caller falls back to a per-building bundle. */
  addBuilding(
    meshes: MeshData[],
    opts: { matrix: THREE.Matrix4; wallKind: WallKind; tint: THREE.Color; mats: Record<string, THREE.Material> },
  ): ShellHandle | null;
  /** Compile the exact BatchedMesh owners that exterior streaming can publish.
   *  Each owner is prepared separately and remains detached until it has a real
   *  building, so this neither draws nor retains empty per-frame scene work. */
  prepareExterior(
    mats: Record<string, THREE.Material>,
    prepare: (label: string, owner: THREE.Object3D) => Promise<boolean>,
  ): Promise<void>;
  stats(): {
    batches: number;
    attachedBatches: number;
    preparedBatches: number;
    instances: number;
    capacity: number;
    geometrySlots: number;
    reusableSlots: number;
    geometryVertexCapacity: number;
    geometryIndexCapacity: number;
  };
  dispose(): void;
}

// ---- per-instance data (tint + fade) read in the shader --------------------------

/** getIndirectIndex(mesh._indirectTexture, builder.getDrawIndex()||instanceIndex)
 *  — the SAME per-instance id three's `batch` node uses to index the matrix/color
 *  textures. Read at shader-build time (like three's own node), when the indirect
 *  texture exists. Returns an int node. */
function indirectId(mesh: THREE.BatchedMesh): N {
  return Fn((_args: unknown, builder: N) => {
    const indirectTexture = (mesh as N)._indirectTexture;
    const di = builder.getDrawIndex();
    const id = int(di === null ? instanceIndex : di);
    const size = int((textureSize as N)(textureLoad(indirectTexture as N), 0).x);
    const x = id.mod(size), y = id.div(size);
    return int((textureLoad(indirectTexture as N, ivec2(x, y)) as N).x);
  })();
}

/** Sample this instance's tint, visual fade and independent shadow gate. Packing
 *  the two scalar controls into alpha keeps the existing one-texel hot update. */
function instanceData(
  mesh: THREE.BatchedMesh,
  dataTex: THREE.DataTexture,
): { tint: N; fade: N; castsShadow: N } {
  const id = indirectId(mesh);
  const w = int(DATA_W);
  const texel = textureLoad(dataTex as N, ivec2(id.mod(w), id.div(w)));
  const packed = texel.w as N;
  return {
    tint: texel.xyz as N,
    fade: packed.mod(2),
    castsShadow: packed.greaterThanEqual(2),
  };
}

// ---- batch materials -------------------------------------------------------------

function makeWallBatchMaterial(kind: WallKind, mesh: THREE.BatchedMesh, dataTex: THREE.DataTexture): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  m.envMapIntensity = 5.5;
  const { tint, fade, castsShadow } = instanceData(mesh, dataTex);
  const tinted = (wallPattern(kind) as N).mul(tint); // grayscale pattern × per-instance body colour
  m.colorNode = tinted;
  m.emissiveNode = tinted.mul(float(WALL_EMISSIVE)); // faint self-lit tint (near-zero ambient world)
  // M5: the existing crossfade (per-instance fade texel) drives the same holo
  // language as the world front — min(front, fade) darkens + adds the emissive
  // grid while a building dithers in/out; settled (fade=1, front revealed)
  // collapses to the exact original shading. Opacity/alphaHash stay untouched.
  applyBirthFade(m, { extraAmount: fade });
  m.opacityNode = fade.mul(cameraCutawayVisibility());
  m.maskShadowNode = castsShadow
    .and(fade.greaterThanEqual(0.5))
    .and(cameraCutawayVisibility().greaterThanEqual(0.5));
  m.alphaHash = true;
  return m;
}

/** A batched clone of one shared theme material (trim/roof/door/stoop/…): copies
 *  its look, adds the per-instance fade. These ids are uniform-coloured, so no
 *  per-instance tint — the material's own colour stands. */
function makeStdBatchMaterial(base: THREE.Material, mesh: THREE.BatchedMesh, dataTex: THREE.DataTexture): THREE.MeshStandardNodeMaterial {
  const s = base as THREE.MeshStandardMaterial;
  const m = new THREE.MeshStandardNodeMaterial({
    color: s.color, roughness: s.roughness ?? 0.9, metalness: s.metalness ?? 0, side: s.side ?? THREE.DoubleSide,
  });
  m.envMapIntensity = s.envMapIntensity ?? 5.5;
  if (s.emissive) { m.emissive = s.emissive.clone(); m.emissiveIntensity = s.emissiveIntensity ?? 1; }
  const { fade, castsShadow } = instanceData(mesh, dataTex);
  // M5 holo retint of the crossfade — see makeWallBatchMaterial.
  applyBirthFade(m, { extraAmount: fade });
  m.opacityNode = fade.mul(cameraCutawayVisibility());
  m.maskShadowNode = castsShadow
    .and(fade.greaterThanEqual(0.5))
    .and(cameraCutawayVisibility().greaterThanEqual(0.5));
  m.alphaHash = true;
  return m;
}

// ---- one material's batch --------------------------------------------------------

interface Batch {
  mesh: THREE.BatchedMesh;
  data: THREE.DataTexture;
  arr: Float32Array;
  cap: number;      // instances
  vertexCapacity: number;
  indexCapacity: number;
  maxVertexCapacity: number;
  maxIndexCapacity: number;
  prepared: boolean;
  used: number;
  slots: GeometrySlot[];
  freeSlots: GeometrySlot[];
}

interface GeometrySlot {
  geo: number;
  reservedVertices: number;
  reservedIndices: number;
}

// per-building record: which (batch, geometryId, instanceId) triples it owns,
// split so door leaves can be toggled without touching the rest.
interface Placement { batch: Batch; slot: GeometrySlot; inst: number; door: boolean; }

function makeGeometry(md: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(md.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(md.normals, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(md.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(md.indices, 1));
  return g;
}

export function createShellBatchLayer(
  scene: THREE.Object3D,
  opts: { capacity?: number; vertsPerBuilding?: number } = {},
): ShellBatchLayer {
  const CAP = opts.capacity ?? 1400;               // instances per batch
  const VPB = opts.vertsPerBuilding ?? 900;        // vertex budget per instance
  // BatchedMesh allocates its complete attribute/index arena on the FIRST
  // addGeometry(). Starting at CAP*VPB made each newly encountered material
  // allocate tens of MiB in one visible frame. Keep the same live BatchedMesh
  // (and therefore the same warmed material/pipeline) while its arena grows in
  // powers of two as geometry actually arrives.
  const MAX_VERTICES = CAP * VPB;
  const MAX_INDICES = MAX_VERTICES * 2;
  // ~0.2 MiB with position/normal/uv/index: small across every prepared owner,
  // but large enough that ordinary rowhouses do not resize on their first few
  // placements.
  const INITIAL_VERTICES = Math.min(MAX_VERTICES, 4096);
  const INITIAL_INDICES = Math.min(MAX_INDICES, 8192);
  const batches = new Map<string, Batch>();        // key: `wall:kind` | materialId
  const _c = new THREE.Color();
  const interactionOnlyMaterialIds = new Set([
    "citygen.door.panel",
    "citygen.door.hardware",
    "citygen.room",
  ]);

  const makeBatch = (key: string, wallKind: WallKind | null, base: THREE.Material | null): Batch => {
    const dataH = Math.ceil(CAP / DATA_W);
    const arr = new Float32Array(DATA_W * dataH * 4);
    const data = new THREE.DataTexture(arr, DATA_W, dataH, THREE.RGBAFormat, THREE.FloatType);
    data.minFilter = THREE.NearestFilter; data.magFilter = THREE.NearestFilter; data.generateMipmaps = false;
    data.needsUpdate = true;
    const mesh = new THREE.BatchedMesh(CAP, INITIAL_VERTICES, INITIAL_INDICES);
    mesh.name = `cityGenShellBatch.${key}`;
    mesh.frustumCulled = false;   // BatchedMesh does its OWN per-instance frustum cull
    // Stable chunk proxies own shadow massing; detail LOD never enters a map.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // paint/cursor rays land on the prism/refiner, not this batch (its geometry is
    // world-space but three offsets by the instance matrix — opt out of raycast).
    mesh.raycast = () => {};
    mesh.material = wallKind ? makeWallBatchMaterial(wallKind, mesh, data) : makeStdBatchMaterial(base!, mesh, data);
    // Stay detached until the first real placement. Detached warmup compiles
    // this exact owner directly; an empty warmed batch costs no scene traversal.
    const b: Batch = {
      mesh, data, arr, cap: CAP,
      vertexCapacity: INITIAL_VERTICES, indexCapacity: INITIAL_INDICES,
      maxVertexCapacity: MAX_VERTICES, maxIndexCapacity: MAX_INDICES,
      prepared: false, used: 0, slots: [], freeSlots: [],
    };
    batches.set(key, b);
    return b;
  };

  const batchFor = (key: string, wallKind: WallKind | null, base: THREE.Material | null): Batch =>
    batches.get(key) ?? makeBatch(key, wallKind, base);

  const writeTexel = (b: Batch, inst: number, r: number, g: number, bl: number, a: number) => {
    const o = inst * 4;
    b.arr[o] = r; b.arr[o + 1] = g; b.arr[o + 2] = bl; b.arr[o + 3] = a;
    b.data.needsUpdate = true;
  };
  const writeFade = (b: Batch, inst: number, fade: number) => {
    b.arr[inst * 4 + 3] = fade;
    b.data.needsUpdate = true;
  };

  const reserveTo = (count: number, quantum: number) => Math.ceil(count / quantum) * quantum;
  const ensureGeometryRoom = (b: Batch, vertices: number, indices: number) => {
    const usedVertices = b.vertexCapacity - b.mesh.unusedVertexCount;
    const usedIndices = b.indexCapacity - b.mesh.unusedIndexCount;
    const requiredVertices = usedVertices + vertices;
    const requiredIndices = usedIndices + indices;
    let nextVertices = b.vertexCapacity;
    let nextIndices = b.indexCapacity;
    while (nextVertices < requiredVertices && nextVertices < b.maxVertexCapacity) {
      nextVertices = Math.min(b.maxVertexCapacity, Math.max(requiredVertices, nextVertices * 2));
    }
    while (nextIndices < requiredIndices && nextIndices < b.maxIndexCapacity) {
      nextIndices = Math.min(b.maxIndexCapacity, Math.max(requiredIndices, nextIndices * 2));
    }
    if (nextVertices < requiredVertices || nextIndices < requiredIndices) {
      throw new RangeError(`CityGen shell batch geometry capacity exhausted (${requiredVertices}v/${requiredIndices}i)`);
    }
    if (nextVertices !== b.vertexCapacity || nextIndices !== b.indexCapacity) {
      b.mesh.setGeometrySize(nextVertices, nextIndices);
      b.vertexCapacity = nextVertices;
      b.indexCapacity = nextIndices;
    }
  };
  const takeGeometrySlot = (b: Batch, geometry: THREE.BufferGeometry): GeometrySlot => {
    const vertices = geometry.getAttribute("position").count;
    const indices = geometry.getIndex()?.count ?? 0;
    // Best-fit avoids consuming a rare large range for a tiny trim/door mesh.
    let best = -1;
    let bestWaste = Infinity;
    for (let index = 0; index < b.freeSlots.length; index++) {
      const slot = b.freeSlots[index];
      if (slot.reservedVertices < vertices || slot.reservedIndices < indices) continue;
      const waste = slot.reservedVertices - vertices + slot.reservedIndices - indices;
      if (waste < bestWaste) {
        best = index;
        bestWaste = waste;
      }
    }
    if (best >= 0) {
      const [slot] = b.freeSlots.splice(best, 1);
      try {
        b.mesh.setGeometryAt(slot.geo, geometry);
        return slot;
      } catch (error) {
        b.freeSlots.push(slot);
        throw error;
      }
    }

    // Size classes trade a small fixed amount of slack for reliable reuse when
    // the next district has a slightly different footprint or facade grammar.
    const reservedVertices = reserveTo(vertices, 64);
    const reservedIndices = reserveTo(indices, 128);
    ensureGeometryRoom(b, reservedVertices, reservedIndices);
    const slot = {
      geo: b.mesh.addGeometry(geometry, reservedVertices, reservedIndices),
      reservedVertices,
      reservedIndices,
    };
    b.slots.push(slot);
    return slot;
  };

  const releasePlacement = (placement: Placement) => {
    try {
      placement.batch.mesh.deleteInstance(placement.inst);
    } catch {
      return;
    }
    placement.batch.used = Math.max(0, placement.batch.used - 1);
    placement.batch.freeSlots.push(placement.slot);
    if (placement.batch.used === 0) placement.batch.mesh.removeFromParent();
  };

  const warmupMesh: MeshData = {
    materialId: "citygen.warmup",
    positions: new Float32Array([0, 0, 0, 0.02, 0, 0, 0, 0.02, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const primeBatch = (b: Batch): Placement => {
    const geometry = makeGeometry(warmupMesh);
    let slot: GeometrySlot;
    try {
      slot = takeGeometrySlot(b, geometry);
    } finally {
      geometry.dispose();
    }
    const inst = b.mesh.addInstance(slot.geo);
    b.used++;
    b.mesh.setMatrixAt(inst, new THREE.Matrix4());
    // Fully discarded if an integration accidentally attaches it mid-prepare.
    writeTexel(b, inst, 1, 1, 1, 0);
    return { batch: b, slot, inst, door: false };
  };

  return {
    async prepareExterior(mats, prepare) {
      const variants: Array<{ key: string; wallKind: WallKind | null; base: THREE.Material | null }> = [
        ...(["clapboard", "brick", "stucco", "smooth"] as const).map((kind) => ({
          key: `wall:${kind}`, wallKind: kind, base: null,
        })),
        // Every non-interior theme id is a possible exterior grammar bucket.
        // Preparing exact owners (instead of assuming structurally-similar
        // standard graphs dedupe) also makes future theme additions generic.
        ...Object.keys(mats)
          .filter((id) =>
            !id.startsWith("wall.") &&
            !id.startsWith("int.") &&
            !interactionOnlyMaterialIds.has(id)
          )
          .sort()
          .map((id) => ({ key: id, wallKind: null, base: mats[id] })),
      ];
      for (const variant of variants) {
        const batch = batchFor(variant.key, variant.wallKind, variant.base);
        if (batch.prepared) continue;
        const dummy = primeBatch(batch);
        try {
          batch.prepared = await prepare(`shell:${variant.key}`, batch.mesh);
        } finally {
          releasePlacement(dummy);
        }
      }
    },
    addBuilding(meshes, o) {
      // Try to place every mesh; if any batch is full, roll back and signal the
      // caller to keep the whole building on the bundle fallback (all-or-nothing
      // so a building is never split across both paths).
      const placed: Placement[] = [];
      const rollback = () => {
        for (const p of placed) releasePlacement(p);
      };
      for (const md of meshes) {
        const isWall = md.materialId.startsWith("wall.");
        const key = isWall ? `wall:${o.wallKind}` : md.materialId;
        const base = isWall ? null : (o.mats[md.materialId] ?? null);
        if (!isWall && !base) continue; // unknown id → skip (shouldn't happen; grammar ids are in mats)
        const b = batchFor(key, isWall ? o.wallKind : null, base);
        if (b.used >= b.cap) { rollback(); return null; }
        let slot: GeometrySlot | null = null;
        let inst: number;
        try {
          const g = makeGeometry(md);
          try {
            slot = takeGeometrySlot(b, g);
          } finally {
            // BatchedMesh copies every attribute/index into its owned arena.
            g.dispose();
          }
          inst = b.mesh.addInstance(slot.geo);
        } catch {
          if (slot) b.freeSlots.push(slot);
          rollback();
          return null;
        }        // vertex/index budget exhausted
        b.used++;
        b.mesh.setMatrixAt(inst, o.matrix);
        const door = md.materialId === "citygen.doorleaf" || md.materialId === "citygen.doorback";
        if (isWall) { _c.copy(o.tint); writeTexel(b, inst, _c.r, _c.g, _c.b, 0.02); }
        else writeTexel(b, inst, 1, 1, 1, 0.02);    // born fading
        placed.push({ batch: b, slot, inst, door });
      }
      if (!placed.length) return null;
      // Publish only after every material placement succeeded, preserving the
      // building's all-or-nothing attach contract.
      for (const b of new Set(placed.map((p) => p.batch))) {
        if (!b.mesh.parent) scene.add(b.mesh);
      }
      let fade = 0.02;
      let freed = false;
      return {
        setFade(nextFade: number) {
          fade = nextFade;
          for (const p of placed) writeFade(p.batch, p.inst, fade);
        },
        setDoorLeavesVisible(vis: boolean) {
          for (const p of placed) if (p.door) p.batch.mesh.setVisibleAt(p.inst, vis);
        },
        setShellHidden(hidden: boolean) {
          for (const p of placed) p.batch.mesh.setVisibleAt(p.inst, !hidden);
        },
        free() {
          if (freed) return;
          freed = true;
          for (const p of placed) releasePlacement(p);
        },
      };
    },
    stats() {
      let attachedBatches = 0, preparedBatches = 0;
      let instances = 0, capacity = 0, geometrySlots = 0, reusableSlots = 0;
      let geometryVertexCapacity = 0, geometryIndexCapacity = 0;
      for (const b of batches.values()) {
        if (b.mesh.parent) attachedBatches++;
        if (b.prepared) preparedBatches++;
        instances += b.used;
        capacity += b.cap;
        geometrySlots += b.slots.length;
        reusableSlots += b.freeSlots.length;
        geometryVertexCapacity += b.vertexCapacity;
        geometryIndexCapacity += b.indexCapacity;
      }
      return {
        batches: batches.size, attachedBatches, preparedBatches,
        instances, capacity, geometrySlots, reusableSlots,
        geometryVertexCapacity, geometryIndexCapacity,
      };
    },
    dispose() {
      for (const b of batches.values()) {
        b.mesh.removeFromParent();
        b.mesh.dispose();
        b.mesh.material.dispose();
        b.data.dispose();
      }
      batches.clear();
    },
  };
}
