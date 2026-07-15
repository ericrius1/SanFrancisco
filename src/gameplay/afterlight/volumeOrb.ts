import * as THREE from "three/webgpu";
import {
  cameraPosition,
  color,
  float,
  modelWorldMatrixInverse,
  positionLocal,
  screenCoordinate,
  time,
  vec4,
  wgslFn
} from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import volumeOrbCode from "./shaders/volumeOrb.wgsl?raw";

type N = any;
export type ScalarUniform = { value: number };

const volumeOrb = wgslFn(volumeOrbCode);

/**
 * HyperMind-style bounded volumetric node, adapted to a real Three.js sphere.
 * The expensive field is evaluated only inside the Afterlight feature chunk;
 * each visible orb uses 10–24 steps based on its screen footprint.
 */
export function makeVolumetricOrbMaterial(
  hue: number,
  activity: ScalarUniform,
  seed: number,
  radius: number,
  baseEnergy = 0.46
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial();
  const localCamera = (modelWorldMatrixInverse as N).mul(vec4(cameraPosition, 1)).xyz as N;
  const energy = float(baseEnergy).add((activity as N).mul(1 - baseEnergy)) as N;
  const sample = volumeOrb({
    localSurface: positionLocal,
    localCamera,
    pixel: (screenCoordinate as N).xy,
    tint: color(hue),
    params: vec4(time, energy, float(seed), float(radius))
  }) as N;
  material.fragmentNode = vec4(sample.rgb.mul(LIGHT_SCALE * 1.08), sample.a);
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.FrontSide;
  material.blending = THREE.NormalBlending;
  material.fog = false;
  return material;
}
