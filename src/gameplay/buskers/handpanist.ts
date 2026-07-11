import * as THREE from "three/webgpu";
import { buildRig } from "../../player/rig";
import { applyArmPose, solveArmPose, type ArmPose } from "./armIk";
import { SEC_PER_BEAT } from "./song";
import { midiHz, NoteCursor } from "./types";
import type { MusicianBuilder, NoteEvent, TrioClock } from "./types";

/**
 * The handpan girl — centre seat, leader of the trio. Long dirty-blonde hair
 * with bangs and face-framing front locks, a soft feminine silhouette (narrow
 * tapered arms, slight bust), charcoal cat-eye sunglasses, bare arms, and the
 * classic bronze UFO lens resting on her lap over the dangling legs. She opens
 * the song and counts the loop back in with four clear nods.
 *
 * Tap choreography: every distinct pitch in her part is pinned to one dimple
 * on the drum (sorted pitches zig-zag around the ring like a real D Kurd, so
 * neighbouring scale steps fall on opposite sides — alternating-hand
 * friendly); bar-opening "ding"s go to the centre dome, favouring the right
 * hand. Joint-rotation stations per target/hand are solved once at build time
 * with a tiny coordinate-descent IK over the real rig, so the taps land on
 * the actual geometry; at runtime the striking hand hovers over its next
 * target and snaps down in the last ~60 ms before the onset.
 *
 * Synth: struck-handpan voice per note — sine fundamental + 2.00x and 3.03x
 * partials under one 4 ms-attack exponential-decay envelope, +10 cent attack
 * pitch flex, and a soft bandpass-noise mallet "tak" on accented hits.
 */

/* ------------------------------------------------------------ tuning */

const SEAT_RIG_Y = 0.11; // rig origin above the seat point (pants touch deck)
const PLAY_LEAN = 0.13; // torso pitch while performing (stations solved here)
const REST_LEAN = 0.05;

const PAN_Y = 0.25;
const PAN_Z = -0.27;
const PAN_TILT = -0.1; // tipped slightly toward the viewer
const PAN_R = 0.26; // lens radius (0.52 diameter)
const PAN_SQUASH = 0.385; // sphere y-scale → ~0.20 tall
const RING_R = 0.155; // tone-dimple ring radius
const DIMPLE_Y = 0.076; // dimple centre height on the curved top (pan-local)
const DOME_TOP_Y = 0.125; // centre dome tap point (pan-local)
// dimple j sits at ZIG[j]·(2π/7) from the near (player) side: lowest tones
// closest to her, ascending pitches alternating left/right around the ring
const ZIG = [0, 1, -1, 2, -2, 3, -3] as const;

const HAND_HALF = 0.05; // hand block half-height → contact offset
const HOVER_LIFT = 0.085; // striking hand waits this far above the target
const DROP_BEATS = 0.06 / SEC_PER_BEAT; // ~60 ms drop into the onset
const REBOUND_SECONDS = 0.12; // bounce back up after a tap
const APPROACH_BEATS = 1.7; // start hovering over the next target this early

// struck-handpan voice
const PARTIALS = [1, 2.0, 3.03] as const; // the 3.03 gives the metallic shimmer
const PARTIAL_GAIN = [1, 0.5, 0.24] as const;

const damp = THREE.MathUtils.damp;

/* ----------------------------------------------------------- the builder */

