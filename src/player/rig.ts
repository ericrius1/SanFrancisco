import * as THREE from "three/webgpu";
import {
  avatarFromSeed,
  CLOTHING_COLORS,
  HAIR_COLORS,
  SKIN_TONES,
  type AvatarHair,
  type AvatarHat,
  type AvatarOutfit,
  type AvatarTraits
} from "./avatar";
import { enableShadowLayer, SHADOW_LAYERS } from "../world/shadows/shadowLayers";

/**
 * The player character: a chunky stylized figure with real joints — neck,
 * shoulders, elbows, hips, knees — so poses read at a glance. Front is local
 * -Z (cap brim, visor and shoe toes all point that way), which is what makes
 * facing legible from any camera angle. Pose functions overwrite the joint
 * rotations every frame from current control state; the reactive inputs
 * (lean, steer) are smoothed by the caller, so poses stay deterministic.
 *
 * Sign conventions (limbs hang along -Y): rotation.x > 0 swings a limb toward
 * -Z (forward); knees bend with negative x, elbows with positive x.
 */

export type Rig = {
  group: THREE.Group; // origin at standing hip height (the body/capsule centre)
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  foreL: THREE.Group;
  foreR: THREE.Group;
  handL: THREE.Group; // mitt group at the wrist tip (grip frame for held items)
  handR: THREE.Group;
  // articulated mitt joints, cached at build so setHandPose is lookup-free.
  // The finger row is split into two independently-hinged 2-segment chains so
  // the hand can POINT (index out, rest curled) as well as grip/open: `index`
  // is the narrow thumb-side finger, `fingers` the fused middle+ring+pinky
  // block. Each has a proximal hinge at the palm's front-bottom edge and a
  // distal `…Tip` nested inside. `thumb` hinges on the inner palm edge and
  // sweeps across to oppose.
  fingersL: THREE.Group;
  fingersR: THREE.Group;
  fingersTipL: THREE.Group;
  fingersTipR: THREE.Group;
  indexL: THREE.Group;
  indexR: THREE.Group;
  indexTipL: THREE.Group;
  indexTipR: THREE.Group;
  thumbL: THREE.Group;
  thumbR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  soleL: THREE.Mesh;
  soleR: THREE.Mesh;
  avatar: RigAvatarState;
};

type AvatarMaterials = {
  jacket: THREE.MeshLambertMaterial;
  sleeve: THREE.MeshLambertMaterial;
  shirt: THREE.MeshLambertMaterial;
  pants: THREE.MeshLambertMaterial;
  shoe: THREE.MeshLambertMaterial;
  sole: THREE.MeshLambertMaterial;
  skin: THREE.MeshLambertMaterial;
  hat: THREE.MeshLambertMaterial;
  visor: THREE.MeshLambertMaterial;
  pack: THREE.MeshLambertMaterial;
  hair: THREE.MeshLambertMaterial;
  trim: THREE.MeshLambertMaterial;
};

export type RigAvatarState = {
  materials: AvatarMaterials;
  torsoBlock: THREE.Mesh;
  hipBlock: THREE.Mesh;
  headBlock: THREE.Mesh;
  armBlocks: THREE.Mesh[];
  legBlocks: THREE.Mesh[];
  hair: Record<AvatarHair, THREE.Object3D[]>;
  /** Top-of-head hair slabs that sit under fitted hats (cap/beanie). */
  hairCrowns: THREE.Object3D[];
  hats: Record<AvatarHat, THREE.Object3D[]>;
  outfits: Record<AvatarOutfit, THREE.Object3D[]>;
  allHair: THREE.Object3D[];
  allHats: THREE.Object3D[];
  allOutfits: THREE.Object3D[];
};

const DEFAULT_RIG_AVATAR = avatarFromSeed("local-default");

const STATIC_MAT = {
  sole: new THREE.MeshLambertMaterial({ color: 0x1b1d22 })
};

// tiny geometry cache — three rigs share every box size they have in common
const geoCache = new Map<string, THREE.BoxGeometry>();
function boxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w}_${h}_${d}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    geoCache.set(key, g);
  }
  return g;
}

function part(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat);
  m.position.set(x, y, z);
  // Only silhouette-scale boxes cast: small detail (shades, nose, straps,
  // trim) is invisible at CSM resolution, yet every caster re-encodes into
  // each shadow cascade — and this rig exists per player AND per busker.
  m.castShadow = w * h * d >= 1.5e-3;
  if (m.castShadow) enableShadowLayer(m, SHADOW_LAYERS.HERO_DYNAMIC);
  // Receiving does not add caster draws, so every visible opaque rig surface
  // can carry self-shadow and shade from the vehicle/world at close range.
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function color(hex: number, scale = 1): THREE.Color {
  const c = new THREE.Color(hex);
  return scale < 1 ? c.multiplyScalar(scale) : c.lerp(new THREE.Color(0xffffff), Math.min(1, scale - 1));
}

function makeAvatarMaterials(): AvatarMaterials {
  // tinted parts are coloured by applyAvatarToRig (the single source of truth);
  // only the fixed parts carry a real colour here
  const tint = () => new THREE.MeshLambertMaterial();
  return {
    jacket: tint(),
    sleeve: tint(),
    shirt: tint(),
    pants: tint(),
    shoe: new THREE.MeshLambertMaterial({ color: 0xe8e4da }),
    sole: new THREE.MeshLambertMaterial({ color: 0x1b1d22 }),
    skin: tint(),
    hat: tint(),
    visor: new THREE.MeshLambertMaterial({ color: 0x14181e }),
    pack: tint(),
    hair: tint(),
    trim: tint()
  };
}

function push<T extends THREE.Object3D>(bucket: THREE.Object3D[], item: T): T {
  bucket.push(item);
  return item;
}

function setVisible(items: THREE.Object3D[], on: boolean) {
  for (const item of items) item.visible = on;
}

