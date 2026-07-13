import * as THREE from "three/webgpu";
import { waterHeight, type WorldMap } from "../world/heightmap";
import type { Player } from "../player/player";
import type { WakeRipples } from "./wake";
import { LIGHT_SCALE } from "../config";

/**
 * Water-entry splashes for the airborne embodiments (bird, plane, drone).
 * Detection lives here so the controllers stay ignorant of FX: we watch the
 * player's altitude against the swell and fire on a downward surface crossing
 * (or a hard, fast pass just above it — the drone's floor stops 0.6 m short of
 * the water, so it never truly crosses). A splash is three layers: staggered
 * foam rings on the surface (WakeRipples.burst), a white water column with a
 * droplet crown that falls back under gravity, and a slow mist puff. Racing
 * along the surface sheds a lighter skim-spray by distance travelled.
 */

const SPLASH_MODES = new Set(["bird", "plane", "drone", "board", "surf"]);

type Drop = {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  grow: number;
  drag: number;
  grav: number;
};

function sprayTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 36;
    const x = 64 + Math.cos(a) * r;
    const y = 64 + Math.sin(a) * r;
    const rad = 10 + Math.random() * 18;
    const g = ctx.createRadialGradient(x, y, 1, x, y, rad);
    g.addColorStop(0, "rgba(255,255,255,0.22)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}

function dropletTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, "rgba(235,250,252,1)");
  g.addColorStop(0.5, "rgba(190,232,238,0.55)");
  g.addColorStop(1, "rgba(160,220,230,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class WaterSplashes {
  #scene: THREE.Scene;
  #wake: WakeRipples;
  #map: WorldMap;
  #drops: Drop[] = [];
  #sprayMat: THREE.SpriteMaterial;
  #dropMat: THREE.SpriteMaterial;

  #prevY = Infinity;
  #cooldown = 0;
  #skimAcc = 0; // metres travelled since the last skim puff
  #skimCount = 0;

  constructor(scene: THREE.Scene, wake: WakeRipples, map: WorldMap) {
    this.#scene = scene;
    this.#wake = wake;
    this.#map = map;
    this.#sprayMat = new THREE.SpriteMaterial({
      map: sprayTexture(),
      color: new THREE.Color(0xeef7f5).multiplyScalar(LIGHT_SCALE),
      depthWrite: false,
      transparent: true,
      opacity: 0.9
    });
    this.#dropMat = new THREE.SpriteMaterial({
      map: dropletTexture(),
      color: new THREE.Color(0xbfe9df).multiplyScalar(LIGHT_SCALE * 0.4),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true
    });
  }

  #spawn(mat: THREE.SpriteMaterial, pos: THREE.Vector3, scale: number, vel: THREE.Vector3, life: number, grow: number, drag: number, grav: number) {
    const sprite = new THREE.Sprite(mat.clone());
    sprite.position.copy(pos);
    sprite.scale.setScalar(scale);
    this.#scene.add(sprite);
    this.#drops.push({ sprite, vel, life, maxLife: life, grow, drag, grav });
  }

  /** The full three-layer hit. `energy` ≈ 0.3 gentle graze … 1.6 full stoop. */
  splash(x: number, y: number, z: number, elapsed: number, energy: number) {
    const e = THREE.MathUtils.clamp(energy, 0.3, 1.6);
    const p = new THREE.Vector3(x, y + 0.15, z);

    this.#wake.burst(x, z, elapsed, 6 + e * 13);

    // white column straight up from the entry point
    for (let i = 0; i < 3; i++) {
      this.#spawn(
        this.#sprayMat,
        p,
        0.9 + e * 1.3 + i * 0.4,
        new THREE.Vector3((Math.random() - 0.5) * 2, (9 + e * 9) * (1 - i * 0.22), (Math.random() - 0.5) * 2),
        0.65 + e * 0.25,
        4.5 + e * 3,
        0.86,
        20
      );
    }
    // droplet crown arcing out and falling back
    const n = Math.round(7 + e * 6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const r = 4 + Math.random() * 3.5 + e * 3;
      this.#spawn(
        this.#dropMat,
        p,
        0.5 + Math.random() * 0.5 + e * 0.3,
        new THREE.Vector3(Math.cos(a) * r, 5.5 + Math.random() * 3.5 + e * 4, Math.sin(a) * r),
        0.8 + Math.random() * 0.4,
        0.8,
        0.985,
        24
      );
    }
    // lingering mist
    this.#spawn(
      this.#sprayMat,
      p,
      2.2 + e * 2.2,
      new THREE.Vector3(0, 1.6, 0),
      1.5 + e * 0.5,
      6 + e * 4,
      0.92,
      1.5
    );
  }

  /** Lighter, faster spray for high-speed surface skims. */
  #skimSpray(x: number, y: number, z: number, speed: number) {
    const p = new THREE.Vector3(x, y + 0.1, z);
    this.#spawn(
      this.#sprayMat,
      p,
      0.7 + speed * 0.012,
      new THREE.Vector3((Math.random() - 0.5) * 3, 3 + Math.random() * 2, (Math.random() - 0.5) * 3),
      0.5,
      3.5,
      0.9,
      14
    );
  }

  update(dt: number, elapsed: number, player: Player) {
    // particles first so a splash spawned below still gets its first full frame
    for (let i = this.#drops.length - 1; i >= 0; i--) {
      const d = this.#drops[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.#scene.remove(d.sprite);
        (d.sprite.material as THREE.SpriteMaterial).dispose();
        this.#drops.splice(i, 1);
        continue;
      }
      d.vel.y -= d.grav * dt;
      d.sprite.position.addScaledVector(d.vel, dt);
      d.vel.multiplyScalar(d.drag);
      d.sprite.scale.addScalar(d.grow * dt);
      const t = d.life / d.maxLife;
      (d.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, t * 1.8) * 0.9;
    }

    this.#cooldown -= dt;
    const p = player.renderPosition;
    if (!SPLASH_MODES.has(player.mode) || !this.#map.isWater(p.x, p.z)) {
      this.#prevY = p.y;
      return;
    }

    const h = waterHeight(p.x, p.z, elapsed);
    const vy = player.velocity.y;
    const hSpeed = Math.hypot(player.velocity.x, player.velocity.z);

    // downward surface crossing, or a hard fast pass just above it (the
    // drone's floor clamps 0.6 m short of the swell, so it never crosses;
    // the board hover-springs to ~1.05 m with a ±0.08 bob, so its band sits
    // well above the wobble and only an ollie landing dips through it)
    const off =
      player.mode === "drone"
        ? 0.75
        : player.mode === "board"
          ? 1.5
          : player.mode === "surf"
            ? 0.58
            : 0.3;
    const crossed = this.#prevY > h + off && p.y <= h + off && vy < 1;
    const slammed = vy < -7 && p.y < h + 1.2;
    // SurfController emits launch/landing impulses explicitly; keep this generic
    // crossing detector for the other embodiments so surf does not double-burst.
    if (player.mode !== "surf" && (crossed || slammed) && this.#cooldown <= 0) {
      this.#cooldown = 0.9;
      const energy = 0.25 + hSpeed / 70 + Math.abs(Math.min(vy, 0)) / 26;
      this.splash(p.x, h, p.z, elapsed, energy);
    }

    // skim: racing along just over the swell sheds spray by distance travelled,
    // with a small wake ring every few puffs (not for the board — its wake is
    // the twin rail streams, and sprite puffs on top just read as clutter)
    if (player.mode !== "board" && p.y < h + 1.0 && hSpeed > (player.mode === "surf" ? 8 : 15)) {
      this.#skimAcc += hSpeed * dt;
      const spacing = player.mode === "surf" ? 2.4 : 4;
      if (this.#skimAcc >= spacing) {
        this.#skimAcc -= spacing;
        this.#skimSpray(p.x, h, p.z, hSpeed);
        if (++this.#skimCount % 3 === 0) this.#wake.burst(p.x, p.z, elapsed, 3.4, 1);
      }
    } else {
      this.#skimAcc = 0;
    }

    this.#prevY = p.y;
  }
}
