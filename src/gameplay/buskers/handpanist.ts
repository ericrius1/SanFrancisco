import * as THREE from "three/webgpu";
import { buildRig } from "../../player/rig";
import { SEC_PER_BEAT } from "./song";
import { midiHz, NoteCursor } from "./types";
import type { MusicianBuilder, NoteEvent, TrioClock } from "./types";

/**
 * The handpan girl — centre seat, leader of the trio. Long auburn hair that
 * sways in the wind, a thin gold headband, bare arms, and the classic bronze
 * UFO lens resting on her lap over the dangling legs. She opens the song and
 * counts the loop back in with four clear nods.
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

// arm IK solver clamps: [armX, armY, armZ, foreX]
const P_MIN = [-0.6, -1.1, -1.5, 0.06] as const;
const P_MAX = [2.1, 1.1, 1.5, 2.5] as const;

type Pose4 = [number, number, number, number];

const _v = new THREE.Vector3();
const damp = THREE.MathUtils.damp;

/* ---------------------------------------------------- build-time arm IK */

/** Coordinate-descent solve of (armX, armY, armZ, foreX) so the hand marker
 * lands on `target` (musician-group space; the group is unparented at build
 * time, so world == group-local). Runs only at build — never per frame. */
function solveArm(arm: THREE.Group, fore: THREE.Group, marker: THREE.Object3D, target: THREE.Vector3, seed: Pose4): Pose4 {
  const p: Pose4 = [
    THREE.MathUtils.clamp(seed[0], P_MIN[0], P_MAX[0]),
    THREE.MathUtils.clamp(seed[1], P_MIN[1], P_MAX[1]),
    THREE.MathUtils.clamp(seed[2], P_MIN[2], P_MAX[2]),
    THREE.MathUtils.clamp(seed[3], P_MIN[3], P_MAX[3])
  ];
  const evalErr = () => {
    arm.rotation.set(p[0], p[1], p[2]);
    fore.rotation.set(p[3], 0, 0);
    marker.getWorldPosition(_v); // updates the ancestor chain itself
    return _v.distanceToSquared(target);
  };
  let best = evalErr();
  let step = 0.55;
  let evals = 0;
  while (step > 0.006 && evals < 700) {
    let improved = false;
    for (let i = 0; i < 4; i++) {
      const orig = p[i];
      for (let dir = 1; dir >= -1; dir -= 2) {
        const cand = THREE.MathUtils.clamp(orig + dir * step, P_MIN[i], P_MAX[i]);
        if (cand === orig) continue;
        p[i] = cand;
        evals++;
        const err = evalErr();
        if (err < best - 1e-10) {
          best = err;
          improved = true;
          break;
        }
        p[i] = orig;
      }
    }
    if (!improved) step *= 0.62;
  }
  return p;
}

/* ----------------------------------------------------------- the builder */

