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

/** Roster slots that read ??? until the player finds one in the world. */
export const MYSTERY_MODES: readonly PlayerMode[] = ["board", "bird", "truck"];

const DISCOVERY_KEY = "sf-discovered-modes";
const START_KNOWN: PlayerMode[] = ["walk", "drive", "plane", "boat", "drone"];

const REVEAL_MSG: Partial<Record<PlayerMode, string>> = {
  board: "Hoverboard found!",
  bird: "Phoenix found!",
  truck: "Parade truck found!",
  speedboat: "Speedboat!"
};

export class ModeDiscovery {
  #found = new Set<PlayerMode>(START_KNOWN);

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(DISCOVERY_KEY) ?? "[]") as PlayerMode[];
      for (const m of raw) this.#found.add(m);
    } catch {
      /* ignore corrupt saves */
    }
  }

  isKnown(mode: PlayerMode) {
    return this.#found.has(mode);
  }

  /** True when this call newly revealed a roster slot. */
  discover(mode: PlayerMode): boolean {
    if (this.#found.has(mode)) return false;
    this.#found.add(mode);
    if ((MYSTERY_MODES as readonly string[]).includes(mode)) this.#persist();
    return true;
  }

  revealMessage(mode: PlayerMode) {
    return REVEAL_MSG[mode];
  }

  #persist() {
    const mystery = [...this.#found].filter((m) => (MYSTERY_MODES as readonly string[]).includes(m));
    localStorage.setItem(DISCOVERY_KEY, JSON.stringify(mystery));
  }
}
