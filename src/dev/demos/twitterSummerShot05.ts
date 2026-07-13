import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_05_SECONDS = 7.5;

// A long mapped Embarcadero road segment, rather than the generic neighborhood
// spawn beside the facade. This heading follows the road southwest; -RIGHT is
// the open waterfront side and +RIGHT is the building line.
const EMBARCADERO = { x: 4383, z: -290.4, facing: Math.PI / 4 } as const;
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
          safety: { floorClearance: 1 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);
            liveFocus();

            // Track from the open-water side, high and far enough back that the
            // full car remains readable. The shallow arc reveals the road and
            // facade as converging layers without ever putting the lens in them.
            eye.copy(focus)
              .addScaledVector(FORWARD, -mix(13.8, 11.2, u))
              .addScaledVector(RIGHT, -mix(10.5, 7.2, u));
            eye.y += mix(5.8, 4.3, u);
            target.copy(focus)
              .addScaledVector(FORWARD, mix(4.5, 8.5, u))
              .addScaledVector(RIGHT, mix(-0.4, 0.15, u));
            target.y += mix(0.35, 0.8, u);
            setPose(out, eye, target, mix(45, 40, u), mix(-0.01, 0.008, u));
          }
        },
        {
          id: "embarcadero-speed-vanishing-point",
          start: 3.2,
          end: TWITTER_SUMMER_SHOT_05_SECONDS,
          safety: { floorClearance: 1 },
          camera: (sample, out) => {
            const u = smoothstep(sample.u);
            const tunnel = smoothstep(THREE.MathUtils.clamp((sample.localTime - 2.4) / 1.9, 0, 1));
            liveFocus();

            // Peel from an elevated open-side rear quarter toward a centred
            // chase, but retain a few metres of waterfront offset as insurance
            // from the facade. A widening lens and distant road target turn the
            // stable street edges into the requested forward vanishing motion.
            eye.copy(focus)
              .addScaledVector(FORWARD, -mix(17.5, 13.2, u))
              .addScaledVector(RIGHT, -mix(10.5, 3.2, tunnel));
            eye.y += mix(8.2, 3.9, u);
            target.copy(focus)
              .addScaledVector(FORWARD, mix(9, 58, tunnel))
              .addScaledVector(RIGHT, -mix(0.8, 0.05, tunnel));
            target.y += mix(1.15, 0.5, tunnel);
            setPose(out, eye, target, mix(46, 29, tunnel), mix(0.012, 0, tunnel));
          }
        }
      ],
      frame: (time) => {
        for (const key of drivenKeys) ctx.input.keys.delete(key);
        ctx.input.keys.add("KeyW");
        if (time >= 0.55) ctx.input.keys.add("ShiftLeft");

        liveFocus();
      }
    });
  }
};
