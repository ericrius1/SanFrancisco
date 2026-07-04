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
  // airborne stability off ramps/hills: leveling gain + how hard it can push +
  // per-second spin decay. Higher = lands flatter; caps keep a wild launch able
  // to still out-spin the fix and flip.
  airLevel: { v: 5, min: 0, max: 20, step: 0.5, label: "air level" },
  airLevelCap: { v: 3, min: 0, max: 10, step: 0.25, label: "air level cap" },
  airDamp: { v: 1.0, min: 0, max: 8, step: 0.1, label: "air damp" }
});
