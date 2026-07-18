/** Live controls for the piano-only screen-space raymarched god-ray graph. */
export interface PianoGodRaysParams {
  raymarchSteps: number;
  density: number;
  maxDensity: number;
  distanceAttenuation: number;
  resolutionScale: number;
  edgeRadius: number;
  edgeStrength: number;
}
