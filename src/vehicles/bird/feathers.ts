import * as THREE from "three/webgpu";
import { float, instanceIndex, mix, positionLocal, sin, time, uv, vec3 } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { featherWind } from "./wind";

/**
 * Plumage layer for the phoenix: solid leathery wing membranes plus fans of
 * instanced feather quads on the trailing edges, all parented straight onto the
 * wing/tail/body bones so they ride the procedural pose for free — no per-frame
 * CPU work at all. Each feather fan is one InstancedMesh (static instance
 * matrices, one draw call each, shared geometry/materials). The wind ripple
 * is pure vertex shader: a travelling wave down each feather, pinned at the
 * quill like the boat's sailcloth, with the amplitude riding a shared airspeed
 * uniform the bird controller writes every step.
 *
 * All placement math happens in rig space (+Z beak, +X left wing, +Y up) and
 * is converted into each bone's own frame via the bone's rest world
 * quaternion — so it must run while the GLB is still unflipped/unscaled,
 * right after load.
 */

const BACK = new THREE.Vector3(0, 0, -1); // trailing edge (beak is +Z)
const UP = new THREE.Vector3(0, 1, 0);

/** Thick tapered wing membrane: local +Y root→tip, ±X chord, ±Z leathery
 * thickness. Wider mid-span like a pterosaur sail, not a flat feather card. */
