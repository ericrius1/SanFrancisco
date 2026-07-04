import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LIGHT_SCALE } from "../../config";
import type { AvatarTraits } from "../../player/avatar";
import type { Rider, RiderFactory } from "./types";

/**
 * The truck's guitarist, driven by a real motion-capture clip instead of the
 * hand-keyed poses the other riders use. `Guitar Playing.fbx` (a Mixamo
 * motion-only take — skeleton + one 4.8s loop, no mesh) was baked to
 * `/models/guitarist.glb`; here we hang chunky boxes off its animated bones so
 * he reads as one of the game's blocky avatars while shredding the exact
 * captured performance. No retargeting: the boxes are children of the real
 * bones, so they inherit the clip verbatim.
 *
 * The GLB loads once and is decorated into a detached template; every Rider is
 * a clone of that template plus its own AnimationMixer, so the parked truck
 * guitarist and each launched one animate independently. Because the load is
 * async and RiderFactory is synchronous, `buildGuitarPlayer` returns an empty
 * group immediately and pops the figure in when the GLB arrives (mirroring the
 * phoenix's async embodiment).
 */

// Mixamo exports ~174 cm tall in centimetres; this shrinks him to a stocky
// ~1.65 m and the launcher/flight-sim place the hips at the group origin.
const RIG_SCALE = 0.0095;
const UP = new THREE.Vector3(0, 1, 0);

type Palette = {
  skin: THREE.MeshLambertMaterial;
  hair: THREE.MeshLambertMaterial;
  tee: THREE.MeshLambertMaterial;
  sleeve: THREE.MeshLambertMaterial;
  pants: THREE.MeshLambertMaterial;
  shoe: THREE.MeshLambertMaterial;
  shade: THREE.MeshLambertMaterial;
};

function makePalette(): Palette {
  return {
    skin: new THREE.MeshLambertMaterial({ color: 0xe0a684 }),
    hair: new THREE.MeshLambertMaterial({ color: 0x191410 }),
    tee: new THREE.MeshLambertMaterial({ color: 0x7d1f8f }), // bold stage purple
    sleeve: new THREE.MeshLambertMaterial({ color: 0x5c1668 }),
    pants: new THREE.MeshLambertMaterial({ color: 0x232a3a }), // dark denim
    shoe: new THREE.MeshLambertMaterial({ color: 0x15171c }),
    shade: new THREE.MeshLambertMaterial({ color: 0x0c0e12 })
  };
}

/** A flying-V-ish electric guitar, built in centimetres (the rig's own units)
 *  with the body at the origin and the neck rising +Y, ready to be slung across
 *  the chest. */
function buildGuitar(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xc11f2b });
  const guardMat = new THREE.MeshLambertMaterial({ color: 0xf3ede0 });
  const neckMat = new THREE.MeshLambertMaterial({ color: 0x3a2a18 });
  const headMat = new THREE.MeshLambertMaterial({ color: 0x1b140c });
  const steel = new THREE.MeshLambertMaterial({ color: 0xd8dde2, emissive: 0x2a2d31, emissiveIntensity: 0.6 * LIGHT_SCALE });

  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
  };
  box(bodyMat, 34, 44, 7, 0, 0, 0); // body
  box(guardMat, 20, 26, 2, -2, -5, 4.5); // pickguard
  box(neckMat, 5, 86, 4.5, 2, 58, 1); // neck +Y
  box(headMat, 9, 16, 5, 2, 104, 1); // headstock
  box(steel, 16, 3, 3, -2, 2, 5); // bridge pickup
  box(steel, 16, 3, 3, -2, -12, 5); // neck pickup
  return g;
}

/** Long rocker hair: a fringe cube plus a fall down the back and sides. */
function addHair(head: THREE.Object3D, mat: THREE.Material) {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    head.add(m);
  };
  box(23, 8, 23, 0, 14, 0.5); // crown
  box(24, 26, 9, 0, 3, 10); // fall down the back
  box(6, 22, 9, -10, 2, 4); // left curtain
  box(6, 22, 9, 10, 2, 4); // right curtain
}

