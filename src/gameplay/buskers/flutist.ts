import * as THREE from "three/webgpu";
import { buildRig, setRigClasp } from "../../player/rig";
import { applyArmPose, dampArmPose, mixArmPose, solveArmPose, type ArmPose } from "./armIk";
import { SEC_PER_BEAT } from "./song";
import { midiHz, NoteCursor, type MusicianBuilder, type NoteEvent, type TrioClock } from "./types";

/** Warm light-brown — a touch richer than sandy blonde so it reads brown in daylight. */
const HAIR_BROWN = 0x8f5e30;

/**
 * The flutist — viewer's RIGHT seat. Eyes down, lost in it.
 *
 * A deep-navy alpaca-knit figure with shorter light-brown hair (no hat/hood,
 * no ponytail), round black teashades, a reddish cedar Native American flute
 * (end-blown, carved bird block + buckskin tie) held out front-and-down, and
 * legs dangling over the edge. His part (SONG.flute) doesn't enter until bar 9:
 * through the handpan/uke intro he sits with the flute low across his lap,
 * nodding faintly with the pulse, then raises it to his mouth in one smooth
 * motion a beat before his first note. He also drops out for the bars-17-20
 * interlude and lifts back in for phrase B.
 *
 * Animation is rig.ts pose-function style: every frame overwrites the joint
 * rotations from (clock, NoteCursor). Two eased scalars drive all blending —
 * `perform` (rest ↔ attentive, damped ~3/s) and `lift` (flute lap ↔ lips) —
 * so phase edges never pop.
 *
 * The flute is parented to rig.head so it stays glued to the lips while the
 * head moves; when lowered, its lap transform is computed by cancelling the
 * head's current rotation, so it rests across the thighs no matter where he
 * is looking.
 */

/* ------------------------------------------------------------- constants */

// Native American flute is END-BLOWN: the mouthpiece touches the lips and the
// body angles DOWN and FORWARD, held out in front with both hands. The flute
// group's mouthpiece is at its origin, its body running along local -Z; this
// quat (head-local) pitches that body down ~36° so it points forward-and-down
// from the mouth. Positioned just below/front of the lips.
const LIP_POS = new THREE.Vector3(0.0, 0.075, -0.135);
const LIP_QUAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.63, 0.02, 0));
// flute lowered across the lap, in TORSO space (head origin sits at torso
// (0, 0.46, 0); mouth end ≈ torso (+0.2, -0.06, -0.22)); rolled so the
// long body crosses both thighs toward his right hand.
const LAP_OFFSET = new THREE.Vector3(0.2, -0.52, -0.22);
const LAP_QUAT_T = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 1.25, 0.12));

const RAISE_LAMBDA = 4.5; // lift → lips (one smooth ~0.7 s motion)
const LOWER_LAMBDA = 2.0; // lips → lap (deliberate, unhurried)
const PERFORM_LAMBDA = 3.0;
const GRIP_LAMBDA = 10.0;
const ACTIVE_TAIL_BEATS = 0.12; // keep the flute raised through the note's soft release

// The base prop was much thinner than one voxel hand. Width is scaled separately
// from length so it reads clearly without turning into a walking stick.
const FLUTE_WIDTH_SCALE = 2.4;
const FLUTE_LENGTH_SCALE = 1.1;
const GRIP_MIDI_LOW = 64; // E4, bottom of the authored melody
const GRIP_MIDI_HIGH = 76; // E5, top of the authored melody
const GRIP_L_LOW_Z = -0.26;
const GRIP_L_HIGH_Z = -0.22;
const GRIP_R_LOW_Z = -0.41;
const GRIP_R_HIGH_Z = -0.35;

// synth (warm, woody Native American flute — deep fundamental, soft breath,
// long tail into the mountain reverb; deliberately un-tinny)
const ATTACK = 0.09; // breathy onset
const RELEASE = 0.3; // long release melts into the reverb tail
const SUSTAIN = 0.16; // * vel
const SUB_GAIN = 0.24; // octave BELOW the fundamental — body & depth
const OCTAVE_GAIN = 0.04; // soft octave above (kept low so it never gets tinny)
const TWELFTH_GAIN = 0.05; // a woody twelfth (3rd harmonic) for reedy richness
const BODY_HZ = 850; // woody formant peak
const BODY_GAIN = 0.42; // fundamental fraction run through the body resonance
const BREATH_GAIN = 0.055;
const BREATH_LP_HZ = 1500; // warmer, less hiss
const REVERB_SEND = 0.45; // wet fraction into the shared "off the mountains" reverb
const VIB_HZ = 4.8;
const VIB_CENTS = 7;
const VIB_RAMP = 0.35;

