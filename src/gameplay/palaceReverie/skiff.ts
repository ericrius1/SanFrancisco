import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { PALACE_LAGOON } from "../../world/heightmap";

/** A quiet skiff drifting on the lagoon — one more warm light on the water. */
export class LagoonSkiff {
  readonly group = new THREE.Group();
  #hull: THREE.Group;
  #lampMat: THREE.MeshStandardNodeMaterial;
  #glow: THREE.Sprite;
  #glowMat: THREE.SpriteMaterial;
  #wakeMat: THREE.MeshBasicNodeMaterial;
  #wake: THREE.Mesh;
  #trailMat: THREE.MeshBasicNodeMaterial;
  #trail: THREE.Mesh;
  #light: THREE.PointLight;
  #progress = 0;

  constructor() {
    this.group.name = "palace-reverie-skiff";
    const wood = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0x4a3424).convertSRGBToLinear(),
      roughness: 0.9,
      metalness: 0
    });
    this.#hull = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.35, 0.95), wood);
    body.position.y = 0.1;
    const bow = new THREE.Mesh(new THREE.ConeGeometry(0.48, 0.9, 4), wood);
    bow.rotation.z = Math.PI / 2;
    bow.position.set(1.35, 0.12, 0);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.7), wood);
    seat.position.set(-0.2, 0.28, 0);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.6, 6), wood);
    mast.position.set(0.3, 1.0, 0);

    this.#lampMat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0xffe2b0).convertSRGBToLinear(),
      emissive: new THREE.Color(0xffb060).convertSRGBToLinear(),
      emissiveIntensity: 0.8 * LIGHT_SCALE,
      roughness: 0.4,
      metalness: 0
    });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), this.#lampMat);
    lamp.position.set(0.3, 1.85, 0);

    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 64;
    const gctx = glowCanvas.getContext("2d")!;
    const gg = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gg.addColorStop(0, "rgba(255,210,140,0.95)");
    gg.addColorStop(0.35, "rgba(255,160,80,0.35)");
    gg.addColorStop(1, "rgba(255,120,40,0)");
    gctx.fillStyle = gg;
    gctx.fillRect(0, 0, 64, 64);
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    glowTex.colorSpace = THREE.SRGBColorSpace;
    this.#glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.55
    });
    this.#glow = new THREE.Sprite(this.#glowMat);
    this.#glow.scale.set(2.4, 2.4, 1);
    this.#glow.position.set(0.3, 1.85, 0);

    this.#light = new THREE.PointLight(0xffb070, 0.55 * LIGHT_SCALE, 22, 2);
    this.#light.position.set(0.3, 1.85, 0);
    this.#light.castShadow = false;

    this.#wakeMat = new THREE.MeshBasicNodeMaterial({
      color: new THREE.Color(0xffc878).convertSRGBToLinear(),
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    this.#wake = new THREE.Mesh(new THREE.CircleGeometry(1.8, 24), this.#wakeMat);
    this.#wake.rotation.x = -Math.PI / 2;
    this.#wake.position.y = -0.02;

    this.#trailMat = new THREE.MeshBasicNodeMaterial({
      color: new THREE.Color(0x9ec8ff).convertSRGBToLinear(),
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    this.#trail = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 1.4), this.#trailMat);
    this.#trail.rotation.x = -Math.PI / 2;
    this.#trail.position.set(-1.6, -0.03, 0);

    this.#hull.add(body, bow, seat, mast, lamp, this.#glow, this.#light, this.#wake, this.#trail);
    this.group.add(this.#hull);
    this.#hull.position.set(PALACE_LAGOON.x + 22, PALACE_LAGOON.surfaceY + 0.15, PALACE_LAGOON.z - 18);
  }

  setProgress(p: number) {
    this.#progress = THREE.MathUtils.clamp(p, 0, 1);
  }

  update(_dt: number, timeSec: number) {
    const bob = Math.sin(timeSec * 0.7) * 0.06;
    const yaw = -0.6 + Math.sin(timeSec * 0.15) * 0.08;
    this.#hull.position.y = PALACE_LAGOON.surfaceY + 0.15 + bob;
    this.#hull.position.x = PALACE_LAGOON.x + 22 + Math.sin(timeSec * 0.12) * 3;
    this.#hull.position.z = PALACE_LAGOON.z - 18 + Math.cos(timeSec * 0.11) * 2.5;
    this.#hull.rotation.y = yaw;
    this.#hull.rotation.z = Math.sin(timeSec * 0.9) * 0.04;
    const pulse = 0.92 + Math.sin(timeSec * 2.1) * 0.08;
    this.#lampMat.emissiveIntensity = (0.7 + this.#progress * 1.6) * pulse * LIGHT_SCALE;
    this.#glowMat.opacity = 0.4 + this.#progress * 0.55;
    const g = 2.1 + this.#progress * 1.6;
    this.#glow.scale.set(g, g, 1);
    this.#light.intensity = (0.45 + this.#progress * 1.35) * pulse * LIGHT_SCALE;
    this.#wakeMat.opacity = 0.18 + this.#progress * 0.32 + Math.sin(timeSec * 1.4) * 0.04;
    const ws = 1.6 + this.#progress * 1.2 + Math.sin(timeSec * 0.9) * 0.12;
    this.#wake.scale.set(ws * 1.4, ws, 1);
    this.#trailMat.opacity = 0.1 + this.#progress * 0.22 + Math.sin(timeSec * 1.1) * 0.03;
    this.#trail.scale.set(1 + this.#progress * 0.5, 0.85 + Math.sin(timeSec * 1.3) * 0.1, 1);
  }

  dispose() {
    this.#hull.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.#lampMat.dispose();
    this.#glowMat.map?.dispose();
    this.#glowMat.dispose();
    this.#wakeMat.dispose();
    this.#trailMat.dispose();
    this.#light.dispose();
  }
}
