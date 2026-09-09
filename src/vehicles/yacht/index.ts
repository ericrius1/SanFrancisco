import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildRig, type Rig } from '../../player/rig';
import { avatarFromSeed } from '../../player/avatar';
import { PASSENGERS } from './stories';
export { YachtController } from './controller';
export { yachtEntry } from './entry';
let prototype: THREE.Group | undefined;
let loading: Promise<void> | undefined;
/** Called only by explicit local selection, before compilation/visibility. */
export function prepareYachtAsset(): Promise<void> {
  if (prototype) return Promise.resolve();
  return loading ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    .loadAsync('/models/yacht/elsewhere.glb').then(gltf => {
      prototype = gltf.scene;
      prototype.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return;
        o.castShadow = false; o.receiveShadow = false;
      });
    }).finally(() => { loading = undefined; });
}
export function buildYachtMesh(owned = false): THREE.Group {
  if (!prototype) throw new Error('Prepare the Elsewhere yacht asset before building');
  const root = prototype.clone(true);
  root.name = 'The Elsewhere';
  if (owned) {
    const materials = new Map<THREE.Material, THREE.Material>();
    root.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry = o.geometry.clone();
      const clone = (m: THREE.Material) => { let copy=materials.get(m); if(!copy){copy=m.clone();materials.set(m,copy);} return copy; };
      o.material = Array.isArray(o.material) ? o.material.map(clone) : clone(o.material);
    });
  }
  root.userData.cockpit = { seat: [0,7.9,-9.3], hide: true };
  // One bounded prototype is shared with nearby remotes; no remote-triggered fetch.
  return root;
}
export function addYachtPassengers(root: THREE.Group): Rig[] {
  return PASSENGERS.map(p => {
    const rig = buildRig(avatarFromSeed(p.seed));
    rig.group.name = p.name; rig.group.position.set(p.at[0],p.at[1]+.93,p.at[2]);
    rig.group.rotation.y = .4; root.add(rig.group);
    rig.group.traverse(o => { o.castShadow = false; o.receiveShadow = false; });
    return rig;
  });
}
