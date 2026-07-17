import type * as THREE from "three/webgpu";
import { tunables } from "../core/persist";
import { voiceAudioLevel } from "../core/audioSettings";
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
 * up toward a consistent loudness) → GainNode → destination. Deliberately
 * non-spatial: intelligibility beats immersion for chat.
 *
 * A listen-only player never passes through setMic(true), so their
 * AudioContext starts suspended by autoplay policy — #armResume kicks it on
 * the next input gesture, otherwise they'd stand there hearing nothing.
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
  #ctx: AudioContext | null = null;
  #resumeArmed = false;
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
      try {
        this.#micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } catch {
        return false; // denied or no device
      }
      this.#micTrack = this.#micStream.getAudioTracks()[0] ?? null;
      this.micOn = true;
      void this.#ensureCtx()?.resume(); // toggling is a user gesture — resume while we have it
    } else {
      this.#micTrack?.stop(); // releases the device (browser mic indicator off)
      this.#micTrack = null;
      this.#micStream = null;
      this.micOn = false;
    }
    for (const p of this.#peers.values()) this.#attachMic(p);
    this.onMicChange(this.micOn);
    return true;
  }

  /** Put the current mic track (or silence) on a peer's one audio m-line. */
  #attachMic(p: Peer) {
    const tr = p.pc.getTransceivers()[0];
    if (!tr) return; // polite peer before the offer arrived — adopted in #handleSignal
    tr.direction = "sendrecv";
    void tr.sender.replaceTrack(this.#micTrack).catch(() => {});
  }

  /* ------------------------------------------------------------- peers */

  #ensureCtx(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    this.#ctx = new AudioContext();
    if (this.#ctx.state === "suspended") this.#armResume();
    return this.#ctx;
  }

  /** Autoplay policy: a listen-only player's ctx needs a gesture to start. */
  #armResume() {
    if (this.#resumeArmed) return;
    this.#resumeArmed = true;
    const kick = () => {
      const ctx = this.#ctx;
      if (!ctx || ctx.state === "running") {
        off();
        return;
      }
      void ctx.resume().then(() => {
        if (this.#ctx?.state === "running") off();
      });
    };
    const off = () => {
      this.#resumeArmed = false;
      window.removeEventListener("pointerdown", kick, true);
      window.removeEventListener("keydown", kick, true);
    };
    window.addEventListener("pointerdown", kick, true);
    window.addEventListener("keydown", kick, true);
  }

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

  /** Remote stream → hidden <audio> (Chrome quirk) → compressor → gain → out. */
  #wireAudio(p: Peer, stream: MediaStream) {
    const ctx = this.#ensureCtx();
    if (!ctx) return;
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
    p.gain.gain.value = VOICE_TUNING.values.volume * voiceAudioLevel() * VOICE_BOOST;
    p.analyser = ctx.createAnalyser();
    p.analyser.fftSize = 256;
    p.analyserBuf = new Float32Array(p.analyser.fftSize);
    src.connect(p.compressor).connect(p.gain).connect(ctx.destination);
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
    const ctx = this.#ctx;
    if (!ctx || this.#peers.size === 0) return;

    const level = VOICE_TUNING.values.volume * voiceAudioLevel() * VOICE_BOOST;
    for (const p of this.#peers.values()) {
      if (p.gain) p.gain.gain.value = level;
      // speaking indicator: RMS over a short window, with hold
      if (p.analyser && p.analyserBuf && level > 0) {
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
      ctx: this.#ctx?.state ?? "none",
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
    void this.#ctx?.close();
    this.#ctx = null;
  }
}