export function applyAvatarToRig(rig: Rig, avatar: AvatarTraits) {
  const s = rig.avatar;
  const primary = CLOTHING_COLORS[avatar.color].color;
  const accent = CLOTHING_COLORS[avatar.accent].color;
  const skin = SKIN_TONES[avatar.skin].color;
  const hair = HAIR_COLORS[(avatar.skin + avatar.color + avatar.accent) % HAIR_COLORS.length];
  const dress = avatar.outfit === "dress";

  const primaryColor = new THREE.Color(primary);
  const brightAccent = color(accent, 1.35);
  // cloth to the wrist for every outfit. tee used to leave the arm blocks
  // skin-toned under tiny shoulder caps, which read as bare beefy arms —
  // cover them in the shirt color (handpanist forces skin back on after build).
  const sleeveColor =
    avatar.outfit === "overalls"
      ? brightAccent
      : avatar.outfit === "tee" || dress
        ? color(primary, dress ? 0.9 : 1)
        : color(primary, 0.82);
  const torsoColor = avatar.outfit === "overalls" ? brightAccent : primaryColor;
  const pantsColor =
    avatar.outfit === "overalls" ? color(primary, 0.58) : dress ? new THREE.Color(0x20242b) : new THREE.Color(0x30343c);

  s.materials.jacket.color.copy(torsoColor);
  s.materials.sleeve.color.copy(sleeveColor);
  s.materials.shirt.color.copy(color(accent, avatar.outfit === "tee" ? 1.15 : 1.35));
  s.materials.pants.color.copy(pantsColor);
  s.materials.skin.color.set(skin);
  s.materials.hat.color.set(accent);
  s.materials.pack.color.copy(color(primary, 0.55));
  s.materials.hair.color.set(hair);
  s.materials.trim.color.set(accent);

  setVisible(s.allHair, false);
  setVisible(s.allHats, false);
  setVisible(s.allOutfits, false);
  // Long hair keeps side/back locks under any hat; other styles only show when
  // the hat leaves the scalp open (none / visor / crown).
  const showHair =
    avatar.hair === "long" || avatar.hat === "none" || avatar.hat === "visor" || avatar.hat === "crown";
  setVisible(s.hair[avatar.hair], showHair);
  // Fitted hats own the scalp — hide crown slabs so they don't share a plane
  // with the hat (long+cap/beanie used to z-fight along the hat band).
  if (avatar.hat === "cap" || avatar.hat === "beanie") setVisible(s.hairCrowns, false);
  setVisible(s.hats[avatar.hat], true);
  setVisible(s.outfits[avatar.outfit], true);

  // dress + overalls get a feminine silhouette; tee/jacket/hoodie keep stock bulk
  // (tee arms are covered above, just not slimmed — guys wear tees too)
  if (dress) {
    s.torsoBlock.scale.set(0.84, 1, 0.92);
    s.hipBlock.scale.set(1.22, 1.04, 1.1);
    s.headBlock.scale.setScalar(0.9);
    for (const arm of s.armBlocks) arm.scale.set(0.62, 1, 0.62);
    for (const leg of s.legBlocks) leg.scale.set(0.86, 1, 0.88);
    rig.armL.position.x = 0.235;
    rig.armR.position.x = -0.235;
    rig.handL.scale.setScalar(0.8);
    rig.handR.scale.setScalar(0.8);
  } else if (avatar.outfit === "overalls") {
    s.torsoBlock.scale.set(0.9, 1, 0.96);
    s.hipBlock.scale.set(1.14, 1.02, 1.06);
    s.headBlock.scale.setScalar(0.94);
    for (const arm of s.armBlocks) arm.scale.set(0.7, 1, 0.7);
    for (const leg of s.legBlocks) leg.scale.set(0.9, 1, 0.92);
    rig.armL.position.x = 0.25;
    rig.armR.position.x = -0.25;
    rig.handL.scale.setScalar(0.86);
    rig.handR.scale.setScalar(0.86);
  } else {
    s.torsoBlock.scale.set(1, 1, 1);
    s.hipBlock.scale.set(1.02, 1, 1);
    s.headBlock.scale.setScalar(1);
    for (const arm of s.armBlocks) arm.scale.set(1, 1, 1);
    for (const leg of s.legBlocks) leg.scale.set(1, 1, 1);
    rig.armL.position.x = 0.28;
    rig.armR.position.x = -0.28;
    rig.handL.scale.setScalar(1);
    rig.handR.scale.setScalar(1);
  }
}

