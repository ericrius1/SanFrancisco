import * as THREE from "three/webgpu";
import {
  OCEAN_BEACH_SURF,
  oceanBeachCrestX,
  oceanBeachFoamNoise
} from "../../world/oceanBeachWaves";
import { RenderBand, tagTransparency } from "../../render/transparency";

const SLOTS = 7;

/**
 * Localized crest spray for the analytic Ocean Beach wave train. The displaced
 * TSL water owns the continuous face; particles supply the breaking silhouette
 * without laying a translucent seam across the ocean at grazing angles.
 */
export class OceanBeachWaves {
  readonly group = new THREE.Group();
  readonly activeWaveCount = SLOTS;

  #spray: THREE.Points;
  #sprayPositions: Float32Array;
  #sprayVelocity: Float32Array;

  constructor(scene: THREE.Scene) {
    this.group.name = "ocean_beach_breaking_waves";
    const sprayCount = 480;
    this.#sprayPositions = new Float32Array(sprayCount * 3);
    this.#sprayVelocity = new Float32Array(sprayCount * 3);
    const sprayGeo = new THREE.BufferGeometry();
    sprayGeo.setAttribute("position", new THREE.BufferAttribute(this.#sprayPositions, 3));
    sprayGeo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(-6030, 3, OCEAN_BEACH_SURF.centerZ),
      2200
    );
    const sprayMat = new THREE.PointsMaterial({
      color: 0xeaffff,
      size: 1.05,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      sizeAttenuation: true
    });
    this.#spray = new THREE.Points(sprayGeo, sprayMat);
    tagTransparency(this.#spray, {
      profile: "additiveWorld",
      renderBand: RenderBand.PARTICLES
    });
    this.group.add(this.#spray);
    scene.add(this.group);
    this.update(0);
  }

  update(time: number, focus?: { x: number; z: number }) {
    const b = OCEAN_BEACH_SURF;
    const focusZ = focus && focus.z > b.minZ - 600 && focus.z < b.maxZ + 600 ? focus.z : b.entryZ;
    const stripMinZ = Math.max(b.minZ, focusZ - 360);
    const stripMaxZ = Math.min(b.maxZ, focusZ + 360);
    this.group.visible = !focus || (
      focus.x > b.minX - 1400 && focus.x < b.maxX + 1400 &&
      focus.z > b.minZ - 900 && focus.z < b.maxZ + 900
    );
    if (!this.group.visible) return;
    const sp = this.#sprayPositions;
    const sv = this.#sprayVelocity;
    const count = sp.length / 3;
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      const life = (time * (0.42 + (i % 7) * 0.018) + i * 0.137) % 1;
      const z = THREE.MathUtils.lerp(stripMinZ, stripMaxZ, ((i * 0.6180339) % 1 + time * 0.006) % 1);
      const slot = (i % SLOTS) - 1;
      const crestX = oceanBeachCrestX(slot, z, time);
      const amp = b.amplitude * (0.78 + Math.sin(z * 0.0041 + time * 0.1) * 0.12);
      const gust = oceanBeachFoamNoise(z, time, i % 13);
      sv[k] = 2.3 + gust * 2.2;
      sv[k + 1] = 2.8 + gust * 4.2;
      sv[k + 2] = Math.sin(i * 9.17) * 1.8;
      sp[k] = crestX + 2 + sv[k] * life;
      sp[k + 1] = amp * 0.92 + sv[k + 1] * life - 5.6 * life * life;
      sp[k + 2] = z + sv[k + 2] * life;
    }
    (this.#spray.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }
}
