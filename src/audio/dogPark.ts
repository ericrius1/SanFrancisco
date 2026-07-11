// Spatial dog sounds for Corona Heights today and any future city dog areas.
//
// The layer rides NatureSoundscape's AudioContext and effects bus, so the HUD
// volume/mute control, browser gesture unlock, visibility handling and limiter
// remain the single source of truth. Dogs supply exact chase/catch/return cues;
// this module decides whether to voice them, enforces per-dog and park-wide
// cooldowns, and varies the procedural voice. Quiet speed-gated paw patter fills
// in movement without turning the dog park into a looped ambience track.

import { smoothstep } from "./regions";
import { DOG_VOICE_LIB, dogVoiceForStyle, type DogVoiceKind } from "./voices";
import { NATURE_AUDIO_TUNING, type NatureSoundscape } from "./natureSoundscape";

/** Structural mirror of a world dog's public audio-facing fields. Keeping this
 * local lets future parks feed the layer without importing Corona world code. */
export type DogParkDog = {
  x: number;
  z: number;
  speed: number;
  controller?: "park" | "player" | "pet";
  style: { scale: number; name: string };
  group: { position: { x: number; y: number; z: number } };
};

export type DogAudioCue = "chase" | "catch" | "return";
type DogVocalMoment = DogAudioCue | "ambient";

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
  // Dog calls are gameplay SFX, not background wildlife. Keep enough headroom
  // for doubles, but make a single nearby bark unmistakable at default FX gain.
  layerGain: 1,
  patterLevel: 0.055,
  globalVocalGap: 3.4,
  dogVocalGapMin: 4.5,
  dogVocalGapMax: 7,
  ambientRadius: 30,
  ambientFirstGapMin: 8,
  ambientFirstGapMax: 12,
  ambientGapMin: 22,
  ambientGapMax: 38,
  ambientRetryMin: 2.5,
  ambientRetryMax: 5,
  ambientMaxDogSpeed: 2.4,
  playerCueChance: {
    // Chase + return are the two moments a player expects to hear. They are
    // guaranteed when cooldowns permit; catch stays a quieter optional huff.
    chase: 1,
    catch: 0.42,
    return: 1
  } satisfies Record<DogAudioCue, number>,
  parkCueChance: {
    // The two owner-run fetch loops repeat forever, so they speak less often
    // and leave space for the player's dog and the occasional idle bark.
    chase: 0.5,
    catch: 0.2,
    return: 0.6
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
  #ambientTimer = randomBetween(DOG_AUDIO.ambientFirstGapMin, DOG_AUDIO.ambientFirstGapMax);
  #lastAmbientDog: DogParkDog | null = null;
  #vocalCount = 0;
  #ambientCount = 0;
  #cueCounts: Record<DogVocalMoment, number> = { chase: 0, catch: 0, return: 0, ambient: 0 };
  #kindCounts: Record<DogVoiceKind, number> = {
    goldenBark: 0,
    collieBark: 0,
    terrierBark: 0,
    corgiBark: 0,
    dogHuff: 0
  };
  #lastVocal: { dog: string; cue: DogVocalMoment; kind: DogVoiceKind } | null = null;

  constructor(nature: NatureSoundscape, dogs: () => readonly DogParkDog[]) {
    this.#nature = nature;
    this.#dogs = dogs;
  }

  /** Read-only verification surface used by the headless audio probe. */
  get debugState() {
    return {
      awake: this.#awake,
      paused: this.#paused,
      rigs: this.#rigs.size,
      context: this.#io?.ctx.state ?? "none",
      layerGain: +(this.#layer?.gain.value ?? 0).toFixed(3),
      globalCooldown: +this.#globalVocalCooldown.toFixed(2),
      ambientIn: +this.#ambientTimer.toFixed(2),
      vocalCount: this.#vocalCount,
      ambientCount: this.#ambientCount,
      cueCounts: { ...this.#cueCounts },
      kindCounts: { ...this.#kindCounts },
      lastVocal: this.#lastVocal
    };
  }

  /** Queue an exact gameplay moment. Cues are intentionally lossy: if several
   * dogs finish together, the shared cooldown keeps only a tasteful response. */
  cue(dog: DogParkDog, cue: DogAudioCue): void {
    const rig = this.#rigs.get(dog);
    if (rig) {
      rig.pendingCue = cue;
      // A user's fresh throw is the foundational feedback beat: an unrelated
      // earlier idle/owner bark must not make their dog silently start running.
      if (dog.controller === "player" && cue === "chase") rig.vocalCooldown = 0;
    } else {
      this.#pendingCues.set(dog, cue);
    }
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
    this.#ambientTimer -= dt;
    this.#layer!.gain.setTargetAtTime(
      DOG_AUDIO.layerGain * smoothstep(DOG_AUDIO.wakeRadius, DOG_AUDIO.wakeRadius - 11, nearestDogDist),
      now,
      0.2
    );

    let hadSemanticCue = false;
    let semantic:
      | { dog: DogParkDog; rig: DogRig; cue: DogAudioCue; priority: number }
      | null = null;
    for (const dog of dogs) {
      const rig = this.#rigs.get(dog);
      if (!rig) continue;
      rig.vocalCooldown = Math.max(0, rig.vocalCooldown - dt);
      movePanner(rig.panner, io.ctx, dog.x, dog.group.position.y + 0.3 * dog.style.scale, dog.z);
      rig.send.gain.setTargetAtTime(
        DOG_AUDIO.reverbCharacter * Number(NATURE_AUDIO_TUNING.values.reverb),
        now,
        0.16
      );

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
      if (cue) {
        hadSemanticCue = true;
        const priority =
          (dog.controller === "player" ? 10 : 0) +
          (cue === "return" ? 3 : cue === "chase" ? 2 : 1);
        if (
          dogDist < DOG_AUDIO.wakeRadius &&
          rig.vocalCooldown <= 0 &&
          Math.random() < cueChance(dog, cue) &&
          (!semantic || priority > semantic.priority)
        ) {
          semantic = { dog, rig, cue, priority };
        }
      }
    }
    // A player's own throw wins a same-frame owner/ambient cue and may punch
    // through the park-wide gap. Its per-dog cooldown still prevents chatter.
    if (semantic && (this.#globalVocalCooldown <= 0 || semantic.dog.controller === "player")) {
      this.#vocalize(io, semantic.rig, semantic.dog, semantic.cue, now);
    } else if (!hadSemanticCue) {
      this.#tryAmbientVocal(io, dogs, playerPos, now);
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
    cue: DogVocalMoment,
    now: number
  ): void {
    this.#globalVocalCooldown = DOG_AUDIO.globalVocalGap + Math.random() * 1.5;
    rig.vocalCooldown =
      DOG_AUDIO.dogVocalGapMin +
      Math.random() * (DOG_AUDIO.dogVocalGapMax - DOG_AUDIO.dogVocalGapMin);

    // Catching with a ball in the mouth favors a breathy huff. Chase and return
    // use the authored breed voice so the fundamental interaction always reads.
    const huffChance = cue === "catch" ? 0.78 : cue === "return" ? 0.14 : 0;
    const kind: DogVoiceKind =
      Math.random() < huffChance ? "dogHuff" : dogVoiceForStyle(dog.style.name, dog.style.scale);
    // Do not multiply by the nature "wildlife calls" control: dog barks are
    // interaction SFX and already ride the user's effects volume + master mute.
    const level = kind === "dogHuff" ? 0.52 + Math.random() * 0.1 : 1 + Math.random() * 0.15;
    DOG_VOICE_LIB[kind]({
      ctx: io.ctx,
      out: rig.panner,
      t0: now + 0.02,
      noise: io.noise,
      rng: Math.random,
      level
    });
    this.#vocalCount++;
    this.#cueCounts[cue]++;
    this.#kindCounts[kind]++;
    if (cue === "ambient") {
      this.#ambientCount++;
      this.#ambientTimer = randomBetween(DOG_AUDIO.ambientGapMin, DOG_AUDIO.ambientGapMax);
      this.#lastAmbientDog = dog;
    }
    this.#lastVocal = { dog: dog.style.name, cue, kind };
  }

  /** One shared countdown for the whole audible pack. This avoids four
   * independent dogs each deciding to bark in the same quiet moment. */
  #tryAmbientVocal(
    io: NatureVoiceIO,
    dogs: readonly DogParkDog[],
    playerPos: { x: number; z: number },
    now: number
  ): void {
    if (this.#ambientTimer > 0) return;
    if (this.#globalVocalCooldown > 0) {
      this.#ambientTimer = randomBetween(DOG_AUDIO.ambientRetryMin, DOG_AUDIO.ambientRetryMax);
      return;
    }
    let candidates = dogs.filter((dog) => {
      const rig = this.#rigs.get(dog);
      return Boolean(
        rig &&
          rig.vocalCooldown <= 0 &&
          dog.speed <= DOG_AUDIO.ambientMaxDogSpeed &&
          Math.hypot(dog.x - playerPos.x, dog.z - playerPos.z) < DOG_AUDIO.ambientRadius
      );
    });
    if (candidates.length > 1 && this.#lastAmbientDog) {
      const rotated = candidates.filter((dog) => dog !== this.#lastAmbientDog);
      if (rotated.length) candidates = rotated;
    }
    if (candidates.length === 0) {
      this.#ambientTimer = randomBetween(DOG_AUDIO.ambientRetryMin, DOG_AUDIO.ambientRetryMax);
      return;
    }
    const dog = candidates[Math.min(candidates.length - 1, Math.floor(Math.random() * candidates.length))];
    this.#vocalize(io, this.#rigs.get(dog)!, dog, "ambient", now);
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
    this.#ambientTimer = randomBetween(DOG_AUDIO.ambientFirstGapMin, DOG_AUDIO.ambientFirstGapMax);
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
    panner.refDistance = 12;
    panner.rolloffFactor = 0.65;
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
      // The first interaction after the audio layer wakes must be allowed to
      // speak; the shared global gap handles simultaneous dogs after that.
      vocalCooldown: 0,
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

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function cueChance(dog: DogParkDog, cue: DogAudioCue): number {
  return (dog.controller === "player" ? DOG_AUDIO.playerCueChance : DOG_AUDIO.parkCueChance)[cue];
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
