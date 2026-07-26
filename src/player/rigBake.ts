import * as THREE from "three/webgpu";
import { attribute, uniform, vec3 } from "three/tsl";
import type { Rig } from "./rig";
import { enableShadowLayer, SHADOW_LAYERS } from "../world/shadows/shadowLayers";

/**
 * Freeze a fully dressed CLASSIC rig into a single rigidly-skinned mesh.
 *
 * A classic rig (`buildRig(avatar, { merged: false })`) is the only build that
 * supports per-part surgery — reassigning a block's `.material`, parenting extra
 * costume boxes under a joint. That expressiveness costs one draw call per box:
 * a dressed Sutro bather is ~43 meshes, so a dozen of them were 564 draws, more
 * than the entire authored hall.
 *
 * This bakes that finished hierarchy down to ONE SkinnedMesh without changing
 * how it looks or how it animates:
 *  - every visible box is transformed into rig-local BIND space and rigidly
 *    weighted (weight 1) to its own parent joint, so no vertex ever blends
 *    between joints and the result is bit-for-bit the articulated original;
 *  - the rig's existing joint Groups ARE the skeleton bones (a Bone is only an
 *    Object3D with a flag, and Skeleton reads nothing but `matrixWorld`), so
 *    `poseIdle`/`poseSwim`/hand poses and every named joint keep working
 *    untouched — callers pose the same objects they always did;
 *  - each box's flat material colour is baked to a vertex colour, so all the
 *    per-part palette surgery survives under one shared-shape node material
 *    (one pipeline; two baked rigs differ only in buffer contents).
 *
 * Only geometry is frozen. Anything that must keep moving relative to its joint
 * (a held prop) has to stay a real child of that joint — pass it after baking.
 *
 * The caller keeps ownership of the source meshes' materials/geometries: they
 * are returned in `detached` precisely so the existing costume/rig teardown
 * contract (shared box-geometry cache must NOT be disposed) stays unchanged.
 */

export type BakedRig = {
  mesh: THREE.SkinnedMesh;
  /**
   * Self-glow, 0..1, multiplied by each part's own baked colour so a figure
   * lifts out of a dark room without flattening to one flat tint. Lets an
   * indoor scene keep its people readable with no extra scene light.
   */
  setAmbientLift(amount: number): void;
  /** Source meshes lifted out of the hierarchy — the caller still owns them. */
  detached: THREE.Mesh[];
  stats: { sourceMeshes: number; droppedMeshes: number; bones: number; triangles: number };
  /** Frees only what the bake itself allocated. */
  dispose(): void;
};

// TSL node type escape hatch (same convention as src/fx/* and rig.ts).
type N = any;

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

function isHiddenInRig(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node && node !== root; node = node.parent) {
    if (!node.visible) return true;
  }
  return false;
}

/**
 * A part can be hidden by its MATERIAL as well as by its `visible` flag, and the
 * bake has to honour both: bathingCostume suppresses the rig's fixed sunglasses
 * bar by zeroing that material's opacity (it is a per-rig material, so this
 * needs no rig.ts edit). Baking colour without checking opacity turned that
 * invisible bar into a solid black slot across every bather's face.
 */
function isMaterialInvisible(material: THREE.Material | THREE.Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  return list.every((entry) => {
    if (!entry) return true;
    if (entry.visible === false) return true;
    return entry.transparent === true && entry.opacity <= 0.02;
  });
}

function materialColor(material: THREE.Material | THREE.Material[]): THREE.Color {
  const single = Array.isArray(material) ? material[0] : material;
  const tinted = single as THREE.Material & { color?: THREE.Color };
  return tinted?.color ?? new THREE.Color(1, 1, 1);
}

/**
 * @param rig a classic rig, already dressed. Its group transform is neutralised
 *   for the bind pass and restored before returning.
 */
