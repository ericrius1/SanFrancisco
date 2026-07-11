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
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
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
  hats: Record<AvatarHat, THREE.Object3D[]>;
  outfits: Record<AvatarOutfit, THREE.Object3D[]>;
  allHair: THREE.Object3D[];
  allHats: THREE.Object3D[];
  allOutfits: THREE.Object3D[];
};

const DEFAULT_RIG_AVATAR = avatarFromSeed("local-default");

const STATIC_MAT = {
  sole: new THREE.MeshLambertMaterial({ color: 0x1b1d22 }),
  clubGrip: new THREE.MeshLambertMaterial({ color: 0x263137 }),
  clubShaft: new THREE.MeshLambertMaterial({ color: 0xa9b8be }),
  clubHead: new THREE.MeshLambertMaterial({ color: 0x5c6d73 })
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
  m.castShadow = true;
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

  const primaryColor = new THREE.Color(primary);
  const skinColor = new THREE.Color(skin);
  const brightAccent = color(accent, 1.35);
  const sleeveColor =
    avatar.outfit === "tee" || avatar.outfit === "dress"
      ? skinColor
      : avatar.outfit === "overalls"
        ? brightAccent
        : color(primary, 0.82);
  const torsoColor = avatar.outfit === "overalls" ? brightAccent : primaryColor;
  const pantsColor =
    avatar.outfit === "overalls" ? color(primary, 0.58) : avatar.outfit === "dress" ? new THREE.Color(0x20242b) : new THREE.Color(0x30343c);

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
  setVisible(s.hair[avatar.hair], avatar.hair === "long" || avatar.hat === "none" || avatar.hat === "visor" || avatar.hat === "crown");
  setVisible(s.hats[avatar.hat], true);
  setVisible(s.outfits[avatar.outfit], true);

  s.torsoBlock.scale.set(avatar.outfit === "dress" ? 0.96 : 1, 1, 1);
  s.hipBlock.scale.set(avatar.outfit === "dress" ? 1.08 : 1.02, 1, 1);
  s.headBlock.scale.setScalar(1);
  for (const arm of s.armBlocks) arm.scale.set(1, 1, 1);
  for (const leg of s.legBlocks) leg.scale.set(avatar.outfit === "dress" ? 0.94 : 1, 1, 1);
}

export function buildRig(avatar: AvatarTraits = DEFAULT_RIG_AVATAR): Rig {
  const materials = makeAvatarMaterials();
  const group = new THREE.Group();
  const hair: RigAvatarState["hair"] = { short: [], bob: [], mohawk: [], buzz: [], long: [] };
  const hats: RigAvatarState["hats"] = { none: [], cap: [], beanie: [], visor: [], crown: [] };
  const outfits: RigAvatarState["outfits"] = { jacket: [], hoodie: [], tee: [], overalls: [], dress: [] };
  const allHair: THREE.Object3D[] = [];
  const allHats: THREE.Object3D[] = [];
  const allOutfits: THREE.Object3D[] = [];
  const armBlocks: THREE.Mesh[] = [];
  const legBlocks: THREE.Mesh[] = [];

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
  push(hair.short, part(head, materials.hair, 0.29, 0.08, 0.28, 0, 0.34, 0));
  push(hair.buzz, part(head, materials.hair, 0.28, 0.045, 0.28, 0, 0.325, 0));
  push(hair.bob, part(head, materials.hair, 0.3, 0.08, 0.28, 0, 0.34, 0));
  push(hair.bob, part(head, materials.hair, 0.07, 0.22, 0.12, -0.17, 0.21, 0.03));
  push(hair.bob, part(head, materials.hair, 0.07, 0.22, 0.12, 0.17, 0.21, 0.03));
  push(hair.long, part(head, materials.hair, 0.3, 0.08, 0.28, 0, 0.34, 0));
  push(hair.long, part(head, materials.hair, 0.24, 0.28, 0.08, 0, 0.16, 0.16));
  push(hair.long, part(head, materials.hair, 0.055, 0.24, 0.08, -0.17, 0.18, 0.08));
  push(hair.long, part(head, materials.hair, 0.055, 0.24, 0.08, 0.17, 0.18, 0.08));
  push(hair.mohawk, part(head, materials.hair, 0.09, 0.18, 0.32, 0, 0.39, 0));
  allHair.push(...hair.short, ...hair.bob, ...hair.mohawk, ...hair.buzz, ...hair.long);
  push(hats.cap, part(head, materials.hat, 0.28, 0.1, 0.28, 0, 0.335, 0));
  push(hats.cap, part(head, materials.hat, 0.26, 0.03, 0.16, 0, 0.31, -0.2)); // brim
  push(hats.beanie, part(head, materials.hat, 0.29, 0.12, 0.29, 0, 0.35, 0));
  push(hats.beanie, part(head, materials.trim, 0.31, 0.04, 0.3, 0, 0.29, 0));
  push(hats.visor, part(head, materials.hat, 0.3, 0.045, 0.29, 0, 0.31, 0));
  push(hats.visor, part(head, materials.hat, 0.28, 0.03, 0.18, 0, 0.3, -0.2));
  push(hats.crown, part(head, materials.hat, 0.3, 0.045, 0.3, 0, 0.34, 0));
  for (const x of [-0.11, 0, 0.11]) push(hats.crown, part(head, materials.trim, 0.055, 0.13, 0.055, x, 0.42, -0.08));
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
    part(fore, materials.skin, 0.09, 0.12, 0.1, 0, -0.2, 0);
    part(fore, materials.skin, 0.09, 0.1, 0.11, 0, -0.3, -0.01); // hand
    return { shoulder, fore };
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
    part(shin, materials.sole, 0.16, 0.03, 0.31, 0, -0.41, -0.06);
    return { hip, shin };
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
    legL: lL.hip,
    legR: lR.hip,
    shinL: lL.shin,
    shinR: lR.shin,
    avatar: {
      materials,
      torsoBlock,
      hipBlock,
      headBlock,
      armBlocks,
      legBlocks,
      hair,
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
  return { group, spin };
}

/** Lightweight club prop. Origin = the TOP of the grip (where the joined hands
 *  hold it), shaft hanging down local -Y. In the golfer's address frame the
 *  ball is in front (local -Z) and the target is to the lead side (local -X),
 *  so the head's toe points -Z (away from the golfer) and its face plate looks
 *  -X (down the line). The Player parents one persistent instance under an
 *  animated chest pivot so the club actually travels with the hands. */
export function buildGolfClub(): THREE.Group {
  const group = new THREE.Group();
  group.name = "golf-club";

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.022, 0.24, 7), STATIC_MAT.clubGrip);
  grip.position.y = -0.11;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.017, 0.58, 7), STATIC_MAT.clubShaft);
  shaft.position.y = -0.52;
  // head: heel at the shaft, toe reaching -Z; a brighter face plate on the -X
  // (target) side reads as "this is the side that hits the ball"
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.08, 0.22), STATIC_MAT.clubHead);
  head.position.set(-0.005, -0.835, -0.06);
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.07, 0.2), STATIC_MAT.clubShaft);
  face.position.set(-0.052, -0.835, -0.06);
  const sole = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.23), STATIC_MAT.sole);
  sole.position.set(-0.005, -0.882, -0.06);
  for (const mesh of [grip, shaft, head, face, sole]) {
    mesh.castShadow = true;
    group.add(mesh);
  }
  group.visible = false;
  return group;
}

