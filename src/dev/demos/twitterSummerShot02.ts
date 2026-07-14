import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { normalizeScooterConfig } from "../../vehicles/scooter";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_02_SECONDS = 7.5;

/**
 * Golden Gate summer ribbon: real scooter physics, restrained color detail and
 * two long camera moves. The outside-cable finish leaves bold vertical slices
 * in frame for the production transition without adding capture-only graphics.
 */
export const twitterSummerShot02: Demo = {
  name: "twitter-summer-02",
  run(ctx) {
    const { map, sky } = ctx;
    if (!map || !sky) {
      console.warn("[demo:twitter-summer-02] map or sky unavailable");
      return;
    }

    const bridge = map.meta.bridges.find((candidate) => candidate.name === "Golden Gate Bridge");
    if (!bridge || bridge.towers.length < 2) {
      console.warn("[demo:twitter-summer-02] Golden Gate Bridge metadata unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    sky.cycleEnabled = false;
    sky.setTimeOfDay(16.35);
    ctx.setExposure(1.08);
    ctx.setPostFx({ ink: false, dream: false, retro: false });
    ctx.input.suspended = false;

    // The broad, opaque buttercup/cream blocks stay legible after a social
    // transcode; the open screen also preserves a clean rider silhouette.
    ctx.player.setScooterConfig(normalizeScooterConfig({
      body: "sport",
      seat: "bench",
      screen: "none",
      cargo: "rack",
      paint: 2,
      trim: 2,
      upholstery: 5,
      whitewalls: true
    }));

    const [southX, southZ] = bridge.towers[0];
    const [northX, northZ] = bridge.towers[1];
    const forward = new THREE.Vector3(northX - southX, 0, northZ - southZ).normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const start = new THREE.Vector3(
      mix(southX, northX, 0.52),
      0,
      mix(southZ, northZ, 0.52)
    );
    start.y = map.bridgeDeck(start.x, start.z);
    const facing = Math.atan2(-forward.x, -forward.z);
    ctx.player.teleportTo({ x: start.x, y: start.y, z: start.z, facing, mode: "scooter" });

    const drivenKeys = ["KeyW", "KeyA", "KeyD", "ShiftLeft", "Space"] as const;
    for (const key of drivenKeys) ctx.input.keys.delete(key);

    const focus = new THREE.Vector3();
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const liveFocus = () => {
      focus.copy(ctx.player.renderPosition);
      focus.y += 0.72;
      return focus;
    };

    armCinematic(ctx, {
      name: "twitter-summer-02",
      duration: TWITTER_SUMMER_SHOT_02_SECONDS,
      shots: [
        {
          id: "suspension-ribbon-chase",
          start: 0,
          end: 4.35,
          safety: { floorClearance: 0.9 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);
            liveFocus();
            eye.copy(focus)
              .addScaledVector(forward, mix(-18.5, -11.5, u))
              .addScaledVector(right, mix(-7.8, 5.4, u));
            eye.y += mix(8.8, 5.2, u);
            target.copy(focus)
              .addScaledVector(forward, mix(12, 22, u))
              .addScaledVector(right, mix(0.8, -0.3, u));
            target.y += mix(1.4, 0.4, u);
            setPose(out, eye, target, mix(31, 44, u), mix(-0.012, 0.014, u));
          }
        },
        {
          id: "cable-parallax-slice",
          start: 4.35,
          end: TWITTER_SUMMER_SHOT_02_SECONDS,
          safety: { floorClearance: 1 },
          camera: (sample, out) => {
            const u = smoothstep(sample.u);
            liveFocus();
            // Ride just outside the west suspension line. Repeating suspenders
            // pass between lens and scooter as stable, high-contrast geometry.
            eye.copy(focus)
              .addScaledVector(right, mix(16.8, 18.4, u))
              .addScaledVector(forward, mix(-9.5, 8.5, u));
            eye.y += mix(9.8, 4.4, u);
            target.copy(focus)
              .addScaledVector(forward, mix(4.5, 8.5, u))
              .addScaledVector(right, -0.7);
            target.y += mix(1.6, 0.15, u);
            setPose(out, eye, target, mix(48, 62, u), mix(0.01, -0.008, u));
          }
        }
      ],
      frame: (time) => {
        for (const key of drivenKeys) ctx.input.keys.delete(key);
        ctx.input.keys.add("KeyW");
        if (time >= 0.8) ctx.input.keys.add("ShiftLeft");
        // One shallow lane-settle creates readable rider lean without turning
        // the repeating cables into noisy, erratic motion.
        if (time >= 2.25 && time < 2.8) ctx.input.keys.add("KeyA");
        if (time >= 2.8 && time < 3.18) ctx.input.keys.add("KeyD");
      }
    });
  }
};
