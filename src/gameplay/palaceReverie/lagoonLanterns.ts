import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { PALACE_LAGOON, type WorldMap } from "../../world/heightmap";
import { REVERIE_TUNING } from "./layout";
import {
  createSurfaceSoftSpriteMaterial,
  horizontalSurfacePlane,
  SURFACE_SOFT_SPRITE
} from "./surfaceSoftSprite";

/**
 * Floating paper-lantern vessels on the Palace lagoon — always-on scenery for
 * the site, with a gentle bob and a soft emissive halo that brightens as the
 * quest progresses.
 */

type Vessel = {
  x: number;
  z: number;
  homeX: number;
  homeZ: number;
  phase: number;
  speed: number;
  amp: number;
  spin: number;
  drift: number;
  root: THREE.Group;
  bodyMat: THREE.MeshStandardNodeMaterial;
  halo: THREE.Sprite;
  haloMat: THREE.SpriteNodeMaterial;
};

function makeHaloTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  g.addColorStop(0, "rgba(255,248,220,1)");
  g.addColorStop(0.22, "rgba(255,210,140,0.85)");
  g.addColorStop(0.55, "rgba(180,140,255,0.28)");
  g.addColorStop(1, "rgba(80,60,140,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class LagoonLanterns {
  readonly group = new THREE.Group();
  #vessels: Vessel[] = [];
  #progress = 0;
  #sharedRim: THREE.MeshStandardNodeMaterial;
  #haloTex: THREE.CanvasTexture;

  constructor(map: WorldMap) {
    this.group.name = "palace-reverie-lanterns";
    this.#sharedRim = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0x5a4030).convertSRGBToLinear(),
      roughness: 0.85,
      metalness: 0
    });
    this.#haloTex = makeHaloTexture();

    const n = REVERIE_TUNING.floatLanternCount;
    for (let i = 0; i < n; i++) {
      const u = (i + 0.37) / n;
      const a = u * Math.PI * 2 + Math.sin(i * 1.7) * 0.35;
      const r = 0.28 + (i % 5) * 0.1 + (i % 3) * 0.035;
      const x = PALACE_LAGOON.x + Math.cos(a) * PALACE_LAGOON.radiusX * r;
      const z = PALACE_LAGOON.z + Math.sin(a) * PALACE_LAGOON.radiusZ * r * 0.92;
      if (!map.lagoonWater(x, z)) continue;

      const hue = new THREE.Color().setHSL(0.08 + (i % 7) * 0.09, 0.55, 0.62);
      const bodyMat = new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color(0xffe2b8).convertSRGBToLinear(),
        emissive: hue.clone().convertSRGBToLinear(),
        emissiveIntensity: 0.55 * LIGHT_SCALE,
        roughness: 0.55,
        metalness: 0.05
      });
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), bodyMat);
      body.scale.set(1, 1.15, 1);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.035, 6, 14), this.#sharedRim);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.12;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.22, 6), this.#sharedRim);
      post.position.y = -0.22;

      const root = new THREE.Group();
      root.add(body, rim, post);

      const haloMat = createSurfaceSoftSpriteMaterial({
        map: this.#haloTex,
        color: hue,
        blending: THREE.AdditiveBlending,
        opacity: 0.55,
        surfacePlane: horizontalSurfacePlane(PALACE_LAGOON.surfaceY),
        feather: 0.52
      }).material;
      const halo = new THREE.Sprite(haloMat);
      halo.scale.set(1.8, 1.8, 1);
      halo.renderOrder = SURFACE_SOFT_SPRITE.renderOrder;

      this.group.add(root, halo);
      this.#vessels.push({
        x,
        z,
        homeX: x,
        homeZ: z,
        phase: i * 0.73,
        speed: 0.55 + (i % 4) * 0.12,
        amp: 0.06 + (i % 3) * 0.02,
        spin: 0.15 + (i % 5) * 0.04,
        drift: 0.8 + (i % 6) * 0.35,
        root,
        bodyMat,
        halo,
        haloMat
      });
    }
  }

  setProgress(p: number) {
    this.#progress = THREE.MathUtils.clamp(p, 0, 1);
  }

  update(_dt: number, timeSec: number) {
    const lift = 0.22 + this.#progress * 0.16;
    for (const v of this.#vessels) {
      const orbit = timeSec * 0.07 + v.phase;
      v.x = v.homeX + Math.cos(orbit) * v.drift;
      v.z = v.homeZ + Math.sin(orbit * 0.85) * v.drift * 0.75;
      const bob = Math.sin(timeSec * v.speed + v.phase) * v.amp;
      const y = PALACE_LAGOON.surfaceY + lift + bob;
      v.root.position.set(v.x, y, v.z);
      v.root.rotation.y = timeSec * v.spin + v.phase;
      v.root.rotation.x = Math.sin(timeSec * 0.7 + v.phase) * 0.1;
      v.halo.position.set(v.x, y + 0.18, v.z);
      v.bodyMat.emissiveIntensity = (1.2 + this.#progress * 2.2) * LIGHT_SCALE;
      const pulse = 0.7 + 0.35 * Math.sin(timeSec * 1.4 + v.phase) + this.#progress * 0.55;
      v.haloMat.opacity = pulse;
      const s = 3.0 + this.#progress * 2.8 + Math.sin(timeSec * 0.9 + v.phase) * 0.35;
      v.halo.scale.set(s, s, 1);
    }
  }

  dispose() {
    this.#haloTex.dispose();
    this.#sharedRim.dispose();
    for (const v of this.#vessels) {
      v.root.traverse((o) => {
        // Sprites (halo) share three's module-global quad geometry — disposing
        // it would destroy the GPU buffer under every sprite still alive.
        if ((o as unknown as THREE.Sprite).isSprite) return;
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      v.bodyMat.dispose();
      v.haloMat.dispose();
    }
  }
}
