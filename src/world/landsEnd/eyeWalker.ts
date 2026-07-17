import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { LIGHT_SCALE } from "../../config";
import { TrioAudio } from "../../gameplay/buskers/audio";
import { buildUkulelist } from "../../gameplay/buskers/ukulelist";
import { COUNTIN_BEATS, SEC_PER_BEAT } from "../../gameplay/buskers/song";
import type { Musician, NoteEvent, TrioClock, TrioPhase } from "../../gameplay/buskers/types";
import { enableShadowLayer, SHADOW_LAYERS } from "../shadows/shadowLayers";
import { attachKtx2Loader } from "../../render/textures";
import { WINDOW_GLOW_W } from "../facade";
import type { WorldMap } from "../heightmap";
import { KEEPER, LABYRINTH } from "./layout";
import { WALKER_REST_MAX, WALKER_REST_MIN, WALKER_SONGS } from "./walkerSongs";

/**
 * The eye-walker — a towering folk-art creature (Tripo-generated GLB: a
 * many-eyed teal moon face, chevron-striped body, fringed eye-shoulders) that
 * paces the plateau around the Lands End labyrinth at its own patient gait.
 * The busker trio's ginger ukulelist rides its shoulders, legs dangling down
 * the striped chest, playing a solo mystical songbook (walkerSongs.ts): a
 * piece, a long rest in the sea wind, the next piece.
 *
 * Loading follows the massive-app policy: constructing this class costs a
 * Group and some numbers. The GLB fetch + rider build + audio graph arm only
 * when the player first comes within LOAD_RADIUS of the labyrinth.
 *
 * The walk/idle clips are Tripo v1.0-rig retargets baked with root motion;
 * we strip the ROOT bone's horizontal position track at import (per the
 * asset-pipeline contract — never `animate_in_place`) and drive locomotion
 * from the wander brain instead.
 */

const MODEL_URL = "/models/eye-walker.glb";
const TARGET_HEIGHT = 3.4; // m — a giant, but not a kaiju
/** Extra yaw on the loaded scene so the creature's face and its baked march
 * direction both point along local +Z (the wander brain's forward).
 * MEASURED, not guessed: the auto-rig's L/R_Upperarm bones separate along the
 * model's Z axis (L +0.82, R -0.68 with no yaw), so the doll's left-right axis
 * is Z and it faces -X in raw model space — a quarter turn, not a half. */
const MODEL_YAW = -Math.PI / 2;
const LOAD_RADIUS = 320; // player→labyrinth distance that arms the asset fetch
const ANIM_RADIUS = 200; // beyond this the mixer/rider skip their per-frame work
const WALK_SPEED = 1.05; // m/s — processional
const WALK_CLIP_STRIDE = 1.45; // m the preset walk covers per cycle at our scale (tuned by eye)
const TURN_RATE = 1.4; // rad/s toward the current waypoint
// Wander annulus around the labyrinth centre. Inner keeps the creature off the
// spiral stones; outer keeps it on the sculpted plateau shelf.
const WANDER_R_MIN = 20;
const WANDER_R_MAX = 42;
const AVOID_CORE_R = 18; // no path chord may pass closer to the centre than this
const KEEPER_CLEAR = 7; // stay out of the lantern-keeper's spot
const PLATEAU_Y_TOLERANCE = 6; // reject waypoints that fall off the terrace shelf
const ARRIVE_DIST = 2.4;
const LOOKAHEAD_SECONDS = 0.4;
const COUNTIN_SECONDS = COUNTIN_BEATS * SEC_PER_BEAT;
// Reuse the creature's albedo as emission so its folk-art colours remain
// intact. The sky's shared twilight ramp keeps this completely dark by day.
const NIGHT_GLOW_PEAK = 0.78 * LIGHT_SCALE;
// Rider saddle: musician group origin (his hips) relative to the creature's
// head-bone world position. The creature is a giant ball-head doll — "on his
// shoulders" means seated on the ruffled collar right behind the head, legs
// straddling it, so the offsets sit behind and slightly above the head bone.
const SADDLE_BACK = 0.42; // m behind the head bone (toward the creature's back)
const SADDLE_DOWN = -0.35; // m below the head-bone origin (negative = above — he rides high on the back slope of the huge head so he reads from the front)
const VOICE_HEIGHT = 0.55; // sound source at the rider's chest

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();

function sampleRest(): number {
  return WALKER_REST_MIN + Math.random() * (WALKER_REST_MAX - WALKER_REST_MIN);
}

