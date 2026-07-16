import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose } from "../../cinematic";
import { PALACE_FINE_ARTS } from "../../world/heightmap";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const PHOENIX_PALACE_FLYBY_SECONDS = 5;

const SUNSET_HOUR = 19.72;
const FACING = Math.PI * 0.5;
const DRIVEN_KEYS = ["KeyW", "KeyA", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "Space"] as const;

/**
 * Five-second phoenix proof shot: a real BirdController flight crosses the
 * Palace of Fine Arts, performs one axial roll, then streams out into sunset.
 * The camera stays on the trailing quarter so the Palace, forward body line,
 * feather transmission, tail flow, and twirl axis remain readable together.
 */
export const phoenixPalaceFlyby: Demo = {
  name: "phoenix-palace-flyby",
  run(ctx) {
    const { map, sky } = ctx;
    if (!map || !sky) {
      console.warn("[demo:phoenix-palace-flyby] map or sky unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    sky.cycleEnabled = false;
    sky.setTimeOfDay(SUNSET_HOUR);
    ctx.setExposure(0.92);
    ctx.setPostFx({ ink: false, dream: false, retro: false });
    ctx.input.suspended = false;
    for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

    const ground = map.groundTop(PALACE_FINE_ARTS.x, PALACE_FINE_ARTS.z);
    const direction = new THREE.Vector3(-Math.sin(FACING), 0, -Math.cos(FACING)).normalize();
    const side = new THREE.Vector3(direction.z, 0, -direction.x);
    const palaceCrown = new THREE.Vector3(PALACE_FINE_ARTS.x, ground + 18, PALACE_FINE_ARTS.z);
    const start = new THREE.Vector3(
      PALACE_FINE_ARTS.x - direction.x * 62,
      ground + 50,
      PALACE_FINE_ARTS.z + 7
    );

    ctx.chase.yaw = FACING;
    ctx.chase.pitch = -0.035;
    ctx.player.teleportTo({ x: start.x, y: start.y, z: start.z, facing: FACING, mode: "bird" });

    const focus = start.clone();
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();

    armCinematic(ctx, {
      name: "phoenix-palace-flyby",
      duration: PHOENIX_PALACE_FLYBY_SECONDS,
      shots: [{
        id: "sunset-palace-pass",
        start: 0,
        end: PHOENIX_PALACE_FLYBY_SECONDS,
        safety: { floorClearance: 2 },
        camera: (sample, out) => {
          const u = easeInOutCubic(sample.u);
          // Fly a low trailing-quarter camera with the phoenix. The lens stays
          // close enough to resolve feather flex and warm transmission while
          // looking through the bird toward the Palace and sunset; a gentle
          // pull-out on the final second gives the accelerated exit room.
          eye.copy(focus)
            .addScaledVector(direction, -mix(21, 27, u))
            .addScaledVector(side, mix(19, 23, u))
            .addScaledVector(THREE.Object3D.DEFAULT_UP, mix(-6, -3.5, u));
          target.copy(focus)
            .addScaledVector(direction, mix(3.5, 6.5, u))
            .addScaledVector(THREE.Object3D.DEFAULT_UP, mix(0.2, -0.5, u));
          // Keep a trace of the rotunda in the targeting solution so the
          // landmark crosses behind the hero rather than falling out of frame.
          target.lerp(palaceCrown, Math.sin(u * Math.PI) * 0.08);
          setPose(out, eye, target, mix(41, 48, u), Math.sin(u * Math.PI) * -0.008);
        }
      }],
      frame: (time) => {
        for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);
        ctx.chase.yaw = FACING;
        ctx.chase.pitch = time < 3.7 ? -0.018 : -0.006;
        ctx.input.keys.add("KeyW");
        if (time < 0.32) ctx.input.keys.add("Space");
        if (time >= 2.15 && time < 3.15) ctx.input.keys.add("KeyE");
        if (time >= 3.65) ctx.input.keys.add("ShiftLeft");
        focus.copy(ctx.player.renderPosition);
        focus.y += 0.8;
      }
    });
  }
};
