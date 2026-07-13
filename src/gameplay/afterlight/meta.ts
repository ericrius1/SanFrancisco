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
