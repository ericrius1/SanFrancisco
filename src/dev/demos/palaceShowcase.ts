import * as THREE from "three/webgpu";
import type { Demo } from "../demo";
import { cleanPlate, freezeAndBuryPlayer, repin, type CineWindow } from "./shared";

/**
 * Static golden-hour review angle for the Palace beauty pass. It deliberately
 * hovers over the lagoon so collision/chase-camera recovery cannot spoil the
 * architectural composition during visual QA or cinematic capture.
 */
export const palaceShowcase: Demo = {
  name: "palace",
  run(ctx) {
    const { camera, sky, hud, minimap } = ctx;
    cleanPlate(hud);
    if (sky) {
      sky.cycleEnabled = false;
      sky.setTimeOfDay(17.3);
    }
    hud?.setHidden(true);
    minimap?.setExpanded(false);
    ctx.setExposure(0.96);

    // Palace/Sutro static meshes now live in streamed geographic tiles. Keep
    // the hidden demo player at the Palace so the same production shot that
    // reviews the asset also exercises the real tile-streaming path.
    const buried = freezeAndBuryPlayer(ctx, -360, -1426);
    const win = window as CineWindow & {
      __sfCinematicState?: { time: number; shotId: string };
      __sf?: { tiles?: { loaded?: Map<string, { group?: THREE.Object3D }> } };
    };
    win.__cineT = 0;
    win.__sfReelArmed = false;
    win.__sfReelDone = false;
    win.__sfReelStep = (sec: number) => {
      win.__cineT = Math.max(0, sec);
    };
    win.__sfStartShot = () => {
      win.__cineT = 0;
    };

    // Deterministic capture waits on __sfReelArmed. Arm only after the actual
    // streamed tile has attached both authored meshes, so the review shot also
    // proves that landmark packaging/loading is complete.
    const armWhenStreamed = () => {
      const tile = win.__sf?.tiles?.loaded?.get("8_9");
      const root = tile?.group;
      if (root?.getObjectByName("lm_palace_rotunda") && root.getObjectByName("lm_palace_peristyle")) {
        win.__sfReelArmed = true;
        return;
      }
      window.setTimeout(armWhenStreamed, 50);
    };
    armWhenStreamed();

    const eye = new THREE.Vector3(-302, 8.2, -1426);
    const target = new THREE.Vector3(-370, 20, -1405);
    camera.fov = 38;
    camera.updateProjectionMatrix();
    ctx.setCine(() => {
      repin(buried, ctx);
      win.__sfCinematicState = { time: win.__cineT ?? 0, shotId: "palace-static" };
      camera.position.copy(eye);
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
      camera.updateMatrixWorld();
    });
  }
};
