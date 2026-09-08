import * as THREE from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { BirdSpeciesId } from './catalog';

export const CLIP_FRAMES = 48;
export const CLIP_ROWS = CLIP_FRAMES + 1;
export const CLIPS = ['Fly', 'Glide', 'Scatter', 'Perch'] as const;
export interface BirdAsset {
  geometry: THREE.BufferGeometry;
  lods: THREE.BufferGeometry[];
  lodFormatsMatch: boolean;
  atlas: THREE.DataTexture;
  textureBytes: number;
  boneCount: number;
  map: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  durations: number[];
  influences: number;
  dispose(): void;
}
/** Once per resident species: sample the edited Blender rig, including quantization
 * transforms. The GPU shares this 43 KB atlas across every instance and habitat. */
export async function loadBirdAsset(id: BirdSpeciesId, renderer: THREE.WebGPURenderer, baseUrl = '/models/aviary/', transcoderPath = '/native-foliage/basis-r185/'): Promise<BirdAsset> {
  const ktx = new KTX2Loader().setTranscoderPath(transcoderPath).setWorkerLimit(1).detectSupport(renderer);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx);
  let gltf;
  try { gltf = await loader.loadAsync(`${baseUrl}${id}.glb`); } finally { ktx.dispose(); }
  const meshes: THREE.SkinnedMesh[] = [];
  gltf.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
  if (meshes.length !== 1) throw new Error(`[aviary] ${id}: expected one skinned mesh`);
  const mesh = meshes[0];
  const sourceMaterial = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
  const map = sourceMaterial.map, normalMap = sourceMaterial.normalMap;
  const boneCount = mesh.skeleton.bones.length;
  const width = boneCount * 4, height = CLIP_ROWS * CLIPS.length;
  const data = new Uint16Array(width * height * 4);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const durations: number[] = [];
  const matrix = new THREE.Matrix4(), bone = new THREE.Matrix4();
  for (let clipIndex = 0; clipIndex < CLIPS.length; clipIndex++) {
    const clip = gltf.animations.find(c => c.name === CLIPS[clipIndex]);
    if (!clip) throw new Error(`[aviary] missing ${CLIPS[clipIndex]} in ${id}`);
    durations.push(clip.duration);
    mixer.stopAllAction(); const action = mixer.clipAction(clip); action.reset().play();
    for (let frame = 0; frame <= CLIP_FRAMES; frame++) {
      // Duplicate the first row at the end for seamless filtered interpolation.
      mixer.setTime((frame % CLIP_FRAMES) / CLIP_FRAMES * clip.duration);
      gltf.scene.updateMatrixWorld(true); mesh.skeleton.update();
      for (let b = 0; b < boneCount; b++) {
        bone.fromArray(mesh.skeleton.boneMatrices!, b * 16);
        matrix.copy(mesh.matrixWorld).multiply(mesh.bindMatrixInverse).multiply(bone).multiply(mesh.bindMatrix);
        const offset = ((clipIndex * CLIP_ROWS + frame) * width + b * 4) * 4;
        for (let k = 0; k < 16; k++) data[offset + k] = THREE.DataUtils.toHalfFloat(matrix.elements[k]);
      }
    }
    // Yield between clips; preparation never occupies a whole loading frame.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
  const geometry = mesh.geometry.clone();
  // Quantized position attributes remain in their authored local space. The
  // sampled skin matrices above include their decoding scale/translation.
  const weights = geometry.getAttribute('skinWeight');
  let influences = 1;
  for (let i = 0; i < weights.count; i++) for (let k = 1; k < 4; k++) {
    if (weights.getComponent(i, k) > 0) influences = Math.max(influences, k + 1);
  }
  // Index-only LODs retain the authored silhouette, UVs and skin weights. The
  // small tiers compact vertices; no additional model/texture requests.
  await MeshoptSimplifier.ready;
  const sourcePosition = geometry.getAttribute('position');
  const points = new Float32Array(sourcePosition.count * 3);
  for (let i = 0; i < sourcePosition.count; i++) points.set([sourcePosition.getX(i), sourcePosition.getY(i), sourcePosition.getZ(i)], i * 3);
  const indices = new Uint32Array(geometry.index!.array);
  const lods = [geometry];
  for (const triangles of [2200, 420]) {
    const [reduced] = MeshoptSimplifier.simplifySloppy(indices, points, 3, null, triangles * 3, 1);
    const remap = new Map<number, number>();
    const compact = Uint32Array.from(reduced, index => { if (!remap.has(index)) remap.set(index, remap.size); return remap.get(index)!; });
    const lod = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      // Preserve the source vertex formats. Sharing one material across LODs
      // must not change normalized integer joint/weight/position layouts.
      const source = attribute as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
      const ArrayType = source.array.constructor as typeof Float32Array;
      const values = new ArrayType(remap.size * source.itemSize);
      const interleaved = source as THREE.InterleavedBufferAttribute;
      const stride = interleaved.isInterleavedBufferAttribute ? interleaved.data.stride : source.itemSize;
      const offset = interleaved.isInterleavedBufferAttribute ? interleaved.offset : 0;
      for (const [old, index] of remap) for (let k = 0; k < source.itemSize; k++) values[index * source.itemSize + k] = source.array[old * stride + offset + k];
      lod.setAttribute(name, new THREE.BufferAttribute(values, source.itemSize, source.normalized));
    }
    lod.setIndex(new THREE.BufferAttribute(compact, 1));
    lods.push(lod);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  // WebGPU may widen byte attributes on upload. Compare authored formats
  // now, before some tiers have rendered and others are still CPU-only.
  const lodFormatsMatch = lods.every(g => Object.entries(geometry.attributes).every(([name, attr]) => g.getAttribute(name).normalized === attr.normalized && g.getAttribute(name).array.constructor === attr.array.constructor));
  const atlas = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  atlas.magFilter = atlas.minFilter = THREE.LinearFilter;
  atlas.generateMipmaps = false; atlas.needsUpdate = true;
  gltf.scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.geometry.dispose(); for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose(); }
  });
  mesh.skeleton.dispose();
  const textureBytes = data.byteLength + [map, normalMap].reduce((sum, t) => sum + (t?.mipmaps ?? []).reduce((n, mip) => n + ((mip as { data?: { byteLength: number } }).data?.byteLength ?? 0), 0), 0);
  return { geometry, lods, lodFormatsMatch, atlas, map, normalMap, textureBytes, boneCount, durations, influences, dispose() { for (const lod of lods) lod.dispose(); atlas.dispose(); map?.dispose(); normalMap?.dispose(); } };
}
