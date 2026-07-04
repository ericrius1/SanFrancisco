import { tunables } from "../../core/persist";

// Parade-truck handling — a heavier, statelier cousin of the sports car (same
// field set so TruckController can share CarController's control math). Bound in
// the "/" panel, persisted to localStorage.
export const TRUCK_TUNING = tunables("movement.truck", {
  maxSpeed: { v: 26, min: 8, max: 90, step: 1, label: "max speed" },
  boostMaxSpeed: { v: 42, min: 16, max: 140, step: 1, label: "boost max" },
  reverseMax: { v: 10, min: 2, max: 30, step: 0.5, label: "reverse max" },
  accel: { v: 13, min: 4, max: 50, step: 1, label: "accel" },
  boostAccel: { v: 20, min: 6, max: 70, step: 1, label: "boost accel" },
  steerRate: { v: 1.45, min: 0.5, max: 5, step: 0.05, label: "steer rate" },
  driftSteerRate: { v: 2.0, min: 0.5, max: 8, step: 0.05, label: "drift steer" },
  grindSpeed: { v: 3.0, min: 0, max: 12, step: 0.1, label: "grind speed" },
  coastDrag: { v: 0.9, min: 0.1, max: 3, step: 0.05, label: "coast drag" },
  reverseAccel: { v: 20 },
  reverseGrind: { v: 2.5 },
  gripLat: { v: 0.14 },
  driftLat: { v: 0.82 },
  rideSpring: { v: 10 }
});
