import * as THREE from "three/webgpu";

export type StaticRegionWarmup = Readonly<{
  meshes: number;
  representatives: number;
  renderSignatures: number;
  durationMs: number;
}>;

type WarmupMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;

const TEXTURE_SLOTS = [
  "alphaMap",
  "anisotropyMap",
  "aoMap",
  "bumpMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "displacementMap",
  "emissiveMap",
  "envMap",
  "gradientMap",
  "iridescenceMap",
  "iridescenceThicknessMap",
  "lightMap",
  "map",
  "matcap",
  "metalnessMap",
  "normalMap",
  "roughnessMap",
  "sheenColorMap",
  "sheenRoughnessMap",
  "specularColorMap",
  "specularIntensityMap",
  "thicknessMap",
  "transmissionMap"
] as const;

function geometryLayout(geometry: THREE.BufferGeometry): string {
  const attributes = Object.keys(geometry.attributes).sort().map((name) => {
    const attribute = geometry.attributes[name];
    const interleaved = attribute as THREE.InterleavedBufferAttribute;
    return [
      name,
      attribute.itemSize,
      attribute.normalized ? "normalized" : "raw",
      interleaved.isInterleavedBufferAttribute ? interleaved.data.stride : 0,
      interleaved.isInterleavedBufferAttribute ? interleaved.offset : 0
    ].join(":");
  });
  const morphs = geometry.morphAttributes as Record<string, THREE.BufferAttribute[]>;
  const morphAttributes = Object.keys(morphs).sort().map((name) =>
    `${name}:${morphs[name].length}`
  );
  return `${attributes.join(",")}|${morphAttributes.join(",")}|${geometry.index ? "indexed" : "linear"}`;
}

function materialPipelineLayout(material: THREE.Material): string {
  const values = material as THREE.Material & Record<string, unknown>;
  const textures = TEXTURE_SLOTS.map((slot) => {
    const value = values[slot] as THREE.Texture | null | undefined;
    if (!value?.isTexture) return `${slot}:none`;
    return `${slot}:${value.mapping}:${value.magFilter}:${value.minFilter}:${value.wrapS}:${value.wrapT}`;
  });
  return [
    material.type,
    material.customProgramCacheKey(),
    `side:${material.side}`,
    `transparent:${material.transparent}`,
    `alphaTest:${Number(values.alphaTest ?? 0) !== 0}`,
    `alphaHash:${values.alphaHash === true}`,
    `blending:${material.blending}`,
    `premultipliedAlpha:${material.premultipliedAlpha}`,
    `depthTest:${material.depthTest}`,
    `depthWrite:${material.depthWrite}`,
    `colorWrite:${material.colorWrite}`,
    `vertexColors:${values.vertexColors === true}`,
    `flatShading:${values.flatShading === true}`,
    `wireframe:${values.wireframe === true}`,
    ...textures
  ].join("|");
}

function renderableMaterials(mesh: WarmupMesh): THREE.Material[] {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (!Array.isArray(mesh.material) || mesh.geometry.groups.length === 0) return materials;

  const used = new Set<number>();
  for (const group of mesh.geometry.groups) used.add(group.materialIndex ?? 0);
  return [...used]
    .map((index) => materials[index])
    .filter((material): material is THREE.Material => Boolean(material));
}

/**
 * WebGPURenderer.compileAsync builds nodes, bindings and geometry state once per
 * submitted object, even when dozens of Blender instances share one material.
 * A representative for each shader-feature/vertex-layout/object-mode combination
 * warms every distinct render path without serially recompiling every instance.
 *
 * Material values such as color and roughness are uniforms, not pipeline state.
 * The first covered destination render binds those per-material values after the
 * genuinely expensive shader and WebGPU pipeline work has already completed.
 */
function renderSignatures(mesh: WarmupMesh): string[] {
  const objectMode = [
    (mesh as THREE.InstancedMesh).isInstancedMesh === true ? "instanced" : "mesh",
    (mesh as THREE.SkinnedMesh).isSkinnedMesh === true ? "skinned" : "static",
    (mesh as THREE.BatchedMesh).isBatchedMesh === true ? "batched" : "direct"
  ].join(":");
  const layout = `${objectMode}|${geometryLayout(mesh.geometry)}|receiveShadow:${mesh.receiveShadow}`;
  return renderableMaterials(mesh).map((material) => `${materialPipelineLayout(material)}|${layout}`);
}

/** Warm the exact pipelines needed by a parsed static Blender region. */
export async function warmStaticRegion(
  renderer: THREE.WebGPURenderer,
  camera: THREE.Camera,
  scene: THREE.Scene,
  root: THREE.Object3D
): Promise<StaticRegionWarmup> {
  const meshes: WarmupMesh[] = [];
  root.traverse((object) => {
    const mesh = object as WarmupMesh;
    if (mesh.isMesh) meshes.push(mesh);
  });

  const coveredSignatures = new Set<string>();
  const representatives = new Set<WarmupMesh>();
  for (const mesh of meshes) {
    const signatures = renderSignatures(mesh);
    if (signatures.some((signature) => !coveredSignatures.has(signature))) {
      representatives.add(mesh);
      for (const signature of signatures) coveredSignatures.add(signature);
    }
  }

  const state = meshes.map((mesh) => ({
    mesh,
    visible: mesh.visible,
    frustumCulled: mesh.frustumCulled
  }));
  for (const mesh of meshes) {
    mesh.visible = representatives.has(mesh);
    if (mesh.visible) mesh.frustumCulled = false;
  }

  const startedAt = performance.now();
  try {
    await renderer.compileAsync(root, camera, scene);
  } finally {
    for (const entry of state) {
      entry.mesh.visible = entry.visible;
      entry.mesh.frustumCulled = entry.frustumCulled;
    }
  }

  return {
    meshes: meshes.length,
    representatives: representatives.size,
    renderSignatures: coveredSignatures.size,
    durationMs: performance.now() - startedAt
  };
}
