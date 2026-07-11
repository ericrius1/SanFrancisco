// Spatial dog sounds for Corona Heights today and any future city dog areas.
//
// The layer rides NatureSoundscape's AudioContext and effects bus, so the HUD
// volume/mute control, browser gesture unlock, visibility handling and limiter
// remain the single source of truth. Dogs supply exact chase/catch/return cues;
// this module decides whether to voice them, enforces per-dog and park-wide
// cooldowns, and varies the procedural voice. Quiet speed-gated paw patter fills
// in movement without turning the dog park into a looped ambience track.

import { smoothstep } from "./regions";
import { VOICE_LIB, type NatureVoiceKind } from "./voices";
import { NATURE_AUDIO_TUNING, type NatureSoundscape } from "./natureSoundscape";

/** Structural mirror of a world dog's public audio-facing fields. Keeping this
 * local lets future parks feed the layer without importing Corona world code. */
export type DogParkDog = {
  x: number;
  z: number;
  speed: number;
  style: { scale: number; name: string };
  group: { position: { x: number; y: number; z: number } };
};

export type DogAudioCue = "chase" | "catch" | "return";

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

type DogRig = {
  panner: PannerNode;
  send: GainNode;
  patterFilter: BiquadFilterNode;
  patterTick: GainNode;
  patterLevel: GainNode;
  patterSrc: AudioBufferSourceNode | null;
  tickPhase: number;
  vocalCooldown: number;
  pendingCue: DogAudioCue | null;
};

/** Audio behavior lives together here so density/volume changes stay coherent. */
const DOG_AUDIO = {
  wakeRadius: 38,
  scamperRadius: 23,
  layerGain: 0.55,
  patterLevel: 0.055,
  globalVocalGap: 4.25,
  dogVocalGapMin: 7,
  dogVocalGapMax: 12,
  cueChance: {
    chase: 0.22,
    catch: 0.48,
    return: 0.25
  } satisfies Record<DogAudioCue, number>,
  reverbCharacter: 0.42
} as const;

const EPS = 0.0001;

export class DogParkAudio {
  #nature: NatureSoundscape;
  #dogs: () => readonly DogParkDog[];
  #io: NatureVoiceIO | null = null;
  #layer: GainNode | null = null;
  #rigs = new Map<DogParkDog, DogRig>();
  #pendingCues = new WeakMap<DogParkDog, DogAudioCue>();
  #awake = false;
  #paused = false;
  #globalVocalCooldown = 0;

  constructor(nature: NatureSoundscape, dogs: () => readonly DogParkDog[]) {
    this.#nature = nature;
    this.#dogs = dogs;
  }

  /** Queue an exact gameplay moment. Cues are intentionally lossy: if several
   * dogs finish together, the shared cooldown keeps only a tasteful response. */
  cue(dog: DogParkDog, cue: DogAudioCue): void {
    const rig = this.#rigs.get(dog);
    if (rig) rig.pendingCue = cue;
    else this.#pendingCues.set(dog, cue);
  }

