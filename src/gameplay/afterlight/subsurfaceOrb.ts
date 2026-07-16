import * as THREE from "three/webgpu";
import {
  cameraPosition,
  clamp,
  color,
  float,
  mix,
  modelWorldMatrixInverse,
  mx_noise_float,
  normalGeometry,
  normalize,
  positionGeometry,
  time,
  vec3,
  vec4
} from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import type { ScalarUniform } from "./volumeOrb";

type N = any;

/**
 * Constant-cost subsurface illusion for the secondary Afterlight crystals.
 *
 * The view ray is advanced to a fixed layer below the surface, then a
 * procedural model-space pattern is sampled at that shifted position. This is
 * the useful core of the fixed-depth/parallax technique from prizemlenie's
 * subsurface-refraction demo, adapted to our convex procedural crystals: the
 * normalized inner position replaces its generated normal cubemap and two
 * noise evaluations replace its triplanar texture reads. There are no loops,
 * screen grabs, transmission passes, or per-object textures.
 */
export function makeSubsurfaceOrbMaterial(
  hue: number,
  activity: ScalarUniform,
  seed: number,
  radius: number,
  baseEnergy = 0.36
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  const localCamera = (modelWorldMatrixInverse as N).mul(vec4(cameraPosition, 1)).xyz as N;
  const view = normalize(localCamera.sub(positionGeometry)) as N;
  const surfaceNormal = normalize(normalGeometry) as N;
  const nDotV = clamp(surfaceNormal.dot(view), 0.16, 1) as N;

  // A single analytical step lands on the imagined inner layer. Dividing by
  // N·V makes the pattern slide under the shell as the view becomes oblique.
  const layerDepth = float(radius * 0.14).div(nDotV) as N;
  const subsurfacePosition = (positionGeometry as N).sub(view.mul(layerDepth)) as N;
  const subsurfaceNormal = normalize(subsurfacePosition) as N;
  const facing = clamp(subsurfaceNormal.dot(view), -1, 1) as N;
  const frontVisibility = clamp(facing, 0, 1).pow(3.4) as N;
  const thinVisibility = clamp(facing.negate(), 0, 1).pow(2.6) as N;

  const drift = vec3(time.mul(0.018), time.mul(-0.012), time.mul(0.009)) as N;
  const seedOffset = vec3(seed * 7.13, seed * 11.47, seed * 17.89) as N;
  const domain = (subsurfacePosition as N)
    .div(radius)
    .mul(3.15)
    .add(seedOffset)
    .add(drift) as N;
  const broad = mx_noise_float(domain).mul(0.5).add(0.5) as N;
  const detail = mx_noise_float(domain.mul(2.65).add(vec3(13.7, 5.1, 9.3)))
    .mul(0.5)
    .add(0.5) as N;
  const tissue = broad.mul(0.68).add(detail.mul(0.32)) as N;
  const cells = tissue.smoothstep(0.28, 0.74) as N;
  const fissures = detail.sub(0.5).abs().smoothstep(0.11, 0.018) as N;
  const interiorPattern = cells.mul(0.56).add(0.38).mul(fissures.mul(0.28).add(0.86)) as N;

  const tint = color(hue) as N;
  const deep = mix(color(0x02050a), tint, 0.075) as N;
  const interior = mix(tint, color(0xffc978), 0.5).mul(interiorPattern) as N;
  const thin = mix(tint, color(0xffefe0), 0.36) as N;
  const resolved = mix(mix(deep, interior, frontVisibility), thin, thinVisibility) as N;
  const fresnel = float(1).sub(nDotV).pow(2.25) as N;
  const energy = float(baseEnergy).add((activity as N).mul(1 - baseEnergy)) as N;
  const pulse = time.mul(1.3).add(seed * 19.0).sin().mul(0.045).add(0.955) as N;

  // The standard surface supplies one inexpensive faceted highlight. Emission
  // carries the buried pattern at night and gives the silhouette a hot rim.
  material.colorNode = mix(deep, resolved, 0.34);
  material.emissiveNode = resolved
    .mul(frontVisibility.mul(0.78).add(0.12))
    .add(mix(tint, color(0xffd8a1), 0.24).mul(fresnel.mul(0.9)))
    .mul(energy)
    .mul(pulse)
    .mul(LIGHT_SCALE * 0.76);
  material.roughnessNode = mix(0.2, 0.48, broad);
  material.metalnessNode = float(0.04);
  material.flatShading = true;
  material.fog = false;
  return material;
}
