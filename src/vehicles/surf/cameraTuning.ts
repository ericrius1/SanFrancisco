import { tunables } from "../../core/persist"

/**
 * Lightweight, single-source framing schema shared by the transient first-use
 * fallback, the dynamically loaded surf rig, and Tweakpane diagnostics. Keeping
 * this metadata separate lets the camera implementation stay out of clean boot.
 */
export const SURF_CAMERA_TUNING = tunables("camera.surf", {
  // Close side angle: rider large, steep face readable, A/D carve obvious.
  // The dedicated tube rig below takes over before this eye reaches the roof.
  distance: { v: 7, min: 5, max: 18, step: 0.25, label: "trail distance" },
  height: { v: 4.2, min: 2, max: 12, step: 0.1, label: "camera height" },
  shoreOffset: { v: 5.5, min: 2, max: 16, step: 0.25, label: "shore offset" },
  lookAhead: { v: 2.5, min: 1, max: 20, step: 0.25, label: "line look-ahead" },
  targetHeight: { v: 1.05, min: 0.5, max: 4, step: 0.05, label: "aim height" },
  positionResponse: { v: 8, min: 2, max: 20, step: 0.25, label: "position response" },
  aimResponse: { v: 10, min: 3, max: 24, step: 0.25, label: "aim response" },
  // How fast the along-beach trail/look blend follows a cutback (never snaps).
  lineResponse: { v: 2.4, min: 0.4, max: 10, step: 0.1, label: "line blend response" },
  orientationResponse: { v: 10, min: 2, max: 24, step: 0.25, label: "orientation slerp" },
  fovSpeed: { v: 24, min: 8, max: 40, step: 0.5, label: "FOV full speed" },
  fovBoost: { v: 3.5, min: 0, max: 4, step: 0.1, label: "FOV boost" },
  fovResponse: { v: 5, min: 1, max: 14, step: 0.25, label: "FOV response" },
  waterClearance: { v: 1.35, min: 0.5, max: 6, step: 0.05, label: "water clearance" },
  sightlineClearance: { v: 0.75, min: 0.2, max: 4, step: 0.05, label: "wave sightline" },

  // Tube transition is intentionally cinematic rather than a cut. Values are
  // exponential responses: 0.9 reaches ~90% in 2.6 seconds. The camera trails
  // the live peel and aims at an opening farther down-line, not at the rider.
  tubeBlendIn: { v: 0.9, min: 0.25, max: 4, step: 0.05, label: "tube blend-in" },
  tubeBlendOut: { v: 1.35, min: 0.25, max: 5, step: 0.05, label: "tube blend-out" },
  tubeDistance: { v: 6.2, min: 3, max: 14, step: 0.1, label: "tube trail distance" },
  tubeHeight: { v: 2.5, min: 0.7, max: 4, step: 0.05, label: "tube eye height" },
  tubeShoreOffset: { v: 0.35, min: -2, max: 3, step: 0.05, label: "tube side offset" },
  tubeLookAhead: { v: 18, min: 8, max: 36, step: 0.25, label: "tube aperture distance" },
  tubeTargetHeight: { v: 2.45, min: 0.7, max: 5, step: 0.05, label: "tube aperture height" },
  tubeWaterClearance: { v: 0.65, min: 0.25, max: 2, step: 0.05, label: "tube water clearance" },
  tubeRoofClearance: { v: 0.7, min: 0.25, max: 2, step: 0.05, label: "tube roof clearance" },
  tubeFovOffset: { v: -3.5, min: -10, max: 4, step: 0.1, label: "tube FOV offset" },
  // Only wave-reset pocket hops should hard-cut; keep this well above carve motion.
  teleportSnapDistance: { v: 55, min: 25, max: 120, step: 1, label: "teleport snap" }
})
