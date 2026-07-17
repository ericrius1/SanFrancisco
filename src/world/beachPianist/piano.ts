import * as THREE from "three/webgpu";
import { enableShadowLayer, SHADOW_LAYERS } from "../shadows/shadowLayers";
import {
  BLACK_MIDIS,
  KEY_CENTER_X,
  KEYBOARD,
  WHITE_MIDIS,
  WHITE_WIDTH
} from "./keys";

/**
 * A chunky voxel GRAND piano, dark near-black wood. Wing-shaped case
 * approximated by stacked boxes (wide front body + narrower angled tail), an
 * open lid propped on a stick, three legs, a pedal lyre, and a matching bench.
 *
 * The 88 keys are TWO InstancedMesh (52 whites + 36 blacks), so the whole
 * keyboard is two draws. Only currently-pressed keys have their instance matrix
 * refreshed each frame — a pressed key sinks and tips its front edge down.
 *
 * Local frame: the pianist sits at the origin facing -Z; the keyboard is in
 * front of him (toward -Z) with the bass at +X, the wing body and open lid
 * stretch further away, and the bench sits behind him at +Z.
 */

// Where the front lip of the keys sits (the hand-contact line) and its height.
export const KEY_CONTACT = { z: -0.34, top: 0.72 } as const;

const KEYBED_Z = KEY_CONTACT.z - KEYBOARD.whiteDepth * 0.5; // centre of the key row

type OwnedPiano = {
  group: THREE.Group;
  whiteKeys: THREE.InstancedMesh;
  blackKeys: THREE.InstancedMesh;
  /** Press a key by its slot within its own instanced mesh (0 = rest, 1 = fully down). */
  setWhitePress: (slot: number, amount: number) => void;
  setBlackPress: (slot: number, amount: number) => void;
  /** Upload any pending key-matrix edits (call once per animated frame). */
  flushKeys: () => void;
  dispose: () => void;
};

