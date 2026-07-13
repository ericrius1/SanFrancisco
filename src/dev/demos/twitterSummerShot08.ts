import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_08_SECONDS = 7.5;

// This is the centre of a real 108 m citygen roof near the downtown spawn.
// It sits between Transamerica and Salesforce Tower, giving the lift a clear
// architectural reveal without inventing a rooftop platform for the camera.
const ROOFTOP = { x: 3954.2, z: 204.6, top: 114.5 } as const;
const TRANSAMERICA = new THREE.Vector3(3680, 174, 32);
const SALESFORCE = new THREE.Vector3(4117, 286, 33);
const SKYLINE_MIDPOINT = new THREE.Vector3(3894, 142, 22);
const DRONE_FACING = Math.PI;
const DRIVEN_KEYS = ["KeyW", "KeyA", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "Space"] as const;

/** Downtown blue-hour finale: an intimate roof launch opens into the whole skyline. */
export const twitterSummerShot08: Demo = {
  name: "twitter-summer-08",
  run(ctx) {
    const { map, sky, fireworks } = ctx;
    if (!map || !sky) {
      console.warn("[demo:twitter-summer-08] map or sky unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    sky.cycleEnabled = false;
    sky.setTimeOfDay(21.15);
    ctx.setExposure(1.19);
    ctx.setPostFx({ sceneSamples: 4, ink: false, dream: false, retro: false });
    ctx.input.suspended = false;
    for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

    ctx.chase.yaw = DRONE_FACING;
    ctx.chase.pitch = -0.035;
    ctx.player.teleportTo({
      x: ROOFTOP.x,
      y: ROOFTOP.top + 1.45,
      z: ROOFTOP.z,
      facing: DRONE_FACING,
      mode: "drone"
    });

    // Two broad, coherent blooms supply a little celebratory motion without
    // filling the frame with the high-frequency noise that social encoders
    // punish. The real Fireworks system owns their flight and illumination.
    if (fireworks) {
      fireworks.params.sparks = 28;
      fireworks.params.trail = 10;
      fireworks.params.crackle = 0;
      fireworks.params.intensity = 1.28;
    }
    const launchFirework = (
      origin: THREE.Vector3,
      apex: THREE.Vector3,
      palette: number,
      size: number
    ) => {
      fireworks?.launchRemote([[
        origin.x, origin.y, origin.z,
        apex.x, apex.y, apex.z,
        1.15, palette, size
      ]]);
    };

    const focus = new THREE.Vector3(ROOFTOP.x, ROOFTOP.top + 1.65, ROOFTOP.z);
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const skylineTarget = new THREE.Vector3();
    const droneOffset = new THREE.Vector3();

    armCinematic(ctx, {
      name: "twitter-summer-08",
      duration: TWITTER_SUMMER_SHOT_08_SECONDS,
      shots: [
        {
          id: "rooftop-rotor-lift",
          start: 0,
          end: 2.85,
          safety: { floorClearance: 1 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);

            // Begin at roof-fixture height with broad wall and sky shapes behind
            // the drone. The lens rises just enough to reveal the distant crown
            // while the real controller provides rotor tilt and vertical motion.
            eye.set(
              mix(3949.15, 3946.4, u),
              mix(ROOFTOP.top + 2.15, ROOFTOP.top + 7.8, u),
              mix(210.2, 214.8, u)
            );
            target.copy(focus);
            target.y += mix(-0.18, 1.05, u);
            target.x = mix(target.x, SALESFORCE.x, u * 0.13);
            setPose(out, eye, target, mix(61, 48, u), mix(-0.018, 0.012, u));
          }
        },
        {
          id: "downtown-skyline-resolve",
          start: 2.85,
          end: TWITTER_SUMMER_SHOT_08_SECONDS,
          safety: { floorClearance: 1.25 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);
            const resolve = smoothstep(
              THREE.MathUtils.clamp((sample.localTime - 2.35) / 1.9, 0, 1)
            );

            // Pull south and crane above the roofscape in one clean arc. Early
            // frames retain the launched drone as the subject; the final third
            // resolves on the stable Transamerica/Salesforce pairing, leaving a
            // calm, readable wide for the end of the assembled film.
            eye.set(
              mix(3946.4, 3992, u),
              mix(ROOFTOP.top + 7.8, 184, u),
              mix(214.8, 432, u)
            );
            droneOffset.copy(focus);
            droneOffset.y += mix(0.8, 2.8, u);
            skylineTarget.copy(SKYLINE_MIDPOINT);
            skylineTarget.y = mix(134, 151, u);
            target.lerpVectors(droneOffset, skylineTarget, resolve);

            // A restrained tightening makes both landmark silhouettes legible
            // at 1080p without turning their illuminated windows into shimmer.
            setPose(out, eye, target, mix(48, 37, resolve), mix(0.012, -0.006, u));
          }
        }
      ],
      cues: [
        {
          id: "west-skyline-bloom",
          at: 3.55,
          run: () => launchFirework(
            new THREE.Vector3(3745, 10, 8),
            TRANSAMERICA.clone().add(new THREE.Vector3(78, 42, -12)),
            4,
            1.05
          )
        },
        {
          id: "east-skyline-bloom",
          at: 4.55,
          run: () => launchFirework(
            new THREE.Vector3(4200, 8, -25),
            SALESFORCE.clone().add(new THREE.Vector3(45, -38, -8)),
            1,
            1.1
          )
        }
      ],
      frame: (time) => {
        for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

        focus.copy(ctx.player.renderPosition);
        focus.y += 0.2;
        ctx.chase.yaw = DRONE_FACING;

        // Lift slowly enough to read the roof edge, then commit to one smooth
        // northbound departure. No lateral twitching or repeated boost pulses:
        // the silhouette stays stable while the skyline supplies parallax.
        if (time < 3.05) ctx.input.keys.add("Space");
        if (time >= 1.35) ctx.input.keys.add("KeyW");
        if (time >= 2.55 && time < 6.45) ctx.input.keys.add("ShiftLeft");
        if (time >= 6.1) ctx.input.keys.add("Space");
      }
    });
  }
};
