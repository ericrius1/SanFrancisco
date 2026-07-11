// Dog-park sound layer — barks and paw-patter for the Corona Heights dogs.
//
// A small sibling of the nature soundscape that rides the SAME AudioContext and
// master bus (via NatureSoundscape.voiceBus), so HUD volume/mute, the region
// presence fade and the out-of-region context suspend all apply for free.
// Unlike the engine's ambient voices these sounds come from the actual park
// dogs: each dog gets ONE persistent PannerNode that follows it, barks are
// one-shot dogYip/dogWoof synths (voices.ts) drawn into that panner, and the
// scamper is a looped-noise patter chain gated by the dog's speed. The whole
// layer parks itself — zero audio work, just one distance check — whenever the
// player is more than ~45 m from the park.

import { smoothstep } from "./regions";
import { VOICE_LIB } from "./voices";
import { NATURE_AUDIO_TUNING, type NatureSoundscape } from "./natureSoundscape";

/** Structural mirror of CoronaHeightsPark's public dog entries — kept local so
 *  this layer never imports world code (audio stays a leaf module). */
export type DogParkDog = {
  x: number;
  z: number;
  heading: number;
  stride: number;
  speed: number;
  style: { scale: number; name: string };
  group: { position: { x: number; y: number; z: number } };
};

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

type DogRig = {
  panner: PannerNode;
  send: GainNode; // reverb tap
  patterFilter: BiquadFilterNode;
  patterTick: GainNode; // per-footfall envelope
  patterLevel: GainNode; // speed × distance gate
  patterSrc: AudioBufferSourceNode | null;
  tickPhase: number;
  barkTimer: number;
  wasSprinting: boolean;
};

const PARK_X = 368;
const PARK_Z = 2703;
const WAKE_RADIUS = 45; // master gate: silent (and idle) beyond this
const SCAMPER_RADIUS = 30;
const SPRINT_SPEED = 4.5; // upward crossing = "chase started" bark spike
const LAYER_GAIN = 0.85;
const PATTER_LEVEL = 0.11; // quiet — the patter sits UNDER the wind/bird bed
const REVERB_CHARACTER = 0.5; // matches the corona region's open-hilltop space
const EPS = 0.0001;

export class DogParkAudio {
  #nature: NatureSoundscape;
  #dogs: () => readonly DogParkDog[];
  #io: NatureVoiceIO | null = null;
  #layer: GainNode | null = null;
  #rigs: DogRig[] = [];
  #awake = false;

  constructor(nature: NatureSoundscape, dogs: () => readonly DogParkDog[]) {
    this.#nature = nature;
    this.#dogs = dogs;
  }

  update(dt: number, playerPos: { x: number; y: number; z: number }): void {
    const centerDist = Math.hypot(playerPos.x - PARK_X, playerPos.z - PARK_Z);
    const dogs = this.#dogs();
    if (dogs.length === 0) {
      this.#park();
      return;
    }
    // Keep the layer awake if the park is near OR any single dog is — an adopted
    // pet trotting at heel stays audible even when its home hill is silent.
    let nearestDogDist = Infinity;
    for (const dog of dogs) {
      const d = Math.hypot(dog.x - playerPos.x, dog.z - playerPos.z);
      if (d < nearestDogDist) nearestDogDist = d;
    }
    if (centerDist > WAKE_RADIUS && nearestDogDist > WAKE_RADIUS) {
      this.#park();
      return;
    }
    const io = (this.#io ??= this.#nature.voiceBus());
    if (!io || io.ctx.state !== "running") return; // nature owns unlock/suspend
    this.#wake(io, dogs);
    const now = io.ctx.currentTime;
    // soft master gate: the layer breathes in over the last dozen metres, driven
    // by whichever is closer — the park itself or the nearest (possibly pet) dog
    const proximity = Math.min(centerDist, nearestDogDist);
    this.#layer!.gain.setTargetAtTime(
      LAYER_GAIN * smoothstep(WAKE_RADIUS, WAKE_RADIUS - 12, proximity),
      now,
      0.2
    );

    for (let i = 0; i < this.#rigs.length && i < dogs.length; i++) {
      const dog = dogs[i];
      const rig = this.#rigs[i];
      movePanner(rig.panner, io.ctx, dog.x, dog.group.position.y + 0.3 * dog.style.scale, dog.z);

      // ---- scamper: footfall ticks gated by speed and proximity ------------
      const dogDist = Math.hypot(dog.x - playerPos.x, dog.z - playerPos.z);
      const patter =
        smoothstep(2.5, 4.2, dog.speed) * smoothstep(SCAMPER_RADIUS, SCAMPER_RADIUS * 0.6, dogDist);
      rig.patterLevel.gain.setTargetAtTime(patter * PATTER_LEVEL, now, 0.09);
      if (patter > 0.02) {
        // tick rate rides speed; small dogs patter faster (shorter legs)
        rig.tickPhase -= dt * Math.min(13, (dog.speed * 2.2) / dog.style.scale);
        if (rig.tickPhase <= 0) {
          rig.tickPhase = 1 + Math.random() * 0.25; // jitter — dogs never phase-lock
          const g = rig.patterTick.gain;
          g.cancelScheduledValues(now);
          g.setValueAtTime(0.5 + Math.random() * 0.5, now);
          g.exponentialRampToValueAtTime(EPS, now + 0.05);
        }
      }

      // ---- barks: cooldown-gated, spiking when a chase starts --------------
      // Per-dog proximity gate: while the layer is held awake for a nearby pet,
      // a distant park dog's chase spike shouldn't yip across the whole hill.
      const audible = dogDist < WAKE_RADIUS;
      const sprinting = dog.speed > SPRINT_SPEED;
      const chaseStart = sprinting && !rig.wasSprinting;
      rig.wasSprinting = sprinting;
      rig.barkTimer -= dt;
      if (audible && chaseStart && rig.barkTimer <= 1.5 && Math.random() < 0.85) {
        this.#bark(io, rig, dog, now);
      } else if (rig.barkTimer <= 0) {
        // idle excitement: an occasional yip while waiting on a throw
        if (audible && dog.speed < 1.2 && Math.random() < 0.3) this.#bark(io, rig, dog, now);
        else rig.barkTimer = 0.8 + Math.random() * 1.4; // re-roll soon
      }
    }
  }

