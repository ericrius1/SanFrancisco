import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { AFTERLIGHT_CENTER, AFTERLIGHT_TUNING } from "../../gameplay/afterlight";
import type { Demo } from "../demo";
import { cleanPlate, freezeAndBuryPlayer, repin } from "./shared";

export const AFTERLIGHT_CINEMATIC_SECONDS = 15;

const WHALE_AT = 7.15;
const WHALE_ORBIT_AT = WHALE_AT + AFTERLIGHT_TUNING.whaleRevealSeconds;

function risingWhaleFocus(time: number, centerY: number, out: THREE.Vector3) {
  const reveal = smoothstep((time - WHALE_AT) / AFTERLIGHT_TUNING.whaleRevealSeconds);
  return out.set(
    AFTERLIGHT_CENTER.x,
    centerY + mix(2.6, AFTERLIGHT_TUNING.whaleCruiseHeight, reveal),
    AFTERLIGHT_CENTER.z + mix(0, -3, reveal)
  );
}

function orbitingWhaleFocus(time: number, centerY: number, out: THREE.Vector3) {
  const orbitTime = Math.max(0, time - WHALE_ORBIT_AT);
  const angle = orbitTime * 0.145 - Math.PI * 0.58;
  const bob = Math.sin(orbitTime * 0.43) * 3.4 + Math.sin(orbitTime * 0.17) * 1.8;
  return out.set(
    AFTERLIGHT_CENTER.x + Math.cos(angle) * AFTERLIGHT_TUNING.whaleOrbitRadiusX,
    centerY + AFTERLIGHT_TUNING.whaleCruiseHeight + bob,
    AFTERLIGHT_CENTER.z + Math.sin(angle) * AFTERLIGHT_TUNING.whaleOrbitRadiusZ
  );
}

/** A clean-plate dusk film of the loom gathering its echoes and calling the sky whale. */
export const afterlightCinematic: Demo = {
  name: "afterlight",
  run(ctx) {
    const afterlight = ctx.afterlight;
    const map = ctx.map;
    const sky = ctx.sky;
    if (!map || !sky || !afterlight) {
      console.warn("[demo:afterlight] map, sky or Afterlight experience unavailable");
      return;
    }

    void afterlight.ready.then(() => {
      cleanPlate(ctx.hud);
      sky.cycleEnabled = false;
      sky.setTimeOfDay(20.25);
      ctx.setExposure(1.1);
      ctx.setPostFx({ sceneSamples: 4, ink: false, dream: false, retro: false });
      ctx.input.suspended = true;
      afterlight.resetForCinematic(1);

      const centerY = map.groundTop(AFTERLIGHT_CENTER.x, AFTERLIGHT_CENTER.z);
      const buried = freezeAndBuryPlayer(ctx, AFTERLIGHT_CENTER.x, AFTERLIGHT_CENTER.z);
      const loom = new THREE.Vector3(AFTERLIGHT_CENTER.x, centerY + 2.45, AFTERLIGHT_CENTER.z);
      const eye = new THREE.Vector3();
      const target = new THREE.Vector3();
      const whale = new THREE.Vector3();

      armCinematic(ctx, {
        name: "afterlight",
        duration: AFTERLIGHT_CINEMATIC_SECONDS,
        chrome: false,
        letterbox: 0,
        overlay: [],
        shots: [
          {
            id: "keepers-and-loom",
            start: 0,
            end: 2.55,
            safety: { floorClearance: 0.8, auditOcclusion: true },
            camera: (sample, out) => {
              const u = easeInOutCubic(sample.u);
              eye.set(
                AFTERLIGHT_CENTER.x + mix(-12.2, -8.1, u),
                centerY + mix(3.8, 3.15, u),
                AFTERLIGHT_CENTER.z + mix(16.2, 11.8, u)
              );
              target.set(
                AFTERLIGHT_CENTER.x + mix(-0.8, 0, u),
                centerY + mix(2.05, 2.42, u),
                AFTERLIGHT_CENTER.z + mix(2.4, 0.8, u)
              );
              setPose(out, eye, target, mix(50, 62, u), mix(-0.008, 0.004, u));
            }
          },
          {
            id: "echo-return-orbit",
            start: 2.55,
            end: 6.75,
            safety: { floorClearance: 1.2, auditOcclusion: true },
            camera: (sample, out) => {
              const u = smoothstep(sample.u);
              const azimuth = mix(-0.75, 0.35, u);
              const radius = mix(50, 36, u);
              eye.set(
                AFTERLIGHT_CENTER.x + Math.sin(azimuth) * radius,
                centerY + mix(19, 11, u),
                AFTERLIGHT_CENTER.z + Math.cos(azimuth) * radius
              );
              target.copy(loom);
              target.y += mix(0.6, 0.05, u);
              setPose(out, eye, target, mix(29, 43, u), Math.sin(u * Math.PI) * 0.009);
            }
          },
          {
            id: "loom-bloom",
            start: 6.75,
            end: 8.6,
            safety: { floorClearance: 1, auditOcclusion: true },
            camera: (sample, out) => {
              const u = smoothstep(sample.u);
              eye.set(
                AFTERLIGHT_CENTER.x + mix(17, 24, u),
                centerY + mix(5.8, 9.2, u),
                AFTERLIGHT_CENTER.z + mix(18, 27, u)
              );
              risingWhaleFocus(sample.time, centerY, whale);
              const reveal = smoothstep((sample.time - WHALE_AT) / 1.45);
              target.copy(loom).lerp(whale, reveal * 0.58);
              setPose(out, eye, target, mix(48, 37, u), mix(0.006, -0.01, u));
            }
          },
          {
            id: "whale-rise",
            start: 8.6,
            end: WHALE_ORBIT_AT,
            safety: { floorClearance: 1.2 },
            camera: (sample, out) => {
              const u = smoothstep(sample.u);
              eye.set(
                AFTERLIGHT_CENTER.x + mix(-24, -34, u),
                centerY + mix(11, 17, u),
                AFTERLIGHT_CENTER.z + mix(35, 45, u)
              );
              risingWhaleFocus(sample.time, centerY, whale);
              target.copy(loom).lerp(whale, mix(0.62, 0.92, u));
              setPose(out, eye, target, mix(39, 34, u), Math.sin(u * Math.PI) * -0.012);
            }
          },
          {
            id: "whale-over-canopy",
            start: WHALE_ORBIT_AT,
            end: AFTERLIGHT_CINEMATIC_SECONDS,
            safety: { floorClearance: 2 },
            camera: (sample, out) => {
              const u = smoothstep(sample.u);
              eye.set(
                AFTERLIGHT_CENTER.x + mix(38, 70, u),
                centerY + mix(24, 40, u),
                AFTERLIGHT_CENTER.z + mix(52, 82, u)
              );
              orbitingWhaleFocus(sample.time, centerY, whale);
              target.set(AFTERLIGHT_CENTER.x, centerY + mix(10, 13, u), AFTERLIGHT_CENTER.z);
              target.lerp(whale, mix(0.78, 0.68, u));
              setPose(out, eye, target, mix(42, 52, u), Math.sin(u * Math.PI) * 0.008);
            }
          }
        ],
        frame: (time, dt) => {
          afterlight.setCinematicTime(time, dt);
          repin(buried, ctx);
        }
      });
    }).catch((error) => {
      console.warn("[demo:afterlight] failed to arm", error);
    });
  }
};
