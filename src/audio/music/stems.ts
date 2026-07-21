// Baked-stem vertical remixer. Each stem is a small looping MP3 (manifest in
// ./stemManifest) fetched and decoded ONLY once its target gain first rises —
// nothing loads at boot, and buffers unload again after a long quiet spell
// (mirrors the nature-bed residency contract).
//
// Looping never uses source.loop: MP3 encoder padding would open a gap at
// every wrap. Instead the player schedules a fresh overlapping source every
// `loopSeconds`, skipping the decoded lead-in (found by transient scan for
// percussive stems), so tails ring across the seam and the groove stays
// sample-tight.

import { STEM_DEFS, STEM_IDS, type StemDef, type StemId } from "./stemManifest";

const SCHEDULE_HORIZON = 2.5; // seconds of scheduled lookahead
const STOP_AFTER_QUIET = 4; // stop sources once the fade has fully settled
const UNLOAD_AFTER_QUIET = 60; // release decoded buffers

type StemState = {
  def: StemDef;
  gain: GainNode;
  buffer: AudioBuffer | null;
  loadToken: symbol | null;
  failed: boolean;
  lead: number;
  nextStartT: number;
  target: number;
  quietSeconds: number;
  sources: Set<AudioBufferSourceNode>;
};

export class StemPlayer {
  #ctx: AudioContext;
  #stems = new Map<StemId, StemState>();

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.#ctx = ctx;
    for (const id of STEM_IDS) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(destination);
      this.#stems.set(id, {
        def: STEM_DEFS[id],
        gain,
        buffer: null,
        loadToken: null,
        failed: false,
        lead: 0,
        nextStartT: 0,
        target: 0,
        quietSeconds: 0,
        sources: new Set()
      });
    }
  }

  get debugState() {
    return STEM_IDS.map((id) => {
      const s = this.#stems.get(id)!;
      return {
        id,
        target: +s.target.toFixed(3),
        loaded: Boolean(s.buffer),
        loading: Boolean(s.loadToken),
        failed: s.failed,
        activeSources: s.sources.size,
        lead: +s.lead.toFixed(4)
      };
    });
  }

  setTarget(id: StemId, target: number): void {
    this.#stems.get(id)!.target = target;
  }

  muteAll(): void {
    for (const s of this.#stems.values()) s.target = 0;
  }

  update(dt: number, now: number): void {
    for (const s of this.#stems.values()) {
      s.gain.gain.setTargetAtTime(s.target * s.def.gainTrim, now, 0.9);
      if (s.target > 0.004) {
        s.quietSeconds = 0;
        if (!s.buffer && !s.loadToken && !s.failed) void this.#load(s);
        if (s.buffer) this.#schedule(s, now);
        continue;
      }
      s.quietSeconds += Math.max(0, dt);
      if (s.quietSeconds >= STOP_AFTER_QUIET && s.sources.size > 0) this.#stopSources(s);
      if (s.quietSeconds >= UNLOAD_AFTER_QUIET && (s.buffer || s.failed)) {
        this.#stopSources(s);
        s.buffer = null;
        s.failed = false; // a later approach may retry (transient network faults)
      }
    }
  }

  dispose(): void {
    for (const s of this.#stems.values()) {
      this.#stopSources(s);
      s.gain.disconnect();
      s.buffer = null;
      s.loadToken = null;
    }
  }

  #schedule(s: StemState, now: number): void {
    if (s.nextStartT < now - 0.05) s.nextStartT = now + 0.06;
    while (s.nextStartT < now + SCHEDULE_HORIZON) {
      const src = this.#ctx.createBufferSource();
      src.buffer = s.buffer;
      src.connect(s.gain);
      src.start(s.nextStartT, s.lead);
      src.onended = () => {
        s.sources.delete(src);
        try {
          src.disconnect();
        } catch {
          /* already gone */
        }
      };
      s.sources.add(src);
      s.nextStartT += s.def.loopSeconds;
    }
  }

  #stopSources(s: StemState): void {
    for (const src of s.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
    }
    s.sources.clear();
    s.nextStartT = 0;
  }

  async #load(s: StemState): Promise<void> {
    const token = Symbol(s.def.id);
    s.loadToken = token;
    try {
      const res = await fetch(s.def.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.arrayBuffer();
      const buf = await this.#ctx.decodeAudioData(arr);
      if (s.loadToken !== token) return; // unloaded/disposed while decoding
      s.lead = s.def.detectLead ? detectLead(buf) : 0;
      s.buffer = buf;
    } catch (error) {
      if (s.loadToken === token) s.failed = true;
      console.warn(`[lofi-music] stem failed: ${s.def.id}`, error);
    } finally {
      if (s.loadToken === token) s.loadToken = null;
    }
  }
}

/** Seconds of decoder padding/silence before the first transient (cap 250 ms). */
function detectLead(buf: AudioBuffer): number {
  const ch = buf.getChannelData(0);
  const limit = Math.min(ch.length, Math.floor(buf.sampleRate * 0.25));
  for (let i = 0; i < limit; i++) {
    if (Math.abs(ch[i]) > 0.02) return i / buf.sampleRate;
  }
  return 0;
}
