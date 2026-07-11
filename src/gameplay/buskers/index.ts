import * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import { TrioAudio } from "./audio";
import { buildPerchRock, PERCH } from "./perchRock";
import { COUNTIN_BEATS, REST_SECONDS, SEC_PER_BEAT, SONGS } from "./song";
import type { BuskerId, Musician, MusicianBuilder, NoteEvent, TrioClock, TrioPhase } from "./types";
import { buildFlutist } from "./flutist";
import { buildHandpanist } from "./handpanist";
import { buildUkulelist } from "./ukulelist";
import { BuskerFireflies } from "./fireflies";

/**
 * The busker trio: three musicians perched on a flat-topped chert boulder
 * (perchRock.ts) playing through a small songbook together (song.ts) — the
 * current song loops, Q cycles to the next one — resting in the wind
 * between passes. Deliberately placeless — createBuskerTrio() drops it at any
 * world position and
 * setPlacement() moves it later (it re-grounds itself), so it can live on
 * the Corona Heights summit today and be nudged when that hill's detail
 * pass lands.
 *
 *   const trio = createBuskerTrio({ x, z, yaw, groundHeight, physics });
 *   scene.add(trio.group);
 *   // per frame: trio.update(dt, camera, gust)
 *
 * The transport is authoritative and always runs, so the performance
 * continues (visually) even while the AudioContext is suspended out of
 * earshot; audio re-syncs to the body language whenever you wander back.
 */

const LOOKAHEAD_SECONDS = 0.4; // audio scheduling horizon
const ANIM_RADIUS = 200; // beyond this, skip musician animation updates
// Render gate with hysteresis (no boundary flicker). The transport and audio
// keep running while hidden — the show goes on unheard, exactly as before.
const SHOW_RADIUS = 240;
const HIDE_RADIUS = 270;
// Parts smaller than this never shadow-cast: a gem/string/fret cast is
// invisible at CSM resolution, but each casting mesh re-encodes into every
// shadow cascade every shadow frame.
const CASTER_MIN_VOLUME = 1.5e-3; // m³
const COUNTIN_SECONDS = COUNTIN_BEATS * SEC_PER_BEAT;

// Seats along the front (-Z) edge. A viewer standing in front of the rock
// sees: ukulele on their left, handpan girl in the middle, flute on their
// right. The outer two angle slightly inward, toward each other.
const SEATS: { id: BuskerId; x: number; yaw: number; build: MusicianBuilder }[] = [
  { id: "ukulele", x: 1.02, yaw: 0.14, build: buildUkulelist },
  { id: "handpan", x: 0, yaw: 0, build: buildHandpanist },
  { id: "flute", x: -1.02, yaw: -0.14, build: buildFlutist }
];
// Butts perched right on the front lip (hip front flush with the edge, knees
// past it) so the shins hang straight over the undercut drop, not on the rock.
const SEAT_Z = -PERCH.depth / 2 + 0.12;
const VOICE_HEIGHT = 0.55; // sound source at chest height above the seat

export type BuskerTrioOptions = {
  x: number;
  z: number;
  /** deck yaw; the trio faces -Z rotated by this */
  yaw?: number;
  /** terrain sampler (map.groundHeight) — used on every (re)placement */
  groundHeight: (x: number, z: number) => number;
  physics?: Physics | null;
};

export class BuskerTrio {
  readonly group = new THREE.Group();

  #audio = new TrioAudio();
  #perch: ReturnType<typeof buildPerchRock>;
  #fireflies = new BuskerFireflies();
  #musicians = new Map<BuskerId, Musician>();
  #seatLocal = new Map<BuskerId, THREE.Vector3>();
  #groundHeight: (x: number, z: number) => number;

  #phase: TrioPhase = "countin";
  #phaseTime = 0;
  #elapsed = 0;
  #anchor = 0; // AudioContext time that maps to song beat 0
  /** Wall-clock silence before the next downbeat (Q cycle / film cue). */
  #silenceRemaining = 0;
  #songIdx = 0;
  #song = SONGS[0];
  #songSeconds = SONGS[0].beats * SEC_PER_BEAT;
  #schedIdx: Record<BuskerId, number> = { ukulele: 0, handpan: 0, flute: 0 };
  #clock: TrioClock = { phase: "countin", phaseTime: 0, songTime: 0, beat: 0, wind: 0.3 };
  #tmp = new THREE.Vector3();

