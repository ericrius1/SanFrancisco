import * as THREE from "three/webgpu";
import {
  positionWorld,
  cameraPosition,
  color,
  float,
  mix,
  smoothstep,
  clamp,
  vec3,
  mx_noise_float,
  mx_fractal_noise_float,
  attribute
} from "three/tsl";
import { bumpNormal } from "./tslUtil";

/**
 * Street asphalt in the spirit of the reference city generator's road material:
 * warm-grey patchwork pours, oily wear stains, low-frequency wet patches that go
 * glossy and mirror the sky, and fine aggregate grit that only resolves near the
 * camera. Painted lane markings are rendered as an OSM-derived overlay so they
 * can follow curved ribbons and one-way/two-way metadata instead of a grid.
 */
export function createRoadMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;

  const dist = p.distance(cameraPosition);
  const detail = smoothstep(240, 25, dist);
  const microFade = smoothstep(22, 4, dist);

  const blotch = mx_fractal_noise_float(p.mul(0.2), 3).mul(0.5).add(0.5);
  const stain = smoothstep(0.5, 0.85, mx_fractal_noise_float(p.mul(0.45), 3).mul(0.5).add(0.5));
  const wet = smoothstep(0.72, 0.92, mx_fractal_noise_float(p.mul(0.09), 2).mul(0.5).add(0.5));
  const grit = mx_noise_float(p.mul(7)).add(mx_noise_float(p.mul(23))).mul(0.5);
  const micro = mx_noise_float(p.mul(45)).mul(0.6).add(mx_noise_float(p.mul(80)).mul(0.4));

  // warm sun-baked greys; the blue sky fill cools them plenty on its own
  const base = mix(color(0x3a3b3e), color(0x55534f), blotch);
  const gritty = base.mul(grit.mul(0.22).mul(detail).add(1));
  const asphalt = mix(gritty, gritty.mul(0.55), stain.mul(0.5).mul(detail));

  mat.colorNode = mix(asphalt, asphalt.mul(0.7), wet);
  // keep it mostly diffuse: at grazing angles a smooth road turns into a sky
  // mirror and the whole street reads blue
  mat.roughnessNode = mix(float(0.96), float(0.62), wet);
  mat.normalNode = bumpNormal(grit.mul(0.003).mul(detail).add(micro.mul(0.0016).mul(microFade)));
  mat.envMapIntensity = 0.12;
  return mat;
}

/** Parks and green areas: soft warm grass with large-scale mow/patch variation. */
export function createParkMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const vColor = attribute("color", "vec3") as unknown as ReturnType<typeof vec3>;
  const p = positionWorld;

  const patch = mx_fractal_noise_float(p.mul(0.06), 3).mul(0.5).add(0.5);
  const tuft = mx_noise_float(p.mul(3.1)).mul(0.5).add(0.5);

  const grassA = color(0x6f9c58);
  const grassB = color(0x8fae62);
  const grass = mix(grassA, grassB, patch).mul(tuft.mul(0.16).add(0.92));

  mat.colorNode = mix(vColor, grass, 0.75);
  mat.roughnessNode = float(1);
  const detail = clamp(float(1).sub(p.distance(cameraPosition).div(400)), 0, 1);
  mat.normalNode = bumpNormal(tuft.mul(0.012).mul(detail));
  mat.envMapIntensity = 0.4;
  return mat;
}
