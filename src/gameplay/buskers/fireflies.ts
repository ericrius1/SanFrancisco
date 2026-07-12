import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { applyMaterialPolicy, RenderBand, tagTransparency } from "../../render/transparency";
import { BUSKER_FIREFLY_TUNING } from "./tuning";

/**
 * A small firefly swarm for the trio. Visible insects drift in a gentle 3D
 * volume around the instruments; one shadowless local light provides the
 * face/instrument fill. Keeping the light count fixed is important in
 * WebGPU: changing it at runtime invalidates every lit pipeline.
 */

export { BUSKER_FIREFLY_TUNING } from "./tuning";

const TAU = Math.PI * 2;
const ACTIVE_RANGE = 90;
const LIGHT_INTENSITY = 7;
// Reach a little past the rock so hillside facades behind the trio still catch
// a soft wash — faces stay the key, but the night city reads further back.
const LIGHT_DISTANCE = 7.4;
// Key sits in front of the trio (camera side), slightly camera-left and above
// the swarm — soft face fill without sitting inside the insects.
const LIGHT_OFFSET = { x: 0.65, y: 0.4, z: -1.35 };
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

// Homes sit in a looser volume around the instruments (not a tight cluster).
// Trio faces -Z; seats are flute −X, handpan center, ukulele +X.
const LAYOUT: readonly FireflyLayout[] = [
  // flute
  { x: -1.55, y: 2.18, z: -1.15, ax: 0.48, ay: 0.34, az: 0.52, speed: 0.52, phase: 0.08, size: 0.12 },
  { x: -1.05, y: 1.52, z: -2.15, ax: 0.42, ay: 0.3, az: 0.44, speed: 0.44, phase: 0.31, size: 0.1 },
  // handpan
  { x: 0.22, y: 1.48, z: -1.85, ax: 0.5, ay: 0.32, az: 0.48, speed: 0.58, phase: 0.52, size: 0.11 },
  { x: -0.35, y: 2.05, z: -0.95, ax: 0.44, ay: 0.36, az: 0.55, speed: 0.4, phase: 0.74, size: 0.095 },
  // ukulele
  { x: 1.48, y: 1.68, z: -1.25, ax: 0.46, ay: 0.33, az: 0.5, speed: 0.5, phase: 0.91, size: 0.115 },
  { x: 1.12, y: 2.28, z: -2.2, ax: 0.4, ay: 0.3, az: 0.42, speed: 0.46, phase: 0.43, size: 0.125 },
  // free floater above the gap
  { x: 0.05, y: 2.55, z: -0.72, ax: 0.58, ay: 0.28, az: 0.6, speed: 0.38, phase: 0.65, size: 0.1 }
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
  gradient.addColorStop(0, "rgba(255,255,230,1)");
  gradient.addColorStop(0.1, "rgba(255,245,120,0.98)");
  gradient.addColorStop(0.28, "rgba(210,255,80,0.45)");
  gradient.addColorStop(1, "rgba(160,220,40,0)");
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
        color: new THREE.Color(0xf2ff7a).multiplyScalar(LIGHT_SCALE * 0.78),
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

    // One warm, shadowless fill — follows the swarm with a fixed key offset
    // so it stays in front of the faces rather than inside the insects.
    this.#light = new THREE.PointLight(0xe8f06a, 0, LIGHT_DISTANCE, 2);
    this.#light.name = "busker-firefly-fill";
    this.#light.castShadow = false;
    this.#light.position.set(LIGHT_OFFSET.x, 1.9 + LIGHT_OFFSET.y, -1.55 + LIGHT_OFFSET.z);
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
    if (!this.group.visible) {
      // daylight / out of range: nothing renders, skip the swarm math
      if (this.#light.intensity !== 0) this.#light.intensity = 0;
      return;
    }

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

      // Soft firefly flicker — deeper and a touch faster than a slow breath.
      const pulse =
        1 +
        Math.sin(this.#elapsed * 1.85 + phase) * pulseDepth +
        Math.sin(this.#elapsed * 4.2 + phase * 1.7) * pulseDepth * 0.35;
      this.#materials[i].opacity = twilight * 0.72 * pulse;
      const size = p.size * sizeGain * (0.96 + 0.04 * pulse);
      sprite.scale.setScalar(size);
    }

    const n = LAYOUT.length;
    const lightGain = twilight * BUSKER_FIREFLY_TUNING.values.brightness;
    this.#light.position.set(
      cx / n + LIGHT_OFFSET.x,
      cy / n + LIGHT_OFFSET.y,
      cz / n + LIGHT_OFFSET.z
    );
    // Shared fill flickers with the swarm — wider range, firefly-like tempo.
    const lightFlicker =
      1 +
      Math.sin(this.#elapsed * 1.7) * pulseDepth * 1.35 +
      Math.sin(this.#elapsed * 3.9 + 0.8) * pulseDepth * 0.55;
    this.#light.intensity = LIGHT_INTENSITY * lightGain * lightFlicker;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const material of this.#materials) material.dispose();
    this.#materials.length = 0;
    this.#sprites.length = 0;
    this.#texture.dispose();
  }
}
