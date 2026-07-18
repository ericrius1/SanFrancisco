// Boot stage: world map (docs/MAIN_DECOMPOSITION.md step 5).
//
// Loads the height/surface data and prepares the Corona Heights ground carve.
// main.ts calls bootMark("map") immediately after this resolves, so the mark's
// timing/name/order are unchanged.
import { WorldMap } from "../../world/heightmap";
import { prepareCoronaHeightsGround } from "../../world/coronaHeights/ground";

export interface BootMapResult {
  map: WorldMap;
}

export async function bootMap(): Promise<BootMapResult> {
  const map = await WorldMap.load();
  prepareCoronaHeightsGround(map);
  return { map };
}
