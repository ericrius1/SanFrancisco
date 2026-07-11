// A walkable U-switchback stair. The visible treads are wooden step boxes, but
// the COLLISION is a smooth tilted RAMP under each flight (plus a flat landing) —
// a box3d capsule jams on discrete step faces (no step-assist), so it walks up the
// incline instead. Two flights climb one storey; the caller cuts a matching hole
// in the slab above so you emerge onto the next floor. Flights run along `runAxis`;
// the two lanes sit side by side across it (up one, turn on the landing, up the other).
import type { ColliderBox } from "../core/types";
import { PanelBuilder, type Vec3 } from "../core/facade";
import { addBox, CIRCULATION_W, FLOOR_H, containsRect, overlaps, rectAround, type Rect, rectW, rectD } from "./common";
import type { Axis } from "./rooms";

const N = 9;            // steps per flight → 18 per storey → rise 3.4/18 ≈ 0.189 m
const RUN = 0.32;       // tread depth
const LAND = 0.80;      // half-landing depth
const LANE_W = 1.25;    // per-flight clear width (roomy for a 0.7 m capsule)
const LANE_GAP = 0.12;  // slot between the two flights (the switchback well)
const RAMP_HY = 0.13;   // ramp collider half-thickness

const AX: Vec3 = [1, 0, 0], AY: Vec3 = [0, 1, 0], AZ: Vec3 = [0, 0, 1];

/** total footprint the stair needs along the run axis / across it. */
export const STAIR_ALONG = N * RUN + LAND;        // 3.68 m
export const STAIR_CROSS = 2 * LANE_W + LANE_GAP; // 2.62 m

export interface StairPlan {
  region: Rect;   // footprint the stair occupies (keep furniture out of it)
  hole: Rect;     // hole to cut in the slab + ceiling above
  runAxis: Axis;
  /** clear floor at the foot/top of the switchback (both emerge at run origin). */
  approach: Rect;
  accessPoint: readonly [number, number];
}

/** does a room rect have space for the stair footprint (with a margin)? */
export function stairFits(cell: Rect): boolean {
  const lo = Math.min(rectW(cell), rectD(cell)), hi = Math.max(rectW(cell), rectD(cell));
  return hi >= STAIR_ALONG + CIRCULATION_W + 0.5 && lo >= STAIR_CROSS + 0.5;
}

/** anchor the stair in a corner of `cell`, flights along the cell's long axis.
 *  `avoid` (the entrance keep-clear zone) rejects corners whose stair footprint
 *  would sit in front of the front door — first clear corner wins (fallback:
 *  the original first corner, so legacy layouts are unchanged when clear). */
export function planStair(cell: Rect, avoid?: Rect | null): StairPlan {
  const runAxis: Axis = rectW(cell) >= rectD(cell) ? "x" : "z";
  const m = 0.25; // keep off the walls
  const [aw, cw] = runAxis === "x" ? [STAIR_ALONG, STAIR_CROSS] : [STAIR_CROSS, STAIR_ALONG];
  const xStarts = runAxis === "x"
    ? [cell.x0 + m + CIRCULATION_W, cell.x1 - m - aw]
    : [cell.x0 + m, cell.x1 - m - aw];
  const zStarts = runAxis === "z"
    ? [cell.z0 + m + CIRCULATION_W, cell.z1 - m - cw]
    : [cell.z0 + m, cell.z1 - m - cw];
  const candidates: { region: Rect; approach: Rect; point: readonly [number, number] }[] = [];
  for (const x0 of xStarts) for (const z0 of zStarts) {
    const region = { x0, x1: x0 + aw, z0, z1: z0 + cw };
    const point = runAxis === "x"
      ? [region.x0 - CIRCULATION_W / 2, (region.z0 + region.z1) / 2] as const
      : [(region.x0 + region.x1) / 2, region.z0 - CIRCULATION_W / 2] as const;
    const approach = runAxis === "x"
      ? rectAround(point[0], point[1], CIRCULATION_W, STAIR_CROSS)
      : rectAround(point[0], point[1], STAIR_CROSS, CIRCULATION_W);
    if (containsRect(cell, region) && containsRect(cell, approach)) candidates.push({ region, approach, point });
  }
  const picked = candidates.find((c) => !avoid || (!overlaps(c.region, avoid) && !overlaps(c.approach, avoid))) ?? candidates[0];
  // stairFits guarantees at least one candidate; retain a defensive centred fallback
  // for direct callers that skip it.
  const fallbackRegion: Rect = {
    x0: cell.x1 - m - aw, x1: cell.x1 - m,
    z0: cell.z1 - m - cw, z1: cell.z1 - m,
  };
  const region = picked?.region ?? fallbackRegion;
  const accessPoint = picked?.point ?? (runAxis === "x"
    ? [region.x0 - CIRCULATION_W / 2, (region.z0 + region.z1) / 2] as const
    : [(region.x0 + region.x1) / 2, region.z0 - CIRCULATION_W / 2] as const);
  const approach = picked?.approach ?? (runAxis === "x"
    ? rectAround(accessPoint[0], accessPoint[1], CIRCULATION_W, STAIR_CROSS)
    : rectAround(accessPoint[0], accessPoint[1], STAIR_CROSS, CIRCULATION_W));
  return { region, hole: { ...region }, runAxis, approach, accessPoint };
}

