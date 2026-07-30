import * as THREE from "three/webgpu";
import { attribute, int, uniformArray } from "three/tsl";
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

/**
 * Classic rig: ~73 individual box meshes with ~12 tintable MeshLambert slots.
 * Kept verbatim for NPC customizers that do per-part surgery the merged rig
 * can't express — reassigning a named block's `.material` (bathingCostume),
 * swapping `headBlock.geometry`, hunting meshes by material identity, or hiding
 * the shades by opacity (buskers, tea master, pianist). Those callers pass
 * `{ merged: false }`; everyone else gets the single-SkinnedMesh build.
 */
function buildRigClassic(avatar: AvatarTraits = DEFAULT_RIG_AVATAR): Rig {
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

/* ------------------------------------------------ merged skinned rig */

// One SkinnedMesh per character instead of ~73 box meshes. Every classic part
// becomes a rigidly-skinned box (100% weight to one bone); every joint/part is
// a THREE.Bone mirroring the classic Group hierarchy 1:1 (same names, same
// neutral transforms), so the pose/IK/attachment code that only mutates those
// named objects keeps working untouched. Per-part tint is a per-vertex palette
// index into a per-rig uniform colour array — one shared MeshLambert node
// material definition (no pipeline permutations, no light-count change), just
// different uniform values per rig. Variant parts (hair/hat/outfit sets) hide
// by collapsing their bone to ZERO_SCALE (the tree-forest trick), so the bind
// geometry never depends on avatar traits and is baked once and shared.

const SLOT_NAMES = [
  "jacket", "sleeve", "shirt", "pants", "shoe", "sole",
  "skin", "hat", "visor", "pack", "hair", "trim"
] as const;
type SlotName = (typeof SLOT_NAMES)[number];
const SLOT = Object.fromEntries(SLOT_NAMES.map((n, i) => [n, i])) as Record<SlotName, number>;

const RIG_ZERO_SCALE = 1e-6; // collapse a bone to hide its box (tree-forest trick)

// TSL node type escape hatch (same convention as src/fx/* and the shadow nodes).
type N = any;

// The bind geometry is avatar-independent (variants, tints and silhouette are
// all runtime bone-scale + palette uniforms), so it is baked once against the
// neutral skeleton and shared by every rig; each rig owns only its skeleton,
// node material and palette. Its dispose() is a no-op — this is app-lifetime
// shared state (like the boxGeo cache) that blanket teardown traversals must
// never free out from under other live rigs.
let MERGED_RIG_GEO: THREE.BufferGeometry | null = null;

/** Toggle a part bone's visibility by collapsing/restoring its scale — keeps the
 *  classic `item.visible = false` API working on a SkinnedMesh, where a bone's
 *  own `.visible` flag cannot hide its skinned vertices. Only applied to variant
 *  parts (never the silhouette-scaled base blocks). */
function makeToggleable(bone: THREE.Object3D): void {
  let shown = true;
  Object.defineProperty(bone, "visible", {
    configurable: true,
    enumerable: true,
    get() {
      return shown;
    },
    set(value: boolean) {
      shown = value;
      bone.scale.setScalar(value ? 1 : RIG_ZERO_SCALE);
    }
  });
}

/** One shared MeshLambert node material definition; the per-rig palette lives in
 *  a uniform colour array indexed by a per-vertex slot attribute. Two rigs'
 *  materials are structurally identical → one compiled pipeline, different
 *  uniform values. Lambert lighting is unchanged from the classic per-part
 *  MeshLambertMaterial; only the diffuse colour is sourced from the palette. */
function makeRigPaletteMaterial(paletteColors: THREE.Color[]): THREE.MeshLambertNodeMaterial {
  const material = new THREE.MeshLambertNodeMaterial();
  const palette = uniformArray(paletteColors);
  // +0.5 then truncate: the attribute is constant across each face (all a box's
  // verts carry one slot), so this rounds it back to the exact integer index.
  const slotIndex = int((attribute("paletteIndex", "float") as N).add(0.5));
  material.colorNode = palette.element(slotIndex) as N;
  return material;
}

function makeMergedMaterials(paletteColors: THREE.Color[], disposeMaterial: () => void): AvatarMaterials {
  const slot = (name: SlotName) => ({ color: paletteColors[SLOT[name]], dispose: disposeMaterial });
  // Structural shim: applyAvatarToRig and NPC recolours only touch `.color`
  // (writes flow straight into the palette uniform array), and dispose routes to
  // the one node material. Cast because it is not a real MeshLambertMaterial.
  return {
    jacket: slot("jacket"), sleeve: slot("sleeve"), shirt: slot("shirt"), pants: slot("pants"),
    shoe: slot("shoe"), sole: slot("sole"), skin: slot("skin"), hat: slot("hat"),
    visor: slot("visor"), pack: slot("pack"), hair: slot("hair"), trim: slot("trim")
  } as unknown as AvatarMaterials;
}

type MergedPartBox = { bone: THREE.Bone; index: number; w: number; h: number; d: number; slot: number };

/** Bake every part box into one buffer geometry in bind (neutral) space, each
 *  vertex rigidly weighted (weight 1) to its part bone. Called once; the result
 *  is shared by every rig (the bind pose is avatar-independent). */
function bakeMergedGeometry(partBoxes: MergedPartBox[]): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const paletteIndex: number[] = [];
  const indices: number[] = [];
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const part of partBoxes) {
    const src = boxGeo(part.w, part.h, part.d);
    const srcPos = src.attributes.position;
    const srcNor = src.attributes.normal;
    const srcIdx = src.index;
    const world = part.bone.matrixWorld;
    nm.getNormalMatrix(world);
    const base = position.length / 3;
    for (let i = 0; i < srcPos.count; i++) {
      v.fromBufferAttribute(srcPos, i).applyMatrix4(world);
      n.fromBufferAttribute(srcNor, i).applyMatrix3(nm).normalize();
      position.push(v.x, v.y, v.z);
      normal.push(n.x, n.y, n.z);
      skinIndex.push(part.index, 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
      paletteIndex.push(part.slot);
    }
    if (srcIdx) {
      for (let i = 0; i < srcIdx.count; i++) indices.push(base + srcIdx.getX(i));
    } else {
      for (let i = 0; i < srcPos.count; i++) indices.push(base + i);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setAttribute("paletteIndex", new THREE.Float32BufferAttribute(paletteIndex, 1));
  geometry.setIndex(indices);
  // Generous static bounds so a consumer that re-enables frustum culling (e.g.
  // coronaHeights.tunePropRendering) can never wrongly cull an animated pose.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -0.1, 0), 3);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1.6, -2.2, -1.6), new THREE.Vector3(1.6, 2.2, 1.6));
  // App-lifetime shared: neutralise dispose so a rig-teardown traversal can't
  // free the geometry every other live rig still renders from.
  geometry.dispose = () => {};
  return geometry;
}

function buildRigMerged(avatar: AvatarTraits): Rig {
  const group = new THREE.Group();

  // per-rig palette: applyAvatarToRig overwrites the tinted slots; the fixed
  // slots (shoe/sole/visor) carry the same constants the classic mats used.
  const paletteColors = SLOT_NAMES.map(() => new THREE.Color(0xffffff));
  paletteColors[SLOT.shoe].set(0xe8e4da);
  paletteColors[SLOT.sole].set(0x1b1d22);
  paletteColors[SLOT.visor].set(0x14181e);
  const material = makeRigPaletteMaterial(paletteColors);
  let materialDisposed = false;
  const disposeMaterial = () => {
    if (materialDisposed) return;
    materialDisposed = true;
    material.dispose();
  };
  const materials = makeMergedMaterials(paletteColors, disposeMaterial);

  const bones: THREE.Bone[] = [];
  const partBoxes: MergedPartBox[] = [];

  const joint = (parent: THREE.Object3D, name: string, x = 0, y = 0, z = 0): THREE.Bone => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    bones.push(b);
    return b;
  };
  // A visual box: its own bone at the box centre (so it scales/hides/moves
  // exactly like the classic mesh) with the box baked in, weighted 100% to it.
  const box = (
    parent: THREE.Object3D, mat: SlotName, w: number, h: number, d: number,
    x: number, y: number, z: number
  ): THREE.Bone => {
    const b = new THREE.Bone();
    b.position.set(x, y, z);
    parent.add(b);
    partBoxes.push({ bone: b, index: bones.length, w, h, d, slot: SLOT[mat] });
    bones.push(b);
    return b;
  };

  // buckets (mirror buildRigClassic exactly)
  const hair: RigAvatarState["hair"] = { short: [], bob: [], mohawk: [], buzz: [], long: [] };
  const hairCrowns: THREE.Object3D[] = [];
  const hats: RigAvatarState["hats"] = { none: [], cap: [], beanie: [], visor: [], crown: [] };
  const outfits: RigAvatarState["outfits"] = { jacket: [], hoodie: [], tee: [], overalls: [], dress: [] };
  const allHair: THREE.Object3D[] = [];
  const allHats: THREE.Object3D[] = [];
  const allOutfits: THREE.Object3D[] = [];
  const armBlocks: THREE.Bone[] = [];
  const legBlocks: THREE.Bone[] = [];
  const crown = <T extends THREE.Object3D>(item: T): T => {
    hairCrowns.push(item);
    return item;
  };

  const hips = joint(group, "hips"); // re-parented under the mesh below
  const hipBlock = box(hips, "pants", 0.36, 0.22, 0.24, 0, 0.01, 0);

  const torso = joint(hips, "torso", 0, 0.12, 0);
  const torsoBlock = box(torso, "jacket", 0.44, 0.42, 0.26, 0, 0.22, 0);
  push(outfits.jacket, box(torso, "shirt", 0.1, 0.38, 0.03, 0, 0.22, -0.135));
  push(outfits.jacket, box(torso, "pack", 0.34, 0.34, 0.14, 0, 0.2, 0.2));
  push(outfits.jacket, box(torso, "sole", 0.06, 0.3, 0.02, -0.12, 0.24, -0.14));
  push(outfits.jacket, box(torso, "sole", 0.06, 0.3, 0.02, 0.12, 0.24, -0.14));
  push(outfits.hoodie, box(torso, "trim", 0.25, 0.13, 0.08, 0, 0.42, 0.12));
  push(outfits.hoodie, box(torso, "shirt", 0.24, 0.08, 0.035, 0, 0.11, -0.15));
  push(outfits.hoodie, box(torso, "shirt", 0.16, 0.04, 0.03, 0, 0.31, -0.15));
  push(outfits.tee, box(torso, "trim", 0.18, 0.16, 0.035, 0, 0.25, -0.15));
  push(outfits.tee, box(torso, "jacket", 0.14, 0.12, 0.15, -0.29, 0.33, 0));
  push(outfits.tee, box(torso, "jacket", 0.14, 0.12, 0.15, 0.29, 0.33, 0));
  push(outfits.overalls, box(torso, "pants", 0.08, 0.36, 0.035, -0.1, 0.22, -0.15));
  push(outfits.overalls, box(torso, "pants", 0.08, 0.36, 0.035, 0.1, 0.22, -0.15));
  push(outfits.overalls, box(torso, "trim", 0.27, 0.1, 0.04, 0, 0.12, -0.155));
  push(outfits.dress, box(torso, "shirt", 0.16, 0.2, 0.035, 0, 0.29, -0.15));
  push(outfits.dress, box(torso, "trim", 0.38, 0.05, 0.29, 0, 0.02, 0));
  push(outfits.dress, box(hips, "jacket", 0.52, 0.38, 0.3, 0, -0.17, 0));
  push(outfits.dress, box(hips, "trim", 0.54, 0.055, 0.31, 0, -0.34, -0.01));
  allOutfits.push(...outfits.jacket, ...outfits.hoodie, ...outfits.tee, ...outfits.overalls, ...outfits.dress);

  const head = joint(torso, "head", 0, 0.46, 0);
  box(head, "skin", 0.12, 0.1, 0.12, 0, 0.04, 0); // neck
  const headBlock = box(head, "skin", 0.26, 0.26, 0.26, 0, 0.2, 0);
  box(head, "visor", 0.24, 0.07, 0.03, 0, 0.23, -0.145); // shades
  box(head, "skin", 0.05, 0.06, 0.05, 0, 0.15, -0.15); // nose
  push(hair.short, crown(box(head, "hair", 0.29, 0.05, 0.28, 0, 0.365, 0)));
  push(hair.buzz, crown(box(head, "hair", 0.28, 0.024, 0.28, 0, 0.342, 0)));
  push(hair.bob, crown(box(head, "hair", 0.3, 0.05, 0.28, 0, 0.365, 0)));
  push(hair.bob, box(head, "hair", 0.07, 0.22, 0.12, -0.17, 0.21, 0.03));
  push(hair.bob, box(head, "hair", 0.07, 0.22, 0.12, 0.17, 0.21, 0.03));
  push(hair.long, crown(box(head, "hair", 0.3, 0.05, 0.28, 0, 0.365, 0)));
  push(hair.long, box(head, "hair", 0.24, 0.28, 0.08, 0, 0.16, 0.16));
  push(hair.long, box(head, "hair", 0.055, 0.24, 0.08, -0.17, 0.18, 0.08));
  push(hair.long, box(head, "hair", 0.055, 0.24, 0.08, 0.17, 0.18, 0.08));
  push(hair.mohawk, crown(box(head, "hair", 0.09, 0.18, 0.32, 0, 0.39, 0)));
  allHair.push(...hair.short, ...hair.bob, ...hair.mohawk, ...hair.buzz, ...hair.long);
  push(hats.cap, box(head, "hat", 0.28, 0.1, 0.28, 0, 0.355, 0));
  push(hats.cap, box(head, "hat", 0.26, 0.03, 0.16, 0, 0.32, -0.2)); // brim
  push(hats.beanie, box(head, "hat", 0.29, 0.12, 0.29, 0, 0.365, 0));
  push(hats.beanie, box(head, "trim", 0.31, 0.04, 0.3, 0, 0.305, 0));
  push(hats.visor, box(head, "hat", 0.3, 0.045, 0.29, 0, 0.318, 0));
  push(hats.visor, box(head, "hat", 0.28, 0.03, 0.18, 0, 0.305, -0.2));
  push(hats.crown, box(head, "hat", 0.3, 0.045, 0.3, 0, 0.42, 0));
  for (const x of [-0.11, 0, 0.11]) push(hats.crown, box(head, "trim", 0.055, 0.13, 0.055, x, 0.48, -0.08));
  allHats.push(...hats.cap, ...hats.beanie, ...hats.visor, ...hats.crown);

  const arm = (side: 1 | -1) => {
    const shoulder = joint(torso, side === 1 ? "shoulder-L" : "shoulder-R", side * 0.28, 0.38, 0);
    armBlocks.push(box(shoulder, "sleeve", 0.12, 0.3, 0.14, 0, -0.13, 0));
    const fore = joint(shoulder, side === 1 ? "fore-L" : "fore-R", 0, -0.3, 0);
    armBlocks.push(box(fore, "sleeve", 0.1, 0.16, 0.12, 0, -0.07, 0));
    box(fore, "skin", 0.09, 0.12, 0.1, 0, -0.2, 0); // wrist
    const hand = joint(fore, side === 1 ? "hand-L" : "hand-R", 0, -0.3, -0.01);
    box(hand, "skin", 0.09, 0.1, 0.11, 0, 0, 0); // palm
    const fingers = joint(hand, side === 1 ? "fingers-L" : "fingers-R", -side * 0.016, -0.038, -0.05);
    box(fingers, "skin", 0.056, 0.028, 0.06, 0, -0.006, -0.022);
    const fingersTip = joint(fingers, side === 1 ? "fingersTip-L" : "fingersTip-R", 0, -0.006, -0.05);
    box(fingersTip, "skin", 0.052, 0.026, 0.048, 0, 0, -0.018);
    const index = joint(hand, side === 1 ? "index-L" : "index-R", side * 0.028, -0.038, -0.05);
    box(index, "skin", 0.026, 0.028, 0.062, 0, -0.006, -0.023);
    const indexTip = joint(index, side === 1 ? "indexTip-L" : "indexTip-R", 0, -0.006, -0.052);
    box(indexTip, "skin", 0.024, 0.026, 0.05, 0, 0, -0.019);
    const thumb = joint(hand, side === 1 ? "thumb-L" : "thumb-R", side * 0.045, -0.025, -0.04);
    box(thumb, "skin", 0.028, 0.032, 0.055, side * 0.004, -0.004, -0.02);
    return { shoulder, fore, hand, fingers, fingersTip, index, indexTip, thumb };
  };
  const aL = arm(1);
  const aR = arm(-1);

  const leg = (side: 1 | -1) => {
    const hip = joint(hips, side === 1 ? "leg-L" : "leg-R", side * 0.13, -0.08, 0);
    legBlocks.push(box(hip, "pants", 0.16, 0.36, 0.18, 0, -0.19, 0));
    const shin = joint(hip, side === 1 ? "shin-L" : "shin-R", 0, -0.4, 0);
    legBlocks.push(box(shin, "pants", 0.14, 0.3, 0.15, 0, -0.15, 0));
    box(shin, "shoe", 0.15, 0.09, 0.3, 0, -0.35, -0.06); // toe
    box(shin, "sole", 0.16, 0.03, 0.31, 0, -0.41, -0.06); // baked visible sole
    // Invisible measurement proxy at the same spot (surf sole-to-deck clearance
    // reads sole.geometry.boundingBox + matrixWorld). Own geometry AND material
    // so a teardown traversal that disposes them can't touch shared state — the
    // proxy never renders, so two extra state-free materials per rig are free.
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.31), new THREE.MeshBasicMaterial());
    sole.position.set(0, -0.41, -0.06);
    sole.visible = false;
    sole.name = side === 1 ? "sole-L" : "sole-R";
    shin.add(sole);
    return { hip, shin, sole };
  };
  const lL = leg(1);
  const lR = leg(-1);

  // Hide-by-collapse for every variant part (base blocks stay untouched so
  // applyAvatarToRig's silhouette scaling keeps working on them).
  for (const item of allHair) makeToggleable(item);
  for (const item of allHats) makeToggleable(item);
  for (const item of allOutfits) makeToggleable(item);

  // bake / reuse the shared bind geometry (see MERGED_RIG_GEO)
  hips.updateMatrixWorld(true);
  const geometry = MERGED_RIG_GEO ?? bakeMergedGeometry(partBoxes);
  MERGED_RIG_GEO = geometry;

  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = "rig-skin";
  mesh.add(hips); // root bone under the mesh
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones)); // no parent yet → bindMatrix = identity
  // Cull against an explicit generous sphere, never the pose. Frustum.intersectsObject
  // prefers `object.boundingSphere` when the property exists, and SkinnedMesh declares
  // it (null), so leaving it null would make three compute a one-shot sphere frozen at
  // whatever pose was current on the first test — the exact failure this rig has to
  // avoid. Seeding it with the bind geometry's own generous bounds keeps every animated
  // pose inside, and lets a rig hundreds of metres away stop submitting a draw to the
  // hero shadow pass.
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -0.1, 0), 3);
  mesh.frustumCulled = true;
  mesh.castShadow = true;
  enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);
  mesh.receiveShadow = true;
  group.add(mesh);

  const asGroup = (b: THREE.Bone) => b as unknown as THREE.Group;
  const asMesh = (b: THREE.Bone) => b as unknown as THREE.Mesh;
  const rig: Rig = {
    group,
    hips: asGroup(hips),
    torso: asGroup(torso),
    head: asGroup(head),
    armL: asGroup(aL.shoulder),
    armR: asGroup(aR.shoulder),
    foreL: asGroup(aL.fore),
    foreR: asGroup(aR.fore),
    handL: asGroup(aL.hand),
    handR: asGroup(aR.hand),
    fingersL: asGroup(aL.fingers),
    fingersR: asGroup(aR.fingers),
    fingersTipL: asGroup(aL.fingersTip),
    fingersTipR: asGroup(aR.fingersTip),
    indexL: asGroup(aL.index),
    indexR: asGroup(aR.index),
    indexTipL: asGroup(aL.indexTip),
    indexTipR: asGroup(aR.indexTip),
    thumbL: asGroup(aL.thumb),
    thumbR: asGroup(aR.thumb),
    legL: asGroup(lL.hip),
    legR: asGroup(lR.hip),
    shinL: asGroup(lL.shin),
    shinR: asGroup(lR.shin),
    soleL: lL.sole,
    soleR: lR.sole,
    avatar: {
      materials,
      torsoBlock: asMesh(torsoBlock),
      hipBlock: asMesh(hipBlock),
      headBlock: asMesh(headBlock),
      armBlocks: armBlocks.map(asMesh),
      legBlocks: legBlocks.map(asMesh),
      hair,
      hairCrowns,
      hats,
      outfits,
      allHair,
      allHats,
      allOutfits
    }
  };
  // The base blocks are Bones cast to Mesh: `.scale` is real (silhouette work),
  // but `.visible`, `.material` and `.geometry` are properties a SkinnedMesh
  // never reads, so writing them is a silent no-op instead of an error. Make
  // that loud in dev rather than leaving the contract to call-site comments.
  warnOnMergedBlockSurgery([
    rig.avatar.torsoBlock, rig.avatar.hipBlock, rig.avatar.headBlock,
    ...rig.avatar.armBlocks, ...rig.avatar.legBlocks
  ]);
  applyAvatarToRig(rig, avatar);
  return rig;
}

