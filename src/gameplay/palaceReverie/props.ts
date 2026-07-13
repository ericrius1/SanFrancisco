import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../../world/heightmap";
import { NPC_LAYOUT } from "./layout";

/** Small props that make the keepers feel placed in the world — Inez's easel
 *  by the shore, Rook's lantern post under the colonnade. */
export class ReverieProps {
  readonly group = new THREE.Group();
  #canvasMat: THREE.MeshStandardNodeMaterial;
  #canvasTex: THREE.CanvasTexture;
  #rookLampMat: THREE.MeshStandardNodeMaterial;
  #rookHaloMat: THREE.SpriteMaterial;
  #rookLight: THREE.PointLight;
  #paintMat: THREE.MeshStandardNodeMaterial;
  #progress = 0;

  constructor(map: WorldMap) {
    this.group.name = "palace-reverie-props";
    const wood = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0x5a3d28).convertSRGBToLinear(),
      roughness: 0.9,
      metalness: 0
    });

    const paintCanvas = document.createElement("canvas");
    paintCanvas.width = paintCanvas.height = 128;
    const pctx = paintCanvas.getContext("2d")!;
    pctx.fillStyle = "#e8dcc8";
    pctx.fillRect(0, 0, 128, 128);
    const sky = pctx.createLinearGradient(0, 0, 0, 80);
    sky.addColorStop(0, "#6a88b8");
    sky.addColorStop(1, "#c8a878");
    pctx.fillStyle = sky;
    pctx.fillRect(8, 8, 112, 72);
    const water = pctx.createLinearGradient(0, 80, 0, 120);
    water.addColorStop(0, "#3a6078");
    water.addColorStop(1, "#1a3048");
    pctx.fillStyle = water;
    pctx.fillRect(8, 80, 112, 40);
    pctx.fillStyle = "rgba(255,220,160,0.55)";
    pctx.beginPath();
    pctx.arc(96, 28, 10, 0, Math.PI * 2);
    pctx.fill();
    this.#canvasTex = new THREE.CanvasTexture(paintCanvas);
    this.#canvasTex.colorSpace = THREE.SRGBColorSpace;

    this.#canvasMat = new THREE.MeshStandardNodeMaterial({
      map: this.#canvasTex,
      color: new THREE.Color(0xffffff).convertSRGBToLinear(),
      emissive: new THREE.Color(0xffc878).convertSRGBToLinear(),
      emissiveIntensity: 0.15 * LIGHT_SCALE,
      roughness: 0.7,
      metalness: 0
    });
    const iron = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0x2a2a2e).convertSRGBToLinear(),
      roughness: 0.55,
      metalness: 0.4
    });
    this.#paintMat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0x2a6a88).convertSRGBToLinear(),
      emissive: new THREE.Color(0x4a90b0).convertSRGBToLinear(),
      emissiveIntensity: 0.2 * LIGHT_SCALE,
      roughness: 0.45,
      metalness: 0.1
    });

    const inez = NPC_LAYOUT[0];
    const easel = new THREE.Group();
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.4, 0.06), wood);
    legL.position.set(-0.28, 0.7, 0.1);
    legL.rotation.z = 0.18;
    const legR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.4, 0.06), wood);
    legR.position.set(0.28, 0.7, 0.1);
    legR.rotation.z = -0.18;
    const legB = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.2, 0.06), wood);
    legB.position.set(0, 0.55, -0.28);
    legB.rotation.x = 0.35;
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.9, 0.04), this.#canvasMat);
    board.position.set(0, 1.15, 0.05);
    board.rotation.x = -0.12;
    const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.12, 10), this.#paintMat);
    jar.position.set(0.42, 0.18, 0.2);
    easel.add(legL, legR, legB, board, jar);
    const gy = map.groundTop(inez.x, inez.z);
    easel.position.set(inez.x + 1.1, gy, inez.z - 0.6);
    easel.rotation.y = inez.yaw + 0.4;
    this.group.add(easel);

    const rook = NPC_LAYOUT[1];
    const post = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.1, 8), iron);
    pole.position.y = 1.05;
    this.#rookLampMat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0xffe0a0).convertSRGBToLinear(),
      emissive: new THREE.Color(0xffb040).convertSRGBToLinear(),
      emissiveIntensity: 1.2 * LIGHT_SCALE,
      roughness: 0.35,
      metalness: 0
    });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), this.#rookLampMat);
    lamp.position.y = 2.15;

    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 64;
    const gctx = glowCanvas.getContext("2d")!;
    const gg = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gg.addColorStop(0, "rgba(255,210,140,1)");
    gg.addColorStop(0.4, "rgba(255,150,60,0.35)");
    gg.addColorStop(1, "rgba(255,100,20,0)");
    gctx.fillStyle = gg;
    gctx.fillRect(0, 0, 64, 64);
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    glowTex.colorSpace = THREE.SRGBColorSpace;
    this.#rookHaloMat = new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.55
    });
    const halo = new THREE.Sprite(this.#rookHaloMat);
    halo.position.y = 2.15;
    halo.scale.set(2.2, 2.2, 1);

    this.#rookLight = new THREE.PointLight(0xffb060, 0.7 * LIGHT_SCALE, 16, 2);
    this.#rookLight.position.y = 2.15;
    this.#rookLight.castShadow = false;

    post.add(pole, lamp, halo, this.#rookLight);
    post.position.set(rook.x - 1.2, map.groundTop(rook.x - 1.2, rook.z + 0.4), rook.z + 0.4);
    this.group.add(post);
  }

  setProgress(p: number) {
    this.#progress = THREE.MathUtils.clamp(p, 0, 1);
  }

  update(_dt: number, timeSec: number) {
    const pulse = 0.92 + Math.sin(timeSec * 1.8) * 0.08;
    this.#canvasMat.emissiveIntensity = (0.12 + this.#progress * 0.7) * pulse * LIGHT_SCALE;
    this.#canvasMat.emissive.setHSL(0.08 + this.#progress * 0.42, 0.55, 0.55);
    this.#paintMat.emissiveIntensity = (0.15 + this.#progress * 0.5) * pulse * LIGHT_SCALE;
    this.#rookLampMat.emissiveIntensity = (1.0 + this.#progress * 1.2) * pulse * LIGHT_SCALE;
    this.#rookHaloMat.opacity = 0.4 + this.#progress * 0.45;
    this.#rookLight.intensity = (0.55 + this.#progress * 1.1) * pulse * LIGHT_SCALE;
  }

  dispose() {
    this.#canvasTex.dispose();
    this.#canvasMat.dispose();
    this.#paintMat.dispose();
    this.#rookLampMat.dispose();
    this.#rookHaloMat.map?.dispose();
    this.#rookHaloMat.dispose();
    this.#rookLight.dispose();
  }
}