export function buildRig(avatar: AvatarTraits = DEFAULT_RIG_AVATAR): Rig {
  const materials = makeAvatarMaterials();
  const group = new THREE.Group();
  const hair: RigAvatarState["hair"] = { short: [], bob: [], mohawk: [], buzz: [], long: [] };
  const hairCrowns: THREE.Object3D[] = [];
  const hats: RigAvatarState["hats"] = { none: [], cap: [], beanie: [], visor: [], crown: [] };
  const outfits: RigAvatarState["outfits"] = { jacket: [], hoodie: [], tee: [], overalls: [], dress: [] };
  const allHair: THREE.Object3D[] = [];
  const allHats: THREE.Object3D[] = [];
  const allOutfits: THREE.Object3D[] = [];
  const armBlocks: THREE.Mesh[] = [];
  const legBlocks: THREE.Mesh[] = [];
  const crown = <T extends THREE.Object3D>(item: T): T => {
    hairCrowns.push(item);
    return item;
  };

  const hips = new THREE.Group();
  group.add(hips);
  const hipBlock = part(hips, materials.pants, 0.36, 0.22, 0.24, 0, 0.01, 0);

  const torso = new THREE.Group();
  torso.position.y = 0.12;
  hips.add(torso);
  const torsoBlock = part(torso, materials.jacket, 0.44, 0.42, 0.26, 0, 0.22, 0);
  push(outfits.jacket, part(torso, materials.shirt, 0.1, 0.38, 0.03, 0, 0.22, -0.135)); // zip stripe
  push(outfits.jacket, part(torso, materials.pack, 0.34, 0.34, 0.14, 0, 0.2, 0.2)); // backpack = instant back-of-player cue
  push(outfits.jacket, part(torso, materials.sole, 0.06, 0.3, 0.02, -0.12, 0.24, -0.14)); // pack straps
  push(outfits.jacket, part(torso, materials.sole, 0.06, 0.3, 0.02, 0.12, 0.24, -0.14));
  push(outfits.hoodie, part(torso, materials.trim, 0.25, 0.13, 0.08, 0, 0.42, 0.12));
  push(outfits.hoodie, part(torso, materials.shirt, 0.24, 0.08, 0.035, 0, 0.11, -0.15));
  push(outfits.hoodie, part(torso, materials.shirt, 0.16, 0.04, 0.03, 0, 0.31, -0.15));
  push(outfits.tee, part(torso, materials.trim, 0.18, 0.16, 0.035, 0, 0.25, -0.15));
  push(outfits.tee, part(torso, materials.jacket, 0.14, 0.12, 0.15, -0.29, 0.33, 0));
  push(outfits.tee, part(torso, materials.jacket, 0.14, 0.12, 0.15, 0.29, 0.33, 0));
  push(outfits.overalls, part(torso, materials.pants, 0.08, 0.36, 0.035, -0.1, 0.22, -0.15));
  push(outfits.overalls, part(torso, materials.pants, 0.08, 0.36, 0.035, 0.1, 0.22, -0.15));
  push(outfits.overalls, part(torso, materials.trim, 0.27, 0.1, 0.04, 0, 0.12, -0.155));
  push(outfits.dress, part(torso, materials.shirt, 0.16, 0.2, 0.035, 0, 0.29, -0.15));
  push(outfits.dress, part(torso, materials.trim, 0.38, 0.05, 0.29, 0, 0.02, 0));
  push(outfits.dress, part(hips, materials.jacket, 0.52, 0.38, 0.3, 0, -0.17, 0));
  push(outfits.dress, part(hips, materials.trim, 0.54, 0.055, 0.31, 0, -0.34, -0.01));
  allOutfits.push(...outfits.jacket, ...outfits.hoodie, ...outfits.tee, ...outfits.overalls, ...outfits.dress);

  const head = new THREE.Group();
  head.position.y = 0.46;
  torso.add(head);
  part(head, materials.skin, 0.12, 0.1, 0.12, 0, 0.04, 0); // neck
  const headBlock = part(head, materials.skin, 0.26, 0.26, 0.26, 0, 0.2, 0);
  part(head, materials.visor, 0.24, 0.07, 0.03, 0, 0.23, -0.145); // shades
  part(head, materials.skin, 0.05, 0.06, 0.05, 0, 0.15, -0.15); // nose
  // Hair crowns sit flush on the scalp (head top y=0.33) so their bottom face
  // doesn't share a plane with the head block. Height is short enough that a
  // forehead visor clears below them.
  push(hair.short, crown(part(head, materials.hair, 0.29, 0.05, 0.28, 0, 0.365, 0)));
  push(hair.buzz, crown(part(head, materials.hair, 0.28, 0.024, 0.28, 0, 0.342, 0)));
  push(hair.bob, crown(part(head, materials.hair, 0.3, 0.05, 0.28, 0, 0.365, 0)));
  push(hair.bob, part(head, materials.hair, 0.07, 0.22, 0.12, -0.17, 0.21, 0.03));
  push(hair.bob, part(head, materials.hair, 0.07, 0.22, 0.12, 0.17, 0.21, 0.03));
  push(hair.long, crown(part(head, materials.hair, 0.3, 0.05, 0.28, 0, 0.365, 0)));
  push(hair.long, part(head, materials.hair, 0.24, 0.28, 0.08, 0, 0.16, 0.16));
  push(hair.long, part(head, materials.hair, 0.055, 0.24, 0.08, -0.17, 0.18, 0.08));
  push(hair.long, part(head, materials.hair, 0.055, 0.24, 0.08, 0.17, 0.18, 0.08));
  push(hair.mohawk, crown(part(head, materials.hair, 0.09, 0.18, 0.32, 0, 0.39, 0)));
  allHair.push(...hair.short, ...hair.bob, ...hair.mohawk, ...hair.buzz, ...hair.long);
  // Hats sit a few mm proud of the scalp / hair crown so opaque boxes don't
  // share a depth plane (reversed-z prefers spatial separation over polygonOffset).
  push(hats.cap, part(head, materials.hat, 0.28, 0.1, 0.28, 0, 0.355, 0));
  push(hats.cap, part(head, materials.hat, 0.26, 0.03, 0.16, 0, 0.32, -0.2)); // brim
  push(hats.beanie, part(head, materials.hat, 0.29, 0.12, 0.29, 0, 0.365, 0));
  push(hats.beanie, part(head, materials.trim, 0.31, 0.04, 0.3, 0, 0.305, 0));
  push(hats.visor, part(head, materials.hat, 0.3, 0.045, 0.29, 0, 0.318, 0));
  push(hats.visor, part(head, materials.hat, 0.28, 0.03, 0.18, 0, 0.305, -0.2));
  // Crown band sits above the hair crown top (~0.39) so both can stay visible.
  push(hats.crown, part(head, materials.hat, 0.3, 0.045, 0.3, 0, 0.42, 0));
  for (const x of [-0.11, 0, 0.11]) push(hats.crown, part(head, materials.trim, 0.055, 0.13, 0.055, x, 0.48, -0.08));
  allHats.push(...hats.cap, ...hats.beanie, ...hats.visor, ...hats.crown);

  const arm = (side: 1 | -1) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.28, 0.38, 0);
    torso.add(shoulder);
    armBlocks.push(part(shoulder, materials.sleeve, 0.12, 0.3, 0.14, 0, -0.13, 0));
    const fore = new THREE.Group();
    fore.position.y = -0.3;
    shoulder.add(fore);
    armBlocks.push(part(fore, materials.sleeve, 0.1, 0.16, 0.12, 0, -0.07, 0));
    part(fore, materials.skin, 0.09, 0.12, 0.1, 0, -0.2, 0); // wrist
    // Articulated mitt: palm stays put; a two-segment finger chain hinges at
    // the palm's front-bottom edge and a thumb sweeps across from the inner
    // edge. setHandPose curls all three so a 0.03–0.05 m grip bar (club shaft,
    // paddle handle, bow riser — axis = hand local X) sits enclosed in the
    // pocket under the palm front. All boxes stay under the castShadow volume
    // threshold — this rig exists per player AND per NPC.
    const hand = new THREE.Group();
    hand.position.set(0, -0.3, -0.01); // same spot the old hand box sat
    hand.name = side === 1 ? "hand-L" : "hand-R";
    fore.add(hand);
    part(hand, materials.skin, 0.09, 0.1, 0.11, 0, 0, 0); // palm
    // Finger row split into two independent 2-segment chains. `fingers` is the
    // fused middle+ring+pinky block (outer ~3/4 of the row, biased away from the
    // thumb); `index` is the narrow thumb-side finger that can extend to point
    // while the rest curl. Both hinge at the same palm front-bottom edge as the
    // old single block, so a grip bar on hand local-X still closes inside them.
    const fingers = new THREE.Group(); // proximal hinge, front-bottom of palm
    fingers.name = side === 1 ? "fingers-L" : "fingers-R";
    fingers.position.set(-side * 0.016, -0.038, -0.05);
    hand.add(fingers);
    part(fingers, materials.skin, 0.056, 0.028, 0.06, 0, -0.006, -0.022); // proximal segment
    const fingersTip = new THREE.Group(); // distal hinge at the proximal's far edge
    fingersTip.name = side === 1 ? "fingersTip-L" : "fingersTip-R";
    fingersTip.position.set(0, -0.006, -0.05);
    fingers.add(fingersTip);
    part(fingersTip, materials.skin, 0.052, 0.026, 0.048, 0, 0, -0.018); // distal segment
    const index = new THREE.Group(); // thumb-side pointer finger, own hinge
    index.name = side === 1 ? "index-L" : "index-R";
    index.position.set(side * 0.028, -0.038, -0.05);
    hand.add(index);
    part(index, materials.skin, 0.026, 0.028, 0.062, 0, -0.006, -0.023); // proximal segment
    const indexTip = new THREE.Group();
    indexTip.name = side === 1 ? "indexTip-L" : "indexTip-R";
    indexTip.position.set(0, -0.006, -0.052);
    index.add(indexTip);
    part(indexTip, materials.skin, 0.024, 0.026, 0.05, 0, 0, -0.019); // distal segment
    const thumb = new THREE.Group(); // inner-edge hinge, opposes across the palm front
    thumb.name = side === 1 ? "thumb-L" : "thumb-R";
    thumb.position.set(side * 0.045, -0.025, -0.04);
    hand.add(thumb);
    part(thumb, materials.skin, 0.028, 0.032, 0.055, side * 0.004, -0.004, -0.02);
    return { shoulder, fore, hand, fingers, fingersTip, index, indexTip, thumb };
  };
  const aL = arm(1);
  const aR = arm(-1);

  const leg = (side: 1 | -1) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.13, -0.08, 0);
    hips.add(hip);
    legBlocks.push(part(hip, materials.pants, 0.16, 0.36, 0.18, 0, -0.19, 0));
    const shin = new THREE.Group();
    shin.position.y = -0.4;
    hip.add(shin);
    legBlocks.push(part(shin, materials.pants, 0.14, 0.3, 0.15, 0, -0.15, 0));
    part(shin, materials.shoe, 0.15, 0.09, 0.3, 0, -0.35, -0.06); // toe forward
    const sole = part(shin, materials.sole, 0.16, 0.03, 0.31, 0, -0.41, -0.06);
    sole.name = side === 1 ? "sole-L" : "sole-R";
    return { hip, shin, sole };
  };
  const lL = leg(1);
  const lR = leg(-1);

  const rig = {
    group,
    hips,
    torso,
    head,
    armL: aL.shoulder,
    armR: aR.shoulder,
    foreL: aL.fore,
    foreR: aR.fore,
    handL: aL.hand,
    handR: aR.hand,
    fingersL: aL.fingers,
    fingersR: aR.fingers,
    fingersTipL: aL.fingersTip,
    fingersTipR: aR.fingersTip,
    indexL: aL.index,
    indexR: aR.index,
    indexTipL: aL.indexTip,
    indexTipR: aR.indexTip,
    thumbL: aL.thumb,
    thumbR: aR.thumb,
    legL: lL.hip,
    legR: lR.hip,
    shinL: lL.shin,
    shinR: lR.shin,
    soleL: lL.sole,
    soleR: lR.sole,
    avatar: {
      materials,
      torsoBlock,
      hipBlock,
      headBlock,
      armBlocks,
      legBlocks,
      hair,
      hairCrowns,
      hats,
      outfits,
      allHair,
      allHats,
      allOutfits
    }
  };
  applyAvatarToRig(rig, avatar);
  return rig;
}

