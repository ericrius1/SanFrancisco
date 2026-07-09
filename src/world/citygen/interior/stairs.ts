// A walkable U-switchback stair: two 9-step flights of int.wood treads with a
// half-landing, climbing one storey. Every tread is a solid box with a matching
// collider, sized so a ~1.8 m capsule walks up it (rise < 0.2 m, run 0.30 m,
// flight width 1.05 m). The stair stacks in the same footprint on every floor,
// and the caller cuts a matching hole in the slab above so you emerge onto the
// next floor. Flights run along `runAxis`; the two lanes sit side by side across
// it, so you go up one lane, turn on the landing, and come up the other.
import type { ColliderBox } from "../core/types";
import { PanelBuilder } from "../core/facade";
import { addBox, FLOOR_H, type Rect, rectW, rectD } from "./common";
import type { Axis } from "./rooms";

const N = 9;            // steps per flight → 18 per storey → rise 3.4/18 ≈ 0.189 m
const RUN = 0.30;       // tread depth (≥ 0.28 m)
const LAND = 0.70;      // half-landing depth
const LANE_W = 1.05;    // per-flight clear width (≥ 1.0 m)
const LANE_GAP = 0.10;  // slot between the two flights (the switchback well)

/** total footprint the stair needs along the run axis / across it. */
export const STAIR_ALONG = N * RUN + LAND;      // 3.40 m
export const STAIR_CROSS = 2 * LANE_W + LANE_GAP; // 2.20 m

export interface StairPlan {
  /** footprint the stair occupies (keep furniture out of it) */
  region: Rect;
  /** hole to cut in the slab + ceiling above (so you emerge onto the next floor) */
  hole: Rect;
  runAxis: Axis;
}

/** does a room rect have space for the stair footprint (with a margin)? */
export function stairFits(cell: Rect): boolean {
  const lo = Math.min(rectW(cell), rectD(cell)), hi = Math.max(rectW(cell), rectD(cell));
  return hi >= STAIR_ALONG + 0.4 && lo >= STAIR_CROSS + 0.4;
}

/** anchor the stair in a corner of `cell`, flights along the cell's long axis. */
export function planStair(cell: Rect): StairPlan {
  const runAxis: Axis = rectW(cell) >= rectD(cell) ? "x" : "z";
  const m = 0.25; // keep off the walls
  const region: Rect = runAxis === "x"
    ? { x0: cell.x0 + m, x1: cell.x0 + m + STAIR_ALONG, z0: cell.z0 + m, z1: cell.z0 + m + STAIR_CROSS }
    : { x0: cell.x0 + m, x1: cell.x0 + m + STAIR_CROSS, z0: cell.z0 + m, z1: cell.z0 + m + STAIR_ALONG };
  return { region, hole: { ...region }, runAxis };
}

/**
 * Build one storey of stair inside `region`, from `floorY` up to `floorY+FLOOR_H`.
 * Flight A climbs +along in lane 1; a landing turns you 180°; flight B climbs the
 * remaining half back along −along in lane 2, topping out flush with the floor
 * above. You step off the top tread across the well (+cross) onto that floor.
 */
export function buildStair(
  out: PanelBuilder, cols: ColliderBox[], region: Rect, runAxis: Axis, floorY: number,
): void {
  const rise = FLOOR_H / (2 * N);
  const a0 = runAxis === "x" ? region.x0 : region.z0; // along origin
  const c0 = runAxis === "x" ? region.z0 : region.x0; // cross origin
  const crossLen = STAIR_CROSS;
  const lane1 = c0 + LANE_W / 2;                 // near the cross origin
  const lane2 = c0 + LANE_W + LANE_GAP + LANE_W / 2;

  // one tread: (alongCentre, crossCentre, topY). Box is 2·rise tall so treads
  // overlap vertically → no gap for a capsule to slip through.
  const tread = (aC: number, cC: number, topY: number): void => {
    if (runAxis === "x") addBox(out, cols, "int.wood", aC, topY - rise, cC, RUN / 2, rise, LANE_W / 2);
    else addBox(out, cols, "int.wood", cC, topY - rise, aC, LANE_W / 2, rise, RUN / 2);
  };

  // flight A — climb +along in lane 1
  for (let s = 0; s < N; s++) tread(a0 + RUN * (s + 0.5), lane1, floorY + rise * (s + 1));

  // half-landing at the +along end, spanning both lanes
  const midY = floorY + rise * N;
  const landAC = a0 + N * RUN + LAND / 2, landCC = c0 + crossLen / 2;
  if (runAxis === "x") addBox(out, cols, "int.wood", landAC, midY - rise, landCC, LAND / 2, rise, crossLen / 2);
  else addBox(out, cols, "int.wood", landCC, midY - rise, landAC, crossLen / 2, rise, LAND / 2);

  // flight B — climb the second half back along −along in lane 2, ending at the
  // next floor level near the along origin (emerge by stepping +cross onto it)
  for (let s = 0; s < N; s++) tread(a0 + N * RUN - RUN * (s + 0.5), lane2, midY + rise * (s + 1));
}
