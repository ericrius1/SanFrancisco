import type { PlayerMode } from "./types";

export const MENU_MODES: PlayerMode[] = [
  "walk",
  "drive",
  "board",
  "plane",
  "boat",
  "drone",
  "bird"
];

/** Every switchable mode (speedboat is bay-only — never on the roster). */
export const ALL_MODES: PlayerMode[] = [...MENU_MODES, "speedboat"];

export const MODE_META: Record<PlayerMode, { icon: string; label: string }> = {
  walk: { icon: "🚶", label: "Walk" },
  drive: { icon: "🚗", label: "Drive" },
  plane: { icon: "✈️", label: "Plane" },
  boat: { icon: "⛵", label: "Boat" },
  speedboat: { icon: "🚤", label: "Speedboat" },
  drone: { icon: "🛸", label: "Drone" },
  board: { icon: "🛹", label: "Board" },
  bird: { icon: "🦅", label: "Bird" }
};

const REVEAL_MSG: Partial<Record<PlayerMode, string>> = {
  board: "Hoverboard found!",
  bird: "Phoenix found!",
  speedboat: "Speedboat!"
};

export class ModeDiscovery {
  #found = new Set<PlayerMode>(MENU_MODES);

  /** True when this call newly records a mode (e.g. first speedboat ride). */
  discover(mode: PlayerMode): boolean {
    if (this.#found.has(mode)) return false;
    this.#found.add(mode);
    return true;
  }

  revealMessage(mode: PlayerMode) {
    return REVEAL_MSG[mode];
  }
}
