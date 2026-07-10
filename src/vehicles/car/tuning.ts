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