/** DEV-only tripwire: keeps the (no-op) assignment behaviour, but reports the
 *  first per-part write to a merged rig's base block and names the way out. */
function warnOnMergedBlockSurgery(blocks: THREE.Mesh[]): void {
  if (!import.meta.env.DEV) return;
  for (const block of blocks) {
    for (const key of ["visible", "material", "geometry"] as const) {
      let value: unknown = (block as unknown as Record<string, unknown>)[key];
      let warned = false;
      Object.defineProperty(block, key, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (next: unknown) => {
          value = next;
          if (warned) return;
          warned = true;
          console.error(
            `[rig] .${key} on a merged rig's base block does nothing — the block is a Bone of one SkinnedMesh. ` +
              "Pass { merged: false } to buildRig for per-part surgery."
          );
        }
      });
    }
  }
}

export type BuildRigOptions = {
  /** `false` → the classic ~73-mesh rig (per-part material/geometry surgery).
   *  Defaults to the single-SkinnedMesh build. */
  merged?: boolean;
};

/** Build a character rig. Defaults to one SkinnedMesh (~1 draw); NPC customizers
 *  that reassign per-part materials or swap part geometry pass `{ merged: false }`
 *  for the classic per-mesh rig. Both return the same {@link Rig} API.
 *
 *  Merged-rig contract: `rig.avatar` parts are Bones, not meshes. Variant parts
 *  (hair/hats/outfits) keep working through `.visible` because they hide by
 *  collapsing their bone scale, but on the BASE blocks (torso/hip/head/arm/leg)
 *  only `.scale` and `.position` are real — `.visible`, `.material` and
 *  `.geometry` are silently ignored. Need any of those? Pass `{ merged: false }`. */
