import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { WakeRipples } from "../../fx/wake";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_07_SECONDS = 7.5;

const BAY = { x: 5200, z: -650, facing: -2.58 } as const;
const BLUE_HOUR = 20.35;
const REVEAL_AT = 3.35;
const DRIVEN_KEYS = ["KeyW", "KeyA", "KeyD", "ShiftLeft"] as const;

/**
 * Blue-hour coda: a real speedboat and its physics wake skim past the camera,
 * then a high, quiet reveal holds the Bay Bridge while five deliberately small
 * firework populations bloom as large constellation nodes. The sparse, coherent
 * silhouettes are designed to survive X's bitrate-constrained transcode and to
 * hand the editor a clean star-point pattern for the outgoing transition.
 */
export const twitterSummerShot07: Demo = {
  name: "twitter-summer-07",
  run(ctx) {
    const { fireworks, map, sky } = ctx;
    if (!fireworks || !map || !sky) {
      console.warn("[demo:twitter-summer-07] fireworks, map, or sky unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    sky.cycleEnabled = false;
    sky.setTimeOfDay(BLUE_HOUR);
    ctx.setExposure(1.16);
    ctx.setPostFx({ sceneSamples: 4, ink: false, dream: false, retro: false });
    ctx.input.suspended = false;
    for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

    ctx.chase.yaw = BAY.facing;
    ctx.chase.pitch = 0.02;
    ctx.player.teleportTo({ x: BAY.x, y: 0, z: BAY.z, facing: BAY.facing, mode: "speedboat" });

    // The shared boat wake currently listens for the day-sailer mode. Give this
    // cinematic its own instance and feed it the real speedboat's live transform;
    // the wake geometry and water-height solver remain the production systems.
    const cinematicWake = new WakeRipples(ctx.scene);

    // X-friendly fireworks: five readable clusters, not thousands of tiny,
    // independently moving sparks that collapse into macroblocks on upload.
    fireworks.params.sparks = 20;
    fireworks.params.crackle = 0;
    fireworks.params.trail = 4;
    fireworks.params.shells = 1;
    fireworks.params.sparkSize = 2.4;
    fireworks.params.burstSpeed = 8;
    fireworks.params.intensity = 1.45;

    const boatFocus = new THREE.Vector3(BAY.x, 1.05, BAY.z);
    const forward = new THREE.Vector3(0, 0, -1);
    const right = new THREE.Vector3(1, 0, 0);
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const nearEye = new THREE.Vector3();
    const nearTarget = new THREE.Vector3();
    const wideEye = new THREE.Vector3(4978, 63, -838);
    const bridgeTarget = new THREE.Vector3(5515, 78, -385);

    const launchNode = (
      origin: readonly [number, number, number],
      apex: readonly [number, number, number],
      palette: number
    ) => {
      fireworks.launchRemote([[
        origin[0], origin[1], origin[2],
        apex[0], apex[1], apex[2],
        0.78, palette, 2.2
      ]]);
    };

    armCinematic(ctx, {
      name: "twitter-summer-07",
      duration: TWITTER_SUMMER_SHOT_07_SECONDS,
      shots: [
        {
          id: "speedboat-waterline-wake",
          start: 0,
          end: REVEAL_AT,
          safety: { floorClearance: 0.75 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);
            // Stay just above the swell, off the port quarter. The long lens
            // compresses hull and wake at first, then breathes wider as speed rises.
            eye.copy(boatFocus)
              .addScaledVector(forward, mix(-14.5, -19, u))
              .addScaledVector(right, mix(-4.8, -2.2, u));
            eye.y += mix(2.25, 3.25, u);
            target.copy(boatFocus).addScaledVector(forward, mix(1.8, 4.5, u));
            target.y += mix(0.2, 0.55, u);
            setPose(out, eye, target, mix(58, 42, u), mix(-0.012, 0.008, u));
          }
        },
        {
          id: "bay-bridge-constellation-reveal",
          start: REVEAL_AT,
          end: TWITTER_SUMMER_SHOT_07_SECONDS,
          safety: { floorClearance: 1.2 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);
            const settle = smoothstep(Math.min(1, sample.localTime / 2.4));
            nearEye.copy(boatFocus)
              .addScaledVector(forward, -23)
              .addScaledVector(right, 12);
            nearEye.y += 12;
            nearTarget.copy(boatFocus).addScaledVector(forward, 14);
            nearTarget.y += 3;
            eye.lerpVectors(nearEye, wideEye, u);
            target.lerpVectors(nearTarget, bridgeTarget, settle);
            setPose(out, eye, target, mix(45, 29, u), mix(0.014, -0.004, u));
          }
        }
      ],
      cues: [
        // Rising diagonal with an offset centre point: a simple constellation
        // silhouette that the final composite can trace into its next scene.
        { id: "constellation-a", at: 4.92, run: () => launchNode([5352, 1, -424], [5364, 96, -410], 1) },
        { id: "constellation-b", at: 5.14, run: () => launchNode([5415, 1, -383], [5422, 128, -364], 4) },
        { id: "constellation-c", at: 5.36, run: () => launchNode([5480, 1, -338], [5490, 108, -322], 2) },
        { id: "constellation-d", at: 5.58, run: () => launchNode([5542, 1, -294], [5553, 148, -279], 1) },
        { id: "constellation-e", at: 5.8, run: () => launchNode([5608, 1, -249], [5617, 118, -236], 4) }
      ],
      frame: (time, dt) => {
        for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

        // Drive the actual controller so trim, helm pose, spray and audio remain
        // coupled to velocity. One gentle carve shapes the wake without noise.
        ctx.input.keys.add("KeyW");
        ctx.input.keys.add("ShiftLeft");
        if (time > 1.25 && time < 3.8) ctx.input.keys.add("KeyA");

        boatFocus.copy(ctx.player.renderPosition);
        boatFocus.y += 0.65;
        forward.set(0, 0, -1).applyQuaternion(ctx.player.renderQuaternion);
        forward.y = 0;
        if (forward.lengthSq() < 1e-5) forward.set(-Math.sin(BAY.facing), 0, -Math.cos(BAY.facing));
        forward.normalize();
        right.set(-forward.z, 0, forward.x);

        cinematicWake.update(dt, time, {
          mode: "boat",
          renderPosition: ctx.player.renderPosition,
          velocity: ctx.player.velocity,
          speed: ctx.player.speed
        });
      }
    });
  }
};
