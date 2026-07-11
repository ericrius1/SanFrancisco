import * as THREE from "three/webgpu";
import { buildRig, setRigClasp } from "../../player/rig";
import { applyArmPose, mixArmPose, solveArmPose, type ArmPose } from "./armIk";
import { SEC_PER_BEAT } from "./song";
import { midiHz, NoteCursor } from "./types";
import type { Musician, MusicianBuilder, NoteEvent } from "./types";

/**
 * The ukulele player — the trio's viewer-left seat. A ginger folk dude: full
 * chunky beard framing the jaw, moss-green trail fleece, uke slung low across
 * the chest with the neck cocked jauntily up toward his left. The strum forearm
 * swings sample-accurately with the score's "down"/"up" tags (winding up a
 * touch just before each stroke lands), the fret hand slides along the neck
 * when the chord changes, his head nods on the beat and one dangling foot
 * taps along. Between passes the strum hand comes to rest flat on the
 * soundboard, the fret hand drops to his thigh, the neck droops, and he
 * breathes with the wind — with an occasional slow glance at the handpan
 * girl beside him (she's seated toward his right, local -X).
 *
 * Synth: plucked nylon — per string, two ±4-cent triangles through a closing
 * lowpass plus a whisper of 600 Hz body resonance, 3 ms attack, exponential
 * die-away. One self-cleaning voice per string, staggered per strum order.
 */

const { damp, lerp, clamp, smoothstep } = THREE.MathUtils;

const WINDUP_S = 0.17;
const STROKE_HALF_S = 0.085; // centre/string contact lands exactly on the note onset
const RECOVER_S = 0.14;
const ARPEGGIO_SWEEP_S = 0.3;
const GINGER_HAIR = 0xd68c3a;
const GINGER_BEARD = 0xc2762e;

