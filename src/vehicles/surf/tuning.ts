import { tunables } from "../../core/persist";

/**
 * One current arcade-surf schema. The controller is velocity-owned and samples
 * one authoritative `waterHeight()` floor in ride, air landing and
 * recovery. Values intentionally favour readable, forgiving play over weight.
 */
export const SURF_TUNING = tunables("movement.surf", {
  // The rider starts already standing and moving; a short window softens the
  // first carve so the dedicated camera can settle.
  entryAssistDuration: { v: 0.22, min: 0, max: 2, step: 0.05, label: "entry assist" },
  trimSpeed: { v: 17.5, min: 5, max: 30, step: 0.5, label: "neutral cruise" },
  pumpBoost: { v: 14, min: 0, max: 28, step: 0.5, label: "W / RT boost" },
  stallSpeed: { v: 7.5, min: 3, max: 14, step: 0.25, label: "S / LT floor" },
  maxTrim: { v: 34, min: 12, max: 48, step: 0.5, label: "max line speed" },
  pumpResponse: { v: 7.5, min: 1, max: 14, step: 0.25, label: "pump response" },
  speedResponse: { v: 4.4, min: 0.5, max: 8, step: 0.1, label: "speed response" },
  stallResponse: { v: 6.5, min: 1, max: 16, step: 0.25, label: "stall response" },
  // Kelly-Slater carve: A/D sets the rail and moves across the face while a
  // wave-local contact solve keeps the board tangent to the rendered wall.
  carveYawAngle: { v: 0.68, min: 0.2, max: 1.05, step: 0.01, label: "carve heading angle" },
  yawResponse: { v: 6.5, min: 1, max: 14, step: 0.25, label: "carve heading response" },
  // Continuous carve: how fast A/D swing the heading (rad/s at full stick). High
  // enough to whip a full cutback in ~1.3 s; the wave still constrains the line.
  carveTurnRate: { v: 2.6, min: 0.6, max: 5, step: 0.1, label: "carve turn rate" },
  // How firmly a neutral stick eases the heading back to the nearest down-line.
  yawRecenter: { v: 2.4, min: 0, max: 8, step: 0.1, label: "carve re-center" },
  carveResponse: { v: 10, min: 1, max: 18, step: 0.25, label: "carve lean response" },
  carveFaceRange: { v: 6.2, min: 0.5, max: 9, step: 0.1, label: "carve face range" },

  // Wave-local rail contact. Neutral runs low enough that the player has to set
  // a high line, while stall assist holds the authored tube center once earned.
  // Neutral line sits up in the pocket on the standing green wall — not down on
  // the spent apron where the rider read as floating on the flat distant ocean.
  faceOffset: { v: 6.5, min: 4.5, max: 11, step: 0.1, label: "neutral face line" },
  faceTrack: { v: 2.35, min: 0.2, max: 6, step: 0.05, label: "face spring" },
  recoveryFaceTrack: { v: 2.2, min: 0.5, max: 8, step: 0.1, label: "recovery magnet" },
  maxFaceCorrection: { v: 13, min: 4, max: 30, step: 0.5, label: "max cross-face speed" },
  railGrip: { v: 10.5, min: 2, max: 24, step: 0.25, label: "rail adhesion" },
  faceYawInfluence: { v: 0.08, min: 0, max: 1, step: 0.02, label: "yaw cross-face influence" },
  faceCorridorMin: { v: 1.25, min: 0.5, max: 4, step: 0.05, label: "crest contact limit" },
  faceCorridorMax: { v: 14.2, min: 8, max: 18, step: 0.1, label: "shoulder contact limit" },
  tubeStallAssist: { v: 0.88, min: 0, max: 1.2, step: 0.02, label: "stall tube hold" },
  boundaryMargin: { v: 34, min: 10, max: 120, step: 1, label: "cutback margin" },
  // Hand the rider to the next set before shore attenuation flattens the face.
  waveResetMargin: { v: 96, min: 45, max: 160, step: 1, label: "next-wave margin" },
  // Board-local y=0 is the hull center plane; the visible shell bottoms near
  // -0.065 m. Keep that shell just above the water and let the fins submerge,
  // as a real surfboard does. The five-point solve prevents deck penetration.
  railHeight: { v: 0.2, min: 0.08, max: 0.5, step: 0.01, label: "hull waterline" },
  // Cap vertical catch-up so trough/crest transitions never read as teleports.
  maxSurfaceVy: { v: 28, min: 8, max: 80, step: 1, label: "max surface climb" },
  carveLean: { v: 0.95, min: 0.1, max: 1.3, step: 0.02, label: "carve lean" },
  leanResponse: { v: 11, min: 2, max: 18, step: 0.25, label: "lean response" },
  // Cant the deck into the face for readability, but never roll it up the
  // near-vertical wall far enough to lay the standing rider flat on their side.
  surfaceBankFollow: { v: 0.42, min: 0, max: 1.2, step: 0.02, label: "surface normal follow" },
  pitchFollow: { v: 1, min: 0, max: 1.5, step: 0.02, label: "pitch follow" },
  pitchResponse: { v: 8, min: 2, max: 18, step: 0.25, label: "pitch response" },

  // automatic wave launch; reachable off a committed high-line pump at the lip
  launchMinSpeed: { v: 16, min: 7, max: 34, step: 0.5, label: "auto launch speed" },
  autoLaunchLip: { v: 0.34, min: 0.15, max: 0.9, step: 0.02, label: "auto launch lip" },
  launchChargeRate: { v: 4.6, min: 0.2, max: 6, step: 0.05, label: "launch charge" },
  launchChargeDecay: { v: 1.1, min: 0, max: 3, step: 0.05, label: "launch decay" },
  launchFacewardSpeed: { v: 0.25, min: 0, max: 6, step: 0.05, label: "lip approach speed" },
  launchVelocity: { v: 8.4, min: 2, max: 18, step: 0.2, label: "launch lift" },
  launchSpeedLift: { v: 0.16, min: 0, max: 0.5, step: 0.01, label: "speed lift" },
  launchLipLift: { v: 3.2, min: 0, max: 8, step: 0.1, label: "lip lift" },
  launchCooldown: { v: 0.85, min: 0.3, max: 4, step: 0.05, label: "launch cooldown" },
  gravity: { v: 15.5, min: 6, max: 30, step: 0.25, label: "air gravity" },
  airYawStyle: { v: 3.45, min: 0, max: 4.5, step: 0.05, label: "air yaw style" },
  airRollStyle: { v: 0.85, min: 0, max: 1.5, step: 0.02, label: "air roll style" },
  airAlignResponse: { v: 7.5, min: 2, max: 18, step: 0.25, label: "air auto-align" },

  // forgiving magnetic landing + on-surface recovery
  landingMagnet: { v: 1.05, min: 0.2, max: 2.5, step: 0.05, label: "landing magnet" },
  softLandingSpeed: { v: 11, min: 3, max: 24, step: 0.5, label: "soft landing" },
  hardLandingRange: { v: 34, min: 5, max: 50, step: 0.5, label: "landing forgiveness" },
  recoveryQuality: { v: 0.08, min: 0, max: 0.75, step: 0.01, label: "assist threshold" },
  recoveryDuration: { v: 0.48, min: 0.15, max: 2.5, step: 0.05, label: "auto-save time" },
  recoverySpeed: { v: 9, min: 3, max: 18, step: 0.25, label: "recovery speed" },
  recoveryLaunchLock: { v: 0.85, min: 0.2, max: 2, step: 0.05, label: "recovery launch lock" },

  // Earned tube ride: climb onto the signed tube line, stay supported, then
  // either pump through or stall to let the roof wrap over the camera.
  tubeEnterDepth: { v: 0.58, min: 0.2, max: 0.9, step: 0.02, label: "tube entry depth" },
  tubeEnterTime: { v: 0.52, min: 0.1, max: 2, step: 0.02, label: "tube entry dwell" },
  tubeExitTime: { v: 0.75, min: 0.15, max: 2.5, step: 0.05, label: "tube exit grace" },
  tubeMinSpeed: { v: 8.5, min: 4, max: 20, step: 0.25, label: "tube minimum speed" },
  tubeStallDwellBoost: { v: 1.45, min: 1, max: 2.5, step: 0.05, label: "stall entry boost" },

  // earned local-only slow motion (world and multiplayer clocks stay normal)
  flowChargeRate: { v: 0.105, min: 0.02, max: 0.35, step: 0.005, label: "flow charge" },
  flowLandingBoost: { v: 0.14, min: 0, max: 0.5, step: 0.01, label: "landing flow" },
  flowReadyThreshold: { v: 0.98, min: 0.5, max: 1, step: 0.01, label: "flow ready" },
  flowDuration: { v: 4.6, min: 1.5, max: 9, step: 0.1, label: "flow duration" },
  flowTimeScale: { v: 0.38, min: 0.18, max: 0.7, step: 0.01, label: "rider time rate" }
});
