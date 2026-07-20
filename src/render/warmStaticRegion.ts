import * as THREE from "three/webgpu";
import { tracer } from "../core/hitchTracer";

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

export type PacedSceneWarmup = Readonly<{
  meshes: number;
  representatives: number;
  chunks: number;
  durationMs: number;
}>;

/**
 * M6: compile every distinct mesh render path in the live scene in SMALL
 * exclusive-compile windows instead of one monolithic compileAsync(scene).
 * The renderer's compile gate (pipeline.ts) holds live rendering while a
 * compile is in flight, so a single whole-scene compile freezes the frame for
 * its full duration (hundreds of ms after P3 construction). Compiling one
 * signature representative at a time and calling `pace()` whenever the chunk
 * budget is spent keeps each frozen window bounded while covering the same
 * signature set (compileAsync(mesh, camera, scene) shares cache keys with
 * live renders — three r185 resolves sceneRef to the target scene).
 *
 * Representatives are compiled with visible/frustumCulled forced on for the
 * mesh only (compile roots at the mesh, so ancestors are never consulted) and
 * restored immediately after — hidden gated content stays hidden.
 */
export async function warmScenePaced(
  renderer: THREE.WebGPURenderer,
  camera: THREE.Camera,
  scene: THREE.Scene,
  pace: () => Promise<void>,
  // M10: 35 ms chunks read as a wall of ~40 ms frames through the whole sweep
  // (the chunk lands inside one rAF interval on top of the normal frame).
  // 8 ms keeps a chunk + frame comfortably under 20 ms; a single oversized
  // compile still overruns its chunk, but those are rare after the first runs.
  chunkBudgetMs = 8
): Promise<PacedSceneWarmup> {
  const meshes: WarmupMesh[] = [];
  scene.traverse((object) => {
    const mesh = object as WarmupMesh;
    if (mesh.isMesh) meshes.push(mesh);
  });

  // Signature strings over thousands of meshes are themselves a synchronous
  // lump — pace the dedup sweep on the same budget as the compiles.
  const coveredSignatures = new Set<string>();
  const representatives: WarmupMesh[] = [];
  const startedAt = performance.now();
  let chunks = 1;
  let chunkStartedAt = startedAt;
  for (const mesh of meshes) {
    const signatures = renderSignatures(mesh);
    if (signatures.some((signature) => !coveredSignatures.has(signature))) {
      representatives.push(mesh);
      for (const signature of signatures) coveredSignatures.add(signature);
    }
    if (performance.now() - chunkStartedAt > chunkBudgetMs) {
      await pace();
      chunks++;
      chunkStartedAt = performance.now();
    }
  }
  for (const mesh of representatives) {
    // The scene mutates between paced chunks (streamers attach/detach); a mesh
    // that left the scene since collection no longer needs its warm here.
    let attached: THREE.Object3D | null = mesh;
    while (attached && !(attached as THREE.Scene).isScene) attached = attached.parent;
    if (!attached) continue;
    const visible = mesh.visible;
    const frustumCulled = mesh.frustumCulled;
    mesh.visible = true;
    mesh.frustumCulled = false;
    try {
      await renderer.compileAsync(mesh, camera, scene);
      tracer.count("pacedWarmCompile");
    } catch {
      // A single failed representative must not abort the sweep; its material
      // simply compiles on first draw as before.
    } finally {
      mesh.visible = visible;
      mesh.frustumCulled = frustumCulled;
    }
    if (performance.now() - chunkStartedAt > chunkBudgetMs) {
      await pace();
      chunks++;
      chunkStartedAt = performance.now();
    }
  }

  return {
    meshes: meshes.length,
    representatives: representatives.length,
    chunks,
    durationMs: performance.now() - startedAt
  };
}

