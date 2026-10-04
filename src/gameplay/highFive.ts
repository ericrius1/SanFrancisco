import * as THREE from "three/webgpu";
import type { GameplaySfxBus } from "../audio/gameplaySfxBus";
import { effectsAudioLevel } from "../core/audioSettings";

/**
 * High fives. Pure presentation on top of the relayed emote channel: every
 * client watches who raised a hand (itself and every remote), and when two
 * hands go up within a beat of each other at arm's reach, it plays the slap —
 * a spark burst between them and a crisp clap — at the moment both palms are
 * at the top of the swing. No new wire message and no authority: each client
 * reaches the same verdict from the same relayed emotes, and a friend watching
 * two strangers high-five sees it too.
 *
 * The burst is created lazily on the first slap (one sprite material, a small
 * pool), so a session that never high-fives never builds it.
 */

/** Seconds into the emote at which the palms meet (see emotes.ts poseHighFive). */
export const HIGH_FIVE_CONTACT_T = 0.55;
/** Two raises further apart than this are two separate, unanswered hands. */
const PAIR_WINDOW_S = 1.4;
/** Torso-to-torso distance that counts as arm's reach. */
const REACH_M = 2.3;
const SPARKS = 28;

type Raise = { key: string; at: number; matched: boolean };

type Spark = { sprite: THREE.Sprite; vel: THREE.Vector3; life: number; max: number };

export type HighFiveDeps = {
  scene: THREE.Scene;
  sfx: GameplaySfxBus | null;
  /** World position (feet) of a participant: "self" or a remote id as string. */
  positionOf(key: string, out: THREE.Vector3): boolean;
};

export class HighFives {
  #deps: HighFiveDeps;
  #raises: Raise[] = [];
  #pending: { at: number; a: string; b: string }[] = [];
  #sparks: Spark[] = [];
  #material: THREE.SpriteMaterial | null = null;
  #group: THREE.Group | null = null;
  #now = 0;
  #slaps = 0;
  readonly #pa = new THREE.Vector3();
  readonly #pb = new THREE.Vector3();

  constructor(deps: HighFiveDeps) {
    this.#deps = deps;
  }

  get debugState() {
    return { slaps: this.#slaps, raises: this.#raises.length, sparks: this.#sparks.length };
  }

  /** A participant started the high-five emote. */
  raise(key: string): void {
    // A re-raise by the same person replaces their earlier hand.
    this.#raises = this.#raises.filter((r) => r.key !== key);
    const raise: Raise = { key, at: this.#now, matched: false };
    for (const other of this.#raises) {
      if (other.matched || this.#now - other.at > PAIR_WINDOW_S) continue;
      if (!this.#deps.positionOf(key, this.#pa) || !this.#deps.positionOf(other.key, this.#pb)) continue;
      if (this.#pa.distanceTo(this.#pb) > REACH_M) continue;
      other.matched = raise.matched = true;
      // The later hand sets the beat: palms meet at its contact time.
      this.#pending.push({ at: this.#now + HIGH_FIVE_CONTACT_T, a: other.key, b: key });
      break;
    }
    this.#raises.push(raise);
  }

  update(dt: number): void {
    this.#now += dt;
    this.#raises = this.#raises.filter((r) => this.#now - r.at <= PAIR_WINDOW_S);
    for (let i = this.#pending.length - 1; i >= 0; i--) {
      const p = this.#pending[i];
      if (this.#now < p.at) continue;
      this.#pending.splice(i, 1);
      if (this.#deps.positionOf(p.a, this.#pa) && this.#deps.positionOf(p.b, this.#pb)) {
        // Hands meet above the midpoint, at a raised-palm height.
        this.#pa.add(this.#pb).multiplyScalar(0.5);
        this.#pa.y += 1.75;
        this.#slap(this.#pa);
      }
    }
    for (let i = this.#sparks.length - 1; i >= 0; i--) {
      const s = this.#sparks[i];
      s.life += dt;
      if (s.life >= s.max) {
        s.sprite.visible = false;
        this.#sparks.splice(i, 1);
        continue;
      }
      const k = s.life / s.max;
      s.vel.y -= 5.5 * dt;
      s.vel.multiplyScalar(Math.exp(-2.2 * dt));
      s.sprite.position.addScaledVector(s.vel, dt);
      const size = 0.16 * (1 - k * 0.7);
      s.sprite.scale.set(size, size, size);
    }
    if (this.#material) this.#material.opacity = this.#sparks.length ? 1 : 0;
  }

  #slap(at: THREE.Vector3): void {
    this.#slaps++;
    this.#burst(at);
    this.#sound(at);
  }

  #burst(at: THREE.Vector3): void {
    if (!this.#material) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
      g.addColorStop(0, "rgba(255,255,240,1)");
      g.addColorStop(0.25, "rgba(255,214,120,0.95)");
      g.addColorStop(1, "rgba(255,120,60,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      this.#material = new THREE.SpriteMaterial({
        map,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false
      });
      this.#group = new THREE.Group();
      this.#group.name = "highFiveSparks";
      this.#deps.scene.add(this.#group);
    }
    const group = this.#group!;
    for (let i = 0; i < SPARKS; i++) {
      let spark = group.children.find((c) => !c.visible) as THREE.Sprite | undefined;
      if (!spark) {
        if (group.children.length >= SPARKS * 3) break;
        spark = new THREE.Sprite(this.#material!);
        spark.frustumCulled = false;
        group.add(spark);
      }
      spark.visible = true;
      spark.position.copy(at);
      // A flat-ish starburst: fast in the horizontal plane, a little lift.
      const a = (i / SPARKS) * Math.PI * 2 + Math.random() * 0.3;
      const up = (Math.random() - 0.3) * 2.2;
      const speed = 3 + Math.random() * 3.5;
      this.#sparks.push({
        sprite: spark,
        vel: new THREE.Vector3(Math.cos(a) * speed, up + 1.2, Math.sin(a) * speed),
        life: 0,
        max: 0.45 + Math.random() * 0.35
      });
    }
  }

  #sound(at: THREE.Vector3): void {
    const io = this.#deps.sfx?.voiceBus(1.2);
    if (!io) return;
    const level = effectsAudioLevel();
    if (level <= 0) return;
    const { ctx, dry, room, noise } = io;
    const now = ctx.currentTime;
    const panner = ctx.createPanner();
    panner.panningModel = "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = 4;
    panner.maxDistance = 120;
    panner.positionX.value = at.x;
    panner.positionY.value = at.y;
    panner.positionZ.value = at.z;
    panner.connect(dry);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    panner.connect(send).connect(room);
    // Two stacked palm transients: a bright crack over a short hollow body.
    const voices: AudioScheduledSourceNode[] = [];
    const crack = (delay: number, freq: number, gain: number, len: number) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = 1.1;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + delay);
      g.gain.exponentialRampToValueAtTime(gain * level, now + delay + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + len);
      src.connect(bp).connect(g).connect(panner);
      src.start(now + delay, Math.random() * Math.max(0.01, noise.duration - 0.2));
      src.stop(now + delay + len + 0.02);
      voices.push(src);
    };
    crack(0, 2400, 0.9, 0.07);
    crack(0.004, 1100, 0.7, 0.11);
    crack(0.011, 4200, 0.35, 0.05);
    voices[voices.length - 1].onended = () => {
      panner.disconnect();
      send.disconnect();
    };
  }

  dispose(): void {
    this.#group?.removeFromParent();
    this.#material?.map?.dispose();
    this.#material?.dispose();
    this.#group = null;
    this.#material = null;
    this.#sparks.length = 0;
  }
}
