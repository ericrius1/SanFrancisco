import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { REVERIE_CENTER, REVERIE_TUNING } from "./layout";

/**
 * Soft firefly field around the lagoon shore + peristyle. Population grows
 * with quest progress; one fixed PointLight for face/column fill (WebGPU
 * light-count stability).
 */

type Bug = {
  ox: number;
  oy: number;
  oz: number;
  ax: number;
  ay: number;
  az: number;
  speed: number;
  phase: number;
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
};

function makeBugTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 15);
  g.addColorStop(0, "rgba(255,255,220,1)");
  g.addColorStop(0.25, "rgba(255,230,120,0.85)");
  g.addColorStop(1, "rgba(120,200,80,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class ReverieFireflies {
  readonly group = new THREE.Group();
  #bugs: Bug[] = [];
  #light: THREE.PointLight;
  #tex: THREE.CanvasTexture;
  #progress = 0;
  #active = 0;

  constructor() {
    this.group.name = "palace-reverie-fireflies";
    this.#tex = makeBugTexture();
    this.#light = new THREE.PointLight(0xffe8a0, 0, 18, 2);
    this.#light.position.set(REVERIE_CENTER.x, 6, REVERIE_CENTER.z);
    this.#light.castShadow = false;
    this.group.add(this.#light);

    const cap = REVERIE_TUNING.fireflyBase + REVERIE_TUNING.fireflyPerLamp * 5;
    for (let i = 0; i < cap; i++) {
      const a = (i / cap) * Math.PI * 2;
      const r = 18 + (i % 9) * 7;
      const mat = new THREE.SpriteMaterial({
        map: this.#tex,
        color: new THREE.Color().setHSL(0.12 + (i % 5) * 0.08, 0.7, 0.65),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0
      });
      const sprite = new THREE.Sprite(mat);
      const size = 0.22 + (i % 4) * 0.05;
      sprite.scale.set(size, size, 1);
      this.group.add(sprite);
      this.#bugs.push({
        ox: REVERIE_CENTER.x + Math.cos(a) * r,
        oy: 2.2 + (i % 6) * 0.55,
        oz: REVERIE_CENTER.z + Math.sin(a) * r * 0.85,
        ax: 1.2 + (i % 4) * 0.4,
        ay: 0.5 + (i % 3) * 0.25,
        az: 1.1 + (i % 5) * 0.35,
        speed: 0.35 + (i % 6) * 0.08,
        phase: i * 0.61,
        sprite,
        mat
      });
    }
  }

  setProgress(p: number) {
    this.#progress = THREE.MathUtils.clamp(p, 0, 1);
    this.#active = Math.floor(
      REVERIE_TUNING.fireflyBase + this.#progress * REVERIE_TUNING.fireflyPerLamp * 5
    );
  }

  update(_dt: number, timeSec: number) {
    for (let i = 0; i < this.#bugs.length; i++) {
      const b = this.#bugs[i];
      const on = i < this.#active;
      const target = on ? 0.85 + 0.15 * Math.sin(timeSec * 3.2 + b.phase) : 0;
      b.mat.opacity += (target - b.mat.opacity) * 0.08;
      if (b.mat.opacity < 0.01) {
        b.sprite.visible = false;
        continue;
      }
      b.sprite.visible = true;
      const lift = this.#progress * 1.8;
      // Warm gold early → cool cyan as the gallery wakes.
      b.mat.color.setHSL(0.12 + this.#progress * 0.45 + (i % 5) * 0.03, 0.68, 0.7);
      // Gently gather toward the lagoon center as progress rises.
      const gather = this.#progress * 0.35;
      const px =
        b.ox * (1 - gather) +
        REVERIE_CENTER.x * gather +
        Math.sin(timeSec * b.speed + b.phase) * b.ax * (1 + this.#progress * 0.4);
      const pz =
        b.oz * (1 - gather) +
        REVERIE_CENTER.z * gather +
        Math.cos(timeSec * b.speed * 0.9 + b.phase) * b.az * (1 + this.#progress * 0.4);
      b.sprite.position.set(
        px,
        b.oy + lift + Math.sin(timeSec * b.speed * 1.3 + b.phase * 1.7) * b.ay,
        pz
      );
      const size = 0.2 + (i % 4) * 0.05 + this.#progress * 0.08;
      b.sprite.scale.set(size, size, 1);
    }
    this.#light.intensity = (0.55 + this.#progress * 3.8) * LIGHT_SCALE * 0.35;
    this.#light.color.setHSL(0.12 + this.#progress * 0.42, 0.55, 0.72);
    this.#light.position.set(
      REVERIE_CENTER.x + Math.sin(timeSec * 0.25) * 6,
      4.5 + this.#progress * 4,
      REVERIE_CENTER.z + Math.cos(timeSec * 0.25) * 6
    );
  }

  dispose() {
    this.#tex.dispose();
    for (const b of this.#bugs) b.mat.dispose();
  }
}