/** Per-finger closure for a stylized mitt. Each channel is 0 (extended) → 1
 *  (fully curled). Omitted channels inherit `fingers`, so a bare `{ fingers: 1 }`
 *  still makes a fist. `spread` splays the index away from the block for open or
 *  cradling gestures. Passing a plain number curls every channel equally (the
 *  original single-scalar behaviour). */
export type HandPose = {
  /** Middle+ring+pinky block. */
  fingers?: number;
  /** Thumb-side pointer finger; defaults to `fingers`. */
  index?: number;
  /** Opposing thumb; defaults to `fingers`. */
  thumb?: number;
  /** 0 = index tucked against the block, 1 = index splayed outboard. */
  spread?: number;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Named hand shapes for the common gestures. Reuse these instead of magic
 *  numbers so grips/poses across the app read the same. */
export const HAND_OPEN: HandPose = { fingers: 0, index: 0, thumb: 0 };
export const HAND_FIST: HandPose = { fingers: 1, index: 1, thumb: 1 };
/** Wrap a 0.03–0.05 m bar at the grip frame (see held.ts). */
export const HAND_GRIP: HandPose = { fingers: 0.92, index: 0.92, thumb: 0.95 };
/** Index extended, the rest curled — the wise-elder point. */
export const HAND_POINT: HandPose = { fingers: 1, index: 0.05, thumb: 0.55 };
/** Soft natural rest so open hands never read as rigid planks. */
export const HAND_RELAXED: HandPose = { fingers: 0.3, index: 0.24, thumb: 0.2 };
/** Shallow splayed cradle for holding a bowl/cup between the palms. */
export const HAND_CUP: HandPose = { fingers: 0.5, index: 0.48, thumb: 0.55, spread: 0.5 };

/** Curl a mitt. `pose` is either a single 0..1 scalar (curls the whole hand
 *  uniformly — the old behaviour) or a {@link HandPose} for per-finger control
 *  (point, cup, pinch…). Pure visual, layered AFTER the pose fns each frame:
 *  poses overwrite joint rotations but never touch the hand children, so
 *  there's no conflict. Allocation-free. */
export function setHandPose(rig: Rig, side: "L" | "R", pose: number | HandPose): void {
  const right = side === "R";
  const scalar = typeof pose === "number";
  const fCurl = clamp01(scalar ? (pose as number) : (pose as HandPose).fingers ?? 0);
  const iCurl = scalar ? fCurl : clamp01((pose as HandPose).index ?? fCurl);
  const tCurl = scalar ? fCurl : clamp01((pose as HandPose).thumb ?? fCurl);
  const spread = scalar ? 0 : clamp01((pose as HandPose).spread ?? 0);
  const sideSign = right ? -1 : 1;

  const fingers = right ? rig.fingersR : rig.fingersL;
  const fingersTip = right ? rig.fingersTipR : rig.fingersTipL;
  const index = right ? rig.indexR : rig.indexL;
  const indexTip = right ? rig.indexTipR : rig.indexTipL;
  const thumb = right ? rig.thumbR : rig.thumbL;

  fingers.rotation.x = -0.3 - 0.96 * fCurl; // rest slope + ~55° curl
  fingersTip.rotation.x = -0.12 - 1.31 * fCurl; // + ~75°
  index.rotation.x = -0.3 - 0.96 * iCurl;
  index.rotation.y = sideSign * spread * 0.42; // splay the pointer outboard
  indexTip.rotation.x = -0.12 - 1.31 * iCurl;
  // thumb hinges on the inner edge (+X for L, -X for R) and yaws across the
  // palm front to press the bar; a small x-curl drops it onto the grip
  thumb.rotation.y = sideSign * 0.8 * tCurl;
  thumb.rotation.x = -0.4 * tCurl;
}

/** Back-compat alias for the old single-flap clasp API (fetchBall, buskers). */
export function setRigClasp(rig: Rig, side: "L" | "R", amount: number): void {
  setHandPose(rig, side, amount);
}

/** World position of a throwing/holding hand. The caller MUST have updated world
 *  matrices this frame (i.e. call after the player's syncMesh). Writes into
 *  `out`, returns `out`. */
export function rigHandWorld(rig: Rig, side: "L" | "R", out: THREE.Vector3): THREE.Vector3 {
  return (side === "R" ? rig.handR : rig.handL).getWorldPosition(out);
}

/**
 * Steering wheel prop for open-cockpit vehicles: a tilted column holder with a
 * `spin` group (rim + spokes) the drive animation rotates by the steer angle.
 */
export function buildSteeringWheel(): { group: THREE.Group; spin: THREE.Group } {
  const group = new THREE.Group();
  const tilt = new THREE.Group();
  tilt.rotation.x = 0.45; // raked back toward the driver (+z)
  group.add(tilt);
  const column = new THREE.Mesh(boxGeo(0.06, 0.06, 0.3), STATIC_MAT.sole);
  column.position.set(0, 0, -0.16);
  tilt.add(column);
  const spin = new THREE.Group();
  tilt.add(spin);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.028, 8, 20), STATIC_MAT.sole);
  spin.add(rim);
  for (const a of [0, 2.09, -2.09]) {
    const spoke = new THREE.Mesh(boxGeo(0.03, 0.16, 0.03), STATIC_MAT.sole);
    spoke.position.set(Math.sin(a) * 0.08, Math.cos(a) * 0.08, 0);
    spoke.rotation.z = -a;
    spin.add(spoke);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 10), STATIC_MAT.sole);
  hub.rotation.x = Math.PI / 2;
  spin.add(hub);
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) mesh.receiveShadow = true;
  });
  return { group, spin };
}

