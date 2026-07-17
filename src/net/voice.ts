import type * as THREE from "three/webgpu";
import { tunables } from "../core/persist";
import { voiceAudioLevel } from "../core/audioSettings";
import { audioEngine } from "../audio/engine";
import type { Net } from "./net";

/**
 * Voice chat: WebRTC peer-to-peer audio, signaled through the existing
 * presence relay (net.sendRtc / net.onRtc — the server just forwards
 * {t:"rtc"} frames to one peer). Voice packets themselves never touch the
 * server.
 *
 * Who you hear: the closest `audibleCount` players, at full volume, at ANY
 * distance — no proximity falloff. Hearing is kept mutual: a link also forms
 * when YOU are in the other player's closest set, so two friends always hear
 * each other even if one of them is surrounded by strangers. Links drop only
 * after a peer has been outside both closest-sets for a linger window, so
 * players trading ranks don't churn connections.
 *
 * Signaling avoids glare entirely: the LOWER id owns the offer. It creates the
 * connection with a sendrecv audio transceiver (which fires
 * negotiationneeded → offer); the higher id only ever creates a connection in
 * response to an incoming signal, adopts the transceiver that
 * setRemoteDescription(offer) creates, and answers. Mic on/off is
 * sender.replaceTrack(track|null) on that one m-line — never a renegotiation.
 *
 * Playback: per peer, remote MediaStream → hidden muted <audio> element
 * (Chrome quirk: a MediaStreamAudioSourceNode is silent unless the stream is
 * also attached to a playing media element) → compressor (levels quiet mics
 * up toward a consistent loudness) → GainNode → the shared AudioEngine's
 * "voice" group input (the group applies the HUD voice volume/mute).
 * Deliberately non-spatial: intelligibility beats immersion for chat.
 *
 * The engine owns the ctx and its gesture unlock — a listen-only player's
 * first input opens it, no local resume plumbing needed. A background engine
 * hold (acquired while the mic is on or any peer is wired) keeps the ctx
 * running even while the tab is hidden — voice chat is a social feature.
 *
 * Privacy: mic off = track stopped and stream released (browser mic indicator
 * turns off), not just muted.
 */

export const VOICE_TUNING = tunables("voice", {
  volume: { v: 1, min: 0, max: 2, step: 0.05, label: "voice volume" },
  audibleCount: { v: 3, min: 1, max: 8, step: 1, label: "hear closest N players" }
});

const LINGER_MS = 10_000; // keep a link this long after it leaves both closest-sets
const SCAN_MS = 1000; // roster scan cadence
const MAX_PEERS = 8; // uplink cap: mic is re-encoded per peer (~32 kbps each)
const RETRY_MS = 5000; // wait after a failed connection before re-offering
const SPEAK_RMS = 0.015; // analyser RMS above this = "speaking"
const SPEAK_HOLD_MS = 250; // indicator hold so it doesn't flicker between words
const VOICE_BOOST = 1.35; // makeup on top of the compressor so voices sit above the world bed

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

type Peer = {
  id: number;
  pc: RTCPeerConnection;
  polite: boolean; // higher id yields (only lower id ever offers first)
  audioEl: HTMLAudioElement | null;
  compressor: DynamicsCompressorNode | null;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  analyserBuf: Float32Array<ArrayBuffer> | null;
  unwantedSince: number; // performance.now() when it left both closest-sets; 0 = wanted
  speakingUntil: number;
};

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  // TURN slot for symmetric-NAT pairs — just env vars when/if ever needed
  const url = import.meta.env.VITE_TURN_URL as string | undefined;
  if (url) {
    servers.push({
      urls: url,
      username: (import.meta.env.VITE_TURN_USER as string) ?? "",
      credential: (import.meta.env.VITE_TURN_CRED as string) ?? ""
    });
  }
  return servers;
}

export class Voice {
  micOn = false;
  onMicChange: (on: boolean) => void = () => {};
  /** Speaking-state edges, for the name-tag indicator. */
  onSpeaking: (id: number, speaking: boolean) => void = () => {};

