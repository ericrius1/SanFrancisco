export { activateSurfboardAssets, animateSurfboard, buildSurfboardMesh, updateSurfboardSurface } from "./mesh";
export { SurfController } from "./controller";
export type { SurfTelemetry } from "./controller";
export { SURF_TUNING } from "./tuning";
export { SurfCameraController, SURF_CAMERA_TUNING } from "./camera";
export type { SurfCameraDiagnostics } from "./camera";
export * from "./config";
export {
  loadSelectedSurfboardSurface,
  paintSurfboardSurface,
  prepareSurfboardSurface,
  surfboardSurfacePaintKey
} from "./surfaceTexture";
