import * as THREE from "three/webgpu";

function softDiscTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Ghost ship steam requires a 2D canvas context");
  const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
  gradient.addColorStop(0, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.4, "rgba(225,242,255,0.58)");
  gradient.addColorStop(1, "rgba(190,220,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = "ghost_ship_steam_soft_disc";
  return texture;
}

export type GhostShipSteam = {
  group: THREE.Group;
  update(dt: number, time: number, amount: number, active: boolean): void;
  readonly visible: number;
  dispose(): void;
};

const STEAM_COUNT = 58;

/** Camera-facing hot-tub vapour, local to the moving ship root. */
export function createGhostShipSteam(): GhostShipSteam {
  const positions = new Float32Array(STEAM_COUNT * 3);
  const colors = new Float32Array(STEAM_COUNT * 3);
  const age = new Float32Array(STEAM_COUNT);
  const speed = new Float32Array(STEAM_COUNT);
  const radius = new Float32Array(STEAM_COUNT);
  for (let i = 0; i < STEAM_COUNT; i++) {
    age[i] = (i / STEAM_COUNT) * 5.6;
    speed[i] = 0.55 + ((i * 37) % 19) / 18 * 0.8;
    radius[i] = ((i * 53) % 101) / 100;
    colors[i * 3] = 0.72;
    colors[i * 3 + 1] = 0.88;
    colors[i * 3 + 2] = 1;
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const texture = softDiscTexture();
  const material = new THREE.PointsMaterial({
    size: 1.55,
    map: texture,
    alphaMap: texture,
    vertexColors: true,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true
  });
  const points = new THREE.Points(geometry, material);
  points.name = "ghost_ship_hot_tub_steam";
  points.frustumCulled = false;
  points.renderOrder = 12;
  const group = new THREE.Group();
  group.name = "ghost_ship_steam";
  group.add(points);

  let visible = 0;
  return {
    group,
    update(dt, time, amount, active) {
      const safeDt = Math.max(0, Math.min(dt, 0.1));
      visible = active && amount > 0.002 ? STEAM_COUNT : 0;
      group.visible = visible > 0;
      if (!group.visible) return;
      material.opacity = Math.min(0.62, amount * 0.52);
      for (let i = 0; i < STEAM_COUNT; i++) {
        age[i] = (age[i] + safeDt * speed[i]) % 5.6;
        const phase = age[i] / 5.6;
        const angle = i * 2.399963 + time * (0.08 + radius[i] * 0.05);
        const spread = 0.35 + phase * (1.1 + radius[i] * 1.2);
        const offset = i * 3;
        positions[offset] = Math.cos(angle) * spread;
        positions[offset + 1] = 0.2 + phase * (3.8 + radius[i] * 2.3);
        positions[offset + 2] = Math.sin(angle) * spread * 0.65;
      }
      positionAttribute.needsUpdate = true;
    },
    get visible() {
      return visible;
    },
    dispose() {
      group.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture.dispose();
    }
  };
}

type FallingStar = {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  hue: number;
};

const STAR_COUNT = 104;

export class RainbowStarShower {
  readonly lines: THREE.LineSegments;
  visible = 0;

  #scene: THREE.Scene;
  #geometry: THREE.BufferGeometry;
  #material: THREE.LineBasicMaterial;
  #positions = new Float32Array(STAR_COUNT * 2 * 3);
  #colors = new Float32Array(STAR_COUNT * 2 * 3);
  #positionAttribute: THREE.BufferAttribute;
  #colorAttribute: THREE.BufferAttribute;
  #stars: FallingStar[] = [];
  #cursor = 0;
  #spawnAccumulator = 0;
  #randomState = 0x51f15e1d;
  #color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
    this.#geometry = new THREE.BufferGeometry();
    this.#positionAttribute = new THREE.BufferAttribute(this.#positions, 3);
    this.#colorAttribute = new THREE.BufferAttribute(this.#colors, 3);
    this.#geometry.setAttribute("position", this.#positionAttribute);
    this.#geometry.setAttribute("color", this.#colorAttribute);
    this.#material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });
    this.lines = new THREE.LineSegments(this.#geometry, this.#material);
    this.lines.name = "ghost_ship_rainbow_shooting_stars";
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 15;
    scene.add(this.lines);
    for (let i = 0; i < STAR_COUNT; i++) {
      this.#stars.push({ active: false, x: 0, y: -1e5, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, hue: 0 });
    }
  }

  #random(): number {
    let x = this.#randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#randomState = x >>> 0;
    return this.#randomState / 0xffffffff;
  }

  #spawn(origin: THREE.Vector3): void {
    const star = this.#stars[this.#cursor++ % STAR_COUNT];
    const angle = this.#random() * Math.PI * 2;
    const radial = Math.sqrt(this.#random()) * 470;
    star.active = true;
    star.x = origin.x + Math.cos(angle) * radial;
    star.y = origin.y + 20 + this.#random() * 150;
    star.z = origin.z + Math.sin(angle) * radial;
    star.vx = -12 + this.#random() * 24;
    star.vy = -72 - this.#random() * 58;
    star.vz = -12 + this.#random() * 24;
    star.maxLife = 2.7 + this.#random() * 2.3;
    star.life = star.maxLife;
    star.hue = this.#random();
  }

  update(dt: number, active: boolean, amount: number, origin: THREE.Vector3): void {
    const safeDt = Math.max(0, Math.min(dt, 0.1));
    if (active && amount > 0.002) {
      this.#spawnAccumulator += safeDt * (5 + amount * 5);
      while (this.#spawnAccumulator >= 1) {
        this.#spawn(origin);
        this.#spawnAccumulator -= 1;
      }
    } else {
      this.#spawnAccumulator = 0;
    }

    this.visible = 0;
    for (let i = 0; i < STAR_COUNT; i++) {
      const star = this.#stars[i];
      const offset = i * 6;
      if (star.active) {
        star.life -= safeDt;
        if (star.life <= 0) star.active = false;
      }
      if (!star.active) {
        for (let j = 0; j < 6; j++) this.#positions[offset + j] = -1e5;
        continue;
      }

      star.x += star.vx * safeDt;
      star.y += star.vy * safeDt;
      star.z += star.vz * safeDt;
      const tailSeconds = 0.13 + (star.life / star.maxLife) * 0.08;
      this.#positions[offset] = star.x;
      this.#positions[offset + 1] = star.y;
      this.#positions[offset + 2] = star.z;
      this.#positions[offset + 3] = star.x - star.vx * tailSeconds;
      this.#positions[offset + 4] = star.y - star.vy * tailSeconds;
      this.#positions[offset + 5] = star.z - star.vz * tailSeconds;
      this.#color.setHSL(star.hue, 0.96, 0.66).multiplyScalar(2.8);
      for (let vertex = 0; vertex < 2; vertex++) {
        const colorOffset = offset + vertex * 3;
        this.#colors[colorOffset] = this.#color.r;
        this.#colors[colorOffset + 1] = this.#color.g;
        this.#colors[colorOffset + 2] = this.#color.b;
      }
      this.visible++;
    }
    this.lines.visible = this.visible > 0;
    this.#positionAttribute.needsUpdate = true;
    this.#colorAttribute.needsUpdate = true;
  }

  dispose(): void {
    this.lines.removeFromParent();
    this.#geometry.dispose();
    this.#material.dispose();
    this.#stars.length = 0;
    void this.#scene;
  }
}
