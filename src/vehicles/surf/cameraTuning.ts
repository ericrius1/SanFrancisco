import { tunables } from "../../core/persist"

/**
 * Lightweight, single-source framing schema shared by the transient first-use
 * fallback, the dynamically loaded surf rig, and Tweakpane diagnostics. Keeping
 * this metadata separate lets the camera implementation stay out of clean boot.
 */
export const SURF_CAMERA_TUNING = tunables("camera.surf", {
  // Kelly-Slater side angle: rider large, wave face readable, A/D carve obvious.
  // Height sits well above 12 m crests so the eye never clips the green wall.
  distance: { v: 12, min: 7, max: 22, step: 0.25, label: "trail distance" },
  height: { v: 9.5, min: 3, max: 16, step: 0.1, label: "camera height" },
  shoreOffset: { v: 11, min: 4, max: 18, step: 0.25, label: "shore offset" },
  lookAhead: { v: 5, min: 2, max: 14, step: 0.25, label: "line look-ahead" },
  targetHeight: { v: 1.4, min: 0.5, max: 4, step: 0.05, label: "aim height" },
  positionResponse: { v: 8, min: 2, max: 20, step: 0.25, label: "position response" },
  aimResponse: { v: 10, min: 3, max: 24, step: 0.25, label: "aim response" },
  // How fast the along-beach trail/look blend follows a cutback (never snaps).
  lineResponse: { v: 2.4, min: 0.4, max: 10, step: 0.1, label: "line blend response" },
  orientationResponse: { v: 10, min: 2, max: 24, step: 0.25, label: "orientation slerp" },
  fovSpeed: { v: 24, min: 8, max: 40, step: 0.5, label: "FOV full speed" },
  fovBoost: { v: 3.5, min: 0, max: 4, step: 0.1, label: "FOV boost" },
  fovResponse: { v: 5, min: 1, max: 14, step: 0.25, label: "FOV response" },
  waterClearance: { v: 3.4, min: 0.5, max: 6, step: 0.05, label: "water clearance" },
  sightlineClearance: { v: 2.2, min: 0.2, max: 4, step: 0.05, label: "wave sightline" },
  // Only wave-reset pocket hops should hard-cut; keep this well above carve motion.
  teleportSnapDistance: { v: 55, min: 25, max: 120, step: 1, label: "teleport snap" }
})
