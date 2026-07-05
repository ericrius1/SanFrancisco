import type { PlayerMode } from "./types";

export const MENU_MODES: PlayerMode[] = [
  "walk",
  "drive",
  "plane",
  "boat",
  "drone",
  "board",
  "bird",
  "truck"
];

/** Every switchable mode (speedboat is bay-only — never on the roster). */
export const ALL_MODES: PlayerMode[] = [...MENU_MODES, "speedboat"];

const REVEAL_MSG: Partial<Record<PlayerMode, string>> = {
  board: "Hoverboard found!",
  bird: "Phoenix found!",
  truck: "Parade truck found!",
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
