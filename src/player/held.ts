import * as THREE from "three/webgpu";
import { setHandPose, HAND_GRIP as GRIP_POSE, type HandPose, type Rig } from "./rig";
import { enableShadowLayer, SHADOW_LAYERS } from "../world/shadows/shadowLayers";

/**
 * Grip system: puts items (clubs, paddles, bows, arrows, anything) into a
 * rig's articulated mitts. Works for the local player and every NPC — same
 * Rig type from buildRig.
 *
 * Hand grip frame: the pocket the curled fingers enclose (see setHandPose),
 * axis-aligned with the hand group, translated to HAND_GRIP below. The grip
 * bar axis is the hand's local X — the fingers wrap around X, so any item's
 * handle must line its long axis up with grip-frame X. A GripSpec names the
 * grip point + orientation in ITEM-local coordinates; attachToHand solves the
 * item transform so that frame lands on the hand's.
 */

/** Grip pocket in hand-group local space: under the palm's front half, where
 *  the proximal+distal curl closes against the thumb. */
const HAND_GRIP = new THREE.Vector3(0, -0.05, -0.038);

export type GripSpec = {
  /** Grip point in item-local coordinates. */
  position: [number, number, number];
  /** Euler XYZ of the grip frame in item-local coordinates. The frame's X axis
   *  must run along the item's handle (the bar the fingers wrap). Rotating the
   *  frame about its own X spins the item around the grip bar. */
  rotation?: [number, number, number];
  /** Finger shape applied on attach. A scalar 0..1 curls the whole mitt (the
   *  old behaviour); a {@link HandPose} lets a grip pick per-finger shapes
   *  (e.g. a loose wrap vs a pinch). Default: {@link HAND_GRIP} (wrap a bar). */
  curl?: number | HandPose;
};

export type HeldItem = {
  object: THREE.Object3D;
  side: "L" | "R";
  /** Un-parents the item from the hand and opens the hand. The item keeps its
   *  last local transform; re-add it to a scene (or re-attach) as needed. */
  release(): void;
};

// attach-time scratch (attachToHand is not a per-frame path, but rigs churn —
// NPC crowds attach/release on wake)
const S = {
  quat: new THREE.Quaternion(),
  euler: new THREE.Euler(),
  vec: new THREE.Vector3()
};

/**
 * Parent `object` under the rig's hand so the item's GripSpec frame coincides
 * with the hand's grip frame, and curl the fingers around it. applyAvatarToRig
 * scales hand groups per outfit (dress/overalls shrink mitts) — the item's
 * scale is compensated so a 1.1 m club stays 1.1 m in world space.
 */
export function attachToHand(rig: Rig, side: "L" | "R", object: THREE.Object3D, spec: GripSpec): HeldItem {
  const hand = side === "R" ? rig.handR : rig.handL;
  const rot = spec.rotation;
  S.quat.setFromEuler(S.euler.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0)).invert();
  object.quaternion.copy(S.quat);
  const invScale = 1 / hand.scale.x; // uniform (applyAvatarToRig uses setScalar)
  object.scale.setScalar(invScale);
  S.vec.set(spec.position[0], spec.position[1], spec.position[2]).applyQuaternion(S.quat).multiplyScalar(invScale);
  object.position.copy(HAND_GRIP).sub(S.vec);
  hand.add(object);
  setHandPose(rig, side, spec.curl ?? GRIP_POSE);
  return {
    object,
    side,
    release() {
      hand.remove(object);
      // wrist neutral too: only item-carrying poses (poseGolf) rotate the hand
      // group, and the ordinary poses never reset it
      hand.rotation.set(0, 0, 0);
      setHandPose(rig, side, 0);
    }
  };
}

/** Curl the OTHER hand as if gripping the same handle (two-handed holds: golf
 *  trail hand, bow draw hand). The pose fn is responsible for actually placing
 *  that hand on the item — this only closes the fingers. For a two-handed hold
 *  where the off hand should also LAND on a second grip point, drive it with
 *  setHandTarget (handIK.ts) each frame instead. */
