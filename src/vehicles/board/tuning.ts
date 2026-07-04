import { tunables } from "../../core/persist";

export const BOARD_TUNING = tunables("movement.board", {
  maxSpeed: { v: 24, min: 5, max: 80, step: 0.5, label: "max speed" },
  boostMaxSpeed: { v: 42, min: 10, max: 120, step: 0.5, label: "boost max" },
  reverseMax: { v: 12, min: 2, max: 30, step: 0.5, label: "reverse max" },
  accel: { v: 15, min: 2, max: 60, step: 0.5, label: "accel" },
  boostAccel: { v: 24, min: 4, max: 80, step: 0.5, label: "boost accel" },
  steerRate: { v: 2.7, min: 0.5, max: 8, step: 0.05, label: "carve rate" },
  jump: { v: 40, min: 2, max: 50, step: 0.5, label: "jump" },
  hover: { v: 1.0, min: 0.4, max: 3, step: 0.05, label: "hover height" },
  coastDrag: { v: 0.45, min: 0.05, max: 2, step: 0.05, label: "coast drag" },
  carveLean: { v: 0.42, min: 0, max: 1.2, step: 0.02, label: "carve lean" },
  gripLat: { v: 0.3 },
  fallGravity: { v: 16 },
  grindSpeed: { v: 3 },
  reverseAccel: { v: 15 },
  reverseGrind: { v: 2.5 }
});