// Item builders live with the grip system now; kept on this module for the
// pre-held.ts import paths (player.ts and probes).
export { buildGolfClub } from "./held";

/* ------------------------------------------------------------------- poses */

function set(g: THREE.Group, x: number, y: number, z: number) {
  g.rotation.set(x, y, z);
}

/** DEV-only spine-hinge override so tools/golf-pose-probe.mjs can sweep the
 *  golf address without a rebuild; ships as the constant 0.62. */
function golfHinge(): number {
  if (import.meta.env.DEV) {
    const t = (globalThis as unknown as { __golfTune?: { hinge?: number } }).__golfTune;
    if (t && typeof t.hinge === "number") return t.hinge;
  }
  return 0.62;
}

/** Golf wrist keyframes (lead hand; the trail hand mirrors y/z). The club is
 *  rigid in the lead mitt (held.ts attachToHand — shaft down hand -X), so the
 *  wrist IS the club: address lays the head on the ball, the top cocks the
 *  shaft high behind the trail shoulder, the finish releases it over the lead
 *  one. Solved against the live hand frame with the grip probe, DEV-sweepable
 *  via window.__golfTune (wax..wfz). */
const GOLF_WRIST = { ax: 0.477, ay: 1.246, az: -0.653, bx: -1.006, by: -1.215, bz: -1.338, fx: 0.607, fy: -0.912, fz: 1.136 };
type GolfWristTune = Partial<Record<`w${keyof typeof GOLF_WRIST}`, number>>;

