import { tunables } from "../../core/persist";

export const SURF_TUNING = tunables("movement.surf", {
  cruiseSpeed: { v: 10.5, min: 4, max: 25, step: 0.25, label: "cruise speed" },
  maxSpeed: { v: 26, min: 10, max: 50, step: 0.5, label: "max speed" },
  tuckMaxSpeed: { v: 34, min: 14, max: 60, step: 0.5, label: "tuck max" },
  pumpAccel: { v: 10, min: 2, max: 30, step: 0.25, label: "pump accel" },
  faceAccel: { v: 15, min: 2, max: 35, step: 0.25, label: "wave drive" },
  steerRate: { v: 1.9, min: 0.4, max: 4, step: 0.05, label: "carve rate" },
  carveLean: { v: 0.72, min: 0.1, max: 1.2, step: 0.02, label: "carve lean" },
  jump: { v: 11.5, min: 3, max: 25, step: 0.25, label: "air launch" },
  gravity: { v: 15.5, min: 5, max: 30, step: 0.25, label: "air gravity" },
  maxAirTime: { v: 1.65, min: 0.8, max: 3, step: 0.05, label: "landing window" },
  railHeight: { v: 0.22, min: 0.05, max: 0.7, step: 0.01, label: "rail height" },
  grip: { v: 0.18, min: 0, max: 0.8, step: 0.01, label: "lateral slip" },
  coastDrag: { v: 0.12, min: 0.01, max: 0.8, step: 0.01, label: "coast drag" }
});
