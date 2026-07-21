import * as THREE from "three/webgpu";
import {
  cos,
  float,
  instancedArray,
  instanceIndex,
  saturate,
  sin,
  uniform,
  uv,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import type { WorldMap } from "../../world/heightmap";
import { oceanBeachApproxShoreX, OCEAN_BEACH_SURF } from "../../world/oceanBeachWaves";

type N = any;

type OceanLight = Readonly<{
  x: number;
  y: number;
  z: number;
  radius: number;
  phase: number;
  speed: number;
  drift: number;
  bob: number;
  color: THREE.Color;
}>;

type OceanLightLayer = Readonly<{
  lights: readonly OceanLight[];
  cores: THREE.InstancedMesh;
  halos: THREE.Sprite;
}>;

const SURFACE_COUNT = 36;
const SUBMERGED_COUNT = 24;
const TWILIGHT_START_ELEVATION = 2;
const NIGHT_FULL_ELEVATION = -6;
const TAU = Math.PI * 2;

function hash(index: number, seed: number): number {
  const value = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function smooth01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function twilightWeight(sunElevation: number): number {
  return smooth01(
    (TWILIGHT_START_ELEVATION - sunElevation) /
      (TWILIGHT_START_ELEVATION - NIGHT_FULL_ELEVATION)
  );
}

function makeMaterial(
  opacity: number,
  depthTest: boolean
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity,
    depthTest,
    depthWrite: false,
    fog: false
  });
  // These are light sources rather than colored surfaces. Keeping them out of
  // the scene tone map preserves the saturated Palace-Reverie palette at the
  // several-kilometre viewing distances of the westbound flight.
  material.toneMapped = false;
  return material;
}

function buildLights(
  map: WorldMap,
  count: number,
  submerged: boolean,
  seed: number
): OceanLight[] {
  const lights: OceanLight[] = [];
  for (let attempt = 0; lights.length < count && attempt < count * 32; attempt++) {
    const z = THREE.MathUtils.lerp(
      OCEAN_BEACH_SURF.minZ + 120,
      OCEAN_BEACH_SURF.maxZ - 120,
      hash(attempt, seed + 1)
    );
    const shoreX = oceanBeachApproxShoreX(z);
    // A broad Pacific field fills the westbound horizon without painting the
    // beach or city. The nearest lights are still offshore; the farthest form
    // a second, quieter constellation toward the horizon.
    const offshore = 130 + Math.pow(hash(attempt, seed + 2), 0.72) * 1_650;
    const x = shoreX - offshore;
    if (!map.isWater(x, z)) continue;

    const vertical = hash(attempt, seed + 3);
    const color = new THREE.Color().setHSL(
      (0.06 + hash(attempt, seed + 4) * 0.66) % 1,
      submerged ? 0.82 : 0.78,
      submerged ? 0.62 : 0.66
    );
    lights.push({
      x,
      y: submerged
        ? -3.5 - vertical * 24
        : 4 + Math.pow(vertical, 1.45) * 72,
      z,
      radius: submerged
        ? 2.8 + hash(attempt, seed + 5) * 4.6
        : 4.2 + hash(attempt, seed + 5) * 8.8,
      phase: hash(attempt, seed + 6) * TAU,
      speed: 0.08 + hash(attempt, seed + 7) * 0.1,
      drift: 8 + hash(attempt, seed + 8) * 28,
      bob: submerged
        ? 0.8 + hash(attempt, seed + 9) * 2.4
        : 2.2 + hash(attempt, seed + 9) * 5.8,
      color
    });
  }
  return lights;
}

/**
 * A flight-only Pacific echo of the Palace Reverie lagoon lanterns.
 *
 * The field is four instanced draws: luminous cores + soft analytic halos for
 * an aerial layer and a dimmer submerged layer. The underwater lights render
 * after the opaque ocean so they read as light diffusing up through the water,
 * while their low opacity keeps them visibly below the surface rather than
 * pasted on top of it.
 */
export class HangGlidingOceanLights {
  readonly group = new THREE.Group();

  #geometry = new THREE.SphereGeometry(1, 12, 9);
  #time = uniform(0);
  #night = uniform(0);
  #surfaceCoreMaterial = makeMaterial(0, true);
  #submergedCoreMaterial = makeMaterial(0, false);
  #surface: OceanLightLayer;
  #submerged: OceanLightLayer;
  #matrix = new THREE.Matrix4();
  #position = new THREE.Vector3();
  #scale = new THREE.Vector3();
  #quaternion = new THREE.Quaternion();
  #nightWeight = 0;

