// Beach Pianist — a lazy optional world site. A bearded voxel man waits beside
// a dark voxel grand piano on the sand at Baker Beach, the Golden Gate Bridge
// spanning the NE horizon behind him. Talk to him and accept his offer to hear
// the real 42.5 s recording once; his hands and fingers track its transcribed
// note timeline, then he waits until the player asks again.
//
// Loading policy (docs/LAZY_LOADING.md): construction is procedural and
// network-free — a group of voxel boxes. The recording and its note timeline
// are fetched only on first approach (AUDIO_FETCH_RADIUS); the audio graph rides
// the shared AudioEngine music group and joins whenever it is unlocked and near.
// Once requested, the transport is authoritative wall-clock, so that one
// performance keeps running (visually) even before audio unlock or while out of
// earshot — audio resyncs to the body language whenever the player wanders back.

import * as THREE from "three/webgpu";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import type { WorldMap } from "../heightmap";
import { enableShadowLayer, SHADOW_LAYERS } from "../shadows/shadowLayers";
import { BeachPianistAudio } from "./audio";
import { buildGrandPiano, KEY_CONTACT } from "./piano";
import { PIANO_FINGER_KEY_OFFSETS, buildPianist, type PianistDrive } from "./pianist";
import { BLACK_MIDIS, KEY_IS_BLACK, KEY_SLOT, WHITE_MIDIS, keyCenterX } from "./keys";
import { PIANO_FINGER_COUNT, parseNoteTimeline, type NoteTimeline } from "./notes";
import { SONGS } from "./songs";
import { BEACH_PIANIST_SITE } from "./meta";
import {
  createBeachPianistRadialSource,
  type BeachPianistRadialSource
} from "./radialSource";
import { PianistShoreline } from "./shoreline";
import { bindBeachPianistShorelineTuning } from "./tuning";
import { createBeachPianistConversation } from "./conversation";

export { BEACH_PIANIST_SITE } from "./meta";

const { clamp, damp } = THREE.MathUtils;

// Distance gates (m from the site centre), all with hysteresis where it matters.
const PRIME_RADIUS = 520; // detached pipeline warmup
const SHOW_RADIUS = 260;
const HIDE_RADIUS = 300;
const ANIM_RADIUS = 210; // beyond this the pose/key work is skipped
const AUDIO_FETCH_RADIUS = 320; // first fetch of the recording + note timeline
export const BEACH_PIANIST_GOD_RAY_RADIUS = 30;

// Voice point: above the soundboard, in stage-local space.
const VOICE_LOCAL = new THREE.Vector3(0, KEY_CONTACT.top + 0.22, KEY_CONTACT.z - 0.9);

const IMMINENT_MS = 180; // notes this soon count toward the hand target
const ONSET_DIP_MS = 130; // only recent onsets pulse a hand dip
const FINGER_CONTACT_MS = 190; // release sustained notes so a digit can travel onward

type Transport = { playing: boolean; songIndex: number; songTimeMs: number };

export class BeachPianist {
  readonly group = new THREE.Group();

  #map: WorldMap;
  #prepareRender: ((root: THREE.Object3D) => Promise<void>) | null;
  #renderWarm: "cold" | "warming" | "ready";

  #stage = new THREE.Group();
  #piano: ReturnType<typeof buildGrandPiano>;
  #pianist: ReturnType<typeof buildPianist>;
  #shoreline: PianistShoreline;
  #audio: BeachPianistAudio;
  #conversation: ReturnType<typeof createBeachPianistConversation>;
  #radialSource: BeachPianistRadialSource | null = null;
  #perfSuppressed = false;

  // lazy note timeline (drives the visual performance)
  #timeline: NoteTimeline | null = null;
  #notesArmed = false;
  #notesError: string | null = null;
  #disposed = false;

  // One-shot transport (authoritative wall-clock once the player requests it).
  #performanceStartMs: number | null = null;
  #perform = 0; // eased playing intensity
  #lastSongTimeMs = 0;

