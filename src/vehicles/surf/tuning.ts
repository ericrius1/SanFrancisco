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
  stallSpeed: { v: 7.5, min: 3, max: 14, step: 0.25, label: "wash speed floor" },
  maxTrim: { v: 34, min: 12, max: 48, step: 0.5, label: "max line speed" },
  speedResponse: { v: 4.4, min: 0.5, max: 8, step: 0.1, label: "speed response" },
  speedDecay: { v: 0.35, min: 0, max: 3, step: 0.05, label: "over-trim bleed" },
  stallResponse: { v: 6.5, min: 1, max: 16, step: 0.25, label: "stall response" },
  // KSPS-style decoupled axes. A/D swing the rail relative to the remembered
  // travel direction and clamp short of vertical (you can never accidentally
  // flip); W/S place you up/down the face directly.
  carveYawAngle: { v: 0.68, min: 0.2, max: 1.05, step: 0.01, label: "recovery heading angle" },
  carveMaxAngle: { v: 1.12, min: 0.4, max: 1.5, step: 0.02, label: "max rail swing" },
  yawResponse: { v: 6.5, min: 1, max: 14, step: 0.25, label: "carve heading response" },
  carveResponse: { v: 8.5, min: 1, max: 18, step: 0.25, label: "rail swing response" },
  // Deliberate roundhouse: double-tap the carve direction. Holding full lock
  // is ordinary hard carving and must never reverse on its own.
  cutbackTapWindow: { v: 0.34, min: 0.15, max: 0.8, step: 0.01, label: "cutback double-tap window" },
  // The nose is the face position: full crestward carve parks this close to
  // the lip; full beachward carve drops this far below the trim line.
  faceLineLipOffset: { v: 1.7, min: 1.3, max: 4, step: 0.05, label: "lip hold distance" },
  faceLineDropRange: { v: 6.2, min: 2, max: 8, step: 0.1, label: "drop range" },
  // Carve energy loop: dropping down the face is free speed, climbing bleeds a
  // little back — pumping IS the W/S rhythm, not a boost button.
  dropCarveGain: { v: 9.5, min: 0, max: 24, step: 0.25, label: "drop-in speed gain" },
  climbCarveCost: { v: 6.5, min: 0, max: 16, step: 0.2, label: "climb speed cost" },

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

  // Lip pop: Space/A ollies when the board is on the lip; W + high line still
  // auto-charges a launch. Manual pop is intentionally more forgiving.
  launchMinSpeed: { v: 14, min: 7, max: 34, step: 0.5, label: "launch min speed" },
  manualLaunchMinSpeed: { v: 11, min: 5, max: 28, step: 0.5, label: "Space pop min speed" },
  autoLaunchLip: { v: 0.28, min: 0.15, max: 0.9, step: 0.02, label: "auto launch lip" },
  manualLaunchLip: { v: 0.18, min: 0.05, max: 0.8, step: 0.02, label: "Space pop lip" },
  manualLaunchCrest: { v: 6.8, min: 3, max: 12, step: 0.1, label: "Space pop crest dist" },
  launchChargeRate: { v: 5.2, min: 0.2, max: 8, step: 0.05, label: "auto launch charge" },
  launchChargeDecay: { v: 1.1, min: 0, max: 3, step: 0.05, label: "launch decay" },
  launchFacewardSpeed: { v: 0.2, min: 0, max: 6, step: 0.05, label: "lip approach speed" },
  // Pop height: readable aerial without flinging the chase cam into the sky.
  launchVelocity: { v: 6.5, min: 2, max: 18, step: 0.2, label: "launch lift" },
  launchSpeedLift: { v: 0.16, min: 0, max: 0.5, step: 0.01, label: "speed lift" },
  launchLipLift: { v: 3.2, min: 0, max: 8, step: 0.1, label: "lip lift" },
  // Vertical momentum carries: hitting the lip while still climbing (W held)
  // adds real height — big airs come from reading the wave.
  launchClimbLift: { v: 0.62, min: 0, max: 1.5, step: 0.02, label: "climb-rate lift" },
  launchCooldown: { v: 0.75, min: 0.3, max: 4, step: 0.05, label: "launch cooldown" },
  popBuffer: { v: 0.22, min: 0.05, max: 0.6, step: 0.01, label: "pop input buffer" },
  // Space away from the lip is a small chop hop, never a dead button.
  ollieVelocity: { v: 4.6, min: 1.5, max: 10, step: 0.1, label: "ollie lift" },
  ollieSpeedLift: { v: 0.06, min: 0, max: 0.3, step: 0.01, label: "ollie speed lift" },
  ollieCooldown: { v: 0.5, min: 0.2, max: 2, step: 0.05, label: "ollie cooldown" },
  gravity: { v: 15.5, min: 6, max: 30, step: 0.25, label: "air gravity" },
  // Aerials are natural surf pops, not trick rotations. Vertical speed raises
  // the nose on ascent and lowers it on descent while roll settles back toward
  // level for a readable, feet-planted landing.
  airPitchScale: { v: 0.024, min: 0.005, max: 0.06, step: 0.001, label: "air pitch from lift" },
  airPitchLimit: { v: 0.48, min: 0.12, max: 0.8, step: 0.01, label: "air pitch limit" },
  airAlignResponse: { v: 7.5, min: 2, max: 18, step: 0.25, label: "air pose settle" },

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
  // Exit spit: a real barrel rewards the exit with a speed burst + spray.
  spitMinDwell: { v: 0.8, min: 0.2, max: 3, step: 0.05, label: "spit min barrel time" },
  spitBoost: { v: 6.5, min: 0, max: 14, step: 0.25, label: "spit speed boost" },

  // earned local-only slow motion (world and multiplayer clocks stay normal)
  flowChargeRate: { v: 0.105, min: 0.02, max: 0.35, step: 0.005, label: "flow charge" },
  flowLandingBoost: { v: 0.14, min: 0, max: 0.5, step: 0.01, label: "landing flow" },
  flowReadyThreshold: { v: 0.98, min: 0.5, max: 1, step: 0.01, label: "flow ready" },
  flowDuration: { v: 4.6, min: 1.5, max: 9, step: 0.1, label: "flow duration" },
  flowTimeScale: { v: 0.38, min: 0.18, max: 0.7, step: 0.01, label: "rider time rate" }
});
