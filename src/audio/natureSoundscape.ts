// Nature soundscape engine — a modular, multi-region ambient audio layer.
//
// One AudioContext (the app is already near the browser's context budget, so we
// deliberately do NOT add a THREE.AudioListener context) drives three layers:
//
//   • beds    — four looped field recordings (forest birds, meadow wind, canopy
//               wind, night crickets), a SHARED pool blended per region so the
//               node count is constant no matter how many regions exist.
//   • wind    — a procedural gust-locked synth (proceduralWind.ts) so the wind
//               swells with the same envelope the grass sways to.
//   • voices  — short procedurally-synthesized animal calls (voices.ts) placed
//               spatially around the listener, scheduled by a density that
//               breathes with time-of-day (dawn chorus, night owls) and wind
//               (birds shelter in gusts). Every call is synthesized fresh, so
//               the foreground never audibly repeats.
//
// Regions are pure data (regions.ts). Adding a nature area is one config entry;
// this engine is generic over the list. The master respects the HUD volume/mute
// (effectsAudioLevel) and the whole context suspends itself when the listener is
// nowhere near any nature region, so it costs nothing in the city.

import * as THREE from "three/webgpu";
import { tunables } from "../core/persist";
import { effectsAudioLevel } from "../core/audioSettings";
import { ProceduralWindSynth } from "./proceduralWind";
import { VOICE_LIB, RESPONDER_KINDS, type NatureVoiceKind } from "./voices";
import {
  NATURE_REGIONS,
  regionInfluence,
  type BedId,
  type NatureRegionSpec,
  type VoiceWeight
} from "./regions";

export const NATURE_AUDIO_TUNING = tunables("natureAudio", {
  enabled: { v: true, label: "enabled" },
  master: { v: 0.9, min: 0, max: 1, step: 0.01, label: "master" },
  beds: { v: 0.85, min: 0, max: 1, step: 0.01, label: "sampled beds" },
  voices: { v: 0.8, min: 0, max: 1, step: 0.01, label: "wildlife calls" },
  wind: { v: 0.9, min: 0, max: 1, step: 0.01, label: "wind synth" },
  reverb: { v: 0.85, min: 0, max: 1, step: 0.01, label: "space / reverb" },
  density: { v: 1, min: 0.25, max: 2.5, step: 0.05, label: "call density ×" }
});

const AUDIO_ROOT = "/audio/nature";
const BED_FILES: Record<BedId, string> = {
  forestBirds: `${AUDIO_ROOT}/forest-birds.mp3`,
  windGrass: `${AUDIO_ROOT}/wind-grass.mp3`,
  windTree: `${AUDIO_ROOT}/wind-tree.mp3`,
  nightCrickets: `${AUDIO_ROOT}/night-crickets.mp3`
};
const BED_IDS = Object.keys(BED_FILES) as BedId[];
const MAX_VOICES = 16;

type Bed = {
  source: AudioBufferSourceNode | null;
  filter: BiquadFilterNode;
  gain: GainNode;
  panLfo: OscillatorNode | null;
  level: number;
};

type ActiveVoice = { panner: PannerNode; send: GainNode; expires: number };

export class NatureSoundscape {
  #ctx: AudioContext | null = null;
  #bus!: GainNode; // master volume/presence fade
  #reverbSend!: GainNode;
  #convolver!: ConvolverNode;
  #noise!: AudioBuffer;
  #wind: ProceduralWindSynth | null = null;
  #beds = new Map<BedId, Bed>();
  #bedBuffers = new Map<BedId, AudioBuffer>();
  #voices: ActiveVoice[] = [];
  #unlocked = false;
  #loading = false;
  #masterLevel = 0;
  #presence = 0;
  #voiceTimer = 0.8;
  #inf = new Float32Array(NATURE_REGIONS.length);
  // debug counters
  #lastKind: NatureVoiceKind | "-" = "-";
  #voiceCount = 0;