function membraneGeometry(): THREE.BufferGeometry {
  const T = [0, 0.22, 0.5, 0.78, 1];
  const W = [0.34, 0.58, 0.64, 0.46, 0.14]; // half-chord profile
  const TH = 0.07; // half-thickness — reads as leather, not a plane
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j < T.length; j++) {
    const t = T[j];
    const w = W[j];
    // top surface (+Z)
    pos.push(-w, t, TH, 0, t, TH, w, t, TH);
    nrm.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
    // bottom surface (-Z), slight belly curve
    const belly = w * 0.12;
    pos.push(-w, t, -TH, 0, t - belly, -TH, w, t, -TH);
    nrm.push(0, 0, -1, 0, 0, -1, 0, 0, -1);
  }
  for (let j = 0; j < T.length - 1; j++) {
    const t0 = j * 6;
    const t1 = t0 + 6;
    // top
    idx.push(t0, t0 + 1, t1, t0 + 1, t1 + 1, t1, t0 + 1, t0 + 2, t1 + 1, t0 + 2, t1 + 2, t1 + 1);
    // bottom (wound opposite)
    idx.push(t0 + 3, t1 + 3, t0 + 4, t0 + 4, t1 + 3, t1 + 4, t0 + 4, t1 + 4, t0 + 5, t0 + 5, t1 + 4, t1 + 5);
    // root cap
    if (j === 0) {
      idx.push(t0, t0 + 3, t0 + 4, t0, t0 + 4, t0 + 1, t0 + 1, t0 + 4, t0 + 5, t0 + 1, t0 + 5, t0 + 2);
    }
    // tip cap
    if (j === T.length - 2) {
      idx.push(t1, t1 + 2, t1 + 5, t1, t1 + 5, t1 + 4, t1, t1 + 4, t1 + 1, t1, t1 + 1, t1 + 2);
    }
  }
  // trailing-edge (-X side) and leading-edge (+X) seals
  for (let j = 0; j < T.length - 1; j++) {
    const t0 = j * 6;
    const t1 = t0 + 6;
    idx.push(t0, t1, t0 + 3, t1, t1 + 3, t0 + 3); // -X edge
    idx.push(t0 + 2, t0 + 5, t1 + 2, t0 + 5, t1 + 5, t1 + 2); // +X edge
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Dark leathery wing skin — low emissive, solid volume. */
function membraneMaterial() {
  const mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
  const leather = vec3(0.48, 0.1, 0.03);
  mat.colorNode = leather;
  (mat as unknown as THREE.MeshStandardNodeMaterial).emissiveNode = leather.mul(LIGHT_SCALE * 0.006);
  return mat;
}

/** Warm body flesh for the torso bulk meshes. */
function bodyMaterial() {
  const mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
  const warm = vec3(0.78, 0.22, 0.06);
  mat.colorNode = warm;
  (mat as unknown as THREE.MeshStandardNodeMaterial).emissiveNode = warm.mul(LIGHT_SCALE * 0.012);
  return mat;
}

/** Tapered creased vane: local +Y quill→tip (length 1), width ±X, normal +Z.
 * uv.y is the quill→tip fraction the ripple pins against. */
function featherGeometry(): THREE.BufferGeometry {
  const T = [0, 0.3, 0.6, 0.85, 1];
  const W = [0.06, 0.3, 0.34, 0.22, 0]; // half-width profile
  const pos: number[] = [];
  const uvs: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j < T.length; j++) {
    const t = T[j];
    const w = W[j];
    // edges dip under the spine — the crease keeps the vane from reading as a
    // flat card at grazing angles
    pos.push(-w, t, -w * 0.4, 0, t, 0, w, t, -w * 0.4);
    uvs.push(0, t, 0.5, t, 1, t);
    nrm.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
  }
  for (let j = 0; j < T.length - 1; j++) {
    for (let i = 0; i < 2; i++) {
      const a = j * 3 + i;
      const b = a + 3;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/** Ember-gradient vane with a quill-pinned travelling ripple along local z.
 * Displacement is pre-instance-transform, so it scales with the feather. */
function featherMaterial(phase: number) {
  const mat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
  const t = uv().y;
  const seed = float(instanceIndex).mul(2.4).add(phase);
  const ripple = sin(t.mul(7).sub(time.mul(6.1)).add(seed))
    .mul(0.55)
    .add(sin(t.mul(11).sub(time.mul(9.7)).add(seed.mul(1.7))).mul(0.3));
  const sway = sin(time.mul(1.6).add(seed)).mul(0.35);
  const amp = t.mul(t).mul(featherWind.mul(0.16).add(0.015));
  mat.positionNode = positionLocal.add(vec3(0, 0, ripple.add(sway).mul(amp)));
  const warm = mix(vec3(0.62, 0.09, 0.02), vec3(1.0, 0.55, 0.12), t);
  mat.colorNode = warm;
  // match the plumage's tempered emissive boost, not the eye-searing one.
  // @types/three only declares emissiveNode on the standard node material,
  // but the NodeMaterial runtime reads it for every lit material.
  (mat as unknown as THREE.MeshStandardNodeMaterial).emissiveNode = warm.mul(LIGHT_SCALE * 0.02);
  return mat;
}

type Feather = {
  pos: THREE.Vector3; // bone-local quill position
  dir: THREE.Vector3; // rig-space feather direction (normalized here)
  len: number; // bone-local units
  width: number;
};

const M = new THREE.Matrix4();
const QI = new THREE.Quaternion();
const AX = new THREE.Vector3();
const AY = new THREE.Vector3();
const AZ = new THREE.Vector3();
const SC = new THREE.Vector3();
const RQ = new THREE.Quaternion();

/** One instanced fan on a bone. `vaneUp` is the rig-space direction the vane
 * faces (projected perpendicular to each feather's length axis). */
function attachFan(bone: THREE.Bone, feathers: Feather[], vaneUp: THREE.Vector3, geo: THREE.BufferGeometry, mat: THREE.Material, visible: boolean) {
  const im = new THREE.InstancedMesh(geo, mat, feathers.length);
  im.frustumCulled = false; // rides an animated bone; static bounds lie
  im.castShadow = false;
  // The source skinned GLB supplies the economical caster silhouette. These
  // larger physical vanes still receive, but never multiply shadow-map draws.
  im.receiveShadow = true;
  im.visible = visible;
  bone.getWorldQuaternion(QI).invert(); // rig space → bone local (rest pose)
  for (let i = 0; i < feathers.length; i++) {
    const f = feathers[i];
    AY.copy(f.dir).normalize().applyQuaternion(QI);
    // vane normal = up projected perpendicular to the length axis
    AZ.copy(vaneUp).applyQuaternion(QI);
    AZ.addScaledVector(AY, -AY.dot(AZ)).normalize();
    AX.crossVectors(AY, AZ);
    M.makeBasis(AX, AY, AZ);
    RQ.setFromRotationMatrix(M);
    M.compose(f.pos, RQ, SC.set(f.width, f.len, f.len));
    im.setMatrixAt(i, M);
  }
  bone.add(im);
}

/** Solid leathery wing membrane on a bone. `dir` is rig-space span axis,
 * `len` the membrane length along it, `chord` the root-to-trailing width. */
function attachMembrane(
  bone: THREE.Bone,
  pos: THREE.Vector3,
  dir: THREE.Vector3,
  len: number,
  chord: number,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  visible: boolean
) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.visible = visible;
  bone.getWorldQuaternion(QI).invert();
  AY.copy(dir).normalize().applyQuaternion(QI);
  AZ.copy(UP).applyQuaternion(QI);
  AZ.addScaledVector(AY, -AY.dot(AZ)).normalize();
  AX.crossVectors(AY, AZ);
  M.makeBasis(AX, AY, AZ);
  RQ.setFromRotationMatrix(M);
  mesh.position.copy(pos).applyQuaternion(QI);
  mesh.quaternion.copy(RQ);
  mesh.scale.set(chord, len, chord);
  bone.add(mesh);
}

/** Ellipsoid torso bulk parented on a bone. */
function attachBulk(bone: THREE.Bone, pos: THREE.Vector3, radii: THREE.Vector3, mat: THREE.Material, visible: boolean) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.visible = visible;
  bone.getWorldQuaternion(QI).invert();
  mesh.position.copy(pos).applyQuaternion(QI);
  mesh.scale.copy(radii);
  bone.add(mesh);
}

const boneChild = (b: THREE.Bone) => b.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;

/** Rig-space feather direction: trailing back, splayed outward, drooping. */
function fdir(side: number, out: number, droop: number) {
  return new THREE.Vector3(side * out, -droop, -1).normalize();
}

/** Dress the freshly loaded (still unflipped, unscaled) phoenix skeleton.
 * Returns the two trail anchors riding the outer tail-streamer tips, for
 * fx/birdTrail to glue its light ribbons onto. */
export function dressPhoenix(bones: Record<string, THREE.Bone>, visible: boolean): THREE.Object3D[] {
  const geo = featherGeometry();
  const memGeo = membraneGeometry();
  const matA = featherMaterial(0);
  const matB = featherMaterial(Math.PI); // break L/R mirror-sync in the flutter
  const memMat = membraneMaterial();
  const bulkMat = bodyMaterial();

  const wing = (side: number, mat: THREE.Material) => {
    const arm = bones[side > 0 ? "wing_arm_L" : "wing_arm_R"];
    const forearm = bones[side > 0 ? "wing_forearm_L" : "wing_forearm_R"];
    const hand = bones[side > 0 ? "wing_hand_L" : "wing_hand_R"];
    const armAlong = forearm.position;
    const foreAlong = hand.position;
    const fLen = foreAlong.length();

    // primary leathery sail — shoulder to elbow
    attachMembrane(
      arm,
      armAlong.clone().multiplyScalar(0.08),
      fdir(side, 0.12, 0.06),
      armAlong.length() * 0.96,
      0.92,
      memGeo,
      memMat,
      visible
    );
    // forearm membrane — elbow to wrist
    attachMembrane(
      forearm,
      foreAlong.clone().multiplyScalar(0.06),
      fdir(side, 0.28, 0.05),
      fLen * 0.94,
      0.78,
      memGeo,
      memMat,
      visible
    );
    // hand membrane — outer wing tip wedge
    const handAlong = boneChild(hand)?.position.clone() ?? new THREE.Vector3(side, 0, 0).multiplyScalar(fLen * 0.75);
    attachMembrane(
      hand,
      handAlong.clone().multiplyScalar(0.1),
      fdir(side, 0.55, 0.04),
      fLen * 0.72,
      0.52,
      memGeo,
      memMat,
      visible
    );

    // trailing-edge feather fans — accent the leather, not replace it
    const secondaries: Feather[] = [];
    for (let i = 0; i < 3; i++) {
      const s = i / 2;
      const len = armAlong.length() * (0.65 + 0.12 * s);
      secondaries.push({
        pos: armAlong.clone().multiplyScalar(0.45 + 0.48 * s),
        dir: fdir(side, 0.2 + 0.1 * s, 0.1),
        len,
        width: len * 0.22
      });
    }
    attachFan(arm, secondaries, UP, geo, mat, visible);

    const mids: Feather[] = [];
    for (let i = 0; i < 4; i++) {
      const s = i / 3;
      const len = fLen * (0.75 + 0.12 * s);
      mids.push({
        pos: foreAlong.clone().multiplyScalar(0.2 + 0.72 * s),
        dir: fdir(side, 0.38 + 0.28 * s, 0.08),
        len,
        width: len * 0.2
      });
    }
    attachFan(forearm, mids, UP, geo, mat, visible);

    const primaries: Feather[] = [];
    for (let i = 0; i < 5; i++) {
      const s = i / 4;
      const len = fLen * (1.05 - 0.35 * s);
      primaries.push({
        pos: handAlong.clone().multiplyScalar(0.2 + 0.78 * s),
        dir: fdir(side, 0.5 + 0.75 * s, 0.06),
        len,
        width: len * 0.16
      });
    }
    attachFan(hand, primaries, UP, geo, mat, visible);
  };
  wing(1, matA);
  wing(-1, matB);

  // tail: two spreading fans down the chain plus long tip streamers — the
  // ripple amplitude peaks at uv tips, so the streamers do the big wind dance
  const segLen = (bones.tail02?.position.length() ?? 0.2) || 0.2;
  const tailFan = (bone: THREE.Bone, len: number, mat: THREE.Material) => {
    const fan: Feather[] = [];
    for (let i = 0; i < 4; i++) {
      const lat = (i - 1.5) * 0.36;
      fan.push({ pos: new THREE.Vector3(), dir: new THREE.Vector3(lat, -0.06, -1).normalize(), len, width: len * 0.3 });
    }
    attachFan(bone, fan, UP, geo, mat, visible);
  };
  tailFan(bones.tail02, segLen * 2.4, matA);
  tailFan(bones.tail04, segLen * 2.1, matB);
  const streamers: Feather[] = [];
  for (let i = 0; i < 3; i++) {
    const len = segLen * (4.6 - Math.abs(i - 1) * 0.9);
    streamers.push({
      pos: new THREE.Vector3(),
      dir: new THREE.Vector3((i - 1) * 0.22, -0.18, -1).normalize(),
      len,
      width: len * 0.12
    });
  }
  attachFan(bones.tail05, streamers, UP, geo, matA, visible);

  // trail anchors sit just inside the outer streamer tips (bone-local = rig
  // dir through the rest world quaternion, same convention as attachFan)
  const trailPoints: THREE.Object3D[] = [];
  bones.tail05.getWorldQuaternion(QI).invert();
  for (const i of [0, 2]) {
    const f = streamers[i];
    const o = new THREE.Object3D();
    o.position.copy(f.dir).applyQuaternion(QI).multiplyScalar(f.len * 0.95);
    bones.tail05.add(o);
    trailPoints.push(o);
  }

  // torso bulk — the GLB skin is a thin tube; these ellipsoids give it mass
  const S = bones.wing_forearm_L.position.length();
  attachBulk(bones.chest, new THREE.Vector3(0, -S * 0.08, S * 0.06), new THREE.Vector3(S * 0.42, S * 0.36, S * 0.34), bulkMat, visible);
  attachBulk(bones.chest, new THREE.Vector3(0, -S * 0.22, -S * 0.12), new THREE.Vector3(S * 0.36, S * 0.3, S * 0.38), bulkMat, visible);
  if (bones.spine01) {
    attachBulk(bones.spine01, new THREE.Vector3(0, -S * 0.06, S * 0.04), new THREE.Vector3(S * 0.34, S * 0.28, S * 0.32), bulkMat, visible);
  }

  // breast tuft fills out the torso silhouette; crest gives the head its crown
  const tuft: Feather[] = [];
  for (let i = 0; i < 7; i++) {
    const s = (i - 3) / 3;
    const len = S * 0.52;
    tuft.push({
      pos: new THREE.Vector3(s * S * 0.18, -S * 0.14, S * 0.18).applyQuaternion(bones.chest.getWorldQuaternion(QI).invert()),
      dir: new THREE.Vector3(s * 0.28, -1, -0.42).normalize(),
      len,
      width: len * 0.55
    });
  }
  attachFan(bones.chest, tuft, BACK, geo, matB, visible);

  const crest: Feather[] = [];
  for (let i = 0; i < 4; i++) {
    const len = S * (0.5 + 0.12 * i);
    crest.push({
      pos: new THREE.Vector3(0, 0, 0),
      dir: new THREE.Vector3((i - 1.5) * 0.06, 1, -(0.45 + 0.35 * i)).normalize(),
      len,
      width: len * 0.28
    });
  }
  attachFan(bones.head, crest, new THREE.Vector3(1, 0, 0), geo, matA, visible);

  return trailPoints;
}