// module-scope temps — update() allocates nothing
const _q1 = new THREE.Quaternion();
const _v1 = new THREE.Vector3();

const lerp = THREE.MathUtils.lerp;
const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;

function set(g: THREE.Group, x: number, y: number, z: number) {
  g.rotation.set(x, y, z);
}

/* --------------------------------------------------------------- builder */

export const buildFlutist: MusicianBuilder = (audio, part) => {
  // A deep-navy alpaca-knit sweater (no hood). Restrained Andean bands are
  // added as raised voxel-knit details on the chest and animated sleeves.
  const rig = buildRig({ skin: 1, hair: "long", hat: "none", outfit: "hoodie", color: 5, accent: 7 });
  // peach base, nudged a touch fairer — short of porcelain
  rig.avatar.materials.skin.color.set(0xe6b08a);
  rig.avatar.materials.jacket.color.set(0x27323c);
  rig.avatar.materials.sleeve.color.set(0x2d3842);
  rig.avatar.materials.shirt.color.set(0xd7c6a3);
  rig.avatar.materials.trim.color.set(0x27323c);
  rig.avatar.materials.hair.color.set(HAIR_BROWN);
  rig.avatar.torsoBlock.scale.set(1.04, 1.02, 1.04);
  for (const sleeve of rig.avatar.armBlocks) sleeve.scale.set(1.055, 1, 1.055);
  // stock long-hair is replaced by the shorter custom cut below
  for (const h of rig.avatar.hair.long) h.visible = false;
  rig.group.position.y = 0.11; // seat of the pants on the deck top
  const group = new THREE.Group();
  group.name = "busker-flutist";
  group.add(rig.group);

  // Hide the stock hood-down bump, pocket and chest stripe; the woven sweater
  // detailing below replaces all three.
  for (const detail of rig.avatar.outfits.hoodie) detail.visible = false;

  const ownGeos: THREE.BufferGeometry[] = [];
  const ownMats: THREE.Material[] = [];
  const geo = (w: number, h: number, d: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    ownGeos.push(g);
    return g;
  };
  const mesh = (parent: THREE.Object3D, g: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  /* ---- alpaca knit: restrained cream/rust/teal stepped geometry ---- */
  const knitCream = new THREE.MeshLambertMaterial({ color: 0xd7c6a3 });
  const knitRust = new THREE.MeshLambertMaterial({ color: 0x985039 });
  const knitTeal = new THREE.MeshLambertMaterial({ color: 0x416b66 });
  const knitDark = new THREE.MeshLambertMaterial({ color: 0x1c252d });
  ownMats.push(knitCream, knitRust, knitTeal, knitDark);

  const torsoBand = geo(0.435, 0.024, 0.026);
  mesh(rig.torso, torsoBand, knitCream, 0, 0.358, -0.143);
  mesh(rig.torso, torsoBand, knitRust, 0, 0.322, -0.144);
  mesh(rig.torso, torsoBand, knitTeal, 0, 0.154, -0.144);
  mesh(rig.torso, torsoBand, knitCream, 0, 0.118, -0.143);

  // Five compact stepped diamonds form the woven central motif. Alternating
  // rust and teal centers keep it lively without turning rainbow-bright.
  const motifBar = geo(0.044, 0.022, 0.028);
  const motifCap = geo(0.024, 0.02, 0.028);
  const motifCenter = geo(0.018, 0.014, 0.03);
  for (let i = 0; i < 5; i++) {
    const x = -0.17 + i * 0.085;
    const accent = i % 2 === 0 ? knitRust : knitTeal;
    mesh(rig.torso, motifBar, knitCream, x, 0.238, -0.144);
    mesh(rig.torso, motifCap, knitCream, x, 0.267, -0.144);
    mesh(rig.torso, motifCap, knitCream, x, 0.209, -0.144);
    mesh(rig.torso, motifCenter, accent, x, 0.238, -0.16);
  }

  // Pattern wraps ride on the limb pivots, so the sweater stays continuous
  // through every flute grip and lap-to-lips transition. Dark cuffs frame the
  // exposed wrists exactly where the base sleeve ends.
  const upperCream = geo(0.138, 0.036, 0.159);
  const upperAccent = geo(0.138, 0.022, 0.159);
  const foreCream = geo(0.117, 0.03, 0.138);
  const foreAccent = geo(0.117, 0.02, 0.138);
  const cuff = geo(0.119, 0.048, 0.141);
  for (const arm of [rig.armL, rig.armR]) {
    mesh(arm, upperCream, knitCream, 0, -0.105, 0);
    mesh(arm, upperAccent, knitRust, 0, -0.155, 0);
    mesh(arm, upperAccent, knitTeal, 0, -0.195, 0);
  }
  for (const fore of [rig.foreL, rig.foreR]) {
    mesh(fore, foreCream, knitCream, 0, -0.045, 0);
    mesh(fore, foreAccent, knitRust, 0, -0.082, 0);
    mesh(fore, foreAccent, knitTeal, 0, -0.112, 0);
    mesh(fore, cuff, knitDark, 0, -0.148, 0);
  }

  /* ---- round black teashades (distinct from uke's stock bar and the
     handpanist's cat-eyes). Hide the shared rectangular visor, then build two
     circular lenses + a thin bridge and short temples. ---- */
  const stockShades = rig.head.children.find(
    (child) => child instanceof THREE.Mesh && child.material === rig.avatar.materials.visor
  );
  if (stockShades) stockShades.visible = false;
  // MeshBasic so the firefly fill can't lift them to charcoal grey — ink black.
  const shadeFrame = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const shadeLens = new THREE.MeshBasicMaterial({ color: 0x000000 });
  ownMats.push(shadeFrame, shadeLens);
  const lensGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.018, 10);
  const rimGeo = new THREE.CylinderGeometry(0.062, 0.062, 0.014, 10);
  ownGeos.push(lensGeo, rimGeo);
  for (const side of [1, -1] as const) {
    const rim = new THREE.Mesh(rimGeo, shadeFrame);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(side * 0.068, 0.225, -0.148);
    rim.castShadow = true;
    rig.head.add(rim);
    const lens = new THREE.Mesh(lensGeo, shadeLens);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(side * 0.068, 0.225, -0.15);
    rig.head.add(lens);
  }
  mesh(rig.head, geo(0.04, 0.016, 0.016), shadeFrame, 0, 0.228, -0.148); // bridge
  for (const side of [1, -1] as const) {
    const temple = mesh(rig.head, geo(0.02, 0.016, 0.1), shadeFrame, side * 0.125, 0.225, -0.09);
    temple.rotation.y = side * 0.12;
  }

  /* ---- shorter light-brown cut (no hat/hood, no ponytail): crown + short
     fringe above the teashades, cropped sides, short occipital cover ---- */
  const hairMat = rig.avatar.materials.hair;
  const hairLowMat = new THREE.MeshLambertMaterial({ color: 0x7c5228 });
  ownMats.push(hairLowMat);
  // crown cap
  mesh(rig.head, geo(0.3, 0.09, 0.28), hairMat, 0, 0.335, 0.02);
  // short fringe wisps above the shades — clear of the lenses
  const fringeL = mesh(rig.head, geo(0.06, 0.05, 0.04), hairMat, -0.07, 0.312, -0.14);
  fringeL.rotation.z = 0.12;
  mesh(rig.head, geo(0.05, 0.045, 0.038), hairMat, 0.02, 0.316, -0.142);
  const fringeR = mesh(rig.head, geo(0.055, 0.048, 0.04), hairMat, 0.085, 0.314, -0.138);
  fringeR.rotation.z = -0.14;
  // cropped side volume (no long jaw locks / ponytail)
  mesh(rig.head, geo(0.065, 0.14, 0.11), hairMat, -0.16, 0.22, 0.03);
  mesh(rig.head, geo(0.065, 0.15, 0.11), hairLowMat, 0.16, 0.2, 0.03);
  // short back cover — sits on the occiput, no dangling fall
  mesh(rig.head, geo(0.26, 0.14, 0.1), hairMat, 0, 0.24, 0.125);
  mesh(rig.head, geo(0.22, 0.1, 0.08), hairLowMat, 0, 0.16, 0.14);

  /* ---- Native American cedar flute (parented to the head → stays at lips).
     Mouthpiece at the group origin; the reddish-wood body runs along local -Z
     (forward), carved "bird" block + leather tie near the mouth, six burnt
     finger holes down the top, a dark inlaid foot. No metal keys. ---- */
  const cedar = new THREE.MeshLambertMaterial({ color: 0xa54a2a }); // warm redheart cedar
  const cedarDark = new THREE.MeshLambertMaterial({ color: 0x5c2a17 }); // foot / accents
  const holeMat = new THREE.MeshLambertMaterial({ color: 0x1c0f08 }); // burnt tone holes
  const hideMat = new THREE.MeshLambertMaterial({ color: 0xc79a4e }); // buckskin tie
  ownMats.push(cedar, cedarDark, holeMat, hideMat);
  const flute = new THREE.Group();
  flute.name = "busker-flute";
  flute.scale.set(FLUTE_WIDTH_SCALE, FLUTE_WIDTH_SCALE, FLUTE_LENGTH_SCALE);
  flute.userData.bodyRadius = 0.0185 * FLUTE_WIDTH_SCALE;
  rig.head.add(flute);

  const FLEN = 0.5; // full length; mouth at z≈+0.03, foot at z≈-0.47
  // openEnded: mouthpiece + foot cover the ends; closed caps z-fight those faces
  const tubeGeo = new THREE.CylinderGeometry(0.017, 0.0185, FLEN, 12, 1, true);
  ownGeos.push(tubeGeo);
  const tube = new THREE.Mesh(tubeGeo, cedar);
  tube.rotation.x = Math.PI / 2; // cylinder (local Y) → lies along local Z
  tube.position.z = -FLEN / 2 + 0.03; // body extends forward (-Z) from the lips
  tube.castShadow = true;
  flute.add(tube);
  // mouth end cap + a hair-cell "flue" step (the true block sits just below it)
  mesh(flute, geo(0.04, 0.04, 0.03), cedar, 0, 0, 0.03); // mouthpiece plug
  // the carved bird / totem block that defines a NA flute — a small animal
  // fetish lashed on top of the sound hole, a third of the way down
  const bird = new THREE.Group();
  bird.position.set(0, 0.02, -0.075);
  flute.add(bird);
  mesh(bird, geo(0.03, 0.028, 0.075), cedarDark, 0, 0.006, 0); // block body
  mesh(bird, geo(0.028, 0.03, 0.024), cedarDark, 0, 0.026, -0.03); // raised head
  mesh(bird, geo(0.016, 0.012, 0.02), cedarDark, 0, 0.02, -0.052); // beak
  // the two sound holes the block bridges (true window + flue)
  mesh(flute, geo(0.012, 0.006, 0.014), holeMat, 0, 0.016, -0.048); // window
  mesh(flute, geo(0.012, 0.006, 0.012), holeMat, 0, 0.016, -0.104); // flue
  // buckskin lashing that holds the block on, with two hanging tails
  mesh(flute, geo(0.043, 0.044, 0.02), hideMat, 0, 0, -0.052);
  mesh(flute, geo(0.043, 0.044, 0.02), hideMat, 0, 0, -0.1);
  const tie = mesh(flute, geo(0.01, 0.09, 0.006), hideMat, 0.006, -0.06, -0.076); // dangling tail
  tie.rotation.x = 0.2;
  // six burnt finger holes down the playing surface (top of the body)
  const fhGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.01, 8);
  ownGeos.push(fhGeo);
  for (let i = 0; i < 6; i++) {
    const h = new THREE.Mesh(fhGeo, holeMat);
    h.rotation.x = Math.PI / 2;
    h.position.set(0, 0.017, -0.2 - i * 0.045);
    flute.add(h);
  }
  // dark carved foot — sits past the open tube end so faces never coplanar
  mesh(flute, geo(0.041, 0.041, 0.05), cedarDark, 0, 0, -0.455);

  // Named, transform-only contact points. They travel along the tone-hole rows
  // with the damped fingering value, giving QA an exact hand/contact reference.
  const gripAnchorL = new THREE.Group();
  gripAnchorL.name = "flute-grip-L";
  flute.add(gripAnchorL);
  const gripAnchorR = new THREE.Group();
  gripAnchorR.name = "flute-grip-R";
  flute.add(gripAnchorR);

  flute.position.copy(LIP_POS);
  flute.quaternion.copy(LIP_QUAT);

  /* ---- build-time arm stations: lap hold + low/high playing grips ---- */
  const solveTargetL = new THREE.Vector3();
  const solveTargetR = new THREE.Vector3();
  const setGripAnchors = (amount: number) => {
    gripAnchorL.position.set(0, 0, lerp(GRIP_L_LOW_Z, GRIP_L_HIGH_Z, amount));
    gripAnchorR.position.set(0, 0, lerp(GRIP_R_LOW_Z, GRIP_R_HIGH_Z, amount));
  };
  const solveGripPair = (seedL: ArmPose, seedR: ArmPose): [ArmPose, ArmPose] => {
    group.updateWorldMatrix(true, true);
    gripAnchorL.getWorldPosition(solveTargetL);
    gripAnchorR.getWorldPosition(solveTargetR);
    const left = solveArmPose(rig.armL, rig.foreL, rig.handL, solveTargetL, seedL, {
      side: 1,
      elbowClearance: 0.27,
      elbowFront: -0.15,
      regularize: 0.000015
    });
    const right = solveArmPose(rig.armR, rig.foreR, rig.handR, solveTargetR, seedR, {
      side: -1,
      elbowClearance: 0.27,
      elbowFront: -0.15,
      regularize: 0.000015
    });
    return [left, right];
  };

  // Representative raised pose. The live head movement around this station is
  // deliberately small enough that the widened flute stays inside each palm.
  rig.torso.rotation.set(0.12, 0, -0.02);
  rig.head.rotation.set(0.14, 0, 0);
  flute.position.copy(LIP_POS);
  flute.quaternion.copy(LIP_QUAT);
  setGripAnchors(0);
  const [playLowL, playLowR] = solveGripPair(
    [1.45, 0.77, -0.03, 1.46, -0.08, -0.43],
    [1.56, -1.12, 0.08, 1.24, -0.89, 0.41]
  );
  setGripAnchors(1);
  const [playHighL, playHighR] = solveGripPair(playLowL, playLowR);

  // Lap stations use the same named anchors. Cancelling the representative head
  // rotation puts the flute in torso space, matching the runtime lap transform.
  rig.torso.rotation.set(0.07, 0, 0);
  rig.head.rotation.set(-0.07, 0, 0);
  _q1.copy(rig.head.quaternion).invert();
  _v1.copy(LAP_OFFSET).applyQuaternion(_q1);
  _q1.multiply(LAP_QUAT_T);
  flute.position.copy(_v1);
  flute.quaternion.copy(_q1);
  setGripAnchors(0);
  const [lapLowL, lapLowR] = solveGripPair(
    [0.5, 0.12, -0.14, 0.6, -0.15, 0],
    [0.52, -0.12, 0.14, 0.62, 0.15, 0]
  );
  setGripAnchors(1);
  const [lapHighL, lapHighR] = solveGripPair(lapLowL, lapLowR);

  const gripStart = clamp(((part[0]?.midis[0] ?? 69) - GRIP_MIDI_LOW) / (GRIP_MIDI_HIGH - GRIP_MIDI_LOW), 0, 1);
  setGripAnchors(gripStart);
  const lapGoalL = [...lapLowL] as ArmPose;
  const lapGoalR = [...lapLowR] as ArmPose;
  const playGoalL = [...playLowL] as ArmPose;
  const playGoalR = [...playLowR] as ArmPose;
  const armGoalL = [...lapLowL] as ArmPose;
  const armGoalR = [...lapLowR] as ArmPose;
  const armPoseL = [...lapLowL] as ArmPose;
  const armPoseR = [...lapLowR] as ArmPose;
  mixArmPose(armPoseL, lapLowL, lapHighL, gripStart);
  mixArmPose(armPoseR, lapLowR, lapHighR, gripStart);
  applyArmPose(rig.armL, rig.foreL, armPoseL);
  applyArmPose(rig.armR, rig.foreR, armPoseR);

  /* ------------------------------------------------------ animation state */

  let cursor = new NoteCursor(part);
  let t = Math.random() * 20; // ambient time (never resets → no oscillator pops)
  let perform = 0; // 0 = resting, 1 = attentive/performing
  let lift = 0; // 0 = flute in lap, 1 = flute at lips
  let grip = gripStart; // 0(low note, hands down-body)..1(high note, hands up-body)
  let prevNote: NoteEvent | null = null;
  let dipT = 10; // since last phrase start (head-dip envelope)

  /* -------------------------------------------------------------- audio */

  let noiseBuf: AudioBuffer | null = null;
  const activeVoices = new Set<() => void>();

  const schedule = (events: NoteEvent[], atTime: (beat: number) => number) => {
    const ctx = audio.ctx;
    if (!ctx) return;
    if (!noiseBuf) {
      // one shared second of white noise for every breath layer
      noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate), ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    for (const ev of events) {
      const t0 = atTime(ev.beat);
      const durS = ev.dur * SEC_PER_BEAT;
      const end = t0 + durS;
      const stopAt = end + RELEASE + 0.03;
      const peak = SUSTAIN * ev.vel;
      const hz = midiHz(ev.midis[0]);

      // envelope: soft attack → sustain (long notes decrescendo) → long release
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + ATTACK);
      if (ev.dur >= 3) env.gain.linearRampToValueAtTime(peak * 0.4, end);
      else env.gain.setValueAtTime(peak, end);
      env.gain.linearRampToValueAtTime(0, end + RELEASE);
      env.connect(audio.out);
      // wet send → shared mountain reverb (the echo)
      let wet: GainNode | null = null;
      if (audio.reverb) {
        wet = ctx.createGain();
        wet.gain.value = REVERB_SEND;
        env.connect(wet).connect(audio.reverb);
      }

      // partials — all sine: sub-octave for depth, fundamental, a soft octave,
      // and a woody twelfth. The tone is warm and round, never tinny.
      const oscs: OscillatorNode[] = [];
      const partGains: GainNode[] = [];
      const addPartial = (mult: number, gain: number): OscillatorNode => {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = hz * mult;
        oscs.push(o);
        if (gain === 1) {
          o.connect(env);
        } else {
          const g = ctx.createGain();
          g.gain.value = gain;
          o.connect(g).connect(env);
          partGains.push(g);
        }
        return o;
      };
      const oscFund = addPartial(1, 1);
      addPartial(0.5, SUB_GAIN); // sub-octave body
      addPartial(2, OCTAVE_GAIN); // soft octave
      addPartial(3, TWELFTH_GAIN); // woody twelfth

      // woody body: a bandpass-resonant copy of the fundamental adds a hollow
      // wooden formant — the thing that reads as "carved cedar", not "sine"
      const body = ctx.createBiquadFilter();
      body.type = "bandpass";
      body.frequency.value = BODY_HZ;
      body.Q.value = 1.4;
      const bodyG = ctx.createGain();
      bodyG.gain.value = BODY_GAIN;
      oscFund.connect(body).connect(bodyG).connect(env);

      // vibrato into every partial's detune, depth ramping in over VIB_RAMP
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = VIB_HZ;
      const vib = ctx.createGain();
      vib.gain.setValueAtTime(0, t0);
      vib.gain.linearRampToValueAtTime(VIB_CENTS, t0 + VIB_RAMP);
      lfo.connect(vib);
      for (const o of oscs) vib.connect(o.detune);

      // breath layer: warm lowpassed noise under the tone, same envelope
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      noise.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = BREATH_LP_HZ;
      const brG = ctx.createGain();
      brG.gain.value = BREATH_GAIN;
      noise.connect(lp).connect(brG).connect(env);

      const cleanup = () => {
        activeVoices.delete(cleanup);
        oscFund.onended = null;
        for (const o of oscs) {
          try {
            o.stop();
          } catch {
            /* already stopped */
          }
          o.disconnect();
        }
        try {
          lfo.stop();
        } catch {
          /* already stopped */
        }
        try {
          noise.stop();
        } catch {
          /* already stopped */
        }
        for (const g of partGains) g.disconnect();
        body.disconnect();
        bodyG.disconnect();
        lfo.disconnect();
        vib.disconnect();
        noise.disconnect();
        lp.disconnect();
        brG.disconnect();
        env.disconnect();
        wet?.disconnect();
      };
      activeVoices.add(cleanup);
      oscFund.onended = cleanup;
      for (const o of oscs) {
        o.start(t0);
        o.stop(stopAt);
      }
      lfo.start(t0);
      lfo.stop(stopAt);
      noise.start(t0);
      noise.stop(stopAt);
    }
  };

  /* -------------------------------------------------------------- update */

  const update = (dt: number, clock: TrioClock) => {
    t += dt;
    dipT += dt;
    const wind = clock.wind;
    const playing = clock.phase === "playing";

    const cur = cursor.at(clock.beat);
    if (playing && cur.current !== prevNote) {
      if (cur.current) {
        const prevEnd = prevNote ? prevNote.beat + prevNote.dur : -10;
        if (prevNote === null || cur.current.beat - prevEnd > 0.35) dipT = 0; // phrase start
      }
      prevNote = cur.current;
    }
    if (!playing) prevNote = null;

    // ---- the two blend scalars ----
    perform = damp(perform, clock.phase === "rest" ? 0 : 1, PERFORM_LAMBDA, dt);
    // he enters at bar 9: raise the flute one beat before his first onset,
    // keep it up while a note is actually live, and lower it in the long tacet.
    // NoteCursor.current is historical, so it cannot be the raise gate by itself.
    const activeNote =
      playing && cur.current && clock.beat <= cur.current.beat + cur.current.dur + ACTIVE_TAIL_BEATS ? cur.current : null;
    const upcomingNote = playing && cur.next && cur.next.beat - clock.beat < 1.1 ? cur.next : null;
    const raise = activeNote !== null || upcomingNote !== null;
    lift = damp(lift, raise ? 1 : 0, raise ? RAISE_LAMBDA : LOWER_LAMBDA, dt);
    const gripEvent = activeNote ?? upcomingNote;
    if (gripEvent) {
      const gripTarget = clamp((gripEvent.midis[0] - GRIP_MIDI_LOW) / (GRIP_MIDI_HIGH - GRIP_MIDI_LOW), 0, 1);
      grip = damp(grip, gripTarget, GRIP_LAMBDA, dt);
    }
    flute.userData.activeMidi = gripEvent?.midis[0] ?? null;
    const w = perform;
    const l = lift;
    const wl = w * l;

    // ---- musical envelopes (only meaningful while playing) ----
    let support = 0; // long-note lean-in / breath support
    let breathF = 0; // quick chest lift in gaps > 0.4 beat
    if (playing && cur.current) {
      const c = cur.current;
      if (c.dur >= 1.5) {
        const lp = clamp((clock.beat - c.beat) / c.dur, 0, 1);
        support = Math.sin(lp * Math.PI) * c.vel;
      }
      if (cur.next) {
        const ce = c.beat + c.dur;
        if (cur.next.beat - ce > 0.4 && clock.beat >= ce) {
          const p = (clock.beat - ce) / (cur.next.beat - ce);
          breathF = Math.sin(clamp(p * 1.6, 0, 1) * Math.PI); // lift fast, settle in
        }
      }
    }
    const dip = dipT < 0.45 ? Math.sin((dipT / 0.45) * Math.PI) : 0;
    const nod = playing ? 0.03 * Math.sin(Math.PI * clock.beat) * (1 - l) : 0; // ready bars: faint pulse nod

    // ---- legs: dangling over the drop, loose lazy swing ----
    const swing = 1 - 0.35 * wl; // stiller while he's playing
    set(rig.legL, 1.32 + 0.13 * swing * Math.sin(t * 0.83 + 0.4), 0, 0.04);
    set(rig.legR, 1.26 + 0.13 * swing * Math.sin(t * 0.79 + 2.6), 0, -0.04);
    set(rig.shinL, -1.02 + 0.24 * swing * Math.sin(t * 1.07 + 1.1), 0, 0);
    set(rig.shinR, -0.98 + 0.24 * swing * Math.sin(t * 1.13 + 3.4), 0, 0);

    // ---- torso: rest = slow breath + wind sway; playing = phrasing body ----
    const breathe = Math.sin(t * 1.5);
    const restTX = 0.07 + 0.035 * breathe;
    const attTX = lerp(0.09 + nod, 0.12 + 0.05 * support - 0.055 * breathF, l);
    const restTY = 0.05 * Math.sin(t * 0.21);
    const attTY = lerp(-0.06, 0.02 * Math.sin(t * 0.3), l);
    const windSway = wind * Math.sin(t * 0.7) * (1 - 0.6 * wl);
    set(rig.torso, lerp(restTX, attTX, w), lerp(restTY, attTY, w), 0.05 * windSway + 0.015 * breathe * (1 - w) - 0.02 * l);
    rig.hips.position.y = 0.008 * support * wl; // gentle rise under long notes
    set(rig.hips, 0, 0, 0);

    // ---- head: horizon-gazing in rest → glance at the girl → eyes down ----
    const restHX = -0.07 + 0.02 * Math.sin(t * 1.5 + 1);
    const restHY = 0.35 * Math.sin(t * 0.11) + 0.18 * Math.sin(t * 0.043);
    const restHZ = 0.02 * wind * Math.sin(t * 0.9);
    // the handpan girl sits to his LEFT (+X): negative yaw looks at her
    const girlHX = 0.02 + 0.02 * Math.sin(t * 0.5);
    const girlHY = -0.48 + 0.05 * Math.sin(t * 0.47);
    const lipsHX = 0.14 + 0.05 * dip - 0.04 * breathF + 0.015 * support;
    const attHX = lerp(girlHX, lipsHX, l);
    const attHY = lerp(girlHY, 0.02 * Math.sin(t * 0.4), l);
    const attHZ = lerp(0, 0.01 * Math.sin(t * 0.6), l); // centered flute — no lean
    set(rig.head, lerp(restHX, attHX, w) + nod, lerp(restHY, attHY, w), lerp(restHZ, attHZ, w));

    // ---- flute: lap (head-rotation cancelled) ↔ lips (head-glued) ----
    _q1.copy(rig.head.quaternion).invert();
    _v1.copy(LAP_OFFSET).applyQuaternion(_q1); // lap position in head space
    _q1.multiply(LAP_QUAT_T); // lap orientation in head space
    flute.position.copy(_v1).lerp(LIP_POS, l);
    flute.quaternion.copy(_q1).slerp(LIP_QUAT, l);

    // ---- hands: named flute anchors + collision-clear, build-time Pose6
    // stations. Pitch moves each grip a few centimetres along its hole bank;
    // damping replaces the old high-frequency wrist twitch with a real slide. ----
    setGripAnchors(grip);
    mixArmPose(lapGoalL, lapLowL, lapHighL, grip);
    mixArmPose(lapGoalR, lapLowR, lapHighR, grip);
    mixArmPose(playGoalL, playLowL, playHighL, grip);
    mixArmPose(playGoalR, playLowR, playHighR, grip);
    mixArmPose(armGoalL, lapGoalL, playGoalL, l);
    mixArmPose(armGoalR, lapGoalR, playGoalR, l);
    const armLambda = lerp(7.5, 12, l);
    dampArmPose(armPoseL, armGoalL, armLambda, dt);
    dampArmPose(armPoseR, armGoalR, armLambda, dt);
    applyArmPose(rig.armL, rig.foreL, armPoseL);
    applyArmPose(rig.armR, rig.foreR, armPoseR);
    const clasp = lerp(0.72, 0.9, l);
    setRigClasp(rig, "L", clasp);
    setRigClasp(rig, "R", clasp);

    // ---- hair: short fringe drifts a little in the wind ----
    const hairAmp = 0.025 + wind * 0.1;
    fringeL.rotation.z = 0.12 + Math.sin(t * 2.4 + 0.5) * hairAmp * 0.2;
    fringeR.rotation.z = -0.14 + Math.sin(t * 2.2 + 1.8) * hairAmp * 0.2;
  };

  return {
    group,
    update,
    schedule,
    setPart(next) {
      cursor = new NoteCursor(next);
      prevNote = null;
    },
    cutAudio() {
      for (const stop of Array.from(activeVoices)) stop();
      activeVoices.clear();
    },
    dispose() {
      for (const stop of Array.from(activeVoices)) stop();
      activeVoices.clear();
      group.parent?.remove(group);
      for (const g of ownGeos) g.dispose();
      for (const m of ownMats) m.dispose();
      for (const m of Object.values(rig.avatar.materials)) m.dispose();
    }
  };
};
