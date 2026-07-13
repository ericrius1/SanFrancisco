import * as THREE from "three/webgpu";
import {
  buildRig,
  poseIdle,
  poseWalk,
  setHandPose,
  HAND_CUP,
  HAND_POINT,
  HAND_RELAXED,
  type Rig
} from "../../player/rig";
import { setHandTarget } from "../../player/handIK";
import { createIrohCostume } from "./irohCostume";
import { createTeaSteam } from "./teaSteam";

export type TeaMasterAction = "idle" | "welcome" | "serve" | "walk" | "talk" | "point";

export type TeaMasterVisual = {
  group: THREE.Group;
  dialogueAnchor: THREE.Object3D;
  cupAnchor: THREE.Object3D;
  setAction(action: TeaMasterAction): void;
  /** Whether the master still holds the tea bowl (both hands cradle it). Set
   *  false when the player takes the tea, freeing his arms to gesture. */
  setCarryingCup(has: boolean): void;
  update(
    dt: number,
    time: number,
    lookTarget?: { x: number; y?: number; z: number },
    travelDistance?: number
  ): void;
  debugState(): TeaMasterVisualDebugState;
  dispose(): void;
};

export type TeaMasterVisualDebugState = {
  action: TeaMasterAction;
  position: [number, number, number];
  joints: number[];
  walkBlend: number;
  stridePhase: number;
  cupToLeftHand: number;
  cupToRightHand: number;
  hasCup: boolean;
  presentT: number;
  ikError: string;
  cupWorldPos: [number, number, number];
  yaw: number;
};

// Uncle Iroh reference tones: silver hair/beard, warm skin, navy tunic under a
// cream shawl, pale grey-tan sleeves, gold topknot tie, navy shoes.
const PALETTE = {
  sleeve: 0xcfc6b0,
  navy: 0x232a42,
  hair: 0xc3c5be,
  skin: 0xd7a17b,
  gold: 0xc9a24b,
  shoe: 0x222a40,
  tea: 0x7a4b20,
  cup: 0xdcc8a0
} as const;

function setRotation(group: THREE.Group, x: number, y: number, z: number): void {
  group.rotation.set(x, y, z);
}

