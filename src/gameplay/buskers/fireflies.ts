import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { tunables } from "../../core/persist";
import { applyMaterialPolicy, RenderBand, tagTransparency } from "../../render/transparency";

/**
 * A small firefly swarm for the trio. Visible insects drift in a gentle 3D
 * volume around the instruments; one shadowless local light provides the
 * face/instrument fill. Keeping the light count fixed is important in
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
const LIGHT_INTENSITY = 20;
const LIGHT_DISTANCE = 4.6;
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

// Homes sit in a volume around the instruments (not a flat arc). Trio faces
// -Z; seats are flute −X, handpan center, ukulele +X.
const LAYOUT: readonly FireflyLayout[] = [
  // flute
  { x: -1.12, y: 2.02, z: -1.42, ax: 0.34, ay: 0.28, az: 0.38, speed: 0.52, phase: 0.08, size: 0.18 },
  { x: -0.82, y: 1.68, z: -1.78, ax: 0.3, ay: 0.24, az: 0.32, speed: 0.44, phase: 0.31, size: 0.15 },
  // handpan
  { x: 0.08, y: 1.62, z: -1.52, ax: 0.36, ay: 0.26, az: 0.34, speed: 0.58, phase: 0.52, size: 0.16 },
  { x: -0.18, y: 1.92, z: -1.28, ax: 0.32, ay: 0.3, az: 0.4, speed: 0.4, phase: 0.74, size: 0.14 },
  // ukulele
  { x: 1.08, y: 1.74, z: -1.46, ax: 0.34, ay: 0.27, az: 0.36, speed: 0.5, phase: 0.91, size: 0.17 },
  { x: 0.78, y: 2.08, z: -1.82, ax: 0.28, ay: 0.25, az: 0.3, speed: 0.46, phase: 0.43, size: 0.19 },
  // free floater above the gap
  { x: 0.28, y: 2.32, z: -1.18, ax: 0.42, ay: 0.22, az: 0.44, speed: 0.38, phase: 0.65, size: 0.15 }
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
  #light: THREE.PointLight;
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

    // One warm, shadowless fill — tracks the swarm centroid so faces and
    // instruments stay lit without a second WebGPU point light.
    this.#light = new THREE.PointLight(0xffdf79, 0, LIGHT_DISTANCE, 2);
    this.#light.name = "busker-firefly-fill";
    this.#light.castShadow = false;
    this.#light.position.set(0, 1.9, -1.55);
    this.group.add(this.#light);
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

    let cx = 0;
    let cy = 0;
    let cz = 0;

    for (let i = 0; i < LAYOUT.length; i++) {
      const p = LAYOUT[i];
      const phase = p.phase * TAU;
      const t = this.#elapsed * p.speed * drift + phase;
      // Multi-frequency Lissajous so paths read as a loose 3D swarm, not a
      // shared planar arc. Secondary terms push depth and height independently.
      const sprite = this.#sprites[i];
      sprite.position.set(
        p.x + Math.sin(t) * p.ax + Math.sin(t * 2.17 + phase) * p.ax * 0.38,
        p.y + Math.sin(t * 0.73 + phase * 0.41) * p.ay + Math.cos(t * 1.41 + phase) * p.ay * 0.32,
        p.z + Math.cos(t * 0.91 + phase * 1.17) * p.az + Math.sin(t * 1.63 + phase * 0.7) * p.az * 0.42
      );
      cx += sprite.position.x;
      cy += sprite.position.y;
      cz += sprite.position.z;

      // Slow, shallow breathing—never an on/off twinkle or high-frequency flicker.
      const pulse = 1 + Math.sin(this.#elapsed * 0.58 + phase) * pulseDepth;
      this.#materials[i].opacity = twilight * 0.72 * pulse;
      const size = p.size * sizeGain * (0.98 + 0.02 * pulse);
      sprite.scale.setScalar(size);
    }

    const n = LAYOUT.length;
    const lightGain = twilight * BUSKER_FIREFLY_TUNING.values.brightness;
    this.#light.position.set(cx / n, cy / n, cz / n);
    this.#light.intensity =
      LIGHT_INTENSITY * lightGain * (1 + Math.sin(this.#elapsed * 0.51) * pulseDepth);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const material of this.#materials) material.dispose();
    this.#materials.length = 0;
    this.#sprites.length = 0;
    this.#texture.dispose();
  }
}
