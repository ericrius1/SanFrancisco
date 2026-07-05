import * as THREE from "three/webgpu";
import { buildPlaneMesh, collectPlaneAnim, type PlaneAnim } from "../vehicles/plane";
import { buildBirdMesh } from "../vehicles/bird";
import { poseBone, type BirdRig } from "../vehicles/bird/mesh";

/**
 * The "-" flyover: a wave of planes and phoenixes streaks in from behind the
 * camera, sweeps overhead along whatever way the player is facing, and recedes
 * straight ahead into the distance — staying in frame as it shrinks toward the
 * horizon. Pure CPU-kinematic (no physics bodies, no colliders): each craft
 * flies a dead-straight ray captured at trigger time, so the whole formation
 * reads the same every run and never wanders out of shot. Mirrors the
 * RocketRiders lifecycle — spawn, move meshes each frame, cull by distance.
 *
 * Altitude is deliberately modest (a few dozen metres over the player): high
 * enough to whoosh overhead, low enough that once the craft are well ahead they
 * sit just above the horizon line instead of climbing out the top of the frame.
 */
export const FLYOVER_TUNING = {
  planes: 6, // planes per wave
  birds: 7, // phoenixes per wave
  planeAlt: 30, // metres over the player — a low, close pass reads far bigger than a high one that shrinks to specks
  birdAlt: 22, // phoenixes fly a touch lower so they layer under the planes
  altJitter: 7, // random spread on cruise altitude
  planeSpeed: 60, // m/s — planes overtake the player and pull ahead (a hair slower = a longer, readable pass)
  birdSpeed: 46, // phoenixes cruise slower, so the planes streak past them
  spread: 13, // lateral spacing between craft in a wave (kept tight = reads as one flight)
  // fly the flight up the strait OFF to one side of the bridge, over open water:
  // dead down the centreline they merge with the tower/cables/deck and vanish,
  // and a moderate side pass keeps them big and clear against the bay the whole way.
  sideOffset: 80,
  startBack: 60, // how far behind the player the lead craft starts
  backStagger: 20, // extra setback per craft so they stream past, not clump
  // hold a low, steady altitude as they recede so they stay big against the water
  glideDist: 1400, // metres over which they ease from cruise to the settle altitude
  lowAlt: 20, // settle altitude — a low cruise up the strait
  lowAltJitter: 5,
  planeScale: 2.1, // read-at-distance size bump
  birdScale: 2.5,
  bank: 0.16, // steady banked-turn roll amplitude
  bobAmp: 1.1, // gentle vertical bob so nothing looks rigid
  farLimit: 1250, // cull once this far ahead of the trigger point
  maxLife: 26, // hard lifetime backstop (seconds)
  maxCraft: 48, // total live craft cap (spamming "-" can't runaway)
  cooldown: 0.5 // min seconds between triggers
};

type Craft = {
  kind: "plane" | "bird";
  mesh: THREE.Group;
  origin: THREE.Vector3;
  fwd: THREE.Vector3;
  right: THREE.Vector3;
  yaw: number;
  lateral: number;
  alt: number; // cruise altitude over the origin during the overhead pass
  lowAlt: number; // settle altitude once well downrange (glides down to this)
  along: number;
  speed: number;
  bankAmp: number;
  bobAmp: number;
  bobRate: number;
  phase: number;
  life: number;
  planeAnim?: PlaneAnim;
  flapPhase?: number;
  animT?: number;
};

const UP = new THREE.Vector3(0, 1, 0);
const TMP = {
  right: new THREE.Vector3(),
  euler: new THREE.Euler(0, 0, 0, "YXZ"),
  quat: new THREE.Quaternion()
};

/** Reveal every mesh under a freshly built embodiment (the phoenix GLB resolves
 *  async and reads embodimentVisible when it lands). */
function reveal(root: THREE.Group) {
  root.userData.embodimentVisible = true;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.visible = true;
  });
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

