// Marina / Sunset Mediterranean (Spanish Revival) façade — boxy smooth stucco,
// flat roof with a low tile cornice, an arched garage under a big bow/picture
// window, arched upper windows. Reuses the shared façade kit.
import { floorBands, aboveGrade, type FacadeDecorator, type Vec3 } from "../core/facade";
import { gp, beltCourse, cornice, windowGrid, garageDoor, faceWindow, frontDoor, frontStoop, wallWithDoorway } from "./facadeKit";
import { doorEligible } from "../core/collider";

export const marinaFacade: FacadeDecorator = (e, out) => {
  const arch = e.arch;
  const wall = arch.wallMaterial;
  const trim = arch.trimMaterial ?? "trim.edwardian";
  const glass = arch.glassMaterial ?? "glass";
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  const bands = floorBands(e);
  const groundTopY = bands[0]?.y1 ?? e.base + arch.floorH;

  // smooth stucco wall, full height (one tone — no clapboard) — cut open at the
  // doorway so the collider's walk-through gap isn't backed by a solid quad
  wallWithDoorway(out, e, wall, e.base, e.top, n3);

  if (doorEligible(e)) {
    frontStoop(out, e, trim); // steps up to the raised entry on a downhill lot
    garageDoor(out, e, e.base, groundTopY, { door: "citygen.door", trim }, true); // arched garage
    frontDoor(out, e, { door: "citygen.door", trim }); // person door beside the garage (aligned to the gap)
    // big bow / picture window over the garage (first upper floor)
    if (bands[1]) {
      const b = bands[1];
      faceWindow(out, gp(e, 0.18), gp(e, 0.82), aboveGrade(e, b.y0 + 0.35), b.y1 - 0.2, n3, { frame: trim, glass, trim }, true);
    }
  }

  // upper floors: arched windows (skip the bow-window floor on the street face)
  const startY = e.isStreet && bands[1] ? bands[1].y1 : groundTopY;
  windowGrid(out, e, { frame: trim, glass, trim }, startY, true, 3.0);
  if (bands[1]) beltCourse(out, e, bands[1].y0, trim, 0.05, 0.06);

  // low tile cornice
  cornice(out, e, "roof.tileCornice", (arch.cornice ?? 0.3) + 0.18, "tile");
};
