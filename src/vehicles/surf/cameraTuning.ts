import { tunables } from "../../core/persist"

/**
 * Behind-the-rider chase framing for arcade surf. Shared by the transient
 * first-use fallback, the dynamically loaded surf rig, and Tweakpane.
 */
export const SURF_CAMERA_TUNING = tunables("camera.surf", {
  // KSPS chase: the eye rides LOW on the flat (shore) side of the rider,
  // trailing the travel direction and looking back AT the surfer, so the wave
  // wall is the backdrop and the camera never crests behind the wave.
  distance: { v: 5.6, min: 3, max: 18, step: 0.25, label: "chase distance" },
  height: { v: 1.7, min: 0.6, max: 10, step: 0.1, label: "camera height" },
  // 0 = pure down-line chase, 1 = square-on at the wave face.
  waveLook: { v: 0.34, min: 0.05, max: 0.95, step: 0.01, label: "face-on look blend" },
  // How quickly the frame follows a genuine travel reversal (double-tap
  // cutback). The swing pivots through the face-on view, never the wall.
  directionResponse: { v: 1.6, min: 0.4, max: 6, step: 0.05, label: "travel follow" },
  lookAhead: { v: 2.8, min: 0.5, max: 20, step: 0.25, label: "look-ahead" },
  targetHeight: { v: 1.05, min: 0.4, max: 4, step: 0.05, label: "aim height" },
  // How much of the rider's altitude the eye follows during airs (KSPS stays
  // low and looks up at the trick).
  airFollow: { v: 0.25, min: 0, max: 1, step: 0.05, label: "air height follow" },
  // How much of the rider's altitude the AIM follows during airs — under 1 the
  // camera looks up at the trick while keeping the waterline in frame (KSPS).
  airAim: { v: 0.55, min: 0.1, max: 1, step: 0.05, label: "air aim follow" },
  positionResponse: { v: 6.5, min: 1.5, max: 18, step: 0.25, label: "position response" },
  aimResponse: { v: 7.5, min: 1.5, max: 20, step: 0.25, label: "aim response" },
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
