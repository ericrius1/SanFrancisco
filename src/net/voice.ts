import * as THREE from "three/webgpu";
import { tunables } from "../core/persist";
import { voiceAudioLevel } from "../core/audioSettings";
import { audioEngine } from "../audio/engine";
import type { Net } from "./net";

/**
 * Proximity voice chat: WebRTC peer-to-peer audio, signaled through the
 * existing presence relay (net.sendRtc / net.onRtc — the server just forwards
 * {t:"rtc"} frames to one peer). Voice packets themselves never touch the
 * server.
 *
 * Connection gating: peers connect when they come within preconnectRadius and
 * tear down past preconnectRadius × DISCONNECT_FACTOR after a linger — a wide
 * hysteresis band so two players dancing around the boundary don't churn
 * connections. preconnectRadius is deliberately larger than fadeEndRadius: ICE
 * takes 1–3 s, so the link is already up (and spatially silent) by the time a
 * peer walks into earshot.
 *
 * Signaling avoids glare entirely: the LOWER id owns the offer. It creates the
 * connection with a sendrecv audio transceiver (which fires
 * negotiationneeded → offer); the higher id only ever creates a connection in
 * response to an incoming signal, adopts the transceiver that
 * setRemoteDescription(offer) creates, and answers. Mic on/off is
 * sender.replaceTrack(track|null) on that one m-line — never a renegotiation.
 *
 * Spatialization: per peer, remote MediaStream → hidden muted <audio> element
 * (Chrome quirk: a MediaStreamAudioSourceNode is silent unless the stream is
 * also attached to a playing media element) → PannerNode (HRTF, linear
 * distance model with a large full-volume range and a long fade band) →
 * GainNode → the shared AudioEngine's "voice" group input.
 * The engine owns the ctx and the listener (tracked from the camera every
 * frame); panners follow the interpolated avatars. A background engine hold
 * (acquired while the mic is on or any peer is wired) keeps the ctx running
 * even while the tab is hidden — proximity chat is a social feature.
 *
 * Privacy: mic off = track stopped and stream released (browser mic indicator
 * turns off), not just muted.
 */

export const VOICE_TUNING = tunables("voice", {
  volume: { v: 1, min: 0, max: 2, step: 0.05, label: "voice volume" },
  fullVolumeRadius: { v: 220, min: 20, max: 800, step: 5, label: "full voice range (m)" },
  fadeEndRadius: { v: 700, min: 80, max: 1600, step: 10, label: "silent past (m)" },
  fadeSlope: { v: 1, min: 0.1, max: 1, step: 0.05, label: "fade slope" },
  preconnectRadius: { v: 760, min: 80, max: 1800, step: 10, label: "connect at (m)" }
});

const DISCONNECT_FACTOR = 1.35; // hysteresis: drop at preconnectRadius × this…
const LINGER_MS = 10_000; // …only after being out of range this long
const SCAN_MS = 1000; // proximity scan cadence
const MAX_PEERS = 8; // uplink cap: mic is re-encoded per peer (~32 kbps each)
const RETRY_MS = 5000; // wait after a failed connection before re-offering
const HEAD_Y = 1.5; // voices come from head height, not the avatar's feet
const SPEAK_RMS = 0.015; // analyser RMS above this = "speaking"
const SPEAK_HOLD_MS = 250; // indicator hold so it doesn't flicker between words
const MIN_FADE_BAND = 40; // keep bad pane values from turning the fade into a cliff
const PRECONNECT_MARGIN = 60; // ICE should be ready before someone reaches audibility

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

type Peer = {
  id: number;
  pc: RTCPeerConnection;
  polite: boolean; // higher id yields (only lower id ever offers first)
  audioEl: HTMLAudioElement | null;
  panner: PannerNode | null;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  analyserBuf: Float32Array<ArrayBuffer> | null;
  outOfRangeSince: number; // performance.now() when it left range; 0 = in range
  speakingUntil: number;
};

