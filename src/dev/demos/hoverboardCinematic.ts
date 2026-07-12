import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { normalizeBoardConfig, type BoardConfig } from "../../vehicles/board";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const HOVERBOARD_SECONDS = 15;

const X = 412;
const Z = 2758;
const FACING = 2.25;

/**
 * A six-shot product film, authored against the real board mesh and controller.
 * Customization is applied through the same Player/VehicleAudio seam as the UI;
 * the final three shots hand control to actual fixed-step board physics.
 */
export const hoverboardCinematic: Demo = {
  name: "hoverboard",
  run(ctx) {
    if (!ctx.map || !ctx.sky || !ctx.setBoardConfig) {
      console.warn("[demo:hoverboard] map, sky or board-config service unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    ctx.sky.cycleEnabled = false;
    ctx.sky.setTimeOfDay(19.15);
    ctx.setExposure(1.08);
    ctx.setPostFx({ sceneSamples: 4, ink: false, dream: false, retro: false });
    ctx.input.suspended = false;
    ctx.input.keys.delete("KeyW");
    ctx.input.keys.delete("ShiftLeft");

    // Clear the summit soundstage. Move the trio and its perch collider as one
    // unit instead of merely hiding the musicians (which would leave the board
    // standing on an invisible boulder).
    ctx.buskers?.setPlacement(X + 900, Z + 900);
    if (ctx.buskers) ctx.buskers.group.visible = false;

    const ground = ctx.map.groundTop(X, Z);
    ctx.player.teleportTo({ x: X, y: ground, z: Z, facing: FACING, mode: "board" });

    const forward = new THREE.Vector3(-Math.sin(FACING), 0, -Math.cos(FACING)).normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const focus = new THREE.Vector3(X, ground + 1.05, Z);
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const liveFocus = (out: THREE.Vector3) => out.copy(ctx.player.renderPosition).addScaledVector(THREE.Object3D.DEFAULT_UP, 0.12);

    const base = normalizeBoardConfig({
      shape: "classic",
      fin: "none",
      deck: 1,
      trim: 5,
      glow: 0,
      surface: "topo",
      surfaceScale: 38,
      surfaceWarp: 18,
      surfaceSeed: 18472,
      surfaceFlow: 18,
      surfaceFx: 24,
      surfaceFxKind: "ripple",
      plumeReach: 24,
      plumeShimmer: 14,
      plumeSparks: false,
      plumeGlow: 0,
      hum: "hum",
      pitch: 0,
      soundTone: 34,
      soundMotion: 18,
      soundThrust: 28,
      soundAir: 16
    });
    let current: BoardConfig = base;
    const apply = (next: Partial<BoardConfig>) => {
      current = normalizeBoardConfig({ ...current, ...next });
      ctx.setBoardConfig?.(current);
    };
    apply(base);

    armCinematic(ctx, {
      name: "hoverboard-customization",
      duration: HOVERBOARD_SECONDS,
      letterbox: 0.052,
      shots: [
        {
          id: "golden-hour-reveal",
          start: 0,
          end: 2.4,
          safety: { floorClearance: 0.8, auditOcclusion: true },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            const azimuth = -0.82 + u * 1.08;
            const radius = mix(12.8, 7.1, u);
            eye.set(
              focus.x + Math.sin(azimuth) * radius,
              focus.y + mix(6.6, 2.7, u),
              focus.z + Math.cos(azimuth) * radius
            );
            target.copy(focus).addScaledVector(forward, mix(1.4, 0.1, u));
            setPose(out, eye, target, mix(28, 42, u));
          }
        },
        {
          id: "shape-macro",
          start: 2.4,
          end: 4.8,
          safety: { floorClearance: 0.48 },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            liveFocus(focus);
            eye.copy(focus)
              .addScaledVector(right, mix(3.5, 2.8, u))
              .addScaledVector(forward, mix(-1.1, 0.45, u));
            eye.y += mix(0.78, 1.08, u);
            target.copy(focus).addScaledVector(forward, 0.2);
            target.y -= 0.14;
            setPose(out, eye, target, mix(62, 78, u), mix(-0.012, 0.012, u));
          }
        },
        {
          id: "surface-orbit",
          start: 4.8,
          end: 7.1,
          safety: { floorClearance: 0.7 },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            liveFocus(focus);
            const azimuth = 1.05 + u * 1.18;
            const radius = mix(4.2, 3.45, u);
            eye.set(
              focus.x + Math.sin(azimuth) * radius,
              focus.y + mix(3.6, 2.25, u),
              focus.z + Math.cos(azimuth) * radius
            );
            target.copy(focus);
            target.y -= 0.1;
            setPose(out, eye, target, 68, Math.sin(u * Math.PI) * 0.018);
          }
        },
        {
          id: "propulsion-lab",
          start: 7.1,
          end: 9.45,
          safety: { floorClearance: 0.38 },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            liveFocus(focus);
            eye.copy(focus)
              .addScaledVector(forward, mix(-5.6, -4.6, u))
              .addScaledVector(right, mix(1.6, -0.7, u));
            // A shallow, slightly elevated profile keeps the bright plume over
            // dark terrain instead of silhouetting it into the pale sky.
            eye.y = ground + mix(1.2, 1.4, u);
            target.copy(focus)
              .addScaledVector(forward, -0.45)
              .addScaledVector(right, 0.4);
            target.y -= 0.25;
            setPose(out, eye, target, mix(55, 65, u));
          }
        },
        {
          id: "boost-chase",
          start: 9.45,
          end: 12.35,
          safety: { floorClearance: 0.75 },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            liveFocus(focus);
            eye.copy(focus)
              .addScaledVector(forward, mix(-5.8, -7.3, u))
              .addScaledVector(right, mix(2.5, 1.1, u));
            eye.y += mix(2.0, 2.75, u);
            target.copy(focus).addScaledVector(forward, mix(2.4, 5.5, u));
            target.y += 0.48;
            setPose(out, eye, target, mix(38, 31, u), mix(0.025, -0.018, u));
          }
        },
        {
          id: "ollie-flyby",
          start: 12.35,
          end: 15,
          safety: { floorClearance: 0.8 },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            liveFocus(focus);
            eye.copy(focus)
              .addScaledVector(forward, mix(5.6, -13.5, u))
              .addScaledVector(right, mix(2.6, -7.5, u));
            eye.y += mix(1.25, 8.8, u);
            target.copy(focus).addScaledVector(forward, mix(0.4, 7.5, u));
            target.y += mix(0.55, 1.8, u);
            setPose(out, eye, target, mix(58, 26, u), Math.sin(u * Math.PI) * -0.025);
          }
        }
      ],
      cues: [
        {
          id: "shape",
          at: 2.42,
          run: () => apply({ shape: "manta", fin: "halo" })
        },
        {
          id: "surface",
          at: 4.82,
          run: () =>
            apply({
              deckHex: 0xf36f5b,
              trimHex: 0x142334,
              glowHex: 0x63ffe3,
              surface: "aurora",
              surfaceScale: 64,
              surfaceWarp: 58,
              surfaceFlow: 72,
              surfaceFx: 66,
              surfaceFxKind: "vortex"
            })
        },
        {
          id: "quiet-plume",
          at: 6.48,
          run: () => apply({ plumeReach: 16, plumeShimmer: 8, plumeSparks: false, plumeGlow: 0 })
        },
        {
          id: "comet-plume",
          at: 7.72,
          run: () =>
            apply({
              plumeReach: 96,
              plumeShimmer: 88,
              plumeSparks: true,
              plumeGlow: 2,
              plumeHex: 0xb8ff68,
              soundThrust: 94,
              soundAir: 72
            })
        },
        {
          id: "voice",
          at: 9.18,
          run: () => apply({ hum: "choir", pitch: 3, soundTone: 78, soundMotion: 68 })
        },
        {
          id: "ride",
          at: 9.45,
          run: () => ctx.input.keys.add("KeyW")
        },
        {
          id: "boost",
          at: 10,
          run: () => ctx.input.keys.add("ShiftLeft")
        },
        {
          id: "ollie",
          at: 12.35,
          run: () => ctx.player.requestBoardJump()
        },
        {
          id: "release-controls",
          at: 14.92,
          run: () => {
            ctx.input.keys.delete("KeyW");
            ctx.input.keys.delete("ShiftLeft");
          }
        }
      ],
      overlay: [
        {
          id: "intro",
          start: 0.15,
          end: 2.25,
          eyebrow: "BOARD LAB · SAN FRANCISCO",
          title: "Build your line.",
          detail: "One ride. Every mood.",
          accent: "#7cf7e5"
        },
        {
          id: "shape-card",
          start: 2.52,
          end: 4.45,
          eyebrow: "SHAPE / 01",
          title: "Manta",
          detail: "wide carve · halo stabilizer",
          accent: "#ff8b77",
          align: "right"
        },
        {
          id: "surface-card",
          start: 4.92,
          end: 6.75,
          eyebrow: "SURFACE / 02",
          title: "Aurora vortex",
          detail: "coral deck · sea-glass rails\nflow 72 · warp 58",
          accent: "#63ffe3"
        },
        {
          id: "quiet-card",
          start: 6.25,
          end: 7.62,
          eyebrow: "PROPULSION / WHISPER",
          title: "Quiet current",
          detail: "reach 16 · shimmer 08",
          accent: "#70eaff",
          align: "right",
          fade: 0.2
        },
        {
          id: "comet-card",
          start: 7.76,
          end: 9.36,
          eyebrow: "PROPULSION / COMET",
          title: "Wake the sparks.",
          detail: "reach 96 · shimmer 88 · sparks ON\nthrust 94 · air 72",
          accent: "#b8ff68",
          align: "right",
          fade: 0.22
        },
        {
          id: "payoff",
          start: 10.2,
          end: 12.15,
          eyebrow: "VOICE / CHOIR · E",
          title: "Now let it sing.",
          accent: "#e9dcff"
        },
        {
          id: "outro",
          start: 13.55,
          end: 14.92,
          eyebrow: "YOUR BOARD · YOUR WEATHER",
          title: "Made to move.",
          accent: "#b8ff68",
          align: "right"
        }
      ]
    });
  }
};
