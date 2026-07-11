import * as THREE from "three/webgpu";
import { buildRig } from "../../player/rig";
import { SEC_PER_BEAT } from "./song";
import { midiHz, NoteCursor } from "./types";
import type { Musician, MusicianBuilder, NoteEvent } from "./types";

/**
 * The ukulele player — the trio's viewer-left seat. A ginger folk dude: full
 * chunky beard framing the jaw, bare-armed warm tee, uke slung low across the
 * chest with the neck cocked jauntily up toward his left. The strum forearm
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

const STRIKE_S = 0.09; // strum strike time (onset → full swing)
const ANTICIPATE_S = 0.14; // pre-strum wind-up window
const GINGER_HAIR = 0xd68c3a;
const GINGER_BEARD = 0xc2762e;

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
  // Ginger folk dude: no hood, short ginger hair, warm coral tee (bare skin
  // sleeves come free with the tee outfit), gold trim.
  const rig = buildRig({ skin: 0, hair: "short", hat: "none", outfit: "tee", color: 1, accent: 3 });
  rig.avatar.materials.hair.color.set(GINGER_HAIR);

  // Seat wrapper: origin = seat point on the deck; rig group rides at hip
  // height so the seat of the pants meets the planks (hip block is 0.22 tall
  // centred at y 0.01 in hip space).
  const group = new THREE.Group();
  rig.group.position.y = 0.11;
  group.add(rig.group);
  rig.hips.rotation.set(0, 0, 0); // never moves again — everything else is per-frame

  // own geometries/materials (rig.ts geometry cache is shared — never touch it)
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
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

  /* ---------------------------------------------------------- animation */
  const cursor = new NoteCursor(part);
  let tLife = 3.7; // own continuous clock (phaseTime resets would pop the sines)
  let perform = 0; // eased playing-intensity: 1 in playing/countin, 0 in rest
  let sNow = 0; // strum scalar: -1 = swung through a down, +1 = through an up
  let sFrom = 0; // latched value at each onset so strikes start where the arm is
  let fret = 0; // eased fret-hand reach along the neck
  let lastEv: NoteEvent | null = null;

  const update = (dt: number, clock: Parameters<Musician["update"]>[1]) => {
    tLife += dt;
    perform = damp(perform, clock.phase === "rest" ? 0 : 1, 3, dt);
    const wind = clock.wind;

    // ---- strum scalar from the part, sample-accurate against clock.beat ----
    const { current, next } = cursor.at(clock.beat);
    if (current !== lastEv) {
      sFrom = sNow; // new onset (or loop reset): strike departs from wherever the arm is
      lastEv = current;
    }
    if (clock.phase === "playing") {
      let sT = 0;
      if (current) {
        const tSince = (clock.beat - current.beat) * SEC_PER_BEAT;
        if (current.tag === "arpeggio") {
          // one slow, luxurious downward roll, then stillness
          if (tSince < 0.5) sT = lerp(sFrom, -1, smoothstep(tSince, 0, 0.5));
          else sT = lerp(-1, -0.35, 1 - Math.exp(-(tSince - 0.5) * 0.8));
        } else if (current.tag === "down" || current.tag === "up") {
          const dir = current.tag === "up" ? 1 : -1;
          if (tSince < STRIKE_S) {
            const f = tSince / STRIKE_S;
            sT = lerp(sFrom, dir, f * f); // accelerating whip through the strings
          } else {
            sT = dir * Math.exp(-(tSince - STRIKE_S) * 6); // relaxed recovery
          }
        }
      }
      if (next && (!current || current.tag !== "arpeggio")) {
        // wind up opposite the coming stroke just before it lands
        const tUntil = (next.beat - clock.beat) * SEC_PER_BEAT;
        const settled = current ? (clock.beat - current.beat) * SEC_PER_BEAT > 0.15 : true;
        if (tUntil < ANTICIPATE_S && settled) {
          const nd = next.tag === "up" ? 1 : -1;
          const w = 1 - tUntil / ANTICIPATE_S;
          sT += -nd * 0.45 * w * w;
        }
      }
      sNow = clamp(sT, -1.3, 1.3);
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

    // fret arm: wraps the neck while playing (deep elbow fold puts the hand at
    // the nut), slides subtly with the chord, micro finger wiggle; rests on
    // the thigh between passes
    const wiggle = perform * (0.03 * Math.sin(tLife * 12.7) + 0.02 * Math.sin(tLife * 8.3));
    rig.armL.rotation.set(
      lerp(0.55, 0.55 - fret * 0.06, perform),
      lerp(0.02, -0.1 - fret * 0.05, perform),
      lerp(0.08, 0.15 + fret * 0.08, perform)
    );
    rig.foreL.rotation.set(lerp(0.32, 2.05 + fret * 0.12, perform), lerp(0, -0.1, perform), wiggle);

    // strum arm: forearm carries the stroke (down = wrist toward -Y/-Z);
    // at rest the hand lies flat on the soundboard
    rig.armR.rotation.set(
      lerp(0.52, 0.56 + sNow * 0.06, perform),
      lerp(0.1, 0.18, perform),
      lerp(0.3, 0.34, perform)
    );
    rig.foreR.rotation.set(lerp(0.66, 0.88 + sNow * 0.42, perform), lerp(-0.1, -0.12, perform), 0);

    // dangling legs over the rock's lip — loose, lazy phase-offset swings,
    // wind-fed, calmer while he plays; the right foot taps the air on the beat
    const legAmp = (0.13 + 0.07 * wind) * (1 - perform * 0.5);
    rig.legL.rotation.set(1.34 + Math.sin(tLife * 0.83) * legAmp, 0, 0.07);
    rig.legR.rotation.set(1.42 + Math.sin(tLife * 0.71 + 2.1) * legAmp, 0, -0.06);
    rig.shinL.rotation.set(-1.26 + Math.sin(tLife * 1.07 + 0.9) * legAmp * 1.8, 0, 0);
    rig.shinR.rotation.set(-1.33 + Math.sin(tLife * 0.93 + 3.4) * legAmp * 1.8 + perform * 0.05 * tap, 0, 0);

    // the uke itself: jaunty across the chest, dips with hard down-strums,
    // droops when he stops playing
    ukeSway.rotation.z = 0.6 - (1 - perform) * 0.3 + sNow * 0.03 * perform;
  };

  /* -------------------------------------------------------------- audio */
  const live = new Set<() => void>();

  return {
    group,
    update,
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
