import { tunables } from "../../core/persist";

/**
 * "/" → overlays. Worldwide toggles always appear; context overlays (tea garden
 * water grid, etc.) are shown/hidden by DebugPanel based on player proximity.
 */
export const OVERLAY_TUNING = tunables("overlays", {
  physicsColliders: {
    v: false,
    label: "physics · buildings / walls"
  },
  physicsCarpet: {
    v: false,
    label: "physics · ground carpet"
  },
  playerBody: {
    v: false,
    label: "physics · player body"
  },
  raycast: {
    v: false,
    label: "interaction raycast"
  },
  teaGardenWaterGrid: {
    v: false,
    label: "tea garden · water spatial grid"
  }
});

/** True when any overlay that needs per-frame gather is enabled. */
export function anyOverlayActive(): boolean {
  const v = OVERLAY_TUNING.values;
  return (
    v.physicsColliders ||
    v.physicsCarpet ||
    v.playerBody ||
    v.raycast ||
    v.teaGardenWaterGrid
  );
}