function smootherstep01(value: number): number {
  const x = clamp(value, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function sampleArmStations(stations: ArmPose[], amount: number, out: ArmPose): ArmPose {
  const u = clamp(amount, 0, 1) * (stations.length - 1);
  const i1 = Math.min(stations.length - 2, Math.floor(u));
  const t = u - i1;
  const p0 = stations[Math.max(0, i1 - 1)];
  const p1 = stations[i1];
  const p2 = stations[Math.min(stations.length - 1, i1 + 1)];
  const p3 = stations[Math.min(stations.length - 1, i1 + 2)];
  const t2 = t * t;
  const t3 = t2 * t;
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  }
  return out;
}

/** Chord "reach" 0..1 along the neck, derived from the event's pitch span so
 * each of the song's four chords (Dm/Bb/F/C) gets its own fret-hand spot. */
function chordReach(ev: NoteEvent): number {
  let lo = 127;
  let hi = 0;
  for (let i = 0; i < ev.midis.length; i++) {
    const m = ev.midis[i];
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  return clamp((hi - lo - 7) / 5, 0, 1);
}

/** One plucked nylon string: 2 detuned triangles → closing lowpass (with a
 * low-mixed 600 Hz bandpass "body" in parallel) → envelope gain. Sources get
 * stop() times and the voice disconnects itself onended. */
function pluck(
  ctx: AudioContext,
  out: GainNode,
  midi: number,
  when: number,
  peak: number,
  decay: number,
  live: Set<() => void>
) {
  const t0 = Math.max(when, ctx.currentTime + 0.001);
  const hz = midiHz(midi);
  const o1 = ctx.createOscillator();
  o1.type = "triangle";
  o1.frequency.value = hz;
  o1.detune.value = 4;
  const o2 = ctx.createOscillator();
  o2.type = "triangle";
  o2.frequency.value = hz;
  o2.detune.value = -4;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 0.7;
  lp.frequency.setValueAtTime(2800, t0);
  lp.frequency.exponentialRampToValueAtTime(900, t0 + 0.5);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 600;
  bp.Q.value = 3.5;
  const body = ctx.createGain();
  body.gain.value = 0.18;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(Math.max(peak, 0.001), t0 + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0004, t0 + decay);
  o1.connect(lp);
  o2.connect(lp);
  lp.connect(g);
  o1.connect(bp);
  o2.connect(bp);
  bp.connect(body);
  body.connect(g);
  g.connect(out);
  const end = t0 + decay + 0.05;
  o1.start(t0);
  o2.start(t0);
  o1.stop(end);
  o2.stop(end);
  const cleanup = () => {
    live.delete(cleanup);
    try {
      o1.stop();
    } catch {
      /* already stopped */
    }
    try {
      o2.stop();
    } catch {
      /* already stopped */
    }
    o1.disconnect();
    o2.disconnect();
    lp.disconnect();
    bp.disconnect();
    body.disconnect();
    g.disconnect();
  };
  live.add(cleanup);
  o1.onended = cleanup;
}

export const buildUkulelist: MusicianBuilder = (audio, part): Musician => {
  /* ------------------------------------------------------------- figure */
  // Ginger folk dude in a mossy trail fleece: the jacket rig supplies cloth
  // all the way to each wrist; its stock city pack/zip details are replaced
  // below by a high collar, quarter zip, shoulder yoke and chest-pocket tab.
  const rig = buildRig({ skin: 0, hair: "short", hat: "none", outfit: "jacket", color: 5, accent: 1 });
  rig.avatar.materials.hair.color.set(GINGER_HAIR);
  rig.avatar.materials.jacket.color.set(0x3d4b35);
  rig.avatar.materials.sleeve.color.set(0x35422f);
  rig.avatar.materials.shirt.color.set(0xb9633d);
  for (const detail of rig.avatar.outfits.jacket) detail.visible = false;
  rig.avatar.torsoBlock.scale.set(1.025, 1.015, 1.025);
  for (const sleeve of rig.avatar.armBlocks) sleeve.scale.set(1.045, 1, 1.045);

  // Seat wrapper: origin = seat point on the deck; rig group rides at hip
  // height so the seat of the pants meets the planks (hip block is 0.22 tall
  // centred at y 0.01 in hip space).
  const group = new THREE.Group();
  group.name = "busker-ukulelist";
  rig.group.position.y = 0.11;
  group.add(rig.group);
  rig.hips.rotation.set(0, 0, 0); // never moves again — everything else is per-frame

  // own geometries/materials (rig.ts geometry cache is shared — never touch it)
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  // MeshBasic so the firefly fill can't lift the bar shades to charcoal grey.
  const blackShades = new THREE.MeshBasicMaterial({ color: 0x000000 });
  mats.push(blackShades);
  const stockShades = rig.head.children.find(
    (child) => child instanceof THREE.Mesh && child.material === rig.avatar.materials.visor
  );
  if (stockShades instanceof THREE.Mesh) stockShades.material = blackShades;
  const own = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };
  const mat = (color: number): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial({ color });
    mats.push(m);
    return m;
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
    const m = new THREE.Mesh(own(new THREE.BoxGeometry(w, h, d)), material);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  /* ---- trail fleece: raised collar, darker shoulder yoke + rust hardware ---- */
  const fleeceYoke = mat(0x46563c);
  const fleeceRust = mat(0xb9633d);
  box(rig.torso, fleeceYoke, 0.29, 0.09, 0.2, 0, 0.445, -0.02); // soft funnel collar
  box(rig.torso, fleeceYoke, 0.445, 0.085, 0.025, 0, 0.382, -0.143); // reinforced shoulder yoke
  box(rig.torso, fleeceRust, 0.026, 0.15, 0.035, 0, 0.337, -0.151); // quarter zip / placket
  box(rig.torso, fleeceRust, 0.09, 0.022, 0.035, -0.135, 0.263, -0.151); // chest-pocket tab

  // stock short hair is only a flat top lid — add a little length over the
  // back of the head so it doesn't end in a hard scalp cliff from behind
  const hairMat = rig.avatar.materials.hair;
  box(rig.head, hairMat, 0.27, 0.12, 0.1, 0, 0.26, 0.12);
  box(rig.head, hairMat, 0.24, 0.09, 0.08, 0, 0.19, 0.14);

  // full ginger beard — chunky boxes framing jaw and chin over the face front
  // (face is -Z; head block is a 0.26 cube centred at head-local y 0.2)
  const beardMat = mat(GINGER_BEARD);
  box(rig.head, beardMat, 0.2, 0.11, 0.05, 0, 0.075, -0.13); // chin slab, hangs below the jaw
  box(rig.head, beardMat, 0.05, 0.13, 0.18, -0.125, 0.11, -0.035); // jaw frame L
  box(rig.head, beardMat, 0.05, 0.13, 0.18, 0.125, 0.11, -0.035); // jaw frame R

  /* ------------------------------------------------------------ ukulele */
  // Built in its own frame (+X up the neck toward HIS left, +Y = soundboard
  // normal), then tipped so the board faces out (-Z) inside a sway holder
  // that carries the jaunty roll + rest droop.
  const wood = mat(0xb07a3f);
  const woodDark = mat(0x6e4a26);
  const holeMat = mat(0x241708);
  const stringMat = mat(0xe9e2cf);

  const uke = new THREE.Group();
  uke.name = "busker-ukulele";
  uke.rotation.x = -Math.PI / 2 + 0.14; // soundboard out toward -Z, tipped up a touch
  box(uke, wood, 0.26, 0.09, 0.2, 0, 0, 0); // body
  const hole = new THREE.Mesh(own(new THREE.CylinderGeometry(0.048, 0.048, 0.012, 12)), holeMat);
  hole.position.set(0.035, 0.048, 0);
  hole.castShadow = true;
  uke.add(hole);
  box(uke, woodDark, 0.022, 0.018, 0.1, -0.085, 0.052, 0); // bridge
  box(uke, woodDark, 0.3, 0.035, 0.05, 0.275, 0.028, 0); // neck rising +X
  box(uke, woodDark, 0.07, 0.03, 0.065, 0.455, 0.035, 0); // headstock
  const strGeo = own(new THREE.BoxGeometry(0.51, 0.004, 0.004));
  for (const z of [-0.02, -0.007, 0.007, 0.02]) {
    const s = new THREE.Mesh(strGeo, stringMat);
    s.position.set(0.17, 0.058, z); // bridge → over the hole → up the neck
    s.castShadow = true;
    uke.add(s);
  }
  const ukeSway = new THREE.Group();
  ukeSway.position.set(-0.04, 0.09, -0.205); // low on the chest/belly
  ukeSway.add(uke);
  rig.torso.add(ukeSway);

  // QA-visible contacts ride in instrument space. The hand stations below are
  // solved against these exact paths, so the stroke crosses the strings instead
  // of pumping toward/away from the player's chest.
  const strumContact = new THREE.Object3D();
  strumContact.name = "ukulele-strum-contact";
  strumContact.position.set(0.02, 0.105, 0);
  uke.add(strumContact);
  const fretContact = new THREE.Object3D();
  fretContact.name = "ukulele-fret-contact";
  fretContact.position.set(0.27, 0.07, 0);
  uke.add(fretContact);

  /* --------------------------------------------------- build-time hand stations */
  // Right hand: five samples across the rolled soundboard. A Catmull-Rom sample
  // of these stations gives a continuous, curved arm path at runtime.
  const strumPoses: ArmPose[] = [];
  let strumSeed: ArmPose = [0.85, -0.05, -0.115, 0.12, 0, 1.3];
  for (const z of [-0.055, -0.0275, 0, 0.0275, 0.055]) {
    strumContact.position.z = z;
    uke.updateWorldMatrix(true, true);
    const target = strumContact.getWorldPosition(new THREE.Vector3());
    strumSeed = solveArmPose(rig.armR, rig.foreR, rig.handR, target, strumSeed, {
      side: -1,
      elbowClearance: 0.245,
      elbowFront: -0.15
    });
    strumPoses.push(strumSeed);
  }

  // Left hand: chord changes travel a short, readable distance along the neck.
  const fretPoses: ArmPose[] = [];
  let fretSeed: ArmPose = [0.58, -0.08, 0.2, 1.95, -0.08, -0.22];
  for (const x of [0.25, 0.295, 0.34, 0.385]) {
    fretContact.position.x = x;
    uke.updateWorldMatrix(true, true);
    const target = fretContact.getWorldPosition(new THREE.Vector3());
    fretSeed = solveArmPose(rig.armL, rig.foreL, rig.handL, target, fretSeed, {
      side: 1,
      elbowClearance: 0.235,
      elbowFront: -0.14
    });
    fretPoses.push(fretSeed);
  }
  strumContact.position.set(0.02, 0.105, 0);
  fretContact.position.set(0.27, 0.07, 0);

  const strumSample = strumPoses[2].slice() as ArmPose;
  const strumPose = strumPoses[2].slice() as ArmPose;
  const fretSample = fretPoses[0].slice() as ArmPose;
  const fretPose = fretPoses[0].slice() as ArmPose;
  const fretRest: ArmPose = [0.55, 0.02, 0.12, 0.32, 0, 0];

  /* ---------------------------------------------------------- animation */
  let cursor = new NoteCursor(part);
  let tLife = 3.7; // own continuous clock (phaseTime resets would pop the sines)
  let perform = 0; // eased playing-intensity: 1 in playing/countin, 0 in rest
  let sNow = 0; // -1..1 across the soundboard; down/up strokes traverse opposite ways
  let fret = 0; // eased fret-hand reach along the neck

  const update = (dt: number, clock: Parameters<Musician["update"]>[1]) => {
    tLife += dt;
    perform = damp(perform, clock.phase === "rest" ? 0 : 1, 3, dt);
    const wind = clock.wind;

    // ---- onset-centred strum path from the authored part ----
    // The old stroke began at the audio onset, accelerated with f², then jumped
    // straight into exponential recovery. This C1/C2 path winds up beforehand,
    // crosses the middle pair of strings exactly at onset, and eases out without
    // a velocity discontinuity.
    const { current, next } = cursor.at(clock.beat);
    if (clock.phase === "playing") {
      let sT = 0;
      if (next) {
        const tUntil = (next.beat - clock.beat) * SEC_PER_BEAT;
        if (tUntil <= WINDUP_S) {
          const dir = next.tag === "up" ? -1 : 1;
          if (tUntil > STROKE_HALF_S) {
            const windup = (WINDUP_S - tUntil) / (WINDUP_S - STROKE_HALF_S);
            sT = -dir * smootherstep01(windup);
          } else {
            sT = dir * Math.sin((-tUntil / STROKE_HALF_S) * (Math.PI / 2));
          }
        }
      }
      if (current) {
        const tSince = (clock.beat - current.beat) * SEC_PER_BEAT;
        const dir = current.tag === "up" ? -1 : 1;
        if (current.tag === "arpeggio") {
          if (tSince <= ARPEGGIO_SWEEP_S) sT = lerp(-1, 1, smootherstep01(tSince / ARPEGGIO_SWEEP_S));
          else if (tSince <= ARPEGGIO_SWEEP_S + RECOVER_S) sT = 1 - smootherstep01((tSince - ARPEGGIO_SWEEP_S) / RECOVER_S);
        } else if (tSince <= STROKE_HALF_S) {
          sT = dir * Math.sin((tSince / STROKE_HALF_S) * (Math.PI / 2));
        } else if (tSince <= STROKE_HALF_S + RECOVER_S) {
          sT = dir * (1 - smootherstep01((tSince - STROKE_HALF_S) / RECOVER_S));
        }
      }
      sNow = clamp(sT, -1, 1);
    } else {
      sNow = damp(sNow, 0, 4, dt); // countin/rest: hand drifts to a neutral hover
    }

    // ---- fret hand slides ahead of the chord change ----
    const chordEv = next && (next.beat - clock.beat) * SEC_PER_BEAT < 0.35 ? next : current;
    if (chordEv && chordEv.midis.length > 2) fret = damp(fret, chordReach(chordEv), 10, dt);

    // ---- shared life signals ----
    const beatPos = clock.phase === "countin" ? clock.phaseTime / SEC_PER_BEAT : clock.beat;
    const frac = beatPos - Math.floor(beatPos);
    const bobW = clock.phase === "countin" ? Math.min(1, beatPos) : 1;
    const bob = Math.cos(frac * Math.PI * 2) * bobW; // peaks on integer beats
    const tap = Math.max(0, bob) * Math.max(0, bob);
    const breathe = Math.sin(tLife * 1.55) * (0.7 + 0.6 * wind);
    const swayR = Math.sin(tLife * 0.9) * wind;
    const swayY = Math.sin(tLife * 0.63 + 1.7) * wind;

    // rest gaze: enjoy the view, occasionally turn (slow, eased) toward the
    // handpan girl — she sits toward his right, i.e. positive head yaw
    const gRaw = Math.sin(clock.phaseTime * 0.45 + 0.8);
    const glance = clock.phase === "rest" ? smoothstep(gRaw, 0.86, 0.99) : 0;
    const restLookY = lerp(0.18 * Math.sin(tLife * 0.27) - 0.06, 0.78, glance);
    const restLookX = lerp(-0.11 + 0.03 * Math.sin(tLife * 0.4 + 0.9), -0.02, glance);

    // ---- pose (overwrite every joint; play/rest targets lerped by perform) ----
    rig.torso.rotation.set(
      lerp(0.04 + breathe * 0.02, 0.1 + breathe * 0.012 + sNow * 0.012, perform),
      lerp(swayY * 0.09, swayY * 0.05 + 0.03 * Math.sin(beatPos * (Math.PI / 8)), perform),
      lerp(swayR * 0.07, swayR * 0.03 + sNow * 0.008, perform)
    );
    rig.head.rotation.set(
      lerp(restLookX + breathe * 0.012, -0.04 + bob * 0.05 + breathe * 0.008, perform),
      lerp(restLookY, swayY * 0.04 + 0.1 * Math.sin(tLife * 0.21), perform),
      lerp(swayR * 0.03, sNow * 0.01, perform)
    );

    // Both hands follow solved instrument-space stations. The fret elbow stays
    // outside the body while the forearm folds to the neck; the right hand runs
    // directly across the soundboard instead of vertically pumping at the elbow.
    sampleArmStations(fretPoses, fret, fretSample);
    mixArmPose(fretPose, fretRest, fretSample, perform);
    applyArmPose(rig.armL, rig.foreL, fretPose);
    sampleArmStations(strumPoses, (sNow + 1) * 0.5, strumSample);
    mixArmPose(strumPose, strumPoses[2], strumSample, perform);
    applyArmPose(rig.armR, rig.foreR, strumPose);
    setRigClasp(rig, "L", 0.25 + 0.62 * perform);
    setRigClasp(rig, "R", 0.18 + 0.18 * perform);
    strumContact.position.z = sNow * 0.055;
    fretContact.position.x = lerp(0.25, 0.385, fret);

    // dangling legs over the rock's lip — loose, lazy phase-offset swings,
    // wind-fed, calmer while he plays; the right foot taps the air on the beat
    const legAmp = (0.13 + 0.07 * wind) * (1 - perform * 0.5);
    rig.legL.rotation.set(1.28 + Math.sin(tLife * 0.83) * legAmp, 0, 0.07);
    rig.legR.rotation.set(1.36 + Math.sin(tLife * 0.71 + 2.1) * legAmp, 0, -0.06);
    rig.shinL.rotation.set(-1.0 + Math.sin(tLife * 1.07 + 0.9) * legAmp * 1.8, 0, 0);
    rig.shinR.rotation.set(-1.07 + Math.sin(tLife * 0.93 + 3.4) * legAmp * 1.8 + perform * 0.05 * tap, 0, 0);

    // the uke itself: jaunty across the chest, dips with hard down-strums,
    // droops when he stops playing
    ukeSway.rotation.z = 0.6 - (1 - perform) * 0.3 + sNow * 0.008 * perform;
  };

  /* -------------------------------------------------------------- audio */
  const live = new Set<() => void>();

  return {
    group,
    update,
    setPart(next) {
      cursor = new NoteCursor(next);
    },
    schedule(events, atTime) {
      const { ctx, out } = audio;
      for (const ev of events) {
        const base = atTime(ev.beat);
        const stagger = ev.tag === "arpeggio" ? 0.07 : 0.014;
        const decay = ev.tag === "arpeggio" ? 2.5 : 0.9;
        const peak = 0.1 * ev.vel * (ev.tag === "up" ? 0.93 : 1); // up-strums a hair quieter
        for (let i = 0; i < ev.midis.length; i++) {
          pluck(ctx, out, ev.midis[i], base + i * stagger, peak, decay, live);
        }
      }
    },
    cutAudio() {
      for (const cleanup of [...live]) cleanup();
      live.clear();
    },
    dispose() {
      for (const cleanup of [...live]) cleanup();
      live.clear();
      group.parent?.remove(group);
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      for (const m of Object.values(rig.avatar.materials)) m.dispose();
    }
  };
};
