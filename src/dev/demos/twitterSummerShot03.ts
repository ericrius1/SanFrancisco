import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_03_SECONDS = 7.5;

// East edge of the Presidio eucalyptus stand, aimed west-northwest through its
// warm backlit canopy. The route stays high enough for a clean bird silhouette
// while the trunks below provide slow, compression-friendly parallax.
const PRESIDIO = { x: -2275, z: -640, facing: 1.22 } as const;
const FLIGHT = new THREE.Vector3(
  -Math.sin(PRESIDIO.facing),
  0,
  -Math.cos(PRESIDIO.facing)
).normalize();
const RIGHT = new THREE.Vector3(Math.cos(PRESIDIO.facing), 0, -Math.sin(PRESIDIO.facing));

/** A clean-plate phoenix glide through the Presidio's summer canopy. */
export const twitterSummerShot03: Demo = {
  name: "twitter-summer-03",
  run(ctx) {
    const { map, sky } = ctx;
    if (!map || !sky) {
      console.warn("[demo:twitter-summer-03] map or sky unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    sky.cycleEnabled = false;
    sky.setTimeOfDay(17.62);
    ctx.setExposure(1.1);
    ctx.setPostFx({ sceneSamples: 4, ink: false, dream: false, retro: false });
    ctx.input.suspended = false;

    const drivenKeys = ["KeyW", "KeyA", "KeyD", "Space", "ShiftLeft", "KeyQ", "KeyE"];
    for (const key of drivenKeys) ctx.input.keys.delete(key);

    const ground = map.groundTop(PRESIDIO.x, PRESIDIO.z);
    ctx.chase.yaw = PRESIDIO.facing;
    ctx.chase.pitch = -0.025;
    ctx.player.teleportTo({
      x: PRESIDIO.x,
      y: ground + 33,
      z: PRESIDIO.z,
      facing: PRESIDIO.facing,
      mode: "bird"
    });

    const focus = ctx.player.renderPosition.clone().add(new THREE.Vector3(0, 0.65, 0));
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();

    armCinematic(ctx, {
      name: "twitter-summer-03",
      duration: TWITTER_SUMMER_SHOT_03_SECONDS,
      shots: [
        {
          id: "presidio-phoenix-glide",
          start: 0,
          end: TWITTER_SUMMER_SHOT_03_SECONDS,
          safety: { floorClearance: 1.2 },
          camera: (sample, out) => {
            const drift = easeInOutCubic(sample.u);
            const featherIris = smoothstep(
              THREE.MathUtils.clamp((sample.localTime - 5.15) / 2.35, 0, 1)
            );

            // First arc sideways across the trunks, then settle directly behind
            // the phoenix. The final push lets the feather fan own the frame so
            // the sequence editor can grow its silhouette into the next shot.
            const distance = mix(mix(24, 13.5, drift), 3.45, featherIris);
            const side = mix(mix(-6.5, 2.4, drift), 0.15, featherIris);
            const height = mix(mix(9.2, 4.1, drift), 1.25, featherIris);
            const lead = mix(mix(6.2, 3.1, drift), 0.75, featherIris);

            eye.copy(focus)
              .addScaledVector(FLIGHT, -distance)
              .addScaledVector(RIGHT, side);
            eye.y += height;
            target.copy(focus).addScaledVector(FLIGHT, lead);
            target.y += mix(0.3, -0.05, featherIris);

            const focalLength = mix(mix(34, 47, drift), 68, featherIris);
            const roll = Math.sin(sample.u * Math.PI) * 0.014 * (1 - featherIris);
            setPose(out, eye, target, focalLength, roll);
          }
        }
      ],
      frame: (time) => {
        for (const key of drivenKeys) ctx.input.keys.delete(key);

        // Keep the actual playable phoenix in a broad powered glide. Brief,
        // separated flap windows reveal the feather layers without a dense,
        // noisy motion field that would disintegrate under social transcodes.
        ctx.input.keys.add("KeyW");
        if (time < 1.15 || time > 5.8) ctx.input.keys.add("Space");
        if (time > 2.25 && time < 3.05) ctx.input.keys.add("KeyA");

        focus.copy(ctx.player.renderPosition);
        focus.y += 0.65;
      }
    });
  }
};