function voiceRange() {
  const t = VOICE_TUNING.values;
  const fullVolumeRadius = Math.max(1, t.fullVolumeRadius);
  const fadeEndRadius = Math.max(t.fadeEndRadius, fullVolumeRadius + MIN_FADE_BAND);
  const preconnectRadius = Math.max(t.preconnectRadius, fadeEndRadius + PRECONNECT_MARGIN);
  return {
    fullVolumeRadius,
    fadeEndRadius,
    fadeSlope: t.fadeSlope,
    preconnectRadius
  };
}

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
      panner: null,
      gain: null,
      analyser: null,
      analyserBuf: null,
      outOfRangeSince: 0,
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

  /** Remote stream → hidden <audio> (Chrome quirk) → panner → gain → voice group. */
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
    p.panner?.disconnect();
    p.gain?.disconnect();
    p.analyser?.disconnect();
    const src = ctx.createMediaStreamSource(stream);
    const range = voiceRange();
    p.panner = new PannerNode(ctx, {
      panningModel: "HRTF",
      distanceModel: "linear",
      refDistance: range.fullVolumeRadius,
      maxDistance: range.fadeEndRadius,
      rolloffFactor: range.fadeSlope
    });
    p.gain = ctx.createGain();
    // No voiceAudioLevel() here — the engine's voice group gain applies it.
    p.gain.gain.value = VOICE_TUNING.values.volume;
    p.analyser = ctx.createAnalyser();
    p.analyser.fftSize = 256;
    p.analyserBuf = new Float32Array(p.analyser.fftSize);
    src.connect(p.panner).connect(p.gain).connect(bus.input);
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

  /** Tear down one peer (out of range, left the server, or ICE failed). */
  drop(id: number) {
    const p = this.#peers.get(id);
    if (!p) return;
    this.#peers.delete(id);
    this.#refreshHold(); // last peer + mic off releases the ctx hold
    if (p.speakingUntil > performance.now()) this.onSpeaking(id, false);
    p.pc.onicecandidate = p.pc.onnegotiationneeded = p.pc.onconnectionstatechange = p.pc.ontrack = null;
    p.pc.close();
    p.panner?.disconnect();
    p.gain?.disconnect();
    p.analyser?.disconnect();
    if (p.audioEl) {
      p.audioEl.srcObject = null;
      p.audioEl = null;
    }
  }

  /* ------------------------------------------------------------- update */

  /** Per rendered frame: panner poses, gains, speaking, scan. */
  // camera is unused now (the engine owns the ctx.listener), but the signature
  // stays for main.ts's per-frame call.
  update(_camera: THREE.Camera) {
    const now = performance.now();
    if (now >= this.#scanAt) {
      this.#scanAt = now + SCAN_MS;
      this.#scan(now);
    }
    if (this.#peers.size === 0) return;

    const t = VOICE_TUNING.values;
    // Per-peer gain drops voiceAudioLevel() — the engine's voice group applies
    // it. voiceAudioLevel() survives only as a cheap gate on the speaking meter.
    const gain = t.volume;
    const audible = voiceAudioLevel() > 0;
    const range = voiceRange();
    for (const p of this.#peers.values()) {
      if (p.gain) p.gain.gain.value = gain;
      if (p.panner) {
        p.panner.refDistance = range.fullVolumeRadius;
        p.panner.maxDistance = range.fadeEndRadius;
        p.panner.rolloffFactor = range.fadeSlope;
        const pos = this.#posOf(p.id);
        if (pos) {
          p.panner.positionX.value = pos.x;
          p.panner.positionY.value = pos.y + HEAD_Y;
          p.panner.positionZ.value = pos.z;
        }
      }
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

  /** 1 Hz: open links to the nearest in-range peers, linger-drop the far ones. */
  #scan(now: number) {
    if (!this.#net.selfId) return;
    const self = this.#selfPos();
    const range = voiceRange();
    // pre-connect margin: the link must exist before anyone is audible
    const connectR = range.preconnectRadius;
    const dropR = connectR * DISCONNECT_FACTOR;

    const inRange: { id: number; d: number }[] = [];
    for (const id of this.#net.roster.keys()) {
      const pos = this.#posOf(id);
      if (!pos) continue;
      const d = Math.hypot(pos.x - self.x, pos.y - self.y, pos.z - self.z);
      const p = this.#peers.get(id);
      if (p) {
        if (d > dropR) {
          if (!p.outOfRangeSince) p.outOfRangeSince = now;
          else if (now - p.outOfRangeSince > LINGER_MS) this.drop(id);
        } else {
          p.outOfRangeSince = 0;
        }
      } else if (d <= connectR && id > this.#net.selfId && (this.#retryAt.get(id) ?? 0) <= now) {
        // only the lower id initiates (see header) — selfId < id here
        inRange.push({ id, d });
      }
    }
    inRange.sort((a, b) => a.d - b.d);
    for (const { id } of inRange.slice(0, Math.max(0, MAX_PEERS - this.#peers.size))) {
      this.#createPeer(id, true);
    }
  }

  /** Headless-verify hook (window.__sf.voice.debugState()). */
  debugState() {
    return {
      mic: this.micOn,
      ctx: audioEngine.debugState.ctx,
      range: voiceRange(),
      peers: [...this.#peers.values()].map((p) => ({
        id: p.id,
        conn: p.pc.connectionState,
        ice: p.pc.iceConnectionState,
        speaking: p.speakingUntil > performance.now(),
        hasAudio: !!p.panner
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
