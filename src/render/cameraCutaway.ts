import * as THREE from "three/webgpu";
import {
  abs,
  dot,
  float,
  mix,
  normalWorldGeometry,
  positionWorld,
  smoothstep,
  uniform,
} from "three/tsl";

// Camera-occlusion cutaway shared by every city-building material. Keeping the
// state in four uniforms means the baked facade, merged CityGen LOD, batched
// shells and instanced windows all cut the exact same world-space corridor with
// no material clones, draw-list edits or GPU readbacks.
const cutCamera = uniform(new THREE.Vector3());
const cutFocus = uniform(new THREE.Vector3());
const cutRadius = uniform(1);
const cutAmount = uniform(0);

// TSL's public node types are intentionally broad and composition-heavy; `any`
// is the established node helper idiom in the rest of this renderer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * 0..1 fragment visibility for a soft, alpha-hashed tunnel between the camera
 * and its subject. Horizontal roofs/floors remain intact: the failure mode is a
 * facade filling the view, while cutting the street/roof under a vehicle would
 * make it look like it was floating.
 */
function cutawayField(world: N) {
  const axis = cutFocus.sub(cutCamera);
  const fromCamera = world.sub(cutCamera);
  const axisLen2 = dot(axis, axis).max(0.0001);
  const alongRaw = dot(fromCamera, axis).div(axisLen2);
  const along = alongRaw.clamp(0, 1);
  const nearest = cutCamera.add(axis.mul(along));
  const radial = world.sub(nearest).length();

  // Slight taper toward the subject preserves the ground immediately under it,
  // while the explicit segment gate prevents walls behind the player vanishing.
  const radius = cutRadius.mul(mix(float(1), float(0.68), along));
  const corridor = smoothstep(radius.mul(0.72), radius, radial);
  const inSegment = smoothstep(-0.02, 0.02, alongRaw).mul(
    smoothstep(1.02, 0.97, alongRaw),
  );
  const verticalSurface = smoothstep(0.78, 0.42, abs(normalWorldGeometry.y));
  const strength = cutAmount.mul(inSegment).mul(verticalSurface);
  return { radial, radius, strength, corridor };
}

export function cameraCutawayVisibility(world: N = positionWorld): N {
  const { strength, corridor } = cutawayField(world);
  return mix(float(1), corridor, strength);
}

/** Hard growing aperture for materials that are otherwise fully opaque. This
 * keeps the vast baked city out of the alpha-hash path when the cutaway is idle. */
export function cameraCutawayMask(world: N = positionWorld): N {
  const { radial, radius, strength } = cutawayField(world);
  return radial.greaterThanEqual(radius.mul(strength));
}

/** Update the shared corridor once after the final chase-camera pose settles. */
export function updateCameraCutaway(
  cameraPosition: THREE.Vector3,
  focus: THREE.Vector3,
  radius: number,
  amount: number,
): void {
  cutCamera.value.copy(cameraPosition);
  cutFocus.value.copy(focus);
  cutRadius.value = Math.max(0.05, radius);
  cutAmount.value = THREE.MathUtils.clamp(amount, 0, 1);
}

/** External camera owners (orbit, cinematics, ball cam) never inherit the cut. */
export function clearCameraCutaway(): void {
  cutAmount.value = 0;
}