  #net: Net;
  #posOf: (id: number) => THREE.Vector3 | null;
  #selfPos: () => THREE.Vector3;
  #peers = new Map<number, Peer>();
  // One background engine hold, live while the mic is on OR ≥1 peer is wired.
  #hold: (() => void) | null = null;
  #micStream: MediaStream | null = null;
  #micTrack: MediaStreamTrack | null = null;
  #scanAt = 0;
  #retryAt = new Map<number, number>(); // failed peers wait out RETRY_MS

  constructor(net: Net, posOf: (id: number) => THREE.Vector3 | null, selfPos: () => THREE.Vector3) {
    this.#net = net;
    this.#posOf = posOf;
    this.#selfPos = selfPos;
    net.onRtc = (from, payload) => void this.#handleSignal(from, payload as Signal);
  }

  /* ---------------------------------------------------------------- mic */

  /** Toggle the microphone. Resolves false if permission was denied. */
  async setMic(on: boolean): Promise<boolean> {
    if (on === this.micOn) return true;
    if (on) {
      // Toggling the mic IS a user gesture: open the engine gate even if this is
      // somehow the first interaction. getUserMedia below is itself gesture-gated.
      void audioEngine.unlock();
      try {
        this.#micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } catch {
        return false; // denied or no device
      }
      this.#micTrack = this.#micStream.getAudioTracks()[0] ?? null;
      this.micOn = true;
    } else {
      this.#micTrack?.stop(); // releases the device (browser mic indicator off)
      this.#micTrack = null;
      this.#micStream = null;
      this.micOn = false;
    }
    this.#refreshHold();
    for (const p of this.#peers.values()) this.#attachMic(p);
    this.onMicChange(this.micOn);
    return true;
  }

  /**
   * Hold the shared context alive (background: true → survives tab-hidden) while
   * the mic is on or any peer is wired; release when both are gone. Edge-
   * triggered from setMic and from peer add/drop — never per frame.
   */
  #refreshHold() {
    const want = this.micOn || this.#peers.size > 0;
    if (want && !this.#hold) this.#hold = audioEngine.acquireHold({ background: true });
    else if (!want && this.#hold) {
      this.#hold();
      this.#hold = null;
    }
  }

  /** Put the current mic track (or silence) on a peer's one audio m-line. */
  #attachMic(p: Peer) {
    const tr = p.pc.getTransceivers()[0];
    if (!tr) return; // polite peer before the offer arrived — adopted in #handleSignal
    tr.direction = "sendrecv";
    void tr.sender.replaceTrack(this.#micTrack).catch(() => {});
  }

  /* ------------------------------------------------------------- peers */

  #createPeer(id: number, withTransceiver: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const p: Peer = {
      id,
      pc,
      polite: this.#net.selfId > id,
      audioEl: null,
      compressor: null,
      gain: null,
      analyser: null,
      analyserBuf: null,
      unwantedSince: 0,
      speakingUntil: 0
    };
    this.#peers.set(id, p);
    this.#refreshHold(); // first peer wires the shared ctx (resumes once unlocked)

    pc.onicecandidate = (e) => this.#net.sendRtc(id, { candidate: e.candidate?.toJSON() ?? null });
    pc.onnegotiationneeded = async () => {
      // only ever fires on the offerer (lower id) — the answerer never adds
      // transceivers or tracks, so no glare is possible
      try {
        await pc.setLocalDescription();
        if (pc.localDescription) this.#net.sendRtc(id, { description: pc.localDescription.toJSON() });
      } catch {
        /* pc torn down mid-negotiation */
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.#retryAt.set(id, performance.now() + RETRY_MS);
        this.drop(id);
      }
    };
    pc.ontrack = (e) => this.#wireAudio(p, e.streams[0] ?? new MediaStream([e.track]));

