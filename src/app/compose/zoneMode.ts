// Zone-only boot ("pocket world"): `?zone=<id>` boots a minimal substrate plus
// one destination site instead of the whole city, then live-upgrades to the
// full world via the "Wake the city" HUD button. This module owns only the
// static zone table + query parsing — deliberately boot-safe: it imports the
// lightweight per-site meta constants (never the site modules themselves), so
// pulling it into the boot path cannot drag an optional feature's code/assets
// with it. The tile-radius lever, the site allowlist, and wake orchestration
// live in initialArrival.ts / optionalSites.ts / main.ts respectively.
import type { OptionalSiteId } from "./optionalSites";
import { GOLDMAN_SITE_CENTER } from "../../world/goldenGateTennis/meta";
import { CORONA_HEIGHTS_SUMMIT } from "../../world/coronaHeights/meta";
import { ARCHERY_CENTER } from "../../gameplay/archery/meta";
import { PUP_CENTER } from "../../gameplay/pup/meta";
import { FORT_MASON_ENSEMBLE_CENTER } from "../../gameplay/fortMasonEnsemble/meta";
import { REVERIE_CENTER } from "../../gameplay/palaceReverie/meta";
import { AFTERLIGHT_ARRIVAL } from "../../gameplay/afterlight/meta";
import { LANDS_END_CENTER } from "../../world/landsEnd/meta";
import { WAVE_ORGAN_CENTER } from "../../world/waveOrgan/meta";
import { BEACH_PIANIST_CENTER } from "../../world/beachPianist/meta";
import { SUTRO_BATHS_ARRIVAL } from "../../world/spawnPoints";

export type ZoneSpec = {
  /** The `?zone=` query id — identical to the optional-site id it wraps. */
  id: OptionalSiteId;
  label: string;
  siteId: OptionalSiteId;
  /** A curated SPAWN_POINTS key, when one exists; otherwise the player lands at
   * `center` (through the normal open-ground search). */
  spawnKey?: string;
  center: { x: number; z: number };
  /** Terrain-residency radius the pocket world settles at (metres). */
  bubbleRadius: number;
};

const DEFAULT_BUBBLE = 900;

export const ZONES: readonly ZoneSpec[] = [
  {
    id: "goldman",
    label: "Goldman Tennis Center",
    siteId: "goldman",
    center: { x: GOLDMAN_SITE_CENTER.x, z: GOLDMAN_SITE_CENTER.z },
    bubbleRadius: DEFAULT_BUBBLE
  },
  {
    id: "archery",
    label: "Archery Range",
    siteId: "archery",
    spawnKey: "archeryRange",
    center: { x: ARCHERY_CENTER.x, z: ARCHERY_CENTER.z },
    bubbleRadius: DEFAULT_BUBBLE
  },
  {
    id: "pup",
    label: "Puppy Nursery",
    siteId: "pup",
    center: { x: PUP_CENTER.x, z: PUP_CENTER.z },
    bubbleRadius: DEFAULT_BUBBLE
  },
  {
    id: "fort-mason-ensemble",
    label: "Fort Mason Jam",
    siteId: "fort-mason-ensemble",
    center: { x: FORT_MASON_ENSEMBLE_CENTER.x, z: FORT_MASON_ENSEMBLE_CENTER.z },
    bubbleRadius: DEFAULT_BUBBLE
  },
  {
    id: "palace",
    label: "Palace Reverie",
    siteId: "palace",
    spawnKey: "palaceReverie",
    center: { x: REVERIE_CENTER.x, z: REVERIE_CENTER.z },
    bubbleRadius: DEFAULT_BUBBLE
  },
  {
    id: "afterlight",
    label: "Afterlight",
    siteId: "afterlight",
    center: { x: AFTERLIGHT_ARRIVAL.x, z: AFTERLIGHT_ARRIVAL.z },
    bubbleRadius: DEFAULT_BUBBLE
  },
  {
    id: "corona",
    label: "Corona Heights",
    siteId: "corona",
    spawnKey: "coronaHeights",
    center: { x: CORONA_HEIGHTS_SUMMIT.x, z: CORONA_HEIGHTS_SUMMIT.z },
    bubbleRadius: DEFAULT_BUBBLE
  },
  {
    id: "lands-end",
    label: "Lands End",
    siteId: "lands-end",
    spawnKey: "landsEnd",
    center: { x: LANDS_END_CENTER.x, z: LANDS_END_CENTER.z },
    bubbleRadius: DEFAULT_BUBBLE
  },
  {
    id: "wave-organ",
    label: "Wave Organ",
    siteId: "wave-organ",
    spawnKey: "waveOrgan",
    center: { x: WAVE_ORGAN_CENTER.x, z: WAVE_ORGAN_CENTER.z },
    bubbleRadius: DEFAULT_BUBBLE
  },
  {
    id: "beach-pianist",
    label: "Beach Pianist",
    siteId: "beach-pianist",
    spawnKey: "beachPianist",
    center: { x: BEACH_PIANIST_CENTER.x, z: BEACH_PIANIST_CENTER.z },
    bubbleRadius: 1000
  },
  {
    id: "sutro-baths",
    label: "Sutro Baths · 1896",
    siteId: "sutro-baths",
    spawnKey: "sutroBaths",
    center: { x: SUTRO_BATHS_ARRIVAL.x, z: SUTRO_BATHS_ARRIVAL.z },
    bubbleRadius: DEFAULT_BUBBLE
  }
];

/** Resolve a `?zone=<id>` request. An unknown id warns and returns null so boot
 * falls through to the ordinary full-world path. */
export function resolveZoneFromQuery(query: URLSearchParams): ZoneSpec | null {
  const raw = query.get("zone")?.trim();
  if (!raw) return null;
  const zone = ZONES.find((candidate) => candidate.id === raw);
  if (!zone) {
    console.warn(`[zone] unknown zone id "${raw}" — booting the full world`);
    return null;
  }
  return zone;
}