function createTeaCup(geometries: THREE.BufferGeometry[], materials: THREE.Material[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "tea_master_cup";
  const ceramic = new THREE.MeshStandardMaterial({ color: PALETTE.cup, roughness: 0.72, metalness: 0 });
  const tea = new THREE.MeshStandardMaterial({ color: PALETTE.tea, roughness: 0.35, metalness: 0 });
  materials.push(ceramic, tea);

  const bowlGeometry = new THREE.CylinderGeometry(0.11, 0.085, 0.105, 14, 1, true);
  const baseGeometry = new THREE.CylinderGeometry(0.075, 0.075, 0.025, 14);
  const teaGeometry = new THREE.CircleGeometry(0.096, 16);
  geometries.push(bowlGeometry, baseGeometry, teaGeometry);
  const bowl = new THREE.Mesh(bowlGeometry, ceramic);
  bowl.name = "tea_cup_bowl";
  bowl.castShadow = true;
  group.add(bowl);
  const base = new THREE.Mesh(baseGeometry, ceramic);
  base.name = "tea_cup_foot";
  base.position.y = -0.062;
  group.add(base);
  const surface = new THREE.Mesh(teaGeometry, tea);
  surface.name = "tea_surface";
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 0.053;
  group.add(surface);
  // Steam is a stylized soft-sprite plume (teaSteam.ts), added by the caller so
  // it can be updated/paused with the ceremony.
  return group;
}

function hideStockFaceAndCostume(rig: Rig): void {
  for (const item of [...rig.avatar.allHair, ...rig.avatar.allHats, ...rig.avatar.allOutfits]) item.visible = false;
  for (const child of rig.head.children) {
    if (child instanceof THREE.Mesh && child.material === rig.avatar.materials.visor) child.visible = false;
  }
}

export function createTeaMasterVisual(): TeaMasterVisual {
  const rig = buildRig({ skin: 2, hair: "buzz", hat: "none", outfit: "jacket", color: 5, accent: 6 });
  hideStockFaceAndCostume(rig);
  rig.avatar.materials.skin.color.set(PALETTE.skin);
  rig.avatar.materials.jacket.color.set(PALETTE.navy);
  rig.avatar.materials.sleeve.color.set(PALETTE.sleeve);
  rig.avatar.materials.pants.color.set(PALETTE.navy);
  rig.avatar.materials.shoe.color.set(PALETTE.shoe);
  rig.avatar.materials.hair.color.set(PALETTE.hair);
  rig.avatar.torsoBlock.scale.set(1.32, 1.06, 1.16);
  rig.avatar.hipBlock.scale.set(1.34, 1.05, 1.18);
  for (const arm of rig.avatar.armBlocks) arm.scale.set(1.12, 1.02, 1.12);

  const group = new THREE.Group();
  group.name = "tea_master_iroh";
  group.scale.setScalar(1.12);
  rig.group.position.y = 0.9;
  group.add(rig.group);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const lambert = (color: number) => {
    const value = new THREE.MeshLambertMaterial({ color });
    materials.push(value);
    return value;
  };
  const skin = rig.avatar.materials.skin;
  const hair = lambert(PALETTE.hair);
  const gold = lambert(PALETTE.gold);
  const ink = new THREE.MeshBasicMaterial({ color: 0x17212a });
  const amber = new THREE.MeshBasicMaterial({ color: 0x815c2d });
  const eyeWhite = new THREE.MeshBasicMaterial({ color: 0xf6eddd });
  materials.push(ink, amber, eyeWhite);

  const addMesh = (
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    mat: THREE.Material,
    position: readonly [number, number, number],
    name: string
  ) => {
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = name;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  const costume = createIrohCostume(rig);

  // Bald crown, grey wing-like side hair, topknot, side beard and goatee.
  for (const side of [-1, 1]) {
    const sideHair = addMesh(
      rig.head,
      new THREE.DodecahedronGeometry(0.11, 0),
      hair,
      [side * 0.17, 0.2, 0.015],
      "tea_master_side_hair"
    );
    sideHair.scale.set(0.85, 1.55, 0.75);
    sideHair.rotation.z = side * 0.32;
    // Fuller sideburns that sweep down the jaw toward the beard, framing the face.
    const whisker = addMesh(rig.head, new THREE.ConeGeometry(0.072, 0.3, 7), hair, [side * 0.115, 0.075, -0.1], "tea_master_beard_wing");
    whisker.rotation.z = side * 0.28;
  }
  const topknot = addMesh(rig.head, new THREE.SphereGeometry(0.09, 10, 7), hair, [0, 0.43, 0.02], "tea_master_topknot");
  topknot.scale.set(0.8, 1.1, 0.8);
  addMesh(rig.head, new THREE.CylinderGeometry(0.075, 0.07, 0.055, 10), gold, [0, 0.38, 0.02], "tea_master_topknot_band");
  // Iroh's signature: a long grey mustache over a full pointed beard hanging
  // well below the chin. A jaw pad joins the sideburns so the beard reads as one
  // connected mass rather than a floating spike.
  const beardPad = addMesh(rig.head, new THREE.SphereGeometry(0.11, 10, 8), hair, [0, 0.04, -0.135], "tea_master_beard_pad");
  beardPad.scale.set(1.05, 0.72, 0.62);
  const goatee = addMesh(rig.head, new THREE.ConeGeometry(0.088, 0.36, 8), hair, [0, -0.02, -0.15], "tea_master_goatee");
  goatee.rotation.z = Math.PI;
  goatee.rotation.x = -0.12; // tip drifts forward, not tucked into the chest
  for (const side of [-1, 1]) {
    const mustache = addMesh(rig.head, new THREE.ConeGeometry(0.03, 0.13, 6), hair, [side * 0.05, 0.11, -0.168], "tea_master_mustache");
    mustache.rotation.z = side * 1.9;
    mustache.rotation.x = 0.2;
  }

  // Welcoming face: bright eyes, warm pupils, soft brows, cheeks and a clear smile.
  for (const side of [-1, 1]) {
    const eye = addMesh(rig.head, new THREE.SphereGeometry(0.034, 10, 7), eyeWhite, [side * 0.065, 0.235, -0.142], "tea_master_eye");
    eye.scale.set(1.25, 0.72, 0.5);
    const pupil = addMesh(rig.head, new THREE.SphereGeometry(0.018, 8, 6), amber, [side * 0.064, 0.234, -0.164], "tea_master_pupil");
    pupil.scale.set(0.82, 0.92, 0.5);
    const brow = addMesh(rig.head, new THREE.BoxGeometry(0.07, 0.013, 0.012), hair, [side * 0.066, 0.29, -0.151], "tea_master_soft_brow");
    brow.rotation.z = side * 0.11;
    const cheek = addMesh(rig.head, new THREE.SphereGeometry(0.038, 8, 6), skin, [side * 0.095, 0.16, -0.146], "tea_master_cheek");
    cheek.scale.set(1.25, 0.58, 0.4);
  }
  const smile = addMesh(rig.head, new THREE.TorusGeometry(0.064, 0.009, 5, 16, Math.PI), ink, [0, 0.138, -0.16], "tea_master_smile");
  smile.rotation.z = Math.PI;
  const mouthOpen = addMesh(rig.head, new THREE.SphereGeometry(0.036, 10, 6), ink, [0, 0.12, -0.158], "tea_master_mouth_open");
  mouthOpen.scale.set(1.25, 0.62, 0.35);
  mouthOpen.visible = false;

  const cupAnchor = new THREE.Group();
  cupAnchor.name = "tea_master_cup_anchor";
  cupAnchor.position.set(0, 0.22, -0.48);
  rig.torso.add(cupAnchor);
  const cup = createTeaCup(geometries, materials);
  cupAnchor.add(cup);
  const steam = createTeaSteam();
  cup.add(steam.group);

  const dialogueAnchor = new THREE.Object3D();
  dialogueAnchor.name = "tea_master_dialogue_anchor";
  dialogueAnchor.position.set(0, 2.18, 0);
  group.add(dialogueAnchor);

  let action: TeaMasterAction = "idle";
  let actionTime = 0;
  let stridePhase = 0;
  let walkBlend = 0;
  let mouthBlend = 0;
  let hasCup = true; // both hands cradle the bowl until the player takes the tea
  let presentT = 0; // 0 = held at the chest, 1 = offered forward (the "serve" beat)
  let ikError = "";
  let previousHeading = group.rotation.y;
  const headTarget = new THREE.Vector3();
  const localTarget = new THREE.Vector3();
  const handLWorld = new THREE.Vector3();
  const handRWorld = new THREE.Vector3();
  const cupWorld = new THREE.Vector3();

  // Two-hand cradle, all in torso-local space. The bowl centre sits in front of
  // the chest; each hand targets a point just below and outboard of it so the
  // fingers close up around the bowl. `serve` eases the whole cradle forward.
  const cupHold = new THREE.Vector3(0, 0.28, -0.42);
  const cupOffer = new THREE.Vector3(0, 0.33, -0.52);
  const cupLocal = new THREE.Vector3();
  const handOffL = new THREE.Vector3(0.088, -0.055, 0.03);
  const handOffR = new THREE.Vector3(-0.088, -0.055, 0.03);
  const targetWorldL = new THREE.Vector3();
  const targetWorldR = new THREE.Vector3();
  // Palms tilt up and angle toward each other so the bowl reads as cradled, not
  // pinched. Applied on top of the torso's world orientation each frame.
  const tiltL = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.32, -0.34, 0.16));
  const tiltR = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.32, 0.34, -0.16));
  const torsoQuat = new THREE.Quaternion();
  const aimL = new THREE.Quaternion();
  const aimR = new THREE.Quaternion();
  const poseJoints = [
    rig.hips,
    rig.torso,
    rig.head,
    rig.armL,
    rig.armR,
    rig.foreL,
    rig.foreR,
    rig.legL,
    rig.legR,
    rig.shinL,
    rig.shinR
  ] as const;
  const currentPose = new Float32Array(poseJoints.length * 3 + 1);
  const targetPose = new Float32Array(poseJoints.length * 3 + 1);

  const capturePose = (out: Float32Array) => {
    poseJoints.forEach((joint, index) => {
      const offset = index * 3;
      out[offset] = joint.rotation.x;
      out[offset + 1] = joint.rotation.y;
      out[offset + 2] = joint.rotation.z;
    });
    out[out.length - 1] = rig.hips.position.y;
  };

  const blendToTargetPose = (safeDt: number) => {
    // Deliberately slower than the player rig: Iroh settles into gestures like
    // a practiced host. At 60 Hz even the largest scripted transition stays
    // below a visually jarring one-frame snap.
    const response = action === "walk" ? 7.5 : 6;
    poseJoints.forEach((joint, index) => {
      const offset = index * 3;
      joint.rotation.set(
        THREE.MathUtils.damp(currentPose[offset], targetPose[offset], response, safeDt),
        THREE.MathUtils.damp(currentPose[offset + 1], targetPose[offset + 1], response, safeDt),
        THREE.MathUtils.damp(currentPose[offset + 2], targetPose[offset + 2], response, safeDt)
      );
    });
    rig.hips.position.y = THREE.MathUtils.damp(
      currentPose[currentPose.length - 1],
      targetPose[targetPose.length - 1],
      response,
      safeDt
    );
  };

  const setAction = (next: TeaMasterAction) => {
    if (next === action) return;
    action = next;
    actionTime = 0;
  };

  const update = (
    dt: number,
    time: number,
    lookTarget?: { x: number; y?: number; z: number },
    travelDistance = 0
  ) => {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    actionTime += safeDt;
    walkBlend = THREE.MathUtils.damp(walkBlend, action === "walk" ? 1 : 0, 7.5, safeDt);
    if (action === "walk") stridePhase = (stridePhase + Math.max(0, travelDistance) * 4.6) % (Math.PI * 2);

    // Pose functions author an instantaneous target. Preserve the live pose,
    // generate the target, then exponentially blend every joint back from the
    // preserved state. This removes the 30–48° state-transition snaps without
    // changing the shared player-rig API.
    capturePose(currentPose);
    if (action === "walk") {
      poseWalk(rig, stridePhase, 0);
      // Iroh walks with a short, grounded tea-master stride. Besides reading as
      // calmer, this keeps the hidden legs well inside the robe's authored
      // envelope so capsule projection remains a safety net, not the silhouette.
      rig.legL.rotation.x *= 0.7;
      rig.legR.rotation.x *= 0.7;
      rig.shinL.rotation.x *= 0.78;
      rig.shinR.rotation.x *= 0.78;
      rig.torso.rotation.y *= 0.62;
      // While he still cradles the cup the arms are IK-driven below, so hold
      // them close; once the tea is handed off his arms are free to swing.
      if (hasCup) {
        rig.armL.rotation.x *= 0.6;
        rig.armR.rotation.x *= 0.6;
      } else {
        rig.armL.rotation.x *= 1.02;
        rig.armR.rotation.x *= 1.02;
      }
    } else {
      poseIdle(rig, time);
    }

    // A warm little bow whenever he greets — reads on both the cup-in-hand
    // welcome and the free-armed farewell.
    if (action === "welcome") {
      rig.torso.rotation.x += Math.sin(Math.min(1, actionTime * 2.4) * Math.PI) * 0.07;
    }

    // Free-arm gestures — only once the tea has been handed off. While he holds
    // the cup the arms belong to the IK cradle and these are skipped.
    if (!hasCup) {
      if (action === "welcome") {
        setRotation(rig.armL, -0.12, 0, 0.98);
        setRotation(rig.foreL, 0.5, 0, 0.1);
        setRotation(rig.armR, -0.12, 0, -0.98);
        setRotation(rig.foreR, 0.5, 0, -0.1);
      } else if (action === "talk") {
        const g = 0.5 + Math.sin(time * 1.4) * 0.16;
        setRotation(rig.armL, 0.24, 0.1, 0.68 + Math.sin(time * 1.1) * 0.12);
        setRotation(rig.foreL, g, 0, 0.1);
        setRotation(rig.armR, 0.3, -0.1, -0.6 - Math.sin(time * 1.1 + 1) * 0.12);
        setRotation(rig.foreR, g * 0.9, 0, 0);
      } else if (action === "point") {
        // The wise elder points the way: left arm out toward the landmark with
        // the index extended, alive with a slow lift.
        const lift = 0.92 + Math.sin(time * 1.6) * 0.12;
        setRotation(rig.armL, lift, 0.2, 0.4);
        setRotation(rig.foreL, 0.06, 0, 0);
        setRotation(rig.armR, 0.32, 0, -0.2);
        setRotation(rig.foreR, 0.6, 0, 0);
      }
    }

    capturePose(targetPose);
    blendToTargetPose(safeDt);

    // ---- hands + cup ----
    presentT = THREE.MathUtils.damp(presentT, action === "serve" ? 1 : 0, 6, safeDt);
    if (hasCup) {
      rig.group.updateWorldMatrix(true, true);
      cupLocal.lerpVectors(cupHold, cupOffer, presentT);
      cupLocal.y += Math.sin(time * 1.5) * 0.006; // a soft breath keeps it alive
      cupAnchor.position.copy(cupLocal);
      cupAnchor.rotation.set(0, 0, 0);
      // Hand targets sit just below and outboard of the bowl (world space); the
      // runtime 2-bone IK reaches both mitts there and HAND_CUP curls the
      // fingers up around it. The cup rides between them.
      rig.torso.localToWorld(targetWorldL.copy(cupLocal).add(handOffL));
      rig.torso.localToWorld(targetWorldR.copy(cupLocal).add(handOffR));
      rig.torso.getWorldQuaternion(torsoQuat);
      aimL.copy(torsoQuat).multiply(tiltL);
      aimR.copy(torsoQuat).multiply(tiltR);
      try {
        setHandTarget(rig, "L", { pos: targetWorldL, aim: aimL, hand: HAND_CUP });
        setHandTarget(rig, "R", { pos: targetWorldR, aim: aimR, hand: HAND_CUP });
        ikError = "";
      } catch (e) {
        ikError = String((e as Error)?.message ?? e).slice(0, 120);
      }
    } else if (action === "point") {
      setHandPose(rig, "L", HAND_POINT); // index leads
      setHandPose(rig, "R", HAND_RELAXED);
    } else {
      setHandPose(rig, "L", HAND_RELAXED);
      setHandPose(rig, "R", HAND_RELAXED);
    }
    cup.visible = hasCup;
    steam.update(safeDt, hasCup);

    const speaking = action === "talk" || action === "point" || action === "welcome";
    const syllable = speaking ? 0.18 + (Math.sin(time * 7.1) * 0.5 + 0.5) * 0.72 : 0;
    mouthBlend = THREE.MathUtils.damp(mouthBlend, syllable, 15, safeDt);
    mouthOpen.visible = true;
    smile.visible = true;
    mouthOpen.scale.x = 0.22 + mouthBlend * 1.03;
    mouthOpen.scale.y = 0.06 + mouthBlend * 0.58;
    mouthOpen.scale.z = 0.35;
    smile.scale.y = 1 - mouthBlend * 0.7;

    if (lookTarget) {
      headTarget.set(lookTarget.x, lookTarget.y ?? group.position.y + 1.55, lookTarget.z);
      localTarget.copy(headTarget);
      group.worldToLocal(localTarget);
      const desiredYaw = THREE.MathUtils.clamp(Math.atan2(-localTarget.x, -localTarget.z), -0.55, 0.55);
      const desiredPitch = THREE.MathUtils.clamp(Math.atan2(localTarget.y - 1.55, Math.hypot(localTarget.x, localTarget.z)), -0.28, 0.25);
      rig.head.rotation.y = THREE.MathUtils.damp(rig.head.rotation.y, desiredYaw, 4.2, safeDt);
      rig.head.rotation.x = THREE.MathUtils.damp(rig.head.rotation.x, desiredPitch, 4.2, safeDt);
    }

    const headingDelta = Math.atan2(
      Math.sin(group.rotation.y - previousHeading),
      Math.cos(group.rotation.y - previousHeading)
    );
    const turn = safeDt > 1e-5 ? THREE.MathUtils.clamp(headingDelta / safeDt / 4, -1, 1) : 0;
    previousHeading = group.rotation.y;
    costume.update(safeDt, walkBlend, turn);
  };

  return {
    group,
    dialogueAnchor,
    cupAnchor,
    setAction,
    setCarryingCup(has: boolean) {
      hasCup = has;
    },
    update,
    debugState() {
      capturePose(currentPose);
      group.updateWorldMatrix(true, true);
      rig.handL.getWorldPosition(handLWorld);
      rig.handR.getWorldPosition(handRWorld);
      cupAnchor.getWorldPosition(cupWorld);
      return {
        action,
        position: group.position.toArray() as [number, number, number],
        joints: Array.from(currentPose),
        walkBlend,
        stridePhase,
        cupToLeftHand: cupWorld.distanceTo(handLWorld),
        cupToRightHand: cupWorld.distanceTo(handRWorld),
        hasCup,
        presentT,
        ikError,
        cupWorldPos: cupWorld.toArray() as [number, number, number],
        yaw: group.rotation.y
      };
    },
    dispose() {
      costume.dispose();
      steam.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const value of materials) value.dispose();
      for (const value of Object.values(rig.avatar.materials)) value.dispose();
      group.removeFromParent();
    }
  };
}
