// Initial-arrival resolution: which spot (invite link > ?spawn= > resume >
// pinned start > random landmark) places the player, plus the open-ground
// scatter/fallback search and the fixed-quality local visual prime kick-off.
// Extracted from main.ts per docs/MAIN_DECOMPOSITION.md: pure spawn-table
// resolution with narrow inputs (map/tiles/authoredRegions + prime callback).
import { CONFIG, START, START_DEFAULTS } from "../../config";
import { loadPlayerState } from "../../core/persist";
import { beganAsReadingVisit } from "../startupIntent";
import { consumeDevReloadSnapshot } from "../hmr/devReloadSnapshot";
import { oceanBeachSurfShackPose } from "../../gameplay/surfing/shack";
import { findOpenSpawn } from "../../world/spawn";
import {
  pickLandmarkSpawn,
  resolveSpawnPoint,
  SAFE_SPAWN_FALLBACK
} from "../../world/spawnPoints";
import { ALL_MODES } from "../../player/discovery";
import type { PlayerMode } from "../../player/types";
import type { AnimalKind } from "../../gameplay/forest";
import type { WorldMap } from "../../world/heightmap";
import type { TileStreamer } from "../../world/tiles";
import type { AuthoredRegionStreamer } from "../../world/authoredRegions";

export type InviteIntent = {
  x: number;
  y: number;
  z: number;
  facing: number;
  mode: PlayerMode;
  animal: AnimalKind | null;
  from: string | null;
};

export function parseInviteIntent(search: string): InviteIntent | null {
  const query = new URLSearchParams(search);
  const raw = query.get("j");
  if (!raw) return null;
  const parts = raw.split(",");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  const facing = Number(parts[3]);
  const mode = ALL_MODES.find((candidate) => candidate === parts[4]);
  if (![x, y, z, facing].every(Number.isFinite) || !mode) return null;
  const animal = parts[5] === "bear" || parts[5] === "raccoon" ? parts[5] : null;
  return {
    x,
    y,
    z,
    facing,
    mode,
    animal,
    from: query.get("via")
  };
}

/**
 * Resolve the real initial destination and start its fixed-quality local tile
 * prime (via `primeInitialVisual`) while Box3D instantiates — the caller
 * overlaps this promise with physics creation so the streams never form a
 * serial loading waterfall before the first covered frame can be prepared.
 */
