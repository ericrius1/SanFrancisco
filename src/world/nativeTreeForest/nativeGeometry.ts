import * as THREE from "three/webgpu";
import { releaseRendererAttribute } from "../../app/rendererRegistry";
import type {
  CompiledTreeLod,
  CompiledTreeMesh,
  CompiledTreePrototype,
  CompiledTreeStats,
  TreeBounds,
  VertexAttributeSemantic
} from "../treeCompiler";

const ATTRIBUTE_NAMES: Record<VertexAttributeSemantic, string> = {
  position: "position",
  normal: "normal",
  uv: "uv",
  anchor: "aTreeAnchor",
  wind: "aTreeWind",
  material: "aTreeMaterial"
};

export type NativeTreeLodGeometry = {
  name: string;
  branch: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
  bounds: TreeBounds;
  triangles: number;
};

export type NativeTreeGeometryPrototype = {
  recipeName: string;
  seed: number;
  skeletonFingerprint: string;
  lods: readonly NativeTreeLodGeometry[];
  bounds: TreeBounds;
  /** Crown ellipsoid used only for distant beauty-pass normal shaping. */
  canopy: Readonly<{ center: readonly [number, number, number]; radii: readonly [number, number, number] }>;
  stats: CompiledTreeStats;
  /** Release the shared prototype buffers only when no forest can use them. */
  dispose(): void;
};

export type TreeInstanceGeometry = {
  geometry: THREE.InstancedBufferGeometry;
  root: THREE.StorageInstancedBufferAttribute;
  yaw: THREE.StorageInstancedBufferAttribute;
};

const INSTANCE_ATTRIBUTE_NAMES = new Set(["aTreeRoot", "aTreeYaw"]);

function applyBounds(geometry: THREE.BufferGeometry, bounds: TreeBounds): void {
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(...bounds.min),
    new THREE.Vector3(...bounds.max)
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(...bounds.sphereCenter),
    bounds.sphereRadius
  );
}

function createSharedGeometry(mesh: CompiledTreeMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const interleaved = new THREE.InterleavedBuffer(mesh.vertices, mesh.vertexStrideFloats);
  interleaved.setUsage(THREE.StaticDrawUsage);
  for (const layout of mesh.attributes) {
    geometry.setAttribute(
      ATTRIBUTE_NAMES[layout.semantic],
      new THREE.InterleavedBufferAttribute(
        interleaved,
        layout.components,
        layout.offsetFloats,
        false
      )
    );
  }
  const index = new THREE.BufferAttribute(mesh.indices, 1);
  index.setUsage(THREE.StaticDrawUsage);
  geometry.setIndex(index);
  applyBounds(geometry, mesh.bounds);
  geometry.userData.nativeTreeShared = true;
  geometry.userData.byteLength = mesh.vertices.byteLength + mesh.indices.byteLength;
  return geometry;
}

function createLodGeometry(lod: CompiledTreeLod): NativeTreeLodGeometry {
  return {
    name: lod.name,
    branch: createSharedGeometry(lod.branch),
    foliage: createSharedGeometry(lod.foliage),
    bounds: lod.bounds,
    triangles: lod.stats.triangles
  };
}

function disposeSharedGeometry(geometry: THREE.BufferGeometry): void {
  // Instance wrappers detach these borrowed objects before disposal. At final
  // cache eviction no renderable geometry owns them, so explicitly free the
  // WebGPU attribute records before disposing the CPU-side prototype shell.
  for (const attribute of Object.values(geometry.attributes)) {
    releaseRendererAttribute(attribute);
  }
  if (geometry.index) releaseRendererAttribute(geometry.index);
  geometry.dispose();
}

