// One-shot baked phrase player for the hybrid conductor. Phrases fetch and
// decode on first request (nothing at boot), stay in a small cache while the
// score is active, and unload after a long melodic silence. Transposition to
// the current key rides playbackRate — the slight tape-speed drift is part of
// the lo-fi character.

import { PHRASE_DEFS, type PhraseDef } from "./phraseManifest";

const UNLOAD_AFTER_IDLE = 120; // seconds without any phrase

export class PhrasePlayer {
  #ctx: AudioContext;
  #bus: GainNode;
  #send: GainNode;
  #buffers = new Map<string, AudioBuffer>();
  #loading = new Set<string>();
  #failed = new Set<string>();
  #idleSeconds = 0;
  #playedCount = 0;
  #lastId = "-";

  constructor(ctx: AudioContext, destination: AudioNode, revSend: AudioNode) {
    this.#ctx = ctx;
    this.#bus = ctx.createGain();
    this.#bus.gain.value = 0;
    this.#bus.connect(destination);
    this.#send = ctx.createGain();
    this.#send.gain.value = 0.55;
    this.#bus.connect(this.#send).connect(revSend);
  }

  get debugState() {
    return {
      played: this.#playedCount,
      last: this.#lastId,
      cached: [...this.#buffers.keys()],
      loading: [...this.#loading],
      failed: [...this.#failed]
    };
  }

  setGain(target: number, now: number): void {
    this.#bus.gain.setTargetAtTime(target, now, 1.2);
  }

  /** Whether a phrase is decoded and would sound immediately on trigger(). */
  isReady(id: string): boolean {
    return this.#buffers.has(id);
  }

  /**
   * Schedule `def` at ctx-time `when`, transposed by `semitones`. Returns true
   * if it sounded; false kicks off the fetch — the caller retries at a later
   * chord boundary, so a phrase is never late-started mid-harmony.
   */
  trigger(def: PhraseDef, when: number, semitones: number, vel: number): boolean {
    const buf = this.#buffers.get(def.id);
    if (!buf) {
      void this.#ensure(def);
      return false;
    }
    const rate = Math.pow(2, semitones / 12);
    const src = this.#ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = this.#ctx.createGain();
    gain.gain.value = vel * def.gainTrim;
    src.connect(gain).connect(this.#bus);
    src.onended = () => {
      try {
        src.disconnect();
        gain.disconnect();
      } catch {
        /* already gone */
      }
    };
    src.start(when);
    this.#idleSeconds = 0;
    this.#playedCount++;
    this.#lastId = def.id;
    return true;
  }

  update(dt: number): void {
    this.#idleSeconds += Math.max(0, dt);
    if (this.#idleSeconds >= UNLOAD_AFTER_IDLE && (this.#buffers.size > 0 || this.#failed.size > 0)) {
      this.#buffers.clear();
      this.#failed.clear(); // quiet spell over — future approaches may retry
    }
  }

  dispose(): void {
    this.#buffers.clear();
    this.#loading.clear();
    this.#bus.disconnect();
    this.#send.disconnect();
  }

  async #ensure(def: PhraseDef): Promise<void> {
    if (this.#loading.has(def.id) || this.#failed.has(def.id)) return;
    this.#loading.add(def.id);
    try {
      const res = await fetch(def.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await this.#ctx.decodeAudioData(await res.arrayBuffer());
      this.#buffers.set(def.id, buf);
    } catch (error) {
      this.#failed.add(def.id);
      console.warn(`[lofi-music] phrase failed: ${def.id}`, error);
    } finally {
      this.#loading.delete(def.id);
    }
  }
}

export { PHRASE_DEFS };