/** Silent tap for audio-less contexts (schedule() is never invoked there). */
function makeSilentTap() {
  return {
    ctx: null as unknown as AudioContext,
    out: null as unknown as GainNode,
    reverb: null as unknown as GainNode
  };
}

export class EyeWalker {
  readonly group = new THREE.Group();

  #map: WorldMap;
  /** Optional detached pipeline warmup, injected by main.ts's loader so the
   * first visible frame never compiles mid-frame. */
  prepareRender: ((root: THREE.Object3D) => Promise<void>) | null = null;

  // ---- lazy asset state ----
  #armed = false;
  #ready = false;
  #disposed = false;
  #mixer: THREE.AnimationMixer | null = null;
  #walkAction: THREE.AnimationAction | null = null;
  #idleAction: THREE.AnimationAction | null = null;
  #headBone: THREE.Object3D | null = null;
  #creatureRoot: THREE.Group | null = null;
  #glowMaterials: THREE.MeshStandardMaterial[] = [];
  #glowAmount = 0;

  // ---- rider + music ----
  #audio: TrioAudio | null = null;
  #rider: Musician | null = null;
  #riderGroup: THREE.Group | null = null;
  #phase: TrioPhase = "rest";
  #phaseTime = 0;
  #restSeconds = 6; // short first wait so an arriving player hears something soon
  #songIdx = 0;
  #song = WALKER_SONGS[0];
  #songSeconds = WALKER_SONGS[0].beats * SEC_PER_BEAT;
  #schedIdx = 0;
  #anchor = 0;
  #clock: TrioClock = { phase: "rest", phaseTime: 0, songTime: 0, beat: 0, wind: 0.3 };
  #elapsed = 0;
  #notesScheduled = 0;
  #audioError: string | null = null;

  // ---- wander brain ----
  #pos = new THREE.Vector3();
  #yaw = 0;
  #target = new THREE.Vector2();
  #dwell = 0;
  #moving = 0; // eased 0..1 walk weight

