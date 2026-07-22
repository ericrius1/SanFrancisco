import * as THREE from "three/webgpu";
import {
  instanceIndex,
  instancedArray,
  positionWorld,
  saturate,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { causticWeb } from "../world/waterShadingTSL";
import { LIGHT_SCALE } from "../config";
import { waterHeight, type WorldMap } from "../world/heightmap";

// TSL node generics fight composition; any is the idiom here (see facade.ts).
type N = any;

const SNOW_COUNT = 3000;
/** Camera-wrapped cube edge (m): particles live in ±22 m around the eye. */
const SNOW_BOX = 44;
const SNOW_HALF = SNOW_BOX / 2;
const CAUSTIC_SIZE = 90;

/**
 * Lazy underwater volume: drifting "marine snow" (ONE instanced-sprite draw,
 * positions wrapped around the camera in the vertex stage — buffers are never
 * rewritten) and a camera-following additive caustic carpet hugging the local
 * bay floor. Constructed by fx/underwaterRig.ts on first near-water approach,
 * prewarmed hidden, and toggled purely via `visible` + uniforms afterwards —
 * no pipeline rebuilds, no lights.
 *
 * Both materials are branchless (mix/smoothstep only) per the project's WGSL
 * uniformity rule, and neither casts/receives shadows or writes depth.
 */
export class UnderwaterVolume {
  readonly root = new THREE.Group();
  #map: WorldMap;
  #camU = uniform(new THREE.Vector3());
  #snowFade = uniform(0);
  #causticIntensity = uniform(0);
  #causticCam = uniform(new THREE.Vector2());
  #snow: THREE.Sprite;
  #caustics: THREE.Mesh;

  constructor(map: WorldMap) {
    this.#map = map;
    this.root.name = "underwater-volume";

    // ---- marine snow: bayLights pattern (Sprite + count + instancedArray).
    const seeds = new Float32Array(SNOW_COUNT * 4);
    for (let i = 0; i < SNOW_COUNT; i++) {
      seeds[i * 4 + 0] = Math.random();
      seeds[i * 4 + 1] = Math.random();
      seeds[i * 4 + 2] = Math.random();
      seeds[i * 4 + 3] = Math.random();
    }
    const seedArr = instancedArray(seeds, "vec4");
    const snowMat = new THREE.SpriteNodeMaterial();
    const s = seedArr.element(instanceIndex) as unknown as N;
    const t = time as N;
    const base = s.xyz.mul(SNOW_BOX);
    // slow sink + gentle pseudo-curl drift, all a function of time — buffers
    // are static, the wrap below keeps every particle inside the camera box
    const sink = t.mul(s.w.mul(0.08).add(0.05)).negate();
    const swayX = t.mul(0.11).add(s.w.mul(43.7)).sin().mul(1.4);
    const swayZ = t.mul(0.09).add(s.w.mul(91.3)).cos().mul(1.4);
    const drifted = base.add(vec3(swayX, sink, swayZ));
    const camU = this.#camU as unknown as N;
    const rel = drifted
      .sub(camU)
      .div(SNOW_BOX)
      .fract()
      .mul(SNOW_BOX)
      .sub(SNOW_HALF);
    snowMat.positionNode = camU.add(rel);
    snowMat.scaleNode = s.w.mul(0.07).add(0.05);
    // per-instance reads resolve in the vertex stage only (bayLights rule)
    const dist = vertexStage(rel.length()) as unknown as N;
    // distance fades hide both the wrap boundary and near-eye popping
    const edgeFade = smoothstep(15.0, 21.0, dist).oneMinus();
    const nearFade = smoothstep(0.6, 2.4, dist);
    const d = uv().sub(0.5).length().mul(2);
    const disc = saturate(d.oneMinus()).pow(1.8);
    // The post-process Beer-Lambert fog attenuates every pixel by the OPAQUE
    // depth behind it; a depth-free sprite over open water inherits the far
    // water column's ~zero transmittance and vanishes. So each mote writes
    // depth on its alpha-tested core: the fog then sees the mote's true
    // distance and shades it correctly instead of erasing it.
    snowMat.colorNode = vec4(vec3(0.72, 0.88, 1.0).mul(0.55 * LIGHT_SCALE), 1);
    snowMat.opacityNode = disc
      .mul(edgeFade)
      .mul(nearFade)
      .mul(this.#snowFade as unknown as N);
    snowMat.alphaTest = 0.05;
    snowMat.transparent = true;
    snowMat.blending = THREE.AdditiveBlending;
    snowMat.depthWrite = true;
    snowMat.fog = false;
    const snow = new THREE.Sprite(snowMat);
    snow.count = SNOW_COUNT;
    snow.frustumCulled = false;
    snow.renderOrder = 18; // after spray/landing in the water ladder
    snow.visible = false;
    this.#snow = snow;
    this.root.add(snow);

    // ---- caustic shimmer carpet near the seabed. World-anchored pattern on a
    // camera-following quad: the dapple stays put while the quad glides.
    const causticGeo = new THREE.PlaneGeometry(CAUSTIC_SIZE, CAUSTIC_SIZE, 1, 1);
    causticGeo.rotateX(-Math.PI / 2);
    const causticMat = new THREE.MeshBasicNodeMaterial();
    const wp = positionWorld as N;
    const web = causticWeb(wp.xz.mul(0.42), t.mul(0.8));
    const camDist = wp.xz.sub(this.#causticCam as unknown as N).length();
    const radial = smoothstep(18.0, 44.0, camDist).oneMinus();
    causticMat.colorNode = vec4(
      vec3(0.5, 0.85, 0.95)
        .mul(web)
        .mul(radial)
        .mul(this.#causticIntensity as unknown as N)
        .mul(0.35 * LIGHT_SCALE),
      1
    );
    causticMat.transparent = true;
    causticMat.blending = THREE.AdditiveBlending;
    // Deliberately depth-writing (same post-fog reasoning as the snow): the
    // carpet grounds the water column at the real floor distance, so the fog
    // grades it by its true path length instead of erasing it — and offshore
    // spans with no streamed seabed geometry still read as a floor.
    causticMat.depthWrite = true;
    causticMat.fog = false;
    const caustics = new THREE.Mesh(causticGeo, causticMat);
    caustics.frustumCulled = false;
    caustics.renderOrder = 8; // just under the water-underside lid (9)
    caustics.visible = false;
    this.#caustics = caustics;
    this.root.add(caustics);
  }

  /**
   * Per-frame drive. `submersion` is the rig's smoothed 0..1 camera state and
   * `lightUp` its sun-elevation factor. Uniform writes + one visibility flip
   * only; nothing here allocates or rebuilds.
   */
  update(camera: THREE.PerspectiveCamera, timeSec: number, submersion: number, lightUp: number) {
    const active = submersion > 0.01;
    if (this.#snow.visible !== active) {
      this.#snow.visible = active;
      this.#caustics.visible = active;
    }
    if (!active) return;
    const cx = camera.position.x;
    const cz = camera.position.z;
    (this.#camU.value as THREE.Vector3).copy(camera.position);
    this.#snowFade.value = submersion;

    const floorY = this.#map.groundHeight(cx, cz);
    const wy = waterHeight(cx, cz, timeSec);
    this.#caustics.position.set(cx, floorY + 0.12, cz);
    (this.#causticCam.value as THREE.Vector2).set(cx, cz);
    // deeper floor = dimmer dapple; subtle is correct — light, not a grid
    const floorDepth = Math.max(0, wy - floorY);
    this.#causticIntensity.value = submersion * Math.exp(-0.09 * floorDepth) * lightUp;
  }
}

export function createUnderwaterVolume(map: WorldMap) {
  return new UnderwaterVolume(map);
}