export async function resolveInitialArrival({
  map,
  tiles,
  authoredRegions,
  primeInitialVisual
}: {
  map: WorldMap;
  tiles: TileStreamer;
  authoredRegions: AuthoredRegionStreamer;
  primeInitialVisual: (x: number, z: number) => void;
}) {
  // Code spawns win over baked metadata; resume/invite links bypass the default
  // district entirely so a shared link never loads one neighborhood and then
  // performs a second cross-city relocation.
  const arrivalQuery = new URLSearchParams(location.search);
  const requestedSpawn = arrivalQuery.get("spawn")?.trim();
  const autoStartHiroTour = arrivalQuery.get("tour") === "hiro";
  const invite = parseInviteIntent(location.search);
  const reloadCandidate = import.meta.env.DEV ? consumeDevReloadSnapshot() : null;
  const devReload = invite || beganAsReadingVisit || arrivalQuery.has("demo")
    ? null
    : reloadCandidate;
  const resumed = invite || requestedSpawn ? null : (devReload?.player ?? loadPlayerState());
  const requestedCodeSpawn = requestedSpawn ? resolveSpawnPoint(requestedSpawn) : undefined;
  const requestedBakedSpawn = requestedSpawn ? map.meta.spawns[requestedSpawn] : undefined;
  const requestedAuthoredSpawn = requestedSpawn
    ? authoredRegions.arrivalForKey(requestedSpawn)
    : null;
  // Default arrival — no ?spawn=, no invite, no resumable position — drops a
  // fresh visitor at a random landmark from LANDMARK_POOL. A resumed player is
  // placed at their saved spot instead (resumeStart wins downstream), and a
  // start location the user has pinned (START.spawn ≠ the default) is honored.
  const spawnKey =
    requestedCodeSpawn || requestedBakedSpawn || requestedAuthoredSpawn
      ? requestedSpawn!
      : resumed || invite
        ? START.spawn
        : START.spawn === START_DEFAULTS.spawn
          ? pickLandmarkSpawn()
          : START.spawn;
  const spawnPoint = requestedCodeSpawn ?? (
    requestedBakedSpawn
      ? undefined
      : resolveSpawnPoint(spawnKey) ?? resolveSpawnPoint(START_DEFAULTS.spawn)
  );
  if (spawnPoint?.key === "oceanBeach") {
    const apron = oceanBeachSurfShackPose(map);
    spawnPoint.x = apron.x;
    spawnPoint.z = apron.z;
    spawnPoint.heading = apron.heading;
  }
  const registeredStart =
    spawnPoint ??
    requestedBakedSpawn ??
    map.meta.spawns[spawnKey] ??
    map.meta.spawns[START_DEFAULTS.spawn];
  const authoredStart = invite || resumed
    ? null
    : requestedAuthoredSpawn ?? authoredRegions.arrivalForKey(spawnKey);
  const inviteMode = invite?.animal ? "drive" : invite?.mode;
  const inviteSide = invite
    ? inviteMode === "boat" || inviteMode === "plane"
      ? 7
      : inviteMode === "drive"
        ? 4
        : 2.5
    : 0;
  const inviteStart = invite
    ? {
        x: invite.x + Math.cos(invite.facing) * inviteSide,
        z: invite.z - Math.sin(invite.facing) * inviteSide,
        heading: invite.facing
      }
    : null;
  const resumeStart = resumed
    ? { x: resumed.x, z: resumed.z, heading: resumed.heading - Math.PI }
    : null;
  const startAt = inviteStart ?? resumeStart ?? authoredStart ?? registeredStart;
  const scatterA = Math.random() * Math.PI * 2;
  const scatterR = requestedSpawn || inviteStart || resumeStart || authoredStart
    ? 0
    : 0.8 + Math.random() * 1.6;
  const openSpawnOrFallback = async () => {
    const scattered = {
      ...startAt,
      x: startAt.x + Math.cos(scatterA) * scatterR,
      z: startAt.z + Math.sin(scatterA) * scatterR
    };
    try {
      return await findOpenSpawn(
        map,
        tiles.manifest,
        scattered,
        requestedSpawn ? 1.5 : 12,
        requestedSpawn ? 36 : 200
      );
    } catch (err) {
      // A random landmark with no movement-safe ground nearby must not crash
      // boot — retire to a guaranteed-open spawn instead of rejecting.
      console.warn(`[spawn] no open ground near "${spawnKey}"; using fallback`, err);
      const fallback = resolveSpawnPoint(SAFE_SPAWN_FALLBACK) ?? startAt;
      return await findOpenSpawn(map, tiles.manifest, fallback, 12, 400);
    }
  };
  const spawn = inviteStart ?? resumeStart ?? authoredStart ?? await openSpawnOrFallback();

  // Arrival breadcrumb: which pool landmark (or resume/invite) placed the
  // player, and where they actually landed after the open-ground search.
  const arrivalOrigin = resumed ? "resume" : invite ? "invite" : spawnKey;
  console.info(`[spawn] arrival "${arrivalOrigin}" → ${Math.round(spawn.x)}, ${Math.round(spawn.z)}`);

  // Same materials and geometry, smaller initial residency. The normal draw
  // ring expands after the first playable frame; this is not adaptive quality.
  const fullTileRadius = CONFIG.tileLoadRadius;
  const INITIAL_VISUAL_RADIUS = 1000;
  CONFIG.tileLoadRadius = Math.min(fullTileRadius, INITIAL_VISUAL_RADIUS);
  primeInitialVisual(spawn.x, spawn.z);
  return {
    autoStartHiroTour,
    invite,
    devReload,
    resumed,
    spawnPoint,
    spawn,
    fullTileRadius
  };
}