/**
 * Paced variant scoped to one (possibly detached) subtree: compile a signature
 * representative per distinct render path under `root`, yielding through
 * `pace()` on the chunk budget. Optional-site roots used to warm through ONE
 * monolithic compileAsync(root) — measured ~1 s of gate-held (frozen) frames
 * when a dense site (Beach Pianist grove) hydrated at a teleport arrival.
 * Detached roots skip the scene-membership check warmScenePaced performs (the
 * caller owns the subtree's lifecycle for the duration).
 */
export async function warmRootPaced(
  renderer: THREE.WebGPURenderer,
  camera: THREE.Camera,
  scene: THREE.Scene,
  root: THREE.Object3D,
  pace: () => Promise<void>,
  chunkBudgetMs = 8
): Promise<PacedSceneWarmup> {
  const meshes: WarmupMesh[] = [];
  root.traverse((object) => {
    const mesh = object as WarmupMesh;
    if (mesh.isMesh) meshes.push(mesh);
  });
  const coveredSignatures = new Set<string>();
  const representatives: WarmupMesh[] = [];
  const startedAt = performance.now();
  let chunks = 1;
  let chunkStartedAt = startedAt;
  for (const mesh of meshes) {
    const signatures = renderSignatures(mesh);
    if (signatures.some((signature) => !coveredSignatures.has(signature))) {
      representatives.push(mesh);
      for (const signature of signatures) coveredSignatures.add(signature);
    }
    if (performance.now() - chunkStartedAt > chunkBudgetMs) {
      await pace();
      chunks++;
      chunkStartedAt = performance.now();
    }
  }
  for (const mesh of representatives) {
    const visible = mesh.visible;
    const frustumCulled = mesh.frustumCulled;
    mesh.visible = true;
    mesh.frustumCulled = false;
    try {
      await renderer.compileAsync(mesh, camera, scene);
      tracer.count("pacedWarmCompile");
    } catch {
      // A failed representative compiles on first draw as before.
    } finally {
      mesh.visible = visible;
      mesh.frustumCulled = frustumCulled;
    }
    if (performance.now() - chunkStartedAt > chunkBudgetMs) {
      await pace();
      chunks++;
      chunkStartedAt = performance.now();
    }
  }
  return {
    meshes: meshes.length,
    representatives: representatives.length,
    chunks,
    durationMs: performance.now() - startedAt
  };
}

/**
 * M10: compile only the meshes among `meshes` that introduce a render
 * signature not in `seen` (which is updated in place). Used by the tile
 * streamer's finalize hook: the FIRST streamed tile's bundle materials
 * (facade near/far, road/park/plain sets) used to sync-create ~45 pipelines
 * inside a live frame on first draw (measured ~600 ms warm-cache, seconds
 * cold); later tiles share the same signatures and cost nothing. Compiles run
 * through the renderer's gated compileAsync, so live frames hold instead of
 * drawing mid-compile.
 */
export async function warmUnseenMeshSignatures(
  renderer: THREE.WebGPURenderer,
  camera: THREE.Camera,
  scene: THREE.Scene,
  meshes: readonly THREE.Object3D[],
  seen: Set<string>
): Promise<number> {
  const fresh: WarmupMesh[] = [];
  for (const object of meshes) {
    const mesh = object as WarmupMesh;
    if (!mesh.isMesh) continue;
    const signatures = renderSignatures(mesh);
    if (signatures.some((signature) => !seen.has(signature))) {
      fresh.push(mesh);
      for (const signature of signatures) seen.add(signature);
    }
  }
  for (const mesh of fresh) {
    const visible = mesh.visible;
    const frustumCulled = mesh.frustumCulled;
    mesh.visible = true;
    mesh.frustumCulled = false;
    try {
      await renderer.compileAsync(mesh, camera, scene);
      tracer.count("tileSignatureWarm");
    } catch {
      // A failed representative compiles on first draw as before.
    } finally {
      mesh.visible = visible;
      mesh.frustumCulled = frustumCulled;
    }
  }
  return fresh.length;
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