export function secondHandCurl(rig: Rig, side: "L" | "R", curl: number | HandPose = GRIP_POSE): void {
  setHandPose(rig, side, curl);
}

/* ---------------------------------------------------------- item builders */

// one shared material set for every instance of every item — never per-build
const MAT = {
  dark: new THREE.MeshLambertMaterial({ color: 0x1b1d22 }),
  clubGrip: new THREE.MeshLambertMaterial({ color: 0x263137 }),
  clubShaft: new THREE.MeshLambertMaterial({ color: 0xa9b8be }),
  clubHead: new THREE.MeshLambertMaterial({ color: 0x5c6d73 }),
  paddleFace: new THREE.MeshLambertMaterial({ color: 0xf1c84c }),
  paddleEdge: new THREE.MeshLambertMaterial({ color: 0x191d20 }),
  bowWood: new THREE.MeshLambertMaterial({ color: 0x6b4a2f }),
  bowLimb: new THREE.MeshLambertMaterial({ color: 0x8a6238 }),
  bowString: new THREE.MeshLambertMaterial({ color: 0xd8d4c8 }),
  arrowShaft: new THREE.MeshLambertMaterial({ color: 0xc9a86a }),
  arrowFletch: new THREE.MeshLambertMaterial({ color: 0xdd5544 }),
  arrowTip: new THREE.MeshLambertMaterial({ color: 0x8f979c })
};

/** Lightweight club prop. Origin = the TOP of the grip (where the joined hands
 *  hold it), shaft hanging down local -Y. In the golfer's address frame the
 *  ball is in front (local -Z) and the target is to the lead side (local -X),
 *  so the head's toe points -Z (away from the golfer) and its face plate looks
 *  -X (down the line). Built hidden — the owner shows it while in use. */
export function buildGolfClub(): THREE.Group {
  const group = new THREE.Group();
  group.name = "golf-club";

  // ~1.1 m grip-to-head so it reaches from the chest-high joined hands down to
  // a ball out in front at a natural ~45° address lie (measured w/ golf-pose-probe)
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.022, 0.24, 7), MAT.clubGrip);
  grip.position.y = -0.11;
  grip.name = "club-grip";
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.017, 0.86, 7), MAT.clubShaft);
  shaft.position.y = -0.66;
  // head: heel at the shaft, toe reaching -Z; a brighter face plate on the -X
  // (target) side reads as "this is the side that hits the ball"
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.08, 0.22), MAT.clubHead);
  head.position.set(-0.005, -1.11, -0.06);
  head.name = "club-head";
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.07, 0.2), MAT.clubShaft);
  face.position.set(-0.052, -1.11, -0.06);
  const sole = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.23), MAT.dark);
  sole.position.set(-0.005, -1.157, -0.06);
  for (const mesh of [grip, shaft, head, face, sole]) {
    // Shaft + head define the readable club shadow. Grip, face plate, and sole
    // still receive but are sub-texel duplicate caster work.
    mesh.castShadow = mesh === shaft || mesh === head;
    if (mesh.castShadow) enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.visible = false;
  return group;
}

/** Lead-hand hold near the top of the grip; the trail hand stacks just below
 *  via secondHandCurl + poseGolf bringing both hands to the sternum. Grip X
 *  runs UP the shaft (+Y) so the butt pokes past the pinky like a real hold;
 *  the X-spin term rolls the face square. */
export const GOLF_CLUB_GRIP: GripSpec = {
  position: [0, -0.05, 0],
  rotation: [0, 0, Math.PI / 2]
};

/** Pickleball paddle matching the Goldman courts look (playerRig.ts): dark
 *  octagon-ish handle + elongated round face. Origin = TOP of the handle,
 *  handle down -Y, face plate normal ±Z. ~0.44 m tip-to-butt. */