export function buildRig(avatar: AvatarTraits = DEFAULT_RIG_AVATAR, opts: BuildRigOptions = {}): Rig {
  return opts.merged === false ? buildRigClassic(avatar) : buildRigMerged(avatar);
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

/**
 * Swimming. `drive` 0..1 blends TREADING WATER (0) into a full front crawl (1),
 * so a swimmer who is holding station stops windmilling at racing cadence — the
 * single thing that most gave away the old pose, because the stroke ran at a
 * fixed rate whether or not the body was going anywhere.
 *
 * The crawl itself now rolls, breathes and bends its elbows. Real front crawl
 * rolls the whole body ±30-40° about its long axis and the head turns with it
 * to breathe; a flat body with straight windmilling arms reads as a doll being
 * spun. The elbow bend is what separates the pull (bent, catching water) from
 * the recovery (straighter, swung over the surface).
 *
 * `drive` defaults to 1 so existing callers posing a full-speed swimmer
 * (world/sutroBaths/bathers.ts) are unchanged.
 */
export function poseSwim(r: Rig, t: number, drive = 1) {
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  const d = Math.min(1, Math.max(0, drive));
  const stroke = Math.sin(t);
  // Sink the body as the stroke picks up: a swimmer under way planes up toward
  // the surface, one holding station hangs lower with only the shoulders out.
  // This is a VISUAL offset on the rig, deliberately not a change to
  // SWIM_REST_DEPTH — the capsule and the first-person eye height stay exactly
  // where the walk controller put them.
  r.hips.position.y = -0.62 + d * 0.12;

  // Prone under way, closer to upright while treading.
  const pitch = -0.45 - d * 0.9;
  // Roll is the crawl's signature; treading barely rolls at all.
  const roll = stroke * (0.06 + d * 0.36);
  set(r.hips, pitch, 0, roll);
  set(r.torso, 0.12, 0, roll * -0.25);

  // Breathe to the side the roll is already taking the body, and lift the face
  // more when prone (where it would otherwise be in the water).
  set(r.head, 0.35 + d * 0.5, stroke * 0.55 * d, 0);

  // Arms. Under way: a continuous windmill, elbows bent through the pull and
  // opening out on the recovery. Treading: sculling out at the sides.
  const swingL = -t % (Math.PI * 2);
  const swingR = -(t + Math.PI) % (Math.PI * 2);
  // 1 while the hand is underneath pulling, 0 while it is over the top
  const pullL = Math.max(0, Math.sin(t));
  const pullR = Math.max(0, Math.sin(t + Math.PI));
  const scullL = 0.95 + Math.sin(t * 1.6) * 0.22;
  const scullR = 0.95 - Math.sin(t * 1.6) * 0.22;
  set(r.armL, swingL * d, 0, lerp(scullL, 0.15, d));
  set(r.armR, swingR * d, 0, lerp(-scullR, -0.15, d));
  set(r.foreL, lerp(0.75 + Math.sin(t * 1.6) * 0.25, 0.25 + pullL * 0.85, d), 0, 0);
  set(r.foreR, lerp(0.75 - Math.sin(t * 1.6) * 0.25, 0.25 + pullR * 0.85, d), 0, 0);

  // Legs: flutter kick under way, a slow wide eggbeater while treading.
  const flutter = Math.sin(t * 3) * 0.35;
  const tread = Math.sin(t * 1.3);
  set(r.legL, lerp(0.85 + tread * 0.3, 0.1 + flutter, d), 0, lerp(0.35, 0, d));
  set(r.legR, lerp(0.85 - tread * 0.3, 0.1 - flutter, d), 0, lerp(-0.35, 0, d));
  set(r.shinL, lerp(-1.15 - tread * 0.35, -0.3, d), 0, 0);
  set(r.shinR, lerp(-1.15 + tread * 0.35, -0.3, d), 0, 0);
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

/** Prone hang-glider harness pose. The rig root is rotated into the flight
 * line by Player; these joint angles keep both hands on the control bar while
 * the pilot shifts shoulders and hips into the bank. */
export function poseHangGlider(r: Rig, bank: number, pitch: number, t: number) {
  const breathe = Math.sin(t * 1.7) * 0.014;
  const weightShift = THREE.MathUtils.clamp(bank / 0.88, -1, 1);
  r.hips.position.set(weightShift * 0.12, breathe, 0);
  set(r.hips, -0.04 + pitch * 0.18, 0, -weightShift * 0.12);
  set(r.torso, 0.1 - pitch * 0.3, -weightShift * 0.1, -weightShift * 0.18);
  set(r.head, -0.36 - pitch * 0.24, weightShift * 0.22, weightShift * 0.08);
  // Legs trail together in the cocoon harness, with a slight crossed-ankle
  // asymmetry so the silhouette never reads as a rigid plank.
  set(r.legL, 0.08, 0.04, 0.04);
  set(r.legR, -0.02, -0.04, -0.04);
  set(r.shinL, -0.1, 0, 0);
  set(r.shinR, -0.16, 0, 0);
  // Weight shift: the outside arm reaches while the inside elbow softens.
  set(r.armL, 1.0 - weightShift * 0.16, -0.2, 0.12);
  set(r.armR, 1.0 + weightShift * 0.16, 0.2, -0.12);
  set(r.foreL, 0.42 + weightShift * 0.12, 0, 0.04);
  set(r.foreR, 0.42 - weightShift * 0.12, 0, -0.04);
  setHandPose(r, "L", 0.9);
  setHandPose(r, "R", 0.9);
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

/** What a skater's body is doing this frame (see vehicles/skate/controller). */
export type SkatePose = {
  /** Deck roll from carving / grind balance (+ = leaning left). */
  lean: number;
  /** Steering input −1..1, for shoulder and head lead. */
  carve: number;
  /** 0..1 ollie crouch and landing squash. */
  crouch: number;
  /** 1 → 0 over one push stroke; 0 means both feet are on the board. */
  push: number;
  air: boolean;
  grab: boolean;
  grind: boolean;
  manual: boolean;
  bail: boolean;
  /** Signed balance meter while grinding/manualing, ±1 = gone. */
  balance: number;
  /** Free-running clock for idle sway. */
  t: number;
};

/** Base hip/knee angle: sets how far apart the feet sit along the deck. */
const SKATE_STANCE = 0.78;
/** Toe-out for each shoe so it lies ACROSS the griptape, not along it. */
const SKATE_FOOT_YAW_FRONT = 1.02;
const SKATE_FOOT_YAW_BACK = 1.42;

/**
 * Street stance on a 1.3 m deck.
 *
 * Three things make this read as skating rather than as a person standing on a
 * plank:
 *
 * 1. **The feet lie ACROSS the deck.** The toe-out lives on the SHIN, not the
 *    thigh — a yaw applied at the knee turns the shoe without changing the
 *    sole's height (Ry leaves the shin's own −Y offset alone), so the
 *    equal-and-opposite thigh/shin pair still plants both soles exactly on the
 *    griptape at every crouch depth. Yawing the thigh instead would swing the
 *    feet sideways off the board, which is what made the old pose look like a
 *    man walking sideways down the street.
 * 2. **The shoulders are open, the head is not.** Hips and chest turn toward
 *    the toe side; the head counter-rotates back down the line of travel. That
 *    twist is the single most recognisable thing about a skateboarder's
 *    silhouette.
 * 3. **A push is a real stroke.** The back foot leaves the tail, reaches the
 *    ROAD (the standing knee folds to let it get there), drives back, and
 *    returns to the deck. It runs on a phase from the controller, so it only
 *    happens on the kick — no perpetual jogging in place.
 */
export function poseSkate(r: Rig, s: SkatePose) {
  const lean = THREE.MathUtils.clamp(s.lean, -1.2, 1.2);
  const carve = THREE.MathUtils.clamp(s.carve, -1, 1);
  const crouch = THREE.MathUtils.clamp(s.crouch, 0, 1);
  const push = THREE.MathUtils.clamp(s.push, 0, 1);

  if (s.bail) {
    // Arms up, legs everywhere. The board is off doing its own thing.
    const flail = Math.sin(s.t * 17);
    r.hips.position.y = -0.12;
    set(r.hips, 0.35, 0, flail * 0.3);
    set(r.torso, 0.5, flail * 0.35, -flail * 0.4);
    set(r.head, -0.45, flail * 0.4, 0);
    set(r.legL, 1.35 + flail * 0.3, 0, 0.35);
    set(r.legR, 0.7 - flail * 0.4, 0, -0.45);
    set(r.shinL, -0.7, 0, 0);
    set(r.shinR, -1.5, 0, 0);
    set(r.armL, -2.3 + flail * 0.4, 0, 0.9);
    set(r.armR, -2.2 - flail * 0.4, 0, -1.0);
    set(r.foreL, 0.5, 0, 0);
    set(r.foreR, 0.6, 0, 0);
    setHandPose(r, "L", 0.15);
    setHandPose(r, "R", 0.15);
    return;
  }

  // --- legs --------------------------------------------------------------
  // `bend` is one angle used by BOTH legs so the shared hip lift plants both
  // soles. Crouching deepens it (hips drop, stance widens a little), and a
  // push deepens the standing leg further so the other foot can reach tarmac.
  const bend =
    SKATE_STANCE +
    crouch * 0.34 +
    push * 0.26 +
    (s.grind ? 0.06 : 0) +
    (s.air && !s.grab ? 0.1 : 0);
  const sway = s.air || push > 0.02 ? 0 : Math.sin(s.t * 2.1) * 0.008;
  r.hips.position.y = -0.317 + 0.4 * Math.cos(bend) + sway;

  // Front (lead) leg: planted, toe angled toward the nose.
  let legL = bend;
  let shinL = -bend;
  // Back leg: planted on the tail unless it is out pushing.
  let legR = -bend;
  let shinR = bend;

  if (s.manual) {
    // Weight slammed onto the tail: back knee folds under, front leg reaches.
    legL = bend * 0.72;
    shinL = -bend * 0.5;
    legR = -bend * 1.22;
    shinR = bend * 1.22;
  }
  if (s.air && !s.grab) {
    // Suck the knees up so the deck has room to flip under the feet.
    legL = bend + 0.3;
    shinL = -bend - 0.55;
    legR = -bend * 0.45;
    shinR = bend * 0.45 - 0.6;
  }
  if (push > 0.02 && !s.air && !s.grind) {
    // One stroke, read backwards from `push` (1 at the kick, 0 back on board):
    //   1.00→0.72  step off the tail, knee straightens, foot finds the road
    //   0.72→0.30  drive: the hip sweeps back and the board shoots forward
    //   0.30→0     fold it back onto the tail
    const reach = THREE.MathUtils.smoothstep(push, 0.18, 0.78); // 0 on deck, 1 out
    const drive = 1 - Math.abs(push - 0.5) * 2; // peaks mid-stroke
    const sweep = THREE.MathUtils.smoothstep(0.78 - push, 0, 0.5); // 0 → 1 as it drives back
    const hip = THREE.MathUtils.lerp(-0.06, -0.52, sweep);
    legR = THREE.MathUtils.lerp(-bend, hip, reach);
    shinR = THREE.MathUtils.lerp(bend, -0.02, reach);
    // The standing knee dips through the drive so the push has some weight.
    legL = bend + drive * 0.12;
    shinL = -bend - drive * 0.12;
  }

  set(r.legL, legL, 0, 0.03);
  set(r.legR, legR, 0, -0.03);
  // Toe-out lives here, at the knee: yaw the shoe across the deck without
  // moving the sole up or down (see the function comment).
  const frontYaw = s.air ? SKATE_FOOT_YAW_FRONT * 0.7 : SKATE_FOOT_YAW_FRONT;
  const backYaw = push > 0.02 ? SKATE_FOOT_YAW_BACK * (1 - push * 0.8) : SKATE_FOOT_YAW_BACK;
  set(r.shinL, shinL, frontYaw, 0);
  set(r.shinR, shinR, backYaw, 0);

  // --- body twist --------------------------------------------------------
  // Hips and chest open toward the toe side; the head turns back down the
  // line. Carving leads with the shoulders, the way it does on a real board.
  const openHips = 0.42 + carve * 0.12;
  const openTorso = 0.5 - carve * 0.18;
  const fold = s.air ? 0.34 : 0.1 + crouch * 0.42 + push * 0.2 + (s.manual ? -0.18 : 0);
  set(r.hips, 0, openHips, lean * 0.12);
  set(r.torso, fold, openTorso, lean * 0.4 - carve * 0.1);
  // Head world-yaw ≈ 0 (straight down the board) minus a glance into the turn.
  set(r.head, s.air ? -0.24 : -0.06 - crouch * 0.12, -(openHips + openTorso) + carve * 0.3, lean * 0.15);

  if (s.grab) {
    // Back hand on the toe edge, front arm counterweighting overhead.
    set(r.armL, -1.5, 0.3, 0.6);
    set(r.foreL, 0.4, 0, 0);
    set(r.armR, 1.5, -0.35, -0.5);
    set(r.foreR, 0.95, 0, 0);
    setHandPose(r, "L", 0.25);
    setHandPose(r, "R", 0.95);
    return;
  }

  // --- arms ---------------------------------------------------------------
  // The arms are the balance pole: out and low while rolling, wide on a rail,
  // and thrown out sideways as the balance meter runs away. The lead arm
  // reaches into the turn.
  const wide = s.grind || s.manual ? 1.3 : s.air ? 1.1 : 0.72 + crouch * 0.22 + push * 0.3;
  const correct = (s.grind || s.manual ? -s.balance : 0) * 0.6;
  const swingL = -carve * 0.35 - (s.air ? 0.5 : 0) + Math.sin(s.t * 1.5) * 0.04;
  const swingR = carve * 0.3 - (s.air ? 0.2 : 0) - Math.sin(s.t * 1.5) * 0.04;
  set(r.armL, swingL - correct * 0.4, 0, wide + lean * 0.45 + correct);
  set(r.armR, swingR + correct * 0.4, 0, -wide + lean * 0.45 + correct);
  set(r.foreL, 0.3 + crouch * 0.35 + (s.air ? 0.45 : 0), 0, 0);
  set(r.foreR, 0.3 + crouch * 0.25 + (s.air ? 0.3 : 0), 0, 0);
  setHandPose(r, "L", 0.25);
  setHandPose(r, "R", 0.25);
}
