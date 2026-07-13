import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose } from "../../cinematic";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";
import {
  LAMP_LAYOUT,
  REVERIE_ROTUNDA,
  REVERIE_SPAWN
} from "../../gameplay/palaceReverie";
import { PALACE_LAGOON } from "../../world/heightmap";

export const PALACE_REVERIE_SECONDS = 15;

const PALACE_SKIFF_LOOK = {
  x: PALACE_LAGOON.x + 22,
  z: PALACE_LAGOON.z - 18
} as const;

/**
 * Fifteen seconds of blue-hour Palace Reverie. Camera rails are authored from
 * the known-good palace showcase vantage so the rotunda and lagoon stay
 * readable; quest progress cues light lamps and bloom the aurora.
 */
export const palaceReverieCinematic: Demo = {
  name: "palace-reverie",
  run(ctx) {
    const reverie = ctx.palaceReverie;
    if (!ctx.map || !ctx.sky || !reverie) {
      console.warn("[demo:palace-reverie] palace reverie services unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    ctx.sky.cycleEnabled = false;
    ctx.sky.setTimeOfDay(19.92);
    ctx.setExposure(1.1);
    ctx.setPostFx({ sceneSamples: 4, ink: false, dream: true, retro: false });
    ctx.input.suspended = true;
    ctx.minimap?.setExpanded(false);

    const ground = ctx.map.groundTop(REVERIE_SPAWN.x, REVERIE_SPAWN.z);
    ctx.player.teleportTo({
      x: REVERIE_SPAWN.x,
      y: ground,
      z: REVERIE_SPAWN.z,
      facing: REVERIE_SPAWN.heading,
      mode: "walk"
    });
    ctx.player.heading = REVERIE_SPAWN.heading - Math.PI;

    reverie.setCinematicProgress(0, false);
    reverie.root.visible = true;

    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const lamp0 = LAMP_LAYOUT[0];
    const lamp2 = LAMP_LAYOUT[2];
    const lamp4 = LAMP_LAYOUT[4];

    const shoreEye = new THREE.Vector3(-302, 8.2, -1426);
    const shoreTarget = new THREE.Vector3(-370, 20, -1405);

    const arm = () => {
      armCinematic(ctx, {
        name: "palace-reverie-blue-hour",
        duration: PALACE_REVERIE_SECONDS,
        letterbox: 0.08,
        overlay: [
          {
            id: "title",
            start: 0.4,
            end: 3.0,
            align: "left",
            accent: "#c8e8ff",
            eyebrow: "Palace of Fine Arts",
            title: "Reverie",
            detail: "Blue hour on the lagoon"
          },
          {
            id: "skiff-card",
            start: 3.85,
            end: 6.4,
            align: "left",
            accent: "#9ef0ff",
            eyebrow: "Lagoon",
            title: "Lanterns drift",
            detail: "Warm wakes on quiet water"
          },
          {
            id: "lamps-card",
            start: 7.25,
            end: 10.4,
            align: "right",
            accent: "#ffd6a0",
            eyebrow: "Peristyle",
            title: "Memory lamps",
            detail: "Arched threads remember the gallery"
          },
          {
            id: "bloom-card",
            start: 11.3,
            end: 14.9,
            align: "center",
            accent: "#f4b4ff",
            eyebrow: "Complete",
            title: "The palace blooms",
            detail: "Blue hour belongs to you now"
          }
        ],
        begin: () => {
          reverie.setCinematicProgress(0, false);
          reverie.root.visible = true;
        },
        cues: [
          { id: "lamps-1", at: 3.6, run: () => reverie.setCinematicProgress(1, false) },
          { id: "lamps-2", at: 4.2, run: () => reverie.setCinematicProgress(2, false) },
          { id: "lamps-3", at: 6.1, run: () => reverie.setCinematicProgress(3, false) },
          { id: "lamps-4", at: 8.0, run: () => reverie.setCinematicProgress(4, false) },
          { id: "pre-bloom", at: 10.85, run: () => reverie.setCinematicProgress(5, false) },
          { id: "complete", at: 11.2, run: () => reverie.setCinematicProgress(5, true) }
        ],
        frame: (t, dt) => {
          reverie.update(Math.max(dt, 1 / 60), 40 + t);
          // Soft exposure lift into the bloom finish.
          const lift = t < 11.2 ? t / 11.2 * 0.08 : 0.08 + Math.min(1, (t - 11.2) / 3.5) * 0.12;
          ctx.setExposure(1.1 + lift);
        },
        shots: [
          {
            id: "shore-arrive",
            start: 0,
            end: 3.5,
            safety: { floorClearance: 1.2, auditOcclusion: false },
            camera: (s, out) => {
              const u = easeInOutCubic(s.u);
              // Open on Inez's shore, then widen to the rotunda across the lagoon.
              eye.set(
                mix(shoreEye.x + 14, shoreEye.x - 4, u),
                mix(shoreEye.y + 1.2, 5.2, u),
                mix(shoreEye.z + 8, shoreEye.z - 2, u)
              );
              target.set(
                mix(-268, shoreTarget.x, u),
                mix(4.2, shoreTarget.y - 1.2, u),
                mix(-1405, shoreTarget.z, u)
              );
              setPose(out, eye, target, mix(34, 30, u), mix(0.004, -0.012, u));
            }
          },
          {
            id: "lantern-drift",
            start: 3.5,
            end: 7.2,
            safety: { floorClearance: 0.8, auditOcclusion: false },
            camera: (s, out) => {
              const u = easeInOutCubic(s.u);
              // Skim the lagoon — low past lanterns & skiff, then lift toward the rotunda.
              eye.set(
                mix(-258, -232, u),
                mix(3.8, 3.2, u),
                mix(-1458, -1470, u)
              );
              target.set(
                mix(PALACE_SKIFF_LOOK.x, mix(PALACE_SKIFF_LOOK.x, REVERIE_ROTUNDA.x, 0.55), u),
                mix(2.2, 12, u),
                mix(PALACE_SKIFF_LOOK.z, mix(PALACE_SKIFF_LOOK.z, REVERIE_ROTUNDA.z, 0.55), u)
              );
              setPose(out, eye, target, mix(42, 34, u), mix(-0.006, -0.018, u));
            }
          },
          {
            id: "colonnade-lamps",
            start: 7.2,
            end: 11.2,
            safety: { floorClearance: 0.9, auditOcclusion: false },
            camera: (s, out) => {
              const u = easeInOutCubic(s.u);
              // Dolly along the peristyle so arched lamp-threads stay in frame.
              const lx = mix(mix(lamp0.x, lamp2.x, 0.55), lamp4.x, u);
              const lz = mix(mix(lamp0.z, lamp2.z, 0.55), lamp4.z, u);
              eye.set(
                lx + mix(12, 6, u),
                mix(3.0, 5.6, u),
                lz + mix(16, 4, u)
              );
              target.set(
                mix(lamp0.x, lamp4.x, u),
                mix(2.8, 5.2, u) + Math.sin(u * Math.PI) * 0.8,
                mix(lamp0.z, lamp4.z, u)
              );
              setPose(out, eye, target, mix(50, 34, u), mix(0.008, -0.01, u));
            }
          },
          {
            id: "rotunda-bloom",
            start: 11.2,
            end: 15.0,
            safety: { floorClearance: 1.4, auditOcclusion: false },
            camera: (s, out) => {
              const u = easeInOutCubic(s.u);
              // Start inside the aurora, then orbit out wide on the shaft.
              const yaw = mix(-0.15, 0.72, u);
              const dist = mix(128, 218, u);
              const height = mix(9, 36, u);
              eye.set(
                REVERIE_ROTUNDA.x + Math.sin(yaw) * dist,
                height,
                REVERIE_ROTUNDA.z + Math.cos(yaw) * dist
              );
              target.set(
                REVERIE_ROTUNDA.x,
                mix(12, 28, u) + Math.sin(u * Math.PI) * 2,
                REVERIE_ROTUNDA.z
              );
              setPose(out, eye, target, mix(42, 22, u), mix(-0.008, -0.042, u));
            }
          }
        ]
      });
    };

    const waitForIdle = () => {
      const idle = (window as unknown as { __sf?: { renderIdle?: () => boolean } }).__sf?.renderIdle?.();
      if (idle) arm();
      else requestAnimationFrame(waitForIdle);
    };
    waitForIdle();
  }
};
