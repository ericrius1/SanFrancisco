import { tunables } from "../../core/persist"

/**
 * Behind-the-rider chase framing for arcade surf. Shared by the transient
 * first-use fallback, the dynamically loaded surf rig, and Tweakpane.
 *
 * One rig, one job: sit behind the board, follow it around, stay out of the
 * wave. The boom trails the live board heading — so the frame turns with you —
 * but its swing is clamped in wave-local terms, which is what keeps the eye on
 * the open shoulder instead of burrowing into the wall when you drop down the
 * face. The barrel view is the same rig eased lower and tighter, never a second
 * camera that snaps into place.
 */
export const SURF_CAMERA_TUNING = tunables("camera.surf", {
  distance: { v: 7, min: 3, max: 18, step: 0.25, label: "chase distance" },
  height: { v: 2.9, min: 0.6, max: 10, step: 0.1, label: "camera height" },
  // How far the boom may swing with the nose, in radians, measured from the
  // down-the-line axis. Up-face swings are free (they park the eye on the flat
  // shoulder); down-face swings are held short so the eye never climbs the wall.
  boomUpSwing: { v: 1.5, min: 0.2, max: 1.5708, step: 0.02, label: "boom up-face swing" },
  boomDownSwing: { v: 0.42, min: 0, max: 1.2, step: 0.02, label: "boom down-face swing" },
  // Constant lean toward the shoulder (radians) so a dead-straight trim line
  // still shows the wave face rather than pure tail.
  shoreBias: { v: 0.2, min: 0, max: 0.9, step: 0.01, label: "shoulder lean" },
  // Boom follow rate. High enough to feel solid and attached, low enough that
  // a hard carve reads as the world turning under a trailing camera.
  followResponse: { v: 4.6, min: 0.5, max: 14, step: 0.1, label: "boom follow" },
  lookAhead: { v: 4.5, min: 0.5, max: 20, step: 0.25, label: "look-ahead" },
  targetHeight: { v: 1.35, min: 0.4, max: 4, step: 0.05, label: "aim height" },
  // Airs are the payoff — the eye rises with the rider and the aim stays on
  // them, so a jump reads as a jump instead of the surfer leaving frame.
  airFollow: { v: 0.62, min: 0, max: 1, step: 0.02, label: "air height follow" },
  airAim: { v: 0.88, min: 0.1, max: 1, step: 0.02, label: "air aim follow" },
  // Extra boom length at the top of a big air so the board stays comfortably
  // inside frame instead of filling it.
  airDistance: { v: 0.16, min: 0, max: 0.6, step: 0.01, label: "air boom stretch" },
  positionResponse: { v: 8, min: 1.5, max: 18, step: 0.25, label: "position response" },
  aimResponse: { v: 9.5, min: 1.5, max: 20, step: 0.25, label: "aim response" },
  orientationResponse: { v: 9, min: 1.5, max: 16, step: 0.25, label: "orientation slerp" },
  fovSpeed: { v: 24, min: 8, max: 40, step: 0.5, label: "FOV full speed" },
  fovBoost: { v: 4, min: 0, max: 6, step: 0.1, label: "FOV boost" },
  fovResponse: { v: 5, min: 1, max: 14, step: 0.25, label: "FOV response" },
  waterClearance: { v: 1.65, min: 0.5, max: 6, step: 0.05, label: "water clearance" },
  sightlineClearance: { v: 0.7, min: 0.2, max: 4, step: 0.05, label: "wave sightline" },

  // Tube handoff: the same boom eased low, short and onto the tube line.
  tubeBlendIn: { v: 2.1, min: 0.25, max: 4, step: 0.05, label: "tube blend-in" },
  tubeBlendOut: { v: 2.2, min: 0.25, max: 5, step: 0.05, label: "tube blend-out" },
  tubeDistance: { v: 5.4, min: 2.5, max: 14, step: 0.1, label: "tube trail distance" },
  tubeHeight: { v: 2.1, min: 0.7, max: 4, step: 0.05, label: "tube eye height" },
  tubeSideBias: { v: 0.25, min: -2, max: 3, step: 0.05, label: "tube side bias" },
  tubeLookAhead: { v: 14, min: 6, max: 36, step: 0.25, label: "tube aperture distance" },
  tubeTargetHeight: { v: 2.35, min: 0.7, max: 5, step: 0.05, label: "tube aperture height" },
  tubeWaterClearance: { v: 0.65, min: 0.25, max: 2, step: 0.05, label: "tube water clearance" },
  tubeRoofClearance: { v: 0.7, min: 0.25, max: 2, step: 0.05, label: "tube roof clearance" },
  tubeFovOffset: { v: -3.5, min: -10, max: 4, step: 0.1, label: "tube FOV offset" },
  // Only wave-reset pocket hops should hard-cut; keep this well above carve motion.
  teleportSnapDistance: { v: 55, min: 25, max: 120, step: 1, label: "teleport snap" }
})

/**
 * Solve the boom angle the eye should trail on. Lives beside the tuning (not in
 * the lazily-imported rig) so the one-frame boot fallback in core/camera.ts can
 * frame identically without pulling the activity chunk into the boot bundle.
 *
 * The board heading is free — the rider can turn all the way around — but the
 * camera is not. Working in the wave's own frame (`base` is the down-the-line
 * axis the rider is travelling, `g` the sign that makes a positive swing point
 * up the face) lets one clamp express the only rule that matters: swing as far
 * as you like toward the open shoulder, barely at all toward the wall.
 *
 * The angle is returned unwrapped inside [−down, π+down], so a genuine
 * turn-around interpolates through π/2 — the face-on view — instead of taking
 * the shorter path straight through the breaking wave.
 */
export function surfBoomAngle(
  boardYaw: number,
  lineDirection: number,
  up: number,
  down: number,
  bias: number
): number {
  const base = lineDirection >= 0 ? Math.PI : 0
  const g = base === 0 ? 1 : -1
  const delta = Math.atan2(Math.sin(boardYaw - base), Math.cos(boardYaw - base))
  const swing = Math.min(up, Math.max(-down, delta * g))
  // The bias leans the eye toward the shoulder; the shared π/2 ceiling is what
  // makes the two branches meet exactly when the rider is square to the beach.
  return base + Math.min(swing + bias, Math.PI / 2) * g
}
