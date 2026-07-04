import type { FolderApi, Pane } from "tweakpane";
import type { PlayerMode } from "../player/types";

/**
 * localStorage persistence for tweakpane values and the player's last state.
 * One current tweak schema only: when the source defaults/ranges/pane shape
 * change, stale stored values are discarded instead of migrated.
 */

const TWEAKS_KEY = "sf-tweaks";
const TWEAKS_SCHEMA_KEY = "sf-tweaks-schema";
const TWEAKS_SCHEMA = "2026-07-render-quality";
const PLAYER_KEY = "sf-player";

const saved: Record<string, unknown> = (() => {
  try {
    if (localStorage.getItem(TWEAKS_SCHEMA_KEY) !== TWEAKS_SCHEMA) {
      localStorage.removeItem(TWEAKS_KEY);
      localStorage.setItem(TWEAKS_SCHEMA_KEY, TWEAKS_SCHEMA);
      return {};
    }
    return JSON.parse(localStorage.getItem(TWEAKS_KEY) ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
})();

/** Saved value for `path` if present, else the inline default. */
export function tweakDefault<T>(path: string, def: T): T {
  return path in saved ? (saved[path] as T) : def;
}

export function saveTweak(path: string, value: unknown) {
  saved[path] = value;
  localStorage.setItem(TWEAKS_SCHEMA_KEY, TWEAKS_SCHEMA);
  localStorage.setItem(TWEAKS_KEY, JSON.stringify(saved));
}

/** One tunable value: the default plus its tweakpane options, all on one line. */
type TunableValue = number | boolean | string;
type TunableSpec = {
  v: TunableValue;
  min?: number;
  max?: number;
  step?: number;
  options?: Record<string, TunableValue>;
  label?: string;
  format?: (v: number) => string;
};

type Values<S extends Record<string, TunableSpec>> = { [K in keyof S]: S[K]["v"] };

// every tunables() group, so resetAllTweaks can restore the inline defaults
const groups: { spec: Record<string, TunableSpec>; values: Record<string, TunableValue> }[] = [];

/**
 * A persisted tunable group. `values` is the live object gameplay code reads
 * (seeded from localStorage, falling back to the inline `v` defaults); `bind`
 * adds one tweakpane control per entry and persists every change. Entries with
 * only a `v` (no range/label) are plain tuned constants — no control.
 */
export function tunables<S extends Record<string, TunableSpec>>(path: string, spec: S) {
  const values = {} as Values<S>;
  for (const k in spec) values[k] = tweakDefault(`${path}.${k}`, spec[k].v) as S[typeof k]["v"];
  groups.push({ spec, values });
  return {
    values,
    /**
     * `target` defaults to `values`; pass another object (e.g. a class instance
     * with matching fields) when the live state lives elsewhere. `onChange`
     * runs after the write + persist, for side effects (uniforms, forceScan…).
     * `keys` limits which entries get controls, so one group can split across
     * folders (basic vs advanced).
     */
    bind(
      folder: FolderApi | Pane,
      hooks?: {
        target?: Record<string, unknown>;
        onChange?: (key: keyof S & string, value: TunableValue, last: boolean) => void;
        keys?: (keyof S & string)[];
      }
    ) {
      const target = hooks?.target ?? values;
      for (const k in spec) {
        if (hooks?.keys && !hooks.keys.includes(k)) continue;
        const { v, ...opts } = spec[k];
        void v;
        if (Object.keys(opts).length === 0) continue; // tuned constant, no control
        folder.addBinding(target, k, opts).on("change", (ev) => {
          (values as Record<string, unknown>)[k] = ev.value;
          saveTweak(`${path}.${k}`, ev.value);
          hooks?.onChange?.(k, ev.value as TunableValue, ev.last ?? true);
        });
      }
    }
  };
}

/**
 * Factory reset (the "." key): wipe the persisted tweak store and put every
 * tunable group's live values back to their inline source defaults. Side
 * effects the pane's onChange
 * handlers normally push (uniforms, exposure, fog…) are the caller's to
 * re-apply; see the Period handler in main.ts.
 */
export function resetAllTweaks() {
  for (const k in saved) delete saved[k];
  localStorage.removeItem(TWEAKS_KEY);
  localStorage.setItem(TWEAKS_SCHEMA_KEY, TWEAKS_SCHEMA);
  for (const g of groups) {
    for (const k in g.spec) g.values[k] = g.spec[k].v;
  }
}

/* --------------------------------------------------------------- player state */

export type SavedPlayer = { mode: PlayerMode; x: number; y: number; z: number; heading: number };

export function savePlayerState(s: SavedPlayer) {
  localStorage.setItem(PLAYER_KEY, JSON.stringify(s));
}

export function loadPlayerState(): SavedPlayer | null {
  try {
    const s = JSON.parse(localStorage.getItem(PLAYER_KEY) ?? "null") as SavedPlayer | null;
    if (!s) return null;
    // legacy save from when the mode was called "fly"
    if ((s.mode as string) === "fly") s.mode = "plane";
    return s;
  } catch {
    return null;
  }
}
