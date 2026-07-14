import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { OCEAN_BEACH_SURF } from "../../world/oceanBeachWaves";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_01_SECONDS = 7.5;

const DRIVEN_KEYS = ["KeyW", "KeyA", "KeyD", "ShiftLeft", "Space"] as const;

/**
 * Ocean Beach at summer sunrise: a broad drop-in reveal becomes an elevated,
 * down-the-line rail track. The real surf controller and authored breaking-wave
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
    ctx.setPostFx({ ink: false, dream: false, retro: false });
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
            // +X is shoreward at Ocean Beach. Stay well east of the rider and
            // look west across them, keeping the crest behind the silhouette.
            offset.set(mix(55, 42, u), mix(24, 20, u), mix(24, 15, u));
            eye.copy(focus).add(offset);
            target.copy(focus);
            target.x -= 1.5;
            target.y += mix(6.2, 5.2, u);
            target.z -= mix(3, 4.5, u);
            setPose(out, eye, target, mix(60, 70, u), mix(-0.008, 0.006, u));
          }
        },
        {
          id: "emerald-rail-track",
          start: 3.7,
          end: TWITTER_SUMMER_SHOT_01_SECONDS,
          safety: { floorClearance: 0.8 },
          camera: (sample, out) => {
            const u = smoothstep(sample.u);
            // Continue shoreward and above the crest, arcing gently down the line.
            // The longer working distance preserves the full rider+board shape
            // and leaves room for horizon, whitewater and sun path around it.
            offset.set(mix(42, 52, u), mix(20, 22, u), mix(18, -8, u));
            eye.copy(focus).add(offset);
            target.copy(focus);
            target.x -= 1.8;
            target.y += mix(5.2, 5.8, u);
            target.z -= mix(4, 5, u);
            setPose(out, eye, target, mix(70, 64, u), mix(0.005, -0.006, u));
          }
        }
      ],
      frame: (time) => {
        for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

        // A straight, pumped line keeps the procedural rider securely seated.
        // No carve, tuck or aerial inputs: the silhouette stays coherent and
        // broad water movement survives X better than splash-heavy tricks.
        ctx.input.keys.add("KeyW");

        focus.copy(ctx.player.renderPosition);
        focus.y += 0.82;
      }
    });
  }
};
