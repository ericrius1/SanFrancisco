/** The 18 exposed inputs of the Blender "build system" node group. */
export interface BuildingParams {
  floor: number;
  length: number;
  width: number;
  acUnit: number;
  roofProbability: number;
  clothlineProbability: number;
  windowType: number;
  windowOpenAmount: number;
  curtainClose: number;
  closedOpenStore: number;
  roofOnStore: number;
  objectOnGround: number;
  storeSign: number;
  objectOnRoof: number;
  randomise: number;
}

/** Values saved on the GeometryNodes modifier in the .blend file. */
export function defaultParams(): BuildingParams {
  return {
    floor: 6,
    length: 7,
    width: 3,
    acUnit: 0.724,
    roofProbability: 0.512,
    clothlineProbability: 0.709,
    windowType: 0.75,
    windowOpenAmount: 0.0,
    curtainClose: 0.0,
    closedOpenStore: 0.598,
    roofOnStore: 0.594,
    objectOnGround: 1.0,
    storeSign: 0.748,
    objectOnRoof: 0.835,
    randomise: 0,
  };
}
