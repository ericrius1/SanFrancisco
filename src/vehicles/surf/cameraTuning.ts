import { tunables } from "../../core/persist"

/**
 * Lightweight, single-source framing schema shared by the transient first-use
 * fallback, the dynamically loaded surf rig, and Tweakpane diagnostics. Keeping
 * this metadata separate lets the camera implementation stay out of clean boot.
 */
export const SURF_CAMERA_TUNING = tunables("camera.surf", {
  // Closer Kelly-Slater side angle: rider large, wave face readable, A/D carve
  // obvious in screen space.
  distance: { v: 10.5, min: 7, max: 22, step: 0.25, label: "trail distance" },
  height: { v: 6.2, min: 3, max: 14, step: 0.1, label: "camera height" },
  shoreOffset: { v: 7.5, min: 4, max: 16, step: 0.25, label: "shore offset" },
  lookAhead: { v: 6.5, min: 2, max: 14, step: 0.25, label: "line look-ahead" },
  targetHeight: { v: 1.35, min: 0.5, max: 4, step: 0.05, label: "aim height" },
  positionResponse: { v: 9, min: 2, max: 20, step: 0.25, label: "position response" },
  aimResponse: { v: 12, min: 3, max: 24, step: 0.25, label: "aim response" },
  fovSpeed: { v: 24, min: 8, max: 40, step: 0.5, label: "FOV full speed" },
  fovBoost: { v: 3.5, min: 0, max: 4, step: 0.1, label: "FOV boost" },
  fovResponse: { v: 5, min: 1, max: 14, step: 0.25, label: "FOV response" },
  waterClearance: { v: 2.2, min: 0.5, max: 5, step: 0.05, label: "water clearance" },
  sightlineClearance: { v: 1.15, min: 0.2, max: 2.5, step: 0.05, label: "wave sightline" },
  teleportSnapDistance: { v: 45, min: 25, max: 100, step: 1, label: "teleport snap" }
})
