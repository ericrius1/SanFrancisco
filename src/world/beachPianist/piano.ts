import * as THREE from "three/webgpu";
import { enableShadowLayer, SHADOW_LAYERS } from "../shadows/shadowLayers";
import {
  BLACK_MIDIS,
  KEY_CENTER_X,
  KEYBOARD,
  WHITE_MIDIS,
  WHITE_WIDTH,
  isBlackMidi,
  keyCenterX
} from "./keys";

/**
 * A compact baby grand in polished near-black wood. The keyboard deck overlaps
 * a single curved wing-shaped case, so the instrument reads as one continuous
 * piece from the player's side rather than a keyboard parked beside two boxes.
 * A matching open lid, three legs, a pedal lyre, and a bench complete it.
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
const WHITE_STRIKE_Z = KEY_CONTACT.z - KEYBOARD.whiteDepth * 0.42;
const BLACK_STRIKE_Z = KEYBED_Z - KEYBOARD.whiteDepth * 0.5 +
  KEYBOARD.whiteDepth * KEYBOARD.blackDepthFrac * 0.5;

/** Exact keyboard-local point an articulated fingertip should strike. */
export function writeKeyStrikeTarget(midi: number, press: number, out: THREE.Vector3): THREE.Vector3 {
  const black = isBlackMidi(midi);
  const keyHeight = black ? KEYBOARD.blackHeight : KEYBOARD.whiteHeight;
  const baseY = KEY_CONTACT.top + (black ? KEYBOARD.blackRise : 0);
  return out.set(
    keyCenterX(midi),
    baseY + keyHeight * 0.5 - THREE.MathUtils.clamp(press, 0, 1) * 0.012,
    black ? BLACK_STRIKE_Z : WHITE_STRIKE_Z
  );
}

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
  const mat = (color: number, roughness = 0.32, metalness = 0.03): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
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

  /**
   * Extrude a piano-plan shape through local Y. Shape uses X/-Z internally so
   * the finished geometry lies flat in the same frame as the keyboard.
   */
  const wingPrism = (
    shape: THREE.Shape,
    height: number,
    material: THREE.Material,
    y: number,
    name: string,
    xOffset = 0,
    bevel = 0.008
  ): THREE.Mesh => {
    const geometry = own(new THREE.ExtrudeGeometry(shape, {
      depth: height,
      steps: 1,
      curveSegments: 12,
      bevelEnabled: bevel > 0,
      bevelSegments: 2,
      bevelSize: bevel,
      bevelThickness: bevel
    }));
    geometry.rotateX(-Math.PI * 0.5);
    if (xOffset !== 0) geometry.translate(xOffset, 0, 0);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.y = y;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  // Straight bass spine (+X), rounded tail, and a gently swept treble side.
  // The front edge deliberately overlaps the fallboard/key deck by 7 cm.
  const wingShape = () => {
    const shape = new THREE.Shape();
    shape.moveTo(0.74, 0.56);
    shape.lineTo(0.74, 1.58);
    shape.quadraticCurveTo(0.72, 1.84, 0.43, 1.94);
    shape.quadraticCurveTo(0.12, 2.04, -0.2, 1.95);
    shape.quadraticCurveTo(-0.56, 1.85, -0.7, 1.57);
    shape.quadraticCurveTo(-0.79, 1.3, -0.76, 1.02);
    shape.quadraticCurveTo(-0.74, 0.75, -0.67, 0.56);
    shape.closePath();
    return shape;
  };

  // Inset top panel leaves a broad, visible rim around the open soundboard.
  const soundboardShape = () => {
    const shape = new THREE.Shape();
    shape.moveTo(0.65, 0.66);
    shape.lineTo(0.65, 1.53);
    shape.quadraticCurveTo(0.62, 1.72, 0.38, 1.81);
    shape.quadraticCurveTo(0.11, 1.89, -0.14, 1.82);
    shape.quadraticCurveTo(-0.44, 1.74, -0.56, 1.5);
    shape.quadraticCurveTo(-0.63, 1.27, -0.61, 1.05);
    shape.quadraticCurveTo(-0.6, 0.84, -0.55, 0.66);
    shape.closePath();
    return shape;
  };

  const wood = mat(0x211713, 0.24, 0.06); // polished ebony with a warm brown lift
  const woodWarm = mat(0x4a2c20, 0.28, 0.04); // readable mahogany edge/trim
  const brass = mat(0xb28a3d, 0.28, 0.62); // pedals + hardware
  const feltDark = mat(0x100c0a, 0.86, 0); // under the open lid / key slip
  const soundboard = mat(0x6e4930, 0.48, 0.01);

  // ---- case: one continuous baby-grand shell instead of disconnected slabs.
  const RIM_TOP = KEY_CONTACT.top; // rim top sits at keyboard height
  const RIM_H = 0.24;
  const rimY = RIM_TOP - RIM_H * 0.5;
  const caseShell = wingPrism(
    wingShape(), RIM_H, wood, RIM_TOP - RIM_H,
    "beachPianist.piano.case"
  );
  group.add(caseShell);
  const rimCap = wingPrism(
    wingShape(), 0.035, woodWarm, RIM_TOP - 0.012,
    "beachPianist.piano.rimCap", 0, 0.006
  );
  group.add(rimCap);
  const soundboardPanel = wingPrism(
    soundboardShape(), 0.018, soundboard, RIM_TOP + 0.023,
    "beachPianist.piano.soundboard", 0, 0.003
  );
  soundboardPanel.castShadow = false;
  group.add(soundboardPanel);

  // ---- keyboard deck + slip/fallboard. The deck reaches back inside the wing
  // shell, making a strong continuous bridge between the keys and soundboard.
  const deckDepth = KEYBOARD.whiteDepth + 0.22;
  box(
    group, wood, KEYBOARD.width + 0.22, 0.17, deckDepth,
    0, RIM_TOP - 0.105, KEY_CONTACT.z - deckDepth * 0.5 + 0.04
  ).name = "beachPianist.piano.keyboardDeck";
  box(group, woodWarm, KEYBOARD.width + 0.12, 0.09, 0.06, 0, RIM_TOP - 0.02, KEY_CONTACT.z + 0.02); // front key slip
  box(group, wood, 0.09, 0.16, KEYBOARD.whiteDepth + 0.14, KEYBOARD.width * 0.5 + 0.06, RIM_TOP - 0.05, KEYBED_Z); // bass cheek
  box(group, wood, 0.09, 0.16, KEYBOARD.whiteDepth + 0.14, -KEYBOARD.width * 0.5 - 0.06, RIM_TOP - 0.05, KEYBED_Z); // treble cheek
  box(group, woodWarm, KEYBOARD.width + 0.24, 0.14, 0.12, 0, RIM_TOP - 0.02, KEYBED_Z - KEYBOARD.whiteDepth * 0.5 - 0.06); // fallboard overlaps the case shoulder

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

  // ---- open lid: repeats the exact wing silhouette and rotates about the
  // straight +X bass spine, so its raised edge still belongs to the case.
  const spineX = 0.74;
  const lidAngle = 0.6; // ~34°, half-stick open
  const lidPivot = new THREE.Group();
  lidPivot.position.set(spineX, RIM_TOP + 0.065, 0);
  group.add(lidPivot);
  const lid = wingPrism(
    wingShape(), 0.038, wood, 0,
    "beachPianist.piano.lid", -spineX, 0.006
  );
  lidPivot.add(lid);
  lid.receiveShadow = true;
  lidPivot.rotation.z = -lidAngle; // treble (-X) edge lifts
  for (const hingeZ of [-0.8, -1.42]) {
    const hinge = box(group, brass, 0.035, 0.028, 0.13, spineX - 0.006, RIM_TOP + 0.052, hingeZ);
    hinge.castShadow = false;
  }
  // Prop stick under the raised treble edge, meeting the lid underside.
  const propX = -0.42;
  const propTop = lidPivot.position.y + (spineX - propX) * Math.sin(lidAngle);
  box(group, woodWarm, 0.045, propTop - RIM_TOP, 0.045, propX, (RIM_TOP + propTop) * 0.5, -1.15);

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
  const whiteMat = mat(0xf2ede2, 0.36, 0.01);
  const blackMat = mat(0x100c0a, 0.2, 0.04);
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
  // Black keys occupy the back of the keybed, away from the pianist. Keeping
  // their former front-aligned placement made both the keyboard and fingering
  // read incorrectly from the side.
  const blackZ = BLACK_STRIKE_Z;

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