    if (withTransceiver) {
      pc.addTransceiver("audio", { direction: "sendrecv" }); // fires negotiationneeded
      this.#attachMic(p);
    }
    return p;
  }

  /** Remote stream → hidden <audio> (Chrome quirk) → compressor → gain → voice group. */
  #wireAudio(p: Peer, stream: MediaStream) {
    // prewarmBus (not bus()) so the receive graph builds even when a remote
    // track arrives before any local gesture — audibility stays gated by the
    // engine's voice group gain and the suspended ctx; the background hold
    // resumes it once unlocked.
    const bus = audioEngine.prewarmBus("voice");
    if (!bus) return;
    const ctx = bus.ctx;
    if (!p.audioEl) {
      p.audioEl = new Audio();
      p.audioEl.muted = true; // WebAudio does the audible playback
    }
    p.audioEl.srcObject = stream;
    void p.audioEl.play().catch(() => {}); // muted play is allowed pre-gesture
    p.compressor?.disconnect();
    p.gain?.disconnect();
    p.analyser?.disconnect();
    const src = ctx.createMediaStreamSource(stream);
    // Voice leveler: browser AGC output varies a lot between mics; squash the
    // dynamics so quiet talkers come through, then make up the level in #gain.
    p.compressor = new DynamicsCompressorNode(ctx, {
      threshold: -30,
      knee: 15,
      ratio: 6,
      attack: 0.003,
      release: 0.2
    });
    p.gain = ctx.createGain();
    // No voiceAudioLevel() here — the engine's voice group gain applies it.
    p.gain.gain.value = VOICE_TUNING.values.volume * VOICE_BOOST;
    p.analyser = ctx.createAnalyser();
    p.analyser.fftSize = 256;
    p.analyserBuf = new Float32Array(p.analyser.fftSize);
    src.connect(p.compressor).connect(p.gain).connect(bus.input);
    src.connect(p.analyser); // parallel tap, pre-gain, for the speaking indicator
  }

  async #handleSignal(from: number, sig: Signal) {
    if (!sig || typeof sig !== "object") return;
    // reactive path: the higher id builds its side when the offer arrives
    const p = this.#peers.get(from) ?? this.#createPeer(from, false);
    try {
      if (sig.description) {
        await p.pc.setRemoteDescription(sig.description);
        if (sig.description.type === "offer") {
          this.#attachMic(p); // adopt the transceiver the offer just created
          await p.pc.setLocalDescription();
          if (p.pc.localDescription) this.#net.sendRtc(from, { description: p.pc.localDescription.toJSON() });
        }
      } else if (sig.candidate !== undefined) {
        if (sig.candidate) await p.pc.addIceCandidate(sig.candidate);
      }
    } catch {
      /* stale signal for a torn-down pc — the scan will re-establish */
    }
  }

  /** Tear down one peer (left the closest-sets, left the server, or ICE failed). */
  drop(id: number) {
    const p = this.#peers.get(id);
    if (!p) return;
    this.#peers.delete(id);
    this.#refreshHold(); // last peer + mic off releases the ctx hold
    if (p.speakingUntil > performance.now()) this.onSpeaking(id, false);
    p.pc.onicecandidate = p.pc.onnegotiationneeded = p.pc.onconnectionstatechange = p.pc.ontrack = null;
    p.pc.close();
    p.compressor?.disconnect();
    p.gain?.disconnect();
    p.analyser?.disconnect();
    if (p.audioEl) {
      p.audioEl.srcObject = null;
      p.audioEl = null;
    }
  }

  /* ------------------------------------------------------------- update */

  /** Per rendered frame: gains, speaking indicator, roster scan. */
  update() {
    const now = performance.now();
    if (now >= this.#scanAt) {
      this.#scanAt = now + SCAN_MS;
      this.#scan(now);
    }
    if (this.#peers.size === 0) return;

    // Per-peer gain drops voiceAudioLevel() — the engine's voice group applies
    // it. voiceAudioLevel() survives only as a cheap gate on the speaking meter.
    const level = VOICE_TUNING.values.volume * VOICE_BOOST;
    const audible = voiceAudioLevel() > 0;
    for (const p of this.#peers.values()) {
      if (p.gain) p.gain.gain.value = level;
      // speaking indicator: RMS over a short window, with hold
      if (p.analyser && p.analyserBuf && audible) {
        p.analyser.getFloatTimeDomainData(p.analyserBuf);
        let sum = 0;
        for (let i = 0; i < p.analyserBuf.length; i++) sum += p.analyserBuf[i] * p.analyserBuf[i];
        const wasSpeaking = p.speakingUntil > now;
        if (Math.sqrt(sum / p.analyserBuf.length) > SPEAK_RMS) p.speakingUntil = now + SPEAK_HOLD_MS;
        const speaking = p.speakingUntil > now;
        if (speaking !== wasSpeaking) this.onSpeaking(p.id, speaking);
      }
    }
  }

  /**
   * 1 Hz: figure out who should be audible and reconcile connections.
   * Wanted = my closest `audibleCount` players ∪ players whose own closest
   * `audibleCount` includes me (all positions are known locally, so both
   * directions are computable — this is what keeps hearing mutual under the
   * lower-id-offers rule).
   */
  #scan(now: number) {
    if (!this.#net.selfId) return;
    const self = this.#selfPos();
    const count = Math.max(1, Math.round(VOICE_TUNING.values.audibleCount));

    const others: { id: number; pos: THREE.Vector3; d: number }[] = [];
    for (const id of this.#net.roster.keys()) {
      const pos = this.#posOf(id);
      if (!pos) continue;
      others.push({ id, pos, d: Math.hypot(pos.x - self.x, pos.y - self.y, pos.z - self.z) });
    }
    others.sort((a, b) => a.d - b.d);

    const wanted = new Set<number>();
    for (const o of others.slice(0, count)) wanted.add(o.id);
    // symmetric side: am I in o's closest `count`? (fewer than `count` players
    // nearer to o than I am — counting the other remotes, not just me)
    for (const o of others) {
      if (wanted.has(o.id)) continue;
      let closer = 0;
      for (const other of others) {
        if (other.id === o.id) continue;
        const dx = other.pos.x - o.pos.x;
        const dy = other.pos.y - o.pos.y;
        const dz = other.pos.z - o.pos.z;
        if (Math.hypot(dx, dy, dz) < o.d) closer++;
        if (closer >= count) break;
      }
      if (closer < count) wanted.add(o.id);
    }

    // linger-drop peers that fell out of both closest-sets (rank churn guard)
    for (const p of this.#peers.values()) {
      if (wanted.has(p.id)) {
        p.unwantedSince = 0;
      } else if (!p.unwantedSince) {
        p.unwantedSince = now;
      } else if (now - p.unwantedSince > LINGER_MS) {
        this.drop(p.id);
      }
    }

    // connect the missing ones, closest first — only the lower id initiates
    // (see header); the higher-id side of each pair runs the same wanted-set
    // computation and simply waits for the offer
    const openSlots = Math.max(0, MAX_PEERS - this.#peers.size);
    let opened = 0;
    for (const o of others) {
      if (opened >= openSlots) break;
      if (!wanted.has(o.id) || this.#peers.has(o.id)) continue;
      if (o.id < this.#net.selfId) continue;
      if ((this.#retryAt.get(o.id) ?? 0) > now) continue;
      this.#createPeer(o.id, true);
      opened++;
    }
  }

  /** Headless-verify hook (window.__sf.voice.debugState()). */
  debugState() {
    return {
      mic: this.micOn,
      ctx: audioEngine.debugState.ctx,
      audibleCount: Math.max(1, Math.round(VOICE_TUNING.values.audibleCount)),
      peers: [...this.#peers.values()].map((p) => ({
        id: p.id,
        conn: p.pc.connectionState,
        ice: p.pc.iceConnectionState,
        speaking: p.speakingUntil > performance.now(),
        hasAudio: !!p.gain
      }))
    };
  }

  dispose() {
    void this.setMic(false);
    for (const id of [...this.#peers.keys()]) this.drop(id);
    // Release our hold but never close the shared engine ctx.
    this.#hold?.();
    this.#hold = null;
  }
}
