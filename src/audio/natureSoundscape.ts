// Nature soundscape engine — a modular, multi-region ambient audio layer.
//
// Rides the shared AudioEngine context (engine.ts owns context, gesture unlock,
// group volume/mute, visibility, the ctx.listener camera track, and idle
// suspend). This layer keeps only its own sonic character and drives three
// layers:
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
// this engine is generic over the list. A persistent engine hold keeps the
// shared context running only while the listener is near a region (or a sibling
// layer needs it); released otherwise, so it costs nothing in the city.

import * as THREE from "three/webgpu";
import { tunables } from "../core/persist";
import { soundscapeAudioLevel } from "../core/audioSettings";
import { audioEngine } from "./engine";
import type { NatureBufferResult } from "./natureBuffersWorker";
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
const BED_PARK_SECONDS = 4;
const BED_BUFFER_UNLOAD_SECONDS = 60;
const BED_REGION_UNUSED_UNLOAD_SECONDS = 30;
const BED_REGION_INFLUENCE_THRESHOLD = 0.02;

type Bed = {
  source: AudioBufferSourceNode | null;
  filter: BiquadFilterNode;
  gain: GainNode;
  panLfo: OscillatorNode | null;
  panLfoGain: GainNode | null;
  panner: StereoPannerNode | null;
  send: GainNode;
  level: number;
};

type ActiveVoice = { panner: PannerNode; send: GainNode; expires: number };

export class NatureSoundscape {
  #ctx: AudioContext | null = null;
  #bus!: GainNode; // regional soundscape volume + presence fade
  #worldBus!: GainNode; // presence-independent environmental soundscape
  #alwaysBus!: GainNode; // foreground effects, never nature/presence-faded
  #worldComp!: DynamicsCompressorNode; // world side → engine world group
  #effectsComp!: DynamicsCompressorNode; // effects side → engine effects group
  // Independent leases prevent one optional sibling from suspending the shared
  // context while another is still active. Symbols also let repeated owner
  // labels coexist safely (for example, two simultaneously loaded sites).
  #externalHolds = new Map<symbol, string>();
  #regionalReverbSend!: GainNode;
  #worldReverbSend!: GainNode;
  #effectsReverbSend!: GainNode;
  #regionalConvolver!: ConvolverNode;
  #worldConvolver!: ConvolverNode;
  #effectsConvolver!: ConvolverNode;
  #noise!: AudioBuffer;
  #wind: ProceduralWindSynth | null = null;
  #beds = new Map<BedId, Bed>();
  #bedBuffers = new Map<BedId, AudioBuffer>();
  #voices: ActiveVoice[] = [];
  #loadingBeds = new Map<BedId, symbol>();
  #failedBeds = new Set<BedId>();
  #bedLoadGeneration = 0;
  #bedIdleSeconds = 0;
  #wantedBedMask = 0;
  #bedUnusedSeconds = new Float32Array(BED_IDS.length);
  #bufferPreparation: Promise<void> | null = null;
  #buffersReady = false;
  #holdRelease: (() => void) | null = null; // engine hold while near a region / awake
  #masterLevel = 0;
  #presence = 0;
  #voiceTimer = 0.8;
  #inf = new Float32Array(NATURE_REGIONS.length);
  // debug counters
  #lastKind: NatureVoiceKind | "-" = "-";
  #voiceCount = 0;

