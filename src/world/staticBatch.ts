import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type StaticBatchOptions = Readonly<{
  /**
   * userData flag that exempts an object — and its entire subtree — from the
   * pass. A flagged mesh is never merged, and a flagged group is never even
   * descended into, so dynamic/animated subsystems stay untouched.
   */
  keepKey: string;
  /** Batch name prefix used when a sibling group has no name (default "static"). */
  siblingFallbackName?: string;
  /** Batch name prefix used when a landmark owner has no name (default "landmark"). */
  landmarkFallbackName?: string;
  /**
   * Run the second, cross-subgroup landmark pass. Sites whose animated content
   * lives in nested groups (a moving deck, a wagging tail, a hovering flock)
   * must keep this off so a sibling-only merge never flattens a moving group.
   * Defaults to true to preserve the Tea Garden's original two-pass behaviour.
   */
  landmarkPass?: boolean;
}>;

export type StaticBatchStats = Readonly<{
  sourceMeshes: number;
  batchMeshes: number;
  removedMeshes: number;
  /**
   * The newly created merged meshes. Their geometries are freshly allocated and
   * untracked; a site that tears down must dispose them (the pass disposes only
   * the source geometries it replaces).
   */
  batches: readonly THREE.Mesh[];
}>;

type BatchCandidate = THREE.Mesh<THREE.BufferGeometry, THREE.Material>;

