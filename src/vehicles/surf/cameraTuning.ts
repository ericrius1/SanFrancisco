import { tunables } from "../../core/persist"

/**
 * Behind-the-rider chase framing for arcade surf. Shared by the transient
 * first-use fallback, the dynamically loaded surf rig, and Tweakpane.
 */
export const SURF_CAMERA_TUNING = tunables("camera.surf", {
  // Chase boom: eye sits behind the board facing, looking the same way.
  distance: { v: 8.5, min: 4, max: 18, step: 0.25, label: "chase distance" },
  height: { v: 3.4, min: 1.5, max: 10, step: 0.1, label: "camera height" },
  // Light shoreward bias keeps the face readable without becoming a side cam.
  sideBias: { v: 1.6, min: 0, max: 8, step: 0.1, label: "shore side bias" },
  lookAhead: { v: 4.5, min: 1, max: 20, step: 0.25, label: "look-ahead" },
  targetHeight: { v: 1.15, min: 0.4, max: 4, step: 0.05, label: "aim height" },
  positionResponse: { v: 6.5, min: 1.5, max: 18, step: 0.25, label: "position response" },
  aimResponse: { v: 7.5, min: 1.5, max: 20, step: 0.25, label: "aim response" },
  // How quickly the chase boom yaws to match board heading through a cutback.
  // ~3–5 feels arcade: readable turn, never a whip.
  followYawResponse: { v: 3.6, min: 0.8, max: 12, step: 0.1, label: "follow yaw slerp" },
  orientationResponse: { v: 5.5, min: 1.5, max: 16, step: 0.25, label: "orientation slerp" },
  fovSpeed: { v: 24, min: 8, max: 40, step: 0.5, label: "FOV full speed" },
  fovBoost: { v: 3.5, min: 0, max: 6, step: 0.1, label: "FOV boost" },
  fovResponse: { v: 5, min: 1, max: 14, step: 0.25, label: "FOV response" },
  waterClearance: { v: 1.25, min: 0.5, max: 6, step: 0.05, label: "water clearance" },
  sightlineClearance: { v: 0.7, min: 0.2, max: 4, step: 0.05, label: "wave sightline" },

  // Tube handoff: ease from chase into a low over-tail barrel view.
  tubeBlendIn: { v: 0.9, min: 0.25, max: 4, step: 0.05, label: "tube blend-in" },
  tubeBlendOut: { v: 1.35, min: 0.25, max: 5, step: 0.05, label: "tube blend-out" },
  tubeDistance: { v: 5.4, min: 2.5, max: 14, step: 0.1, label: "tube trail distance" },
  tubeHeight: { v: 2.35, min: 0.7, max: 4, step: 0.05, label: "tube eye height" },
  tubeSideBias: { v: 0.25, min: -2, max: 3, step: 0.05, label: "tube side bias" },
  tubeLookAhead: { v: 14, min: 6, max: 36, step: 0.25, label: "tube aperture distance" },
  tubeTargetHeight: { v: 2.35, min: 0.7, max: 5, step: 0.05, label: "tube aperture height" },
  tubeWaterClearance: { v: 0.65, min: 0.25, max: 2, step: 0.05, label: "tube water clearance" },
  tubeRoofClearance: { v: 0.7, min: 0.25, max: 2, step: 0.05, label: "tube roof clearance" },
  tubeFovOffset: { v: -3.5, min: -10, max: 4, step: 0.1, label: "tube FOV offset" },
  // Only wave-reset pocket hops should hard-cut; keep this well above carve motion.
  teleportSnapDistance: { v: 55, min: 25, max: 120, step: 1, label: "teleport snap" }
})
