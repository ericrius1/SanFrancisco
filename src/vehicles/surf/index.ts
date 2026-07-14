export {
  activateSurfboardAssets,
  animateSurfboard,
  buildSurfboardMesh,
  SURFBOARD_FLAT_DECK_TOP,
  updateSurfboardSurface
} from "./mesh";
export { SurfController } from "./controller";
export type { SurfTelemetry } from "./controller";
export { SURF_TUNING } from "./tuning";
export * from "./config";
export {
  loadSelectedSurfboardSurface,
  paintSurfboardSurface,
  prepareSurfboardSurface,
  surfboardSurfacePaintKey
} from "./surfaceTexture";
