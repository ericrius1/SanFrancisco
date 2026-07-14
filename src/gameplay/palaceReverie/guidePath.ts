import * as THREE from "three/webgpu";
import type { WorldMap } from "../../world/heightmap";
import { LAMP_LAYOUT, NPC_LAYOUT, REVERIE_SPAWN } from "./layout";
import {
  createSurfaceSoftSpriteMaterial,
  SURFACE_SOFT_SPRITE,
  terrainSurfacePlane
} from "./surfaceSoftSprite";

/**
 * Soft stepping-stone glows from the shore greeting to the first memory lamp —
 * a quiet invitation so first-time visitors know which way the quest begins.
 */
export class GuidePath {
  readonly group = new THREE.Group();
  #sprites: THREE.Sprite[] = [];
  #mats: THREE.SpriteNodeMaterial[] = [];
  #progress = 0;
  #tex: THREE.CanvasTexture;

  constructor(map: WorldMap) {
    this.group.name = "palace-reverie-guide";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, "rgba(255,240,200,1)");
    g.addColorStop(0.35, "rgba(200,220,255,0.55)");
    g.addColorStop(1, "rgba(120,140,200,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.#tex = new THREE.CanvasTexture(canvas);
    this.#tex.colorSpace = THREE.SRGBColorSpace;

    const inez = NPC_LAYOUT[0];
    const first = LAMP_LAYOUT[0];
    const start = { x: inez.x, z: inez.z };
    const mid = { x: REVERIE_SPAWN.x - 20, z: REVERIE_SPAWN.z - 30 };
    const end = { x: first.x, z: first.z };

    const points = 12;
    for (let i = 0; i < points; i++) {
      const u = (i + 1) / (points + 1);
      // quadratic bezier shore → mid → first lamp
      const omu = 1 - u;
      const x = omu * omu * start.x + 2 * omu * u * mid.x + u * u * end.x;
      const z = omu * omu * start.z + 2 * omu * u * mid.z + u * u * end.z;
      const y = map.groundTop(x, z) + 0.12;
      const mat = createSurfaceSoftSpriteMaterial({
        map: this.#tex,
        blending: THREE.AdditiveBlending,
        opacity: 0.35,
        surfacePlane: terrainSurfacePlane(map, x, z),
        feather: 0.18
      }).material;
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(x, y, z);
      sprite.scale.set(1.4, 1.4, 1);
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
    // Fade the guide away as lamps wake — path has done its job.
    const fade = Math.max(0, 1 - this.#progress * 1.4);
    const chase = (timeSec * 1.35) % this.#sprites.length;
    for (let i = 0; i < this.#sprites.length; i++) {
      const wave = Math.max(0, 1 - Math.abs(i - chase));
      const pulse = 0.22 + 0.18 * Math.sin(timeSec * 2.2 + i * 0.7) + wave * 0.55;
      this.#mats[i].opacity = fade * Math.min(1, pulse);
      const s = 1.05 + pulse * 0.65 + wave * 0.35;
      this.#sprites[i].scale.set(s, s, 1);
      this.#sprites[i].visible = fade > 0.04;
    }
  }

  dispose() {
    this.#tex.dispose();
    for (const m of this.#mats) m.dispose();
  }
}
