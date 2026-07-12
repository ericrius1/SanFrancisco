import { tunables } from "../../core/persist";

export const SCOOTER_TUNING = tunables("movement.scooter", {
  maxFactor: { v: 0.82, min: 0.35, max: 1.4, step: 0.01, label: "top speed" },
  accelFactor: { v: 1.35, min: 0.5, max: 2.5, step: 0.05, label: "electric punch" },
  steerFactor: { v: 1.35, min: 0.5, max: 2.2, step: 0.05, label: "steering" }
});