export function poseIdle(r: Rig, t: number) {
  const breathe = Math.sin(t * 1.6);
  r.hips.position.y = 0;
  set(r.hips, 0, 0, 0);
  set(r.torso, 0.03 + breathe * 0.02, Math.sin(t * 0.23) * 0.05, 0);
  set(r.head, 0.02 + breathe * 0.015, Math.sin(t * 0.31) * 0.16, 0);
  set(r.legL, 0.03, 0, 0.02);
  set(r.legR, -0.03, 0, -0.02);
  set(r.shinL, -0.05, 0, 0);
  set(r.shinR, -0.05, 0, 0);
  set(r.armL, breathe * 0.03, 0, 0.08);
  set(r.armR, -breathe * 0.03, 0, -0.08);
  set(r.foreL, 0.14, 0, 0);
  set(r.foreR, 0.14, 0, 0);
}

/** Walk↔run cycle; `t` is the stride phase, `run` blends 0..1 into a sprint.
 *  Athletic forward lean (neg X — torso tips toward face/-Z). Old pose leaned
 *  *back* into the sprint which read as flailing; this tips into the run like
 *  a Nike spot — hips drive, chest over the lead foot, high knees, tight arms. */
export function poseWalk(r: Rig, t: number, run: number) {
  const swing = 0.52 + run * 0.55; // longer stride at sprint, capped short of flail
  const sL = Math.sin(t);
  const sR = Math.sin(t + Math.PI);
  // push-off bob: deeper at sprint so the silhouette loads then springs
  r.hips.position.y = -(0.02 + run * 0.045) * (0.5 - 0.5 * Math.cos(2 * t));
  // whole-hip tip into the run + a touch of counter-rotate with the stride
  const lean = -0.05 - run * 0.24; // walk slight forward → sprint athletic
  set(r.hips, lean * 0.4, sL * 0.04 * run, 0);
  set(r.torso, lean * 0.7, sL * (0.05 + run * 0.06), 0);
  // lift the head against the lean so eyes stay on the horizon
  set(r.head, -lean * 0.55 - run * 0.04, sL * 0.025, 0);
  set(r.legL, sL * swing, 0, 0.012 * run);
  set(r.legR, sR * swing, 0, -0.012 * run);
  // higher knee drive when sprinting
  set(r.shinL, -Math.max(0, Math.sin(t + Math.PI * 0.55)) * (0.5 + run * 0.75), 0, 0);
  set(r.shinR, -Math.max(0, Math.sin(t + Math.PI * 1.55)) * (0.5 + run * 0.75), 0, 0);
  // tight opposite arm pump, elbows tucked; ~90° forearms at full sprint
  const armSwing = swing * (0.65 + run * 0.28);
  set(r.armL, sR * armSwing, 0, 0.07 + run * 0.05);
  set(r.armR, sL * armSwing, 0, -(0.07 + run * 0.05));
  set(r.foreL, 0.4 + run * 0.5 + Math.max(0, sR) * 0.12, 0, 0);
  set(r.foreR, 0.4 + run * 0.5 + Math.max(0, sL) * 0.12, 0, 0);
}

/** Golf address/swing pose. `swing` runs -1 (full backswing), through 0
 *  (impact/address), to +1 (follow-through).
 *
 *  Address frame: the golfer FACES the ball (local -Z) and the target line
 *  runs to their lead side (local -X); the trail side is +X. The caller aligns
 *  the whole avatar to that frame (heading = aimYaw - π/2). Weight loads the
 *  trail foot going back and drives onto the lead foot through impact — the
 *  body moves, not just the arms. armL is the +X (trail) arm. */