  constructor(opts: BuskerTrioOptions) {
    this.#groundHeight = opts.groundHeight;
    this.#perch = buildPerchRock(opts.physics ?? null);
    this.group.add(this.#perch.group);
    this.group.add(this.#fireflies.group);

    for (const seat of SEATS) {
      const tap = this.#audio.channel(seat.id);
      // Headless/audio-less contexts still get the full visual performance:
      // hand the builder a dummy tap wired to nothing.
      const musician = seat.build(tap ?? makeSilentTap(), this.#song.parts[seat.id]);
      musician.group.position.set(seat.x, PERCH.top, SEAT_Z);
      musician.group.rotation.y = seat.yaw;
      this.group.add(musician.group);
      this.#musicians.set(seat.id, musician);
      this.#seatLocal.set(seat.id, new THREE.Vector3(seat.x, PERCH.top + VOICE_HEIGHT, SEAT_Z));
    }

    this.setPlacement(opts.x, opts.z, opts.yaw ?? 0);
    applyShadowDiet(this.group);
    // Prune the ~280-node subtree from the scene's per-frame matrix pass;
    // update() refreshes it manually while the trio is on-screen and animating.
    this.group.matrixWorldAutoUpdate = false;
  }

  /** Move the whole act (perch rock, trio, collider, sound sources) and re-seat
   * it on the terrain. Safe to call at runtime — use it when Corona Heights'
   * detail pass settles and the summit spot moves. */
  setPlacement(x: number, z: number, yaw = this.group.rotation.y) {
    const y = this.#groundHeight(x, z);
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    this.#refreshMatrices();
    this.#perch.setColliderTransform(x, y, z, yaw);
    for (const [id, local] of this.#seatLocal) {
      this.#tmp.copy(local).applyMatrix4(this.group.matrixWorld);
      this.#audio.setChannelPosition(id, this.#tmp.x, this.#tmp.y, this.#tmp.z);
    }
  }

  /** Debug helper: jump straight to the top of the song. */
  restartSong() {
    this.#enterPhase("playing");
  }

  /** Name of the song the transport is currently cycling. */
  get songName(): string {
    return this.#song.name;
  }

  /**
   * Q: advance to the next song in the songbook and cue it up —
   * `leadInSeconds` of hard silence before the downbeat. Mid-song tails are
   * cut so the new tune starts clean. Returns the new song's name.
   */
  cycleSong(leadInSeconds = 2): string {
    this.#songIdx = (this.#songIdx + 1) % SONGS.length;
    this.#song = SONGS[this.#songIdx];
    this.#songSeconds = this.#song.beats * SEC_PER_BEAT;
    for (const [id, musician] of this.#musicians) musician.setPart(this.#song.parts[id]);
    this.cueShow(leadInSeconds);
    return this.#song.name;
  }

  /**
   * Film cue: `leadInSeconds` of silence, then the downbeat. Does not move
   * the player or the perch — transport only. Cuts any mid-song tails so the
   * gap is actually silent (not just a muted count-in with ringing voices).
   */
  cueShow(leadInSeconds = 2) {
    this.#audio.holdSilent(true);
    for (const musician of this.#musicians.values()) musician.cutAudio();
    const gap = Math.max(0, leadInSeconds);
    if (gap <= 0) {
      this.#silenceRemaining = 0;
      this.#enterPhase("playing");
      return;
    }
    // Rest pose during the gap so it reads as a pause, not a rushed count-in.
    this.#silenceRemaining = gap;
    this.#enterPhase("rest");
  }

  /** Debug/probe helper: jump the transport to an arbitrary song beat. */
  seek(beat: number) {
    this.#enterPhase("playing");
    this.#phaseTime = THREE.MathUtils.clamp(beat, 0, this.#song.beats) * SEC_PER_BEAT;
    const ctx = this.#audio.ctx;
    if (ctx) this.#anchor = ctx.currentTime - this.#phaseTime;
  }

  /** Live MediaStream of the trio's final audio mix (master + reverb), for
   * MediaRecorder capture in a realtime render pass. Null in audio-less
   * contexts (headless tests). */
  captureStream(): MediaStream | null {
    return this.#audio.captureStream();
  }

  /** World position of a musician's seat (probe cameras, effects). */
  seatWorld(id: BuskerId, out = new THREE.Vector3()): THREE.Vector3 {
    const local = this.#seatLocal.get(id);
    this.group.updateMatrixWorld(true);
    return local ? out.copy(local).applyMatrix4(this.group.matrixWorld) : out.copy(this.group.position);
  }

  get clock(): Readonly<TrioClock> {
    return this.#clock;
  }

  update(dt: number, camera: THREE.Camera, gust = 0, sunElevation = 90) {
    dt = Math.min(dt, 0.1);
    this.#elapsed += dt;

    const dist = camera.getWorldPosition(this.#tmp).distanceTo(this.group.position);
    this.#audio.update(camera, dist, this.#elapsed);
    this.#fireflies.update(dt, dist, sunElevation);

    // ---- transport (always runs; the show goes on unheard) ----
    this.#phaseTime += dt;
    const ctx = this.#audio.ctx;
    if (this.#phase === "playing" && ctx && this.#audio.running) {
      // the audio clock is authoritative while it's running; a big gap means
      // the context was suspended mid-song, so re-anchor instead of snapping
      const audioPhase = ctx.currentTime - this.#anchor;
      if (Math.abs(audioPhase - this.#phaseTime) > 0.25) this.#anchor = ctx.currentTime - this.#phaseTime;
      else this.#phaseTime = audioPhase;
    }
    if (this.#silenceRemaining > 0) {
      this.#silenceRemaining -= dt;
      if (this.#silenceRemaining <= 0) {
        this.#silenceRemaining = 0;
        this.#enterPhase("playing");
      }
    } else if (this.#phase === "playing" && this.#phaseTime >= this.#songSeconds) this.#enterPhase("rest");
    else if (this.#phase === "rest" && this.#phaseTime >= REST_SECONDS) this.#enterPhase("countin");
    else if (this.#phase === "countin" && this.#phaseTime >= COUNTIN_SECONDS) this.#enterPhase("playing");

    const clock = this.#clock;
    clock.phase = this.#phase;
    clock.phaseTime = this.#phaseTime;
    clock.songTime = this.#phase === "playing" ? this.#phaseTime : this.#songSeconds;
    clock.beat = clock.songTime / SEC_PER_BEAT;
    // never dead still: a slow breath under the shared foliage gust
    clock.wind = THREE.MathUtils.clamp(0.18 + 0.12 * Math.sin(this.#elapsed * 0.31) + 0.85 * gust, 0, 1);

    // ---- audio scheduling (lookahead window, once per event) ----
    if (this.#phase === "playing" && this.#audio.running) {
      const nowBeat = this.#phaseTime / SEC_PER_BEAT;
      const horizon = Math.min(this.#song.beats, (this.#phaseTime + LOOKAHEAD_SECONDS) / SEC_PER_BEAT);
      const atTime = (beat: number) => this.#anchor + beat * SEC_PER_BEAT;
      for (const [id, musician] of this.#musicians) {
        const events = this.#song.parts[id];
        let i = this.#schedIdx[id];
        while (i < events.length && events[i].beat < nowBeat - 0.05) i++; // arrived mid-song: drop the past
        let batch: NoteEvent[] | null = null;
        while (i < events.length && events[i].beat <= horizon) {
          (batch ??= []).push(events[i++]);
        }
        this.#schedIdx[id] = i;
        if (batch) musician.schedule(batch, atTime);
      }
    }

    // ---- render gate + animation ----
    if (this.group.visible) {
      if (dist > HIDE_RADIUS) this.group.visible = false;
    } else if (dist < SHOW_RADIUS) {
      this.group.visible = true;
    }
    if (this.group.visible && dist < ANIM_RADIUS) {
      for (const musician of this.#musicians.values()) musician.update(dt, clock);
      this.#refreshMatrices();
    }
  }

  dispose() {
    for (const musician of this.#musicians.values()) musician.dispose();
    this.#musicians.clear();
    this.#fireflies.dispose();
    this.#perch.dispose();
    this.#audio.dispose();
    this.group.parent?.remove(this.group);
  }

  /** The root sits outside the scene's auto matrix pass (matrixWorldAutoUpdate
   * false) — force one subtree refresh through the disabled flag. */
  #refreshMatrices() {
    this.group.matrixWorldAutoUpdate = true;
    this.group.updateMatrixWorld(true);
    this.group.matrixWorldAutoUpdate = false;
  }

  #enterPhase(phase: TrioPhase) {
    this.#phase = phase;
    this.#phaseTime = 0;
    if (phase === "playing") {
      this.#audio.holdSilent(false);
      this.#schedIdx = { ukulele: 0, handpan: 0, flute: 0 };
      const ctx = this.#audio.ctx;
      // +60 ms of slack so beat-0 voices are never scheduled in the past
      this.#anchor = (ctx ? ctx.currentTime : 0) + 0.06;
    }
  }
}

/** No-audio environments (tests, unsupported browsers): a detached context
 * stand-in is impossible, so give musicians a tap whose scheduling is
 * simply never invoked (TrioAudio.running stays false). */
function makeSilentTap() {
  return {
    // schedule() is only called when the real context runs, so musicians
    // never touch this in the audio-less case; the cast keeps builders simple.
    ctx: null as unknown as AudioContext,
    out: null as unknown as GainNode,
    reverb: null as unknown as GainNode
  };
}

/** Size-based caster diet: only chunky parts shadow-cast. Volume-thresholded
 * rather than name-matched so new outfit/instrument detail stays dieted. */
function applyShadowDiet(root: THREE.Object3D) {
  const size = new THREE.Vector3();
  const scale = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    geo.boundingBox!.getSize(size);
    mesh.getWorldScale(scale);
    const volume = Math.abs(size.x * scale.x) * Math.abs(size.y * scale.y) * Math.abs(size.z * scale.z);
    if (volume < CASTER_MIN_VOLUME) mesh.castShadow = false;
  });
}

export function createBuskerTrio(opts: BuskerTrioOptions): BuskerTrio {
  return new BuskerTrio(opts);
}
