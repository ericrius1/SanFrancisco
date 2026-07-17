import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type TeaStaticBatchStats = Readonly<{
  sourceMeshes: number;
  batchMeshes: number;
  removedMeshes: number;
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

function isCandidate(object: THREE.Object3D): object is BatchCandidate {
  const mesh = object as THREE.Mesh;
  return Boolean(
    mesh.isMesh &&
    !(mesh as THREE.InstancedMesh).isInstancedMesh &&
    !(mesh as THREE.SkinnedMesh).isSkinnedMesh &&
    mesh.visible &&
    !Array.isArray(mesh.material) &&
    mesh.geometry.getAttribute("position") &&
    !mesh.morphTargetInfluences &&
    !mesh.userData.keepTeaGardenMesh
  );
}

/**
 * Collapse sibling-only static Tea Garden meshes by material/render state.
 *
 * The pass deliberately retains the authored group tree. Physics, light
 * anchors, landmark names, animated koi, instanced bridge pieces, and Hiro's
 * rig remain independent objects; only inert leaf meshes inside a shared
 * parent are merged in that parent's local space.
 */
export function batchTeaGardenStatics(root: THREE.Object3D): TeaStaticBatchStats {
  const geometryRefs = new Map<THREE.BufferGeometry, number>();
  let sourceMeshes = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    sourceMeshes++;
    geometryRefs.set(mesh.geometry, (geometryRefs.get(mesh.geometry) ?? 0) + 1);
  });

  let batchMeshes = 0;
  let removedMeshes = 0;
  let batchIndex = 0;

  const visit = (parent: THREE.Object3D) => {
    // Batch deepest groups first, while preserving every group transform and
    // semantic landmark boundary.
    for (const child of [...parent.children]) visit(child);

    const buckets = new Map<string, BatchCandidate[]>();
    for (const child of parent.children) {
      if (!isCandidate(child)) continue;
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
      batch.name = `${parent.name || "tea_static"}_batch_${++batchIndex}`;
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
      batchMeshes++;
      removedMeshes += list.length;
    }
  };

  visit(root);

  // A second pass may cross ornamental sub-groups, but never a landmark's
  // direct ownership boundary. Tea House, each bridge/building, paths, pond
  // life and every lantern therefore retain stable names and useful bounds,
  // while repeated timber/stone pieces nested below them share one render
  // object per compatible state.
  root.updateWorldMatrix(true, true);
  for (const owner of [...root.children]) {
    const ownerMesh = owner as THREE.Mesh;
    if (ownerMesh.isMesh) continue;
    owner.updateWorldMatrix(true, true);
    const ownerInverse = owner.matrixWorld.clone().invert();
    const buckets = new Map<string, BatchCandidate[]>();
    owner.traverse((object) => {
      if (object === owner || !isCandidate(object)) return;
      const key = batchKey(object);
      const list = buckets.get(key);
      if (list) list.push(object);
      else buckets.set(key, [object]);
    });

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
      batch.name = `${owner.name || "tea_landmark"}_batch_${++batchIndex}`;
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
      batchMeshes++;
      removedMeshes += list.length;
    }
  }

  return { sourceMeshes, batchMeshes, removedMeshes };
}
