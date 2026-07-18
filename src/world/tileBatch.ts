// Streamed-tile draw-call collapse via THREE.BatchedMesh.
//
// Each resident city tile ships ~one merged mesh PER surface family (buildings,
// roads, park/pier decks). The per-tile road/park meshes historically drew one
// GPU draw each from inside a per-tile BundleGroup — ~one road draw per resident
// tile, ~25-60 in the beauty pass, growing linearly with the residency ring.
// This backend is per-draw-EXECUTION bound (see project memory + citygen
// shellBatch), so this folds every resident tile's mesh for ONE shared material
// into a single THREE.BatchedMesh: one owner, one pipeline bind, N sub-draws in
// one indirect encode, AND per-instance frustum culling the bundles could not do
// (bundles record draws once with frustumCulled=false, paying for off-screen
// tiles every frame).
//
// This path is only viable for surfaces whose material is world-position keyed
// and shared across every tile (road/park asphalt/grass) — the per-instance
// dequantization transform folds into the BatchedMesh instance matrix, so
// `positionWorld` resolves correctly. Building facades CANNOT use it: their
// material closes over a per-tile "alive" DataTexture (1-row, indexed by _bid)
// and a modelScale-relative positionNode/vertexNode; both live in facade.ts and
// would need per-instance texture addressing + a batch-aware dequant scale to
// batch. See tiles.ts / the perf report for that (separate-track) design.
//
// Streaming churn: BatchedMesh reuses deleted INSTANCE ids immediately, but
// deleteGeometry never reclaims the append-only vertex/index arena until an
// optimize() whole-buffer compaction. So (exactly as citygen shellBatch) we
// retain fixed geometry RANGES as size-classed reusable slots and refill them
// with setGeometryAt(); a tile leaving the ring frees its instance + returns its
// slot, and the next tile through the same district reuses it. No compaction of
// a live city in a visible frame, no unbounded arena growth.
import * as THREE from "three/webgpu";

/** One tile mesh folded into a batch. free() removes the instance and returns
 *  its geometry slot to the reuse pool (called on tile unload). setVisible mirrors
 *  the owning tile's group visibility (batched roads are not under tile.group, so
 *  a hidden tile must hide its instances too — e.g. non-destination tiles during
 *  a covered arrival). */
export interface TileBatchHandle {
  free(): void;
  setVisible(visible: boolean): void;
  /** This instance's id inside the BatchedMesh. It is also the row three writes
   *  the per-instance matrix to (setMatrixAt) and the value the shader recovers
   *  via the indirect index — so a caller carrying per-instance data in a shared
   *  texture (e.g. the facade alive atlas) indexes that texture by this id. */
  readonly instanceId: number;
}

export interface TileMeshBatch {
  /** Fold one tile mesh's geometry into the batch at a world transform (the
   *  tile's dequantization matrix). Returns null when the batch is full or its
   *  arena is exhausted — the caller keeps that mesh on the per-tile bundle
   *  fallback so a tile is never partially represented. */
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): TileBatchHandle | null;
  /** The batch owner. Exposed so a per-instance-keyed material (the facade batch
   *  material) can be built against this mesh's `_indirectTexture` after
   *  construction — the material needs the mesh, and the mesh needs a material,
   *  so the caller creates a shell material, builds the batch, then configures. */
  readonly mesh: THREE.BatchedMesh;
  stats(): {
    instances: number;
    capacity: number;
    slots: number;
    freeSlots: number;
    vertexCapacity: number;
    indexCapacity: number;
    attached: boolean;
  };
  dispose(): void;
}

// Reusable geometry range inside the batch arena. reserved* are the rounded-up
// budget the range holds; a refilled geometry must fit inside both.
interface GeometrySlot {
  geo: number;
  reservedVertices: number;
  reservedIndices: number;
}

export interface TileMeshBatchOptions {
  name: string;
  /** Shared, world-position-keyed material (e.g. the road/park material). ONE
   *  material owns the whole batch — three injects the batch node automatically. */
  material: THREE.Material;
  /** Max live instances (resident tiles for this surface + streaming headroom). */
  capacity: number;
  /** Initial arena size — sized to cover a healthy residency ring so ordinary
   *  play never triggers a mid-stream setGeometrySize grow. */
  initialVertices: number;
  initialIndices: number;
  /** Hard arena ceiling; the arena grows power-of-two toward it only under an
   *  unusually dense residency, then add() returns null (bundle fallback). */
  maxVertices: number;
  maxIndices: number;
  receiveShadow?: boolean;
}

const roundUp = (count: number, quantum: number): number => Math.ceil(count / quantum) * quantum;
const VERTEX_QUANTUM = 128;
const INDEX_QUANTUM = 256;