  get debugState() {
    return {
      ctx: this.#ctx?.state ?? "none",
      unlocked: audioEngine.unlocked,
      regional: +this.#masterLevel.toFixed(3),
      world: +(this.#worldBus?.gain.value ?? 0).toFixed(3),
      effects: +(this.#alwaysBus?.gain.value ?? 0).toFixed(3),
      presence: +this.#presence.toFixed(3),
      externalHolds: {
        count: this.#externalHolds.size,
        owners: [...this.#externalHolds.values()]
      },
      beds: BED_IDS.map((id) => ({
        id,
        level: +(this.#beds.get(id)?.level ?? 0).toFixed(3),
        wanted: this.#isBedWanted(id),
        loaded: this.#bedBuffers.has(id),
        loading: this.#loadingBeds.has(id),
        running: Boolean(this.#beds.get(id)?.source),
        unusedSeconds: +this.#bedUnusedSeconds[BED_IDS.indexOf(id)].toFixed(1)
      })),
      decodedBedMiB: +(
        [...this.#bedBuffers.values()].reduce(
          (bytes, buffer) => bytes + buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
          0
        ) / (1024 * 1024)
      ).toFixed(1),
      influence: NATURE_REGIONS.map((r, i) => ({ id: r.id, inf: +this.#inf[i].toFixed(3) })),
      activeVoices: this.#voices.length,
      voiceCount: this.#voiceCount,
      lastKind: this.#lastKind
    };
  }

  /** Force-unlock without a gesture (headless tests). Delegates the gate to the
   *  engine, then builds our graph so voiceBus() can go live. */
  async unlock(): Promise<void> {
    await audioEngine.unlock();
    this.#ensure();
  }

  /** Build the lightweight graph early when a caller wants it. Long procedural
   *  buffers are always synthesized in a worker and may arrive after unlock. */
  prewarm(): void {
    const ctx = this.#ensure();
    if (ctx) void this.#prepareBuffers(ctx);
  }

  /** Shared graph taps. `bus` is regional ambience, `worldBus` is environmental
   *  ambience without a nature-region fade, and `alwaysBus` is foreground FX.
   *  Each category has a matching reverb return so mixer sliders never leak. */
  voiceBus():
    | {
        ctx: AudioContext;
        bus: GainNode;
        worldBus: GainNode;
        alwaysBus: GainNode;
        regionalReverbSend: GainNode;
        worldReverbSend: GainNode;
        effectsReverbSend: GainNode;
        noise: AudioBuffer;
      }
    | null {
    // Audio is optional world content. Until a real gesture (or an explicit
    // headless-test unlock) has crossed the browser's audio gate, do not create
    // the context, synth buffers, or fetch/decode the four sampled nature beds.
    // Callers already tolerate a null bus and retry when they are actually live.
    if (!audioEngine.unlocked) return null;
    const ctx = this.#ensure();
    if (!ctx || !this.#buffersReady) return null;
    return {
      ctx,
      bus: this.#bus,
      worldBus: this.#worldBus,
      alwaysBus: this.#alwaysBus,
      regionalReverbSend: this.#regionalReverbSend,
      worldReverbSend: this.#worldReverbSend,
      effectsReverbSend: this.#effectsReverbSend,
      noise: this.#noise
    };
  }

  /** Keep the shared nature graph alive for an independently owned activity.
   *  The returned release function is idempotent. */
  acquireExternalHold(owner: string): () => void {
    const token = Symbol(owner);
    this.#externalHolds.set(token, owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#externalHolds.delete(token);
    };
  }

  update(
    dt: number,
    o: {
      playerPos: { x: number; y: number; z: number };
      camera: THREE.Camera;
      gust: number;
      timeOfDay: number;
      /** Existing ambience may keep mixing, but destination-critical work can
       * defer the first sampled-bed fetch/decode until its visual prime settles. */
      allowNewLoads?: boolean;
    }
  ): void {
    const T = NATURE_AUDIO_TUNING.values;
    const allowed = Boolean(T.enabled) && Number(T.master) > 0.001;

    // ---- region influences + blended character ---------------------------
    let presence = 0;
    let windBias = 0;
    let fog = 0;
    let infSum = 0;
    let wantedBedMask = 0;
    for (let i = 0; i < NATURE_REGIONS.length; i++) {
      const region = NATURE_REGIONS[i];
      const inf = regionInfluence(region, o.playerPos.x, o.playerPos.z);
      this.#inf[i] = inf;
      presence = Math.max(presence, inf);
      if (inf > BED_REGION_INFLUENCE_THRESHOLD) {
        for (let bedIndex = 0; bedIndex < BED_IDS.length; bedIndex++) {
          if ((region.beds[BED_IDS[bedIndex]] ?? 0) > 0) wantedBedMask |= 1 << bedIndex;
        }
      }
      // exposed hilltops: the wind term climbs with the listener's altitude
      const wa = region.windAltitude;
      const lift = wa ? 1 + wa.boost * smooth(wa.y0, wa.y1, o.playerPos.y) : 1;
      windBias += inf * region.character.windBias * lift;
      fog += inf * region.character.fog;
      infSum += inf;
    }
    if (infSum > 0) {
      windBias /= infSum;
      fog /= infSum;
    }
    let ctx = this.#ctx;
    const externallyAwake = this.#externalHolds.size > 0;
    if (!ctx && audioEngine.unlocked && ((allowed && presence > 0.02) || externallyAwake)) {
      ctx = this.#ensure();
    }
    if (!ctx) return;
    // Sampled ambience is first-approach content. A city keydown unlocks the
    // graph and starts worker synthesis, but only fetches/decodes the union of
    // beds declared by regions that are actually influencing the listener.
    if (
      audioEngine.unlocked && allowed && presence > BED_REGION_INFLUENCE_THRESHOLD &&
      Number(T.beds) > 0.001 && wantedBedMask !== 0
    ) {
      this.#wantedBedMask = wantedBedMask;
      this.#bedIdleSeconds = 0;
      this.#updateBedResidency(dt);
      if (o.allowNewLoads !== false) void this.#loadBeds(wantedBedMask);
      this.#startBeds();
    } else {
      this.#wantedBedMask = 0;
      this.#bedIdleSeconds += Math.max(0, dt);
      if (this.#bedIdleSeconds >= BED_PARK_SECONDS) this.#stopBeds();
      if (
        this.#bedIdleSeconds >= BED_BUFFER_UNLOAD_SECONDS &&
        (this.#bedBuffers.size > 0 || this.#loadingBeds.size > 0 || this.#failedBeds.size > 0)
      ) {
        this.#stopBeds(true);
      }
    }

    const targetPresence = allowed ? presence : 0;
    this.#presence = approach(this.#presence, targetPresence, dt, 1.6);

    // Keep the shared engine context running while we — or a sibling layer such
    // as a pet at heel / nearby surf (external leases) — need it. Edge-triggered
    // so we never churn the hold per frame; released otherwise, and the engine
    // suspends once its groups fall quiet. The ctx.listener is the engine's job.
    const wantHold = (allowed && presence > 0.02) || externallyAwake;
    if (wantHold && !this.#holdRelease) this.#holdRelease = audioEngine.acquireHold();
    else if (!wantHold && this.#holdRelease) {
      this.#holdRelease();
      this.#holdRelease = null;
    }

    const windRunning = allowed && Number(T.wind) > 0.001 && presence > 0.02;
    this.#wind?.setRunning(windRunning);

    // The engine owns suspend/resume; until it has the context running there is
    // nothing to mix this frame (our hold makes it resume shortly).
    if (ctx.state !== "running") return;
    this.#reapVoices(ctx.currentTime);

    // #bus carries the region fade (master × presence). #worldBus and #alwaysBus
    // hold constant unity (set in #ensure) — the engine's world/effects groups
    // apply the HUD volume, mute, and visibility, so no *AudioLevel term belongs
    // here (invariant: no double attenuation).
    const targetMaster = allowed ? Number(T.master) * this.#presence : 0;
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
      if (windRunning) {
        this.#wind.update(gust, o.camera, Number(T.wind) * windBias * presence, nearMix);
      }
    }

    // ---- spatial voice scheduler ----------------------------------------
    if (presence > 0.02 && soundscapeAudioLevel() > 0.001 && Number(T.voices) > 0.001) {
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
    for (const v of this.#voices) {
      try {
        v.panner.disconnect();
        v.send.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.#voices.length = 0;
    this.#stopBeds(true);
    for (const bed of this.#beds.values()) {
      bed.filter.disconnect();
      bed.gain.disconnect();
      bed.send.disconnect();
    }
    this.#beds.clear();
    this.#wind?.dispose();
    this.#holdRelease?.();
    this.#holdRelease = null;
    this.#externalHolds.clear();
    // Disconnect our own graph from the engine groups; never close the shared
    // engine context (the engine owns it).
    this.#bus?.disconnect();
    this.#worldBus?.disconnect();
    this.#alwaysBus?.disconnect();
    this.#worldComp?.disconnect();
    this.#effectsComp?.disconnect();
    this.#ctx = null;
  }

  /* --------------------------------------------------------------- guts */

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    // Build pre-gesture under the loading cover: prewarmBus creates the shared
    // context (or returns null under Node) without the unlocked gate. The world
    // side and the effects side land in DIFFERENT engine groups, so the single
    // limiter of old must split into two — one compressor can't feed two group
    // inputs. Same character on both so the sonics don't change.
    const worldSide = audioEngine.prewarmBus("world");
    const effectsSide = audioEngine.prewarmBus("effects");
    if (!worldSide || !effectsSide) return null; // no AudioContext (Node probes)
    const ctx = worldSide.ctx;
    this.#ctx = ctx;
    void this.#prepareBuffers(ctx);

    this.#worldComp = makeNatureComp(ctx);
    this.#worldComp.connect(worldSide.input);
    this.#effectsComp = makeNatureComp(ctx);
    this.#effectsComp.connect(effectsSide.input);

    this.#bus = ctx.createGain();
    this.#bus.gain.value = 0;
    this.#bus.connect(this.#worldComp);

    // Environmental layers such as ocean wash and garden streams belong to the
    // World slider, but manage their own distance fades instead of a nature
    // region. Their bus stays independent of #presence and holds constant unity
    // — the engine world group applies the HUD volume/mute.
    this.#worldBus = ctx.createGain();
    this.#worldBus.gain.value = 1;
    this.#worldBus.connect(this.#worldComp);

    // Presence-independent tap: sibling layers (the dog park's pet at heel) route
    // here so a pet trotting through the city — where region presence and thus
    // #bus are 0 — stays audible. Routes to the engine EFFECTS group via its own
    // compressor; the group applies the HUD FX volume/mute, so this holds unity.
    this.#alwaysBus = ctx.createGain();
    this.#alwaysBus.gain.value = 1;
    this.#alwaysBus.connect(this.#effectsComp);

    // Worker-generated buffers replace these silent fallbacks asynchronously.
    // Audio is allowed to stream in after the gesture; input is never held up.
    const sr = ctx.sampleRate;
    this.#noise = ctx.createBuffer(1, 1, sr);

    // One generated impulse, three returns: regional ambience keeps its
    // presence fade, independent environmental beds use World without that
    // fade, and foreground effects remain isolated from both.
    this.#regionalConvolver = ctx.createConvolver();
    this.#worldConvolver = ctx.createConvolver();
    this.#effectsConvolver = ctx.createConvolver();
    const regionalReverbReturn = ctx.createGain();
    regionalReverbReturn.gain.value = 0.9;
    const worldReverbReturn = ctx.createGain();
    worldReverbReturn.gain.value = 0.9;
    const effectsReverbReturn = ctx.createGain();
    effectsReverbReturn.gain.value = 0.9;
    this.#regionalReverbSend = ctx.createGain();
    this.#regionalReverbSend.gain.value = 1;
    this.#regionalReverbSend
      .connect(this.#regionalConvolver)
      .connect(regionalReverbReturn)
      .connect(this.#bus);
    this.#worldReverbSend = ctx.createGain();
    this.#worldReverbSend.gain.value = 1;
    this.#worldReverbSend
      .connect(this.#worldConvolver)
      .connect(worldReverbReturn)
      .connect(this.#worldBus);
    this.#effectsReverbSend = ctx.createGain();
    this.#effectsReverbSend.gain.value = 1;
    this.#effectsReverbSend
      .connect(this.#effectsConvolver)
      .connect(effectsReverbReturn)
      .connect(this.#alwaysBus);

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
      gain.connect(send).connect(this.#regionalReverbSend);
      this.#beds.set(id, {
        source: null,
        filter,
        gain,
        panLfo: null,
        panLfoGain: null,
        panner: null,
        send,
        level: 0
      });
    }
    return ctx;
  }

  #prepareBuffers(ctx: AudioContext): Promise<void> {
    if (this.#bufferPreparation) return this.#bufferPreparation;
    const task = new Promise<NatureBufferResult>((resolve, reject) => {
      const worker = new Worker(new URL("./natureBuffersWorker.ts", import.meta.url), {
        type: "module"
      });
      const finish = () => worker.terminate();
      worker.onmessage = (event: MessageEvent<NatureBufferResult>) => {
        finish();
        resolve(event.data);
      };
      worker.onerror = (event) => {
        finish();
        reject(new Error(event.message || "nature buffer worker failed"));
      };
      worker.postMessage({ sampleRate: ctx.sampleRate });
    }).then((result) => {
      if (this.#ctx !== ctx || ctx.state === "closed") return;
      const makeBuffer = (channels: readonly ArrayBuffer[]): AudioBuffer => {
        const length = channels[0]?.byteLength ? channels[0].byteLength / Float32Array.BYTES_PER_ELEMENT : 1;
        const buffer = ctx.createBuffer(channels.length, length, ctx.sampleRate);
        channels.forEach((channel, index) => {
          const samples = new Float32Array(channel) as Float32Array<ArrayBuffer>;
          buffer.copyToChannel(samples, index);
        });
        return buffer;
      };
      this.#noise = makeBuffer([result.voiceNoise]);
      const impulse = makeBuffer([result.impulseLeft, result.impulseRight]);
      this.#regionalConvolver.buffer = impulse;
      this.#worldConvolver.buffer = impulse;
      this.#effectsConvolver.buffer = impulse;
      this.#wind?.setNoiseBuffer(makeBuffer([result.windLeft, result.windRight]));
      this.#buffersReady = true;
    }).catch((error) => {
      // Optional ambience may stay silent, but a worker failure must never put
      // procedural buffer loops back on the main/input thread.
      console.warn("[nature-audio] procedural buffers unavailable:", error);
      this.#bufferPreparation = null;
    });
    this.#bufferPreparation = task;
    return task;
  }

  async #loadBeds(wantedMask: number): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    const generation = this.#bedLoadGeneration;
    const tasks: Promise<void>[] = [];
    for (let bedIndex = 0; bedIndex < BED_IDS.length; bedIndex++) {
      if ((wantedMask & (1 << bedIndex)) === 0) continue;
      const id = BED_IDS[bedIndex];
      if (this.#bedBuffers.has(id) || this.#loadingBeds.has(id) || this.#failedBeds.has(id)) continue;
      const token = Symbol(id);
      this.#loadingBeds.set(id, token);
      tasks.push((async () => {
        try {
          try {
            const res = await fetch(BED_FILES[id]);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const arr = await res.arrayBuffer();
            const buf = await ctx.decodeAudioData(arr);
            if (
              this.#ctx === ctx && this.#bedLoadGeneration === generation &&
              this.#loadingBeds.get(id) === token && this.#isBedWanted(id)
            ) {
              this.#bedBuffers.set(id, buf);
            }
          } catch (err) {
            if (this.#bedLoadGeneration === generation && this.#loadingBeds.get(id) === token) {
              this.#failedBeds.add(id);
            }
            console.warn(`[nature-audio] bed failed: ${id}`, err);
          }
        } finally {
          if (this.#loadingBeds.get(id) === token) this.#loadingBeds.delete(id);
        }
      })());
    }
    if (tasks.length === 0) return;
    await Promise.all(tasks);
    if (audioEngine.unlocked && this.#wantedBedMask !== 0) this.#startBeds();
  }

  #startBeds(): void {
    const ctx = this.#ctx;
    if (!ctx || !audioEngine.unlocked || this.#wantedBedMask === 0) return;
    for (let bedIndex = 0; bedIndex < BED_IDS.length; bedIndex++) {
      if ((this.#wantedBedMask & (1 << bedIndex)) === 0) continue;
      const id = BED_IDS[bedIndex];
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
      bed.panLfoGain = lg;
      bed.panner = panner;
    }
  }

  #isBedWanted(id: BedId): boolean {
    const index = BED_IDS.indexOf(id);
    return index >= 0 && (this.#wantedBedMask & (1 << index)) !== 0;
  }

  #updateBedResidency(dt: number): void {
    const safeDt = Math.max(0, dt);
    for (let bedIndex = 0; bedIndex < BED_IDS.length; bedIndex++) {
      if ((this.#wantedBedMask & (1 << bedIndex)) !== 0) {
        this.#bedUnusedSeconds[bedIndex] = 0;
        continue;
      }
      const previous = this.#bedUnusedSeconds[bedIndex];
      const next = previous + safeDt;
      this.#bedUnusedSeconds[bedIndex] = next;
      if (previous < BED_PARK_SECONDS && next >= BED_PARK_SECONDS) {
        this.#stopBed(BED_IDS[bedIndex]);
      }
      if (previous < BED_REGION_UNUSED_UNLOAD_SECONDS && next >= BED_REGION_UNUSED_UNLOAD_SECONDS) {
        this.#stopBed(BED_IDS[bedIndex], true);
      }
    }
  }

  #stopBed(id: BedId, releaseBuffer = false): void {
    const bed = this.#beds.get(id);
    if (bed) {
      try { bed.source?.stop(); } catch { /* already stopped */ }
      try { bed.panLfo?.stop(); } catch { /* already stopped */ }
      bed.source?.disconnect();
      bed.panLfo?.disconnect();
      bed.panLfoGain?.disconnect();
      bed.panner?.disconnect();
      bed.source = null;
      bed.panLfo = null;
      bed.panLfoGain = null;
      bed.panner = null;
      bed.level = 0;
      const now = this.#ctx?.currentTime ?? 0;
      bed.gain.gain.cancelScheduledValues(now);
      bed.gain.gain.setValueAtTime(0, now);
    }
    if (!releaseBuffer) return;
    this.#loadingBeds.delete(id);
    this.#failedBeds.delete(id);
    this.#bedBuffers.delete(id);
  }

  #stopBeds(releaseBuffers = false): void {
    if (!releaseBuffers && ![...this.#beds.values()].some((bed) => bed.source || bed.panLfo)) return;
    for (const id of BED_IDS) this.#stopBed(id, releaseBuffers);
    if (!releaseBuffers) return;
    this.#bedLoadGeneration++;
    this.#loadingBeds.clear();
    this.#failedBeds.clear();
    this.#bedBuffers.clear();
    this.#bedUnusedSeconds.fill(0);
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
    panner.connect(send).connect(this.#regionalReverbSend);

    const level = Number(NATURE_AUDIO_TUNING.values.voices) * (0.7 + Math.random() * 0.35);
    const dur = VOICE_LIB[kind]({ ctx, out: panner, t0: now + 0.02, noise: this.#noise, rng: Math.random, level });
    // Keep the shared ctx alive past this spatial one-shot's scheduled tail even
    // if presence dips and our hold releases mid-call.
    audioEngine.touch(dur + 2.6);
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

/** The nature-side limiter, one instance per engine group we feed. */
function makeNatureComp(ctx: AudioContext): DynamicsCompressorNode {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = -14;
  c.knee.value = 22;
  c.ratio.value = 5;
  c.attack.value = 0.005;
  c.release.value = 0.35;
  return c;
}

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
