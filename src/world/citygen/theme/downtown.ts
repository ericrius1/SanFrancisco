// Downtown / Union-Square commercial mid-rise — masonry grid, a ground-floor
// storefront (bulkhead + glazing + signband + fabric awning), regular upper
// window grid with string courses, a flat parapet cap.
import { floorBands, type FacadeDecorator, type Vec3 } from "../core/facade";
import { gp, beltCourse, cornice, windowGrid, storefront, cornerBoards, frontDoor } from "./facadeKit";
import { largeCommercialFacade } from "./largeCommercial";

export const downtownFacade: FacadeDecorator = (e, out, rng) => {
  // Big downtown/warehouse blocks get the rich tripartite masonry treatment
  // (stone base + entrance, pier×band shaft grid, bracketed cornice) instead of
  // the small storefront-and-grid look, which reads as a flat window-wall at
  // this scale. "Large" = tall (height/floor count is building-wide, so every
  // face agrees) OR a long, multi-storey block face (footprint-span proxy).
  const height = e.top - e.base;
  if (height >= 24 || e.floors >= 7 || (e.length >= 32 && e.floors >= 4)) {
    largeCommercialFacade(e, out, rng);
    return;
  }

  const arch = e.arch;
  const wall = arch.wallMaterial;
  const trim = arch.trimMaterial ?? "trim.edwardian";
  const glass = arch.glassMaterial ?? "glass";
  const baseMat = arch.baseMaterial ?? "base.stoop";
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  const bands = floorBands(e);
  const groundTopY = bands[0]?.y1 ?? e.base + arch.floorH;
  const g0 = gp(e, 0), g1 = gp(e, 1);

  // masonry wall (ground band a touch darker)
  out.quad(baseMat, [g0[0], e.base, g0[2]], [g1[0], e.base, g1[2]], [g1[0], groundTopY, g1[2]], [g0[0], groundTopY, g0[2]], n3);
  out.quad(wall, [g0[0], groundTopY, g0[2]], [g1[0], groundTopY, g1[2]], [g1[0], e.top, g1[2]], [g0[0], e.top, g0[2]], n3);

  // ground floor: storefront on the street face + a clear entrance door
  if (e.isStreet && e.length > 2.4) {
    storefront(out, e, e.base, groundTopY, { glass, trim, awn: "citygen.awn", sign: "citygen.sign" });
    frontDoor(out, e, { door: "citygen.door", trim });
  }

  // upper floors: regular window grid + a string course each floor
  windowGrid(out, e, { frame: trim, glass, trim }, groundTopY, false, 2.9);
  for (const b of bands) if (b.y0 >= groundTopY - 0.01) beltCourse(out, e, b.y0, trim, 0.05, 0.06);
  if (e.isStreet) cornerBoards(out, e, trim, 0.06);

  // flat parapet cap
  cornice(out, e, trim, (arch.cornice ?? 0.25) + 0.1, "parapet");
};
