import { tunables } from "../../core/persist";

export const PLANE_TUNING = tunables("movement.plane", {
  turnRate: { v: 0.8, min: 0.5, max: 12, step: 0.1, label: "turn rate" },
  mouseYaw: { v: 0.0026, min: 0.0005, max: 0.01, step: 0.0001, label: "mouse yaw" },
  mousePitch: { v: 0.0022, min: 0.0005, max: 0.01, step: 0.0001, label: "mouse pitch" },
  keyYaw: { v: 1.8, min: 0.2, max: 6, step: 0.1, label: "A/D yaw" },
  bankAmount: { v: 0.55, min: 0, max: 2, step: 0.05, label: "bank amount" },
  bankSmooth: { v: 4.5, min: 0.5, max: 20, step: 0.5, label: "bank smooth" },
  spawnSpeed: { v: 45, min: 5, max: 120, step: 1, label: "spawn speed" },
  minSpeed: { v: 18, min: 5, max: 60, step: 1, label: "min speed" },
  maxSpeed: { v: 95, min: 30, max: 250, step: 1, label: "max speed" },
  boostMaxSpeed: { v: 150, min: 50, max: 350, step: 1, label: "boost max" },
  throttleAccel: { v: 42, min: 5, max: 120, step: 1, label: "throttle accel" },
  boostAccel: { v: 30, min: 5, max: 80, step: 1, label: "boost accel" },
  brakeDecel: { v: 55, min: 5, max: 150, step: 1, label: "brake decel" },
  stallThreshold: { v: 34, min: 10, max: 80, step: 1, label: "stall speed" },
  stallSag: { v: 5, min: 0, max: 20, step: 0.5, label: "stall sag" }
});