  constructor() {
    const unlock = () => {
      const ctx = this.#ensure();
      if (!ctx) return;
      if (ctx.state === "suspended") void ctx.resume();
      this.#unlocked = true;
      this.#startBeds();
      if (ctx.state === "running") {
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
        window.removeEventListener("touchstart", unlock);
      }
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    window.addEventListener("touchstart", unlock, { passive: true });
  }

  get debugState() {
    return {
      ctx: this.#ctx?.state ?? "none",
      unlocked: this.#unlocked,
      master: +this.#masterLevel.toFixed(3),
      presence: +this.#presence.toFixed(3),
      beds: BED_IDS.map((id) => ({ id, level: +(this.#beds.get(id)?.level ?? 0).toFixed(3) })),
      influence: NATURE_REGIONS.map((r, i) => ({ id: r.id, inf: +this.#inf[i].toFixed(3) })),
      activeVoices: this.#voices.length,
      voiceCount: this.#voiceCount,
      lastKind: this.#lastKind
    };
  }

  /** Force-unlock without a gesture (headless tests). */
  async unlock(): Promise<void> {
    const ctx = this.#ensure();
    if (!ctx) return;
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    this.#unlocked = true;
    this.#startBeds();
  }

  update(
    dt: number,
    o: { playerPos: { x: number; y: number; z: number }; camera: THREE.Camera; gust: number; timeOfDay: number }
  ): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const T = NATURE_AUDIO_TUNING.values;

    // ---- region influences + blended character ---------------------------
    let presence = 0;
    let windBias = 0;
    let fog = 0;
    let infSum = 0;
    for (let i = 0; i < NATURE_REGIONS.length; i++) {
      const inf = regionInfluence(NATURE_REGIONS[i], o.playerPos.x, o.playerPos.z);
      this.#inf[i] = inf;
      presence = Math.max(presence, inf);
      windBias += inf * NATURE_REGIONS[i].character.windBias;
      fog += inf * NATURE_REGIONS[i].character.fog;
      infSum += inf;
    }
    if (infSum > 0) {
      windBias /= infSum;
      fog /= infSum;
    }

    const allowed =
      document.visibilityState === "visible" && Boolean(T.enabled) && Number(T.master) > 0.001;
    const effects = effectsAudioLevel();
    const targetPresence = allowed ? presence : 0;
    this.#presence = approach(this.#presence, targetPresence, dt, 1.6);

    // ---- master fade + park the whole graph when far from any region ------
    const targetMaster = allowed ? effects * Number(T.master) * this.#presence : 0;
    if (targetMaster <= 0.0001 && this.#masterLevel <= 0.001) {
      if (ctx.state === "running") {
        this.#bus.gain.value = 0;
        this.#masterLevel = 0;
        void ctx.suspend();
      }
      return; // suspended: no per-frame cost out in the city
    }
    if (ctx.state === "suspended") void ctx.resume();
    if (ctx.state !== "running") return;
    this.#masterLevel = approach(this.#masterLevel, targetMaster, dt, 3.5);
    this.#bus.gain.value = this.#masterLevel;

    const now = ctx.currentTime;
    const day = daylight(o.timeOfDay);
    const gust = clamp01(o.gust);

    // ---- beds ------------------------------------------------------------
    for (const id of BED_IDS) {
      const bed = this.#beds.get(id);
      if (!bed) continue;
      // influence×density weighted average of each region's bed gain: where
      // regions overlap (garden inside the park) the denser one leads the mix,
      // so the garden stays lush-and-sheltered instead of park-windy. Overall
      // fade to silence out of all regions is the bus's job (presence), not this.
      let num = 0;
      let den = 0;
      for (let i = 0; i < NATURE_REGIONS.length; i++) {
        const b = NATURE_REGIONS[i].beds[id];
        if (b === undefined) continue;
        const w = this.#inf[i] * NATURE_REGIONS[i].density;
        num += w * b;
        den += w;
      }
      const blend = den > 0 ? Math.min(1, num / den) : 0;
      const target = blend * bedFactor(id, day, gust) * Number(T.beds);
      bed.level = target;
      bed.gain.gain.setTargetAtTime(target, now, 0.25);
      // mist/fog softens the whole region: pull the bed lowpass down
      bed.filter.frequency.setTargetAtTime(2600 + (1 - fog) * 3400, now, 0.3);
    }

    // ---- wind synth ------------------------------------------------------
    if (this.#wind) {
      const nearMix = presence; // deeper in a region = more leaf/grass rustle
      this.#wind.setRunning(true);
      this.#wind.update(gust, o.camera, Number(T.wind) * windBias * presence, nearMix);
    }

    // ---- spatial voice scheduler ----------------------------------------
    this.#updateListener(o.camera);
    this.#reapVoices(now);
    if (presence > 0.02 && effects > 0.001 && Number(T.voices) > 0.001) {
      let ratePerMin = 0;
      for (let i = 0; i < NATURE_REGIONS.length; i++) {
        ratePerMin += this.#inf[i] * NATURE_REGIONS[i].density;
      }
      ratePerMin *= timeDensity(o.timeOfDay) * windLull(gust) * Number(T.density);
      ratePerMin = Math.min(44, ratePerMin);
      if (ratePerMin > 0.01) {
        this.#voiceTimer -= dt;
        if (this.#voiceTimer <= 0) {
          this.#spawnVoice(o.playerPos, day, now);
          const mean = 60 / ratePerMin;
          this.#voiceTimer = mean * (0.55 + Math.random() * 1.2);
        }
      }
    }
  }

  dispose(): void {
    const ctx = this.#ctx;
    for (const v of this.#voices) {
      try {
        v.panner.disconnect();
        v.send.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.#voices.length = 0;
    for (const bed of this.#beds.values()) {
      bed.source?.stop();
      bed.panLfo?.stop();
    }
    this.#wind?.dispose();
    if (ctx && ctx.state !== "closed") void ctx.close();
    this.#ctx = null;
  }

  /* --------------------------------------------------------------- guts */

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    const ctx = new AudioContext();
    this.#ctx = ctx;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 22;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.35;
    limiter.connect(ctx.destination);

    this.#bus = ctx.createGain();
    this.#bus.gain.value = 0;
    this.#bus.connect(limiter);

    // shared 2s white noise for voice synthesis
    const sr = ctx.sampleRate;
    this.#noise = ctx.createBuffer(1, sr * 2, sr);
    const nd = this.#noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // reverb: a generated exponential-decay impulse gives the open-canyon /
    // enclosed-garden "space" without any IR asset. One convolver, per-source send.
    this.#convolver = ctx.createConvolver();
    this.#convolver.buffer = makeImpulse(ctx, 2.2, 2.6);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.9;
    this.#reverbSend = ctx.createGain();
    this.#reverbSend.gain.value = 1;
    this.#reverbSend.connect(this.#convolver).connect(reverbReturn).connect(this.#bus);

    // wind synth draws into the master bus (with a small fixed reverb tap)
    this.#wind = new ProceduralWindSynth(ctx, this.#bus);

    // build (silent) beds now; sources start once a buffer + unlock arrive
    for (const id of BED_IDS) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 3800;
      filter.Q.value = 0.2;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      filter.connect(gain);
      gain.connect(this.#bus);
      const send = ctx.createGain();
      send.gain.value = 0.16;
      gain.connect(send).connect(this.#reverbSend);
      this.#beds.set(id, { source: null, filter, gain, panLfo: null, level: 0 });
    }
    void this.#loadBeds();
    return ctx;
  }

  async #loadBeds(): Promise<void> {
    if (this.#loading || !this.#ctx) return;
    this.#loading = true;
    await Promise.all(
      BED_IDS.map(async (id) => {
        try {
          const res = await fetch(BED_FILES[id]);
          const arr = await res.arrayBuffer();
          const buf = await this.#ctx!.decodeAudioData(arr);
          this.#bedBuffers.set(id, buf);
        } catch (err) {
          console.warn(`[nature-audio] bed failed: ${id}`, err);
        }
      })
    );
    if (this.#unlocked) this.#startBeds();
  }

  #startBeds(): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#unlocked) return;
    for (const id of BED_IDS) {
      const bed = this.#beds.get(id);
      const buf = this.#bedBuffers.get(id);
      if (!bed || !buf || bed.source) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // stagger the loop phase so beds don't pulse in lockstep
      const offset = (id.charCodeAt(0) * 3.3) % Math.max(1, buf.duration - 0.5);
      // a slow stereo drift keeps the wash alive without positional cost
      const panner = ctx.createStereoPanner();
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.03 + Math.random() * 0.04;
      const lg = ctx.createGain();
      lg.gain.value = 0.35;
      lfo.connect(lg).connect(panner.pan);
      src.connect(panner).connect(bed.filter);
      src.start(0, offset);
      lfo.start();
      bed.source = src;
      bed.panLfo = lfo;
    }
  }

  #updateListener(camera: THREE.Camera): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const l = ctx.listener;
    camera.getWorldPosition(tmpPos);
    camera.getWorldDirection(tmpFwd); // -Z, normalized
    tmpUp.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(tmpQuat));
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setTargetAtTime(tmpPos.x, t, 0.02);
      l.positionY.setTargetAtTime(tmpPos.y, t, 0.02);
      l.positionZ.setTargetAtTime(tmpPos.z, t, 0.02);
      l.forwardX.setTargetAtTime(tmpFwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(tmpFwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(tmpFwd.z, t, 0.02);
      l.upX.setTargetAtTime(tmpUp.x, t, 0.05);
      l.upY.setTargetAtTime(tmpUp.y, t, 0.05);
      l.upZ.setTargetAtTime(tmpUp.z, t, 0.05);
    } else {
      // deprecated Safari path
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(
        tmpPos.x,
        tmpPos.y,
        tmpPos.z
      );
      (l as unknown as { setOrientation(...a: number[]): void }).setOrientation(
        tmpFwd.x,
        tmpFwd.y,
        tmpFwd.z,
        tmpUp.x,
        tmpUp.y,
        tmpUp.z
      );
    }
  }

  #reapVoices(now: number): void {
    for (let i = this.#voices.length - 1; i >= 0; i--) {
      if (this.#voices[i].expires <= now) {
        try {
          this.#voices[i].panner.disconnect();
          this.#voices[i].send.disconnect();
        } catch {
          /* noop */
        }
        this.#voices.splice(i, 1);
      }
    }
  }

  #spawnVoice(playerPos: { x: number; y: number; z: number }, day: number, now: number, answerTo?: number): void {
    const ctx = this.#ctx;
    if (!ctx || this.#voices.length >= MAX_VOICES) return;
    const ri = this.#pickRegion();
    if (ri < 0) return;
    const region = NATURE_REGIONS[ri];
    const kind = pickVoice(region, day, answerTo);
    if (!kind) return;

    // place around the listener in world space; the panner does distance/rolloff
    const az = Math.random() * Math.PI * 2;
    const dist = 8 + Math.random() * 44;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 9;
    panner.rolloffFactor = 0.9;
    panner.maxDistance = 160;
    setPannerPos(
      panner,
      ctx,
      playerPos.x + Math.sin(az) * dist,
      playerPos.y + 1.5 + Math.random() * 9,
      playerPos.z + Math.cos(az) * dist
    );
    panner.connect(this.#bus);
    const send = ctx.createGain();
    send.gain.value = region.character.reverb * Number(NATURE_AUDIO_TUNING.values.reverb);
    panner.connect(send).connect(this.#reverbSend);

    const level = Number(NATURE_AUDIO_TUNING.values.voices) * (0.7 + Math.random() * 0.35);
    const dur = VOICE_LIB[kind]({ ctx, out: panner, t0: now + 0.02, noise: this.#noise, rng: Math.random, level });
    this.#voices.push({ panner, send, expires: now + dur + 2.6 });
    this.#lastKind = kind;
    this.#voiceCount++;

    // call-and-response: a nearby bird answers from a different bearing
    if (answerTo === undefined && RESPONDER_KINDS.has(kind) && Math.random() < 0.33) {
      const delay = 0.4 + Math.random() * 0.9;
      window.setTimeout(() => {
        if (this.#ctx && this.#ctx.state === "running") {
          this.#spawnVoice(playerPos, day, this.#ctx.currentTime + 0.02, ri);
        }
      }, delay * 1000);
    }
  }

  /** Weighted-random region by influence × density, so where regions overlap
   *  (e.g. the lush garden inside the broad park) the denser one supplies more
   *  of the calls and keeps its identity. */
  #pickRegion(): number {
    let total = 0;
    for (let i = 0; i < this.#inf.length; i++) total += this.#inf[i] * NATURE_REGIONS[i].density;
    if (total <= 0) return -1;
    let r = Math.random() * total;
    for (let i = 0; i < this.#inf.length; i++) {
      r -= this.#inf[i] * NATURE_REGIONS[i].density;
      if (r <= 0) return i;
    }
    return this.#inf.length - 1;
  }
}

/* ------------------------------------------------------------- free helpers */

function approach(cur: number, target: number, dt: number, rate: number): number {
  return cur + (target - cur) * (1 - Math.exp(-dt * rate));
}
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** 0..1 daylight: soft dawn ~5.2-7.2h, soft dusk ~18.5-20.5h. */
function daylight(h: number): number {
  const up = smooth(5.2, 7.2, h);
  const down = 1 - smooth(18.5, 20.5, h);
  return up * down;
}
function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
/** Call-rate multiplier over the day: dawn chorus + gentle dusk lift, half-rate at night. */
function timeDensity(h: number): number {
  const day = daylight(h);
  const dawn = Math.max(0, 1 - Math.abs(h - 6.3) / 1.8);
  const dusk = Math.max(0, 1 - Math.abs(h - 19) / 1.3) * 0.5;
  return (0.45 + 0.55 * day) * (1 + 1.4 * dawn + dusk);
}
/** Birds shelter and call less as gusts pick up. */
function windLull(gust: number): number {
  return 1 - 0.5 * smooth(0.5, 0.95, gust);
}
/** Per-bed day/night + gust weighting. */
function bedFactor(id: BedId, day: number, gust: number): number {
  if (id === "forestBirds") return 0.12 + 0.88 * day;
  if (id === "nightCrickets") return 0.08 + 0.92 * (1 - day);
  // wind beds breathe with the gust envelope
  return 0.4 + 0.7 * gust;
}

/** Blend a region's day and night palettes by daylight, then weighted-pick. */
function pickVoice(region: NatureRegionSpec, day: number, forceSameAs?: number): NatureVoiceKind | null {
  const weights = new Map<NatureVoiceKind, number>();
  const add = (list: VoiceWeight[], scale: number) => {
    for (const vw of list) weights.set(vw.kind, (weights.get(vw.kind) ?? 0) + vw.w * scale);
  };
  add(region.day, day);
  add(region.night, 1 - day);
  // an "answer" prefers responder species (keeps a dialogue coherent)
  if (forceSameAs !== undefined) {
    for (const k of [...weights.keys()]) if (!RESPONDER_KINDS.has(k)) weights.delete(k);
  }
  let total = 0;
  for (const w of weights.values()) total += w;
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const [kind, w] of weights) {
    r -= w;
    if (r <= 0) return kind;
  }
  return null;
}

function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function setPannerPos(p: PannerNode, ctx: AudioContext, x: number, y: number, z: number): void {
  if (p.positionX) {
    const t = ctx.currentTime;
    p.positionX.setValueAtTime(x, t);
    p.positionY.setValueAtTime(y, t);
    p.positionZ.setValueAtTime(z, t);
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }
}

// scratch vectors — module-scope, reused every frame (no per-frame allocation)
const tmpPos = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
