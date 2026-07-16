import { BUENA_VISTA_SUMMIT_CLEARING } from "../../world/buenaVista";

/** Lightweight first-approach/minimap metadata for Afterlight. */
export const AFTERLIGHT_CENTER = {
  x: BUENA_VISTA_SUMMIT_CLEARING.x - 4,
  z: BUENA_VISTA_SUMMIT_CLEARING.z + 6
} as const;

export const AFTERLIGHT_ARRIVAL = {
  x: AFTERLIGHT_CENTER.x,
  z: AFTERLIGHT_CENTER.z + 16
} as const;

/**
 * The grove exists on world time, not wall-clock time. Keeping this predicate in
 * lightweight metadata lets the streaming scheduler skip the entire Afterlight
 * chunk during the day.
 */
export const AFTERLIGHT_OPEN_HOUR = 21;
export const AFTERLIGHT_CLOSE_HOUR = 5;

export function isAfterlightOpenAtHour(hour: number): boolean {
  if (!Number.isFinite(hour)) return false;
  const normalized = ((hour % 24) + 24) % 24;
  return normalized >= AFTERLIGHT_OPEN_HOUR || normalized < AFTERLIGHT_CLOSE_HOUR;
}
