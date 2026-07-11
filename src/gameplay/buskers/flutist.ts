import * as THREE from "three/webgpu";
import { buildRig } from "../../player/rig";
import { SEC_PER_BEAT } from "./song";
import { midiHz, NoteCursor, type MusicianBuilder, type NoteEvent, type TrioClock } from "./types";

/**
 * The flutist — viewer's RIGHT seat. Hood up, eyes down, lost in it.
 *
 * A graphite-hoodied figure (the only hooded one of the trio) with a raised
 * hood built from boxes parented to the head, a transverse silver flute held
 * to his lips, and legs dangling over the deck edge. His part (SONG.flute)
 * doesn't enter until bar 9: through the handpan/uke intro he sits with the
 * flute low across his lap, nodding faintly with the pulse, then raises it
 * to his mouth in one smooth motion a beat before his first note.
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

// flute at the lips, in head-local space (mouth ≈ (0, 0.13, -0.16); tube
// runs to HIS right (-X) with a slight backward (+y rot) and downward
// (+z rot) rake — classic transverse posture)
const LIP_POS = new THREE.Vector3(0.005, 0.122, -0.168);
const LIP_QUAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.04, 0.16, 0.11));
// flute resting across the lap, in TORSO space (head origin sits at torso
// (0, 0.46, 0); lap point ≈ torso (0, -0.08, -0.26))
const LAP_OFFSET = new THREE.Vector3(0, -0.54, -0.26);
const LAP_QUAT_T = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, 0.3, 0.05));

const RAISE_LAMBDA = 4.5; // lift → lips (one smooth ~0.7 s motion)
const LOWER_LAMBDA = 2.0; // lips → lap (deliberate, unhurried)
const PERFORM_LAMBDA = 3.0;

// synth (airy flute, sits on top of the mix)
const ATTACK = 0.07;
const RELEASE = 0.15;
const SUSTAIN = 0.13; // * vel
const OCTAVE_GAIN = 0.1;
const BREATH_GAIN = 0.08;
const BREATH_LP_HZ = 2200;
const VIB_HZ = 5.2;
const VIB_CENTS = 8;
const VIB_RAMP = 0.3;

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
  // graphite hoodie / teal accent, hood built by hand below (hat "none" so
  // a coppery fringe peeks out under the hood shell)
  const rig = buildRig({ skin: 2, hair: "short", hat: "none", outfit: "hoodie", color: 5, accent: 7 });
  rig.group.position.y = 0.11; // seat of the pants on the deck top
  const group = new THREE.Group();
  group.add(rig.group);

  // the hoodie outfit ships a hood-down bump on the back of the neck; his
  // hood is UP, so hide it (first mesh pushed to outfits.hoodie in rig.ts)
  rig.avatar.outfits.hoodie[0].visible = false;

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

  /* ---- raised hood (children of rig.head so it turns with him) ---- */
  const hoodMat = rig.avatar.materials.jacket.clone();
  hoodMat.color.multiplyScalar(0.82); // a shade darker than the hoodie
  ownMats.push(hoodMat);
  const cheekGeo = geo(0.05, 0.28, 0.32);
  const hoodBack = mesh(rig.head, geo(0.36, 0.32, 0.1), hoodMat, 0, 0.2, 0.15);
  const hoodTop = mesh(rig.head, geo(0.36, 0.1, 0.36), hoodMat, 0, 0.4, 0.0);
  const hoodBrow = mesh(rig.head, geo(0.3, 0.05, 0.06), hoodMat, 0, 0.365, -0.17); // peak shading the eyes
  const hoodCheekL = mesh(rig.head, cheekGeo, hoodMat, 0.155, 0.19, 0.01);
  const hoodCheekR = mesh(rig.head, cheekGeo, hoodMat, -0.155, 0.19, 0.01);

  /* ---- drawstrings (pivots on the torso collar, sway with the wind) ---- */
  const cordMat = new THREE.MeshLambertMaterial({ color: 0xd9d4c6 });
  ownMats.push(cordMat);
  const cordGeo = geo(0.02, 0.15, 0.02);
  const cordL = new THREE.Group();
  cordL.position.set(0.075, 0.36, -0.15);
  rig.torso.add(cordL);
  mesh(cordL, cordGeo, cordMat, 0, -0.075, -0.012);
  const cordR = new THREE.Group();
  cordR.position.set(-0.075, 0.36, -0.15);
  rig.torso.add(cordR);
  mesh(cordR, cordGeo, cordMat, 0, -0.075, -0.012);

  /* ---- transverse silver flute (parented to the head → stays at lips) ---- */
  const fluteMat = new THREE.MeshLambertMaterial({ color: 0xc9ccd2 });
  const keyMat = new THREE.MeshLambertMaterial({ color: 0xaeb3bc });
  ownMats.push(fluteMat, keyMat);
  const flute = new THREE.Group();
  rig.head.add(flute);
  const tubeGeo = new THREE.CylinderGeometry(0.013, 0.013, 0.52, 10);
  ownGeos.push(tubeGeo);
  const tube = new THREE.Mesh(tubeGeo, fluteMat);
  tube.rotation.z = Math.PI / 2; // tube runs along local X
  tube.position.x = -0.2; // lip end at +0.06, foot joint at -0.46
  tube.castShadow = true;
  flute.add(tube);
  mesh(flute, geo(0.034, 0.02, 0.028), fluteMat, 0.02, 0.013, 0); // lip plate
  mesh(flute, geo(0.022, 0.022, 0.022), fluteMat, 0.055, 0, 0); // crown cap
  const keyGeo = geo(0.017, 0.013, 0.02);
  for (let i = 0; i < 6; i++) mesh(flute, keyGeo, keyMat, -0.09 - i * 0.052, 0.013, 0);
  flute.position.copy(LIP_POS);
  flute.quaternion.copy(LIP_QUAT);

  /* ------------------------------------------------------ animation state */

  const cursor = new NoteCursor(part);
  let t = Math.random() * 20; // ambient time (never resets → no oscillator pops)
  let perform = 0; // 0 = resting, 1 = attentive/performing
  let lift = 0; // 0 = flute in lap, 1 = flute at lips
  let prevNote: NoteEvent | null = null;
  let rippleT = 10; // since last note change (finger ripple envelope)
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

      // envelope: 70 ms attack → sustain (bar-17 long D5 decrescendos) → 150 ms release
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + ATTACK);
      if (ev.dur >= 3) env.gain.linearRampToValueAtTime(peak * 0.4, end);
      else env.gain.setValueAtTime(peak, end);
      env.gain.linearRampToValueAtTime(0, end + RELEASE);
      env.connect(audio.out);

      // fundamental + one octave partial
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = hz;
      osc.connect(env);
      const osc2 = ctx.createOscillator();
      osc2.type = "sine";
      osc2.frequency.value = hz * 2;
      const octG = ctx.createGain();
      octG.gain.value = OCTAVE_GAIN;
      osc2.connect(octG).connect(env);

      // vibrato: 5.2 Hz into detune, depth 0 → 8 cents over the first 0.3 s
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = VIB_HZ;
      const vib = ctx.createGain();
      vib.gain.setValueAtTime(0, t0);
      vib.gain.linearRampToValueAtTime(VIB_CENTS, t0 + VIB_RAMP);
      lfo.connect(vib);
      vib.connect(osc.detune);
      vib.connect(osc2.detune);

      // breath layer: lowpassed noise under the tone, same envelope
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
        osc.onended = null;
        osc.disconnect();
        osc2.disconnect();
        octG.disconnect();
        lfo.disconnect();
        vib.disconnect();
        noise.disconnect();
        lp.disconnect();
        brG.disconnect();
        env.disconnect();
      };
      activeVoices.add(cleanup);
      osc.onended = cleanup;
      osc.start(t0);
      osc.stop(stopAt);
      osc2.start(t0);
      osc2.stop(stopAt);
      lfo.start(t0);
      lfo.stop(stopAt);
      noise.start(t0);
      noise.stop(stopAt);
    }
  };

  /* -------------------------------------------------------------- update */

  const update = (dt: number, clock: TrioClock) => {
    t += dt;
    rippleT += dt;
    dipT += dt;
    const wind = clock.wind;
    const playing = clock.phase === "playing";

    const cur = cursor.at(clock.beat);
    if (playing && cur.current !== prevNote) {
      if (cur.current) {
        rippleT = 0; // fingers move on every note change
        const prevEnd = prevNote ? prevNote.beat + prevNote.dur : -10;
        if (prevNote === null || cur.current.beat - prevEnd > 0.35) dipT = 0; // phrase start
      }
      prevNote = cur.current;
    }
    if (!playing) prevNote = null;

    // ---- the two blend scalars ----
    perform = damp(perform, clock.phase === "rest" ? 0 : 1, PERFORM_LAMBDA, dt);
    // he enters at bar 9: raise the flute one beat before his first onset,
    // keep it up while his part is live, lower it in rest/countin
    const raise = playing && (cur.current !== null || (cur.next !== null && cur.next.beat - clock.beat < 1.1));
    lift = damp(lift, raise ? 1 : 0, raise ? RAISE_LAMBDA : LOWER_LAMBDA, dt);
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
    const ripple = Math.exp(-rippleT * 7) * Math.sin(rippleT * 38);
    const dip = dipT < 0.45 ? Math.sin((dipT / 0.45) * Math.PI) : 0;
    const nod = playing ? 0.03 * Math.sin(Math.PI * clock.beat) * (1 - l) : 0; // ready bars: faint pulse nod

    // ---- legs: dangling over the drop, slow phase-offset swing ----
    const swing = 1 - 0.35 * wl; // stiller while he's playing
    set(rig.legL, 1.38 + 0.05 * swing * Math.sin(t * 0.83 + 0.4), 0, 0.04);
    set(rig.legR, 1.31 + 0.05 * swing * Math.sin(t * 0.79 + 2.6), 0, -0.04);
    set(rig.shinL, -1.3 + 0.09 * swing * Math.sin(t * 1.07 + 1.1), 0, 0);
    set(rig.shinR, -1.24 + 0.09 * swing * Math.sin(t * 1.13 + 3.4), 0, 0);

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
    const attHZ = lerp(0, 0.09, l); // tilts a few degrees toward the flute
    set(rig.head, lerp(restHX, attHX, w) + nod, lerp(restHY, attHY, w), lerp(restHZ, attHZ, w));

    // ---- arms: lap hold ↔ transverse-flute hold (elbows out) ----
    const shoulderBr = 0.06 * breathF * l; // breaths flare the shoulders
    const settle = (1 - l) * w; // countin / ready-bars grip fidget
    const armLX = lerp(0.5 + 0.02 * breathe, 1.25, l);
    const armLY = lerp(0.12, 0.28, l);
    const armLZ = lerp(-0.14, -0.5, l) + shoulderBr;
    const armRX = lerp(0.52 + 0.02 * breathe, -0.3, l);
    const armRY = lerp(-0.12, -0.2, l);
    const armRZ = lerp(0.14, -1.25, l) - shoulderBr;
    set(rig.armL, armLX, armLY, armLZ);
    set(rig.armR, armRX, armRY, armRZ);
    set(rig.foreL, lerp(0.6, 1.5, l) + 0.02 * Math.sin(t * 2.1) * settle, lerp(-0.15, 0.15, l), lerp(0, 0.1, l));
    set(
      rig.foreR,
      lerp(0.62, 1.85, l) + 0.045 * ripple * l + 0.02 * Math.sin(t * 2.4 + 1) * settle,
      lerp(0.15, -0.2, l),
      lerp(0, -0.15, l) + 0.03 * ripple * l
    );

    // ---- flute: lap (head-rotation cancelled) ↔ lips (head-glued) ----
    _q1.copy(rig.head.quaternion).invert();
    _v1.copy(LAP_OFFSET).applyQuaternion(_q1); // lap position in head space
    _q1.multiply(LAP_QUAT_T); // lap orientation in head space
    flute.position.copy(_v1).lerp(LIP_POS, l);
    flute.quaternion.copy(_q1).slerp(LIP_QUAT, l);

    // ---- cloth: hood ruffle + drawstring sway, scaled by the wind ----
    const ruffle = wind * 0.028;
    hoodTop.rotation.set(ruffle * Math.sin(t * 2.7 + 0.5), 0, ruffle * Math.sin(t * 2.3));
    hoodBack.rotation.set(ruffle * Math.sin(t * 3.1 + 2.1), 0, ruffle * 0.7 * Math.sin(t * 2.9 + 1.2));
    hoodBrow.rotation.set(ruffle * 0.6 * Math.sin(t * 3.4 + 4), 0, 0);
    hoodCheekL.rotation.set(0, 0, ruffle * 0.4 * Math.sin(t * 2.5 + 0.9));
    hoodCheekR.rotation.set(0, 0, ruffle * 0.4 * Math.sin(t * 2.6 + 2.4));
    const cord = 0.12 + 0.5 * wind;
    cordL.rotation.set(-0.08 + cord * 0.3 * Math.sin(t * 1.9), 0, cord * 0.22 * Math.sin(t * 2.3 + 0.7));
    cordR.rotation.set(-0.08 + cord * 0.3 * Math.sin(t * 2.1 + 2.9), 0, cord * 0.22 * Math.sin(t * 2.5 + 3.6));
  };

  return {
    group,
    update,
    schedule,
    dispose() {
      for (const stop of Array.from(activeVoices)) stop();
      activeVoices.clear();
      group.parent?.remove(group);
      for (const g of ownGeos) g.dispose();
      for (const m of ownMats) m.dispose();
    }
  };
};