export function buildStair(
  out: PanelBuilder, cols: ColliderBox[], region: Rect, runAxis: Axis, floorY: number,
  storeyH = FLOOR_H,
): void {
  const rise = storeyH / (2 * N);
  const a0 = runAxis === "x" ? region.x0 : region.z0; // along origin
  const c0 = runAxis === "x" ? region.z0 : region.x0; // cross origin
  const lane1 = c0 + LANE_W / 2;
  const lane2 = c0 + LANE_W + LANE_GAP + LANE_W / 2;
  const flightLen = N * RUN, flightRise = storeyH / 2;
  const theta = Math.atan2(flightRise, flightLen);
  const slopeLen = Math.hypot(flightLen, flightRise);
  const midY = floorY + flightRise; // landing height

  // tread VISUALS only (the ramp below carries the collision)
  const treadVis = (aC: number, cC: number, topY: number): void => {
    if (runAxis === "x") out.box("int.wood", [aC, topY - rise, cC], [RUN / 2, rise, LANE_W / 2], AX, AY, AZ, false);
    else out.box("int.wood", [cC, topY - rise, aC], [LANE_W / 2, rise, RUN / 2], AX, AY, AZ, false);
  };
  for (let s = 0; s < N; s++) treadVis(a0 + RUN * (s + 0.5), lane1, floorY + rise * (s + 1));
  for (let s = 0; s < N; s++) treadVis(a0 + N * RUN - RUN * (s + 0.5), lane2, midY + rise * (s + 1));

  // ramp COLLIDER for one flight: surface midpoint (along,y) at cross cC; sign +1
  // rises toward +along, −1 toward −along. Tilt about Z (x-run) / X (z-run).
  const ramp = (aMidSurf: number, yMidSurf: number, cC: number, sign: number): void => {
    const nA = -Math.sin(theta) * sign, nY = Math.cos(theta); // top-face normal (along,y)
    const cA = aMidSurf - nA * RAMP_HY, cY = yMidSurf - nY * RAMP_HY;
    const hLen = slopeLen / 2 + 0.12; // overlap floor/landing so there's no lip
    if (runAxis === "x") {
      const a = (theta * sign) / 2; // rotate about Z
      cols.push({ x: cA, y: cY, z: cC, hx: hLen, hy: RAMP_HY, hz: LANE_W / 2, yaw: 0, quat: [0, 0, Math.sin(a), Math.cos(a)] });
    } else {
      const a = (-theta * sign) / 2; // rotate about X
      cols.push({ x: cC, y: cY, z: cA, hx: LANE_W / 2, hy: RAMP_HY, hz: hLen, yaw: 0, quat: [Math.sin(a), 0, 0, Math.cos(a)] });
    }
  };
  ramp(a0 + flightLen / 2, floorY + flightRise / 2, lane1, +1); // flight A: up +along, lane1
  ramp(a0 + flightLen / 2, midY + flightRise / 2, lane2, -1);   // flight B: up −along, lane2

  // half-landing (flat) at the +along end, spanning both lanes
  const landAC = a0 + flightLen + LAND / 2, landCC = c0 + STAIR_CROSS / 2;
  if (runAxis === "x") addBox(out, cols, "int.wood", landAC, midY - 0.09, landCC, LAND / 2, 0.11, STAIR_CROSS / 2);
  else addBox(out, cols, "int.wood", landCC, midY - 0.09, landAC, STAIR_CROSS / 2, 0.11, LAND / 2);
}
