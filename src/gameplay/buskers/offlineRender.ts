import { TrioAudio } from "./audio";
import { buildFlutist } from "./flutist";
import { buildHandpanist } from "./handpanist";
import { buildUkulelist } from "./ukulelist";
import { SEC_PER_BEAT, SONGS } from "./song";
import type { BuskerId, Musician, MusicianBuilder, NoteEvent } from "./types";

/**
 * Deterministic, gapless offline render of the trio's music.
 *
 * The live game captures audio in REAL TIME (MediaRecorder tapping
 * TrioAudio.captureStream) — fine for playing through speakers, but fragile
 * for a film render: a GPU stall hitches the transport, the AudioContext
 * resume is async, and BuskerTrio re-anchors whenever audio/visual drift
 * >0.25s, any of which can drop a silent stretch into the recording.
 *
 * For a RENDER none of that matters: we don't need to hear it in real time, we
 * need the exact same music computed reproducibly. So this builds an
 * OfflineAudioContext, wires up the REAL TrioAudio graph (same panners, shared
 * "off the mountains" convolution reverb, master gain, safety compressor) and
 * the REAL three musicians (same synthesis), then lays the whole score down in
 * one pass against a virtual clock and renders faster-than-realtime. No
 * suspends, no re-anchors, no lookahead window — beat b simply lands at
 * `downbeatAt + b * SEC_PER_BEAT`, every note, every time.
 *
 * Exposed to the render tool as `window.__sfRenderTrioAudio(seconds)` →
 * base64 WAV (registered at the bottom of this module).
 */

export type OfflineRenderOptions = {
  /** total render length in seconds (the shot length) */
  seconds: number;
  /** seconds of pre-roll silence before beat 0 (the shot's cueShow lead-in) */
  downbeatAt?: number;
  sampleRate?: number;
  /** index into SONGS (default 0 = "Fog Rolls Home", the cinematic's default) */
  songIndex?: number;
};

// Seat X offsets mirror index.ts SEATS: a listener in front sees the ukulele on
// their left (+X), the handpan girl centre, the flute on their right (-X).
const SEATS: { id: BuskerId; x: number; build: MusicianBuilder }[] = [
  { id: "ukulele", x: 1.02, build: buildUkulelist },
  { id: "handpan", x: 0, build: buildHandpanist },
  { id: "flute", x: -1.02, build: buildFlutist }
];

/**
 * Render `seconds` of the trio's music into an AudioBuffer, gapless and
 * deterministic-in-timing (voice/reverb noise still use Math.random, so two
 * renders are perceptually identical but not byte-identical — see module doc).
 */
export async function renderTrioAudioOffline(opts: OfflineRenderOptions): Promise<AudioBuffer> {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("renderTrioAudioOffline needs a browser (OfflineAudioContext unavailable)");
  }
  const seconds = opts.seconds;
  const downbeatAt = opts.downbeatAt ?? 1.0;
  const sampleRate = opts.sampleRate ?? 48000;
  const song = SONGS[opts.songIndex ?? 0] ?? SONGS[0];

  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });

  // The REAL graph, bound to the offline context (injected-context seam).
  const audio = new TrioAudio(ctx);
  // Master gain starts at 0 and is only opened by update()/holdSilent() in the
  // live game; offline never ticks update(), so open the mix explicitly. This
  // sets master.gain to musicAudioLevel() (the game's HUD music-volume level,
  // which the render tool seeds via localStorage) and un-gates the reverb bus,
  // at the offline clock's t=0.
  audio.holdSilent(false);

  // Build the REAL musicians, tapped into the offline graph, and place their
  // sound sources on a small static X spread near the origin.
  const musicians: { musician: Musician; part: NoteEvent[] }[] = [];
  for (const seat of SEATS) {
    const tap = audio.channel(seat.id);
    if (!tap) continue;
    const part = song.parts[seat.id];
    const musician = seat.build(tap, part);
    musicians.push({ musician, part });
    audio.setChannelPosition(seat.id, seat.x, 0.1, 0);
  }

  // Static listener a few metres in front of the trio (they face -Z), looking
  // at them, so the HRTF panners paint a gentle, stable stereo image.
  positionListener(ctx);

  // Deterministic scheduling: offline time never advances while we schedule, so
  // there is no "scheduled in the past" hazard and no need for the transport's
  // rolling lookahead — lay down every note whose onset fits the window at once.
  const atTime = (beat: number) => downbeatAt + beat * SEC_PER_BEAT;
  for (const { musician, part } of musicians) {
    const events = part.filter((e) => atTime(e.beat) < seconds + 1e-3);
    if (events.length) musician.schedule(events, atTime);
  }

  const buffer = await ctx.startRendering();

  // Intentionally NOT disposing the musicians: their rigs share rig.ts's global
  // geometry/material caches (STATIC_MAT, geoCache) with the LIVE trio that is
  // visible on the same page — disposing would corrupt the on-screen performers.
  // Nothing here was uploaded to a GPU; the detached objects and offline audio
  // nodes are unreferenced after this returns and simply GC away.
  return buffer;
}

/** Park the offline listener in front of the trio, facing them. */
function positionListener(ctx: BaseAudioContext) {
  const l = ctx.listener;
  const set = (p: AudioParam | undefined, v: number) => {
    if (p) p.value = v;
  };
  if (l.positionX) {
    set(l.positionX, 0);
    set(l.positionY, 0.1);
    set(l.positionZ, -4);
    set(l.forwardX, 0);
    set(l.forwardY, 0);
    set(l.forwardZ, 1);
    set(l.upX, 0);
    set(l.upY, 1);
    set(l.upZ, 0);
  } else {
    const legacy = l as unknown as {
      setPosition(x: number, y: number, z: number): void;
      setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
    };
    legacy.setPosition(0, 0.1, -4);
    legacy.setOrientation(0, 0, 1, 0, 1, 0);
  }
}

/* ---------------------------------------------------- WAV / base64 encoding */

/** Encode an AudioBuffer as a 16-bit PCM stereo WAV (little-endian). */
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return ab;
}

/** base64 of an ArrayBuffer, chunked so we never blow the argument-count limit. */
function arrayBufferToBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* --------------------------------------------------------------- dev hook */

declare global {
  interface Window {
    /** Render `seconds` of the trio's music offline → base64 WAV. Installed on
     * any page that loads the buskers module; driven by the render tool's
     * deterministic audio pass. */
    __sfRenderTrioAudio?: (seconds?: number) => Promise<string>;
  }
}

if (typeof window !== "undefined") {
  window.__sfRenderTrioAudio = async (seconds = 30) => {
    const buffer = await renderTrioAudioOffline({ seconds });
    return arrayBufferToBase64(audioBufferToWav(buffer));
  };
}
