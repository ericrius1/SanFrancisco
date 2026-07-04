import { tunables } from "../../core/persist";

export const BOAT_TUNING = tunables("movement.boat", {
  maxSpeed: { v: 14, min: 4, max: 50, step: 0.5, label: "max speed" },
  boostMaxSpeed: { v: 22, min: 8, max: 80, step: 0.5, label: "boost max" },
  reverseMax: { v: 7, min: 1, max: 20, step: 0.5, label: "reverse max" },
  accel: { v: 7, min: 1, max: 30, step: 0.5, label: "accel" },
  boostAccel: { v: 10, min: 2, max: 40, step: 0.5, label: "boost accel" },
  steerRate: { v: 1.1, min: 0.2, max: 4, step: 0.05, label: "steer rate" },
  shallowFactor: { v: 0.35, min: 0.05, max: 1, step: 0.05, label: "shallow ×" },
  coastDrag: { v: 0.5, min: 0.1, max: 2, step: 0.05, label: "coast drag" },
  reverseAccel: { v: 8 },
  gripLat: { v: 0.82 }
});
