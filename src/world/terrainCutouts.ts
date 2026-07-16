import { float, mix, positionWorld, smoothstep, uniform } from "three/tsl";
import * as THREE from "three/webgpu";

type N = any;

export type TerrainCutoutSpec = {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  yaw: number;
  /** Narrow transition band in metres around the authored ownership boundary. */
  feather?: number;
};

/** Three authored surfaces may overlap one streamed destination tile. */
export const TERRAIN_CUTOUT_CAPACITY = 3;

const cutoutBounds = [
  uniform(new THREE.Vector4(0, 0, 1, 1)),
  uniform(new THREE.Vector4(0, 0, 1, 1)),
  uniform(new THREE.Vector4(0, 0, 1, 1))
] as const;

// xy = cos/sin(yaw), z = enabled, w = feather.
const cutoutFrames = [
  uniform(new THREE.Vector4(1, 0, 0, 0.2)),
  uniform(new THREE.Vector4(1, 0, 0, 0.2)),
  uniform(new THREE.Vector4(1, 0, 0, 0.2))
] as const;

function cutoutVisibility(slot: 0 | 1 | 2): N {
  const bound = cutoutBounds[slot] as N;
  const frame = cutoutFrames[slot] as N;
  const world = positionWorld as N;
  const dx = world.x.sub(bound.x);
  const dz = world.z.sub(bound.y);
  const localX = dx.mul(frame.x).sub(dz.mul(frame.y));
  const localZ = dx.mul(frame.y).add(dz.mul(frame.x));
  const signedOutside = localX.abs().sub(bound.z).max(localZ.abs().sub(bound.w));
  const outside = smoothstep(frame.w.negate(), frame.w, signedOutside);
  return mix(float(1), outside, frame.z);
}

/** Shared fragment mask for the heightfield and generated draped lawn sheets. */
export function terrainCutoutMask(): N {
  return cutoutVisibility(0).mul(cutoutVisibility(1)).mul(cutoutVisibility(2));
}

export function setTerrainCutoutUniforms(cutouts: readonly TerrainCutoutSpec[]): void {
  if (cutouts.length > TERRAIN_CUTOUT_CAPACITY) {
    throw new Error(`terrain cutout capacity ${TERRAIN_CUTOUT_CAPACITY} exceeded`);
  }
  for (let slot = 0; slot < TERRAIN_CUTOUT_CAPACITY; slot++) {
    const cutout = cutouts[slot];
    const bound = cutoutBounds[slot].value;
    const frame = cutoutFrames[slot].value;
    if (!cutout) {
      frame.z = 0;
      continue;
    }
    bound.set(cutout.centerX, cutout.centerZ, cutout.halfX, cutout.halfZ);
    frame.set(
      Math.cos(cutout.yaw),
      Math.sin(cutout.yaw),
      1,
      Math.max(0.02, cutout.feather ?? 0.2)
    );
  }
}