export function poseGolf(r: Rig, swing: number) {
  const s = THREE.MathUtils.clamp(swing, -1, 1);
  const back = Math.max(0, -s); // 0..1 into the backswing
  const thru = Math.max(0, s); // 0..1 into the follow-through
  // keyframe helper: address → top-of-backswing (b) or finish (f)
  const L = (addr: number, b: number, f: number) =>
    s < 0 ? THREE.MathUtils.lerp(addr, b, back) : THREE.MathUtils.lerp(addr, f, thru);

  const shoulders = s * 1.05; // - = chest toward +X (trail), + = open to target
  const hipTurn = s * 0.42 + thru * 0.3;
  const hinge = golfHinge(); // DEV-tunable spine hinge (window.__golfTune.hinge)

  // weight shift: loads the trail foot going back, drives onto the lead foot at
  // the finish. The whole pelvis slides, not just the arms.
  r.hips.position.x = -s * 0.05 - thru * 0.08;
  r.hips.position.y = -0.1 - back * 0.02 + thru * 0.05;
  r.hips.position.z = 0.04 - thru * 0.05; // butt out over the ball, tall finish
  set(r.hips, 0, hipTurn, 0);
  // deep spine hinge from the hips so the chest points down at the ball; side-
  // bends with the turn, unwinds tall through impact into the finish
  set(r.torso, hinge - thru * 0.42, shoulders, s * 0.12);
  // eyes stay down on the ball until well after impact, then chase the shot
  set(r.head, -0.34 + thru * 0.2, -shoulders * 0.7 + thru * 0.5, -s * 0.05);

  // athletic stance: knees flexed, feet splayed; the trail knee kicks in and
  // the lead leg posts up straight as the hips clear to the finish
  set(r.legL, L(0.12, 0.06, -0.42), 0, 0.16 - thru * 0.22);
  set(r.legR, L(0.12, 0.16, 0.14), 0, -0.16 + back * 0.05);
  set(r.shinL, L(-0.34, -0.28, -0.72), 0, 0);
  set(r.shinR, L(-0.34, -0.4, -0.12), 0, 0);

  // Both hands grip together in front of the sternum. armL is the +X (trail)
  // arm, armR the -X (lead) arm; both swing down-and-in so the hands meet at
  // centre, then travel as one unit with the shoulder turn. At the top the
  // trail elbow folds high; through the finish the lead arm folds instead.
  set(r.armL, L(1.02, 0.62, 0.7), L(-0.34, -0.55, 0.05), L(-0.28, -0.05, -0.95));
  set(r.armR, L(1.02, 0.7, 0.62), L(0.34, 0.05, -0.55), L(0.28, 0.95, 0.05));
  set(r.foreL, L(0.32, 1.35, 0.15), 0, L(0, 0, 0.15));
  set(r.foreR, L(0.32, 0.15, 1.35), 0, L(0, 0.15, 0));

  // wrists carry the club (see GOLF_WRIST); the trail hand mirrors so both
  // mitts read as stacked on the same grip
  const w = GOLF_WRIST;
  const t = import.meta.env.DEV ? ((globalThis as unknown as { __golfTune?: GolfWristTune }).__golfTune ?? undefined) : undefined;
  const wx = L(t?.wax ?? w.ax, t?.wbx ?? w.bx, t?.wfx ?? w.fx);
  const wy = L(t?.way ?? w.ay, t?.wby ?? w.by, t?.wfy ?? w.fy);
  const wz = L(t?.waz ?? w.az, t?.wbz ?? w.bz, t?.wfz ?? w.fz);
  set(r.handR, wx, wy, wz);
  set(r.handL, wx, -wy, -wz);
}

/** Airborne (jump/fall): asymmetric tuck with arms flung out. */
export function poseAir(r: Rig) {
  r.hips.position.y = 0;
  set(r.hips, 0, 0, 0);
  set(r.torso, 0.16, 0, 0);
  set(r.head, -0.1, 0, 0);
  set(r.legL, 0.9, 0, 0);
  set(r.legR, 0.45, 0, 0);
  set(r.shinL, -1.2, 0, 0);
  set(r.shinR, -0.7, 0, 0);
  set(r.armL, -0.25, 0, 0.95);
  set(r.armR, -0.25, 0, -0.95);
  set(r.foreL, 0.35, 0, 0);
  set(r.foreR, 0.35, 0, 0);
}

/** Front crawl: body flat, windmilling arms, flutter kick. */
export function poseSwim(r: Rig, t: number) {
  r.hips.position.y = 0;
  // lay the whole body prone at the hips (negative x pitches the torso toward
  // the face side, -Z); rolling the hips with the stroke sells the reach
  set(r.hips, -1.35, 0, Math.sin(t) * 0.1);
  set(r.torso, 0.12, 0, 0);
  set(r.head, 0.8, 0, 0); // lift the face out of the water
  // negative sweep = pull through the water head→feet, recover through the air
  set(r.armL, -t % (Math.PI * 2), 0, 0.15);
  set(r.armR, -(t + Math.PI) % (Math.PI * 2), 0, -0.15);
  set(r.foreL, 0.25, 0, 0);
  set(r.foreR, 0.25, 0, 0);
  // legs trail the body line (hips already prone); flutter kick around it
  set(r.legL, 0.1 + Math.sin(t * 3) * 0.35, 0, 0);
  set(r.legR, 0.1 - Math.sin(t * 3) * 0.35, 0, 0);
  set(r.shinL, -0.3, 0, 0);
  set(r.shinR, -0.3, 0, 0);
}

/**
 * Hoverboard surf stance. The caller pre-yaws the rig group across the deck
 * (~1.05 rad) — legL is the lead leg. `lean` is the board's carve roll (+ =
 * leaning left), `crouch` 0..1 sinks the hips with speed and hard carves.
 */
export function poseRide(r: Rig, lean: number, crouch: number, air: boolean, t: number) {
  if (air) {
    // grab the board: full tuck, arms high
    r.hips.position.y = -0.3;
    set(r.hips, 0, 0, 0);
    set(r.torso, 0.3, -0.45, lean * 0.3);
    set(r.head, -0.2, -0.6, 0);
    set(r.legL, 1.05, 0, 0);
    set(r.legR, -0.2, 0, 0);
    set(r.shinL, -1.5, 0, 0);
    set(r.shinR, -1.25, 0, 0);
    set(r.armL, -0.3, 0, 1.25);
    set(r.armR, -0.3, 0, -1.25);
    set(r.foreL, 0.3, 0, 0);
    set(r.foreR, 0.3, 0, 0);
    return;
  }
  const bob = Math.sin(t * 2.6) * 0.012;
  r.hips.position.y = -(0.06 + crouch * 0.16) + bob;
  set(r.hips, 0, 0, 0);
  set(r.torso, 0.14 + crouch * 0.2, -0.45, lean * 0.5);
  set(r.head, -0.08, -0.6, lean * 0.25); // face the direction of travel
  set(r.legL, 0.5 + crouch * 0.3, 0, 0);
  set(r.legR, -0.35 - crouch * 0.15, 0, 0);
  set(r.shinL, -(0.55 + crouch * 0.6), 0, 0);
  set(r.shinR, -(0.45 + crouch * 0.55), 0, 0);
  // arms out like a wing that tips with the carve
  set(r.armL, Math.sin(t * 1.3) * 0.05, 0, 0.85 + lean * 0.45);
  set(r.armR, -Math.sin(t * 1.3) * 0.05, 0, -0.85 + lean * 0.45);
  set(r.foreL, 0.22, 0, 0);
  set(r.foreR, 0.22, 0, 0);
}

