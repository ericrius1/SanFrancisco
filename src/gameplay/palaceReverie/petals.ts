import * as THREE from "three/webgpu";
import { PALACE_LAGOON } from "../../world/heightmap";
import { REVERIE_ROTUNDA } from "./layout";

/** Soft petal / mote fall that appears as the quest completes. */
export class CompletionPetals {
  readonly group = new THREE.Group();
  #sprites: THREE.Sprite[] = [];
  #mats: THREE.SpriteMaterial[] = [];
  #phase: number[] = [];
  #intensity = 0;
  #target = 0;
  #tex: THREE.CanvasTexture;

  constructor() {
    this.group.name = "palace-reverie-petals";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.beginPath();
    ctx.ellipse(16, 16, 10, 6, 0.4, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 12);
    g.addColorStop(0, "rgba(255,220,230,1)");
    g.addColorStop(0.6, "rgba(255,180,200,0.7)");
    g.addColorStop(1, "rgba(200,140,180,0)");
    ctx.fillStyle = g;
    ctx.fill();
    this.#tex = new THREE.CanvasTexture(canvas);
    this.#tex.colorSpace = THREE.SRGBColorSpace;

    for (let i = 0; i < 72; i++) {
      const hue =
        i % 4 === 0 ? 0.12 + (i % 3) * 0.02 : i % 3 === 0 ? 0.55 + (i % 4) * 0.02 : 0.92 + (i % 5) * 0.02;
      const mat = new THREE.SpriteMaterial({
        map: this.#tex,
        color: new THREE.Color().setHSL(hue, 0.48, 0.76),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        rotation: Math.random() * Math.PI
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(0.45, 0.45, 1);
      sprite.visible = false;
      this.group.add(sprite);
      this.#sprites.push(sprite);
      this.#mats.push(mat);
      this.#phase.push(i * 0.31);
    }
  }

  setComplete(on: boolean) {
    this.#target = on ? 1 : 0;
  }

  snap(intensity: number) {
    this.#intensity = this.#target = THREE.MathUtils.clamp(intensity, 0, 1);
  }

  update(dt: number, timeSec: number) {
    this.#intensity += (this.#target - this.#intensity) * Math.min(1, dt * 1.2);
    const i = this.#intensity;
    for (let k = 0; k < this.#sprites.length; k++) {
      const sprite = this.#sprites[k];
      const mat = this.#mats[k];
      if (i < 0.02) {
        sprite.visible = false;
        mat.opacity = 0;
        continue;
      }
      sprite.visible = true;
      const p = this.#phase[k];
      const orbit = timeSec * 0.22 + p;
      const radius = 16 + (k % 9) * 3.8;
      const fall = (timeSec * 0.68 + p * 3) % 26;
      const wind = Math.sin(timeSec * 0.35 + p) * 3.5;
      sprite.position.set(
        REVERIE_ROTUNDA.x + Math.cos(orbit) * radius + wind,
        PALACE_LAGOON.surfaceY + 32 - fall,
        REVERIE_ROTUNDA.z + Math.sin(orbit * 0.9) * radius * 0.85
      );
      mat.opacity = i * (0.55 + 0.35 * Math.sin(timeSec * 1.8 + p));
      mat.rotation = timeSec * 0.5 + p;
      const s = 0.38 + (k % 5) * 0.11;
      sprite.scale.set(s, s * 0.72, 1);
    }
  }

  dispose() {
    this.#tex.dispose();
    for (const m of this.#mats) m.dispose();
  }
}
