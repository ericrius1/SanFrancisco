import * as THREE from "three/webgpu";
import { musicAudioLevel } from "../../core/audioSettings";
import { audioEngine } from "../../audio/engine";
import type { BuskerId, MusicianAudio } from "./types";

/**
 * The trio's audio core: three spatial HRTF panners (one per musician, placed
 * at their seat) into a shared "off the mountains" reverb and a safety
 * compressor. Live, the graph rides the shared AudioEngine music group — the
 * engine owns the context, the gesture unlock, the HUD music volume/mute, the
 * visibility policy, the ctx.listener camera track and idle suspend. This
 * module keeps only its own sonic character and an engine hold while the
 * listener is within earshot. Offline (film render) the same graph is built on
 * an injected OfflineAudioContext straight to its destination.
 *
 * Musicians never see any of this — they get a `{ctx, out}` tap
 * (MusicianAudio) and connect self-cleaning voices to it.
 */

const AUDIBLE_RADIUS = 80; // inside this we hold the engine ctx alive
const AUDIBLE_TAIL = 4; // seconds of engine hold slack when leaving earshot (reverb tail)

export class TrioAudio {
  #ctx: AudioContext | null = null;
  #offline = false; // injected OfflineAudioContext (film render) vs live engine
  #master: GainNode | null = null;
  #comp: DynamicsCompressorNode | null = null; // final mix node (post master + reverb)
  #reverbIn: GainNode | null = null; // shared wet bus → convolver → master
  #convolver: ConvolverNode | null = null;
  #captureDest: MediaStreamAudioDestinationNode | null = null;
  #channels = new Map<BuskerId, {
    tap: MusicianAudio;
    gain: GainNode | null;
    panner: PannerNode | null;
    reverb: GainNode | null;
    position: [number, number, number];
  }>();
  #impulseWorker: Worker | null = null;
  #holdRelease: (() => void) | null = null; // engine hold while inside earshot
  #inRange = false; // listener within AUDIBLE_RADIUS (gates scheduling in index.ts)
  /** Force master gain to 0 (film cue: kill mid-song tails before the next pass). */
  #holdSilent = false;

  /** Null when Web Audio is unavailable (headless test contexts). */
  get ctx(): AudioContext | null {
    return this.#ctx;
  }

  get running(): boolean {
    // In-range gate so index.ts stops scheduling when the listener leaves the
    // radius, even though the shared engine ctx may keep running for other
    // features (music/effects/world all share it now).
    return this.#inRange && this.#ctx?.state === "running";
  }

  /**
   * A live MediaStream of the trio's FINAL mix — the compressor output, so it
   * carries the master gain, the shared "off the mountains" reverb, everything.
   * The compressor is the trio's OWN pre-engine mix node: it feeds the engine
   * music group (live) but the tap sits before it, so the capture is the trio
   * alone, never other app audio riding the same shared context. Lazily taps a
   * MediaStreamAudioDestinationNode off the compressor (cached; the compressor
   * keeps feeding its normal output unchanged). The render tool records this
   * with MediaRecorder in a realtime pass. Null when Web Audio is unavailable
   * (headless test contexts).
   */
  captureStream(): MediaStream | null {
    this.#ensureLiveContext();
    const ctx = this.#ctx;
    const comp = this.#comp;
    if (!ctx || !comp) return null;
    if (!this.#captureDest) {
      this.#captureDest = ctx.createMediaStreamDestination();
      comp.connect(this.#captureDest);
    }
    return this.#captureDest.stream;
  }

  /** Mute the trio until the next playing phase (or an explicit clear). */
  holdSilent(on: boolean) {
    this.#holdSilent = on;
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    // Immediate cut — setTargetAtTime alone left audible tails through the Q gap.
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(on ? 0 : this.#masterOpen(), t);
    // Gate the wet bus too so the convolver can't spit a leftover hall into the
    // unmute that starts the next song.
    const reverbIn = this.#reverbIn;
    if (reverbIn) {
      reverbIn.gain.cancelScheduledValues(t);
      reverbIn.gain.setValueAtTime(on ? 0 : 1, t);
    }
  }

  /**
   * @param injectedCtx when supplied (an OfflineAudioContext for the
   * deterministic film render — see offlineRender.ts), the whole graph is built
   * on it, straight to its destination, instead of the live engine music group.
   * The capture-stream path is never exercised offline, so the identical build
   * works unchanged. Omit it and the live game lazily rides the shared
   * AudioEngine music bus once a gesture unlocks it.
   */
  constructor(injectedCtx?: BaseAudioContext) {
    if (injectedCtx) {
      // OfflineAudioContext exposes every create*/gain method the graph uses;
      // the AudioContext-only bits (createMediaStreamDestination) are simply
      // never called offline. The offline graph feeds its own destination — no
      // engine group offline — and holdSilent() bakes musicAudioLevel() into the
      // master so a rendered film keeps its absolute loudness.
      this.#offline = true;
      const ctx = injectedCtx as unknown as AudioContext;
      this.#initialize(ctx, true, ctx.destination);
    }
  }

  /** The master trim opened by holdSilent(false). Offline bakes the HUD music
   *  level in (no engine group to apply it); live holds unity and lets the
   *  engine music group apply musicAudioLevel()/mute/visibility. */
  #masterOpen(): number {
    return this.#offline ? musicAudioLevel() : 1;
  }

  #ensureLiveContext(): void {
    if (this.#ctx) return;
    // The engine owns the context and the gesture gate: bus() is null until the
    // first user gesture unlocks it (same tolerated contract as before). Distance
    // gating in update() ensures a distant trio still costs nothing.
    const bus = audioEngine.bus("music");
    if (!bus) return;
    this.#initialize(bus.ctx, false, bus.input);
  }

  #initialize(ctx: AudioContext, synchronousImpulse: boolean, output: AudioNode): void {
    this.#ctx = ctx;
    const master = ctx.createGain();
    // Honor the current film-cue gate: the ctx can be created AFTER a
    // holdSilent()/phase call (e.g. restored state), and there is no per-frame
    // master re-assertion anymore, so open (or hold silent) it right here.
    master.gain.value = this.#holdSilent ? 0 : this.#masterOpen();
    // gentle safety compressor so three simultaneous voices can't clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 14;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.24;
    // Live: comp → engine music group input. Offline: comp → ctx.destination.
    // The capture tap sits on comp, so it is the trio's pre-engine mix node.
    master.connect(comp).connect(output);
    this.#master = master;
    this.#comp = comp;

    // "off the mountains" reverb: a synthetic exponential-decay impulse (a
    // long, slightly bright hall — the summit air), shared by all three
    // musicians. Voices send a wet fraction into #reverbIn; the convolved
    // return rejoins the master DOWNSTREAM of the panners, so the tail reads
    // as diffuse, non-localized reflection rather than a point source.
    const reverbIn = ctx.createGain();
    reverbIn.gain.value = 1;
    const convolver = ctx.createConvolver();
    if (synchronousImpulse) convolver.buffer = buildImpulse(ctx, 2.7, 3.2);
    else this.#buildImpulseOffThread(ctx, convolver, 2.7, 3.2);
    const wetReturn = ctx.createGain();
    wetReturn.gain.value = 0.9;
    reverbIn.connect(convolver).connect(wetReturn).connect(master);
    this.#reverbIn = reverbIn;
    this.#convolver = convolver;
    for (const [id, channel] of this.#channels) this.#materializeChannel(id, channel);
  }

  #buildImpulseOffThread(
    ctx: AudioContext,
    convolver: ConvolverNode,
    seconds: number,
    decay: number
  ): void {
    try {
      const worker = new Worker(new URL("./audioImpulseWorker.ts", import.meta.url), { type: "module" });
      this.#impulseWorker = worker;
      worker.onmessage = (event: MessageEvent<{ left: Float32Array; right: Float32Array }>) => {
        worker.terminate();
        if (this.#impulseWorker === worker) this.#impulseWorker = null;
        if (this.#ctx !== ctx || this.#convolver !== convolver) return;
        const { left, right } = event.data;
        const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
        buffer.getChannelData(0).set(left);
        buffer.getChannelData(1).set(right);
        convolver.buffer = buffer;
      };
      worker.onerror = () => {
        worker.terminate();
        if (this.#impulseWorker === worker) this.#impulseWorker = null;
        // Dry audio is a quality-safe fallback; never block play on reverb.
      };
      worker.postMessage({ sampleRate: ctx.sampleRate, seconds, decay });
    } catch {
      // Worker creation can be unavailable in restrictive embeds. Keep dry mix.
    }
  }

  /** The per-musician tap. Creates the spatial chain on first request. */
  channel(id: BuskerId): MusicianAudio | null {
    let ch = this.#channels.get(id);
    if (!ch) {
      const tap = {
        ctx: null as unknown as AudioContext,
        out: null as unknown as GainNode,
        reverb: null as unknown as GainNode
      };
      ch = { tap, gain: null, panner: null, reverb: null, position: [0, 0, 0] };
      this.#channels.set(id, ch);
      if (this.#ctx) this.#materializeChannel(id, ch);
    }
    return ch.tap;
  }

  #materializeChannel(
    _id: BuskerId,
    channel: {
      tap: MusicianAudio;
      gain: GainNode | null;
      panner: PannerNode | null;
      reverb: GainNode | null;
      position: [number, number, number];
    }
  ): void {
    const ctx = this.#ctx;
    const master = this.#master;
    const reverbIn = this.#reverbIn;
    if (!ctx || !master || !reverbIn || channel.gain) return;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 7;
    panner.rolloffFactor = 1.05;
    panner.maxDistance = 140;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(panner).connect(master);
    const reverb = ctx.createGain();
    reverb.gain.value = 1;
    reverb.connect(reverbIn);
    channel.gain = gain;
    channel.panner = panner;
    channel.reverb = reverb;
    channel.tap.ctx = ctx;
    channel.tap.out = gain;
    channel.tap.reverb = reverb;
    const [x, y, z] = channel.position;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else {
      (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
  }

  /** World position of a musician's sound source (chest height at the seat). */
  setChannelPosition(id: BuskerId, x: number, y: number, z: number) {
    const ch = this.#channels.get(id);
    if (!ch) return;
    ch.position = [x, y, z];
    const ctx = this.#ctx;
    const p = ch.panner;
    if (!ctx || !p) return;
    if (p.positionX) {
      const t = ctx.currentTime;
      p.positionX.setTargetAtTime(x, t, 0.05);
      p.positionY.setTargetAtTime(y, t, 0.05);
      p.positionZ.setTargetAtTime(z, t, 0.05);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
  }

  /**
   * Per-frame distance lifecycle. `distance` = camera → platform centre. The
   * engine owns the ctx.listener camera track and the HUD music volume/mute, so
   * this only holds the engine ctx alive while inside earshot (edge-triggered so
   * we never churn the hold per frame) and drops it outside — which lets index.ts
   * stop scheduling (via `running`) and lets the engine suspend once quiet. The
   * `#holdSilent` film cue still hard-zeros the master in holdSilent().
   */
  update(_camera: THREE.Camera, distance: number, _elapsed: number) {
    const inside = distance <= AUDIBLE_RADIUS;
    if (inside && !this.#ctx) this.#ensureLiveContext();
    this.#inRange = inside;

    if (inside && !this.#holdRelease) {
      this.#holdRelease = audioEngine.acquireHold();
    } else if (!inside && this.#holdRelease) {
      // Cover any in-flight scheduled notes / reverb tail past the hold release.
      audioEngine.touch(AUDIBLE_TAIL);
      this.#holdRelease();
      this.#holdRelease = null;
    }
  }

  dispose() {
    this.#impulseWorker?.terminate();
    this.#impulseWorker = null;
    this.#holdRelease?.();
    this.#holdRelease = null;
    for (const ch of this.#channels.values()) {
      ch.gain?.disconnect();
      ch.panner?.disconnect();
      ch.reverb?.disconnect();
    }
    this.#channels.clear();
    this.#master?.disconnect();
    this.#comp?.disconnect();
    this.#reverbIn?.disconnect();
    this.#convolver?.disconnect();
    this.#captureDest?.disconnect();
    // Disconnect our own nodes only; never close the shared engine context (the
    // engine owns it) — and the offline OfflineAudioContext has no close() anyway.
    this.#ctx = null;
    this.#master = null;
    this.#comp = null;
    this.#reverbIn = null;
    this.#convolver = null;
    this.#captureDest = null;
  }
}

/** Build a stereo exponential-decay noise impulse response — a cheap, warm
 * synthetic hall. `seconds` = tail length, `decay` = how fast it dies (bigger
 * = tighter). Slightly gentler on the highs so the flute echo stays soft, not
 * hissy. */
function buildImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, decay);
      const white = Math.random() * 2 - 1;
      lp += 0.42 * (white - lp); // one-pole lowpass — softens the tail
      data[i] = lp * env;
    }
  }
  return buf;
}
