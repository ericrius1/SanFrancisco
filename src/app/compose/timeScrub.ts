// Z-hold time-of-day scrub + N-hold look/speed adjust (trackpad gestures that
// consume mouse/wheel input before the fly controller and chase camera see it).
// Extracted from main.ts per docs/MAIN_DECOMPOSITION.md: self-contained input
// wiring over sky/input/hud, one update call per live frame.
import * as THREE from "three/webgpu";
import { INPUT_TUNING } from "../../config";
import { saveTweak } from "../../core/persist";
import type { Input } from "../../core/input";
import type { Sky } from "../../world/sky";
import type { HUD } from "../../ui/hud";

const clock12 = (t: number) => {
  const h = Math.floor(t) % 24;
  const m = Math.floor((t % 1) * 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/**
 * Z (hold): the trackpad scrubs time of day instead of the camera. `target`
 * accumulates raw input; the sky eases toward it each frame so fast swipes
 * glide instead of stepping. The cycle pauses while scrubbing and resumes
 * (from the new time) on release.
 * N (hold): horizontal trackpad → look sensitivity; vertical → move speed.
 */
export function createTimeScrubAndTuningGestures({
  input,
  sky,
  hud
}: {
  input: Input;
  sky: Sky;
  hud: HUD;
}): { update: (dt: number, scrubHeld: boolean, adjustHeld: boolean) => void } {
  let timeScrub: { target: number; wasCycling: boolean } | null = null;
  const update = (frameDt: number, scrubHeld: boolean, adjustHeld: boolean) => {
    if (scrubHeld && !timeScrub) timeScrub = { target: sky.timeOfDay, wasCycling: sky.cycleEnabled };
    if (timeScrub) {
      if (scrubHeld) {
        sky.cycleEnabled = false;
        timeScrub.target += input.mouseDX * 0.01 + input.wheelX * 0.005;
        input.mouseDX = 0;
        input.mouseDY = 0;
        input.wheelX = 0;
        input.wheel = 0; // momentum scroll must not zoom the camera mid-scrub
      }
      // shortest way around the 24h wrap, critically-damped ease
      const d = ((((timeScrub.target - sky.timeOfDay) % 24) + 36) % 24) - 12;
      sky.advanceCivilHours(d * (1 - Math.exp(-frameDt * 10)));
      hud.message(clock12(sky.timeOfDay), 0.8);
      if (!scrubHeld && Math.abs(d) < 0.01) {
        sky.cycleEnabled = timeScrub.wasCycling;
        timeScrub = null;
      }
    }
    if (adjustHeld) {
      const look = INPUT_TUNING.values;
      const nextLook = THREE.MathUtils.clamp(
        look.lookSensitivity + input.mouseDX * 0.002 + input.wheelX * 0.001,
        0.25,
        3
      );
      const nextSpeed = THREE.MathUtils.clamp(
        look.moveSpeedScale - input.mouseDY * 0.002 - input.wheel * 0.001,
        0.4,
        2.5
      );
      if (nextLook !== look.lookSensitivity) {
        look.lookSensitivity = nextLook;
        saveTweak("input.lookSensitivity", nextLook);
      }
      if (nextSpeed !== look.moveSpeedScale) {
        look.moveSpeedScale = nextSpeed;
        saveTweak("input.moveSpeedScale", nextSpeed);
      }
      input.mouseDX = 0;
      input.mouseDY = 0;
      input.wheelX = 0;
      input.wheel = 0;
      hud.message(
        `Look ${look.lookSensitivity.toFixed(2)}× · Move ${look.moveSpeedScale.toFixed(2)}×`,
        0.8
      );
    }
  };
  return { update };
}