export function bakeRigToSkinnedMesh(rig: Rig, options: { name?: string } = {}): BakedRig {
  const root = rig.group;
  const keptPosition = root.position.clone();
  const keptQuaternion = root.quaternion.clone();
  const keptScale = root.scale.clone();
  const keptAutoUpdate = root.matrixWorldAutoUpdate;

  // Bind space is rig-local: bake with the group at the origin so the baked
  // vertices and bone inverses are independent of where this bather stands.
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.matrixWorldAutoUpdate = true;
  root.updateMatrixWorld(true);

  const sources: THREE.Mesh[] = [];
  // Parts that contribute no pixels: unused variant geometry, and anything a
  // customizer suppressed through its material. They are still LIFTED OUT of the
  // rig — leaving an opacity-zero mesh behind would keep paying a transparent
  // draw call per bather for something nobody can see.
  const dropped: THREE.Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (!mesh.geometry?.attributes?.position) return;
    if (isHiddenInRig(mesh, root) || isMaterialInvisible(mesh.material)) {
      dropped.push(mesh);
      return;
    }
    sources.push(mesh);
  });

  const bones: THREE.Object3D[] = [];
  const boneIndex = new Map<THREE.Object3D, number>();
  const boneFor = (mesh: THREE.Mesh): number => {
    const joint = mesh.parent ?? root;
    let index = boneIndex.get(joint);
    if (index === undefined) {
      index = bones.length;
      bones.push(joint);
      boneIndex.set(joint, index);
    }
    return index;
  };

  const position: number[] = [];
  const normal: number[] = [];
  const color: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const indices: number[] = [];
  let castsShadow = false;

  for (const mesh of sources) {
    const index = boneFor(mesh);
    const geometry = mesh.geometry;
    const sourcePosition = geometry.attributes.position;
    const sourceNormal = geometry.attributes.normal;
    const sourceIndex = geometry.index;
    const tint = materialColor(mesh.material);
    const base = position.length / 3;
    _nm.getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < sourcePosition.count; i++) {
      _v.fromBufferAttribute(sourcePosition, i).applyMatrix4(mesh.matrixWorld);
      position.push(_v.x, _v.y, _v.z);
      if (sourceNormal) {
        _n.fromBufferAttribute(sourceNormal, i).applyMatrix3(_nm).normalize();
        normal.push(_n.x, _n.y, _n.z);
      } else {
        normal.push(0, 1, 0);
      }
      color.push(tint.r, tint.g, tint.b);
      skinIndex.push(index, 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
    }
    if (sourceIndex) {
      for (let i = 0; i < sourceIndex.count; i++) indices.push(base + sourceIndex.getX(i));
    } else {
      for (let i = 0; i < sourcePosition.count; i++) indices.push(base + i);
    }
    if (mesh.castShadow) castsShadow = true;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // Joints swing well outside the bind silhouette (a raised arm, a prone
  // swimmer). Pad the culling sphere so a posed bather never pops out of frame.
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.9;

  const material = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
  material.name = options.name ? `${options.name}_material` : "baked_rig_material";
  // Emissive keyed to the vertex colour, not a flat tint: a navy wool suit and
  // a bare shoulder lift by the same amount in their OWN hue.
  const liftUniform = uniform(0);
  (material as unknown as { emissiveNode: N }).emissiveNode = vec3(
    attribute("color", "vec3") as N
  ).mul(liftUniform as N);

  const boneInverses = bones.map((bone) => bone.matrixWorld.clone().invert());
  const skeleton = new THREE.Skeleton(bones as THREE.Bone[], boneInverses);
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = options.name ?? "baked_rig";
  mesh.castShadow = castsShadow;
  mesh.receiveShadow = true;
  if (castsShadow) enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);
  root.add(mesh);
  mesh.bind(skeleton, new THREE.Matrix4());

  const detached: THREE.Mesh[] = [];
  for (const source of [...sources, ...dropped]) {
    source.removeFromParent();
    detached.push(source);
  }

  root.position.copy(keptPosition);
  root.quaternion.copy(keptQuaternion);
  root.scale.copy(keptScale);
  root.matrixWorldAutoUpdate = keptAutoUpdate;
  root.updateMatrixWorld(true);

  return {
    mesh,
    setAmbientLift(amount) {
      liftUniform.value = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    },
    detached,
    stats: {
      sourceMeshes: sources.length,
      droppedMeshes: dropped.length,
      bones: bones.length,
      triangles: indices.length / 3
    },
    dispose() {
      mesh.removeFromParent();
      skeleton.dispose();
      geometry.dispose();
      material.dispose();
    }
  };
}