  /** Freeze/pause hook: stops looped patter instead of leaving the last running
   * speed audible while the simulation is held. */
  setPaused(paused: boolean): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    if (paused) this.#sleep();
  }

  update(dt: number, playerPos: { x: number; y: number; z: number }): void {
    if (this.#paused) return;
    const dogs = this.#dogs();
    if (dogs.length === 0) {
      this.#sleep();
      return;
    }

    let nearestDogDist = Infinity;
    for (const dog of dogs) {
      const d = Math.hypot(dog.x - playerPos.x, dog.z - playerPos.z);
      if (d < nearestDogDist) nearestDogDist = d;
    }
    if (nearestDogDist > DOG_AUDIO.wakeRadius) {
      this.#sleep();
      return;
    }

    // A nearby adopted pet can be outside every nature region. Ask the shared
    // soundscape to keep only its effects-scaled always bus awake.
    this.#nature.setExternalAwake(true);
    const io = (this.#io ??= this.#nature.voiceBus());
    if (!io || io.ctx.state !== "running") return;
    this.#wake(io, dogs);

    const now = io.ctx.currentTime;
    this.#globalVocalCooldown = Math.max(0, this.#globalVocalCooldown - dt);
    this.#layer!.gain.setTargetAtTime(
      DOG_AUDIO.layerGain * smoothstep(DOG_AUDIO.wakeRadius, DOG_AUDIO.wakeRadius - 11, nearestDogDist),
      now,
      0.2
    );

    for (const dog of dogs) {
      const rig = this.#rigs.get(dog);
      if (!rig) continue;
      rig.vocalCooldown = Math.max(0, rig.vocalCooldown - dt);
      movePanner(rig.panner, io.ctx, dog.x, dog.group.position.y + 0.3 * dog.style.scale, dog.z);

      const dogDist = Math.hypot(dog.x - playerPos.x, dog.z - playerPos.z);
      const patter =
        smoothstep(2.5, 4.2, dog.speed) *
        smoothstep(DOG_AUDIO.scamperRadius, DOG_AUDIO.scamperRadius * 0.58, dogDist);
      rig.patterLevel.gain.setTargetAtTime(patter * DOG_AUDIO.patterLevel, now, 0.09);
      if (patter > 0.02) {
        rig.tickPhase -= dt * Math.min(13, (dog.speed * 2.2) / dog.style.scale);
        if (rig.tickPhase <= 0) {
          rig.tickPhase = 1 + Math.random() * 0.25;
          const g = rig.patterTick.gain;
          g.cancelScheduledValues(now);
          g.setValueAtTime(0.42 + Math.random() * 0.38, now);
          g.exponentialRampToValueAtTime(EPS, now + 0.045);
        }
      }

      const cue = rig.pendingCue;
      rig.pendingCue = null;
      if (
        cue &&
        dogDist < DOG_AUDIO.wakeRadius &&
        rig.vocalCooldown <= 0 &&
        this.#globalVocalCooldown <= 0 &&
        Math.random() < DOG_AUDIO.cueChance[cue]
      ) {
        this.#vocalize(io, rig, dog, cue, now);
      }
    }
  }

  dispose(): void {
    this.#sleep();
    for (const rig of this.#rigs.values()) this.#disposeRig(rig);
    this.#rigs.clear();
    this.#layer?.disconnect();
    this.#layer = null;
  }

  #vocalize(
    io: NatureVoiceIO,
    rig: DogRig,
    dog: DogParkDog,
    cue: DogAudioCue,
    now: number
  ): void {
    this.#globalVocalCooldown = DOG_AUDIO.globalVocalGap + Math.random() * 1.5;
    rig.vocalCooldown =
      DOG_AUDIO.dogVocalGapMin +
      Math.random() * (DOG_AUDIO.dogVocalGapMax - DOG_AUDIO.dogVocalGapMin);

    // Fetch completion often gets a soft breathy huff instead of another bark.
    // Chases read best with a bark; small dogs favor the brighter yip.
    const huffChance = cue === "return" ? 0.72 : cue === "catch" ? 0.34 : 0;
    const kind: NatureVoiceKind =
      Math.random() < huffChance ? "dogHuff" : dog.style.scale < 0.9 ? "dogYip" : "dogWoof";
    const base = kind === "dogHuff" ? 0.2 + Math.random() * 0.06 : 0.27 + Math.random() * 0.09;
    const level = Number(NATURE_AUDIO_TUNING.values.voices) * base;
    VOICE_LIB[kind]({
      ctx: io.ctx,
      out: rig.panner,
      t0: now + 0.02,
      noise: io.noise,
      rng: Math.random,
      level
    });
  }

  #wake(io: NatureVoiceIO, dogs: readonly DogParkDog[]): void {
    const ctx = io.ctx;
    if (!this.#layer) {
      this.#layer = ctx.createGain();
      this.#layer.gain.value = 0;
      this.#layer.connect(io.alwaysBus);
    }
    this.#syncRigs(io, dogs);
    if (this.#awake) return;
    this.#awake = true;
    for (const rig of this.#rigs.values()) this.#startPatter(io, rig);
  }

  #syncRigs(io: NatureVoiceIO, dogs: readonly DogParkDog[]): void {
    const live = new Set(dogs);
    for (const [dog, rig] of this.#rigs) {
      if (live.has(dog)) continue;
      this.#disposeRig(rig);
      this.#rigs.delete(dog);
    }
    for (const dog of dogs) {
      if (this.#rigs.has(dog)) continue;
      const rig = this.#makeRig(io, this.#layer!, dog);
      rig.pendingCue = this.#pendingCues.get(dog) ?? null;
      this.#pendingCues.delete(dog);
      this.#rigs.set(dog, rig);
      if (this.#awake) this.#startPatter(io, rig);
    }
  }

  #startPatter(io: NatureVoiceIO, rig: DogRig): void {
    if (rig.patterSrc) return;
    const src = io.ctx.createBufferSource();
    src.buffer = io.noise;
    src.loop = true;
    src.connect(rig.patterFilter);
    src.start(0, Math.random() * 1.5);
    rig.patterSrc = src;
  }

  #sleep(): void {
    this.#nature.setExternalAwake(false);
    this.#pendingCues = new WeakMap<DogParkDog, DogAudioCue>();
    for (const rig of this.#rigs.values()) rig.pendingCue = null;
    if (!this.#awake) return;
    this.#awake = false;
    const io = this.#io;
    if (!io) return;
    this.#layer?.gain.setTargetAtTime(0, io.ctx.currentTime, 0.12);
    for (const rig of this.#rigs.values()) {
      if (rig.patterSrc) {
        rig.patterSrc.stop();
        rig.patterSrc.disconnect();
        rig.patterSrc = null;
      }
      rig.patterLevel.gain.value = 0;
    }
  }

  #makeRig(io: NatureVoiceIO, layer: GainNode, dog: DogParkDog): DogRig {
    const ctx = io.ctx;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 4;
    panner.rolloffFactor = 1.35;
    panner.maxDistance = 60;
    panner.connect(layer);

    const send = ctx.createGain();
    send.gain.value = DOG_AUDIO.reverbCharacter * Number(NATURE_AUDIO_TUNING.values.reverb);
    panner.connect(send).connect(io.reverbSend);

    const patterFilter = ctx.createBiquadFilter();
    patterFilter.type = "bandpass";
    patterFilter.frequency.value = 1150 / dog.style.scale;
    patterFilter.Q.value = 1.3;
    const patterTick = ctx.createGain();
    patterTick.gain.value = EPS;
    const patterLevel = ctx.createGain();
    patterLevel.gain.value = 0;
    patterFilter.connect(patterTick).connect(patterLevel).connect(panner);
    movePanner(panner, ctx, dog.x, dog.group.position.y, dog.z, 0);
    return {
      panner,
      send,
      patterFilter,
      patterTick,
      patterLevel,
      patterSrc: null,
      tickPhase: Math.random(),
      vocalCooldown: Math.random() * 3,
      pendingCue: null
    };
  }

  #disposeRig(rig: DogRig): void {
    if (rig.patterSrc) {
      try {
        rig.patterSrc.stop();
      } catch {
        // Source may already have ended during context teardown.
      }
      rig.patterSrc.disconnect();
      rig.patterSrc = null;
    }
    rig.patterFilter.disconnect();
    rig.patterTick.disconnect();
    rig.patterLevel.disconnect();
    rig.panner.disconnect();
    rig.send.disconnect();
  }
}

function movePanner(
  p: PannerNode,
  ctx: AudioContext,
  x: number,
  y: number,
  z: number,
  tc = 0.035
): void {
  const now = ctx.currentTime;
  if (p.positionX) {
    p.positionX.setTargetAtTime(x, now, tc);
    p.positionY.setTargetAtTime(y, now, tc);
    p.positionZ.setTargetAtTime(z, now, tc);
  } else {
    p.setPosition(x, y, z);
  }
}
