import * as THREE from "three/webgpu";
import type { Demo } from "../demo";

/**
 * Static golden-hour review angle for the Palace beauty pass. It deliberately
 * hovers over the lagoon so collision/chase-camera recovery cannot spoil the
 * architectural composition during visual QA or cinematic capture.
 */
export const palaceShowcase: Demo = {
  name: "palace",
  run(ctx) {
    const { camera, sky, hud, minimap } = ctx;
    if (sky) {
      sky.cycleEnabled = false;
      sky.setTimeOfDay(17.3);
    }
    hud?.setHidden(true);
    minimap?.setExpanded(false);
    ctx.setExposure(0.96);

    const eye = new THREE.Vector3(-302, 8.2, -1426);
    const target = new THREE.Vector3(-370, 20, -1405);
    camera.fov = 38;
    camera.updateProjectionMatrix();
    ctx.setCine(() => {
      camera.position.copy(eye);
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
      camera.updateMatrixWorld();
    });
  }
};