  constructor(map: WorldMap) {
    this.group.name = "hang_gliding_ocean_lights";
    this.group.visible = false;
    this.#surface = this.#makeLayer(
      buildLights(map, SURFACE_COUNT, false, 19),
      this.#surfaceCoreMaterial,
      false,
      "surface"
    );
    this.#submerged = this.#makeLayer(
      buildLights(map, SUBMERGED_COUNT, true, 47),
      this.#submergedCoreMaterial,
      true,
      "submerged"
    );
    this.group.add(
      this.#submerged.halos,
      this.#submerged.cores,
      this.#surface.halos,
      this.#surface.cores
    );
    this.#writeLayer(this.#surface, 0);
    this.#writeLayer(this.#submerged, 0);
  }

  get debugState() {
    return {
      visible: this.group.visible,
      nightWeight: this.#nightWeight,
      surfaceCount: this.#surface.lights.length,
      submergedCount: this.#submerged.lights.length
    };
  }

  update(time: number, flightActive: boolean, sunElevation: number): void {
    this.#nightWeight = twilightWeight(sunElevation);
    const visible = flightActive && this.#nightWeight > 0.002;
    this.group.visible = visible;
    if (!visible) return;

    const night = this.#nightWeight;
    this.#time.value = time;
    this.#night.value = night;
    this.#surfaceCoreMaterial.opacity = night * 0.92;
    this.#submergedCoreMaterial.opacity = night * 0.3;
    this.#writeLayer(this.#surface, time);
    this.#writeLayer(this.#submerged, time);
  }

  hide(): void {
    this.group.visible = false;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.#geometry.dispose();
    this.#surfaceCoreMaterial.dispose();
    this.#submergedCoreMaterial.dispose();
    (this.#surface.halos.material as THREE.Material).dispose();
    (this.#submerged.halos.material as THREE.Material).dispose();
  }

  #makeLayer(
    lights: readonly OceanLight[],
    coreMaterial: THREE.MeshBasicMaterial,
    submerged: boolean,
    name: string
  ): OceanLightLayer {
    const cores = new THREE.InstancedMesh(this.#geometry, coreMaterial, lights.length);
    const halos = this.#makeHaloSprite(lights, submerged);
    cores.name = `hang_gliding_ocean_${name}_cores`;
    halos.name = `hang_gliding_ocean_${name}_halos`;
    cores.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cores.frustumCulled = false;
    halos.frustumCulled = false;
    cores.renderOrder = name === "submerged" ? 14 : 12;
    halos.renderOrder = name === "submerged" ? 15 : 13;
    for (let i = 0; i < lights.length; i++) {
      const coreColor = lights[i].color.clone();
      cores.setColorAt(i, coreColor);
    }
    if (cores.instanceColor) cores.instanceColor.needsUpdate = true;
    return { lights, cores, halos };
  }

  #makeHaloSprite(lights: readonly OceanLight[], submerged: boolean): THREE.Sprite {
    const positionRadius: number[] = [];
    const motionData: number[] = [];
    const colorData: number[] = [];
    for (const light of lights) {
      positionRadius.push(light.x, light.y, light.z, light.radius);
      motionData.push(light.phase, light.speed, light.drift, light.bob);
      const haloColor = light.color.clone().lerp(new THREE.Color(0xffffff), 0.28);
      colorData.push(haloColor.r, haloColor.g, haloColor.b, 1);
    }

    const homes = instancedArray(new Float32Array(positionRadius), "vec4");
    const motions = instancedArray(new Float32Array(motionData), "vec4");
    const colors = instancedArray(new Float32Array(colorData), "vec4");
    const home = homes.element(instanceIndex) as unknown as N;
    const motion = motions.element(instanceIndex) as unknown as N;
    const glowColor = colors.element(instanceIndex) as unknown as N;
    const orbit = (this.#time as N).mul(motion.y).add(motion.x);

    const material = new THREE.SpriteNodeMaterial();
    material.positionNode = vec3(
      home.x.add(cos(orbit).mul(motion.z)),
      home.y.add(sin(orbit.mul(1.7)).mul(motion.w)),
      home.z.add(sin(orbit.mul(0.83)).mul(motion.z).mul(0.72))
    );
    const pulse = sin((this.#time as N).mul(0.34).add(motion.x)).mul(0.08).add(1);
    material.scaleNode = home.w.mul(submerged ? 7.4 : 6.2).mul(pulse);

    const shaded = vertexStage(
      glowColor.xyz
        .mul(this.#night as N)
        .mul(submerged ? float(0.42) : float(0.72))
    ) as unknown as N;
    const radius = (uv() as N).sub(0.5).mul(2).length();
    const soft = saturate(radius.oneMinus()).pow(2.15);
    const hotCore = saturate(radius.mul(2.35).oneMinus()).pow(5).mul(0.62);
    const submergedDiffusion = submerged
      ? saturate(radius.mul(0.82).oneMinus()).pow(2.7).mul(0.2)
      : float(0);
    material.colorNode = vec4(shaded.mul(soft.add(hotCore).add(submergedDiffusion)), 1);
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthTest = !submerged;
    material.depthWrite = false;
    material.fog = false;
    material.toneMapped = false;

    const sprite = new THREE.Sprite(material);
    sprite.count = lights.length;
    sprite.frustumCulled = false;
    return sprite;
  }

  #writeLayer(layer: OceanLightLayer, time: number): void {
    for (let i = 0; i < layer.lights.length; i++) {
      const light = layer.lights[i];
      const orbit = time * light.speed + light.phase;
      this.#position.set(
        light.x + Math.cos(orbit) * light.drift,
        light.y + Math.sin(orbit * 1.7) * light.bob,
        light.z + Math.sin(orbit * 0.83) * light.drift * 0.72
      );
      const pulse = 0.94 + Math.sin(time * 0.62 + light.phase * 1.3) * 0.06;
      this.#scale.setScalar(light.radius * pulse);
      this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
      layer.cores.setMatrixAt(i, this.#matrix);
    }
    layer.cores.instanceMatrix.needsUpdate = true;
  }
}