  constructor(map: WorldMap) {
    this.#map = map;
    this.group.name = "landsEnd.eyeWalker";
    // spawn on the far (seaward-north) side of the spiral from the keeper
    const a = LABYRINTH.startAngle + Math.PI * 0.9;
    this.#pos.set(
      LABYRINTH.x + Math.cos(a) * 30,
      0,
      LABYRINTH.z + Math.sin(a) * 30
    );
    this.#pos.y = map.groundTop(this.#pos.x, this.#pos.z);
    this.#pickTarget();
  }

  /** Player distance to the labyrinth arms the one-time asset load. */
  #maybeArm(px: number, pz: number) {
    if (this.#armed) return;
    const d = Math.hypot(px - LABYRINTH.x, pz - LABYRINTH.z);
    if (d > LOAD_RADIUS) return;
    this.#armed = true;
    void this.#loadAssets().catch((error) => {
      console.warn("[eyeWalker] asset load failed:", error);
    });
  }

  async #loadAssets(): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    await attachKtx2Loader(loader); // eye-walker.glb ships KTX2 (KHR_texture_basisu)
    const gltf = await loader.loadAsync(MODEL_URL);
    if (this.#disposed) return;

    const scene = gltf.scene;
    // normalize: measured height → TARGET_HEIGHT, feet on local y=0
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(_v0);
    const scale = TARGET_HEIGHT / Math.max(size.y, 1e-3);
    const root = new THREE.Group();
    root.name = "eyeWalker.creature";
    root.scale.setScalar(scale);
    scene.position.y -= box.min.y; // feet to origin (pre-scale space)
    scene.rotation.y = MODEL_YAW;
    root.add(scene);

    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false; // skinned bounds lag the pose
      enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);

      // The Tripo asset currently shares one textured standard material, but
      // keep this correct if a later export splits it into several primitives.
      // Reusing `map` as `emissiveMap` makes the painted eyes and chevrons glow
      // in their authored colours instead of flattening the creature to white.
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        if (!standard.isMeshStandardMaterial || this.#glowMaterials.includes(standard)) continue;
        standard.emissive.set(0xffffff);
        standard.emissiveMap = standard.map;
        standard.emissiveIntensity = 0;
        standard.needsUpdate = true;
        this.#glowMaterials.push(standard);
      }
    });
    this.#headBone = findHeadBone(scene);

    // clips: measure the walk's baked root travel (for gait speed), then strip
    // the root bone's horizontal drift and keep only the vertical bob
    const clips = gltf.animations ?? [];
    const walkClip = clips.find((c) => /walk/i.test(c.name)) ?? clips[0];
    const idleClip = clips.find((c) => /idle/i.test(c.name)) ?? clips[1] ?? walkClip;
    let walkTravel = 0; // metres per clip cycle, in world units after normalize
    for (const clip of clips) {
      for (const tr of clip.tracks) {
        if (!/(^|\.)Root\.position$/.test(tr.name)) continue;
        const v = tr.values;
        if (clip === walkClip && v.length >= 6) {
          const last = v.length - 3;
          walkTravel = Math.hypot(v[last] - v[0], v[last + 2] - v[2]) * scale;
        }
        const x0 = v[0];
        const z0 = v[2];
        for (let i = 0; i < v.length; i += 3) {
          v[i] = x0;
          v[i + 2] = z0;
        }
      }
    }
    const mixer = new THREE.AnimationMixer(scene);
    this.#walkAction = mixer.clipAction(walkClip);
    this.#idleAction = mixer.clipAction(idleClip);
    this.#walkAction.play();
    this.#idleAction.play();
    this.#walkAction.setEffectiveWeight(0);
    this.#idleAction.setEffectiveWeight(1);
    // match foot cadence to ground speed; fall back to the tuned stride guess
    const naturalSpeed = walkTravel > 0.2 ? walkTravel / walkClip.duration : WALK_CLIP_STRIDE / walkClip.duration;
    this.#walkAction.timeScale = THREE.MathUtils.clamp(WALK_SPEED / naturalSpeed, 0.45, 1.7);
    this.#mixer = mixer;
    this.#creatureRoot = root;

    // ---- rider: the trio's ukulelist on a solo engagement ----
    this.#audio = new TrioAudio();
    const tap = this.#audio.channel("ukulele") ?? makeSilentTap();
    const rider = buildUkulelist(tap, this.#song.part);
    const riderGroup = new THREE.Group();
    riderGroup.name = "eyeWalker.rider";
    riderGroup.add(rider.group);
    this.#rider = rider;
    this.#riderGroup = riderGroup;

    this.group.add(root);
    this.group.add(riderGroup);
    this.group.visible = false;
    if (this.prepareRender) {
      await this.prepareRender(this.group).catch(() => {});
      if (this.#disposed) return;
    }
    this.group.visible = true;
    this.#ready = true;
  }

  /* --------------------------------------------------------- wander brain */

  #pickTarget() {
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = WANDER_R_MIN + Math.random() * (WANDER_R_MAX - WANDER_R_MIN);
      const x = LABYRINTH.x + Math.cos(a) * r;
      const z = LABYRINTH.z + Math.sin(a) * r;
      if (Math.hypot(x - KEEPER.x, z - KEEPER.z) < KEEPER_CLEAR) continue;
      // stay on the terrace shelf (the plateau falls toward the sea WNW)
      const y = this.#map.groundTop(x, z);
      if (Math.abs(y - LABYRINTH.terraceY) > PLATEAU_Y_TOLERANCE) continue;
      // the straight path must not cut across the spiral stones
      if (chordDistToCenter(this.#pos.x, this.#pos.z, x, z) < AVOID_CORE_R) continue;
      this.#target.set(x, z);
      return;
    }
    // fallback: orbit on — a point further around the current bearing
    const cur = Math.atan2(this.#pos.z - LABYRINTH.z, this.#pos.x - LABYRINTH.x);
    const a = cur + 0.9;
    this.#target.set(LABYRINTH.x + Math.cos(a) * 30, LABYRINTH.z + Math.sin(a) * 30);
  }

  #updateWander(dt: number) {
    const dx = this.#target.x - this.#pos.x;
    const dz = this.#target.y - this.#pos.z;
    const dist = Math.hypot(dx, dz);
    let walking = false;

    if (this.#dwell > 0) {
      this.#dwell -= dt;
      if (this.#dwell <= 0) this.#pickTarget();
    } else if (dist < ARRIVE_DIST) {
      this.#dwell = 2.5 + Math.random() * 4.5; // pause, look out to sea
    } else {
      const heading = Math.atan2(dx, dz);
      let err = heading - this.#yaw;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      const maxTurn = TURN_RATE * dt;
      this.#yaw += THREE.MathUtils.clamp(err, -maxTurn, maxTurn);
      // ease off while pivoting hard so the feet don't ice-skate
      const align = THREE.MathUtils.clamp(1 - Math.abs(err) * 0.8, 0.15, 1);
      const step = WALK_SPEED * align * dt;
      this.#pos.x += Math.sin(this.#yaw) * step;
      this.#pos.z += Math.cos(this.#yaw) * step;
      walking = true;
    }

    const gy = this.#map.groundTop(this.#pos.x, this.#pos.z);
    this.#pos.y = THREE.MathUtils.damp(this.#pos.y || gy, gy, 8, dt);
    this.#moving = THREE.MathUtils.damp(this.#moving, walking ? 1 : 0, 4, dt);

    this.group.position.copy(this.#pos);
    this.group.rotation.y = this.#yaw;
  }

  /* ------------------------------------------------------------ transport */

  #enterPhase(phase: TrioPhase) {
    this.#phase = phase;
    this.#phaseTime = 0;
    if (phase === "playing") {
      this.#schedIdx = 0;
      const ctx = this.#audio?.ctx;
      this.#anchor = (ctx ? ctx.currentTime : 0) + 0.06;
    }
  }

  #updateTransport(dt: number) {
    this.#phaseTime += dt;
    const audio = this.#audio;
    const ctx = audio?.ctx ?? null;
    if (this.#phase === "playing" && ctx && audio!.running) {
      const audioPhase = ctx.currentTime - this.#anchor;
      if (Math.abs(audioPhase - this.#phaseTime) > 0.25) this.#anchor = ctx.currentTime - this.#phaseTime;
      else this.#phaseTime = audioPhase;
    }
    if (this.#phase === "playing" && this.#phaseTime >= this.#songSeconds) {
      this.#restSeconds = sampleRest();
      this.#enterPhase("rest");
      this.#songIdx = (this.#songIdx + 1) % WALKER_SONGS.length;
      this.#song = WALKER_SONGS[this.#songIdx];
      this.#songSeconds = this.#song.beats * SEC_PER_BEAT;
      this.#rider?.setPart(this.#song.part);
    } else if (this.#phase === "rest" && this.#phaseTime >= this.#restSeconds) {
      this.#enterPhase("countin");
    } else if (this.#phase === "countin" && this.#phaseTime >= COUNTIN_SECONDS) {
      this.#enterPhase("playing");
    }

    const clock = this.#clock;
    clock.phase = this.#phase;
    clock.phaseTime = this.#phaseTime;
    clock.songTime = this.#phase === "playing" ? this.#phaseTime : this.#songSeconds;
    clock.beat = clock.songTime / SEC_PER_BEAT;

    // ---- audio scheduling (lookahead window, once per event) ----
    if (this.#phase === "playing" && audio && audio.running && this.#rider) {
      const nowBeat = this.#phaseTime / SEC_PER_BEAT;
      const horizon = Math.min(this.#song.beats, (this.#phaseTime + LOOKAHEAD_SECONDS) / SEC_PER_BEAT);
      const atTime = (beat: number) => this.#anchor + beat * SEC_PER_BEAT;
      const events = this.#song.part;
      let i = this.#schedIdx;
      while (i < events.length && events[i].beat < nowBeat - 0.05) i++;
      let batch: NoteEvent[] | null = null;
      while (i < events.length && events[i].beat <= horizon) {
        (batch ??= []).push(events[i++]);
      }
      this.#schedIdx = i;
      if (batch) {
        this.#notesScheduled += batch.length;
        this.#rider.schedule(batch, atTime);
      }
    }
  }

  /** Probe/debug: jump the transport to a song beat (starts playing). */
  seek(beat: number) {
    this.#enterPhase("playing");
    this.#phaseTime = THREE.MathUtils.clamp(beat, 0, this.#song.beats) * SEC_PER_BEAT;
    const ctx = this.#audio?.ctx;
    if (ctx) this.#anchor = ctx.currentTime - this.#phaseTime;
  }

  /** Probe/debug snapshot — plain data only. */
  get debugState() {
    return {
      armed: this.#armed,
      ready: this.#ready,
      phase: this.#phase,
      phaseTime: this.#phaseTime,
      song: this.#song.name,
      songIdx: this.#songIdx,
      restSeconds: this.#restSeconds,
      beat: this.#clock.beat,
      moving: this.#moving,
      pos: [this.#pos.x, this.#pos.y, this.#pos.z] as [number, number, number],
      target: [this.#target.x, this.#target.y] as [number, number],
      yaw: this.#yaw,
      headBone: this.#headBone?.name ?? null,
      walkTimeScale: this.#walkAction?.timeScale ?? 0,
      glow: {
        amount: this.#glowAmount,
        materials: this.#glowMaterials.length
      },
      audio: {
        ctx: this.#audio?.ctx?.state ?? "none",
        running: this.#audio?.running ?? false,
        notes: this.#notesScheduled,
        error: this.#audioError
      }
    };
  }

  /* --------------------------------------------------------------- update */

  update(
    dt: number,
    elapsed: number,
    playerPos: { x: number; z: number },
    camera?: THREE.Camera,
    gust = 0
  ) {
    dt = Math.min(dt, 0.1);
    this.#elapsed += dt;
    this.#maybeArm(playerPos.x, playerPos.z);
    if (!this.#ready) return;

    this.#updateWander(dt);
    this.#updateTransport(dt);
    this.#clock.wind = THREE.MathUtils.clamp(0.18 + 0.12 * Math.sin(this.#elapsed * 0.31) + 0.85 * gust, 0, 1);

    // A slow breath keeps the emission organic while WINDOW_GLOW_W performs
    // the actual day/night gate (0 in daylight, 1 once twilight has finished).
    const breathe = 0.92 + 0.08 * Math.sin(elapsed * 1.15);
    this.#glowAmount = WINDOW_GLOW_W.value * NIGHT_GLOW_PEAK * breathe;
    for (const material of this.#glowMaterials) material.emissiveIntensity = this.#glowAmount;

    // audio follows the rider; listener follows the camera. The context is
    // created lazily in here (first approach after a user gesture) — the app
    // runs close to the browser's AudioContext budget, so a construction
    // failure must degrade to a silent performance, never break the frame.
    if (camera && this.#audio) {
      const camDist = camera.getWorldPosition(_v0).distanceTo(this.#pos);
      try {
        this.#audio.update(camera, camDist, this.#elapsed);
      } catch (error) {
        this.#audioError = String(error).slice(0, 120);
        this.#audio = null;
      }
    }

    const playerDist = Math.hypot(playerPos.x - this.#pos.x, playerPos.z - this.#pos.z);
    if (playerDist > ANIM_RADIUS) return; // transport ran; body work skipped

    // creature gait: crossfade walk/idle by movement, bob rides the clip
    if (this.#mixer && this.#walkAction && this.#idleAction) {
      this.#walkAction.setEffectiveWeight(this.#moving);
      this.#idleAction.setEffectiveWeight(1 - this.#moving);
      this.#mixer.update(dt);
    }

    // saddle: seat the rider off the head bone, upright, facing creature-forward
    const rider = this.#riderGroup;
    if (rider && this.#headBone && this.#creatureRoot) {
      this.#headBone.getWorldPosition(_v0);
      // creature-forward in world (group yaw): local +Z is forward after yaw
      _v1.set(Math.sin(this.#yaw), 0, Math.cos(this.#yaw));
      _v0.addScaledVector(_v1, -SADDLE_BACK);
      _v0.y -= SADDLE_DOWN;
      // world → group-local by hand (group matrixWorld is a frame stale here)
      _v0.sub(this.#pos).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -this.#yaw);
      rider.position.copy(_v0);
      // the seated musician faces his local -Z; π turns him to creature-forward,
      // plus a light wind sway so he reads as balancing, not bolted on
      const sway = Math.sin(this.#elapsed * 0.7) * 0.05 * this.#clock.wind;
      rider.rotation.set(0, Math.PI + sway, 0);
    }
    if (this.#rider) this.#rider.update(dt, this.#clock);

    // spatial voice at the rider's chest
    if (this.#audio && rider) {
      rider.getWorldPosition(_v1);
      this.#audio.setChannelPosition("ukulele", _v1.x, _v1.y + VOICE_HEIGHT, _v1.z);
    }
  }

  dispose() {
    this.#disposed = true;
    this.#rider?.dispose();
    this.#audio?.dispose();
    this.#mixer?.stopAllAction();
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m?.dispose();
    });
    this.group.clear();
  }
}

/** Closest distance from the labyrinth centre to the segment (x0,z0)→(x1,z1). */
function chordDistToCenter(x0: number, z0: number, x1: number, z1: number): number {
  const cx = LABYRINTH.x;
  const cz = LABYRINTH.z;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? THREE.MathUtils.clamp(((cx - x0) * dx + (cz - z0) * dz) / len2, 0, 1) : 0;
  return Math.hypot(x0 + dx * t - cx, z0 + dz * t - cz);
}

/** Find the anatomical head bone (v1.0 rig names it "Head"). */
function findHeadBone(scene: THREE.Object3D): THREE.Object3D | null {
  let head: THREE.Object3D | null = null;
  let fallback: THREE.Object3D | null = null;
  scene.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    if (/^head$/i.test(o.name)) head = o;
    else if (!fallback && /head|neck/i.test(o.name)) fallback = o;
  });
  return head ?? fallback;
}
