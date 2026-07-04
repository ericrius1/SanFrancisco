import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { rippleWingMaterial } from "../../fx/cloth";

/**
 * The truck-bed bald eagle, loaded from /models/eagle.glb — a segmented
 * patriotic eagle draped in US flags (Tripo export, 8 parts under a ROOT node).
 * Replaces the old procedural feather-card build. The two flag wings
 * (tripo_part_0 / tripo_part_7, a mirror pair) keep flapping like cloth: a
 * shoulder-anchored wind ripple (see {@link rippleWingMaterial}) billows the
 * feathered membrane while the rest of the bird stays solid.
 *
 * Loads async (the group is returned empty and populated on arrival, like the
 * phoenix/guitarist). Local origin ends up at the feet; front is -Z to match the
 * truck's forward. The GLB is kept at raw scale — never quantise it, the ripple
 * displaces along positionLocal and quantisation amplifies that ~420×.
 */

// eagle height in local units, before buildTruckMesh's 1.55× scale
const TARGET_HEIGHT = 2.2;
// GLB facing → game front (-Z). Tuned by eye against the truck.
const FACING_Y = Math.PI;
// the US-flag mirror-pair wings (Tripo node names) that get the cloth ripple
const WING_PARTS = new Set(["tripo_part_0", "tripo_part_7"]);

/** Swap a wing mesh's material for a wind-rippled one, anchored at the shoulder
 * (the wing vertex nearest the body centre) so the ripple grows out to the tip. */
function applyWingRipple(mesh: THREE.Mesh, modelCenterWorld: THREE.Vector3, idx: number) {
  const pos = mesh.geometry.getAttribute("position");
  mesh.updateMatrixWorld(true);
  const centerLocal = modelCenterWorld.clone().applyMatrix4(mesh.matrixWorld.clone().invert());

  const v = new THREE.Vector3();
  const shoulder = new THREE.Vector3();
  let best = Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = v.distanceToSquared(centerLocal);
    if (d < best) {
      best = d;
      shoulder.copy(v);
    }
  }
  let reach = 1e-3;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    reach = Math.max(reach, v.distanceTo(shoulder));
  }

  const map = (mesh.material as THREE.MeshStandardMaterial).map ?? undefined;
  mesh.material = rippleWingMaterial({
    map,
    shoulder,
    reach,
    amp: reach * 0.16,
    phase: idx * Math.PI // desync the two wings
  });
  mesh.frustumCulled = false; // the displacement grows the mesh bounds
  mesh.castShadow = true;
}

export function buildEagle(): THREE.Group {
  const g = new THREE.Group();

  new GLTFLoader().load("/models/eagle.glb", (gltf) => {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);

    // body centre in raw coords — the wings' shoulder sits nearest here
    const modelCenter = new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3());

    let wing = 0;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (WING_PARTS.has(mesh.name)) applyWingRipple(mesh, modelCenter, wing++);
    });

    // recentre so the feet rest at group y=0 and the bird sits on the x/z axis
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    scene.position.set(-ctr.x, -box.min.y, -ctr.z);

    // scale to the intended height and face the bird down the truck (-Z)
    const holder = new THREE.Group();
    holder.add(scene);
    holder.scale.setScalar(TARGET_HEIGHT / Math.max(1e-3, size.y));
    holder.rotation.y = FACING_Y;
    g.add(holder);
  });

  return g;
}