export function buildPickleballPaddle(): THREE.Group {
  const group = new THREE.Group();
  group.name = "pickleball-paddle";
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.24, 0.055), MAT.paddleEdge);
  handle.position.y = -0.09;
  const edgeGeometry = new THREE.CylinderGeometry(0.152, 0.152, 0.022, 20);
  edgeGeometry.rotateX(Math.PI / 2);
  const edge = new THREE.Mesh(edgeGeometry, MAT.paddleEdge);
  edge.position.y = -0.31;
  edge.scale.y = 1.18;
  const faceGeometry = new THREE.CylinderGeometry(0.139, 0.139, 0.026, 20);
  faceGeometry.rotateX(Math.PI / 2);
  const face = new THREE.Mesh(faceGeometry, MAT.paddleFace);
  face.name = "pickleball-paddle-face";
  face.position.y = -0.31;
  face.scale.y = 1.18;
  for (const mesh of [handle, edge, face]) {
    // The inset face covers essentially the same projection as the edge.
    mesh.castShadow = mesh === handle || mesh === face;
    if (mesh.castShadow) enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Handle mid-grip; face swings up when the forearm raises. */
export const PADDLE_GRIP: GripSpec = {
  position: [0, -0.1, 0],
  rotation: [0, 0, Math.PI / 2]
};

/** Simple recurve bow, ~1.2 m tip to tip. Origin = riser grip midpoint. Limbs
 *  run ±Y and sweep AWAY from the archer: the belly/string side is +Z (toward
 *  the archer's face at full draw), the back of the bow points -Z downrange —
 *  same convention as the avatar's front. String = one thin cylinder tip to
 *  tip on the +Z side. */
export function buildBow(): THREE.Group {
  const group = new THREE.Group();
  group.name = "bow";
  const riser = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.3, 0.055), MAT.bowWood);
  riser.castShadow = true;
  enableShadowLayer(riser, SHADOW_LAYERS.HERO_DYNAMIC);
  riser.receiveShadow = true;
  group.add(riser);
  // each limb = two angled segments curving back toward +Z at the tip (recurve)
  for (const dir of [1, -1]) {
    const inner = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.34, 0.026), MAT.bowLimb);
    inner.position.set(0, dir * 0.29, -0.035);
    inner.rotation.x = dir * 0.28; // leans away downrange
    const outer = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.26, 0.022), MAT.bowLimb);
    outer.position.set(0, dir * 0.52, -0.02);
    outer.rotation.x = -dir * 0.38; // recurves back toward the string
    for (const m of [inner, outer]) {
      m.castShadow = true;
      enableShadowLayer(m, SHADOW_LAYERS.HERO_DYNAMIC);
      m.receiveShadow = true;
      group.add(m);
    }
  }
  // string between the limb tips (±0.62 Y, slightly +Z of the riser)
  const string = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 1.24, 4), MAT.bowString);
  string.position.set(0, 0, 0.055);
  string.name = "bow-string";
  string.receiveShadow = true;
  group.add(string);
  return group;
}

/** Riser held vertically: grip X along the riser (+Y) so the fist wraps it,
 *  string side toward the archer. */
export const BOW_GRIP: GripSpec = {
  position: [0, 0, 0],
  rotation: [0, 0, Math.PI / 2]
};

/** Arrow, 0.7 m. Origin = the NOCK (string end), +Y toward the tip. */
export function buildArrow(): THREE.Group {
  const group = new THREE.Group();
  group.name = "arrow";
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.66, 5), MAT.arrowShaft);
  shaft.position.y = 0.35;
  // Seven-millimetre arrow parts are below the useful CSM texel scale. They
  // receive close shade but intentionally add no shadow-pass draws.
  shaft.receiveShadow = true;
  group.add(shaft);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.06, 5), MAT.arrowTip);
  tip.position.y = 0.7;
  tip.receiveShadow = true;
  group.add(tip);
  // three fletch fins around the nock end
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.09, 0.028), MAT.arrowFletch);
    fin.position.set(0, 0.075, 0);
    fin.rotation.y = (i / 3) * Math.PI * 2;
    fin.translateZ(0.016);
    fin.receiveShadow = true;
    group.add(fin);
  }
  return group;
}

/** Pinched mid-shaft (carried/nocked arrows are usually posed by gameplay code
 *  directly against the bow; this spec is for the "holding an arrow" case). */
export const ARROW_GRIP: GripSpec = {
  position: [0, 0.3, 0],
  rotation: [0, 0, -Math.PI / 2],
  curl: 0.85
};
