import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { OCEAN_BEACH_SURF } from "../../world/oceanBeachWaves";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_01_SECONDS = 7.5;

const DRIVEN_KEYS = ["KeyW", "KeyA", "KeyD", "ShiftLeft", "Space"] as const;

/**
 * Ocean Beach at summer sunrise: a broad drop-in reveal becomes a close,
 * waterline rail track. The real surf controller and authored breaking-wave
 * field stay live; only the tiny crest-spray points are hidden so a social
 * transcode sees coherent foam masses instead of hundreds of isolated pixels.
 */
export const twitterSummerShot01: Demo = {
  name: "twitter-summer-01",
  run(ctx) {
    const { map, sky } = ctx;
    if (!map || !sky) {
      console.warn("[demo:twitter-summer-01] map or sky unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    const style = document.createElement("style");
    style.dataset.twitterSummerShot01 = "true";
    style.textContent = "body.reel-capture .surf-hud{display:none!important}";
    document.head.appendChild(style);

    sky.cycleEnabled = false;
    sky.setTimeOfDay(6.72);
    ctx.setExposure(1.16);
    ctx.setPostFx({ sceneSamples: 4, ink: false, dream: false, retro: false });
    ctx.input.suspended = false;
    for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

    // Spawn just outside the authored break: SurfController routes the player
    // to its live, time-correct lineup instead of guessing a crest position.
    ctx.player.teleportTo({
      x: OCEAN_BEACH_SURF.maxX + 12,
      y: 0,
      z: OCEAN_BEACH_SURF.entryZ,
      facing: Math.PI / 2,
      mode: "surf"
    });

    // The shader's broad whitewater remains; removing the independent point
    // spray is a capture-specific compression decision, not a gameplay change.
    ctx.scene.getObjectByName("ocean_beach_breaking_waves")?.traverse((object) => {
      if (object instanceof THREE.Points) object.visible = false;
    });

    const focus = ctx.player.renderPosition.clone().add(new THREE.Vector3(0, 0.82, 0));
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const offset = new THREE.Vector3();

    armCinematic(ctx, {
      name: "twitter-summer-01",
      duration: TWITTER_SUMMER_SHOT_01_SECONDS,
      shots: [
        {
          id: "sunrise-drop-in",
          start: 0,
          end: 3.7,
          safety: { floorClearance: 1 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);
            offset.set(mix(-46, -24, u), mix(17, 7.8, u), mix(35, 21, u));
            eye.copy(focus).add(offset);
            target.copy(focus);
            target.x += mix(2.5, 1, u);
            target.y += mix(0.3, 0.08, u);
            target.z -= mix(8, 5, u);
            setPose(out, eye, target, mix(39, 55, u), mix(-0.018, 0.012, u));
          }
        },
        {
          id: "emerald-rail-track",
          start: 3.7,
          end: TWITTER_SUMMER_SHOT_01_SECONDS,
          safety: { floorClearance: 0.8 },
          camera: (sample, out) => {
            const u = smoothstep(sample.u);
            // Stay just offshore of the green wall, easing from a trailing
            // three-quarter into a close side profile without crossing it.
            offset.set(mix(-12, -8, u), mix(4.6, 3.1, u), mix(14, -3.5, u));
            eye.copy(focus).add(offset);
            target.copy(focus);
            target.x += 0.8;
            target.y += 0.12;
            target.z -= mix(4.2, 6.5, u);
            setPose(out, eye, target, mix(61, 50, u), mix(0.008, -0.014, u));
          }
        }
      ],
      frame: (time) => {
        for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

        // A clean drop-in, one climb toward the luminous lip, then a lower
        // shoulder line. No aerial: coherent water movement survives X better
        // than a frame full of short-lived splash sprites.
        ctx.input.keys.add("KeyW");
        if (time > 0.9 && time < 2.45) ctx.input.keys.add("KeyD");
        if (time >= 2.45 && time < 4.35) ctx.input.keys.add("KeyA");
        if (time > 4.5) ctx.input.keys.add("ShiftLeft");

        focus.copy(ctx.player.renderPosition);
        focus.y += 0.82;
      }
    });
  }
};
