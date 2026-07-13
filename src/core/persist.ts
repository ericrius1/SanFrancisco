import type { FolderApi, Pane } from "tweakpane";
import type { PlayerMode } from "../player/types";

/**
 * localStorage persistence for tweakpane values and the player's last state.
 * Each `tunables()` group is fingerprinted from its durable definition; when that
 * shape/defaults/ranges change, that group's stored overrides are discarded and
 * values fall back to source defaults. No manual schema bumps or migrations.
 */

const TWEAKS_KEY = "sf-tweaks";
const TWEAKS_SCHEMA_KEY = "sf-tweaks-schema";
const PLAYER_KEY = "sf-player";
export const TUNABLES_UPDATED_EVENT = "sf:tunables-updated";

const IDLE_FLUSH_TIMEOUT_MS = 1000;
const FALLBACK_FLUSH_DELAY_MS = 100;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

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

type WidenTunable<T extends TunableValue> = T extends boolean ? boolean : T extends number ? number : string;
type Values<S extends Record<string, TunableSpec>> = { [K in keyof S]: WidenTunable<S[K]["v"]> };
type RefreshableBinding = { refresh(): void };

type TunableGroupRecord = {
  spec: Record<string, TunableSpec>;
  values: Record<string, TunableValue>;
};

/** Stable fingerprint of a group's durable definition (skips `format` functions). */
function fingerprintSpec(spec: Record<string, TunableSpec>): string {
  const keys = Object.keys(spec).sort();
  const parts = keys.map((k) => {
    const s = spec[k];
    const entry: Record<string, unknown> = { v: s.v };
    if (s.min !== undefined) entry.min = s.min;
    if (s.max !== undefined) entry.max = s.max;
    if (s.step !== undefined) entry.step = s.step;
    if (s.label !== undefined) entry.label = s.label;
    if (s.options) {
      const optKeys = Object.keys(s.options).sort();
      entry.options = Object.fromEntries(optKeys.map((ok) => [ok, s.options![ok]]));
    }
    return [k, entry];
  });
  return JSON.stringify(parts);
}

function isFingerprintMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
  }
  return true;
}

/** Load path→fingerprint map. Legacy dated schema strings trigger a one-time wipe. */
function loadSchemaFingerprints(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TWEAKS_SCHEMA_KEY);
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isFingerprintMap(parsed)) {
      localStorage.removeItem(TWEAKS_KEY);
      localStorage.setItem(TWEAKS_SCHEMA_KEY, "{}");
      return {};
    }
    return { ...parsed };
  } catch {
    try {
      localStorage.removeItem(TWEAKS_KEY);
      localStorage.setItem(TWEAKS_SCHEMA_KEY, "{}");
    } catch {
      // Storage can be unavailable.
    }
    return {};
  }
}

const schemaFingerprints: Record<string, string> = loadSchemaFingerprints();

const saved: Record<string, unknown> = (() => {
  try {
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
    localStorage.setItem(TWEAKS_SCHEMA_KEY, JSON.stringify(schemaFingerprints));
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
 * Drop persisted overrides that belong directly to `path` (one path segment after
 * the group prefix). Nested groups like `movement.drive.landingFeedback` are left
 * alone when `movement.drive` is invalidated.
 */
function clearGroupOverrides(path: string) {
  const prefix = `${path}.`;
  for (const key of Object.keys(saved)) {
    if (!key.startsWith(prefix)) continue;
    if (!key.slice(prefix.length).includes(".")) delete saved[key];
  }
}

/**
 * Compare this group's definition fingerprint to the stored one. On mismatch,
 * clear that group's overrides and record the new fingerprint. Returns true when
 * overrides were discarded.
 */
function ensureGroupSchema(path: string, spec: Record<string, TunableSpec>): boolean {
  const fp = fingerprintSpec(spec);
  if (schemaFingerprints[path] === fp) return false;
  clearGroupOverrides(path);
  schemaFingerprints[path] = fp;
  tweakPersistenceDirty = true;
  scheduleTweakFlush();
  return true;
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

// Keyed by persisted path + schema keys so a hot-evaluated feature reuses the
// exact values object that existing Tweakpane bindings already reference. The
// schema suffix keeps hot-evaluated groups with different control shapes from
// accidentally sharing a live values object.
const groups = new Map<string, TunableGroupRecord>();

/**
 * A persisted tunable group. `values` is the live object gameplay code reads
 * (seeded from localStorage, falling back to the inline `v` defaults); `bind`
 * adds one tweakpane control per entry and persists each committed change.
 * Continuous controls stay live while dragging but persist on release.
 * Entries with only a `v` (no range/label) are plain tuned constants — no control.
 */
export function tunables<S extends Record<string, TunableSpec>>(path: string, spec: S) {
  const definitionChanged = ensureGroupSchema(path, spec);
  const groupKey = `${path}\u0000${Object.keys(spec).sort().join("\u0000")}`;
  let group = groups.get(groupKey);
  if (!group) {
    const values: Record<string, TunableValue> = {};
    for (const k in spec) values[k] = tweakDefault(`${path}.${k}`, spec[k].v);
    group = { spec, values };
    groups.set(groupKey, group);
  } else {
    if (definitionChanged) {
      for (const k in spec) group.values[k] = spec[k].v;
    } else {
      const previousSpec = group.spec;
      for (const k in spec) {
        if (previousSpec[k] && Object.is(group.values[k], previousSpec[k].v)) {
          // If the value was still at the old source default, adopt a newly edited
          // default live. Explicit pane/persisted values remain untouched.
          group.values[k] = spec[k].v;
        }
      }
    }
    group.spec = spec;
  }
  const values = group.values as Values<S>;
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
      for (const k in group.spec) {
        const key = k as keyof S & string;
        if (hooks?.keys && !hooks.keys.includes(key)) continue;
        const { v, ...opts } = group.spec[k];
        void v;
        if (Object.keys(opts).length === 0) continue; // tuned constant, no control
        const binding = folder.addBinding(target, k, opts);
        binding.on("change", (ev) => {
          if (bindingEventSuppressionDepth > 0) return;
          (values as Record<string, unknown>)[k] = ev.value;
          const last = ev.last ?? true;
          if (last) saveTweak(`${path}.${k}`, ev.value);
          hooks?.onChange?.(key, ev.value as TunableValue, last);
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
 *
 * Definition fingerprints are kept (and rewritten from currently registered
 * groups) so the next load does not treat every group as changed.
 */
export function resetAllTweaks() {
  cancelScheduledTweakFlush();
  tweakPersistenceDirty = false;
  for (const k in saved) delete saved[k];
  for (const k of Object.keys(schemaFingerprints)) delete schemaFingerprints[k];
  for (const [groupKey, g] of groups) {
    const path = groupKey.slice(0, groupKey.indexOf("\u0000"));
    schemaFingerprints[path] = fingerprintSpec(g.spec);
    for (const k in g.spec) g.values[k] = g.spec[k].v;
  }
  try {
    localStorage.removeItem(TWEAKS_KEY);
    localStorage.setItem(TWEAKS_SCHEMA_KEY, JSON.stringify(schemaFingerprints));
  } catch {
    // Storage can be unavailable.
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
