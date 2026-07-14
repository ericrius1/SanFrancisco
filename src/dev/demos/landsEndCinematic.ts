import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import type { Demo } from "../demo";
import { LABYRINTH } from "../../world/landsEnd";
import { cleanPlate, freezeAndBuryPlayer, repin } from "./shared";

export const LANDS_END_SECONDS = 15;

/**
 * Lands End at twilight. A cliff-top labyrinth of bioluminescent cobbles that
 * lights as an invisible walker threads it; at the heart it floods gold and a
 * ring of sea-lanterns lifts off and drifts over the Pacific.
 *
 * Camera is a pure function of window.__cineT (via armCinematic). The labyrinth
 * light-wave is driven deterministically in frame() so the shot replays exactly.
 */
export const landsEndCinematic: Demo = {
  name: "landsend",
  run(ctx) {
    if (!ctx.map || !ctx.sky) {
      console.warn("[demo:landsend] map or sky unavailable");
      return;
    }
    const lab = ctx.landsEnd?.labyrinth ?? (window as never as { __sf: { landsEnd: { labyrinth: unknown } } }).__sf?.landsEnd?.labyrinth;
    if (!lab) {
      console.warn("[demo:landsend] Lands End region unavailable");
      return;
    }
    const labyrinth = lab as {
      reset(): void;
      setProgress(t: number): void;
      triggerComplete(): void;
    };

    cleanPlate(ctx.hud);
    ctx.sky.cycleEnabled = false;
    ctx.sky.setTimeOfDay(20.25); // deep golden dusk, sun on the horizon
    ctx.setExposure(1.06);
    ctx.setPostFx({ ink: false, dream: false, retro: false });
    ctx.input.suspended = true;

    const cx = LABYRINTH.x;
    const cz = LABYRINTH.z;
    const groundY = ctx.map.groundTop(cx, cz);

    // Pure art plate: bury the avatar (and its nameplate) far underground while
    // keeping tiles + region LOD fed at the labyrinth XZ. The spiral is the
    // subject — no figure, no chrome.
    const buried = freezeAndBuryPlayer(ctx, cx, cz);
    const sf = (window as unknown as { __sf?: { worldCursor?: { setEnabled(on: boolean): void } } }).__sf;
    sf?.worldCursor?.setEnabled?.(false); // kill the in-world aim orb

    // Local frame. `toOcean` points WNW toward the sunset/sea; the camera lives
    // on the opposite (landward) side so the labyrinth is backlit by the water.
    const C = new THREE.Vector3(cx, groundY + 0.6, cz);
    const toOcean = new THREE.Vector3(-0.74, 0, -0.34).normalize();
    const side = new THREE.Vector3(-toOcean.z, 0, toOcean.x); // right-hand perp
    const up = new THREE.Vector3(0, 1, 0);
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();

    armCinematic(ctx, {
      name: "lands-end-labyrinth",
      duration: LANDS_END_SECONDS,
      letterbox: 0.05,
      begin: () => {
        labyrinth.reset();
      },
      // Deterministic light-wave: the spiral lights from rim to centre over
      // ~2.6s→10.2s, then the heart floods and the lanterns rise.
      frame: (time: number) => {
        repin(buried, ctx); // keep the buried body from drifting/NaN
        sf?.worldCursor?.setEnabled?.(false);
        const p = smoothstep(Math.max(0, Math.min(1, (time - 2.6) / 7.6)));
        labyrinth.setProgress(p);
        if (time >= 10.7) labyrinth.triggerComplete();
      },
      shots: [
        {
          // Establishing crane: high and far SE, descending and pushing in over
          // the dormant spiral with the ocean glowing beyond.
          id: "arrival",
          start: 0,
          end: 3.4,
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            const radius = mix(52, 33, u);
            const height = mix(33, 16, u);
            const lateral = mix(12, 5, u);
            eye
              .copy(C)
              .addScaledVector(toOcean, -radius)
              .addScaledVector(side, lateral);
            eye.y = groundY + height;
            target.copy(C).addScaledVector(toOcean, mix(7, 2.5, u));
            target.y += mix(2.5, 0.4, u);
            setPose(out, eye, target, mix(30, 40, u));
          }
        },
        {
          // Descend to the rim and skim low across the SE edge as the light wave
          // begins threading inward.
          id: "threshold",
          start: 3.4,
          end: 7.0,
          camera: (s, out) => {
            const u = smoothstep(s.u);
            const radius = mix(28, 19, u);
            const height = mix(14, 4.2, u);
            const lateral = mix(-9, 10, u);
            eye
              .copy(C)
              .addScaledVector(toOcean, -radius)
              .addScaledVector(side, lateral);
            eye.y = groundY + height;
            target.copy(C).addScaledVector(side, mix(-2, 2, u));
            target.y += 0.3;
            setPose(out, eye, target, mix(40, 46, u), Math.sin(u * Math.PI) * 0.01);
          }
        },
        {
          // Low orbit as the whole spiral comes alight, cairn heart glowing.
          id: "awaken",
          start: 7.0,
          end: 10.7,
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            const az = -0.5 + u * 1.35;
            const radius = mix(19, 16, u);
            const height = mix(5.5, 7.5, u);
            eye.set(C.x + Math.sin(az) * radius, groundY + height, C.z + Math.cos(az) * radius);
            target.copy(C);
            target.y += 0.5;
            setPose(out, eye, target, mix(48, 44, u), Math.sin(u * Math.PI) * -0.012);
          }
        },
        {
          // Payoff: gold flood + sea-lanterns lift off. Crane up and pull back,
          // tilting to follow the lanterns drifting out over the Pacific.
          id: "release",
          start: 10.7,
          end: 15,
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            const radius = mix(18, 40, u);
            const height = mix(8, 30, u);
            eye
              .copy(C)
              .addScaledVector(toOcean, -radius)
              .addScaledVector(side, mix(3, -2, u));
            eye.y = groundY + height;
            // look up and toward the ocean where the lanterns climb and drift
            target
              .copy(C)
              .addScaledVector(toOcean, mix(3, 14, u))
              .addScaledVector(up, mix(3, 16, u));
            setPose(out, eye, target, mix(44, 33, u), Math.sin(u * Math.PI) * 0.02);
          }
        }
      ]
    });
  }
};