function batchKey(mesh: BatchCandidate): string {
  const attributes = Object.entries(mesh.geometry.attributes)
    .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}:${attribute.array.constructor.name}`)
    .sort()
    .join("|");
  return [
    mesh.material.uuid,
    mesh.castShadow ? 1 : 0,
    mesh.receiveShadow ? 1 : 0,
    mesh.renderOrder,
    mesh.layers.mask,
    mesh.frustumCulled ? 1 : 0,
    mesh.geometry.index?.array.constructor.name ?? "none",
    attributes
  ].join(":");
}

function isCandidate(object: THREE.Object3D, keepKey: string): object is BatchCandidate {
  const mesh = object as THREE.Mesh;
  return Boolean(
    mesh.isMesh &&
    !(mesh as THREE.InstancedMesh).isInstancedMesh &&
    !(mesh as THREE.SkinnedMesh).isSkinnedMesh &&
    mesh.visible &&
    !Array.isArray(mesh.material) &&
    mesh.geometry.getAttribute("position") &&
    !mesh.morphTargetInfluences &&
    !mesh.userData[keepKey]
  );
}

/**
 * Collapse sibling-only static meshes by material/render state, preserving the
 * authored group tree.
 *
 * Only leaf meshes that share a parent, a material instance, and identical
 * render state (shadow flags, layers, render order, frustum culling, attribute
 * layout) are merged, in that parent's local space. Physics, light anchors,
 * landmark names, animated and instanced objects, and anything flagged with
 * `keepKey` remain independent objects — a flagged object and its whole subtree
 * are skipped, so moving groups never lose their children to a static merge.
 */
export function batchStaticSiblings(root: THREE.Object3D, options: StaticBatchOptions): StaticBatchStats {
  const keepKey = options.keepKey;
  const siblingFallbackName = options.siblingFallbackName ?? "static";
  const landmarkFallbackName = options.landmarkFallbackName ?? "landmark";
  const landmarkPass = options.landmarkPass ?? true;

  const geometryRefs = new Map<THREE.BufferGeometry, number>();
  let sourceMeshes = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    sourceMeshes++;
    geometryRefs.set(mesh.geometry, (geometryRefs.get(mesh.geometry) ?? 0) + 1);
  });

  const batches: THREE.Mesh[] = [];
  let batchMeshes = 0;
  let removedMeshes = 0;
  let batchIndex = 0;

  const visit = (parent: THREE.Object3D) => {
    // Batch deepest groups first, while preserving every group transform and
    // semantic landmark boundary. Never descend into an exempt subtree.
    for (const child of [...parent.children]) {
      if (child.userData[keepKey]) continue;
      visit(child);
    }

    const buckets = new Map<string, BatchCandidate[]>();
    for (const child of parent.children) {
      if (!isCandidate(child, keepKey)) continue;
      const key = batchKey(child);
      const list = buckets.get(key);
      if (list) list.push(child);
      else buckets.set(key, [child]);
    }

    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      const transformed = list.map((mesh) => {
        mesh.updateMatrix();
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrix);
        return geometry;
      });
      const merged = mergeGeometries(transformed, false);
      for (const geometry of transformed) geometry.dispose();
      if (!merged) continue;

      const exemplar = list[0];
      const batch = new THREE.Mesh(merged, exemplar.material);
      batch.name = `${parent.name || siblingFallbackName}_batch_${++batchIndex}`;
      batch.castShadow = exemplar.castShadow;
      batch.receiveShadow = exemplar.receiveShadow;
      batch.renderOrder = exemplar.renderOrder;
      batch.layers.mask = exemplar.layers.mask;
      batch.frustumCulled = exemplar.frustumCulled;
      batch.matrixAutoUpdate = false;
      batch.updateMatrix();

      for (const mesh of list) {
        parent.remove(mesh);
        const remaining = (geometryRefs.get(mesh.geometry) ?? 1) - 1;
        geometryRefs.set(mesh.geometry, remaining);
        if (remaining === 0) mesh.geometry.dispose();
      }
      parent.add(batch);
      batches.push(batch);
      batchMeshes++;
      removedMeshes += list.length;
    }
  };

  visit(root);

  if (!landmarkPass) {
    return { sourceMeshes, batchMeshes, removedMeshes, batches };
  }

  // A second pass may cross ornamental sub-groups, but never a landmark's
  // direct ownership boundary. Each landmark owner therefore retains a stable
  // name and useful bounds, while repeated pieces nested below it share one
  // render object per compatible state.
  root.updateWorldMatrix(true, true);
  for (const owner of [...root.children]) {
    const ownerMesh = owner as THREE.Mesh;
    if (ownerMesh.isMesh) continue;
    if (owner.userData[keepKey]) continue;
    owner.updateWorldMatrix(true, true);
    const ownerInverse = owner.matrixWorld.clone().invert();
    const buckets = new Map<string, BatchCandidate[]>();
    const collect = (object: THREE.Object3D) => {
      if (object !== owner && object.userData[keepKey]) return; // prune exempt subtree
      if (object !== owner && isCandidate(object, keepKey)) {
        const key = batchKey(object);
        const list = buckets.get(key);
        if (list) list.push(object);
        else buckets.set(key, [object]);
      }
      for (const child of object.children) collect(child);
    };
    collect(owner);

    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      const transformed = list.map((mesh) => {
        mesh.updateWorldMatrix(true, false);
        const toOwner = ownerInverse.clone().multiply(mesh.matrixWorld);
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(toOwner);
        return geometry;
      });
      const merged = mergeGeometries(transformed, false);
      for (const geometry of transformed) geometry.dispose();
      if (!merged) continue;

      const exemplar = list[0];
      const batch = new THREE.Mesh(merged, exemplar.material);
      batch.name = `${owner.name || landmarkFallbackName}_batch_${++batchIndex}`;
      batch.castShadow = exemplar.castShadow;
      batch.receiveShadow = exemplar.receiveShadow;
      batch.renderOrder = exemplar.renderOrder;
      batch.layers.mask = exemplar.layers.mask;
      batch.frustumCulled = exemplar.frustumCulled;
      batch.matrixAutoUpdate = false;
      batch.updateMatrix();

      for (const mesh of list) {
        mesh.removeFromParent();
        const remaining = (geometryRefs.get(mesh.geometry) ?? 1) - 1;
        geometryRefs.set(mesh.geometry, remaining);
        if (remaining === 0) mesh.geometry.dispose();
      }
      owner.add(batch);
      batches.push(batch);
      batchMeshes++;
      removedMeshes += list.length;
    }
  }

  return { sourceMeshes, batchMeshes, removedMeshes, batches };
}