export function buildGrandPiano(): OwnedPiano {
  const group = new THREE.Group();
  group.name = "beachPianist.piano";

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const own = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };
  const mat = (color: number): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial({ color });
    mats.push(m);
    return m;
  };
  const box = (
    parent: THREE.Object3D,
    material: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number
  ): THREE.Mesh => {
    const m = new THREE.Mesh(own(new THREE.BoxGeometry(w, h, d)), material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  const wood = mat(0x171310); // near-black, faint brown
  const woodWarm = mat(0x211913); // slightly warmer edge/trim wood
  const brass = mat(0x9c7b39); // pedals + hardware
  const feltDark = mat(0x0d0b0a); // under the open lid / key slip

  // ---- case (rim): wide front body + narrower angled tail approximate a wing.
  const RIM_TOP = KEY_CONTACT.top; // rim top sits at keyboard height
  const RIM_H = 0.24;
  const rimY = RIM_TOP - RIM_H * 0.5;
  box(group, wood, 1.42, RIM_H, 0.66, 0, rimY, KEYBED_Z - 0.68); // front body
  box(group, wood, 0.84, RIM_H, 0.72, 0.2, rimY, KEYBED_Z - 1.36); // tail, biased to the straight bass side
  box(group, woodWarm, 1.46, 0.04, 0.7, 0, RIM_TOP + 0.005, KEYBED_Z - 0.68); // top rim cap
  // soundboard well (dark) just under the lid so the open case doesn't look solid
  box(group, feltDark, 1.24, 0.02, 0.86, 0, RIM_TOP - 0.02, KEYBED_Z - 0.9);

  // ---- key slip / fallboard + cheek blocks framing the keyboard
  box(group, woodWarm, KEYBOARD.width + 0.12, 0.09, 0.06, 0, RIM_TOP - 0.02, KEY_CONTACT.z + 0.02); // front key slip
  box(group, wood, 0.09, 0.16, KEYBOARD.whiteDepth + 0.14, KEYBOARD.width * 0.5 + 0.06, RIM_TOP - 0.05, KEYBED_Z); // bass cheek
  box(group, wood, 0.09, 0.16, KEYBOARD.whiteDepth + 0.14, -KEYBOARD.width * 0.5 - 0.06, RIM_TOP - 0.05, KEYBED_Z); // treble cheek
  box(group, woodWarm, KEYBOARD.width + 0.24, 0.14, 0.08, 0, RIM_TOP - 0.02, KEYBED_Z - KEYBOARD.whiteDepth * 0.5 - 0.08); // fallboard behind keys

  // ---- keybed slab the keys rest on (dark, just below key tops)
  box(group, feltDark, KEYBOARD.width + 0.02, 0.05, KEYBOARD.whiteDepth, 0, RIM_TOP - KEYBOARD.whiteHeight - 0.03, KEYBED_Z);

  // ---- legs (2 front + 1 tail) down to the sand
  const legH = rimY - RIM_H * 0.5; // rim bottom to y=0
  const legY = legH * 0.5;
  box(group, wood, 0.11, legH, 0.11, KEYBOARD.width * 0.5 - 0.02, legY, KEY_CONTACT.z - 0.14); // front bass
  box(group, wood, 0.11, legH, 0.11, -KEYBOARD.width * 0.5 + 0.02, legY, KEY_CONTACT.z - 0.14); // front treble
  box(group, wood, 0.12, legH, 0.12, 0.28, legY, KEYBED_Z - 1.62); // tail

  // ---- pedal lyre at front centre, brass pedals near the feet
  box(group, wood, 0.08, legH * 0.62, 0.08, 0, legH * 0.31, KEY_CONTACT.z - 0.22);
  box(group, woodWarm, 0.26, 0.05, 0.16, 0, 0.05, KEY_CONTACT.z - 0.4);
  for (const px of [-0.06, 0, 0.06]) box(group, brass, 0.04, 0.02, 0.14, px, 0.06, KEY_CONTACT.z - 0.46);

  // ---- open lid: a thin slab hinged along the +X (bass) spine, tipped up, plus
  // a prop stick under the raised treble edge.
  const spineX = KEYBOARD.width * 0.5 + 0.04;
  const lidAngle = 0.6; // ~34°, half-stick open
  const lidPivot = new THREE.Group();
  lidPivot.position.set(spineX, RIM_TOP + 0.03, KEYBED_Z - 0.9);
  group.add(lidPivot);
  const lid = box(lidPivot, wood, 1.32, 0.03, 1.44, -0.66, 0, 0); // extends toward -X (treble) from the spine
  lid.receiveShadow = true;
  lidPivot.rotation.z = lidAngle; // treble edge lifts
  // Prop stick under the raised treble edge, meeting the lid underside.
  const propX = -0.42;
  const propTop = RIM_TOP + 0.03 + (spineX - propX) * Math.sin(lidAngle);
  box(group, woodWarm, 0.055, propTop - RIM_TOP, 0.055, propX, (RIM_TOP + propTop) * 0.5, KEYBED_Z - 0.9);

  // ---- bench behind the pianist (+Z)
  box(group, woodWarm, 0.94, 0.09, 0.36, 0, 0.5, 0.24); // seat top
  for (const bx of [-0.4, 0.4])
    for (const bz of [0.1, 0.38]) box(group, wood, 0.07, 0.5, 0.07, bx, 0.25, 0.24 + (bz - 0.24)); // 4 legs

  // ---- keys: two InstancedMesh (whites, blacks)
  const whiteGeo = own(new THREE.BoxGeometry(WHITE_WIDTH * 0.86, KEYBOARD.whiteHeight, KEYBOARD.whiteDepth));
  const blackGeo = own(
    new THREE.BoxGeometry(
      WHITE_WIDTH * KEYBOARD.blackWidthFrac,
      KEYBOARD.blackHeight,
      KEYBOARD.whiteDepth * KEYBOARD.blackDepthFrac
    )
  );
  const whiteMat = mat(0xece7da);
  const blackMat = mat(0x0c0a09);
  const whiteKeys = new THREE.InstancedMesh(whiteGeo, whiteMat, WHITE_MIDIS.length);
  const blackKeys = new THREE.InstancedMesh(blackGeo, blackMat, BLACK_MIDIS.length);
  whiteKeys.name = "beachPianist.whiteKeys";
  blackKeys.name = "beachPianist.blackKeys";
  whiteKeys.castShadow = false; // small detail — invisible at shadow resolution
  blackKeys.castShadow = false;
  whiteKeys.receiveShadow = true;
  blackKeys.receiveShadow = true;

  const whiteTopY = RIM_TOP;
  const blackTopY = RIM_TOP + KEYBOARD.blackRise;
  const blackZ = KEYBED_Z + KEYBOARD.whiteDepth * 0.5 - (KEYBOARD.whiteDepth * KEYBOARD.blackDepthFrac) * 0.5;

  // Base (rest) transform per key, and its pressed pivot. Pressed keys sink and
  // tip their front (player) edge down; we rotate about the back edge.
  const whiteBase: { x: number; y: number; z: number }[] = [];
  const blackBase: { x: number; y: number; z: number }[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  const backEdgeZ = KEYBED_Z - KEYBOARD.whiteDepth * 0.5; // hinge (far/back edge)

  const composeKey = (
    mesh: THREE.InstancedMesh,
    slot: number,
    base: { x: number; y: number; z: number },
    press: number
  ) => {
    const tip = press * 0.14; // rad, front (player-side, +Z) edge dips ~8°
    const sink = press * 0.008;
    euler.set(tip, 0, 0); // Rx(+tip) drops the +Z edge
    q.setFromEuler(euler);
    // rotate the key about its back edge: offset so the hinge line stays put
    const dz = base.z - backEdgeZ; // > 0 (centre sits forward of the hinge)
    const rotatedY = -Math.sin(tip) * dz;
    const rotatedZ = Math.cos(tip) * dz;
    pos.set(base.x, base.y - sink + rotatedY, backEdgeZ + rotatedZ);
    m4.compose(pos, q, scl);
    mesh.setMatrixAt(slot, m4);
  };

  for (let i = 0; i < WHITE_MIDIS.length; i++) {
    const base = { x: KEY_CENTER_X[WHITE_MIDIS[i]], y: whiteTopY, z: KEYBED_Z };
    whiteBase.push(base);
    composeKey(whiteKeys, i, base, 0);
  }
  for (let i = 0; i < BLACK_MIDIS.length; i++) {
    const base = { x: KEY_CENTER_X[BLACK_MIDIS[i]], y: blackTopY, z: blackZ };
    blackBase.push(base);
    composeKey(blackKeys, i, base, 0);
  }
  whiteKeys.instanceMatrix.needsUpdate = true;
  blackKeys.instanceMatrix.needsUpdate = true;
  group.add(whiteKeys, blackKeys);

  // Press edits compose straight into the instance matrix (scratch is reused —
  // no per-frame allocation); flushKeys uploads once per animated frame.
  let whiteDirty = false;
  let blackDirty = false;

  const owned: OwnedPiano = {
    group,
    whiteKeys,
    blackKeys,
    setWhitePress: (slot, amount) => {
      if (slot < 0 || slot >= whiteBase.length) return;
      composeKey(whiteKeys, slot, whiteBase[slot], amount);
      whiteDirty = true;
    },
    setBlackPress: (slot, amount) => {
      if (slot < 0 || slot >= blackBase.length) return;
      composeKey(blackKeys, slot, blackBase[slot], amount);
      blackDirty = true;
    },
    flushKeys: () => {
      if (whiteDirty) {
        whiteKeys.instanceMatrix.needsUpdate = true;
        whiteDirty = false;
      }
      if (blackDirty) {
        blackKeys.instanceMatrix.needsUpdate = true;
        blackDirty = false;
      }
    },
    dispose: () => {
      whiteKeys.dispose();
      blackKeys.dispose();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    }
  };

  // Diet: only chunky case parts cast; the small detail already opts out above.
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.castShadow) enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);
  });

  return owned;
}
