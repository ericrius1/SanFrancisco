import { tunables } from "../../core/persist";

// Live handling tuning, bound in the "/" debug panel and persisted to
// localStorage. Each line is the default (`v`) plus its slider range; entries
// with only a `v` are tuned constants without a slider.
export const CAR_TUNING = tunables("movement.drive", {
  maxSpeed: { v: 34, min: 10, max: 120, step: 1, label: "max speed" },
  boostMaxSpeed: { v: 55, min: 20, max: 200, step: 1, label: "boost max" },
  reverseMax: { v: 12, min: 2, max: 30, step: 0.5, label: "reverse max" },
  accel: { v: 18, min: 4, max: 60, step: 1, label: "accel" },
  boostAccel: { v: 26, min: 8, max: 80, step: 1, label: "boost accel" },
  steerRate: { v: 1.7, min: 0.5, max: 5, step: 0.05, label: "steer rate" },
  driftSteerRate: { v: 2.4, min: 0.5, max: 8, step: 0.05, label: "drift steer" },
  grindSpeed: { v: 3.5, min: 0, max: 12, step: 0.1, label: "grind speed" },
  coastDrag: { v: 0.9, min: 0.1, max: 3, step: 0.05, label: "coast drag" },
  reverseAccel: { v: 24 },
  reverseGrind: { v: 2.5 },
  gripLat: { v: 0.12 },
  driftLat: { v: 0.86 },
  rideSpring: { v: 10 },
  groundNormalResponse: { v: 12 },

  // Bumper power-slide (LB/RB, keyboard [ / ]). Arcade slip with a soft engage /
  // recover blend so it feels punchy rather than icy or binary. Space handbrake
  // stays the looser classic drift; bumpers are the directional kart-style slide.
  slideLat: { v: 0.4, min: 0.2, max: 0.95, step: 0.01, label: "slide slip" },
  slideYaw: { v: 0.7, min: 0, max: 4, step: 0.05, label: "slide yaw" },
  slideSteerRate: { v: 1.85, min: 0.5, max: 6, step: 0.05, label: "slide steer" },
  slideSlip: { v: 4.5, min: 0, max: 28, step: 0.5, label: "slide push" },
  slideBuild: { v: 5, min: 1, max: 20, step: 0.5, label: "slide build" },
  slideEngage: { v: 8, min: 2, max: 24, step: 0.5, label: "slide engage" },
  slideRecover: { v: 10, min: 2, max: 24, step: 0.5, label: "slide recover" },
  slideMinSpeed: { v: 6, min: 0, max: 20, step: 0.5, label: "slide min speed" },
  slideRefSpeed: { v: 18, min: 4, max: 40, step: 0.5, label: "slide ref speed" },
  slideSteerInto: { v: 0.3, min: 0, max: 1.5, step: 0.05, label: "steer-into boost" },
  // Snap turbo: release a held bumper slide for a short speed pop.
  slideBoostImpulse: { v: 4, min: 0, max: 25, step: 0.5, label: "snap boost" },
  slideBoostMinTime: { v: 0.28, min: 0, max: 1.5, step: 0.02, label: "snap hold" },
  slideBoostDecay: { v: 3.2, min: 0.5, max: 12, step: 0.1, label: "snap decay" },

  // Jump state hysteresis. Clearance is measured from the chassis centre to the
  // current ride target (road + rideHeight), not from the centre to raw terrain.
  // This keeps the nose-on-ramp phase supported, then latches one clean takeoff.
  takeoffClearance: { v: 0.5, min: 0.15, max: 1.2, step: 0.05, label: "takeoff gap" },
  takeoffMinVerticalSpeed: { v: 0.75 },
  minimumAirTime: { v: 0.18 },
  landingClearance: { v: 0.2, min: -0.4, max: 0.8, step: 0.05, label: "landing gap" },
  landingMaxVerticalSpeed: { v: 0.65 },
  landingMaxFallSpeed: { v: 8 },
  landingConfirmSteps: { v: 2 },
  landingBlendRate: { v: 9, min: 2, max: 20, step: 0.5, label: "landing blend" },
  landingAssistHeight: { v: 2.5, min: 0.5, max: 6, step: 0.25, label: "landing align" },
  landingAssistDescentSpeed: { v: 2 },

  // Critically-damped airborne pitch/roll assist. kp is angular stiffness (s^-2)
  // and kd is damping (s^-1); kd=2*sqrt(kp) is critical. The short hold preserves
  // the ramp's launch attitude before the arcade assist eases in.
  airHold: { v: 0.1, min: 0, max: 0.4, step: 0.01, label: "air pose hold" },
  airBlendTime: { v: 0.22, min: 0.05, max: 0.8, step: 0.01, label: "air assist fade" },
  airKp: { v: 16, min: 0, max: 36, step: 1, label: "air stiffness" },
  airKd: { v: 8, min: 0, max: 16, step: 0.5, label: "air damping" },
  airMaxAcceleration: { v: 22, min: 4, max: 40, step: 1, label: "air torque cap" },
  airYawDamping: { v: 2.5 },
  airYawAcceleration: { v: 3.5, min: 0, max: 10, step: 0.25, label: "air steer" }
});