/**
 * Surf stance with both soles planted on the surfboard deck.
 *
 * The regular hoverboard pose deliberately bobs and tucks its feet. A surfboard
 * must instead remain attached to the rider through hard carves and aerials:
 * equal-and-opposite hip/knee rotations keep each shoe flat, while the hips
 * compensate for the shortened bent-leg height. With the surf rig root at
 * 0.93 m, this places both sole bottoms at board-local y=0.108 m — 3 mm above
 * the flat deck shell — for every crouch value from 0 through 1.
 */
export function poseSurfRide(
  r: Rig,
  lean: number,
  crouch: number,
  air: boolean,
  t: number,
  landingCompression = 0
) {
  const landingLoad = THREE.MathUtils.clamp(landingCompression, 0, 1);
  const bend =
    0.55 +
    THREE.MathUtils.clamp(crouch, 0, 1) * 0.25 +
    landingLoad * 0.42;

  // Root 0.93 - hip pivot 0.08 - thigh 0.40*cos(bend) - sole 0.425
  // must equal the 0.105 m deck top plus a visible 0.003 m safety gap.
  r.hips.position.y = -0.317 + 0.4 * Math.cos(bend);
  set(r.hips, 0, 0, 0);
  set(r.legL, bend, 0, 0);
  set(r.shinL, -bend, 0, 0);
  set(r.legR, -bend, 0, 0);
  set(r.shinR, bend, 0, 0);

  if (air) {
    // Keep the feet attached to the deck while the upper body sells the spin.
    set(r.torso, 0.3, -0.45, lean * 0.2);
    set(r.head, -0.2, -0.6, 0);
    set(r.armL, -0.3, 0, 1.25);
    set(r.armR, -0.3, 0, -1.25);
    set(r.foreL, 0.3, 0, 0);
    set(r.foreR, 0.3, 0, 0);
    return;
  }

  // The board itself already banks into the live face. Keep the planted rider
  // athletic but readable instead of stacking a second extreme layback.
  set(r.torso, 0.14 + crouch * 0.2 + landingLoad * 0.2, -0.45, lean * 0.28);
  set(r.head, -0.08, -0.6, lean * 0.12);
  set(r.armL, Math.sin(t * 1.3) * 0.05, 0, 0.85 + lean * 0.45);
  set(r.armR, -Math.sin(t * 1.3) * 0.05, 0, -0.85 + lean * 0.45);
  set(r.foreL, 0.22, 0, 0);
  set(r.foreR, 0.22, 0, 0);
}

/**
 * Seated at the wheel, legs stretched into the footwell. `steer` is the
 * smoothed steer input (+ = turning left): hands follow the rim, head checks
 * into the turn, torso tips a touch.
 */
export function poseDrive(r: Rig, steer: number, t: number, hasWheel: boolean) {
  const breathe = Math.sin(t * 1.4) * 0.012;
  r.hips.position.y = 0;
  set(r.hips, 0, 0, 0);
  set(r.torso, 0.02 + breathe, steer * 0.06, -steer * 0.05);
  set(r.head, 0.0, steer * 0.38, 0);
  set(r.legL, 1.25, 0, 0.06);
  set(r.legR, 1.25, 0, -0.06);
  set(r.shinL, -0.5, 0, 0);
  set(r.shinR, -0.5, 0, 0);
  if (hasWheel) {
    // hands at ten-and-two; steering drops one hand and raises the other
    set(r.armL, 1.05 + steer * 0.22, -0.15, 0.1);
    set(r.armR, 1.05 - steer * 0.22, 0.15, -0.1);
    set(r.foreL, 0.28 - steer * 0.12, 0, 0);
    set(r.foreR, 0.28 + steer * 0.12, 0, 0);
  } else {
    set(r.armL, 0.5, 0, 0.12);
    set(r.armR, 0.5, 0, -0.12);
    set(r.foreL, 0.5, 0, 0);
    set(r.foreR, 0.5, 0, 0);
  }
}

/** Upright scooter stance: hands wide on the bar, knees tucked around the
 * step-through shield, and the rider leaning naturally into steering. */
export function poseScooter(r: Rig, steer: number, t: number, airborne: boolean) {
  const bounce = airborne ? -0.08 : Math.sin(t * 5.2) * 0.008;
  r.hips.position.y = bounce;
  set(r.hips, airborne ? 0.12 : 0, 0, -steer * 0.05);
  set(r.torso, 0.08 + (airborne ? 0.12 : 0), steer * 0.08, -steer * 0.2);
  set(r.head, airborne ? -0.1 : 0, steer * 0.3, steer * 0.08);
  set(r.legL, 1.08 + (airborne ? 0.16 : 0), 0, 0.12);
  set(r.legR, 1.08 + (airborne ? 0.08 : 0), 0, -0.12);
  set(r.shinL, -0.82, 0, 0);
  set(r.shinR, -0.82, 0, 0);
  set(r.armL, 1.0 + steer * 0.13, -0.2, 0.28);
  set(r.armR, 1.0 - steer * 0.13, 0.2, -0.28);
  set(r.foreL, 0.38 - steer * 0.08, 0, 0.08);
  set(r.foreR, 0.38 + steer * 0.08, 0, -0.08);
  setHandPose(r, "L", 0.8);
  setHandPose(r, "R", 0.8);
}
