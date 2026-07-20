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
  // M14: the default path loads only meta + the 1/8 terrain overview (~160 KB)
  // and streams real 800 m tiles behind the materialize front. `?fullmap=1`
  // keeps the legacy monolithic load as an A/B + emergency escape hatch.
  const fullMap = new URLSearchParams(location.search).has("fullmap");
  const map = fullMap ? await WorldMap.load() : await WorldMap.loadCore();
  // Runs against coarse data on the streamed path; it registers a tile-install
  // fixup so its carve is re-applied when a real tile overwrites the region.
  prepareCoronaHeightsGround(map);
  return { map };
}
