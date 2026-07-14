import * as THREE from "three/webgpu";
import { PALACE_LAGOON } from "../../world/heightmap";
import {
  createSurfaceSoftSpriteMaterial,
  horizontalSurfacePlane,
  SURFACE_SOFT_SPRITE
} from "./surfaceSoftSprite";

/** Soft ground mist over the lagoon basin — cheap sprites that thicken with
 *  quest progress so the blue-hour read gets dreamier as lamps wake. */
export class LagoonMist {
  readonly group = new THREE.Group();
  #sprites: THREE.Sprite[] = [];
  #mats: THREE.SpriteNodeMaterial[] = [];
  #progress = 0;
  #tex: THREE.CanvasTexture;

  constructor() {
    this.group.name = "palace-reverie-mist";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(220,230,255,0.55)");
    g.addColorStop(0.45, "rgba(180,190,220,0.22)");
    g.addColorStop(1, "rgba(140,150,180,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    this.#tex = new THREE.CanvasTexture(canvas);
    this.#tex.colorSpace = THREE.SRGBColorSpace;

    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      const r = 0.2 + (i % 7) * 0.1;
      const mat = createSurfaceSoftSpriteMaterial({
        map: this.#tex,
        opacity: 0.18,
        color: new THREE.Color(0xd8e4ff),
        surfacePlane: horizontalSurfacePlane(PALACE_LAGOON.surfaceY),
        feather: 0.9
      }).material;
      const sprite = new THREE.Sprite(mat);
      const s = 24 + (i % 5) * 7;
      sprite.scale.set(s, s * 0.35, 1);
      const layer = i % 3;
      sprite.position.set(
        PALACE_LAGOON.x + Math.cos(a) * PALACE_LAGOON.radiusX * r,
        PALACE_LAGOON.surfaceY + 0.9 + layer * 1.1 + (i % 4) * 0.2,
        PALACE_LAGOON.z + Math.sin(a) * PALACE_LAGOON.radiusZ * r
      );
      sprite.renderOrder = SURFACE_SOFT_SPRITE.renderOrder;
      this.group.add(sprite);
      this.#sprites.push(sprite);
      this.#mats.push(mat);
    }
  }

  setProgress(p: number) {
    this.#progress = THREE.MathUtils.clamp(p, 0, 1);
  }

  update(_dt: number, timeSec: number) {
    for (let i = 0; i < this.#sprites.length; i++) {
      const sprite = this.#sprites[i];
      const mat = this.#mats[i];
      const drift = Math.sin(timeSec * 0.15 + i) * 2.5;
      sprite.position.x += Math.cos(timeSec * 0.08 + i) * 0.01;
      sprite.position.z += Math.sin(timeSec * 0.1 + i * 0.7) * 0.01;
      mat.opacity = 0.15 + this.#progress * 0.48 + Math.sin(timeSec * 0.4 + i) * 0.05;
      // Cool dawn mist → lavender/rose as memory lamps wake.
      mat.color.setHSL(0.62 - this.#progress * 0.12, 0.26 + this.#progress * 0.28, 0.8 + this.#progress * 0.04);
      const base = 30 + (i % 5) * 8;
      sprite.scale.set(base + drift, (base + drift) * (0.28 + (i % 3) * 0.04), 1);
    }
  }

  dispose() {
    this.#tex.dispose();
    for (const m of this.#mats) m.dispose();
  }
}