/* ------------------------------------------------------------------- poses */

function set(g: THREE.Group, x: number, y: number, z: number) {
  g.rotation.set(x, y, z);
}

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

/** Walk↔run cycle; `t` is the stride phase, `run` blends 0..1 into a sprint. */
export function poseWalk(r: Rig, t: number, run: number) {
  const swing = 0.55 + run * 0.5;
  const sL = Math.sin(t);
  const sR = Math.sin(t + Math.PI);
  r.hips.position.y = -(0.02 + run * 0.045) * (0.5 - 0.5 * Math.cos(2 * t));
  set(r.hips, 0, 0, 0);
  set(r.torso, 0.07 + run * 0.22, sL * 0.07, 0);
  set(r.head, -(0.04 + run * 0.12), sL * 0.04, 0); // keep the gaze level against the lean
  set(r.legL, sL * swing, 0, 0);
  set(r.legR, sR * swing, 0, 0);
  set(r.shinL, -Math.max(0, Math.sin(t + Math.PI * 0.6)) * (0.5 + run * 0.7), 0, 0);
  set(r.shinR, -Math.max(0, Math.sin(t + Math.PI * 1.6)) * (0.5 + run * 0.7), 0, 0);
  set(r.armL, sR * swing * 0.8, 0, 0.06);
  set(r.armR, sL * swing * 0.8, 0, -0.06);
  set(r.foreL, 0.25 + run * 0.55 + Math.max(0, sR) * 0.2, 0, 0);
  set(r.foreR, 0.25 + run * 0.55 + Math.max(0, sL) * 0.2, 0, 0);
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

  const shoulders = s * 0.95; // - = chest toward +X (trail), + = open to target
  const hipTurn = s * 0.4 + thru * 0.28;

  // weight shift: trail foot at the top, hard onto the lead foot at the finish
  r.hips.position.x = -s * 0.06 - thru * 0.07;
  r.hips.position.y = -0.07 - back * 0.02 + thru * 0.025;
  r.hips.position.z = 0.05 - thru * 0.04; // butt back at address, tall finish
  set(r.hips, 0, hipTurn, 0);
  // spine hinged toward the ball, side-bending with the turn, rising to finish
  set(r.torso, 0.42 - thru * 0.3, shoulders, s * 0.1);
  // eyes stay down on the ball until well after impact, then chase the shot
  set(r.head, -0.26 + thru * 0.14, -shoulders * 0.72 + thru * 0.55, -s * 0.05);

  // stance splayed, knees soft; the trail leg releases (knee in, heel up) as
  // the hips clear through the finish
  set(r.legL, L(0.06, 0.02, -0.5), 0, 0.14 - thru * 0.18);
  set(r.legR, L(0.06, 0.1, 0.12), 0, -0.14 + back * 0.06);
  set(r.shinL, L(-0.16, -0.12, -0.75), 0, 0);
  set(r.shinR, L(-0.16, -0.22, -0.06), 0, 0);

  // joined hands ride the club: the lead arm (-X side, armR) stays long while
  // the trail arm folds at the top — mirrored through the finish
  set(r.armL, L(0.55, 0.18, 0.5), L(0, -0.15, 0.1), L(-0.5, -0.12, -1.1));
  set(r.armR, L(0.55, 0.5, 0.18), L(0, -0.1, 0.15), L(0.5, 1.1, 0.12));
  set(r.foreL, L(0.35, 0.95, 0.12), 0, 0);
  set(r.foreR, L(0.35, 0.12, 0.95), 0, 0);
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
