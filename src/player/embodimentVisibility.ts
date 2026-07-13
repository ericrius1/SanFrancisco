import type { Object3D } from "three/webgpu";

/**
 * Show or hide a complete player/vehicle embodiment without touching the
 * visibility owned by its children. Character rigs use child visibility for
 * mutually exclusive hair, hat, and outfit variants; recursively rewriting it
 * makes every variant render at once and creates coplanar depth fighting.
 */
export function setEmbodimentVisible(root: Object3D, visible: boolean) {
  // Retain the state for async model builders and diagnostics.
  root.userData.embodimentVisible = visible;
  root.visible = visible;
}
