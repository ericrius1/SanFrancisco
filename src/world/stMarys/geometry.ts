import * as THREE from "three/webgpu";

/**
 * Placement and cupola dimensions, mirrored from the Blender generator
 * (`tools/create-st-marys-site.py`). Both the god-ray layer and the plaza rave
 * derive beam origins and the projection surface from the same saddle ruling
 * the authored GLB was built with, so nothing drifts against the model.
 */
export const CENTER_X = 1642.02;
export const CENTER_Z = 661.16;
export const FLOOR_Y = 61.2;
export const YAW = 0.152;

export const PLAZA_TOP = 1.35;
export const NAVE_FLOOR_Z = 1.5;
export const CUPOLA_HALF = 20.6;
export const SHELL_Z0 = 15.0;
export const SHELL_TOP = 59.4;
export const ARM_TIP_Z = 58.7;
export const ARM_HALF = 8.2;
export const GLASS_HW = 0.92;

export function localToWorld(
  lx: number,
  ly: number,
  lz: number,
  out = new THREE.Vector3()
): THREE.Vector3 {
  const c = Math.cos(YAW);
  const s = Math.sin(YAW);
  return out.set(
    CENTER_X + lx * c - ly * s,
    FLOOR_Y + lz,
    CENTER_Z - lx * s - ly * c
  );
}

export function worldToLocal(position: THREE.Vector3): { x: number; y: number } {
  const dx = position.x - CENTER_X;
  const dz = position.z - CENTER_Z;
  const c = Math.cos(YAW);
  const s = Math.sin(YAW);
  return { x: c * dx - s * dz, y: -s * dx - c * dz };
}
