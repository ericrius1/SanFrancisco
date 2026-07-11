import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { tunables } from "../../core/persist";
import { applyMaterialPolicy, RenderBand, tagTransparency } from "../../render/transparency";

/**
 * A small, fixed firefly group for the trio. The visible insects stay around
 * the performers' silhouette while two shadowless local lights provide the
 * actual face/instrument fill. Keeping the light count fixed is important in
 * WebGPU: changing it at runtime invalidates every lit pipeline.
 */

export const BUSKER_FIREFLY_TUNING = tunables("busker.fireflies", {
  enabled: { v: true, label: "enabled" },
  brightness: { v: 1, min: 0, max: 2.5, step: 0.05, label: "light strength" },
  drift: { v: 1, min: 0, max: 2, step: 0.05, label: "flight speed" },
  pulse: { v: 0.05, min: 0, max: 0.15, step: 0.005, label: "gentle pulse" },
  glowSize: { v: 1, min: 0.5, max: 1.8, step: 0.05, label: "glow size" }
});

const TAU = Math.PI * 2;
const ACTIVE_RANGE = 90;
const LIGHT_INTENSITY = 13;
const LIGHT_DISTANCE = 4.2;
const TWILIGHT_START_ELEVATION = 7;
const TWILIGHT_FULL_ELEVATION = -2;

type FireflyLayout = {
  x: number;
  y: number;
  z: number;
  ax: number;
  ay: number;
  az: number;
  speed: number;
  phase: number;
  size: number;
};

// The trio faces -Z. Most paths sit above the heads or beyond the outer
// shoulders, leaving the central face/instrument sightline clear.
const LAYOUT: readonly FireflyLayout[] = [
  { x: -1.62, y: 2.18, z: -1.82, ax: 0.11, ay: 0.13, az: 0.08, speed: 0.18, phase: 0.08, size: 0.2 },
  { x: -1.86, y: 1.62, z: -1.57, ax: 0.09, ay: 0.1, az: 0.07, speed: 0.15, phase: 0.31, size: 0.16 },
  { x: -0.64, y: 2.62, z: -1.54, ax: 0.14, ay: 0.08, az: 0.06, speed: 0.13, phase: 0.52, size: 0.17 },
  { x: 0.18, y: 2.73, z: -1.46, ax: 0.1, ay: 0.07, az: 0.07, speed: 0.16, phase: 0.74, size: 0.15 },
  { x: 0.96, y: 2.58, z: -1.56, ax: 0.12, ay: 0.09, az: 0.06, speed: 0.14, phase: 0.91, size: 0.17 },
  { x: 1.58, y: 2.12, z: -1.84, ax: 0.1, ay: 0.12, az: 0.08, speed: 0.17, phase: 0.43, size: 0.2 },
  { x: 1.88, y: 1.54, z: -1.55, ax: 0.08, ay: 0.09, az: 0.06, speed: 0.12, phase: 0.65, size: 0.15 }
] as const;

function smooth01(edge0: number, edge1: number, value: number) {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function makeGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  gradient.addColorStop(0, "rgba(255,255,225,1)");
  gradient.addColorStop(0.1, "rgba(250,255,150,0.98)");
  gradient.addColorStop(0.3, "rgba(225,255,100,0.42)");
  gradient.addColorStop(1, "rgba(190,235,65,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class BuskerFireflies {
  readonly group = new THREE.Group();

  #texture = makeGlowTexture();
  #sprites: THREE.Sprite[] = [];
  #materials: THREE.SpriteMaterial[] = [];
  #lights: THREE.PointLight[] = [];
  #elapsed = 0;

  constructor() {
    this.group.name = "busker-fireflies";

    for (let i = 0; i < LAYOUT.length; i++) {
      const material = new THREE.SpriteMaterial({
        map: this.#texture,
        color: new THREE.Color(0xf0ff91).multiplyScalar(LIGHT_SCALE * 0.82),
        opacity: 0
      });
      applyMaterialPolicy(material, "additiveWorld");
      material.fog = false;

      const sprite = new THREE.Sprite(material);
      sprite.name = `busker-firefly-${i + 1}`;
      sprite.frustumCulled = false;
      tagTransparency(sprite, {
        profile: "additiveWorld",
        renderBand: RenderBand.WORLD_ADDITIVE_FRONT,
        ink: false
      });
      this.group.add(sprite);
      this.#sprites.push(sprite);
      this.#materials.push(material);
    }

    // Two warm, shadowless keys sit on the outer fireflies. They brighten the
    // three faces from the camera side without putting a glowing orb over one.
    for (const index of [0, 5]) {
      const light = new THREE.PointLight(0xffdf79, 0, LIGHT_DISTANCE, 2);
      light.name = `busker-firefly-fill-${this.#lights.length + 1}`;
      light.castShadow = false;
      light.position.set(LAYOUT[index].x, LAYOUT[index].y, LAYOUT[index].z);
      this.group.add(light);
      this.#lights.push(light);
    }
  }

  update(dt: number, cameraDistance: number, sunElevation: number) {
    this.#elapsed += Math.min(dt, 0.1);
    const enabled = BUSKER_FIREFLY_TUNING.values.enabled && cameraDistance < ACTIVE_RANGE;
    const twilight = enabled
      ? smooth01(TWILIGHT_START_ELEVATION, TWILIGHT_FULL_ELEVATION, sunElevation)
      : 0;
    const drift = BUSKER_FIREFLY_TUNING.values.drift;
    const pulseDepth = BUSKER_FIREFLY_TUNING.values.pulse;
    const sizeGain = BUSKER_FIREFLY_TUNING.values.glowSize;

    this.group.visible = twilight > 0.001;

    for (let i = 0; i < LAYOUT.length; i++) {
      const p = LAYOUT[i];
      const phase = p.phase * TAU;
      const t = this.#elapsed * p.speed * drift + phase;
      const sprite = this.#sprites[i];
      sprite.position.set(
        p.x + Math.sin(t) * p.ax,
        p.y + Math.sin(t * 0.73 + phase * 0.41) * p.ay,
        p.z + Math.sin(t * 0.47 + phase * 1.37) * p.az
      );

      // Slow, shallow breathing—never an on/off twinkle or high-frequency flicker.
      const pulse = 1 + Math.sin(this.#elapsed * 0.58 + phase) * pulseDepth;
      this.#materials[i].opacity = twilight * 0.72 * pulse;
      const size = p.size * sizeGain * (0.98 + 0.02 * pulse);
      sprite.scale.setScalar(size);
    }

    const lightGain = twilight * BUSKER_FIREFLY_TUNING.values.brightness;
    for (let i = 0; i < this.#lights.length; i++) {
      const sourceIndex = i === 0 ? 0 : 5;
      const phase = LAYOUT[sourceIndex].phase * TAU;
      this.#lights[i].position.copy(this.#sprites[sourceIndex].position);
      this.#lights[i].intensity =
        LIGHT_INTENSITY * lightGain * (1 + Math.sin(this.#elapsed * 0.51 + phase) * pulseDepth);
    }
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const material of this.#materials) material.dispose();
    this.#materials.length = 0;
    this.#sprites.length = 0;
    this.#lights.length = 0;
    this.#texture.dispose();
  }
}
