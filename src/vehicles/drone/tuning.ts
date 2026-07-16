import { tunables } from "../../core/persist";

export const DRONE_TUNING = tunables("movement.drone", {
  maxSpeed: { v: 26, min: 5, max: 80, step: 1, label: "max speed" },
  boostMaxSpeed: { v: 62, min: 10, max: 150, step: 1, label: "boost max" },
  vertSpeed: { v: 9, min: 2, max: 30, step: 0.5, label: "climb speed" },
  boostVertSpeed: { v: 17, min: 4, max: 50, step: 0.5, label: "boost climb" },
  response: { v: 2.6, min: 0.5, max: 10, step: 0.1, label: "response" },
  strafeFactor: { v: 0.85, min: 0.2, max: 1, step: 0.05, label: "strafe ×" },
  tiltPerSpeed: { v: 0.016, min: 0, max: 0.05, step: 0.001, label: "tilt/speed" },
  maxTilt: { v: 0.5, min: 0, max: 1, step: 0.02, label: "max tilt" },
  yawFollow: { v: 5.5, min: 0.5, max: 15, step: 0.5, label: "yaw follow" },
  tiltSmooth: { v: 6 }
});
