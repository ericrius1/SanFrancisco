import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../config";

function radialTexture(inner: string, outer: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function puffTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 34;
    const x = 64 + Math.cos(a) * r;
    const y = 64 + Math.sin(a) * r;
    const rad = 14 + Math.random() * 20;
    const g = ctx.createRadialGradient(x, y, 1, x, y, rad);
    g.addColorStop(0, "rgba(255,255,255,0.16)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}

type Kind = "flash" | "fire" | "smoke" | "dust";

type Particle = {
  kind: Kind;
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  grow: number;
  fade: number;
  drag: number;
};

// dust drives the impact puff; the other kinds are kept as a shared warm pool so
// past that the oldest particle of the same kind gets recycled early
const POOL: Record<Kind, number> = { flash: 8, fire: 8, smoke: 56, dust: 48 };

const scratch = new THREE.Vector3();

export class FX {
  #particles: Particle[] = [];
  #free: Record<Kind, Particle[]> = { flash: [], fire: [], smoke: [], dust: [] };
  #carLandingBursts = 0;

  constructor(scene: THREE.Scene) {
    const baseMats: Record<Kind, THREE.SpriteMaterial> = {
      flash: new THREE.SpriteMaterial({
        map: radialTexture("rgba(255,252,220,1)", "rgba(255,180,60,0)"),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true
      }),
      fire: new THREE.SpriteMaterial({
        map: radialTexture("rgba(255,170,60,0.95)", "rgba(180,40,10,0)"),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true
      }),
      smoke: new THREE.SpriteMaterial({
        map: puffTexture(),
        color: 0x5a5751,
        depthWrite: false,
        transparent: true,
        opacity: 0.8
      }),
      dust: new THREE.SpriteMaterial({
        map: puffTexture(),
        color: 0xa89f8d,
        depthWrite: false,
        transparent: true,
        opacity: 0.85
      })
    };
    // sprites are unlit: carry them into the photometric light scale so flashes still
    // read hot and dust holds its old contrast against the brighter-lit world
    for (const m of Object.values(baseMats)) m.color.multiplyScalar(LIGHT_SCALE);

    // fixed pool, built once: per-sprite material clones (opacity animates per
    // particle) so gameplay never creates or disposes materials — a fresh material
    // mid-run means a WebGPU pipeline compile hitch on the first puff.
    // Culling stays off: idle sprites are invisible anyway, and it keeps the boot
    // prewarm independent of where the camera points.
    for (const kind of Object.keys(POOL) as Kind[]) {
      for (let i = 0; i < POOL[kind]; i++) {
        const sprite = new THREE.Sprite(baseMats[kind].clone());
        sprite.visible = false;
        sprite.frustumCulled = false;
        scene.add(sprite);
        this.#free[kind].push({
          kind,
          sprite,
          vel: new THREE.Vector3(),
          life: 0,
          maxLife: 1,
          grow: 0,
          fade: 1,
          drag: 1
        });
      }
    }
  }

  /** Allocation-on-demand browser QA/diagnostics; the update path stays lean. */
  get debugState() {
    const byKind: Record<Kind, number> = { flash: 0, fire: 0, smoke: 0, dust: 0 };
    for (const particle of this.#particles) byKind[particle.kind] += 1;
    return { active: this.#particles.length, byKind, carLandingBursts: this.#carLandingBursts };
  }

  // spawn one zero-alpha particle of each kind during the boot warmup render so
  // both sprite pipeline variants (additive + normal blending) compile up front
  prewarm() {
    for (const kind of Object.keys(POOL) as Kind[]) {
      const p = this.#spawn(kind, scratch.set(0, -50, 0), 0.01, 0, 0, 0, 0.05, 0);
      p.fade = 0;
    }
  }

  #spawn(kind: Kind, pos: THREE.Vector3, scale: number, vx: number, vy: number, vz: number, life: number, grow: number, drag = 1): Particle {
    let p = this.#free[kind].pop();
    if (!p) {
      // pool dry: recycle the oldest live particle of this kind (front of the list)
      const i = this.#particles.findIndex((q) => q.kind === kind);
      p = this.#particles[i];
      this.#particles.splice(i, 1);
    }
    p.sprite.position.copy(pos);
    p.sprite.scale.setScalar(scale);
    p.sprite.visible = true;
    p.vel.set(vx, vy, vz);
    p.life = life;
    p.maxLife = life;
    p.grow = grow;
    p.fade = 1;
    p.drag = drag;
    (p.sprite.material as THREE.SpriteMaterial).opacity = 1;
    this.#particles.push(p);
    return p;
  }

  impactPuff(pos: THREE.Vector3) {
    this.#spawn("dust", pos, 1.6, 0, 1.8, 0, 0.7, 3.2, 0.94);
  }

  /**
   * Low road-hugging dust plus soft grey puffs spread across the car's width.
   * All sprites come from the boot-warmed shared pool, so a first fun jump never
   * creates a material or compiles a new WebGPU pipeline during play.
   */
  carLandingPuff(
    pos: THREE.Vector3,
    yaw: number,
    strength: number,
    count: number,
    scale: number,
    spread: number,
    life: number
  ) {
    const amount = THREE.MathUtils.clamp(strength, 0, 1);
    const puffs = THREE.MathUtils.clamp(Math.round(count), 0, POOL.smoke);
    if (amount <= 0 || puffs <= 0) return;
    this.#carLandingBursts += 1;

    const safeScale = Math.max(0.05, scale);
    const safeLife = Math.max(0.05, life);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);

    scratch.set(pos.x, pos.y + 0.04, pos.z);
    this.#spawn(
      "dust",
      scratch,
      safeScale * (0.7 + amount * 0.45),
      forwardX * 0.35,
      0.55 + amount * 0.65,
      forwardZ * 0.35,
      safeLife * 0.72,
      2.2 + amount * 2.4,
      0.92
    );

    for (let i = 0; i < puffs; i++) {
      const across = puffs === 1 ? 0 : (i / (puffs - 1) - 0.5) * spread;
      const sideJitter = (Math.random() - 0.5) * spread * 0.22;
      const foreJitter = (Math.random() - 0.5) * 0.85;
      const side = across + sideJitter;
      scratch.set(
        pos.x + rightX * side + forwardX * foreJitter,
        pos.y + 0.08 + Math.random() * 0.14,
        pos.z + rightZ * side + forwardZ * foreJitter
      );
      const outward = Math.sign(side || (i % 2 ? 1 : -1)) * (0.25 + amount * 0.65);
      this.#spawn(
        "smoke",
        scratch,
        safeScale * (0.58 + Math.random() * 0.38),
        rightX * outward + forwardX * (Math.random() - 0.5) * 0.45,
        0.65 + amount * 1.05 + Math.random() * 0.35,
        rightZ * outward + forwardZ * (Math.random() - 0.5) * 0.45,
        safeLife * (0.82 + Math.random() * 0.35),
        1.35 + amount * 1.85,
        0.965
      );
    }
  }

  update(dt: number) {
    for (let i = this.#particles.length - 1; i >= 0; i--) {
      const p = this.#particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        this.#free[p.kind].push(p);
        this.#particles.splice(i, 1);
        continue;
      }
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(p.drag);
      const t = p.life / p.maxLife;
      p.sprite.scale.addScalar(p.grow * dt);
      (p.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, t * 1.6) * p.fade;
    }
  }
}
