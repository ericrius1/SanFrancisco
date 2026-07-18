import * as THREE from "three/webgpu";
import { buildRig, setRigClasp, type Rig } from "../../player/rig";
import { applyArmPose, mixArmPose, solveArmPose, type ArmPose } from "../../gameplay/buskers/armIk";
import { KEY_CONTACT } from "./piano";
import { keyCenterX } from "./keys";

/**
 * The bearded voxel pianist: light skin, a dark-brown side/back cut covering the
 * rear fifth of his crown while leaving the forehead open, a black long-sleeve
 * tee, black pants, white shoes, a full dark beard and black sunglasses. He sits
 * at the bench, thighs level, shins down, feet at the pedals, and plays the
 * keyboard with build-time IK arm stations blended at runtime toward the current
 * notes' key positions. Between phrases his hands hover; during the rest he
 * drops them to his lap and gazes out to sea.
 *
 * Local frame matches the piano: he faces -Z (the keyboard), bass at +X, so his
 * left hand (rig "L", the +X shoulder) naturally covers the low half.
 */

const { damp, lerp, clamp } = THREE.MathUtils;

// Bench seat point in stage space (tuned so the butt meets the bench and the
// feet reach the pedals/sand).
export const SEAT = { x: 0, y: 0.6, z: 0.16 } as const;

const SKIN = 0xf2c7ad;
const DARK_HAIR = 0x5b4933;
const BEARD = 0x241a12;
const BLACK_CLOTH = 0x141414;
const WHITE_SHOE = 0xf3f1ea;

// MIDI spans each hand plays (from the baked timeline hand ranges).
const LEFT_LO = 39;
const LEFT_HI = 70;
const RIGHT_LO = 53;
const RIGHT_HI = 82;
const STATION_COUNT = 5;

/** Per-hand runtime drive computed by the site from the note timeline. */
export type HandDrive = {
  /** Weighted mean key-centre X (keyboard-local) of the hand's current notes. */
  targetX: number;
  /** 0..1 onset dip envelope (quick down-press pulse). */
  dip: number;
  /** 0..1 finger-curl / chord spread amount. */
  clasp: number;
  /** True while the hand has notes to play right now. */
  active: boolean;
};

export type PianistDrive = {
  /** Eased 0..1 playing intensity (1 mid-song, 0 during the rest). */
  perform: number;
  /** 0..1 velocity-weighted loudness of the moment (torso lean). */
  loud: number;
  left: HandDrive;
  right: HandDrive;
};

export type Pianist = {
  group: THREE.Group;
  rig: Rig;
  update: (dt: number, elapsed: number, drive: PianistDrive) => void;
  /** World X of each hand (for the tracking sanity check). Requires world
   * matrices to be current. */
  handWorldX: (out: { l: number; r: number }) => void;
  dispose: () => void;
};