export const buildHandpanist: MusicianBuilder = (audio, part) => {
  const group = new THREE.Group();
  group.name = "busker-handpanist";
  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];

  // ---- figure: cool black stagewear, long dirty-blonde hair, no hat, bare arms.
  // Per-rig overrides keep this look local to the performer instead of adding a
  // special case to the shared player-avatar palette.
  const rig = buildRig({ skin: 5, hair: "long", hat: "none", outfit: "tee", color: 5, accent: 3 });
  rig.avatar.materials.jacket.color.set(0x11141a); // black tee + sleeve caps
  rig.avatar.materials.sleeve.color.copy(rig.avatar.materials.skin.color); // bare arms
  rig.avatar.materials.shirt.color.set(0x343b4b);
  rig.avatar.materials.pants.color.set(0x090b11);
  rig.avatar.materials.shoe.color.set(0x1a1f29);
  rig.avatar.materials.sole.color.set(0x050608);
  rig.avatar.materials.trim.color.set(0x2b3341); // cool slate tee inset, matching the eyewear
  rig.avatar.materials.hair.color.set(0xd2b57f); // beige dirty blonde, not auburn/brown
  // Feminine silhouette: narrower waist/hips, softer torso, stock long-hair
  // replaced by the custom cut below (bangs + face-framing front + long fall).
  for (const h of rig.avatar.hair.long) h.visible = false;
  rig.avatar.torsoBlock.scale.set(0.92, 1.02, 0.88);
  rig.avatar.hipBlock.scale.set(0.9, 1, 0.92);
  rig.group.position.y = SEAT_RIG_Y;
  // Give the upper arms a clean shoulder seam. The forearms do the inward
  // reaching; the upper-arm boxes no longer have to pass through the torso.
  rig.armL.position.x = 0.29;
  rig.armR.position.x = -0.29;
  group.add(rig.group);

  // Replace this rig's shared cube with an owned, low-poly tapered face. The
  // octagonal temples and narrower jaw keep the chunky house style while the
  // silhouette reads softer and less square. Reassignment is important: the
  // original BoxGeometry comes from the rig-wide cache and must not be mutated.
  const faceGeo = new THREE.CylinderGeometry(0.14, 0.105, 0.28, 8, 1, false, Math.PI / 8).toNonIndexed();
  faceGeo.computeVertexNormals();
  ownedGeos.push(faceGeo);
  rig.avatar.headBlock.geometry = faceGeo;
  rig.avatar.headBlock.position.z = -0.02;

  // The stock shades are a single rectangular visor. Hide only this rig's bar
  // (its material is per-rig), then layer inset smoke lenses over angular black
  // silhouettes to make oversized cat-eye frames with no metallic/gold rim.
  const stockShades = rig.head.children.find(
    (child) => child instanceof THREE.Mesh && child.material === rig.avatar.materials.visor
  );
  if (stockShades) stockShades.visible = false;

  // MeshBasic so the firefly fill can't lift them to charcoal grey — ink black.
  const frameMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  const lensMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  const lipMat = new THREE.MeshLambertMaterial({ color: 0xa85f68 });
  const hairLowMat = new THREE.MeshLambertMaterial({ color: 0xaa895f });
  const hairHiMat = new THREE.MeshLambertMaterial({ color: 0xead8ad });
  ownedMats.push(frameMat, lensMat, lipMat, hairLowMat, hairHiMat);

  const polygonGeo = (points: readonly (readonly [number, number])[]) => {
    const shape = new THREE.Shape();
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    ownedGeos.push(geo);
    return geo;
  };
  const mirror = (points: readonly (readonly [number, number])[]) =>
    points.map(([x, y]) => [-x, y] as const).reverse();
  const framePoints = [
    [0.014, 0.263],
    [0.134, 0.28],
    [0.122, 0.2],
    [0.016, 0.207]
  ] as const;
  const lensPoints = [
    [0.023, 0.255],
    [0.121, 0.268],
    [0.111, 0.212],
    [0.024, 0.216]
  ] as const;
  for (const side of [1, -1] as const) {
    const frame = new THREE.Mesh(polygonGeo(side === 1 ? framePoints : mirror(framePoints)), frameMat);
    frame.position.z = -0.154;
    rig.head.add(frame);
    const lens = new THREE.Mesh(polygonGeo(side === 1 ? lensPoints : mirror(lensPoints)), lensMat);
    lens.position.z = -0.157;
    rig.head.add(lens);
  }
  const bridgeGeo = new THREE.BoxGeometry(0.038, 0.012, 0.012);
  const wingGeo = new THREE.BoxGeometry(0.026, 0.014, 0.02);
  ownedGeos.push(bridgeGeo, wingGeo);
  const bridge = new THREE.Mesh(bridgeGeo, frameMat);
  bridge.position.set(0, 0.235, -0.155);
  rig.head.add(bridge);
  for (const side of [1, -1] as const) {
    const wing = new THREE.Mesh(wingGeo, frameMat);
    wing.position.set(side * 0.133, 0.258, -0.137);
    wing.rotation.z = side * 0.18;
    rig.head.add(wing);
  }

  // ---- jewelled rim: tiny rhinestones seated on the TOP EDGE of each cat-eye
  // frame (not floating mid-lens). MeshStandard gives sharp speculars; a faint
  // emissive keeps them sparkling even in shade.
  const gemMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    metalness: 0.5,
    roughness: 0.05,
    emissive: 0xbcd6ff,
    emissiveIntensity: 0.95
  });
  ownedMats.push(gemMat);
  const gemGeo = new THREE.OctahedronGeometry(0.0075, 0);
  const tipGemGeo = new THREE.OctahedronGeometry(0.01, 0);
  ownedGeos.push(gemGeo, tipGemGeo);
  // y sits just above the frame's top edge so gems read as rim studs
  const studs: readonly (readonly [number, number, number])[] = [
    [0.038, 0.272, 0.02],
    [0.066, 0.278, 0.35],
    [0.096, 0.284, -0.25],
    [0.122, 0.289, 0.15]
  ];
  for (const side of [1, -1] as const) {
    for (const [x, y, spin] of studs) {
      const gem = new THREE.Mesh(gemGeo, gemMat);
      gem.position.set(side * x, y, -0.151); // proud of the frame face (-0.154)
      gem.rotation.set(spin, side * 0.5, side * 0.4);
      rig.head.add(gem);
    }
    const tip = new THREE.Mesh(tipGemGeo, gemMat);
    tip.position.set(side * 0.138, 0.292, -0.15);
    tip.rotation.set(0.2, side * 0.6, side * 0.5);
    rig.head.add(tip);
  }

  // A tiny two-stroke smile helps the tapered face read at gameplay distance
  // without turning the intentionally minimal voxel face into a portrait.
  const lipGeo = new THREE.BoxGeometry(0.038, 0.011, 0.01);
  ownedGeos.push(lipGeo);
  for (const side of [1, -1] as const) {
    const lip = new THREE.Mesh(lipGeo, lipMat);
    lip.position.set(side * 0.018, 0.098, -0.124);
    lip.rotation.z = side * 0.14;
    rig.head.add(lip);
  }

  // ---- feminine arms: swap the stock chunky boxes for thin tapered cylinders
  // so the silhouette reads soft and girl-like while IK joints stay put.
  const upperArmGeo = new THREE.CylinderGeometry(0.038, 0.048, 0.3, 8);
  const foreArmGeo = new THREE.CylinderGeometry(0.028, 0.036, 0.16, 8);
  const wristGeo = new THREE.CylinderGeometry(0.026, 0.03, 0.11, 8);
  ownedGeos.push(upperArmGeo, foreArmGeo, wristGeo);
  // armBlocks order from buildRig: L upper, L fore, R upper, R fore
  for (let i = 0; i < 4; i++) {
    const block = rig.avatar.armBlocks[i];
    block.geometry = i % 2 === 0 ? upperArmGeo : foreArmGeo;
    block.scale.set(1, 1, 1);
  }
  // Replace the stock wrist boxes (first skin mesh on each forearm).
  for (const fore of [rig.foreL, rig.foreR]) {
    for (const child of fore.children) {
      if (child instanceof THREE.Mesh && child.material === rig.avatar.materials.skin && child.position.y < -0.15) {
        child.geometry = wristGeo;
        child.scale.set(1, 1, 1);
      }
    }
  }
  // Soften the mitts so they don't read as big male fists over the drum.
  rig.handL.scale.set(0.82, 0.88, 0.82);
  rig.handR.scale.set(0.82, 0.88, 0.82);
  // Slim the tee's stock shoulder caps to match the narrower arms, and hide
  // the flat chest trim — the bust geometry replaces that front detail.
  for (const detail of rig.avatar.outfits.tee) {
    if (!(detail instanceof THREE.Mesh)) continue;
    if (Math.abs(detail.position.x) < 0.05) {
      detail.visible = false; // centre trim plaque
    } else if (Math.abs(detail.position.x) > 0.2) {
      detail.scale.set(0.72, 0.85, 0.78);
      detail.position.x *= 0.92;
    }
  }

  // ---- slight bust: two soft black tee mounds so she reads clearly feminine
  // at gameplay distance without leaving the chunky house style.
  const bustMat = rig.avatar.materials.jacket;
  const bustGeo = new THREE.SphereGeometry(0.07, 10, 8);
  ownedGeos.push(bustGeo);
  for (const side of [1, -1] as const) {
    const bust = new THREE.Mesh(bustGeo, bustMat);
    bust.position.set(side * 0.07, 0.28, -0.11);
    bust.scale.set(1.05, 0.85, 0.95);
    bust.castShadow = true;
    rig.torso.add(bust);
  }
  // A soft cleavage bridge keeps the two mounds reading as one chest, not
  // disconnected balls stuck on a flat board.
  const cleavageGeo = new THREE.BoxGeometry(0.1, 0.08, 0.06);
  ownedGeos.push(cleavageGeo);
  const cleavage = new THREE.Mesh(cleavageGeo, bustMat);
  cleavage.position.set(0, 0.265, -0.12);
  cleavage.castShadow = true;
  rig.torso.add(cleavage);

  // ---- long dirty-blonde cut: crown + layered bangs + face-framing front
  // locks past the jaw, and a longer multi-slat fall down the back that sways
  // in the wind. Stock long-hair is already hidden above.
  const hairMat = rig.avatar.materials.hair;
  const box = (w: number, h: number, d: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    ownedGeos.push(g);
    return g;
  };
  const hairMesh = (parent: THREE.Object3D, g: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  // crown cap — slightly taller/softer than the stock flat lid, pushed back so
  // it meets the occipital cover (no bare scalp from behind)
  hairMesh(rig.head, box(0.3, 0.1, 0.32), hairMat, 0, 0.34, 0.02);
  // layered bangs across the brow (asymmetric lengths so it isn't a ruler cut)
  const fringeL = hairMesh(rig.head, box(0.11, 0.13, 0.055), hairHiMat, -0.09, 0.255, -0.145);
  fringeL.rotation.z = 0.2;
  const fringeC = hairMesh(rig.head, box(0.1, 0.15, 0.05), hairMat, 0.01, 0.24, -0.148);
  fringeC.rotation.z = -0.05;
  const fringeR = hairMesh(rig.head, box(0.1, 0.12, 0.055), hairHiMat, 0.1, 0.265, -0.142);
  fringeR.rotation.z = -0.24;
  // long face-framing front locks — past the jaw, hanging beside the cheeks
  // so the hair reads long from the front, not just a bob with a back fall
  const sideFrontL = hairMesh(rig.head, box(0.065, 0.36, 0.08), hairMat, -0.155, 0.08, -0.06);
  sideFrontL.rotation.x = 0.08;
  sideFrontL.rotation.z = 0.06;
  const sideFrontR = hairMesh(rig.head, box(0.065, 0.38, 0.08), hairLowMat, 0.155, 0.06, -0.055);
  sideFrontR.rotation.x = 0.1;
  sideFrontR.rotation.z = -0.08;
  // extra cheek wisps that tuck in front of the shoulders
  const cheekL = hairMesh(rig.head, box(0.05, 0.28, 0.055), hairHiMat, -0.14, 0.12, -0.11);
  cheekL.rotation.z = 0.12;
  const cheekR = hairMesh(rig.head, box(0.05, 0.26, 0.055), hairMat, 0.14, 0.13, -0.105);
  cheekR.rotation.z = -0.1;
  // temple/side volume so the head isn't a bare cylinder behind the bangs
  hairMesh(rig.head, box(0.07, 0.26, 0.12), hairLowMat, -0.16, 0.16, 0.04);
  hairMesh(rig.head, box(0.07, 0.28, 0.12), hairMat, 0.16, 0.14, 0.04);
  // occipital bridge — covers the back of the head so the fall joins the crown
  // instead of floating off a bare scalp gap
  hairMesh(rig.head, box(0.28, 0.2, 0.1), hairMat, 0, 0.24, 0.125);
  hairMesh(rig.head, box(0.24, 0.14, 0.08), hairLowMat, 0, 0.14, 0.145);

  // back fall — longer overlapping slats, pivoted under the occipital cover
  const slatGeo = box(0.11, 0.44, 0.05);
  const hairFall = new THREE.Group();
  hairFall.position.set(0, 0.16, 0.155); // under the nape fill, continuous with crown
  rig.head.add(hairFall);
  const slats: THREE.Mesh[] = [];
  const slatBaseZ: number[] = [];
  const slatMats = [hairLowMat, hairMat, hairHiMat] as const;
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(slatGeo, slatMats[i]);
    s.position.set((i - 1) * 0.078, -0.2, 0.006 + Math.abs(i - 1) * 0.008);
    const baseZ = (i - 1) * 0.12; // gentle outward fan
    s.rotation.z = baseZ;
    s.castShadow = true;
    hairFall.add(s);
    slats.push(s);
    slatBaseZ.push(baseZ);
  }
  // one extra longer central lock for a shaggy feminine silhouette
  const longLock = hairMesh(hairFall, box(0.1, 0.5, 0.048), hairMat, 0.015, -0.24, 0.02);
  longLock.rotation.z = 0.05;

  // ---- the handpan: parented to the GROUP (not a limb) so it never bobs
  const shellMat = new THREE.MeshLambertMaterial({ color: 0x8a5a33 });
  const domeMat = new THREE.MeshLambertMaterial({ color: 0x9a6a3e });
  const dimpleMat = new THREE.MeshLambertMaterial({ color: 0x6e4526 });
  const seamMat = new THREE.MeshLambertMaterial({ color: 0x50331c });
  ownedMats.push(shellMat, domeMat, dimpleMat, seamMat);

  const pan = new THREE.Group();
  pan.name = "busker-handpan";
  pan.position.set(0, PAN_Y, PAN_Z);
  pan.rotation.x = PAN_TILT;
  group.add(pan);

  const lensGeo = new THREE.SphereGeometry(PAN_R, 24, 18);
  const domeGeo = new THREE.SphereGeometry(0.06, 14, 10);
  const dimpleGeo = new THREE.SphereGeometry(0.038, 12, 8);
  const seamGeo = new THREE.CylinderGeometry(PAN_R + 0.004, PAN_R + 0.004, 0.016, 28);
  ownedGeos.push(lensGeo, domeGeo, dimpleGeo, seamGeo);

  const lens = new THREE.Mesh(lensGeo, shellMat);
  lens.scale.set(1, PAN_SQUASH, 1);
  lens.castShadow = true;
  pan.add(lens);
  const seam = new THREE.Mesh(seamGeo, seamMat); // rim shadow line at the equator
  seam.castShadow = true;
  pan.add(seam);
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.scale.set(1, 0.5, 1);
  dome.position.y = 0.097;
  dome.castShadow = true;
  pan.add(dome);
  for (let j = 0; j < 7; j++) {
    const a = (ZIG[j] * Math.PI * 2) / 7;
    const dimple = new THREE.Mesh(dimpleGeo, dimpleMat);
    dimple.scale.set(1, 0.3, 1);
    dimple.position.set(Math.sin(a) * RING_R, DIMPLE_Y, Math.cos(a) * RING_R);
    dimple.castShadow = true;
    pan.add(dimple);
  }

  // ---- hand markers (plain groups at the hand block centre) for the IK
  const markL = new THREE.Group();
  markL.position.set(0, -0.3, -0.01);
  rig.foreL.add(markL);
  const markR = new THREE.Group();
  markR.position.set(0, -0.3, -0.01);
  rig.foreR.add(markR);

  // ---- tap targets in group space (group is unparented ⇒ world == local)
  pan.updateWorldMatrix(true, false);
  const strikePts: THREE.Vector3[] = [];
  const hoverPts: THREE.Vector3[] = [];
  const targetX: number[] = []; // for glancing toward the striking side
  for (let j = 0; j < 7; j++) {
    const a = (ZIG[j] * Math.PI * 2) / 7;
    const s = pan.localToWorld(new THREE.Vector3(Math.sin(a) * RING_R, DIMPLE_Y, Math.cos(a) * RING_R));
    s.y += HAND_HALF;
    strikePts.push(s);
    hoverPts.push(s.clone().setY(s.y + HOVER_LIFT));
    targetX.push(s.x);
  }
  const domePt = pan.localToWorld(new THREE.Vector3(0, DOME_TOP_Y, 0)); // target 7 = the ding
  domePt.y += HAND_HALF;
  strikePts.push(domePt);
  hoverPts.push(domePt.clone().setY(domePt.y + HOVER_LIFT));
  targetX.push(0);
  const restPts = [
    pan.localToWorld(new THREE.Vector3(0.16, 0.07, 0.05)), // L palm parked on the drum
    pan.localToWorld(new THREE.Vector3(-0.16, 0.07, 0.05)) // R palm
  ];
  for (const r of restPts) r.y += HAND_HALF - 0.01;
  const readyPts = [new THREE.Vector3(0.2, PAN_Y + 0.21, PAN_Z - 0.02), new THREE.Vector3(-0.2, PAN_Y + 0.21, PAN_Z - 0.02)];

  // ---- solve the station lookup: strike + hover per target, per hand
  const handRigs = [
    { arm: rig.armL, fore: rig.foreL, marker: markL, side: 1 as const, seed: [0.85, 0.08, 0.22, 1.15, 0, -0.65] as ArmPose },
    { arm: rig.armR, fore: rig.foreR, marker: markR, side: -1 as const, seed: [0.85, -0.08, -0.22, 1.15, 0, 0.65] as ArmPose }
  ];
  const strike: ArmPose[][] = [[], []];
  const hover: ArmPose[][] = [[], []];
  const readyPose: ArmPose[] = [];
  const restPose: ArmPose[] = [];
  rig.hips.rotation.set(0, 0, 0);
  for (let h = 0; h < 2; h++) {
    const H = handRigs[h];
    rig.torso.rotation.set(PLAY_LEAN, 0, 0); // playing stations solved at play lean
    for (let j = 0; j < 8; j++) {
      const s = solveArmPose(H.arm, H.fore, H.marker, strikePts[j], H.seed, { side: H.side, elbowClearance: 0.265 });
      strike[h].push(s);
      hover[h].push(solveArmPose(H.arm, H.fore, H.marker, hoverPts[j], s, { side: H.side, elbowClearance: 0.265 }));
    }
    readyPose.push(solveArmPose(H.arm, H.fore, H.marker, readyPts[h], H.seed, { side: H.side, elbowClearance: 0.265 }));
    rig.torso.rotation.set(REST_LEAN, 0, 0); // palms park on the drum at rest lean
    restPose.push(solveArmPose(H.arm, H.fore, H.marker, restPts[h], readyPose[h], { side: H.side, elbowClearance: 0.265 }));
  }

  // ---- per-event choreography: pitch → dimple. Side dimples belong to the
  // nearest hand; only the centre/ding targets alternate. This prevents the
  // conspicuous cross-body shoulder penetration of the old blind alternation.
  // Rebuilt whenever the songbook cycles (setPart).
  let animOf = new Map<NoteEvent, { hand: number; target: number }>();
  let cursor = new NoteCursor(part);
  const bindPart = (events: NoteEvent[]) => {
    const distinct = Array.from(new Set(events.map((e) => e.midis[0]))).sort((a, b) => a - b);
    const dimpleOf = new Map<number, number>();
    distinct.forEach((m, i) => dimpleOf.set(m, i % 7));
    animOf = new Map();
    let lastHand = 1;
    for (const e of events) {
      const ding = e.tag === "ding";
      const target = ding ? 7 : (dimpleOf.get(e.midis[0]) ?? 0);
      const x = targetX[target];
      const hand = ding || Math.abs(x) < 0.035 ? (lastHand === 1 ? 0 : 1) : x > 0 ? 0 : 1;
      lastHand = hand;
      animOf.set(e, { hand, target });
    }
    cursor = new NoteCursor(events);
  };
  bindPart(part);

  // ---- runtime state (module-temp reuse only; zero per-frame allocations)
  const handPose: ArmPose[] = [restPose[0].slice() as ArmPose, restPose[1].slice() as ArmPose];
  let perform = 0; // eased 0(rest)..1(playing/countin)
  let t = 0; // own accumulator (phaseTime resets at phase edges)
  let gaze = 0.1;
  let headYaw = 0;
  let lastTargetX = 0;
  let prevPhase = "";
  let prevCurrent: NoteEvent | null = null;

  // settle into the seated rest pose so frame 0 already reads right
  rig.torso.rotation.set(REST_LEAN, 0, 0);
  rig.head.rotation.set(-0.1, 0, 0);
  for (let h = 0; h < 2; h++) {
    applyArmPose(handRigs[h].arm, handRigs[h].fore, handPose[h]);
  }
  rig.legL.rotation.set(1.3, 0, 0.04);
  rig.legR.rotation.set(1.26, 0, -0.04);
  rig.shinL.rotation.x = -1.0;
  rig.shinR.rotation.x = -0.98;

  const update = (dt: number, clock: TrioClock) => {
    t += dt;
    if (clock.phase !== prevPhase) {
      if (clock.phase === "playing") cursor.reset();
      prevPhase = clock.phase;
    }
    perform = damp(perform, clock.phase === "rest" ? 0 : 1, 3, dt);
    const p = perform;
    const wind = clock.wind;
    const { current, next } = cursor.at(clock.beat);
    if (current !== prevCurrent) {
      prevCurrent = current;
      if (current) {
        const info = animOf.get(current);
        if (info) lastTargetX = targetX[info.target];
      }
    }
    const nInfo = next ? animOf.get(next) : undefined;
    const cInfo = current ? animOf.get(current) : undefined;

    // ---- hands: hover over the next target, drop at the onset, bounce back
    for (let h = 0; h < 2; h++) {
      const rest = restPose[h];
      let tgt: ArmPose = readyPose[h];
      let lam = 5.5;
      if (clock.phase === "countin") {
        lam = 6; // hover back into ready position under the count
      } else if (clock.phase === "playing") {
        let dropping = false;
        if (nInfo && nInfo.hand === h && next) {
          const tb = next.beat - clock.beat;
          if (tb <= DROP_BEATS) {
            tgt = strike[h][nInfo.target]; // the fast ~60 ms drop → contact at the onset
            lam = 42;
            dropping = true;
          } else if (tb <= APPROACH_BEATS) {
            tgt = hover[h][nInfo.target]; // anticipation: lift over the target
            lam = 9;
          }
        }
        if (!dropping && cInfo && cInfo.hand === h && current) {
          const since = (clock.beat - current.beat) * SEC_PER_BEAT;
          if (since >= 0 && since < REBOUND_SECONDS) {
            tgt = hover[h][cInfo.target]; // spring back off the metal
            lam = 16;
          }
        }
      }
      const pose = handPose[h];
      const lamF = 4 + (lam - 4) * p;
      for (let i = 0; i < pose.length; i++) {
        const goal = rest[i] + (tgt[i] - rest[i]) * p; // rest ↔ perform blend, no pops
        pose[i] = damp(pose[i], goal, lamF, dt);
      }
      const H = handRigs[h];
      const bob = (1 - p) * 0.02 * Math.sin(t * 1.05 + h * 2.5) + p * 0.012 * Math.sin(t * 2.3 + h * 2.9);
      applyArmPose(H.arm, H.fore, pose);
      H.arm.rotation.x += bob;
    }

    // ---- nods: the count-in is THE moment — four big legible dips
    let nod = 0;
    if (clock.phase === "countin") {
      const beatInCount = clock.phaseTime / SEC_PER_BEAT;
      nod = Math.exp(-(beatInCount % 1) * 6.5) * 0.26;
    } else if (clock.phase === "playing") {
      nod = Math.exp(-(clock.beat % 2) * 6) * 0.1; // subtle nod on beats 1 and 3
    }

    // ---- gaze: down at the drum when busy, up to the view in the gaps
    let gazeTgt: number;
    let yawTgt: number;
    if (clock.phase === "countin") {
      gazeTgt = -0.06; // eyes up, checking the band
      yawTgt = Math.sin(clock.phaseTime * 1.4) * 0.3; // glance to both bandmates
    } else {
      const gap = current && next ? next.beat - current.beat : 9;
      gazeTgt = gap > 0.95 ? -0.13 : 0.3;
      yawTgt = -lastTargetX * 1.2; // follow the striking side
    }
    gaze = damp(gaze, gazeTgt, 3.5, dt);
    headYaw = damp(headYaw, yawTgt, 3, dt);

    // ---- torso & head: perform pulse ↔ rest breathing, mixed by `perform`
    const playTorsoX = PLAY_LEAN + 0.016 * Math.sin(clock.beat * Math.PI * 4) + nod * 0.22;
    const restTorsoX = REST_LEAN + 0.028 * Math.sin(t * 1.05) + wind * 0.012;
    const restTorsoY = Math.sin(t * 0.16) * 0.07;
    const restTorsoZ = Math.sin(t * 0.5 + 1.3) * 0.02 * (0.4 + wind);
    const playHeadX = gaze + nod;
    const restHeadX = -0.17 + 0.02 * Math.sin(t * 1.05 + 0.7); // tipped up into the breeze
    const restHeadY = Math.sin(t * 0.21) * 0.42 + Math.sin(t * 0.073 + 1) * 0.18; // slow look around
    const restHeadZ = Math.sin(t * 0.34) * 0.05 * (0.3 + wind);
    rig.torso.rotation.set(
      restTorsoX + (playTorsoX - restTorsoX) * p,
      restTorsoY + (headYaw * 0.45 - restTorsoY) * p,
      restTorsoZ * (1 - p)
    );
    rig.head.rotation.set(restHeadX + (playHeadX - restHeadX) * p, restHeadY + (headYaw - restHeadY) * p, restHeadZ * (1 - p));
    rig.hips.rotation.set(0, 0, (1 - p) * 0.012 * Math.sin(t * 0.45));

    // ---- legs: dangling over the drop, loose lazy swing (the charm)
    const swing = 0.15 - 0.07 * p + wind * 0.03;
    rig.legL.rotation.x = 1.3 + Math.sin(t * 0.83) * swing;
    rig.legR.rotation.x = 1.26 + Math.sin(t * 0.83 + 2.4) * swing;
    rig.shinL.rotation.x = -1.0 + Math.sin(t * 0.83 - 0.9) * swing * 1.8;
    rig.shinR.rotation.x = -0.98 + Math.sin(t * 0.83 + 1.5) * swing * 1.8;

    // ---- hair in the wind: the whole fall sways as one, with a little
    // per-slat lag so it reads as soft strands; bangs + face locks drift too
    const hairAmp = 0.05 + wind * 0.24;
    hairFall.rotation.x = 0.05 + Math.sin(t * 1.5 + 0.3) * hairAmp * 0.5; // drift back & forth
    hairFall.rotation.z = Math.sin(t * 1.9 + 1.1) * hairAmp; // side-to-side sway
    hairFall.rotation.y = Math.sin(t * 1.15) * hairAmp * 0.4; // gentle twist
    for (let i = 0; i < slats.length; i++) {
      slats[i].rotation.z = slatBaseZ[i] + Math.sin(t * 2.2 + i * 1.3) * hairAmp * 0.5;
    }
    longLock.rotation.z = 0.05 + Math.sin(t * 1.7 + 2.2) * hairAmp * 0.5;
    fringeL.rotation.z = 0.2 + Math.sin(t * 2.4 + 0.5) * hairAmp * 0.28;
    fringeC.rotation.z = -0.05 + Math.sin(t * 2.1 + 1.1) * hairAmp * 0.2;
    fringeR.rotation.z = -0.24 + Math.sin(t * 2.2 + 1.8) * hairAmp * 0.28;
    sideFrontL.rotation.z = 0.06 + Math.sin(t * 1.8 + 0.3) * hairAmp * 0.35;
    sideFrontR.rotation.z = -0.08 + Math.sin(t * 1.9 + 1.4) * hairAmp * 0.35;
    cheekL.rotation.z = 0.12 + Math.sin(t * 2.0 + 0.8) * hairAmp * 0.22;
    cheekR.rotation.z = -0.1 + Math.sin(t * 2.05 + 1.6) * hairAmp * 0.22;
  };

  // ---- audio: one self-cleaning struck-handpan voice per note
  let noiseBuf: AudioBuffer | null = null; // shared mallet-noise source, lazy
  const schedule = (events: NoteEvent[], atTime: (beat: number) => number) => {
    const ctx = audio.ctx;
    const out = audio.out;
    if (!ctx || !out) return;
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const now = ctx.currentTime;
    for (const e of events) {
      const t0 = atTime(e.beat);
      const start = Math.max(now, t0); // slightly-past events clamp to now
      const hz = midiHz(e.midis[0]);
      const peak = 0.16 * e.vel;
      const ring = e.tag === "ding" ? 3.5 : 2.2;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + 0.004);
      env.gain.exponentialRampToValueAtTime(peak * 8e-4, t0 + ring);
      env.gain.linearRampToValueAtTime(0, t0 + ring + 0.04);
      env.connect(out);

      const gains: GainNode[] = [env];
      const oscs: OscillatorNode[] = [];
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = hz * PARTIALS[i];
        osc.detune.setValueAtTime(10, t0); // attack pitch flex: +10 cents → 0
        osc.detune.linearRampToValueAtTime(0, t0 + 0.06);
        const pg = ctx.createGain();
        pg.gain.value = PARTIAL_GAIN[i];
        osc.connect(pg);
        pg.connect(env);
        osc.start(start);
        osc.stop(t0 + ring + 0.08);
        gains.push(pg);
        oscs.push(osc);
      }
      oscs[0].onended = () => {
        for (const o of oscs) o.disconnect();
        for (const g of gains) g.disconnect();
      };

      if (e.vel > 0.6) {
        // soft mallet "tak": 25 ms bandpass noise blip
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuf;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 900;
        bp.Q.value = 4;
        const tg = ctx.createGain();
        tg.gain.setValueAtTime(0.05 * e.vel, t0);
        tg.gain.exponentialRampToValueAtTime(4e-4, t0 + 0.025);
        tg.gain.linearRampToValueAtTime(0, t0 + 0.032);
        noise.connect(bp);
        bp.connect(tg);
        tg.connect(out);
        noise.start(start);
        noise.stop(t0 + 0.06);
        noise.onended = () => {
          noise.disconnect();
          bp.disconnect();
          tg.disconnect();
        };
      }
    }
  };

  return {
    group,
    update,
    schedule,
    setPart(next) {
      bindPart(next);
      prevCurrent = null;
    },
    dispose() {
      group.parent?.remove(group);
      for (const g of ownedGeos) g.dispose(); // face + styling + pan + strands —
      for (const m of ownedMats) m.dispose(); // never the rig's shared cache
    }
  };
};