export const buildHandpanist: MusicianBuilder = (audio, part) => {
  const group = new THREE.Group();
  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];

  // ---- figure: warm rose tee, long auburn hair, no hat, bare arms
  const rig = buildRig({ skin: 5, hair: "long", hat: "none", outfit: "tee", color: 6, accent: 3 });
  rig.avatar.materials.pants.color.set(0x463844); // warm mauve over default denim
  rig.group.position.y = SEAT_RIG_Y;
  group.add(rig.group);

  // a normal medium-long hair fall down the back — one soft sheet of three
  // overlapping slats, pivoted at the nape BEHIND the head so it always hangs
  // clear of the face, arms and torso, and sways as one in the wind.
  const hairMat = rig.avatar.materials.hair;
  const slatGeo = new THREE.BoxGeometry(0.11, 0.32, 0.05);
  ownedGeos.push(slatGeo);
  const hairFall = new THREE.Group();
  hairFall.position.set(0, 0.05, 0.14); // nape, at the back of the head block
  rig.head.add(hairFall);
  const slats: THREE.Mesh[] = [];
  const slatBaseZ: number[] = [];
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(slatGeo, hairMat);
    s.position.set((i - 1) * 0.075, -0.15, 0.006 + Math.abs(i - 1) * 0.008);
    const baseZ = (i - 1) * 0.13; // gentle outward fan
    s.rotation.z = baseZ;
    s.castShadow = true;
    hairFall.add(s);
    slats.push(s);
    slatBaseZ.push(baseZ);
  }
  // thin gold trim headband across the hairline
  const bandGeo = new THREE.BoxGeometry(0.272, 0.03, 0.272);
  ownedGeos.push(bandGeo);
  const band = new THREE.Mesh(bandGeo, rig.avatar.materials.trim);
  band.position.set(0, 0.285, 0);
  band.castShadow = true;
  rig.head.add(band);

  // ---- the handpan: parented to the GROUP (not a limb) so it never bobs
  const shellMat = new THREE.MeshLambertMaterial({ color: 0x8a5a33 });
  const domeMat = new THREE.MeshLambertMaterial({ color: 0x9a6a3e });
  const dimpleMat = new THREE.MeshLambertMaterial({ color: 0x6e4526 });
  const seamMat = new THREE.MeshLambertMaterial({ color: 0x50331c });
  ownedMats.push(shellMat, domeMat, dimpleMat, seamMat);

  const pan = new THREE.Group();
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
    { arm: rig.armL, fore: rig.foreL, marker: markL, seed: [0.85, 0.1, -0.3, 1.15] as Pose4 },
    { arm: rig.armR, fore: rig.foreR, marker: markR, seed: [0.85, -0.1, 0.3, 1.15] as Pose4 }
  ];
  const strike: Pose4[][] = [[], []];
  const hover: Pose4[][] = [[], []];
  const readyPose: Pose4[] = [];
  const restPose: Pose4[] = [];
  rig.hips.rotation.set(0, 0, 0);
  for (let h = 0; h < 2; h++) {
    const H = handRigs[h];
    rig.torso.rotation.set(PLAY_LEAN, 0, 0); // playing stations solved at play lean
    for (let j = 0; j < 8; j++) {
      const s = solveArm(H.arm, H.fore, H.marker, strikePts[j], H.seed);
      strike[h].push(s);
      hover[h].push(solveArm(H.arm, H.fore, H.marker, hoverPts[j], s)); // seeded nearby → same elbow branch
    }
    readyPose.push(solveArm(H.arm, H.fore, H.marker, readyPts[h], H.seed));
    rig.torso.rotation.set(REST_LEAN, 0, 0); // palms park on the drum at rest lean
    restPose.push(solveArm(H.arm, H.fore, H.marker, restPts[h], readyPose[h]));
  }

  // ---- per-event choreography: pitch → dimple, hand alternation (dings → R)
  const distinct = Array.from(new Set(part.map((e) => e.midis[0]))).sort((a, b) => a - b);
  const dimpleOf = new Map<number, number>();
  distinct.forEach((m, i) => dimpleOf.set(m, i % 7));
  const animOf = new Map<NoteEvent, { hand: number; target: number }>();
  let lastHand = 0;
  for (const e of part) {
    const ding = e.tag === "ding";
    const hand = ding ? 1 : lastHand === 1 ? 0 : 1;
    lastHand = hand;
    animOf.set(e, { hand, target: ding ? 7 : (dimpleOf.get(e.midis[0]) ?? 0) });
  }

  // ---- runtime state (module-temp reuse only; zero per-frame allocations)
  const cursor = new NoteCursor(part);
  const handPose: Pose4[] = [restPose[0].slice() as Pose4, restPose[1].slice() as Pose4];
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
    handRigs[h].arm.rotation.set(handPose[h][0], handPose[h][1], handPose[h][2]);
    handRigs[h].fore.rotation.set(handPose[h][3], 0, 0);
  }
  rig.legL.rotation.set(1.36, 0, 0.04);
  rig.legR.rotation.set(1.31, 0, -0.04);
  rig.shinL.rotation.x = -1.27;
  rig.shinR.rotation.x = -1.23;

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
      let tgt: Pose4 = readyPose[h];
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
      for (let i = 0; i < 4; i++) {
        const goal = rest[i] + (tgt[i] - rest[i]) * p; // rest ↔ perform blend, no pops
        pose[i] = damp(pose[i], goal, lamF, dt);
      }
      const H = handRigs[h];
      const bob = (1 - p) * 0.02 * Math.sin(t * 1.05 + h * 2.5) + p * 0.012 * Math.sin(t * 2.3 + h * 2.9);
      H.arm.rotation.set(pose[0] + bob, pose[1], pose[2]);
      H.fore.rotation.set(pose[3], 0, 0);
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
    rig.legL.rotation.x = 1.36 + Math.sin(t * 0.83) * swing;
    rig.legR.rotation.x = 1.31 + Math.sin(t * 0.83 + 2.4) * swing;
    rig.shinL.rotation.x = -1.27 + Math.sin(t * 0.83 - 0.9) * swing * 1.8;
    rig.shinR.rotation.x = -1.23 + Math.sin(t * 0.83 + 1.5) * swing * 1.8;

    // ---- hair in the wind: the whole fall sways as one, with a little
    // per-slat lag so it reads as soft strands, never a rigid board
    const hairAmp = 0.05 + wind * 0.24;
    hairFall.rotation.x = 0.05 + Math.sin(t * 1.5 + 0.3) * hairAmp * 0.5; // drift back & forth
    hairFall.rotation.z = Math.sin(t * 1.9 + 1.1) * hairAmp; // side-to-side sway
    hairFall.rotation.y = Math.sin(t * 1.15) * hairAmp * 0.4; // gentle twist
    for (let i = 0; i < slats.length; i++) {
      slats[i].rotation.z = slatBaseZ[i] + Math.sin(t * 2.2 + i * 1.3) * hairAmp * 0.5;
    }
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
    dispose() {
      group.parent?.remove(group);
      for (const g of ownedGeos) g.dispose(); // pan + strands + band only —
      for (const m of ownedMats) m.dispose(); // never the rig's shared cache
    }
  };
};
