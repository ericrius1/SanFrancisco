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
  SAFE_SPAWN_FALLBACK,
  type SpawnPoint
} from "../../world/spawnPoints";
import { resolveZoneFromQuery, type ZoneSpec } from "./zoneMode";
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
  // Zone-only boot: `?zone=<id>` boots a pocket world around one site. An invite
  // link farther than the bubble from the zone centre drops zone mode entirely
  // (the shared spot is elsewhere), otherwise the invite point — always inside
  // the bubble — still wins as the arrival.
  let zone: ZoneSpec | null = resolveZoneFromQuery(arrivalQuery);
  if (zone && invite) {
    const inviteDist = Math.hypot(invite.x - zone.center.x, invite.z - zone.center.z);
    if (inviteDist > zone.bubbleRadius) {
      console.warn(
        `[zone] invite ${Math.round(inviteDist)}m from "${zone.id}" centre exceeds bubble ` +
          `${zone.bubbleRadius}m — booting the full world`
      );
      zone = null;
    }
  }
  const zoneArrival = zone && !invite;
  const reloadCandidate = import.meta.env.DEV ? consumeDevReloadSnapshot() : null;
  const devReload = invite || beganAsReadingVisit || arrivalQuery.has("demo") || zoneArrival
    ? null
    : reloadCandidate;
  // Zone arrivals ignore resume: a returning player must land in the pocket, not
  // at their last downtown position.
  const resumed = invite || requestedSpawn || zoneArrival
    ? null
    : (devReload?.player ?? loadPlayerState());
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
  // A zone arrival owns its destination outright; never let a random landmark's
  // authored region (spawnKey is random for keyless zones) leak into the chain.
  const authoredStart = invite || resumed || zoneArrival
    ? null
    : requestedAuthoredSpawn ?? authoredRegions.arrivalForKey(spawnKey);
  // The pocket's own arrival pose: a curated spawn point when the zone names one,
  // otherwise a walk-mode pose at the site centre. The open-ground search below
  // still refines it onto movement-safe ground.
  const zoneSpawnPoint: SpawnPoint | null = zoneArrival
    ? (zone!.spawnKey ? resolveSpawnPoint(zone!.spawnKey) : null) ?? {
        key: zone!.id,
        label: zone!.label,
        x: zone!.center.x,
        z: zone!.center.z,
        heading: 0,
        mode: "walk"
      }
    : null;
  const zoneStart = zoneSpawnPoint
    ? { x: zoneSpawnPoint.x, z: zoneSpawnPoint.z, heading: zoneSpawnPoint.heading }
    : null;
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
  const startAt = inviteStart ?? zoneStart ?? resumeStart ?? authoredStart ?? registeredStart;
  const scatterA = Math.random() * Math.PI * 2;
  const scatterR = requestedSpawn || inviteStart || zoneStart || resumeStart || authoredStart
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
  const arrivalOrigin = resumed ? "resume" : invite ? "invite" : zoneArrival ? `zone:${zone!.id}` : spawnKey;
  console.info(`[spawn] arrival "${arrivalOrigin}" → ${Math.round(spawn.x)}, ${Math.round(spawn.z)}`);

  // Same materials and geometry, smaller initial residency. The normal draw
  // ring expands after the first playable frame; this is not adaptive quality.
  //
  // THE ZONE LEVER: returning the bubble radius AS `fullTileRadius` makes the
  // ring coordinator settle at the pocket and BOTH restore paths (the worldReady
  // quiet-window block and RingCoordinator.onExpansionStalled) restore to the
  // bubble too — so nothing un-clamps the world ~20 s in. `cityTileRadius`
  // carries the real city radius so wakeCity() can expand later.
  const cityTileRadius = CONFIG.tileLoadRadius;
  const fullTileRadius = zone ? zone.bubbleRadius : cityTileRadius;
  const INITIAL_VISUAL_RADIUS = 1000;
  CONFIG.tileLoadRadius = Math.min(fullTileRadius, INITIAL_VISUAL_RADIUS);
  primeInitialVisual(spawn.x, spawn.z);
  return {
    autoStartHiroTour,
    invite,
    devReload,
    resumed,
    spawnPoint: zoneSpawnPoint ?? spawnPoint,
    spawn,
    zone,
    cityTileRadius,
    fullTileRadius
  };
}
