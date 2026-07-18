import * as THREE from "three/webgpu";
import { buildRig, type Rig } from "../../player/rig";
import { applyArmPose, type ArmPose } from "../../gameplay/buskers/armIk";
import { setHandTarget } from "../../player/handIK";
import { KEY_CONTACT, writeKeyStrikeTarget } from "./piano";
import { keyCenterX } from "./keys";
import { PIANO_FINGER_COUNT } from "./notes";

/**
 * The bearded voxel pianist: light skin, a dark-brown side/back cut covering the
 * rear fifth of his crown while leaving the forehead open, a black long-sleeve
 * tee, black pants, white shoes, a full dark beard and black sunglasses. He sits
 * at the bench, thighs level, shins down, feet at the pedals, and plays the
 * keyboard with closed-form arm IK aimed at the current notes' key positions.
 * Between phrases his hands hover; during the rest he drops them to his lap and
 * gazes out to sea.
 *
 * Local frame matches the piano: he faces -Z (the keyboard), bass at +X, so his
 * left hand (rig "L", the +X shoulder) naturally covers the low half.
 */

const { damp, lerp, clamp } = THREE.MathUtils;

// Bench seat point in stage space (tuned so the butt meets the bench and the
// feet reach the pedals/sand).
export const SEAT = { x: 0, y: 0.6, z: 0.11 } as const;

const SKIN = 0xf2c7ad;
const DARK_HAIR = 0x5b4933;
const BEARD = 0x241a12;
const BLACK_CLOTH = 0x141414;
const WHITE_SHOE = 0xf3f1ea;

