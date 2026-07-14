import * as THREE from "three/webgpu";
import {
  cameraPosition,
  float,
  materialOpacity,
  mix,
  modelWorldMatrix,
  positionWorld,
  smoothstep,
  uniform,
  vertexStage
} from "three/tsl";
import type { WorldMap } from "../../world/heightmap";

type N = any;

/**
 * Palace surface-bound sprite quality.
 *
 * The feather is analytic: no scene-depth texture or extra pass. It is fully
 * active for close hero framing and fades back to the original sprite outside
 * the range where the surface intersection is readable.
 */
export const SURFACE_SOFT_SPRITE = Object.freeze({
  heroFullDistance: 70,
  heroEndDistance: 120,
  renderOrder: 12
});

export type SurfaceSoftSpriteMaterial = {
  material: THREE.SpriteNodeMaterial;
  /** Mutable uniform value; pooled particles can retarget it on spawn. */
  surfacePlane: THREE.Vector4;
};

type SurfaceSoftSpriteOptions = {
  map: THREE.Texture;
  surfacePlane: THREE.Vector4;
  feather: number;
  color?: THREE.ColorRepresentation;
  opacity?: number;
  blending?: THREE.Blending;
  rotation?: number;
};

/** Horizontal plane in Hessian form: dot(worldPosition, xyz) + w = 0. */
export function horizontalSurfacePlane(y: number): THREE.Vector4 {
  return new THREE.Vector4(0, 1, 0, -y);
}

/**
 * One-time terrain tangent plane for a small ground-bound effect. Four height
 * samples capture local slope without asking every sprite pixel to sample the
 * city height texture.
 */
export function terrainSurfacePlane(
  map: Pick<WorldMap, "groundTop">,
  x: number,
  z: number,
  sampleRadius = 0.75
): THREE.Vector4 {
  const r = Math.max(0.05, sampleRadius);
  const y = map.groundTop(x, z);
  const dx = (map.groundTop(x + r, z) - map.groundTop(x - r, z)) / (2 * r);
  const dz = (map.groundTop(x, z + r) - map.groundTop(x, z - r)) / (2 * r);
  const normal = new THREE.Vector3(-dx, 1, -dz).normalize();
  return new THREE.Vector4(
    normal.x,
    normal.y,
    normal.z,
    -normal.dot(new THREE.Vector3(x, y, z))
  );
}

/**
 * Softens the visible side of a billboard before ordinary depth testing clips
 * its buried half. Far away the node resolves to the material's original
 * opacity, so only close hero particles receive the feathered presentation.
 */
export function createSurfaceSoftSpriteMaterial(
  options: SurfaceSoftSpriteOptions
): SurfaceSoftSpriteMaterial {
  const surfacePlane = options.surfacePlane.clone();
  const plane = uniform(surfacePlane) as N;
  const feather = float(Math.max(0.01, options.feather));
  // Object distance is constant across a billboard. Evaluate it on the four
  // vertices instead of repeating a square root for every covered pixel.
  const distance = vertexStage(
    cameraPosition.sub((modelWorldMatrix as N)[3].xyz).length()
  ) as N;
  const heroWeight = smoothstep(
    float(SURFACE_SOFT_SPRITE.heroFullDistance),
    float(SURFACE_SOFT_SPRITE.heroEndDistance),
    distance
  ).oneMinus();
  const surfaceDistance = (positionWorld as N).dot(plane.xyz).add(plane.w);
  const surfaceFade = smoothstep(float(0), feather, surfaceDistance);

  const material = new THREE.SpriteNodeMaterial({
    map: options.map,
    color: options.color ?? 0xffffff,
    transparent: true,
    depthWrite: false,
    blending: options.blending ?? THREE.NormalBlending,
    opacity: options.opacity ?? 1,
    rotation: options.rotation ?? 0
  });
  material.name = "palace-surface-soft-sprite";
  material.opacityNode = materialOpacity.mul(mix(float(1), surfaceFade, heroWeight));

  return { material, surfacePlane };
}
