import type { FolderApi, Pane } from "tweakpane";
import type { PlayerMode } from "../player/types";

/**
 * localStorage persistence for tweakpane values and the player's last state.
 * One current tweak schema only: when the source defaults/ranges/pane shape
 * change, stale stored values are discarded instead of migrated.
 */

const TWEAKS_KEY = "sf-tweaks";
const TWEAKS_SCHEMA_KEY = "sf-tweaks-schema";
// One current schema only: transparency policy diagnostics and the board's
// independently tunable plume/light controls changed the pane shape.
const TWEAKS_SCHEMA = "2026-07-busker-fireflies";
const PLAYER_KEY = "sf-player";

const IDLE_FLUSH_TIMEOUT_MS = 1000;
const FALLBACK_FLUSH_DELAY_MS = 100;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

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

let tweakPersistenceDirty = false;
let scheduledFlush: { kind: "idle" | "timeout"; handle: number } | null = null;
let bindingEventSuppressionDepth = 0;

function cancelScheduledTweakFlush() {
  if (!scheduledFlush || typeof window === "undefined") return;
  if (scheduledFlush.kind === "idle") {
    (window as IdleWindow).cancelIdleCallback?.(scheduledFlush.handle);
  } else {
    window.clearTimeout(scheduledFlush.handle);
  }
  scheduledFlush = null;
}

/** Write all queued tweak changes now. Page lifecycle handlers call this before suspension. */
export function flushTweakPersistence() {
  cancelScheduledTweakFlush();
  if (!tweakPersistenceDirty) return;
  try {
    localStorage.setItem(TWEAKS_SCHEMA_KEY, TWEAKS_SCHEMA);
    localStorage.setItem(TWEAKS_KEY, JSON.stringify(saved));
    tweakPersistenceDirty = false;
  } catch {
    // Storage can be unavailable (privacy mode/quota). Leave the dirty flag set
    // so a later explicit change or lifecycle flush gets another chance.
  }
}

function scheduleTweakFlush() {
  if (!tweakPersistenceDirty || scheduledFlush || typeof window === "undefined") return;
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) {
    scheduledFlush = {
      kind: "idle",
      handle: idleWindow.requestIdleCallback(
        () => {
          scheduledFlush = null;
          flushTweakPersistence();
        },
        { timeout: IDLE_FLUSH_TIMEOUT_MS }
      )
    };
    return;
  }
  scheduledFlush = {
    kind: "timeout",
    handle: window.setTimeout(() => {
      scheduledFlush = null;
      flushTweakPersistence();
    }, FALLBACK_FLUSH_DELAY_MS)
  };
}

export function saveTweak(path: string, value: unknown) {
  saved[path] = value;
  tweakPersistenceDirty = true;
  scheduleTweakFlush();
}

/**
 * Ignore generic binding events emitted synchronously by a programmatic pane
 * refresh. Callers have already updated the live state and re-apply any needed
 * side effects explicitly; running change hooks here would duplicate expensive
 * work such as shader rebuilds and vegetation rescattering.
 */
export function withTweakBindingEventsSuppressed<T>(callback: () => T): T {
  bindingEventSuppressionDepth += 1;
  try {
    return callback();
  } finally {
    bindingEventSuppressionDepth -= 1;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushTweakPersistence);
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushTweakPersistence();
  });
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
type RefreshableBinding = { refresh(): void };

// every tunables() group, so resetAllTweaks can restore the inline defaults
const groups: { spec: Record<string, TunableSpec>; values: Record<string, TunableValue> }[] = [];

/**
 * A persisted tunable group. `values` is the live object gameplay code reads
 * (seeded from localStorage, falling back to the inline `v` defaults); `bind`
 * adds one tweakpane control per entry and persists each committed change.
 * Continuous controls stay live while dragging but persist on release.
 * Entries with only a `v` (no range/label) are plain tuned constants — no control.
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
     * runs after every live write, for side effects (uniforms, forceScan…).
     * Persistence is queued only for the final event and flushed in an idle turn.
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
      const bindings: RefreshableBinding[] = [];
      for (const k in spec) {
        if (hooks?.keys && !hooks.keys.includes(k)) continue;
        const { v, ...opts } = spec[k];
        void v;
        if (Object.keys(opts).length === 0) continue; // tuned constant, no control
        const binding = folder.addBinding(target, k, opts);
        binding.on("change", (ev) => {
          if (bindingEventSuppressionDepth > 0) return;
          (values as Record<string, unknown>)[k] = ev.value;
          const last = ev.last ?? true;
          if (last) saveTweak(`${path}.${k}`, ev.value);
          hooks?.onChange?.(k, ev.value as TunableValue, last);
        });
        bindings.push(binding);
      }
      return bindings;
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
  cancelScheduledTweakFlush();
  tweakPersistenceDirty = false;
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