/** Box between a bone and one of its children — length/orientation read from
 *  the child's rest offset, so it wraps the real limb without any hand-tuning. */
function limb(parent: THREE.Object3D, childOffset: THREE.Vector3, w: number, d: number, mat: THREE.Material, trim = 1) {
  const len = childOffset.length();
  const seg = new THREE.Group();
  seg.quaternion.setFromUnitVectors(UP, childOffset.clone().normalize());
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, len * trim, d), mat);
  m.position.y = len / 2;
  m.castShadow = true;
  seg.add(m);
  parent.add(seg);
}

/** A simple box fixed onto a bone (torso, head, hands, feet). */
function slab(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
}

/**
 * Decorate the loaded skeleton in place: hang boxes off every major Mixamo
 * bone, sling on a guitar, then scale/lift the whole thing so the hips land at
 * the group origin. Returns the finished (detached) template to clone per rider.
 */
function decorate(scene: THREE.Object3D): THREE.Group {
  scene.updateMatrixWorld(true);
  const pal = makePalette();
  const N = (name: string) => scene.getObjectByName(name);
  const off = (name: string) => N(name)?.position.clone() ?? new THREE.Vector3(0, 1, 0);

  const hips = N("mixamorigHips");
  const spine1 = N("mixamorigSpine1");
  const head = N("mixamorigHead");

  // torso + pelvis
  if (spine1) slab(spine1, 34, 44, 24, 0, 18, 0, pal.tee);
  if (hips) slab(hips, 30, 22, 22, 0, -1, 0, pal.pants);
  // head cube, hair, shades
  if (head) {
    slab(head, 22, 22, 22, 0, 9, 1, pal.skin);
    addHair(head, pal.hair);
    slab(head, 20, 6, 3, 0, 8, 11, pal.shade); // sunglasses across the face (+Z)
  }

  for (const s of ["Left", "Right"] as const) {
    const arm = N(`mixamorig${s}Arm`);
    const fore = N(`mixamorig${s}ForeArm`);
    const hand = N(`mixamorig${s}Hand`);
    const upLeg = N(`mixamorig${s}UpLeg`);
    const leg = N(`mixamorig${s}Leg`);
    const foot = N(`mixamorig${s}Foot`);
    if (arm) limb(arm, off(`mixamorig${s}ForeArm`), 10, 10, pal.sleeve, 1.05);
    if (fore) limb(fore, off(`mixamorig${s}Hand`), 8.5, 8.5, pal.skin);
    if (hand) slab(hand, 9, 6, 10, 0, 8, 0, pal.skin); // fist
    if (upLeg) limb(upLeg, off(`mixamorig${s}Leg`), 15, 16, pal.pants);
    if (leg) limb(leg, off(`mixamorig${s}Foot`), 12.5, 13, pal.pants);
    if (foot) slab(foot, 12, 8, 24, 0, 4, 6, pal.shoe); // shoe, toe forward
  }

  // the guitar rides between his hands: its body pinned to the strum (right)
  // hand and its neck aimed at the fret (left) hand every frame (see
  // #trackGuitar), so he's always actually playing it rather than strumming air.
  // Built in cm — same units as the skeleton it lives under.
  const guitar = buildGuitar();
  guitar.name = "guitar-prop";
  guitar.scale.setScalar(0.62);
  scene.add(guitar); // sibling of the bones, inside the cm-scale holder

  // pin hips to the group origin, shrink to game scale
  const holder = new THREE.Group();
  holder.add(scene);
  holder.scale.setScalar(RIG_SCALE);
  const hipY = hips ? hips.getWorldPosition(new THREE.Vector3()).y : 98.7;
  holder.position.y = -hipY * RIG_SCALE;
  holder.rotation.y = Math.PI; // Mixamo faces +Z; the game's front is -Z
  return holder;
}

/* --------------------------------------------------- per-frame guitar tracking */

const _lh = new THREE.Vector3();
const _rh = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _x = new THREE.Vector3();
const _front = new THREE.Vector3(0, 0, 1); // character front in holder-local space
const _basis = new THREE.Matrix4();