/** Upload-ready geometry wrappers; the compiler skeleton can be reclaimed here. */
export function createNativeTreeGeometryPrototype(
  compiled: CompiledTreePrototype
): NativeTreeGeometryPrototype {
  const lods = compiled.lods.map(createLodGeometry);
  const foliageBounds = compiled.lods[0]?.foliage.bounds ?? compiled.bounds;
  const canopy = Object.freeze({
    center: Object.freeze([
      (foliageBounds.min[0] + foliageBounds.max[0]) * 0.5,
      (foliageBounds.min[1] + foliageBounds.max[1]) * 0.5,
      (foliageBounds.min[2] + foliageBounds.max[2]) * 0.5
    ] as const),
    radii: Object.freeze([
      Math.max(0.01, (foliageBounds.max[0] - foliageBounds.min[0]) * 0.5),
      Math.max(0.01, (foliageBounds.max[1] - foliageBounds.min[1]) * 0.5),
      Math.max(0.01, (foliageBounds.max[2] - foliageBounds.min[2]) * 0.5)
    ] as const)
  });
  let disposed = false;
  return {
    recipeName: compiled.recipeName,
    seed: compiled.seed,
    skeletonFingerprint: compiled.skeletonFingerprint,
    lods,
    bounds: compiled.bounds,
    canopy,
    stats: compiled.stats,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const lod of lods) {
        disposeSharedGeometry(lod.branch);
        disposeSharedGeometry(lod.foliage);
      }
    }
  };
}

/**
 * A lightweight per-batch wrapper around shared prototype vertex/index data.
 * Only the two compact instance-storage attributes are owned by this geometry.
 */
export function createTreeInstanceGeometry(
  shared: THREE.BufferGeometry,
  capacity: number,
  instanceAttributes?: Pick<TreeInstanceGeometry, "root" | "yaw">,
  instanceUsage: THREE.Usage = THREE.StaticDrawUsage
): TreeInstanceGeometry {
  // Deliberately use an InstancedBufferGeometry on a plain Mesh instead of an
  // InstancedMesh. Three r185 keys every InstancedMesh NodeMaterial build by
  // object UUID because its built-in instanceMatrix node captures that object's
  // buffer. Native trees already carry their complete transform in the named
  // root/yaw attributes, so keeping the transform in the geometry layout lets
  // WebGPU safely reuse one NodeBuilder state and render pipeline across chunks.
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.instanceCount = capacity;
  for (const [name, attribute] of Object.entries(shared.attributes)) {
    geometry.setAttribute(name, attribute);
  }
  geometry.setIndex(shared.index);
  geometry.boundingBox = shared.boundingBox?.clone() ?? null;
  geometry.boundingSphere = shared.boundingSphere?.clone() ?? null;

  const root = instanceAttributes?.root ?? new THREE.StorageInstancedBufferAttribute(capacity, 4);
  const yaw = instanceAttributes?.yaw ?? new THREE.StorageInstancedBufferAttribute(capacity, 4);
  if (!instanceAttributes) {
    root.setUsage(instanceUsage);
    yaw.setUsage(instanceUsage);
  }
  geometry.setAttribute("aTreeRoot", root);
  geometry.setAttribute("aTreeYaw", yaw);
  geometry.userData.nativeTreeInstanceWrapper = true;
  geometry.userData.nativeTreeSharedAttributeNames = Object.keys(shared.attributes);
  return { geometry, root, yaw };
}

/**
 * Detach a batch wrapper without invalidating the immutable prototype buffers
 * referenced by every other batch. The wrapper owns only its instance storage;
 * its vertex attributes and index are borrowed from the compiled prototype.
 */
export function detachTreeInstanceGeometry(wrapper: TreeInstanceGeometry): void {
  const { geometry } = wrapper;
  const sharedNames = geometry.userData.nativeTreeSharedAttributeNames;
  if (Array.isArray(sharedNames)) {
    for (const name of sharedNames) {
      if (typeof name === "string" && !INSTANCE_ATTRIBUTE_NAMES.has(name)) {
        geometry.deleteAttribute(name);
      }
    }
  }
  geometry.setIndex(null);
}

/** Dispatch disposal after every wrapper in a batch has detached its borrows. */
export function disposeTreeInstanceGeometry(wrapper: TreeInstanceGeometry): void {
  detachTreeInstanceGeometry(wrapper);
  wrapper.geometry.dispose();
}
