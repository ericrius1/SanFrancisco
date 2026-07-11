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

/**
 * Halo-fin comet: a chain of additive orbs riding the energy ring. The whole
 * look is tuned live — animateBoard reads .values every frame, so every slider
 * (including orb count) acts without a mesh rebuild. The signature move: the
 * comet whips through the ring's sides and stalls at top/bottom, where the
 * stretched tail collapses into a concentric stack — a dark outer sphere with
 * white light shining from inside.
 */
export const HALO_TUNING = tunables("board.halo", {
  count: { v: 7, min: 2, max: 12, step: 1, label: "comet count" },
  orbitSpeed: { v: 2.6, min: 0.4, max: 8, step: 0.05, label: "orbit speed" },
  slowdown: { v: 0.72, min: 0, max: 0.95, step: 0.01, label: "pole stall" },
  tailSpread: { v: 1.6, min: 0.2, max: 4, step: 0.05, label: "tail whip" },
  collapse: { v: 4, min: 1, max: 12, step: 0.1, label: "collapse snap" },
  taper: { v: 0.8, min: 0.5, max: 0.95, step: 0.01, label: "orb taper" },
  hueDeep: { v: 232, min: 0, max: 360, step: 1, label: "deep hue" },
  hueGlow: { v: 187, min: 0, max: 360, step: 1, label: "glow hue" },
  whiten: { v: 0.85, min: 0, max: 1, step: 0.01, label: "tip whiten" },
  sat: { v: 0.85, min: 0, max: 1, step: 0.01, label: "saturation" }
});