  dispose(): void {
    this.#park();
    for (const rig of this.#rigs) {
      try {
        rig.panner.disconnect();
        rig.send.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.#rigs.length = 0;
    this.#layer?.disconnect();
    this.#layer = null;
  }

  /* --------------------------------------------------------------- guts */

  #bark(io: NatureVoiceIO, rig: DogRig, dog: DogParkDog, now: number): void {
    rig.barkTimer = 4 + Math.random() * 6;
    const level = Number(NATURE_AUDIO_TUNING.values.voices) * (0.5 + Math.random() * 0.22);
    VOICE_LIB[dog.style.scale < 0.9 ? "dogYip" : "dogWoof"]({
      ctx: io.ctx,
      out: rig.panner,
      t0: now + 0.02,
      noise: io.noise,
      rng: Math.random,
      level
    });
  }

  #wake(io: NatureVoiceIO, dogs: readonly DogParkDog[]): void {
    if (this.#awake) return;
    this.#awake = true;
    const ctx = io.ctx;
    if (!this.#layer) {
      this.#layer = ctx.createGain();
      this.#layer.gain.value = 0;
      this.#layer.connect(io.bus);
    }
    if (this.#rigs.length === 0) {
      for (const dog of dogs) this.#rigs.push(this.#makeRig(io, this.#layer, dog));
    }
    for (const rig of this.#rigs) {
      // buffer sources can't restart — recreate on wake, like the wind synth
      const src = ctx.createBufferSource();
      src.buffer = io.noise;
      src.loop = true;
      src.connect(rig.patterFilter);
      src.start(0, Math.random() * 1.5);
      rig.patterSrc = src;
    }
  }

  #park(): void {
    if (!this.#awake) return;
    this.#awake = false;
    const io = this.#io;
    if (!io) return;
    this.#layer?.gain.setTargetAtTime(0, io.ctx.currentTime, 0.15);
    for (const rig of this.#rigs) {
      if (rig.patterSrc) {
        rig.patterSrc.stop();
        rig.patterSrc.disconnect();
        rig.patterSrc = null;
      }
      rig.patterLevel.gain.value = 0;
      rig.wasSprinting = false;
    }
  }

  #makeRig(io: NatureVoiceIO, layer: GainNode, dog: DogParkDog): DogRig {
    const ctx = io.ctx;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 6;
    panner.rolloffFactor = 1.1;
    panner.maxDistance = 90;
    panner.connect(layer);
    const send = ctx.createGain();
    send.gain.value = REVERB_CHARACTER * Number(NATURE_AUDIO_TUNING.values.reverb);
    panner.connect(send).connect(io.reverbSend);
    // paw-patter chain: looped noise → bandpass → per-tick envelope → gate.
    // The band centre scales with the dog: small paws tick brighter.
    const patterFilter = ctx.createBiquadFilter();
    patterFilter.type = "bandpass";
    patterFilter.frequency.value = 1150 / dog.style.scale;
    patterFilter.Q.value = 1.3;
    const patterTick = ctx.createGain();
    patterTick.gain.value = EPS;
    const patterLevel = ctx.createGain();
    patterLevel.gain.value = 0;
    patterFilter.connect(patterTick).connect(patterLevel).connect(panner);
    movePanner(panner, ctx, dog.x, dog.group.position.y, dog.z, 0); // tc 0 = jump
    return {
      panner,
      send,
      patterFilter,
      patterTick,
      patterLevel,
      patterSrc: null,
      tickPhase: Math.random(),
      barkTimer: 2 + Math.random() * 6,
      wasSprinting: false
    };
  }
}

function movePanner(p: PannerNode, ctx: AudioContext, x: number, y: number, z: number, tc = 0.06): void {
  if (p.positionX) {
    const t = ctx.currentTime;
    p.positionX.setTargetAtTime(x, t, tc);
    p.positionY.setTargetAtTime(y, t, tc);
    p.positionZ.setTargetAtTime(z, t, tc);
  } else {
    // deprecated Safari path
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }
}
