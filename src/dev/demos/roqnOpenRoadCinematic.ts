import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import type { Demo } from "../demo";
import { cleanPlate } from "./shared";

export const ROQN_OPEN_ROAD_SECONDS = 30;

const GARDEN = { x: -2290, z: 2470, facing: -0.72 } as const;
const EMBARCADERO = { x: 4340, z: -380, facing: 1.8 } as const;
const PALACE = { x: -388, z: -1426, facing: 1.15 } as const;
const GOLDEN_GATE = { x: -2947, z: -2289, facing: 3.07 } as const;
const BAY = { x: 5200, z: -650, facing: -2.58 } as const;

/** A clean-plate tour: five locations, five visual languages, zero text. */
export const roqnOpenRoadCinematic: Demo = {
  name: "roqn-open-road",
  run(ctx) {
    const { map, sky, fireworks } = ctx;
    if (!map || !sky || !fireworks) {
      console.warn("[demo:roqn-open-road] map, sky, or fireworks unavailable");
      return;
    }

    cleanPlate(ctx.hud);
    sky.cycleEnabled = false;
    sky.setTimeOfDay(7.15);
    ctx.setExposure(1.12);
    ctx.setPostFx({ sceneSamples: 4, ink: false, dream: false, retro: false });
    ctx.input.suspended = false;
    const drivenKeys = ["KeyW", "KeyA", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "Space"];
    for (const key of drivenKeys) ctx.input.keys.delete(key);

    const gardenGround = map.groundTop(GARDEN.x, GARDEN.z);
    const embarcaderoGround = map.groundTop(EMBARCADERO.x, EMBARCADERO.z);
    const palaceGround = map.groundTop(PALACE.x, PALACE.z);
    ctx.player.teleportTo({ x: GARDEN.x, y: gardenGround + 26, z: GARDEN.z, facing: GARDEN.facing, mode: "bird" });

    // Authored initial values make preflight deterministic; before each runtime
    // camera sample, the active focus follows the real fixed-step subject.
    const gardenFocus = new THREE.Vector3(GARDEN.x, gardenGround + 28, GARDEN.z);
    const carFocus = new THREE.Vector3(EMBARCADERO.x, embarcaderoGround + 1.1, EMBARCADERO.z);
    const palaceFocus = new THREE.Vector3(PALACE.x, palaceGround + 13, PALACE.z);
    const bridgeFocus = new THREE.Vector3(GOLDEN_GATE.x, 150, GOLDEN_GATE.z);
    const boatFocus = new THREE.Vector3(BAY.x, 1.2, BAY.z);
    const towerFocus = new THREE.Vector3(-2947, 150, -2289);
    const skyline = new THREE.Vector3(5430, 112, -284);
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    const offset = new THREE.Vector3();

    armCinematic(ctx, {
      name: "roqn-open-road",
      duration: ROQN_OPEN_ROAD_SECONDS,
      shots: [
        {
          id: "garden-canopy",
          start: 0,
          end: 3,
          safety: { floorClearance: 1 },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            offset.set(mix(-22, -12, u), mix(15, 7, u), mix(24, 11, u));
            eye.copy(gardenFocus).add(offset);
            target.copy(gardenFocus).add(offset.set(0, mix(-2, 0.5, u), mix(-6, 5, u)));
            setPose(out, eye, target, mix(31, 46, u), mix(-0.025, 0.012, u));
          }
        },
        {
          id: "garden-wingtip",
          start: 3,
          end: 6,
          safety: { floorClearance: 0.8 },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            offset.set(mix(-8, 7, u), mix(3.4, 4.8, u), mix(8, -9, u));
            eye.copy(gardenFocus).add(offset);
            target.copy(gardenFocus).add(offset.set(0, 0.2, 3));
            setPose(out, eye, target, mix(58, 42, u), Math.sin(u * Math.PI) * 0.024);
          }
        },
        {
          id: "embarcadero-car-front",
          start: 6,
          end: 9,
          safety: { floorClearance: 0.7 },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            offset.set(mix(-1, 3, u), mix(8, 5.5, u), mix(0, -3, u));
            eye.copy(carFocus).add(offset);
            target.copy(carFocus).add(offset.set(0, 0.25, 1.5));
            setPose(out, eye, target, mix(46, 56, u), mix(-0.008, 0.01, u));
          }
        },
        {
          id: "embarcadero-car-chase",
          start: 9,
          end: 12,
          safety: { floorClearance: 0.8 },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            offset.set(mix(2.5, -2.5, u), mix(6.5, 8.5, u), mix(8, 10, u));
            eye.copy(carFocus).add(offset);
            target.copy(carFocus).add(offset.set(0, 0.25, 1));
            setPose(out, eye, target, mix(43, 34, u), mix(0.012, -0.018, u));
          }
        },
        {
          id: "palace-lagoon-reveal",
          start: 12,
          end: 15,
          safety: { floorClearance: 1 },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            const azimuth = -0.25 + u * 0.16;
            const radius = mix(94, 88, u);
            eye.set(PALACE.x + Math.sin(azimuth) * radius, palaceGround + mix(40, 35, u), PALACE.z + Math.cos(azimuth) * radius);
            target.set(PALACE.x, palaceGround + 12, PALACE.z);
            setPose(out, eye, target, mix(30, 43, u), mix(-0.015, 0.01, u));
          }
        },
        {
          id: "palace-column-drift",
          start: 15,
          end: 18,
          safety: { floorClearance: 0.9 },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            const azimuth = -0.08 + u * 0.18;
            const radius = mix(92, 86, u);
            eye.set(PALACE.x + Math.sin(azimuth) * radius, palaceGround + mix(45, 40, u), PALACE.z + Math.cos(azimuth) * radius);
            target.set(PALACE.x, palaceGround + 10, PALACE.z);
            setPose(out, eye, target, mix(36, 43, u), Math.sin(u * Math.PI) * -0.012);
          }
        },
        {
          id: "golden-gate-tower",
          start: 18,
          end: 21,
          safety: { floorClearance: 1 },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            eye.set(mix(-2900, -2905, u), mix(190, 184, u), mix(-2207, -2216, u));
            target.lerpVectors(towerFocus, bridgeFocus, mix(0.2, 0.8, u));
            setPose(out, eye, target, mix(29, 47, u), mix(-0.02, 0.008, u));
          }
        },
        {
          id: "golden-gate-wing-dive",
          start: 21,
          end: 24,
          safety: { floorClearance: 1 },
          camera: (s, out) => {
            const u = smoothstep(s.u);
            offset.set(mix(-12, 10, u), mix(6, 3, u), mix(14, -10, u));
            eye.copy(bridgeFocus).add(offset);
            target.copy(bridgeFocus).add(offset.set(0, mix(-1, 0.2, u), mix(-5, 4, u)));
            setPose(out, eye, target, mix(55, 62, u), Math.sin(u * Math.PI) * 0.035);
          }
        },
        {
          id: "bay-bridge-speedboat",
          start: 24,
          end: 27,
          safety: { floorClearance: 0.7 },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            offset.set(mix(-18, -9, u), mix(7.5, 3.4, u), mix(20, 10, u));
            eye.copy(boatFocus).add(offset);
            target.copy(boatFocus).add(offset.set(0, 0.5, -7));
            setPose(out, eye, target, mix(36, 52, u), mix(-0.012, 0.015, u));
          }
        },
        {
          id: "bay-lights-finale",
          start: 27,
          end: 30,
          safety: { floorClearance: 0.8 },
          camera: (s, out) => {
            const u = easeInOutCubic(s.u);
            eye.set(mix(5065, 5055, u), mix(27, 34, u), mix(-766, -777, u));
            target.lerpVectors(boatFocus, skyline, mix(0.35, 0.92, u));
            setPose(out, eye, target, mix(40, 38, u), mix(0.01, -0.018, u));
          }
        }
      ],
      cues: [
        {
          id: "car-stage",
          at: 6,
          run: () => {
            sky.setTimeOfDay(16.8);
            ctx.player.teleportTo({ x: EMBARCADERO.x, y: embarcaderoGround, z: EMBARCADERO.z, facing: EMBARCADERO.facing, mode: "drive" });
          }
        },
        {
          id: "palace-stage",
          at: 12,
          run: () => {
            sky.setTimeOfDay(18.25);
            ctx.player.teleportTo({ x: PALACE.x - 35, y: palaceGround + 20, z: PALACE.z + 16, facing: PALACE.facing, mode: "drone" });
          }
        },
        {
          id: "bridge-stage",
          at: 18,
          run: () => {
            sky.setTimeOfDay(19.1);
            ctx.player.teleportTo({ x: GOLDEN_GATE.x, y: 150, z: GOLDEN_GATE.z, facing: GOLDEN_GATE.facing, mode: "bird" });
          }
        },
        {
          id: "bay-stage",
          at: 24,
          run: () => {
            sky.setTimeOfDay(20.75);
            ctx.setExposure(1.18);
            ctx.player.teleportTo({ x: BAY.x, y: 0, z: BAY.z, facing: BAY.facing, mode: "speedboat" });
            fireworks.params.sparks = 60;
            fireworks.params.trail = 18;
            fireworks.params.crackle = 16;
            fireworks.params.intensity = 1.55;
          }
        },
        { id: "bay-shell-one", at: 25.25, run: () => fireworks.launchShell(new THREE.Vector3(5230, 1, -600), new THREE.Vector3(5350, 118, -350), 1.35, 2, 1.2) },
        { id: "bay-shell-two", at: 26.2, run: () => fireworks.launchShell(new THREE.Vector3(5280, 1, -520), new THREE.Vector3(5490, 138, -520), 1.45, 4, 1.35) },
        { id: "bay-burst-three", at: 27.8, run: () => fireworks.burstAt(new THREE.Vector3(5350, 92, -350), { secondary: 5, sizeScale: 2.1 }) },
        { id: "bay-burst-four", at: 28.65, run: () => fireworks.burstAt(new THREE.Vector3(5490, 108, -520), { secondary: 6, sizeScale: 2.25 }) }
      ],
      frame: (time) => {
        for (const key of drivenKeys) ctx.input.keys.delete(key);
        if (time < 6) {
          gardenFocus.copy(ctx.player.renderPosition);
          gardenFocus.y += 0.8;
          ctx.input.keys.add("KeyW");
          if (time < 2.2) ctx.input.keys.add("Space");
          if (time > 3.2) ctx.input.keys.add("ShiftLeft");
          if (time > 4.2) ctx.input.keys.add("KeyE");
        } else if (time < 12) {
          carFocus.copy(ctx.player.renderPosition);
          carFocus.y += 0.75;
          ctx.input.keys.add("KeyW");
          if (time > 7.2) ctx.input.keys.add("ShiftLeft");
          ctx.input.keys.add(time < 9.2 ? "KeyA" : "KeyD");
        } else if (time < 18) {
          palaceFocus.copy(ctx.player.renderPosition);
          palaceFocus.y += 0.35;
          if (time > 14.2) ctx.input.keys.add("KeyW");
          if (time > 15.1) ctx.input.keys.add("KeyA");
        } else if (time < 24) {
          bridgeFocus.copy(ctx.player.renderPosition);
          bridgeFocus.y += 0.75;
          if (time < 21.2) {
            ctx.input.keys.add("KeyW");
            ctx.input.keys.add("ShiftLeft");
          }
          if (time > 21.4) ctx.input.keys.add("KeyQ");
        } else {
          boatFocus.copy(ctx.player.renderPosition);
          boatFocus.y += 0.5;
          ctx.input.keys.add("KeyW");
          ctx.input.keys.add("ShiftLeft");
          if (time > 25.4) ctx.input.keys.add("KeyA");
        }
      }
    });
  }
};