  // per-frame timeline cursors
  #hi = 0; // first note starting after (songTime + IMMINENT)
  #onset = 0; // next onset not yet pulsed
  #leftDip = 0;
  #rightDip = 0;

  // key press state (per instance slot)
  #whitePress = new Float32Array(WHITE_MIDIS.length);
  #blackPress = new Float32Array(BLACK_MIDIS.length);
  #keysActive = false;

  // reusable drive + scratch (allocation-free hot path)
  #drive: PianistDrive = {
    perform: 0,
    loud: 0,
    left: {
      targetX: keyCenterX(48),
      dip: 0,
      clasp: 0,
      active: false,
      fingerMidi: new Int16Array(PIANO_FINGER_COUNT).fill(-1),
      fingerPress: new Float32Array(PIANO_FINGER_COUNT)
    },
    right: {
      targetX: keyCenterX(72),
      dip: 0,
      clasp: 0,
      active: false,
      fingerMidi: new Int16Array(PIANO_FINGER_COUNT).fill(-1),
      fingerPress: new Float32Array(PIANO_FINGER_COUNT)
    }
  };
  #tmp = new THREE.Vector3();
  #tp: Transport = { playing: false, songIndex: 0, songTimeMs: 0 };
  #handX = { l: 0, r: 0 };
  #lastLeftTargetX = keyCenterX(48);
  #lastRightTargetX = keyCenterX(72);

  constructor(opts: {
    map: WorldMap;
    prepareRender?: (root: THREE.Object3D) => Promise<void>;
  }) {
    this.#map = opts.map;
    this.#prepareRender = opts.prepareRender ?? null;
    this.#renderWarm = this.#prepareRender ? "cold" : "ready";
    this.group.name = "beachPianist";

    // Build at stage-local origin so the IK solve happens in a stable frame; the
    // whole stage is then rigidly positioned in the world (local arm rotations
    // stay valid because rig and piano move together).
    this.#stage.name = "beachPianist.stage";
    this.#piano = buildGrandPiano();
    this.#stage.add(this.#piano.group);
    this.#pianist = buildPianist(this.#stage);

    const y = this.#map.groundTop(BEACH_PIANIST_SITE.x, BEACH_PIANIST_SITE.z);
    this.group.position.set(BEACH_PIANIST_SITE.x, y, BEACH_PIANIST_SITE.z);
    this.group.rotation.y = BEACH_PIANIST_SITE.yaw;
    this.#shoreline = new PianistShoreline(this.#map, -y);
    this.group.add(this.#shoreline.group, this.#stage);
    this.group.updateMatrixWorld(true);

    // Spatial voice at the soundboard.
    this.#audio = new BeachPianistAudio(SONGS[0].audio);
    this.#stage.localToWorld(this.#tmp.copy(VOICE_LOCAL));
    this.#audio.setVoicePosition(this.#tmp.x, this.#tmp.y, this.#tmp.z);
    this.#conversation = createBeachPianistConversation({
      group: this.group,
      anchor: this.#pianist.rig.head,
      awaitingRequest: () => this.awaitingRequest,
      requestPerformance: () => this.requestPerformance()
    });

    // Only chunky parts cast; keep them in the every-frame hero shadow domain.
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.castShadow) enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);
    });

    // Never let an uncompiled site into a live frame while a warmup is pending.
    if (this.#prepareRender) this.group.visible = false;
  }

  /** Feed the requested one-shot transport at time `nowMs`. Writes into a
   * reused object (no per-frame allocation). */
  #transport(nowMs: number): Transport {
    const out = this.#tp;
    const start = this.#performanceStartMs;
    if (start === null) {
      out.playing = false;
      out.songIndex = 0;
      out.songTimeMs = 0;
      return out;
    }

    const songTimeMs = Math.max(0, nowMs - start);
    if (songTimeMs < SONGS[0].durationMs) {
      out.playing = true;
      out.songIndex = 0;
      out.songTimeMs = songTimeMs;
      return out;
    }

    // Completion returns to the requestable idle state. Nothing schedules a
    // replay; only the conversation's Yes action can set a new start time.
    this.#performanceStartMs = null;
    out.playing = false;
    out.songIndex = 0;
    out.songTimeMs = SONGS[0].durationMs;
    return out;
  }

  get awaitingRequest(): boolean {
    return this.#performanceStartMs === null;
  }

  /** Starts one song from the beginning. No-op until the previous request has
   * completed, which keeps repeated input from restarting it mid-performance. */
  requestPerformance(): boolean {
    if (this.#disposed || !this.awaitingRequest) return false;
    this.#armAssets();
    this.#performanceStartMs = performance.now();
    this.#lastSongTimeMs = 0;
    this.#hi = 0;
    this.#onset = 0;
    this.#whitePress.fill(0);
    this.#blackPress.fill(0);
    return true;
  }

  get active(): boolean {
    return this.#conversation.active;
  }

  get choosing(): boolean {
    return this.#conversation.choosing;
  }

  tryInteract(player: { x: number; y?: number; z: number }, mode: string): boolean {
    return this.#conversation.tryInteract({ x: player.x, y: player.y ?? 0, z: player.z }, mode);
  }

  confirm(): boolean {
    return this.#conversation.confirm();
  }

  close(): boolean {
    return this.#conversation.close();
  }

  navigate(dy: number): boolean {
    return this.#conversation.navigate(dy);
  }

  project(camera: THREE.Camera): void {
    this.#conversation.project(camera);
  }

  #armAssets(): void {
    if (this.#notesArmed) return;
    this.#notesArmed = true;
    this.#audio.arm();
    void fetch(SONGS[0].notes)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((raw) => {
        if (this.#disposed) return;
        this.#timeline = parseNoteTimeline(raw, SONGS[0].durationMs);
      })
      .catch((error) => {
        this.#notesError = String(error).slice(0, 120);
        console.warn("[beachPianist] notes fetch failed:", error);
      });
  }

  #kickRenderWarm(): void {
    const prepare = this.#prepareRender;
    if (!prepare || this.#renderWarm !== "cold") return;
    this.#renderWarm = "warming";
    void prepare(this.group)
      .catch((error) => console.warn("[beachPianist] render warmup failed:", error))
      .finally(() => {
        this.#renderWarm = "ready";
      });
  }

  update(dt: number, _elapsed: number, playerPos: { x: number; z: number }, camera?: THREE.Camera, _gust = 0): void {
    if (this.#disposed) return;
    dt = Math.min(dt, 0.1);
    const dist = Math.hypot(playerPos.x - BEACH_PIANIST_SITE.x, playerPos.z - BEACH_PIANIST_SITE.z);

    if (dist < AUDIO_FETCH_RADIUS) this.#armAssets();

    // ---- transport + performance easing (always runs) ----
    const now = performance.now();
    const tp = this.#transport(now);
    this.#perform = damp(this.#perform, tp.playing ? 1 : 0, 3, dt);
    const songTimeMs = tp.playing ? tp.songTimeMs : 0;

    // ---- audio (joins when unlocked + near; resyncs to the transport) ----
    this.#audio.update(dist, { playing: tp.playing, songTimeSec: songTimeMs * 0.001 });

    // ---- render gate (hysteresis) + warmup ----
    if (this.#renderWarm === "cold" && dist < PRIME_RADIUS) this.#kickRenderWarm();
    if (this.group.visible) {
      if (dist > HIDE_RADIUS) this.group.visible = false;
    } else if (!this.#perfSuppressed && dist < SHOW_RADIUS && this.#renderWarm === "ready") {
      this.group.visible = true;
    }
    this.#conversation.setWorldVisible(!this.#perfSuppressed && this.group.visible);
    this.#conversation.update({ x: playerPos.x, y: 0, z: playerPos.z });
    const shorelineActive = !this.#perfSuppressed && this.group.visible && dist < ANIM_RADIUS;
    this.#shoreline.update(_elapsed, shorelineActive);
    if (!this.group.visible || dist > ANIM_RADIUS) {
      this.#lastSongTimeMs = songTimeMs;
      return;
    }

    // ---- read the baked timeline into per-hand drive + key presses ----
    this.#buildDrive(tp, songTimeMs, dt);
    this.#pianist.update(dt, now * 0.001, this.#drive);
    this.#piano.flushKeys();
    this.#lastSongTimeMs = songTimeMs;
  }

  #buildDrive(tp: Transport, songTimeMs: number, dt: number): void {
    const drive = this.#drive;
    drive.perform = this.#perform;
    const tl = this.#timeline;
    drive.left.fingerMidi.fill(-1);
    drive.right.fingerMidi.fill(-1);
    drive.left.fingerPress.fill(0);
    drive.right.fingerPress.fill(0);

    // wrap detection (rest→replay resets the song to 0)
    if (songTimeMs < this.#lastSongTimeMs - 1) {
      this.#hi = 0;
      this.#onset = 0;
      this.#whitePress.fill(0);
      this.#blackPress.fill(0);
    }

    // decay onset dips
    this.#leftDip = damp(this.#leftDip, 0, 12, dt);
    this.#rightDip = damp(this.#rightDip, 0, 12, dt);

    if (!tl || !tp.playing) {
      drive.left.active = false;
      drive.right.active = false;
      drive.left.dip = this.#leftDip;
      drive.right.dip = this.#rightDip;
      drive.loud = 0;
      // keys ease back to rest
      if (this.#keysActive) this.#pushKeyDecayToRest(dt);
      return;
    }

    // onset pulses (advance the cursor; only recent onsets kick a hand dip)
    while (this.#onset < tl.count && tl.startMs[this.#onset] <= songTimeMs) {
      if (songTimeMs - tl.startMs[this.#onset] < ONSET_DIP_MS) {
        if (tl.hand[this.#onset] === 0) this.#leftDip = 1;
        else this.#rightDip = 1;
      }
      this.#onset++;
    }

    // advance the imminent-window cursor
    const horizon = songTimeMs + IMMINENT_MS;
    while (this.#hi < tl.count && tl.startMs[this.#hi] <= horizon) this.#hi++;
    const scanLo = Math.max(0, this.#hi - 48);

    // accumulate per-hand targets over active + imminent notes, and refresh keys
    let lSumX = 0;
    let lW = 0;
    let lCount = 0;
    let lMaxVel = 0;
    let lActive = false;
    let rSumX = 0;
    let rW = 0;
    let rCount = 0;
    let rMaxVel = 0;
    let rActive = false;
    let loudAcc = 0;

    // decay all key presses first, then re-assert active ones
    const decay = Math.exp(-dt * 9);
    let anyPress = false;
    for (let i = 0; i < this.#whitePress.length; i++) {
      const v = this.#whitePress[i] * decay;
      this.#whitePress[i] = v < 0.004 ? 0 : v;
      if (this.#whitePress[i] > 0) anyPress = true;
    }
    for (let i = 0; i < this.#blackPress.length; i++) {
      const v = this.#blackPress[i] * decay;
      this.#blackPress[i] = v < 0.004 ? 0 : v;
      if (this.#blackPress[i] > 0) anyPress = true;
    }

    for (let i = scanLo; i < this.#hi; i++) {
      const start = tl.startMs[i];
      const end = tl.endMs[i];
      const active = start <= songTimeMs && end > songTimeMs;
      const imminent = start > songTimeMs && start <= horizon;
      if (!active && !imminent) continue;
      const x = keyCenterX(tl.midi[i]);
      const vel = tl.vel[i];
      const finger = tl.finger[i];
      const wristX =
        x - (finger < PIANO_FINGER_COUNT ? PIANO_FINGER_KEY_OFFSETS[tl.hand[i]][finger] : 0);
      const tracking = imminent || (active && songTimeMs - start <= FINGER_CONTACT_MS);
      const weight = active ? vel : vel * 0.4;
      if (tl.hand[i] === 0) {
        if (tracking) {
          lSumX += wristX * weight;
          lW += weight;
          lActive = true;
        }
        if (active && tracking) {
          lCount++;
          if (vel > lMaxVel) lMaxVel = vel;
        }
      } else {
        if (tracking) {
          rSumX += wristX * weight;
          rW += weight;
          rActive = true;
        }
        if (active && tracking) {
          rCount++;
          if (vel > rMaxVel) rMaxVel = vel;
        }
      }

      // Fingers pre-position inside the imminent window, strike their exact
      // assigned key, then release after the physical contact window even when
      // the recording's resonance keeps the note/key visually sustained.
      if (tracking) {
        const handDrive = tl.hand[i] === 0 ? drive.left : drive.right;
        if (finger < PIANO_FINGER_COUNT) {
          if (active) {
            const attack = clamp((songTimeMs - start) / 22, 0, 1);
            if (handDrive.fingerMidi[finger] < 0 || attack >= handDrive.fingerPress[finger]) {
              handDrive.fingerMidi[finger] = tl.midi[i];
              handDrive.fingerPress[finger] = attack;
            }
          } else if (
            handDrive.fingerMidi[finger] < 0 &&
            !handDrive.fingerMidi.includes(tl.midi[i])
          ) {
            // Do not pre-hover a second digit over a repeated key while the
            // currently assigned finger is still completing its strike.
            handDrive.fingerMidi[finger] = tl.midi[i];
          }
        }
      }
      if (active) {
        loudAcc += vel;
        const slot = KEY_SLOT[tl.midi[i]];
        if (slot >= 0) {
          const attack = clamp((songTimeMs - start) / 22, 0, 1);
          if (KEY_IS_BLACK[tl.midi[i]]) this.#blackPress[slot] = Math.max(this.#blackPress[slot], attack);
          else this.#whitePress[slot] = Math.max(this.#whitePress[slot], attack);
          anyPress = true;
        }
      }
    }

    if (lW > 0) this.#lastLeftTargetX = lSumX / lW;
    if (rW > 0) this.#lastRightTargetX = rSumX / rW;
    drive.left.targetX = this.#lastLeftTargetX;
    drive.right.targetX = this.#lastRightTargetX;
    drive.left.active = lActive;
    drive.right.active = rActive;
    drive.left.dip = this.#leftDip;
    drive.right.dip = this.#rightDip;
    drive.left.clasp = clamp(0.25 + 0.2 * (lCount - 1) + lMaxVel / 320, 0, 1);
    drive.right.clasp = clamp(0.25 + 0.2 * (rCount - 1) + rMaxVel / 320, 0, 1);
    drive.loud = clamp(loudAcc / 260, 0, 1);

    // push key matrices (only while something is or was pressed)
    if (anyPress || this.#keysActive) {
      for (let i = 0; i < this.#whitePress.length; i++) this.#piano.setWhitePress(i, this.#whitePress[i]);
      for (let i = 0; i < this.#blackPress.length; i++) this.#piano.setBlackPress(i, this.#blackPress[i]);
    }
    this.#keysActive = anyPress;
  }

  #pushKeyDecayToRest(dt: number): void {
    const decay = Math.exp(-dt * 9);
    let anyPress = false;
    for (let i = 0; i < this.#whitePress.length; i++) {
      const v = this.#whitePress[i] * decay;
      this.#whitePress[i] = v < 0.004 ? 0 : v;
      this.#piano.setWhitePress(i, this.#whitePress[i]);
      if (this.#whitePress[i] > 0) anyPress = true;
    }
    for (let i = 0; i < this.#blackPress.length; i++) {
      const v = this.#blackPress[i] * decay;
      this.#blackPress[i] = v < 0.004 ? 0 : v;
      this.#piano.setBlackPress(i, this.#blackPress[i]);
      if (this.#blackPress[i] > 0) anyPress = true;
    }
    this.#keysActive = anyPress;
  }

  /** Test hook: warp a requested performance to `songMs`; values at or beyond
   * the duration put the pianist back into the requestable idle state. */
  debugWarp(songMs: number): void {
    this.#performanceStartMs = songMs < SONGS[0].durationMs
      ? performance.now() - Math.max(0, songMs)
      : null;
    this.#lastSongTimeMs = 0;
    this.#hi = 0;
    this.#onset = 0;
  }

  isPlayerInGodRayArea(playerPos: { x: number; z: number }): boolean {
    const dx = playerPos.x - BEACH_PIANIST_SITE.x;
    const dz = playerPos.z - BEACH_PIANIST_SITE.z;
    return dx * dx + dz * dz <= BEACH_PIANIST_GOD_RAY_RADIUS * BEACH_PIANIST_GOD_RAY_RADIUS;
  }

  /** Allocate only after the player has crossed the 30 m gate. The expensive
   * radial render graph remains a separate dynamic import owned by pipeline.ts. */
  get radialLightSource() {
    if (!this.#radialSource) {
      this.#radialSource = createBeachPianistRadialSource({
        x: BEACH_PIANIST_SITE.x,
        y: this.group.position.y,
        z: BEACH_PIANIST_SITE.z
      });
    }
    return this.#radialSource.source;
  }

  releaseRadialLightSource(): void {
    this.#radialSource?.dispose();
    this.#radialSource = null;
  }

  setPerfSuppressed(suppressed: boolean): void {
    this.#perfSuppressed = suppressed;
    this.#conversation.setWorldVisible(!suppressed && this.group.visible);
    if (suppressed) {
      this.#conversation.close();
      this.group.visible = false;
      this.#shoreline.update(0, false);
    }
  }

  tuningDescriptor(): DebugFeatureTuningRegistration {
    return {
      id: "beach-pianist-shoreline",
      title: "Beach Pianist · shoreline",
      build(folder) {
        bindBeachPianistShorelineTuning(folder);
      }
    };
  }

  get debugState() {
    const tp = this.#transport(performance.now());
    this.group.updateMatrixWorld(true);
    this.#pianist.handWorldX(this.#handX);
    // expected key world X for each hand (target key centre transformed to world)
    const expectL = this.#stage.localToWorld(this.#tmp.set(this.#lastLeftTargetX, KEY_CONTACT.top, KEY_CONTACT.z)).x;
    const expectR = this.#stage.localToWorld(this.#tmp.set(this.#lastRightTargetX, KEY_CONTACT.top, KEY_CONTACT.z)).x;
    return {
      x: BEACH_PIANIST_SITE.x,
      z: BEACH_PIANIST_SITE.z,
      yaw: BEACH_PIANIST_SITE.yaw,
      groundY: this.group.position.y,
      visible: this.group.visible,
      renderWarm: this.#renderWarm,
      notesArmed: this.#notesArmed,
      notesReady: this.#timeline != null,
      notesError: this.#notesError,
      awaitingRequest: this.awaitingRequest,
      conversationActive: this.active,
      phase: tp.playing ? "playing" : "rest",
      songIndex: tp.songIndex,
      songTimeMs: tp.songTimeMs,
      perform: this.#perform,
      godRayRadius: BEACH_PIANIST_GOD_RAY_RADIUS,
      godRaySourceAllocated: this.#radialSource !== null,
      handLXWorld: this.#handX.l,
      handRXWorld: this.#handX.r,
      expectLXWorld: expectL,
      expectRXWorld: expectR,
      leftTargetX: this.#lastLeftTargetX,
      rightTargetX: this.#lastRightTargetX,
      leftFingerMidi: Array.from(this.#drive.left.fingerMidi),
      rightFingerMidi: Array.from(this.#drive.right.fingerMidi),
      leftFingerPress: Array.from(this.#drive.left.fingerPress),
      rightFingerPress: Array.from(this.#drive.right.fingerPress),
      shoreline: this.#shoreline.debugState,
      audio: this.#audio.debugState()
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#conversation.dispose();
    this.#audio.dispose();
    this.releaseRadialLightSource();
    this.#shoreline.dispose();
    this.#pianist.dispose();
    this.#piano.dispose();
    this.group.parent?.remove(this.group);
    this.group.clear();
  }
}
