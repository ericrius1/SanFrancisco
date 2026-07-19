import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../../world/heightmap";
import { LAMP_LAYOUT, REVERIE_TUNING } from "./layout";
import {
  createSurfaceSoftSpriteMaterial,
  horizontalSurfacePlane,
  SURFACE_SOFT_SPRITE,
  terrainSurfacePlane
} from "./surfaceSoftSprite";

/**
 * Five memory lamps along the peristyle. Dim until awakened with E; each
 * lights a warm upwash on the nearby column and contributes to quest progress.
 */

export type MemoryLamp = {
  x: number;
  z: number;
  y: number;
  hue: number;
  whisper: string;
  lit: boolean;
  awakenT: number;
  root: THREE.Group;
  flameMat: THREE.MeshStandardNodeMaterial;
  haloMat: THREE.SpriteNodeMaterial;
  surfacePlane: THREE.Vector4;
  light: THREE.PointLight;
  sparkBurst: number; // 1 → 0 after lighting
};

type Spark = {
  sprite: THREE.Sprite;
  mat: THREE.SpriteNodeMaterial;
  surfacePlane: THREE.Vector4;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
};

function makeGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  g.addColorStop(0, "rgba(255,255,240,1)");
  g.addColorStop(0.2, "rgba(255,220,140,0.9)");
  g.addColorStop(0.55, "rgba(200,120,255,0.35)");
  g.addColorStop(1, "rgba(40,20,80,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class MemoryLamps {
  readonly group = new THREE.Group();
  readonly lamps: MemoryLamp[] = [];
  #glowTex: THREE.CanvasTexture;
  #stoneMat: THREE.MeshStandardNodeMaterial;
  #sparks: Spark[] = [];
  #sparkPool: Spark[] = [];

  constructor(map: WorldMap) {
    this.group.name = "palace-reverie-lamps";
    this.#glowTex = makeGlowTexture();
    this.#stoneMat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0xb8a88e).convertSRGBToLinear(),
      roughness: 0.88,
      metalness: 0.02
    });

    for (let i = 0; i < 48; i++) {
      const soft = createSurfaceSoftSpriteMaterial({
        map: this.#glowTex,
        color: 0xffe8b0,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        surfacePlane: horizontalSurfacePlane(0),
        feather: 0.28
      });
      const mat = soft.material;
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.scale.set(0.35, 0.35, 1);
      sprite.renderOrder = SURFACE_SOFT_SPRITE.renderOrder;
      this.group.add(sprite);
      this.#sparkPool.push({
        sprite,
        mat,
        surfacePlane: soft.surfacePlane,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        maxLife: 1
      });
    }

    for (const spec of LAMP_LAYOUT) {
      const ground = map.groundTop(spec.x, spec.z);
      const surfacePlane = terrainSurfacePlane(map, spec.x, spec.z);
      const hue = new THREE.Color(spec.hue);
      const flameMat = new THREE.MeshStandardNodeMaterial({
        color: hue.clone().convertSRGBToLinear(),
        emissive: hue.clone().convertSRGBToLinear(),
        emissiveIntensity: 0.08 * LIGHT_SCALE,
        roughness: 0.35,
        metalness: 0
      });
      const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.55, 10), this.#stoneMat);
      pedestal.position.y = 0.28;
      const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), this.#stoneMat);
      bowl.position.y = 0.62;
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), flameMat);
      flame.position.y = 0.78;
      flame.scale.set(1, 1.35, 1);

      const haloMat = createSurfaceSoftSpriteMaterial({
        map: this.#glowTex,
        color: hue,
        blending: THREE.AdditiveBlending,
        opacity: 0.12,
        surfacePlane,
        feather: 0.58
      }).material;
      const halo = new THREE.Sprite(haloMat);
      halo.position.y = 0.9;
      halo.scale.set(1.2, 1.2, 1);
      halo.renderOrder = SURFACE_SOFT_SPRITE.renderOrder;

      // Soft uplight wash on the nearby column face — taller gradient plane
      const wash = new THREE.Mesh(
        new THREE.PlaneGeometry(1.9, 6.2),
        new THREE.MeshBasicNodeMaterial({
          color: hue.clone().convertSRGBToLinear(),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide
        })
      );
      wash.position.set(0, 3.4, -0.55);
      wash.name = "lamp-wash";

      // Secondary soft ground splash under the lamp
      const puddle = new THREE.Mesh(
        new THREE.CircleGeometry(1.1, 20),
        new THREE.MeshBasicNodeMaterial({
          color: hue.clone().convertSRGBToLinear(),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide
        })
      );
      puddle.rotation.x = -Math.PI / 2;
      puddle.position.set(0, 0.08, 0.15);
      puddle.name = "lamp-puddle";

      const light = new THREE.PointLight(hue.getHex(), 0, 14, 2);
      light.position.y = 0.95;
      light.castShadow = false;
      light.visible = true;

      const root = new THREE.Group();
      root.position.set(spec.x, ground, spec.z);
      // Face wash toward palace center roughly
      root.rotation.y = Math.atan2(-(spec.x + 388), -(spec.z + 1426));
      root.add(pedestal, bowl, flame, halo, wash, puddle, light);
      this.group.add(root);

      this.lamps.push({
        x: spec.x,
        z: spec.z,
        y: ground,
        hue: spec.hue,
        whisper: spec.whisper,
        lit: false,
        awakenT: 0,
        sparkBurst: 0,
        root,
        flameMat,
        haloMat,
        surfacePlane,
        light
      });
    }
  }

  litCount(): number {
    return this.lamps.reduce((n, l) => n + (l.lit ? 1 : 0), 0);
  }

  nearestUnlit(x: number, z: number, radius: number): MemoryLamp | null {
    let best: MemoryLamp | null = null;
    let bestD = radius;
    for (const lamp of this.lamps) {
      if (lamp.lit) continue;
      const d = Math.hypot(lamp.x - x, lamp.z - z);
      if (d < bestD) {
        bestD = d;
        best = lamp;
      }
    }
    return best;
  }

  /** Soft “come closer” pulse on the nearest unlit lamp (beacon even from afar). */
  setInvite(x: number, z: number, timeSec: number) {
    const near = this.nearestUnlit(x, z, REVERIE_TUNING.promptRadius * 2.4);
    const inReach = near ? Math.hypot(near.x - x, near.z - z) <= REVERIE_TUNING.promptRadius : false;
    for (const lamp of this.lamps) {
      const invited = near === lamp;
      if (!lamp.lit) {
        const pulse = invited
          ? (inReach ? 0.55 : 0.28) + 0.45 * (0.5 + 0.5 * Math.sin(timeSec * (inReach ? 3.8 : 2.2)))
          : 0;
        lamp.haloMat.opacity = 0.1 + pulse;
        const s = 1.2 + pulse * (inReach ? 3.0 : 2.0);
        for (const c of lamp.root.children) {
          if (c instanceof THREE.Sprite && c.material === lamp.haloMat) c.scale.set(s, s, 1);
          if (c.name === "lamp-puddle" && invited) {
            const m = (c as THREE.Mesh).material as THREE.MeshBasicNodeMaterial;
            m.opacity = pulse * 0.22;
          }
        }
        lamp.flameMat.emissiveIntensity =
          (0.06 + pulse * 1.9) * (0.85 + 0.15 * Math.sin(timeSec * 5 + lamp.x)) * LIGHT_SCALE;
        if (invited) {
          lamp.light.visible = true;
          lamp.light.intensity = pulse * 2.2 * LIGHT_SCALE;
          lamp.light.distance = 10 + pulse * 8;
        }
      }
    }
  }

  nearestAny(x: number, z: number, radius: number): MemoryLamp | null {
    let best: MemoryLamp | null = null;
    let bestD = radius;
    for (const lamp of this.lamps) {
      const d = Math.hypot(lamp.x - x, lamp.z - z);
      if (d < bestD) {
        bestD = d;
        best = lamp;
      }
    }
    return best;
  }

  tryAwaken(x: number, z: number): MemoryLamp | null {
    const lamp = this.nearestUnlit(x, z, REVERIE_TUNING.interactRadius);
    if (!lamp) return null;
    lamp.lit = true;
    lamp.sparkBurst = 1;
    this.#emitSparks(lamp);
    return lamp;
  }

  forceLit(count: number) {
    for (let i = 0; i < this.lamps.length; i++) {
      const lamp = this.lamps[i];
      const was = lamp.lit;
      lamp.lit = i < count;
      lamp.awakenT = lamp.lit ? 1 : 0;
      if (lamp.lit && !was) {
        lamp.sparkBurst = 1;
        this.#emitSparks(lamp);
      }
      this.#applyVisual(lamp, 0);
    }
  }

  #emitSparks(lamp: MemoryLamp) {
    const hue = new THREE.Color(lamp.hue);
    const white = new THREE.Color(0xfff6e8);
    for (let i = 0; i < 18; i++) {
      const spark = this.#sparkPool.pop();
      if (!spark) break;
      spark.sprite.visible = true;
      spark.sprite.position.set(lamp.x, lamp.y + 0.9, lamp.z);
      spark.surfacePlane.copy(lamp.surfacePlane);
      spark.mat.color.copy(i % 4 === 0 ? white : hue);
      spark.mat.opacity = 0.95;
      const a = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 3.0;
      spark.vx = Math.cos(a) * sp;
      spark.vy = 3.0 + Math.random() * 4.2;
      spark.vz = Math.sin(a) * sp;
      spark.maxLife = 0.7 + Math.random() * 0.6;
      spark.life = spark.maxLife;
      this.#sparks.push(spark);
    }
  }

  update(dt: number, timeSec: number) {
    const rate = 1 / REVERIE_TUNING.lampAwakenSeconds;
    for (const lamp of this.lamps) {
      const target = lamp.lit ? 1 : 0;
      if (lamp.awakenT < target) lamp.awakenT = Math.min(1, lamp.awakenT + dt * rate);
      else if (lamp.awakenT > target) lamp.awakenT = Math.max(0, lamp.awakenT - dt * rate);
      if (lamp.sparkBurst > 0) lamp.sparkBurst = Math.max(0, lamp.sparkBurst - dt * 1.6);
      this.#applyVisual(lamp, timeSec);
    }

    for (let i = this.#sparks.length - 1; i >= 0; i--) {
      const s = this.#sparks[i];
      s.life -= dt;
      if (s.life <= 0) {
        s.sprite.visible = false;
        s.mat.opacity = 0;
        this.#sparks.splice(i, 1);
        this.#sparkPool.push(s);
        continue;
      }
      const u = s.life / s.maxLife;
      s.vy -= 4.5 * dt;
      s.sprite.position.x += s.vx * dt;
      s.sprite.position.y += s.vy * dt;
      s.sprite.position.z += s.vz * dt;
      s.mat.opacity = u * 0.9;
      const sc = 0.2 + u * 0.45;
      s.sprite.scale.set(sc, sc, 1);
    }
  }

  #applyVisual(lamp: MemoryLamp, timeSec: number) {
    const t = lamp.awakenT;
    const flicker = lamp.lit ? 0.85 + 0.15 * Math.sin(timeSec * 7.2 + lamp.x * 0.1) : 1;
    const burst = lamp.sparkBurst;
    lamp.flameMat.emissiveIntensity = (0.25 + t * 3.6 + burst * 2.8) * flicker * LIGHT_SCALE;
    lamp.haloMat.opacity = 0.22 + t * 0.95 + burst * 0.45;
    const s = 1.7 + t * 3.8 + burst * 2.2;
    for (const c of lamp.root.children) {
      if (c instanceof THREE.Sprite && c.material === lamp.haloMat) c.scale.set(s, s, 1);
      if (c.name === "lamp-wash") {
        const m = (c as THREE.Mesh).material as THREE.MeshBasicNodeMaterial;
        m.opacity = t * 0.48 * flicker;
        c.scale.set(1 + t * 0.25, 1 + t * 0.35, 1);
      }
      if (c.name === "lamp-puddle") {
        const m = (c as THREE.Mesh).material as THREE.MeshBasicNodeMaterial;
        m.opacity = t * 0.32 * flicker;
        const ps = 0.75 + t * 1.05;
        c.scale.set(ps, ps, 1);
      }
    }
    lamp.light.intensity = t * 6.4 * flicker;
    lamp.light.distance = 15 + t * 8;
    lamp.light.visible = t > 0.02;
  }

  dispose() {
    this.#glowTex.dispose();
    this.#stoneMat.dispose();
    for (const lamp of this.lamps) {
      lamp.flameMat.dispose();
      lamp.haloMat.dispose();
      lamp.root.traverse((o) => {
        // Sprites (flame/halo) share three's module-global quad geometry —
        // disposing it would destroy the GPU buffer under every sprite still
        // alive in the app. Their materials are disposed above.
        if ((o as unknown as THREE.Sprite).isSprite) return;
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.name === "lamp-wash" || m.name === "lamp-puddle") (m.material as THREE.Material).dispose();
      });
    }
    for (const s of [...this.#sparks, ...this.#sparkPool]) s.mat.dispose();
  }
}