export class Flyover {
  #scene: THREE.Scene;
  #craft: Craft[] = [];
  #cool = 0;
  #warmed = false;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
  }

  get count(): number {
    return this.#craft.length;
  }

  /**
   * Warm the phoenix GLB (fetch + parse + GPU upload) ahead of time so a wave
   * triggered mid-cinematic spawns its birds instantly instead of popping in a
   * few frames late when the async load lands. Enables THREE.Cache so every
   * subsequent buildBirdMesh() reuses the one fetched GLB. Idempotent; the warm
   * bird is parked far below the world and never seen.
   */
  preload() {
    if (this.#warmed) return;
    this.#warmed = true;
    THREE.Cache.enabled = true;
    const b = buildBirdMesh();
    b.visible = false;
    b.position.set(0, -100000, 0);
    this.#scene.add(b);
  }

  /** Debug: live craft world positions (headless framing checks). */
  debugCraft() {
    return this.#craft.map((c) => ({
      kind: c.kind,
      x: +c.mesh.position.x.toFixed(1),
      y: +c.mesh.position.y.toFixed(1),
      z: +c.mesh.position.z.toFixed(1),
      along: +c.along.toFixed(0),
      hasRig: c.kind === "bird" ? !!c.mesh.userData.rig : true
    }));
  }

  /**
   * Launch a flyover from `origin`, streaking along the horizontal `fwd`
   * direction (front the player is facing). Both vectors are copied.
   */
  trigger(origin: THREE.Vector3, fwd: THREE.Vector3) {
    if (this.#cool > 0 || this.#craft.length >= FLYOVER_TUNING.maxCraft) return;
    this.#cool = FLYOVER_TUNING.cooldown;
    const t = FLYOVER_TUNING;

    const f = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (f.lengthSq() < 1e-4) f.set(0, 0, -1);
    f.normalize();
    const right = new THREE.Vector3().crossVectors(f, UP).normalize();
    const yaw = Math.atan2(-f.x, -f.z);
    const o = origin.clone();

    const spawnWave = (kind: "plane" | "bird", n: number, baseAlt: number, speed: number, scale: number) => {
      for (let i = 0; i < n; i++) {
        const mesh = kind === "plane" ? buildPlaneMesh() : buildBirdMesh();
        reveal(mesh);
        mesh.scale.setScalar(scale);
        this.#scene.add(mesh);
        // line-abreast wave, centred on the travel line; outer craft trail a
        // little (a shallow V) so the formation reads with depth
        const lateral = t.sideOffset + (i - (n - 1) / 2) * t.spread + (Math.random() - 0.5) * 2.5;
        const along = -(t.startBack + i * t.backStagger + (kind === "bird" ? 10 : 0)) - Math.abs(lateral) * 0.5;
        const c: Craft = {
          kind,
          mesh,
          origin: o,
          fwd: f,
          right,
          yaw,
          lateral,
          alt: baseAlt + (Math.random() - 0.5) * t.altJitter,
          lowAlt: t.lowAlt + (Math.random() - 0.5) * t.lowAltJitter,
          along,
          speed: speed * (0.92 + Math.random() * 0.16),
          bankAmp: t.bank * (0.6 + Math.random() * 0.8) * (i % 2 ? -1 : 1),
          bobAmp: t.bobAmp * (0.6 + Math.random()),
          bobRate: 0.7 + Math.random() * 0.6,
          phase: Math.random() * Math.PI * 2,
          life: 0
        };
        if (kind === "plane") c.planeAnim = collectPlaneAnim(mesh);
        else {
          c.flapPhase = Math.random() * Math.PI * 2;
          c.animT = 0;
        }
        this.#craft.push(c);
      }
    };

    spawnWave("plane", t.planes, t.planeAlt, t.planeSpeed, t.planeScale);
    spawnWave("bird", t.birds, t.birdAlt, t.birdSpeed, t.birdScale);
  }

  update(dt: number) {
    if (this.#cool > 0) this.#cool -= dt;
    const t = FLYOVER_TUNING;
    for (let i = this.#craft.length - 1; i >= 0; i--) {
      const c = this.#craft[i];
      c.along += c.speed * dt;
      c.life += dt;

      // glide down from cruise to the settle altitude as they pull ahead, so
      // they track toward the horizon and keep receding in-frame (a level cruise
      // gets shoved off the top of the deck-pitched chase cam)
      const glide = THREE.MathUtils.clamp(c.along / t.glideDist, 0, 1);
      const ease = glide * glide * (3 - 2 * glide);
      const alt = c.alt * (1 - ease) + c.lowAlt * ease;
      const bob = Math.sin(c.life * c.bobRate + c.phase) * c.bobAmp;
      c.mesh.position
        .copy(c.origin)
        .addScaledVector(c.fwd, c.along)
        .addScaledVector(c.right, c.lateral);
      c.mesh.position.y = c.origin.y + alt + bob;

      // banked-turn roll + a gentle nose-down while descending
      const roll = Math.sin(c.life * 0.5 + c.phase) * c.bankAmp;
      const descentPitch = -((c.alt - c.lowAlt) / t.glideDist) * (glide < 1 ? 1 : 0) * 0.9;
      const pitch = Math.cos(c.life * c.bobRate + c.phase) * 0.03 + descentPitch;
      TMP.euler.set(pitch, c.yaw, roll);
      c.mesh.quaternion.setFromEuler(TMP.euler);

      if (c.kind === "plane" && c.planeAnim) {
        const spin = dt * (7 + c.speed * 0.55);
        for (const p of c.planeAnim.props) p.rotation.z += spin;
      } else if (c.kind === "bird") {
        this.#flap(c, dt);
      }

      if (c.along > t.farLimit || c.life > t.maxLife) {
        c.mesh.removeFromParent();
        disposeObject(c.mesh);
        this.#craft.splice(i, 1);
      }
    }
  }

  /** Lighter travelling-wave wingbeat (echo of the playable phoenix / abandoned
   *  bird flap); no-ops until the GLB skeleton resolves. */
  #flap(c: Craft, dt: number) {
    const r = c.mesh.userData.rig as BirdRig | undefined;
    if (!r) return;
    c.animT = (c.animT ?? 0) + dt;
    c.flapPhase = (c.flapPhase ?? 0) + dt * Math.PI * 2 * 2.3;
    const wingBeat = (ph: number) => {
      const wr = ph - 0.35 * Math.sin(ph);
      const s = Math.sin(wr) + 0.15 * Math.sin(2 * wr - 0.5);
      return s > 0 ? s : s * 0.4;
    };
    const drive = 0.5;
    const seg = 1.05;
    const wave = (i: number) => wingBeat((c.flapPhase ?? 0) - i * seg);
    const up = 0.08 + wave(0) * drive * 0.85;
    poseBone(r.wingL, 0, 0, up);
    poseBone(r.wingR, 0, 0, -up);
    poseBone(r.elbowL, 0, 0, wave(1) * drive);
    poseBone(r.elbowR, 0, 0, -wave(1) * drive);
    poseBone(r.handL, 0, 0, wave(2) * drive * 1.18);
    poseBone(r.handR, 0, 0, -wave(2) * drive * 1.18);
    for (let i = 0; i < r.tail.length; i++) {
      poseBone(r.tail[i], 0, Math.sin((c.animT ?? 0) * 2.0 - i * 0.75) * 0.08 * (0.3 + i * 0.3), 0);
    }
  }
}