export function createTileMeshBatch(
  scene: THREE.Object3D,
  opts: TileMeshBatchOptions
): TileMeshBatch {
  const cap = opts.capacity;
  let vertexCapacity = Math.min(opts.initialVertices, opts.maxVertices);
  let indexCapacity = Math.min(opts.initialIndices, opts.maxIndices);

  const mesh = new THREE.BatchedMesh(cap, vertexCapacity, indexCapacity, opts.material);
  mesh.name = opts.name;
  // BatchedMesh frustum-culls per instance itself (perObjectFrustumCulled, on by
  // default); the whole-owner cull must stay OFF or one giant citywide bounds
  // would cull the entire batch when its centre leaves the view.
  mesh.frustumCulled = false;
  mesh.perObjectFrustumCulled = true;
  // Beauty road/park meshes never cast (their shadow massing rides the separate
  // tile shadow proxy); they do receive. Mirror the per-tile mesh flags exactly.
  mesh.castShadow = false;
  mesh.receiveShadow = opts.receiveShadow ?? true;
  // Physics/paint/cursor rays use box3d colliders + query world, never tile
  // render meshes — opt the batch out of raycasting (instanced geometry is
  // world-space but three would offset it by the instance matrix).
  mesh.raycast = () => {};

  const slots: GeometrySlot[] = [];
  const freeSlots: GeometrySlot[] = [];
  let used = 0;

  const ensureGeometryRoom = (vertices: number, indices: number): boolean => {
    const usedVertices = vertexCapacity - mesh.unusedVertexCount;
    const usedIndices = indexCapacity - mesh.unusedIndexCount;
    const requiredVertices = usedVertices + vertices;
    const requiredIndices = usedIndices + indices;
    let nextVertices = vertexCapacity;
    let nextIndices = indexCapacity;
    while (nextVertices < requiredVertices && nextVertices < opts.maxVertices) {
      nextVertices = Math.min(opts.maxVertices, Math.max(requiredVertices, nextVertices * 2));
    }
    while (nextIndices < requiredIndices && nextIndices < opts.maxIndices) {
      nextIndices = Math.min(opts.maxIndices, Math.max(requiredIndices, nextIndices * 2));
    }
    if (nextVertices < requiredVertices || nextIndices < requiredIndices) return false;
    if (nextVertices !== vertexCapacity || nextIndices !== indexCapacity) {
      mesh.setGeometrySize(nextVertices, nextIndices);
      vertexCapacity = nextVertices;
      indexCapacity = nextIndices;
    }
    return true;
  };

  const takeGeometrySlot = (geometry: THREE.BufferGeometry): GeometrySlot | null => {
    const vertices = geometry.getAttribute("position").count;
    const indices = geometry.getIndex()?.count ?? 0;
    // Best-fit an existing freed range so a small park deck never consumes a rare
    // large downtown-road range (and vice versa) when districts churn.
    let best = -1;
    let bestWaste = Infinity;
    for (let i = 0; i < freeSlots.length; i++) {
      const slot = freeSlots[i];
      if (slot.reservedVertices < vertices || slot.reservedIndices < indices) continue;
      const waste = slot.reservedVertices - vertices + slot.reservedIndices - indices;
      if (waste < bestWaste) {
        best = i;
        bestWaste = waste;
      }
    }
    if (best >= 0) {
      const [slot] = freeSlots.splice(best, 1);
      try {
        mesh.setGeometryAt(slot.geo, geometry);
        return slot;
      } catch {
        freeSlots.push(slot);
        return null;
      }
    }
    // Size classes trade a little slack for reliable reuse across slightly
    // different footprints in the next district.
    const reservedVertices = roundUp(vertices, VERTEX_QUANTUM);
    const reservedIndices = roundUp(Math.max(indices, 1), INDEX_QUANTUM);
    if (!ensureGeometryRoom(reservedVertices, reservedIndices)) return null;
    try {
      const geo = mesh.addGeometry(geometry, reservedVertices, reservedIndices);
      const slot = { geo, reservedVertices, reservedIndices };
      slots.push(slot);
      return slot;
    } catch {
      return null;
    }
  };

  return {
    add(geometry, matrix) {
      if (used >= cap) return null;
      // Per-instance frustum culling reads each geometry's bounds through the
      // instance matrix; compute them now (normalized-int positions denormalize
      // correctly) so the cull is exact and no first-cull per-vertex loop hitches.
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const slot = takeGeometrySlot(geometry);
      if (!slot) return null;
      let inst: number;
      try {
        inst = mesh.addInstance(slot.geo);
      } catch {
        freeSlots.push(slot);
        return null;
      }
      used++;
      mesh.setMatrixAt(inst, matrix);
      if (!mesh.parent) scene.add(mesh);
      let freed = false;
      return {
        instanceId: inst,
        free() {
          if (freed) return;
          freed = true;
          try {
            mesh.deleteInstance(inst);
          } catch {
            return;
          }
          used = Math.max(0, used - 1);
          freeSlots.push(slot);
          if (used === 0) mesh.removeFromParent();
        },
        setVisible(visible: boolean) {
          if (freed) return;
          mesh.setVisibleAt(inst, visible);
        }
      };
    },
    mesh,
    stats() {
      return {
        instances: used,
        capacity: cap,
        slots: slots.length,
        freeSlots: freeSlots.length,
        vertexCapacity,
        indexCapacity,
        attached: mesh.parent !== null
      };
    },
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
    }
  };
}
