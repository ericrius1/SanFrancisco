/**
 * Pier 15 / Exploratorium footprint in world space. Kept in its own module so
 * the tutorial (and other light consumers) can import layout helpers without
 * pulling the full museum class + exhibit sims into the main chunk.
 */

// shed OBB from the baked collider (tile 14_9, building 1)
const CX = 4084.7;
const CZ = -1271.5;
const YAW = -2.523;
const COS = Math.cos(YAW);
const SIN = Math.sin(YAW);
const HL = 125.6; // half length: +u = shore/entrance end, -u = bay end
const HW = 31.4; // half width: +v = the Pier 17 side
const FLOOR = 3.78;

const DOME_C = { u: -72, v: 0 };

function toLocal(x: number, z: number): { u: number; v: number } {
  const dx = x - CX;
  const dz = z - CZ;
  return { u: dx * COS - dz * SIN, v: dx * SIN + dz * COS };
}

function pierWorld(u: number, v: number): { x: number; z: number } {
  return { x: CX + u * COS + v * SIN, z: CZ - u * SIN + v * COS };
}

/** Is a world point on the pier footprint (inside the museum shell)? */
export function insidePier(x: number, z: number): boolean {
  const { u, v } = toLocal(x, z);
  return Math.abs(u) < HL && Math.abs(v) < HW;
}

/** Just outside the front doors, facing down the hall. */
export const PIER_ENTRANCE = (() => {
  const p = pierWorld(HL + 9, 0);
  // forward(θ) = (−sinθ, −cosθ); face −u (into the pier) ⇒ θ = atan2(COS, −SIN)
  return { x: p.x, y: FLOOR + 1.2, z: p.z, facing: Math.atan2(COS, -SIN) };
})();

/** Dome theater center, world space. */
export const DOME_WORLD = pierWorld(DOME_C.u, DOME_C.v);

/**
 * In front of the Water Works wave tank, centred on the SPH screen and stood
 * ~7 m back on the room side, facing it.
 */
export const WATER_VIEW = (() => {
  const p = pierWorld(-20, -21.7);
  return { x: p.x, y: FLOOR + 1.2, z: p.z, facing: YAW };
})();

/** Shared constants the museum class needs (same numbers as above). */
export const PIER = {
  CX,
  CZ,
  YAW,
  COS,
  SIN,
  HL,
  HW,
  FLOOR,
  DOME_C,
  toLocal,
  pierWorld
} as const;