function sampleStations(stations: ArmPose[], amount: number, out: ArmPose): ArmPose {
  const u = clamp(amount, 0, 1) * (stations.length - 1);
  const i1 = Math.min(stations.length - 2, Math.floor(u));
  const t = u - i1;
  const p0 = stations[Math.max(0, i1 - 1)];
  const p1 = stations[i1];
  const p2 = stations[Math.min(stations.length - 1, i1 + 1)];
  const p3 = stations[Math.min(stations.length - 1, i1 + 2)];
  const t2 = t * t;
  const t3 = t2 * t;
  for (let i = 0; i < out.length; i++) {
    out[i] =
      0.5 *
      (2 * p1[i] +
        (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  }
  return out;
}

/** Build the pianist, seat him in `stage`, and solve his keyboard IK stations. */
export function buildPianist(stage: THREE.Group): Pianist {
  const rig = buildRig({ skin: 0, hair: "buzz", hat: "none", outfit: "tee", color: 5, accent: 5 });
  const m = rig.avatar.materials;
  m.skin.color.set(SKIN);
  m.hair.color.set(DARK_HAIR);
  m.jacket.color.set(BLACK_CLOTH); // tee torso
  m.trim.color.set(BLACK_CLOTH); // tee collar
  m.sleeve.color.set(BLACK_CLOTH); // sleeves run from shoulder to wrist
  m.pants.color.set(0x101010); // black pants (hips + legs)
  m.shoe.color.set(WHITE_SHOE);
  m.sole.color.set(0xcfcabd);

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const own = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };
  const mat = (color: number): THREE.MeshLambertMaterial => {
    const mm = new THREE.MeshLambertMaterial({ color });
    mats.push(mm);
    return mm;
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
    const mesh = new THREE.Mesh(own(new THREE.BoxGeometry(w, h, d)), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = w * h * d >= 1.5e-3;
    parent.add(mesh);
    return mesh;
  };

  // Black sunglasses over the stock visor slot (MeshBasic so the fill can't lift
  // them to grey — busker idiom).
  const shades = new THREE.MeshBasicMaterial({ color: 0x000000 });
  mats.push(shades);
  const stockShades = rig.head.children.find(
    (child) => child instanceof THREE.Mesh && child.material === rig.avatar.materials.visor
  );
  if (stockShades instanceof THREE.Mesh) stockShades.material = shades;

  // Replace the stock buzz crown with a close side/back wrap. The occipital
  // panel rises to the scalp and joins a shallow rear-crown slab: its 0.055 m
  // overlap on the 0.26 m-deep head covers roughly the back 20% of the top
  // without reaching the forehead or face.
  for (const crown of rig.avatar.hair.buzz) crown.visible = false;
  const hairWrap = new THREE.Group();
  hairWrap.name = "beachPianist.sideBackHair";
  rig.head.add(hairWrap);
  box(hairWrap, m.hair, 0.27, 0.24, 0.04, 0, 0.22, 0.15); // raised back/occipital hair
  box(hairWrap, m.hair, 0.035, 0.2, 0.18, -0.1475, 0.2, 0.06); // left side
  box(hairWrap, m.hair, 0.035, 0.2, 0.18, 0.1475, 0.2, 0.06); // right side
  box(hairWrap, m.hair, 0.27, 0.03, 0.095, 0, 0.345, 0.1225); // rear 20% of crown

  // Fuller dark beard than the ukulelist: chin slab, jaw frames, upper cheeks.
  const beard = mat(BEARD);
  box(rig.head, beard, 0.22, 0.12, 0.05, 0, 0.07, -0.13); // chin/jaw slab
  box(rig.head, beard, 0.05, 0.15, 0.19, -0.13, 0.12, -0.03); // jaw frame L
  box(rig.head, beard, 0.05, 0.15, 0.19, 0.13, 0.12, -0.03); // jaw frame R
  box(rig.head, beard, 0.16, 0.05, 0.05, 0, 0.16, -0.14); // moustache
  box(rig.head, beard, 0.06, 0.07, 0.06, -0.12, 0.2, -0.05); // sideburn L
  box(rig.head, beard, 0.06, 0.07, 0.06, 0.12, 0.2, -0.05); // sideburn R

  const group = rig.group;
  group.name = "beachPianist.pianist";
  group.position.set(SEAT.x, SEAT.y, SEAT.z);
  group.rotation.y = 0;
  stage.add(group);
  rig.hips.rotation.set(0, 0, 0);

  // ---- build-time IK: contact rides the keyboard front lip in stage space.
  const contact = new THREE.Object3D();
  contact.position.set(0, KEY_CONTACT.top, KEY_CONTACT.z);
  stage.add(contact);
  stage.updateMatrixWorld(true);

  const solveHand = (
    arm: THREE.Group,
    fore: THREE.Group,
    hand: THREE.Group,
    side: 1 | -1,
    loMidi: number,
    hiMidi: number,
    seed: ArmPose
  ): ArmPose[] => {
    const poses: ArmPose[] = [];
    let s = seed;
    const xLo = keyCenterX(loMidi);
    const xHi = keyCenterX(hiMidi);
    for (let i = 0; i < STATION_COUNT; i++) {
      contact.position.x = lerp(xLo, xHi, i / (STATION_COUNT - 1));
      stage.updateMatrixWorld(true);
      const target = contact.getWorldPosition(new THREE.Vector3());
      s = solveArmPose(arm, fore, hand, target, s, {
        side,
        elbowClearance: 0.22,
        elbowFront: -0.12
      });
      poses.push(s);
    }
    return poses;
  };

  // Left hand (rig L, +X) plays the bass; right hand (rig R, -X) the treble.
  const leftStations = solveHand(rig.armL, rig.foreL, rig.handL, 1, LEFT_LO, LEFT_HI, [0.7, -0.1, 0.2, 0.7, 0, 0]);
  const rightStations = solveHand(rig.armR, rig.foreR, rig.handR, -1, RIGHT_LO, RIGHT_HI, [0.7, 0.1, -0.2, 0.7, 0, 0]);
  stage.remove(contact);

  const LEFT_XLO = keyCenterX(LEFT_LO);
  const LEFT_XHI = keyCenterX(LEFT_HI);
  const RIGHT_XLO = keyCenterX(RIGHT_LO);
  const RIGHT_XHI = keyCenterX(RIGHT_HI);

  // Lap-rest arm poses (hands on thighs) blended in as `perform` drops.
  const leftRest: ArmPose = [0.62, 0.05, 0.12, 0.55, 0, 0];
  const rightRest: ArmPose = [0.62, -0.05, -0.12, 0.55, 0, 0];

  // Reusable pose scratch (allocation-free per frame).
  const leftSample = leftStations[0].slice() as ArmPose;
  const rightSample = rightStations[0].slice() as ArmPose;
  const leftPose = leftStations[0].slice() as ArmPose;
  const rightPose = rightStations[0].slice() as ArmPose;

  // eased hand params
  let leftU = 0.5;
  let rightU = 0.5;
  let leftDip = 0;
  let rightDip = 0;
  const baseHandY = rig.handL.position.y; // same for both

  const update = (dt: number, elapsed: number, drive: PianistDrive) => {
    const perform = drive.perform;
    const breathe = Math.sin(elapsed * 1.4);

    // ---- map each hand's target key X to a station parameter, damp, sample ----
    const luTarget = clamp((drive.left.targetX - LEFT_XLO) / (LEFT_XHI - LEFT_XLO || 1), 0, 1);
    const ruTarget = clamp((drive.right.targetX - RIGHT_XLO) / (RIGHT_XHI - RIGHT_XLO || 1), 0, 1);
    if (drive.left.active) leftU = damp(leftU, luTarget, 14, dt);
    if (drive.right.active) rightU = damp(rightU, ruTarget, 14, dt);
    leftDip = damp(leftDip, drive.left.dip, 22, dt);
    rightDip = damp(rightDip, drive.right.dip, 22, dt);

    sampleStations(leftStations, leftU, leftSample);
    sampleStations(rightStations, rightU, rightSample);
    mixArmPose(leftPose, leftRest, leftSample, perform);
    mixArmPose(rightPose, rightRest, rightSample, perform);
    applyArmPose(rig.armL, rig.foreL, leftPose);
    applyArmPose(rig.armR, rig.foreR, rightPose);

    // press dip: nudge the hand down along the forearm on each onset
    rig.handL.position.y = baseHandY - leftDip * 0.02 * perform;
    rig.handR.position.y = baseHandY - rightDip * 0.02 * perform;
    setRigClasp(rig, "L", lerp(0.28, 0.5 + 0.4 * drive.left.clasp, perform));
    setRigClasp(rig, "R", lerp(0.28, 0.5 + 0.4 * drive.right.clasp, perform));

    // ---- torso lean into loud passages + head nod on onsets; rest gaze ----
    const nod = Math.max(leftDip, rightDip);
    const restLookY = 0.55 * Math.sin(elapsed * 0.22) + 0.25; // slow turn toward the sea
    rig.torso.rotation.set(
      lerp(0.06 + breathe * 0.02, 0.12 + drive.loud * 0.05 + breathe * 0.012, perform),
      lerp(Math.sin(elapsed * 0.3) * 0.05, Math.sin(elapsed * 0.5) * 0.02, perform),
      0
    );
    rig.head.rotation.set(
      lerp(0.02 + breathe * 0.02, -0.18 + nod * 0.14 * perform + breathe * 0.01, perform),
      lerp(restLookY, Math.sin(elapsed * 0.4) * 0.06, perform),
      0
    );

    // ---- seated legs: thighs level, shins down, feet at the pedals. Right foot
    // slightly forward on the sustain pedal, with a subtle heel tap while playing.
    const tap = Math.max(0, Math.sin(elapsed * 3.1)) * 0.04 * perform;
    rig.legL.rotation.set(1.46, 0, 0.05);
    rig.legR.rotation.set(1.52, 0, -0.05);
    rig.shinL.rotation.set(-1.48, 0, 0);
    rig.shinR.rotation.set(-1.6 + tap, 0, 0);
  };

  const handWorldX = (out: { l: number; r: number }) => {
    out.l = rig.handL.getWorldPosition(_tmp).x;
    out.r = rig.handR.getWorldPosition(_tmp).x;
  };

  const dispose = () => {
    group.parent?.remove(group);
    for (const g of geos) g.dispose();
    for (const mm of mats) mm.dispose();
    for (const mm of Object.values(rig.avatar.materials)) mm.dispose();
  };

  return { group, rig, update, handWorldX, dispose };
}

const _tmp = new THREE.Vector3();
