export { OVERLAY_TUNING, anyOverlayActive } from "./tuning";
export { DebugOverlays, type OverlaySyncContext, type OverlayContextFlags } from "./manager";
export {
  LineOverlay,
  type DebugBox,
  type DebugMesh,
  type DebugPolyline
} from "./lineOverlay";

/** @deprecated Prefer DebugOverlays — kept so older imports keep typechecking. */
export { LineOverlay as ColliderDebug } from "./lineOverlay";