/** Per-hand runtime drive computed by the site from the note timeline. */
export type HandDrive = {
  /** Weighted wrist-centre X inferred from the hand's current notes/fingers. */
  targetX: number;
  /** 0..1 onset dip envelope (quick down-press pulse). */
  dip: number;
  /** 0..1 finger-curl / chord spread amount. */
  clasp: number;
  /** True while the hand has notes to play right now. */
  active: boolean;
  /** Assigned MIDI note per digit: thumb, index, middle, ring, pinky. */
  fingerMidi: Int16Array;
  /** 0 = hovering over the key, 1 = fully struck. */
  fingerPress: Float32Array;
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

type PianoFinger = {
  root: THREE.Group;
  distal: THREE.Group;
  tip: THREE.Object3D;
  proximalLength: number;
  distalLength: number;
  restPitch: number;
  restYaw: number;
  target: THREE.Vector3;
};

type PianoHand = {
  hand: THREE.Group;
  side: 1 | -1;
  fingers: PianoFinger[];
};

const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"] as const;
const FINGER_PROXIMAL = [0.053, 0.056, 0.061, 0.057, 0.049] as const;
const FINGER_DISTAL = [0.039, 0.043, 0.047, 0.043, 0.037] as const;
const FINGER_WIDTH = [0.023, 0.019, 0.02, 0.019, 0.017] as const;
// Left-hand palm coordinates, thumb → pinky. The right hand mirrors these.
// Keeping this order consistent with the key lanes is the fundamental
// no-crossing invariant for all subsequent finger posing.
const FINGER_ROOT_X = [-0.043, -0.025, -0.005, 0.015, 0.033] as const;
const FINGER_ROOT_Y = [-0.012, -0.033, -0.036, -0.035, -0.032] as const;
const FINGER_ROOT_Z = [-0.014, -0.043, -0.047, -0.045, -0.04] as const;
const FINGER_REST_YAW = [0.24, 0.08, 0, -0.07, -0.16] as const;

/** Keyboard-space home lane for thumb → pinky. Hand 0 is left, hand 1 right.
 * The timeline uses these to position the wrist under the digit that actually
 * plays a note instead of centring every finger over the wrist. */
export const PIANO_FINGER_KEY_OFFSETS = [
  [-0.045, -0.023, 0, 0.023, 0.043],
  [0.045, 0.023, 0, -0.023, -0.043]
] as const;

// The analytic arm target places the wrist just above the key tops while the
// tapered palm projects over the front half of the keyboard. This gives every
// phalanx enough vertical/forward reach for both white and black keys without
// collapsing the wrist into the fallboard.
const WRIST_TARGET_Y = KEY_CONTACT.top + 0.055;
const WRIST_TARGET_Z = KEY_CONTACT.z - 0.005;
const MIN_FINGER_LANE_GAP = 0.011;

/** Build the pianist and seat him in `stage`. */
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

  const capsule = (
    parent: THREE.Object3D,
    material: THREE.Material,
    width: number,
    length: number
  ): THREE.Mesh => {
    const radius = width * 0.5;
    const geometry = own(new THREE.CapsuleGeometry(radius, Math.max(0.002, length - width), 2, 6));
    geometry.rotateX(Math.PI * 0.5);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = -length * 0.5;
    parent.add(mesh);
    return mesh;
  };

  const taperedPalmGeometry = (): THREE.BufferGeometry => {
    const backW = 0.068;
    const frontW = 0.102;
    const backH = 0.034;
    const frontH = 0.044;
    const backZ = 0.045;
    const frontZ = -0.045;
    const positions = new Float32Array([
      -backW / 2, -backH / 2, backZ,
      backW / 2, -backH / 2, backZ,
      backW / 2, backH / 2, backZ,
      -backW / 2, backH / 2, backZ,
      -frontW / 2, -frontH / 2, frontZ,
      frontW / 2, -frontH / 2, frontZ,
      frontW / 2, frontH / 2, frontZ,
      -frontW / 2, frontH / 2, frontZ
    ]);
    const indices = [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2,
      1, 2, 6, 1, 6, 5,
      0, 4, 7, 0, 7, 3
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return own(geometry.toNonIndexed());
  };

  const buildHeroForearm = (fore: THREE.Group, side: 1 | -1): void => {
    // Replace the shared rectangular sleeve + wrist only for this close-up
    // musician. An octagonal taper, fitted cuff, and exposed wrist make a
    // continuous elbow→hand silhouette while retaining the voxel language.
    for (const child of [...fore.children]) {
      if (child instanceof THREE.Mesh) child.visible = false;
    }
    const sleeveGeo = own(new THREE.CylinderGeometry(0.067, 0.052, 0.205, 8, 1, false));
    const sleeve = new THREE.Mesh(sleeveGeo, m.sleeve);
    sleeve.name = `piano-${side === 1 ? "L" : "R"}-tapered-forearm`;
    sleeve.position.y = -0.1025;
    sleeve.scale.z = 1.12;
    sleeve.castShadow = true;
    fore.add(sleeve);

    const cuffGeo = own(new THREE.CylinderGeometry(0.054, 0.048, 0.045, 8, 1, false));
    const cuff = new THREE.Mesh(cuffGeo, m.trim);
    cuff.name = `piano-${side === 1 ? "L" : "R"}-sleeve-cuff`;
    cuff.position.y = -0.2275;
    cuff.scale.z = 1.08;
    cuff.castShadow = true;
    fore.add(cuff);

    const wristGeo = own(new THREE.CylinderGeometry(0.046, 0.041, 0.055, 8, 1, false));
    const wrist = new THREE.Mesh(wristGeo, m.skin);
    wrist.name = `piano-${side === 1 ? "L" : "R"}-wrist`;
    wrist.position.y = -0.2775;
    wrist.scale.z = 1.06;
    fore.add(wrist);
  };

  // The shared avatar hand is intentionally a low-cost articulated mitt. This
  // hero musician replaces its fused digit blocks, stock slab palms, and
  // rectangular forearms with tapered palms and ten rounded two-bone chains.
  rig.fingersL.visible = false;
  rig.fingersR.visible = false;
  rig.indexL.visible = false;
  rig.indexR.visible = false;
  rig.thumbL.visible = false;
  rig.thumbR.visible = false;

  buildHeroForearm(rig.foreL, 1);
  buildHeroForearm(rig.foreR, -1);

  const nail = mat(0xe6b7ae);

  const buildPianoHand = (hand: THREE.Group, side: 1 | -1): PianoHand => {
    for (const child of [...hand.children]) {
      if (child instanceof THREE.Mesh) child.visible = false;
    }

    const palm = new THREE.Mesh(taperedPalmGeometry(), m.skin);
    palm.name = `piano-${side === 1 ? "L" : "R"}-tapered-palm`;
    palm.position.z = -0.002;
    palm.castShadow = true;
    hand.add(palm);
    // Thenar pad and individual knuckles break up the old box silhouette and
    // make the thumb attachment readable from the overhead playing view.
    const thenar = box(hand, m.skin, 0.032, 0.018, 0.046, -side * 0.027, -0.018, -0.006);
    thenar.rotation.y = side * 0.22;
    for (let index = 1; index < PIANO_FINGER_COUNT; index++) {
      box(hand, m.skin, FINGER_WIDTH[index] * 1.06, 0.013, 0.017, side * FINGER_ROOT_X[index], 0.022, -0.043);
    }

    const fingers: PianoFinger[] = [];
    for (let index = 0; index < PIANO_FINGER_COUNT; index++) {
      const proximalLength = FINGER_PROXIMAL[index];
      const distalLength = FINGER_DISTAL[index];
      const width = FINGER_WIDTH[index];
      const root = new THREE.Group();
      root.name = `piano-${side === 1 ? "L" : "R"}-${FINGER_NAMES[index]}-proximal`;
      root.position.set(
        side * FINGER_ROOT_X[index],
        FINGER_ROOT_Y[index],
        FINGER_ROOT_Z[index]
      );
      hand.add(root);
      capsule(root, m.skin, width, proximalLength);

      const distal = new THREE.Group();
      distal.name = `piano-${side === 1 ? "L" : "R"}-${FINGER_NAMES[index]}-distal`;
      distal.position.z = -proximalLength;
      root.add(distal);
      capsule(distal, m.skin, width * 0.88, distalLength);
      const nailMesh = box(
        distal,
        nail,
        width * 0.58,
        0.0025,
        Math.min(0.014, distalLength * 0.32),
        0,
        width * 0.405,
        -distalLength * 0.72
      );
      nailMesh.castShadow = false;

      const tip = new THREE.Object3D();
      tip.name = `piano-${side === 1 ? "L" : "R"}-${FINGER_NAMES[index]}-tip`;
      tip.position.z = -distalLength;
      distal.add(tip);

      const restPitch = index === 0 ? -0.16 : -0.19 - index * 0.018;
      const restYaw = side * FINGER_REST_YAW[index];
      root.rotation.set(restPitch, restYaw, 0);
      distal.rotation.x = index === 0 ? -0.3 : -0.42;
      fingers.push({
        root,
        distal,
        tip,
        proximalLength,
        distalLength,
        restPitch,
        restYaw,
        target: new THREE.Vector3()
      });
    }
    return { hand, side, fingers };
  };

  const pianoLeft = buildPianoHand(rig.handL, 1);
  const pianoRight = buildPianoHand(rig.handR, -1);

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

  // Lap-rest arm poses seed the analytic transition when `perform` drops.
  const leftRest: ArmPose = [0.62, 0.05, 0.12, 0.55, 0, 0];
  const rightRest: ArmPose = [0.62, -0.05, -0.12, 0.55, 0, 0];

  // eased hand params
  let leftX = keyCenterX(48);
  let rightX = keyCenterX(72);
  let leftDip = 0;
  let rightDip = 0;
  const baseHandY = rig.handL.position.y; // same for both

  // Reused ten-finger IK scratch. Stage targets are transformed into each
  // moving palm once per hand, then every two-bone chain reaches its own key.
  const leftStageToHand = new THREE.Matrix4();
  const rightStageToHand = new THREE.Matrix4();
  const target = new THREE.Vector3();
  const stageWorld = new THREE.Quaternion();
  const desiredStage = new THREE.Quaternion();
  const leftRestWorld = new THREE.Vector3();
  const rightRestWorld = new THREE.Vector3();
  const leftPlayWorld = new THREE.Vector3();
  const rightPlayWorld = new THREE.Vector3();
  const leftWristWorld = new THREE.Vector3();
  const rightWristWorld = new THREE.Vector3();
  const leftRestAim = new THREE.Quaternion();
  const rightRestAim = new THREE.Quaternion();
  const leftPlayAim = new THREE.Quaternion();
  const rightPlayAim = new THREE.Quaternion();
  const leftWristAim = new THREE.Quaternion();
  const rightWristAim = new THREE.Quaternion();

  const animatePianoHand = (
    pianoHand: PianoHand,
    drive: HandDrive,
    stageToHand: THREE.Matrix4,
    dt: number,
    perform: number
  ) => {
    const hoverOffsets = PIANO_FINGER_KEY_OFFSETS[pianoHand.side === 1 ? 0 : 1];

    // Resolve every target first, then preserve thumb→pinky lane order. This
    // matters during legato hand shifts where one prepared note and four idle
    // fingers otherwise briefly ask for the same point.
    for (let index = 0; index < pianoHand.fingers.length; index++) {
      const finger = pianoHand.fingers[index];
      const midi = drive.fingerMidi[index];
      const press = drive.fingerPress[index];
      if (midi >= 0) {
        writeKeyStrikeTarget(midi, press, target);
        target.y += (1 - press) * 0.02;
      } else {
        target.set(
          drive.targetX + hoverOffsets[index],
          KEY_CONTACT.top + 0.052,
          KEY_CONTACT.z - 0.062
        );
      }
      finger.target.copy(target).applyMatrix4(stageToHand);
    }
    for (let index = 1; index < pianoHand.fingers.length; index++) {
      const previousLane = pianoHand.fingers[index - 1].target.x * pianoHand.side;
      const finger = pianoHand.fingers[index];
      const lane = finger.target.x * pianoHand.side;
      if (lane < previousLane + MIN_FINGER_LANE_GAP) {
        finger.target.x = pianoHand.side * (previousLane + MIN_FINGER_LANE_GAP);
      }
    }

    for (let index = 0; index < pianoHand.fingers.length; index++) {
      const finger = pianoHand.fingers[index];
      if (perform < 0.035) {
        finger.root.rotation.x = damp(finger.root.rotation.x, finger.restPitch, 10, dt);
        finger.root.rotation.y = damp(finger.root.rotation.y, finger.restYaw, 10, dt);
        finger.root.rotation.z = damp(finger.root.rotation.z, 0, 10, dt);
        finger.distal.rotation.x = damp(finger.distal.rotation.x, index === 0 ? -0.3 : -0.42, 12, dt);
        continue;
      }

      const press = drive.fingerPress[index];
      const dx = finger.target.x - finger.root.position.x;
      const dy = finger.target.y - finger.root.position.y;
      const dz = finger.target.z - finger.root.position.z;
      const a = finger.proximalLength;
      const b = finger.distalLength;
      const forward = Math.max(0.004, Math.hypot(dx, dz));
      const distance = clamp(Math.hypot(forward, dy), Math.abs(a - b) + 0.001, a + b - 0.001);
      const elbow = Math.acos(clamp((distance * distance - a * a - b * b) / (2 * a * b), -1, 1));
      const shoulder = Math.atan2(b * Math.sin(elbow), a + b * Math.cos(elbow));
      const maxYaw = index === 0 ? 0.76 : 0.46;
      const yaw = clamp(-Math.atan2(dx, -dz), -maxYaw, maxYaw);
      const linePitch = Math.atan2(dy, forward);
      const pitch = clamp(linePitch + shoulder, index === 0 ? -0.5 : -0.72, index === 0 ? 0.48 : 0.56);
      const distalPitch = -clamp(elbow, 0.1, index === 0 ? 1.35 : 1.62);
      const response = press > 0 ? 34 : 18;
      // Fingers flex only around their knuckles and interphalangeal joints,
      // with bounded lateral splay. Removing arbitrary roll is what stops the
      // toothpick-like chains from corkscrewing through their neighbours.
      finger.root.rotation.x = damp(finger.root.rotation.x, pitch, response, dt);
      finger.root.rotation.y = damp(finger.root.rotation.y, yaw, response, dt);
      finger.root.rotation.z = damp(finger.root.rotation.z, 0, response, dt);
      finger.distal.rotation.x = damp(finger.distal.rotation.x, distalPitch, response, dt);
    }
  };

  const update = (dt: number, elapsed: number, drive: PianistDrive) => {
    const perform = drive.perform;
    const breathe = Math.sin(elapsed * 1.4);

    if (drive.left.active) leftX = damp(leftX, drive.left.targetX, 14, dt);
    if (drive.right.active) rightX = damp(rightX, drive.right.targetX, 14, dt);
    leftDip = damp(leftDip, drive.left.dip, 22, dt);
    rightDip = damp(rightDip, drive.right.dip, 22, dt);

    // Set body motion first: the wrist solve reads the live torso frame, so a
    // loud-passage lean cannot lift the fingertips away from their keys.
    const nod = Math.max(leftDip, rightDip);
    const restLookY = 0.55 * Math.sin(elapsed * 0.22) + 0.25;
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

    // Establish the lap pose, read its two wrist frames, then analytically move
    // each complete arm toward the keyboard. Blending targets (rather than arm
    // angles) keeps the wrist path continuous and lands exactly on the narrow
    // playing plane at full performance.
    rig.handL.position.y = baseHandY;
    rig.handR.position.y = baseHandY;
    rig.handL.quaternion.identity();
    rig.handR.quaternion.identity();
    applyArmPose(rig.armL, rig.foreL, leftRest);
    applyArmPose(rig.armR, rig.foreR, rightRest);
    stage.updateWorldMatrix(true, false);
    rig.handL.getWorldPosition(leftRestWorld);
    rig.handR.getWorldPosition(rightRestWorld);
    rig.handL.getWorldQuaternion(leftRestAim);
    rig.handR.getWorldQuaternion(rightRestAim);

    leftPlayWorld.set(leftX, WRIST_TARGET_Y - leftDip * 0.012 * perform, WRIST_TARGET_Z);
    rightPlayWorld.set(rightX, WRIST_TARGET_Y - rightDip * 0.012 * perform, WRIST_TARGET_Z);
    stage.localToWorld(leftPlayWorld);
    stage.localToWorld(rightPlayWorld);
    leftWristWorld.copy(leftRestWorld).lerp(leftPlayWorld, perform);
    rightWristWorld.copy(rightRestWorld).lerp(rightPlayWorld, perform);

    stage.getWorldQuaternion(stageWorld);
    desiredStage.setFromEuler(new THREE.Euler(-0.055, 0, 0.025));
    leftPlayAim.copy(stageWorld).multiply(desiredStage);
    desiredStage.setFromEuler(new THREE.Euler(-0.055, 0, -0.025));
    rightPlayAim.copy(stageWorld).multiply(desiredStage);
    leftWristAim.copy(leftRestAim).slerp(leftPlayAim, perform);
    rightWristAim.copy(rightRestAim).slerp(rightPlayAim, perform);

    if (perform >= 0.035) {
      setHandTarget(rig, "L", { pos: leftWristWorld, aim: leftWristAim });
      setHandTarget(rig, "R", { pos: rightWristWorld, aim: rightWristAim });
    }
    pianoLeft.hand.updateWorldMatrix(true, false);
    pianoRight.hand.updateWorldMatrix(true, false);
    leftStageToHand.copy(pianoLeft.hand.matrixWorld).invert().multiply(stage.matrixWorld);
    rightStageToHand.copy(pianoRight.hand.matrixWorld).invert().multiply(stage.matrixWorld);
    animatePianoHand(pianoLeft, drive.left, leftStageToHand, dt, perform);
    animatePianoHand(pianoRight, drive.right, rightStageToHand, dt, perform);

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
