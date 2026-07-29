import { tunables } from "../../core/persist";

/**
 * One current arcade-surf schema. The controller is velocity-owned and samples
 * one authoritative `waterHeight()` floor in ride, air landing and
 * recovery. Values intentionally favour readable, forgiving play over weight.
 *
 * Control model: the mouse/trackpad IS the board. Horizontal motion turns the
 * nose (screen-relative, so "push right, go right" never inverts), vertical
 * motion sets how high you ride on the wall, and Space is the only button.
 * Keyboard A/D + W/S and the pad sticks feed the exact same two channels.
 */
export const SURF_TUNING = tunables("movement.surf", {
  // The rider starts already standing and moving; a short window softens the
  // first carve so the dedicated camera can settle.
  entryAssistDuration: { v: 0.22, min: 0, max: 2, step: 0.05, label: "entry assist" },
  trimSpeed: { v: 17.5, min: 5, max: 30, step: 0.5, label: "neutral cruise" },
  stallSpeed: { v: 9, min: 3, max: 14, step: 0.25, label: "pocket stall speed" },
  maxTrim: { v: 34, min: 12, max: 48, step: 0.5, label: "max line speed" },
  speedResponse: { v: 4.4, min: 0.5, max: 8, step: 0.1, label: "speed response" },
  speedDecay: { v: 0.35, min: 0, max: 3, step: 0.05, label: "over-trim bleed" },
  stallResponse: { v: 6.5, min: 1, max: 16, step: 0.25, label: "stall response" },

  // --- mouse / trackpad steering ---------------------------------------------
  // Radians of nose swing per mouse pixel. ~260 px sweeps a quarter turn, so a
  // relaxed wrist covers every line on the wave without ever running out of desk
  // (pointer lock has no edges).
  mouseTurn: { v: 0.0042, min: 0.001, max: 0.02, step: 0.0005, label: "mouse turn per px" },
  // Face placement per mouse pixel: ~230 px from the trough to the lip.
  mouseFace: { v: 0.0045, min: 0.001, max: 0.02, step: 0.0005, label: "mouse climb per px" },
  // Keyboard/left-stick equivalent turn rate (rad/s at full deflection).
  keyTurnRate: { v: 1.9, min: 0.4, max: 4, step: 0.05, label: "key turn rate" },
  // Ceiling on how fast the nose can come around however hard the mouse is
  // whipped — the board keeps its weight, and the camera keeps up.
  maxTurnRate: { v: 3.6, min: 0.8, max: 8, step: 0.1, label: "max turn rate" },
  // Hands off the mouse: the nose eases back onto the nearest down-the-line
  // heading. This is the whole reason surfing stays easy — you cannot get lost.
  trimAssist: { v: 1.35, min: 0, max: 6, step: 0.05, label: "auto-trim strength" },
  // Turning faster than this fully suspends auto-trim (rad/s).
  trimIdleRate: { v: 0.35, min: 0.05, max: 2, step: 0.05, label: "auto-trim release rate" },
  // Mouse-Y self-centre: let go and the board settles back to the trim line.
  faceReturn: { v: 0.85, min: 0, max: 4, step: 0.05, label: "face self-centre" },
  faceInputResponse: { v: 9, min: 1, max: 18, step: 0.25, label: "face response" },
  yawResponse: { v: 6.5, min: 1, max: 14, step: 0.25, label: "recovery heading response" },
  carveResponse: { v: 8.5, min: 1, max: 18, step: 0.25, label: "rail response" },
  carveYawAngle: { v: 0.68, min: 0.2, max: 1.05, step: 0.01, label: "recovery heading angle" },
  // Aiming the nose up the wall also climbs it, so mouse-X alone can set up a
  // launch — you never have to think in two separate axes.
  steerFaceInfluence: { v: 0.36, min: 0, max: 0.8, step: 0.01, label: "turn face influence" },
  steerEnergyInfluence: { v: 0.28, min: 0, max: 1, step: 0.02, label: "turn energy influence" },
  pumpGain: { v: 5.2, min: 0, max: 16, step: 0.2, label: "climb pump gain" },
  // The nose is the face position: full crestward turn parks this close to
  // the lip; full beachward turn drops this far below the trim line.
  faceLineLipOffset: { v: 1.7, min: 1.3, max: 4, step: 0.05, label: "lip hold distance" },
  faceLineDropRange: { v: 6.2, min: 2, max: 8, step: 0.1, label: "drop range" },
  // Carve energy loop: dropping down the face is free speed, climbing bleeds a
  // little back — pumping IS the up/down rhythm, not a boost button.
  dropCarveGain: { v: 9.5, min: 0, max: 24, step: 0.25, label: "drop-in speed gain" },
  climbCarveCost: { v: 6.5, min: 0, max: 16, step: 0.2, label: "climb speed cost" },

  // Wave-local rail contact. Neutral runs low enough that the player has to set
  // a high line, while stall assist holds the authored tube center once earned.
  // Neutral line sits up in the pocket on the standing green wall — not down on
  // the spent apron where the rider read as floating on the flat distant ocean.
  faceOffset: { v: 8.8, min: 4.5, max: 11, step: 0.1, label: "neutral face line" },
  faceTrack: { v: 2.9, min: 0.2, max: 6, step: 0.05, label: "face spring" },
  recoveryFaceTrack: { v: 2.2, min: 0.5, max: 8, step: 0.1, label: "recovery magnet" },
  maxFaceCorrection: { v: 13, min: 4, max: 30, step: 0.5, label: "max cross-face speed" },
  railGrip: { v: 10.5, min: 2, max: 24, step: 0.25, label: "rail adhesion" },
  faceYawInfluence: { v: 0.08, min: 0, max: 1, step: 0.02, label: "yaw cross-face influence" },
  faceCorridorMin: { v: 1.25, min: 0.5, max: 4, step: 0.05, label: "crest contact limit" },
  faceCorridorMax: { v: 14.2, min: 8, max: 18, step: 0.1, label: "shoulder contact limit" },
  tubeStallAssist: { v: 0.96, min: 0, max: 1.2, step: 0.02, label: "stall tube hold" },
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

  // --- jumping ---------------------------------------------------------------
  // Space is never a dead button and never gated: every press leaves the water.
  // Height is earned smoothly by riding high and fast, so a beginner still gets
  // a satisfying hop from anywhere on the wall.
  jumpVelocity: { v: 7.2, min: 2, max: 14, step: 0.1, label: "base pop" },
  launchSpeedLift: { v: 0.14, min: 0, max: 0.5, step: 0.01, label: "speed lift" },
  // Crest distance at which the height bonus has faded to zero.
  launchCrestRange: { v: 10, min: 3, max: 16, step: 0.25, label: "lip bonus range" },
  launchLipLift: { v: 5.6, min: 0, max: 10, step: 0.1, label: "lip lift" },
  // Vertical momentum carries: hitting the lip while still climbing adds real
  // height — big airs come from reading the wave.
  launchClimbLift: { v: 0.62, min: 0, max: 1.5, step: 0.02, label: "climb-rate lift" },
  maxLaunchVelocity: { v: 14.5, min: 6, max: 26, step: 0.5, label: "pop ceiling" },
  launchCooldown: { v: 0.28, min: 0.05, max: 2, step: 0.01, label: "launch cooldown" },
  popBuffer: { v: 0.28, min: 0.05, max: 0.6, step: 0.01, label: "pop input buffer" },
  gravity: { v: 13.5, min: 6, max: 30, step: 0.25, label: "air gravity" },
  // Airborne steering: the same mouse keeps working, scaled down so a jump is a
  // controllable arc you can spin for style and still land clean.
  airTurnScale: { v: 0.85, min: 0, max: 2, step: 0.05, label: "air turn scale" },
  airPitchInput: { v: 0.42, min: 0, max: 1, step: 0.02, label: "air nose authority" },
  airPitchScale: { v: 0.024, min: 0.005, max: 0.06, step: 0.001, label: "air pitch from lift" },
  airPitchLimit: { v: 0.55, min: 0.12, max: 0.9, step: 0.01, label: "air pitch limit" },
  airAlignResponse: { v: 7.5, min: 2, max: 18, step: 0.25, label: "air pose settle" },
  // Big airs with a full meter drop into Flow automatically — the reward for
  // reading the wave, with no extra button to remember.
  flowAutoLaunchSpeed: { v: 12.5, min: 6, max: 24, step: 0.5, label: "auto-flow pop speed" },

  // forgiving magnetic landing + on-surface recovery
  landingMagnet: { v: 1.35, min: 0.2, max: 2.5, step: 0.05, label: "landing magnet" },
  softLandingSpeed: { v: 13, min: 3, max: 24, step: 0.5, label: "soft landing" },
  hardLandingRange: { v: 40, min: 5, max: 50, step: 0.5, label: "landing forgiveness" },
  recoveryQuality: { v: 0.08, min: 0, max: 0.75, step: 0.01, label: "assist threshold" },
  recoveryDuration: { v: 0.4, min: 0.15, max: 2.5, step: 0.05, label: "auto-save time" },
  recoverySpeed: { v: 9, min: 3, max: 18, step: 0.25, label: "recovery speed" },
  recoveryLaunchLock: { v: 0.3, min: 0.05, max: 2, step: 0.05, label: "recovery launch lock" },

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
