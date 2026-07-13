import { tunables } from "../../core/persist";

/**
 * One current arcade-surf schema. The controller is velocity-owned and samples
 * one authoritative `waterHeight()` floor in ride, air landing and
 * recovery. Values intentionally favour readable, forgiving play over weight.
 */
export const SURF_TUNING = tunables("movement.surf", {
  // The rider starts already standing and moving; a short window softens the
  // first carve so the dedicated camera can settle.
  entryAssistDuration: { v: 0.35, min: 0, max: 2, step: 0.05, label: "entry assist" },
  trimSpeed: { v: 16, min: 5, max: 30, step: 0.5, label: "neutral cruise" },
  pumpBoost: { v: 11, min: 0, max: 28, step: 0.5, label: "W / RT boost" },
  stallSpeed: { v: 7.5, min: 3, max: 14, step: 0.25, label: "S / LT floor" },
  maxTrim: { v: 30, min: 12, max: 48, step: 0.5, label: "max line speed" },
  pumpResponse: { v: 5.5, min: 1, max: 14, step: 0.25, label: "pump response" },
  speedResponse: { v: 2.8, min: 0.5, max: 8, step: 0.1, label: "speed response" },
  stallResponse: { v: 6.5, min: 1, max: 16, step: 0.25, label: "stall response" },
  // Kelly-Slater carve: A/D yaw the board on screen; face magnet keeps the pocket.
  yawRate: { v: 2.35, min: 0.5, max: 4.5, step: 0.05, label: "A/D yaw rate" },
  carveResponse: { v: 8.5, min: 1, max: 18, step: 0.25, label: "carve lean response" },
  carveFaceRange: { v: 6.5, min: 0.5, max: 12, step: 0.1, label: "carve face range" },

  // moving-face grip; soft X magnet holds the pocket while A/D yaw freely.
  faceOffset: { v: 6.5, min: 1.5, max: 16, step: 0.1, label: "pocket depth" },
  faceTrack: { v: 1.65, min: 0.2, max: 6, step: 0.05, label: "face magnet" },
  recoveryFaceTrack: { v: 2.4, min: 0.5, max: 8, step: 0.1, label: "recovery magnet" },
  maxFaceCorrection: { v: 14, min: 4, max: 30, step: 0.5, label: "face correction" },
  waveCarry: { v: 0.55, min: 0, max: 1, step: 0.05, label: "wave carry blend" },
  boundaryMargin: { v: 34, min: 10, max: 120, step: 1, label: "cutback margin" },
  waveResetMargin: { v: 92, min: 45, max: 160, step: 1, label: "next-wave margin" },
  railHeight: { v: 0.28, min: 0.12, max: 1, step: 0.01, label: "surface clearance" },
  carveLean: { v: 0.85, min: 0.1, max: 1.3, step: 0.02, label: "carve lean" },
  leanResponse: { v: 9, min: 2, max: 18, step: 0.25, label: "lean response" },
  pitchSampleDistance: { v: 2.2, min: 0.6, max: 6, step: 0.1, label: "pitch sample" },
  pitchFollow: { v: 0.82, min: 0, max: 1.5, step: 0.02, label: "pitch follow" },
  pitchResponse: { v: 8, min: 2, max: 18, step: 0.25, label: "pitch response" },

  // automatic wave launch; less hair-trigger than the first arcade pass
  launchMinSpeed: { v: 19, min: 7, max: 34, step: 0.5, label: "auto launch speed" },
  autoLaunchLip: { v: 0.48, min: 0.15, max: 0.9, step: 0.02, label: "auto launch lip" },
  launchChargeRate: { v: 1.05, min: 0.2, max: 3, step: 0.05, label: "launch charge" },
  launchChargeDecay: { v: 1.1, min: 0, max: 3, step: 0.05, label: "launch decay" },
  launchVelocity: { v: 7.4, min: 2, max: 18, step: 0.2, label: "launch lift" },
  launchSpeedLift: { v: 0.16, min: 0, max: 0.5, step: 0.01, label: "speed lift" },
  launchLipLift: { v: 3.2, min: 0, max: 8, step: 0.1, label: "lip lift" },
  launchCooldown: { v: 1.35, min: 0.3, max: 4, step: 0.05, label: "launch cooldown" },
  gravity: { v: 15.5, min: 6, max: 30, step: 0.25, label: "air gravity" },
  airYawStyle: { v: 0.55, min: 0, max: 1.2, step: 0.02, label: "air yaw style" },
  airRollStyle: { v: 0.72, min: 0, max: 1.5, step: 0.02, label: "air roll style" },
  airAlignResponse: { v: 7.5, min: 2, max: 18, step: 0.25, label: "air auto-align" },

  // forgiving magnetic landing + on-surface recovery
  landingMagnet: { v: 1.05, min: 0.2, max: 2.5, step: 0.05, label: "landing magnet" },
  softLandingSpeed: { v: 11, min: 3, max: 24, step: 0.5, label: "soft landing" },
  hardLandingRange: { v: 34, min: 5, max: 50, step: 0.5, label: "landing forgiveness" },
  recoveryQuality: { v: 0.08, min: 0, max: 0.75, step: 0.01, label: "assist threshold" },
  recoveryDuration: { v: 0.48, min: 0.15, max: 2.5, step: 0.05, label: "auto-save time" },
  recoverySpeed: { v: 9, min: 3, max: 18, step: 0.25, label: "recovery speed" },
  recoveryLaunchLock: { v: 0.85, min: 0.2, max: 2, step: 0.05, label: "recovery launch lock" },

  // earned local-only slow motion (world and multiplayer clocks stay normal)
  flowChargeRate: { v: 0.105, min: 0.02, max: 0.35, step: 0.005, label: "flow charge" },
  flowLandingBoost: { v: 0.14, min: 0, max: 0.5, step: 0.01, label: "landing flow" },
  flowReadyThreshold: { v: 0.98, min: 0.5, max: 1, step: 0.01, label: "flow ready" },
  flowDuration: { v: 4.6, min: 1.5, max: 9, step: 0.1, label: "flow duration" },
  flowTimeScale: { v: 0.38, min: 0.18, max: 0.7, step: 0.01, label: "rider time rate" }
});
