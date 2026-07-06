import * as THREE from "three/webgpu";

/**
 * Minimal stub so the build resolves — HorseHerd imports and drives this. A
 * richer training-guide UI is being authored in parallel; this satisfies the
 * used interface (constructor + update) meanwhile and does nothing visible.
 */
export class HorseTrainingGuide {
  constructor(_pos: THREE.Vector3, _onToggle?: (on: boolean) => void) {}
  update(_camera: THREE.Camera, _camPos: THREE.Vector3): void {}
  setTraining(_on: boolean): void {}
}
