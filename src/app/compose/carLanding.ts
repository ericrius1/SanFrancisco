// Hard-car-landing presentation (camera shake + landing thump + dust puff).
// Extracted from main.ts per docs/MAIN_DECOMPOSITION.md: pure wiring around
// the player's landing-feedback serial, no scene ownership of its own.
import * as THREE from "three/webgpu";
import { CAR_LANDING_TUNING } from "../../vehicles/car";
import type { Player } from "../../player/player";
import type { ChaseCamera } from "../../core/camera";
import type { FX } from "../../fx/fx";
import type { VehicleAudio } from "../../fx/vehicleAudio";
import type { EmbodimentController } from "../player/embodimentController";

/**
 * Car physics publishes one stable landing event; presentation consumes each
 * serial exactly once. The controller stays independent from camera/audio/VFX,
 * while every authored range remains together under movement > car > landing.
 */
export function createCarLandingFeedback({
  player,
  embodiments,
  chase,
  vehicleAudio,
  fx
}: {
  player: Player;
  embodiments: EmbodimentController;
  chase: ChaseCamera;
  vehicleAudio: VehicleAudio;
  fx: FX;
}): { consume: () => void } {
  let consumedCarLandingSerial = player.driveLandingFeedback.serial;
  const carLandingPosition = new THREE.Vector3();
  const consume = () => {
    const landing = player.driveLandingFeedback;
    if (landing.serial === consumedCarLandingSerial) return;
    consumedCarLandingSerial = landing.serial;
    const tuning = CAR_LANDING_TUNING.values;
    if (
      player.mode !== "drive" ||
      embodiments.currentAnimal ||
      !tuning.enabled ||
      landing.strength <= 0
    ) return;

    const amount = THREE.MathUtils.clamp(landing.strength, 0, 1);
    const ranged = (a: number, b: number) =>
      THREE.MathUtils.lerp(Math.min(a, b), Math.max(a, b), amount);
    chase.shake(ranged(tuning.shakeMin, tuning.shakeMax));
    vehicleAudio.carLanding(amount, ranged(tuning.soundMin, tuning.soundMax));
    carLandingPosition.set(landing.x, landing.y, landing.z);
    fx.carLandingPuff(
      carLandingPosition,
      landing.yaw,
      amount,
      Math.round(ranged(tuning.smokeMin, tuning.smokeMax)),
      ranged(tuning.smokeScaleMin, tuning.smokeScaleMax),
      tuning.smokeSpread,
      tuning.smokeLife
    );
  };
  return { consume };
}
