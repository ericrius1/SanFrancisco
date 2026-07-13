import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { normalizeBoardConfig } from "../../vehicles/board";
import { collectGardenFlora } from "../../world/garden/layout";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const TWITTER_SUMMER_SHOT_06_SECONDS = 7.5;

// The east promenade is an authored, collider-clear walk into the Great
// Meadow. Riding its centre line lets the real board controller supply motion
// while flower beds remain close enough for the opening foreground layer.
const PROMENADE_START = new THREE.Vector3(-2089.5, 0, 2370.5);
const PROMENADE_END = new THREE.Vector3(-2130, 0, 2420);
const FORWARD = PROMENADE_END.clone().sub(PROMENADE_START).setY(0).normalize();
const RIGHT = new THREE.Vector3(FORWARD.z, 0, -FORWARD.x);
const FACING = Math.atan2(-FORWARD.x, -FORWARD.z);
const DRIVEN_KEYS = ["KeyW", "KeyA", "KeyD", "ShiftLeft", "Space"] as const;

/** Botanical Garden board study: flower-level macro into a summer promenade sweep. */
export const twitterSummerShot06: Demo = {
  name: "twitter-summer-06",
  run(ctx) {
    const { map, sky, setBoardConfig } = ctx;
    if (!map || !sky || !setBoardConfig) {
      console.warn("[demo:twitter-summer-06] map, sky, or board-config service unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    sky.cycleEnabled = false;
    sky.setTimeOfDay(17.82);
    ctx.setExposure(1.1);
    ctx.setPostFx({ sceneSamples: 4, ink: false, dream: false, retro: false });
    ctx.input.suspended = false;
    for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

    const ground = map.groundTop(PROMENADE_START.x, PROMENADE_START.z);
    ctx.player.teleportTo({
      x: PROMENADE_START.x,
      y: ground,
      z: PROMENADE_START.z,
      facing: FACING,
      mode: "board"
    });

    // Broad, warm color fields and slow surface motion hold together through a
    // social transcode. The real plume remains visible, but isolated spark
    // motes and high-frequency shimmer are deliberately absent.
    setBoardConfig(normalizeBoardConfig({
      shape: "manta",
      fin: "halo",
      deck: 6,
      trim: 2,
      glow: 4,
      deckHex: 0xee7897,
      trimHex: 0x315b48,
      glowHex: 0xffcf79,
      surface: "aurora",
      surfaceScale: 30,
      surfaceWarp: 24,
      surfaceSeed: 52817,
      surfaceFlow: 8,
      surfaceFx: 34,
      surfaceFxKind: "vortex",
      plumeReach: 38,
      plumeShimmer: 8,
      plumeSparks: false,
      plumeGlow: 4,
      plumeHex: 0xffbd6d,
      hum: "crystal",
      pitch: 1,
      soundTone: 58,
      soundMotion: 18,
      soundThrust: 44,
      soundAir: 14
    }));

    // Retain the broad base lawn and authored blooms, but park the densest
    // near-camera blade layer: hundreds of sub-pixel edges would otherwise
    // compete for X's bitrate during the moving sweep.
    const nearGrass = ctx.scene.getObjectByName("sfbg_procedural_grass_near_detail");
    if (nearGrass) nearGrass.visible = false;

    // Use the deterministic garden layout to put an actual flower tuft between
    // lens and board. Palette 3 is the authored path-side flower bed; tint over
    // 0.55 selects an instance that renders with a bloom color.
    const heroBloom = collectGardenFlora(map)
      .filter((flora) => flora.palette === 3 && flora.tint > 0.55)
      .reduce<{ x: number; y: number; z: number; score: number } | null>((best, flora) => {
        const distance = Math.hypot(flora.x - PROMENADE_START.x, flora.z - PROMENADE_START.z);
        const score = Math.abs(distance - 2.45);
        return !best || score < best.score ? { ...flora, score } : best;
      }, null);

    const flowerDirection = heroBloom
      ? new THREE.Vector3(
          heroBloom.x - PROMENADE_START.x,
          0,
          heroBloom.z - PROMENADE_START.z
        ).normalize()
      : RIGHT.clone();
    const flowerDistance = heroBloom
      ? Math.hypot(heroBloom.x - PROMENADE_START.x, heroBloom.z - PROMENADE_START.z)
      : 2.45;
    const macroDistance = THREE.MathUtils.clamp(flowerDistance + 0.85, 3.1, 4.8);

    const focus = new THREE.Vector3(PROMENADE_START.x, ground + 0.2, PROMENADE_START.z);
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();

    armCinematic(ctx, {
      name: "twitter-summer-06",
      duration: TWITTER_SUMMER_SHOT_06_SECONDS,
      shots: [
        {
          id: "flower-board-macro",
          start: 0,
          end: 2.65,
          safety: { floorClearance: 0.42 },
          camera: (sample, out) => {
            const u = easeInOutCubic(sample.u);
            eye.copy(focus)
              .addScaledVector(flowerDirection, mix(macroDistance, macroDistance - 0.52, u))
              .addScaledVector(RIGHT, mix(-0.38, 0.42, u));
            eye.y = ground + mix(0.74, 1.03, u);
            target.copy(focus).addScaledVector(FORWARD, mix(0.12, 0.52, u));
            target.y -= mix(0.08, 0.18, u);
            setPose(out, eye, target, mix(72, 84, u), mix(-0.012, 0.014, u));
          }
        },
        {
          id: "summer-bloom-sweep",
          start: 2.65,
          end: TWITTER_SUMMER_SHOT_06_SECONDS,
          safety: { floorClearance: 0.72 },
          camera: (sample, out) => {
            const u = smoothstep(sample.u);
            const vortexSettle = smoothstep(
              THREE.MathUtils.clamp((sample.localTime - 3.0) / 1.85, 0, 1)
            );

            // Open on a readable chase, orbit through the summer beds, then
            // settle high and close over the radial deck artwork. That final
            // centered shape is the visual seed for the editor's petal vortex.
            eye.copy(focus)
              .addScaledVector(FORWARD, -mix(9.8, 3.0, vortexSettle))
              .addScaledVector(RIGHT, mix(5.6, -1.35, u));
            eye.y += mix(3.6, 4.45, vortexSettle);
            target.copy(focus).addScaledVector(FORWARD, mix(6.2, 0.8, vortexSettle));
            target.y += mix(0.48, -0.13, vortexSettle);
            setPose(
              out,
              eye,
              target,
              mix(38, 68, vortexSettle),
              mix(-0.018, 0.052, vortexSettle)
            );
          }
        }
      ],
      frame: (time) => {
        for (const key of DRIVEN_KEYS) ctx.input.keys.delete(key);

        focus.copy(ctx.player.renderPosition);
        focus.y += 0.2;

        // Hold for the macro, then let the real board physics deliver one long
        // acceleration and a gentle garden-path carve. No jump means the board,
        // blooms and horizon remain coherent from frame to frame.
        if (time >= 2.38) ctx.input.keys.add("KeyW");
        if (time >= 3.12) ctx.input.keys.add("ShiftLeft");
        if (time >= 4.55 && time < 5.28) ctx.input.keys.add("KeyA");
        if (time >= 5.28 && time < 5.78) ctx.input.keys.add("KeyD");
      }
    });
  }
};
