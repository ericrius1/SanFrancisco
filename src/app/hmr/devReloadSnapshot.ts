import { ALL_MODES } from "../../player/discovery";
import type { PlayerMode } from "../../player/types";

const KEY = "sf-dev-reload-v1";
const MAX_AGE_MS = 60_000;

export type DevReloadSnapshot = {
  version: 1;
  timestamp: number;
  pathname: string;
  started: boolean;
  name: string;
  player: { mode: PlayerMode; x: number; y: number; z: number; heading: number };
  camera: { yaw: number; pitch: number; zoom: number };
};

type SnapshotSource = {
  started: boolean;
  name: string;
  player: DevReloadSnapshot["player"];
  camera: DevReloadSnapshot["camera"];
};

/** Tab-scoped one-version snapshot used only when Vite must perform a full reload. */
export function writeDevReloadSnapshot(source: SnapshotSource): void {
  const snapshot: DevReloadSnapshot = {
    version: 1,
    timestamp: Date.now(),
    pathname: location.pathname,
    ...source
  };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // Storage may be disabled; the ordinary localStorage player save remains.
  }
}

/** Consumes exactly once. Invalid, stale, or wrong-path data is discarded. */
export function consumeDevReloadSnapshot(now = Date.now()): DevReloadSnapshot | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DevReloadSnapshot>;
    if (
      value.version !== 1 ||
      value.pathname !== location.pathname ||
      typeof value.timestamp !== "number" ||
      now - value.timestamp < 0 ||
      now - value.timestamp > MAX_AGE_MS ||
      typeof value.started !== "boolean" ||
      typeof value.name !== "string" ||
      !value.player ||
      !value.camera ||
      !ALL_MODES.includes(value.player.mode as PlayerMode)
    ) {
      return null;
    }
    const numbers = [
      value.player.x,
      value.player.y,
      value.player.z,
      value.player.heading,
      value.camera.yaw,
      value.camera.pitch,
      value.camera.zoom
    ];
    if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number))) return null;
    return value as DevReloadSnapshot;
  } catch {
    return null;
  }
}