type Tracked = { inst: THREE.Object3D; guitar: THREE.Object3D; lh: THREE.Object3D; rh: THREE.Object3D };

/**
 * Glue the guitar to the animated hands: body at the strum (right) hand, neck
 * aimed at the fret (left) hand, face turned outward — so however the clip moves
 * his arms, he's always playing the instrument instead of the air beside it.
 */
function trackGuitar(t: Tracked) {
  t.inst.updateMatrixWorld(true); // bone world matrices reflect this frame's pose
  const parent = t.guitar.parent;
  if (!parent) return;
  t.lh.getWorldPosition(_lh);
  parent.worldToLocal(_lh);
  t.rh.getWorldPosition(_rh);
  parent.worldToLocal(_rh);
  _y.subVectors(_lh, _rh); // neck direction: strum hand → fret hand
  const len = _y.length();
  if (len < 1e-3) return;
  _y.divideScalar(len);
  // orient the strings' face (guitar +Z) forward, orthogonal to the neck
  _z.copy(_front).addScaledVector(_y, -_front.dot(_y));
  if (_z.lengthSq() < 1e-6) _z.set(1, 0, 0);
  else _z.normalize();
  _x.crossVectors(_y, _z).normalize();
  _basis.makeBasis(_x, _y, _z);
  t.guitar.quaternion.setFromRotationMatrix(_basis);
  // body at the strum hand, nudged a touch up the neck and out along the face so
  // the hand rests on the strings rather than clipping through the wrist
  t.guitar.position.copy(_rh).addScaledVector(_y, 8).addScaledVector(_z, 3);
}

/* --------------------------------------------------------------- async load */

let template: THREE.Group | null = null;
let clip: THREE.AnimationClip | null = null;
let loading = false;
let instances = 0; // stagger each jammer's phase so a stage-full isn't in lockstep
const waiters: Array<() => void> = [];

function ensureLoaded() {
  if (loading || template) return;
  loading = true;
  new GLTFLoader().load(
    "/models/guitarist.glb",
    (gltf) => {
      clip = gltf.animations[0] ?? null;
      template = decorate(gltf.scene);
      for (const w of waiters.splice(0)) w();
    },
    undefined,
    (err) => {
      loading = false;
      console.error("guitarist.glb failed to load", err);
    }
  );
}

/* -------------------------------------------------------------------- rider */

export const buildGuitarPlayer: RiderFactory = (_avatar?: AvatarTraits): Rider => {
  const group = new THREE.Group();
  let mixer: THREE.AnimationMixer | null = null;
  let tracked: Tracked | null = null;
  let last = -1;

  const build = () => {
    if (!template || !clip) return;
    const inst = template.clone(true);
    group.add(inst);
    mixer = new THREE.AnimationMixer(inst);
    const action = mixer.clipAction(clip);
    action.play();
    action.time = (instances++ * 0.83) % clip.duration;
    const guitar = inst.getObjectByName("guitar-prop");
    const lh = inst.getObjectByName("mixamorigLeftHand");
    const rh = inst.getObjectByName("mixamorigRightHand");
    if (guitar && lh && rh) tracked = { inst, guitar, lh, rh };
    mixer.update(0); // snap to a playing pose now — never show the bind T-pose,
    if (tracked) trackGuitar(tracked); // and put the guitar in his hands from frame 0
  };

  if (template && clip) build();
  else {
    waiters.push(build);
    ensureLoaded();
  }

  // ride/jam both feed the same clip (he's always "playing guitar"). The Rider
  // API hands us an accumulating time; derive a clamped dt for the mixer.
  const advance = (t: number, speed: number) => {
    if (!mixer) return;
    const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, t - last));
    last = t;
    mixer.update(dt * speed);
    if (tracked) trackGuitar(tracked);
  };

  return {
    group,
    ride: (t: number) => advance(t, 1),
    jam: (t: number) => advance(t, 1.15) // dig in a little harder once he's landed
  };
};
