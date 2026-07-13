import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_05_SECONDS = 7.5;

// Known-good straight on the Embarcadero. The stock car's local -Z nose follows
// this yaw, sending the chase west along a long, building-lined road corridor.
const EMBARCADERO = { x: 4340, z: -380, facing: 1.8 } as const;
const FORWARD = new THREE.Vector3(
  -Math.sin(EMBARCADERO.facing),
  0,
  -Math.cos(EMBARCADERO.facing)
).normalize();
const RIGHT = new THREE.Vector3(FORWARD.z, 0, -FORWARD.x);

/** Warm-waterfront sports-car chase with a compression-friendly speed finish. */
export const twitterSummerShot05: Demo = {
  name: "twitter-summer-05",
  run(ctx) {
    const { map, sky } = ctx;
    if (!map || !sky) {
      console.warn("[demo:twitter-summer-05] map or sky unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    sky.cycleEnabled = false;
    sky.setTimeOfDay(17.15);
    ctx.setExposure(1.08);
    ctx.setPostFx({ sceneSamples: 4, ink: false, dream: false, retro: false });
    ctx.input.suspended = false;

    // Restore the low red roadster even if a prior demo mounted an animal.
    ctx.player.setDriveStyle(null);
    const ground = map.groundTop(EMBARCADERO.x, EMBARCADERO.z);
    ctx.player.teleportTo({
      x: EMBARCADERO.x,
      y: ground,
      z: EMBARCADERO.z,
      facing: EMBARCADERO.facing,
      mode: "drive"
    });

    const drivenKeys = ["KeyW", "KeyA", "KeyD", "ShiftLeft", "Space"] as const;
    for (const key of drivenKeys) ctx.input.keys.delete(key);

    const focus = ctx.player.renderPosition.clone().add(new THREE.Vector3(0, 0.64, 0));
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const liveFocus = () => {
      focus.copy(ctx.player.renderPosition);
      focus.y += 0.64;
      return focus;
    };

    armCinematic(ctx, {
      name: "twitter-summer-05",
      duration: TWITTER_SUMMER_SHOT_05_SECONDS,
      shots: [
        {
          id: "embarcadero-wheel-quarter",
          start: 0,
          end: 3.2,
          safety: { floorClearance: 0.32 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);
            liveFocus();

            // Run beside the front wheel, then arc across the nose. Keeping the
            // camera near the car makes the broad red body panels do the visual
            // work instead of fine particles that collapse under an X encode.
            eye.copy(focus)
              .addScaledVector(FORWARD, mix(3.3, 1.45, u))
              .addScaledVector(RIGHT, mix(-3.35, -2.6, u));
            eye.y += mix(0.58, 1.2, u);
            target.copy(focus)
              .addScaledVector(FORWARD, mix(0.45, 1.8, u))
              .addScaledVector(RIGHT, mix(-0.28, 0.05, u));
            target.y += mix(-0.08, 0.15, u);
            setPose(out, eye, target, mix(62, 52, u), mix(-0.018, 0.012, u));
          }
        },
        {
          id: "embarcadero-speed-vanishing-point",
          start: 3.2,
          end: TWITTER_SUMMER_SHOT_05_SECONDS,
          safety: { floorClearance: 0.75 },
          camera: (sample, out) => {
            const u = smoothstep(sample.u);
            const tunnel = smoothstep(THREE.MathUtils.clamp((sample.localTime - 2.4) / 1.9, 0, 1));
            liveFocus();

            // Peel from a high rear quarter into a dead-centre, low chase. The
            // widening lens and increasingly distant target exaggerate forward
            // flow while converging the stable road/building edges on one point.
            eye.copy(focus)
              .addScaledVector(FORWARD, -mix(11.5, 16.5, u))
              .addScaledVector(RIGHT, mix(5.8, 0.05, tunnel));
            eye.y += mix(6.4, 2.15, u);
            target.copy(focus)
              .addScaledVector(FORWARD, mix(8, 72, tunnel));
            target.y += mix(1.0, 0.42, tunnel);
            setPose(out, eye, target, mix(50, 23, tunnel), mix(0.016, 0, tunnel));
          }
        }
      ],
      frame: (time) => {
        for (const key of drivenKeys) ctx.input.keys.delete(key);
        ctx.input.keys.add("KeyW");
        if (time >= 0.55) ctx.input.keys.add("ShiftLeft");

        // A single broad S-settle shows suspension and driver steering while
        // preserving a predictable, compression-friendly road corridor.
        if (time >= 1.0 && time < 1.58) ctx.input.keys.add("KeyA");
        if (time >= 1.78 && time < 2.25) ctx.input.keys.add("KeyD");

        liveFocus();
      }
    });
  }
};
