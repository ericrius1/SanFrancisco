// Walkable, multi-room building interiors — a PURE FUNCTION of (spec, zone).
// Built lazily only when the player actually steps inside (the ring gates it on
// the footprint) and thrown away when they leave, so nothing pays for an
// interior nobody is in.
//
// What it builds, in world space (same frame as the exterior, so no transform):
//   • a floor slab per storey (you stand on each floor) + a ceiling under each,
//   • the storey partitioned into 2–4 rooms joined by 1 m doorways (a connected,
//     walkable plan) — or ONE open room for lofts/warehouses,
//   • a real U-switchback staircase with step colliders threading every floor,
//     with a matching hole cut in the slab above so you emerge onto the next,
//   • zone-appropriate furniture, warm emissive lamps, and framed placeholder
//     art hung at eye height (frame box + swappable art quad).
//
// Determinism: all variation from spec.seed via mulberry32 (rng). Emissive-only
// lighting (no THREE lights — the app has a fixed LightPool), so every room reads.
import type { BuildingSpec, ColliderBox, Panel } from "../core/types";
import { PanelBuilder } from "../core/facade";
import { ensureCCW, triangulate } from "../core/footprint";
import { rng } from "../core/rng";
import { FLOOR_H, MAX_FLOORS, INSET, bboxOf, inset, rectArea, rectMinDim, type Rect } from "./common";
import { partition, buildWalls, deck, polyGroundSlab } from "./rooms";
import { planStair, buildStair, stairFits, type StairPlan } from "./stairs";
import { furnish, type Role } from "./props";

export interface BuiltInterior {
  panels: Panel[];
  colliders: ColliderBox[];
  floors: number;
}

/** matches the parallax-window zone so what you see through the glass ≈ what you
 *  find inside: homes (parlour/apartments), shops (retail + offices), lofts (open). */
export type InteriorZone = "residential" | "commercial" | "loft";

/** index of the roomiest cell (best chance of fitting the stair). */
function roomiest(rooms: Rect[]): number {
  let best = 0, bestV = -1;
  for (let i = 0; i < rooms.length; i++) {
    const v = rectMinDim(rooms[i]);
    if (v > bestV) { bestV = v; best = i; }
  }
  return best;
}

export function buildInterior(spec: BuildingSpec, zone: InteriorZone = "residential"): BuiltInterior {
  const poly = ensureCCW(spec.poly);
  const tris = triangulate(poly);
  const bb = bboxOf(poly);
  const area = inset(bb, INSET);
  const base = spec.base;
  const nFloors = Math.max(1, Math.min(MAX_FLOORS, Math.round((spec.top - base) / FLOOR_H)));

  const out = new PanelBuilder();
  const cols: ColliderBox[] = [];

  // ---- one shared partition, reused on every floor so walls + the stairwell
  //      stack (realistic, and keeps the stair footprint clear on each storey) --
  const target = zone === "loft" ? 1 : Math.max(2, Math.min(4, Math.round(rectArea(area) / 20)));
  let { rooms, walls } = partition(area, target, rng(spec.seed, 101));
  let stairIdx = roomiest(rooms);

  // ---- reserve a staircase (multi-storey only); fall back to one open room if
  //      the roomiest cell can't hold it, so tiny lots still get a usable stair --
  let stair: StairPlan | null = null;
  if (nFloors > 1) {
    if (!stairFits(rooms[stairIdx])) {
      ({ rooms, walls } = partition(area, 1, rng(spec.seed, 102)));
      stairIdx = 0;
    }
    if (stairFits(rooms[stairIdx])) stair = planStair(rooms[stairIdx]);
  }
  const hole: Rect | null = stair ? stair.hole : null;

  // bath goes in the last non-stair cell on residential upper floors (stacked)
  let bathIdx = -1;
  for (let i = rooms.length - 1; i >= 0; i--) if (!(stair && i === stairIdx)) { bathIdx = i; break; }

  for (let k = 0; k < nFloors; k++) {
    const fY = base + k * FLOOR_H;                       // this storey's floor surface
    const rf = rng(spec.seed, 300 + k);                  // per-floor furniture stream
    const openFloor = zone === "loft" || (zone === "commercial" && k === 0);

    // floor slab: faithful footprint on the ground, inset-bbox ring (with the
    // stairwell hole) on floors above
    if (k === 0) polyGroundSlab(out, cols, poly, tris, fY, area);
    else deck(out, cols, "int.floor", area, hole, fY, true);

    // ceiling: under each upper floor with the stairwell open; a plain cap on top
    if (k < nFloors - 1) deck(out, null, "int.ceil", area, hole, base + (k + 1) * FLOOR_H - 0.06, false);
    else deck(out, null, "int.ceil", area, null, Math.min(spec.top - 0.12, fY + FLOOR_H - 0.06), false);

    // partition walls (skip on open plans), then the stair up to the next floor
    if (!openFloor) buildWalls(out, cols, walls, fY);
    if (stair && k < nFloors - 1) buildStair(out, cols, stair.region, stair.runAxis, fY);

    // ---- furniture + art -----------------------------------------------------
    if (openFloor) {
      furnish(out, cols, stair ? stair.region : null, zone === "commercial" ? "retail" : "loft", area, fY, rf);
    } else {
      let parlorDone = false, kitchenDone = false;
      for (let i = 0; i < rooms.length; i++) {
        let role: Role;
        if (stair && i === stairIdx) role = "stair";
        else if (zone === "commercial") role = "office";
        else if (k === 0) {
          if (!parlorDone) { role = "parlor"; parlorDone = true; }
          else if (!kitchenDone) { role = "kitchen"; kitchenDone = true; }
          else role = "hall";
        } else {
          role = i === bathIdx ? "bath" : "bedroom";
        }
        furnish(out, cols, stair ? stair.region : null, role, rooms[i], fY, rf);
      }
    }
  }

  return { panels: out.panels(), colliders: cols, floors: nFloors };
}
