// SoMa / Dogpatch brick warehouse + loft — a wide masonry box with TALL
// industrial windows, a loading-dock storefront at grade, restrained trim and a
// flat parapet. Minimal ornament (the brick + big sash do the work).
import { floorBands, type FacadeDecorator, type Vec3 } from "../core/facade";
import { gp, cornice, windowGrid, storefront, beltCourse, frontDoor } from "./facadeKit";

export const somaFacade: FacadeDecorator = (e, out) => {
  const arch = e.arch;
  const wall = arch.wallMaterial;
  const trim = arch.trimMaterial ?? "trim.edwardian";
  const glass = arch.glassMaterial ?? "glass";
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  const bands = floorBands(e);
  const groundTopY = bands[0]?.y1 ?? e.base + arch.floorH;
  const g0 = gp(e, 0), g1 = gp(e, 1);

  // brick wall, full height
  out.quad(wall, [g0[0], e.base, g0[2]], [g1[0], e.base, g1[2]], [g1[0], e.top, g1[2]], [g0[0], e.top, g0[2]], n3);

  // loading-dock storefront on the street face + a clear entrance door (aligned
  // with the collider's walk-through gap so you can see where to go in)
  if (e.isStreet && e.length > 2.4) {
    storefront(out, e, e.base, groundTopY, { glass, trim, awn: "citygen.awn", sign: "citygen.sign" });
    frontDoor(out, e, { door: "citygen.door", trim });
  }

  // TALL industrial windows (wider spacing, near-full-floor height via windowGrid)
  windowGrid(out, e, { frame: trim, glass, trim }, groundTopY, false, 3.8);
  // a single brick belt course at the first upper floor (corbelled band)
  if (bands[1]) beltCourse(out, e, bands[1].y0, wall, 0.08, 0.1);

  // flat parapet
  cornice(out, e, wall, (arch.cornice ?? 0.2) + 0.12, "parapet");
};
