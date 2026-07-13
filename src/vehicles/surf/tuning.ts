import { tunables } from "../../core/persist";

/**
 * One current arcade-surf schema. The controller is velocity-owned and samples
 * one authoritative `waterHeight()` floor in paddle, ride, air landing and
 * recovery. Values intentionally favour readable, forgiving play over weight.
 */
export const SURF_TUNING = tunables("movement.surf", {
  // paddle + catch
  paddleSpeed: { v: 8.5, min: 3, max: 18, step: 0.25, label: "paddle speed" },
  paddleAccel: { v: 4.8, min: 1, max: 12, step: 0.1, label: "paddle response" },
  paddleBrake: { v: 7, min: 1, max: 16, step: 0.25, label: "paddle brake" },
  paddleTurn: { v: 2.45, min: 0.5, max: 5, step: 0.05, label: "paddle turn" },
  proneHeight: { v: 0.24, min: 0.08, max: 0.65, step: 0.01, label: "prone clearance" },
  catchDelay: { v: 0.28, min: 0, max: 1.2, step: 0.02, label: "catch delay" },
  catchFace: { v: 0.3, min: 0.08, max: 0.9, step: 0.02, label: "catch steepness" },

  // direct down-line carving + speed
  trimSpeed: { v: 14, min: 5, max: 30, step: 0.5, label: "trim speed" },
  pumpBoost: { v: 12, min: 0, max: 28, step: 0.5, label: "W pump boost" },
  stallSpeed: { v: 4.5, min: 1, max: 12, step: 0.25, label: "S stall speed" },
  maxTrim: { v: 30, min: 12, max: 48, step: 0.5, label: "max line speed" },
  pumpResponse: { v: 5.5, min: 1, max: 14, step: 0.25, label: "pump response" },
  speedResponse: { v: 2.8, min: 0.5, max: 8, step: 0.1, label: "speed response" },
  stallResponse: { v: 6.5, min: 1, max: 16, step: 0.25, label: "stall response" },
  carveResponse: { v: 7.5, min: 1, max: 18, step: 0.25, label: "direction carve" },

  // moving-face grip; X rides the world-time crest while Z is rider-owned. The
  // offset sets the rider DOWN in the pocket (not on the crest) so the steep face
  // towers overhead — the Kelly-Slater wall. Climbing to the lip is a control, not
  // the resting spot, so the auto-launch no longer fires every wave.
  faceOffset: { v: 7, min: 1.5, max: 16, step: 0.1, label: "pocket depth" },
  faceTrack: { v: 2.4, min: 0.4, max: 6, step: 0.1, label: "face magnet" },
  recoveryFaceTrack: { v: 3.2, min: 0.5, max: 8, step: 0.1, label: "recovery magnet" },
  maxFaceCorrection: { v: 16, min: 4, max: 30, step: 0.5, label: "face correction" },
  boundaryMargin: { v: 34, min: 10, max: 120, step: 1, label: "cutback margin" },
  railHeight: { v: 0.48, min: 0.18, max: 1, step: 0.01, label: "surface clearance" },
  carveLean: { v: 0.78, min: 0.1, max: 1.3, step: 0.02, label: "carve lean" },
  leanResponse: { v: 8.5, min: 2, max: 18, step: 0.25, label: "lean response" },
  pitchSampleDistance: { v: 2.2, min: 0.6, max: 6, step: 0.1, label: "pitch sample" },
  pitchFollow: { v: 0.82, min: 0, max: 1.5, step: 0.02, label: "pitch follow" },
  pitchResponse: { v: 8, min: 2, max: 18, step: 0.25, label: "pitch response" },

  // automatic wave launch; no jump button
  launchMinSpeed: { v: 17, min: 7, max: 34, step: 0.5, label: "auto launch speed" },
  autoLaunchLip: { v: 0.38, min: 0.15, max: 0.9, step: 0.02, label: "auto launch lip" },
  launchChargeRate: { v: 1.35, min: 0.2, max: 3, step: 0.05, label: "launch charge" },
  launchChargeDecay: { v: 0.8, min: 0, max: 3, step: 0.05, label: "launch decay" },
  launchVelocity: { v: 7.4, min: 2, max: 18, step: 0.2, label: "launch lift" },
  launchSpeedLift: { v: 0.16, min: 0, max: 0.5, step: 0.01, label: "speed lift" },
  launchLipLift: { v: 3.2, min: 0, max: 8, step: 0.1, label: "lip lift" },
  launchCooldown: { v: 1.15, min: 0.3, max: 4, step: 0.05, label: "launch cooldown" },
  gravity: { v: 15.5, min: 6, max: 30, step: 0.25, label: "air gravity" },
  airSpinRate: { v: 3.1, min: 0.5, max: 8, step: 0.1, label: "air spin" },
  airRollRate: { v: 1.55, min: 0, max: 5, step: 0.05, label: "air roll" },

  // forgiving magnetic landing + on-surface recovery
  landingMagnet: { v: 1.05, min: 0.2, max: 2.5, step: 0.05, label: "landing magnet" },
  softLandingSpeed: { v: 11, min: 3, max: 24, step: 0.5, label: "soft landing" },
  hardLandingRange: { v: 20, min: 5, max: 40, step: 0.5, label: "landing forgiveness" },
  recoveryQuality: { v: 0.22, min: 0, max: 0.75, step: 0.01, label: "recovery threshold" },
  recoveryDuration: { v: 0.75, min: 0.2, max: 2.5, step: 0.05, label: "skim recovery" },
  recoverySpeed: { v: 9, min: 3, max: 18, step: 0.25, label: "recovery speed" },
  recoveryLaunchLock: { v: 0.85, min: 0.2, max: 2, step: 0.05, label: "recovery launch lock" },

  // earned local-only slow motion (world and multiplayer clocks stay normal)
  flowChargeRate: { v: 0.105, min: 0.02, max: 0.35, step: 0.005, label: "flow charge" },
  flowLandingBoost: { v: 0.14, min: 0, max: 0.5, step: 0.01, label: "landing flow" },
  flowReadyThreshold: { v: 0.98, min: 0.5, max: 1, step: 0.01, label: "flow ready" },
  flowDuration: { v: 4.6, min: 1.5, max: 9, step: 0.1, label: "flow duration" },
  flowTimeScale: { v: 0.38, min: 0.18, max: 0.7, step: 0.01, label: "rider time rate" }
});
