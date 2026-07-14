import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { PALACE_FINE_ARTS } from "../../world/heightmap";
import { sanFranciscoCivilNow, solarPosition } from "../../world/solar";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_04_SECONDS = 7.5;

const SUMMER_HOUR = 18.35;
const DRIVEN_KEYS = ["KeyW", "KeyA", "KeyD", "KeyQ", "KeyU", "ShiftLeft", "Space"] as const;

/**
 * Palace summer aureole: a real drone glides over the lagoon while a low lens
 * reveals the colonnade, then the camera rises into a broad rotunda orbit and
 * finishes directly on the astronomical sun for the sequence's flare burn.
 */
export const twitterSummerShot04: Demo = {
  name: "twitter-summer-04",
  run(ctx) {
    const { map, sky } = ctx;
    if (!map || !sky) {
      console.warn("[demo:twitter-summer-04] map or sky unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    sky.cycleEnabled = false;
    sky.setTimeOfDay(SUMMER_HOUR);
    ctx.setExposure(1.04);
    ctx.setPostFx({ ink: false, dream: false, retro: false });
    ctx.input.suspended = false;
    for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

    const palaceGround = map.groundTop(PALACE_FINE_ARTS.x, PALACE_FINE_ARTS.z);
    const palaceCrown = new THREE.Vector3(
      PALACE_FINE_ARTS.x,
      palaceGround + 18,
      PALACE_FINE_ARTS.z
    );

    // Match the sky's real-date solar solver. The final view vector therefore
    // lands on the rendered sun rather than approximating a generic westward
    // sunset, and remains deterministic for every frame within one capture.
    const civil = sanFranciscoCivilNow();
    const solar = solarPosition({ ...civil, hour: SUMMER_HOUR });
    const sunDirection = new THREE.Vector3(solar.x, solar.y, solar.z).normalize();
    const sunHorizontal = new THREE.Vector2(sunDirection.x, sunDirection.z).normalize();
    const sunOrbitAzimuth = Math.atan2(-sunHorizontal.x, -sunHorizontal.y);

    // Cross the open lagoon on the true drone controller. A slight climb keeps
    // the silhouette clean against stone and water while the eased controller
    // supplies believable rotor tilt without scripted mesh animation.
    const droneFacing = 0.55;
    ctx.chase.yaw = droneFacing;
    ctx.chase.pitch = -0.045;
    ctx.player.teleportTo({
      x: -270,
      y: palaceGround + 15,
      z: -1340,
      facing: droneFacing,
      mode: "drone"
    });

    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const architecturalTarget = new THREE.Vector3();
    const sunTarget = new THREE.Vector3();

    armCinematic(ctx, {
      name: "twitter-summer-04",
      duration: TWITTER_SUMMER_SHOT_04_SECONDS,
      shots: [
        {
          id: "lagoon-column-sweep",
          start: 0,
          end: 3.45,
          safety: { floorClearance: 1 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);

            // A restrained low dolly lets the lagoon read as one broad plane;
            // the open column bays and moving drone provide measured parallax.
            eye.set(
              mix(-238, -282, u),
              palaceGround + mix(10.5, 15.2, u),
              mix(-1318, -1368, u)
            );
            target.set(
              mix(-356, -389, u),
              palaceGround + mix(12.5, 18, u),
              mix(-1392, -1424, u)
            );
            setPose(out, eye, target, mix(43, 52, u), mix(-0.012, 0.008, u));
          }
        },
        {
          id: "rotunda-sun-orbit",
          start: 3.45,
          end: TWITTER_SUMMER_SHOT_04_SECONDS,
          safety: { floorClearance: 1.2 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);
            const flare = smoothstep(
              THREE.MathUtils.clamp((sample.localTime - 3.12) / 0.93, 0, 1)
            );
            const azimuth = mix(0.57, sunOrbitAzimuth, u);
            const radius = mix(98, 91, u);

            eye.set(
              palaceCrown.x + Math.sin(azimuth) * radius,
              palaceGround + mix(37, 43, u),
              palaceCrown.z + Math.cos(azimuth) * radius
            );
            architecturalTarget.copy(palaceCrown);
            architecturalTarget.y += mix(-1.5, 1.5, u);
            sunTarget.copy(eye).addScaledVector(sunDirection, 220);
            target.lerpVectors(architecturalTarget, sunTarget, flare);

            // The final tightening fills the frame with a simple warm gradient
            // and sun disc: an intentionally robust source for X's transcode and
            // a natural luminance matte for the editor's flare-burn transition.
            setPose(out, eye, target, mix(34, 48, u), mix(0.01, -0.006, u) * (1 - flare));
          }
        }
      ],
      frame: (time) => {
        for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

        ctx.chase.yaw = droneFacing;
        ctx.chase.pitch = time < 4.9 ? -0.045 : -0.015;
        if (time < 3.65) {
          ctx.input.keys.add("KeyW");
          if (time > 0.7 && time < 1.95) ctx.input.keys.add("ShiftLeft");
        } else {
          ctx.input.keys.add("Space");
        }
      }
    });
  }
};