// A confirmed touchdown is converted into one normalized 0..1 impact. Height
// measures the largest suspension clearance during the jump; fall distance is
// the apex-to-touchdown drop. Presentation systems consume the resulting event,
// but all of their authoring ranges live here in the car's own tuning folder.
export const CAR_LANDING_TUNING = tunables("movement.drive.landingFeedback", {
  enabled: { v: true, label: "enabled" },
  minHeight: { v: 0.65, min: 0, max: 4, step: 0.05, label: "min jump height" },
  maxHeight: { v: 6.5, min: 1, max: 20, step: 0.25, label: "max jump height" },
  minFallDistance: { v: 0.5, min: 0, max: 4, step: 0.05, label: "min fall distance" },
  maxFallDistance: { v: 6, min: 1, max: 20, step: 0.25, label: "max fall distance" },
  heightWeight: { v: 0.4, min: 0, max: 1, step: 0.05, label: "height influence" },
  responseCurve: { v: 0.7, min: 0.25, max: 2.5, step: 0.05, label: "impact curve" },
  shakeMin: { v: 0.05, min: 0, max: 0.5, step: 0.01, label: "shake min" },
  shakeMax: { v: 0.48, min: 0, max: 1.6, step: 0.02, label: "shake max" },
  soundMin: { v: 0.9, min: 0, max: 3, step: 0.05, label: "sound min" },
  soundMax: { v: 1.8, min: 0, max: 3, step: 0.05, label: "sound max" },
  smokeMin: { v: 2, min: 0, max: 12, step: 1, label: "smoke puffs min" },
  smokeMax: { v: 7, min: 0, max: 18, step: 1, label: "smoke puffs max" },
  smokeScaleMin: { v: 0.55, min: 0.1, max: 3, step: 0.05, label: "smoke size min" },
  smokeScaleMax: { v: 1.35, min: 0.1, max: 5, step: 0.05, label: "smoke size max" },
  smokeSpread: { v: 2.2, min: 0, max: 5, step: 0.1, label: "smoke spread" },
  smokeLife: { v: 0.8, min: 0.2, max: 2.5, step: 0.05, label: "smoke life" }
});

/** Skid-mark + skid-audio presentation for bumper slides / handbrake. */
export const CAR_SKID_TUNING = tunables("movement.drive.skid", {
  markLife: { v: 5.5, min: 1, max: 14, step: 0.25, label: "mark life" },
  markOpacity: { v: 0.42, min: 0.05, max: 1, step: 0.02, label: "mark opacity" },
  markWidth: { v: 0.14, min: 0.05, max: 0.4, step: 0.01, label: "mark width" },
  markLength: { v: 0.75, min: 0.2, max: 2, step: 0.05, label: "mark length" },
  markSpacing: { v: 0.5, min: 0.15, max: 2, step: 0.05, label: "mark spacing" },
  audioGain: { v: 0.11, min: 0, max: 0.4, step: 0.01, label: "skid volume" },
  audioTone: { v: 340, min: 120, max: 900, step: 10, label: "skid tone Hz" }
});
