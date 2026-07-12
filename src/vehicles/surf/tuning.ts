import { tunables } from "../../core/persist";

/**
 * Kelly-Slater-style arcade surf. Two phases share this block:
 *  · PADDLE — prone, paddle out from the beach into the lineup and into a wave.
 *  · RIDE   — popped up, pinned to the moving wave face; A/D carves up/down it,
 *             W pumps for speed down the line, Shift tucks, Space launches the lip.
 * The board is kinematic (gravity off): the wave carries it, so it can never be
 * swept onto the sand — a closed-out wave just drops you back to paddling.
 */
export const SURF_TUNING = tunables("movement.surf", {
  // paddle phase
  paddleSpeed: { v: 7.5, min: 3, max: 16, step: 0.25, label: "paddle speed" },
  paddleAccel: { v: 9, min: 2, max: 20, step: 0.5, label: "paddle accel" },
  paddleTurn: { v: 2.1, min: 0.5, max: 4, step: 0.05, label: "paddle turn" },
  proneHeight: { v: 0.12, min: 0.02, max: 0.5, step: 0.01, label: "prone height" },

  // catching a wave
  catchFace: { v: 0.34, min: 0.1, max: 0.9, step: 0.02, label: "catch steepness" },

  // ride phase — face position + trim
  climbRate: { v: 5, min: 1, max: 12, step: 0.5, label: "carve response" },
  baseOffset: { v: 15, min: 6, max: 26, step: 0.5, label: "shoulder offset" },
  lipOffset: { v: 3.2, min: 1, max: 8, step: 0.1, label: "lip offset" },
  trackGain: { v: 9, min: 3, max: 20, step: 0.5, label: "face grip" },

  trimSpeed: { v: 15, min: 6, max: 30, step: 0.5, label: "line speed" },
  pumpBoost: { v: 9, min: 0, max: 20, step: 0.5, label: "pump boost" },
  tuckBoost: { v: 7, min: 0, max: 20, step: 0.5, label: "tuck boost" },
  maxTrim: { v: 27, min: 12, max: 45, step: 0.5, label: "max line speed" },

  railHeight: { v: 0.34, min: 0.05, max: 0.8, step: 0.01, label: "rail height" },
  carveLean: { v: 0.8, min: 0.1, max: 1.3, step: 0.02, label: "carve lean" },

  // airs off the lip
  jump: { v: 12, min: 4, max: 26, step: 0.25, label: "air launch" },
  gravity: { v: 17, min: 6, max: 32, step: 0.25, label: "air gravity" }
});
