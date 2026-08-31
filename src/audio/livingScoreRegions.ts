/**
 * Musical geography for the non-diegetic living score.
 *
 * This module is reached only through the living-score dynamic import. The
 * regions describe musical intent; audio files and playback stay in
 * livingScore.ts. Higher-priority authored places win over the broad city and
 * park blankets, then a short hold in the director prevents border chatter.
 */

export type ScoreProfileId =
  | "golden-gate-canopy"
  | "tea-garden-stillness"
  | "pacific-tide"
  | "sutro-memory"
  | "presidio-fog"
  | "marin-sky"
  | "afterlight-cosmos"
  | "mission-sun"
  | "downtown-neon"
  | "bay-lights"
  | "city-rain"
  | "california-gold";

export type ScoreDirection = {
  profile: ScoreProfileId;
  /** Broad score energy before the runtime adds movement and passage shape. */
  intensity: number;
  /** Non-diegetic score gives way to an authored performer inside these areas. */
  liveMusicDuck: number;
  label: string;
};

type CircleZone = {
  profile: ScoreProfileId;
  label: string;
  x: number;
  z: number;
  radius: number;
  feather: number;
  intensity: number;
  nightOnly?: boolean;
};

type RectZone = {
  profile: ScoreProfileId;
  label: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  feather: number;
  intensity: number;
};

const CIRCLES: readonly CircleZone[] = [
  {
    profile: "tea-garden-stillness",
    label: "Japanese Tea Garden",
    x: -2282,
    z: 2183,
    radius: 120,
    feather: 130,
    intensity: 0.58
  },
  {
    profile: "sutro-memory",
    label: "Sutro Baths",
    x: -6125,
    z: 1117,
    radius: 155,
    feather: 210,
    intensity: 0.58
  },
  {
    profile: "afterlight-cosmos",
    label: "Buena Vista · Afterlight",
    x: 208,
    z: 2456,
    radius: 145,
    feather: 210,
    intensity: 0.7,
    nightOnly: true
  },
  {
    profile: "mission-sun",
    label: "Mission & Castro",
    x: 1090,
    z: 3020,
    radius: 1050,
    feather: 500,
    intensity: 0.78
  }
] as const;

const RECTS: readonly RectZone[] = [
  {
    profile: "marin-sky",
    label: "Marin Headlands",
    minX: -6300,
    maxX: -2700,
    minZ: -7800,
    maxZ: -5000,
    feather: 600,
    intensity: 0.76
  },
  {
    profile: "presidio-fog",
    label: "Presidio",
    minX: -3035,
    maxX: -200,
    minZ: -2250,
    maxZ: 180,
    feather: 350,
    intensity: 0.62
  },
  {
    profile: "pacific-tide",
    label: "Ocean Beach & Lands End",
    minX: -6600,
    maxX: -5200,
    minZ: 250,
    maxZ: 3300,
    feather: 520,
    intensity: 0.64
  },
  {
    profile: "golden-gate-canopy",
    label: "Golden Gate Park",
    minX: -5920,
    maxX: -760,
    minZ: 1780,
    maxZ: 2860,
    feather: 380,
    intensity: 0.66
  },
  {
    profile: "bay-lights",
    label: "Bay waterfront",
    minX: 2350,
    maxX: 5200,
    minZ: -3300,
    maxZ: -450,
    feather: 600,
    intensity: 0.68
  }
] as const;

const LIVE_MUSIC_SITES = [
  // Corona Heights busker trio.
  { x: 398, z: 2752, radius: 105, feather: 95, floor: 0.1 },
  // Marshall's Beach pianist.
  { x: -2670, z: -2745, radius: 100, feather: 100, floor: 0.08 },
  // Fort Mason ensemble.
  { x: 650, z: -1750, radius: 125, feather: 100, floor: 0.12 }
] as const;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const smooth01 = (n: number) => {
  const t = clamp01(n);
  return t * t * (3 - 2 * t);
};

function circleInfluence(x: number, z: number, zone: CircleZone): number {
  const d = Math.hypot(x - zone.x, z - zone.z);
  if (d <= zone.radius) return 1;
  return 1 - smooth01((d - zone.radius) / zone.feather);
}

function rectInfluence(x: number, z: number, zone: RectZone): number {
  const dx = Math.max(zone.minX - x, 0, x - zone.maxX);
  const dz = Math.max(zone.minZ - z, 0, z - zone.maxZ);
  return 1 - smooth01(Math.hypot(dx, dz) / zone.feather);
}

function liveMusicDuckAt(x: number, z: number): number {
  let duck = 1;
  for (const site of LIVE_MUSIC_SITES) {
    const d = Math.hypot(x - site.x, z - site.z);
    const influence = d <= site.radius
      ? 1
      : 1 - smooth01((d - site.radius) / site.feather);
    duck = Math.min(duck, 1 + (site.floor - 1) * influence);
  }
  return duck;
}

const isNight = (hour: number) => hour >= 19.5 || hour < 6.5;

/** Pure, allocation-light direction lookup used once per score update. */
export function scoreDirectionAt(x: number, z: number, hour: number): ScoreDirection {
  let best:
    | { profile: ScoreProfileId; label: string; intensity: number; influence: number }
    | undefined;

  // Circles are authored-place overrides, so they win ties against blankets.
  for (const zone of CIRCLES) {
    if (zone.nightOnly && !isNight(hour)) continue;
    const influence = circleInfluence(x, z, zone);
    if (influence <= 0 || (best && influence <= best.influence)) continue;
    best = { profile: zone.profile, label: zone.label, intensity: zone.intensity, influence };
  }
  for (const zone of RECTS) {
    const influence = rectInfluence(x, z, zone);
    if (influence <= 0 || (best && influence <= best.influence)) continue;
    best = { profile: zone.profile, label: zone.label, intensity: zone.intensity, influence };
  }

  if (!best) {
    const downtown = x > 2450 && z < 1500;
    const rainyBlueHour = hour >= 17.5 && hour < 19.5;
    best = downtown
      ? {
          profile: isNight(hour) ? "downtown-neon" : "california-gold",
          label: isNight(hour) ? "Downtown at night" : "Downtown daylight",
          intensity: 0.72,
          influence: 1
        }
      : rainyBlueHour
        ? { profile: "city-rain", label: "Blue-hour city", intensity: 0.58, influence: 1 }
        : isNight(hour)
          ? { profile: "downtown-neon", label: "San Francisco at night", intensity: 0.6, influence: 1 }
          : { profile: "california-gold", label: "San Francisco daylight", intensity: 0.64, influence: 1 };
  }

  // At a feathered region edge, the score also thins before the next profile
  // has held long enough to take over. This makes geography audible without a
  // hard musical fence.
  return {
    profile: best.profile,
    label: best.label,
    intensity: best.intensity * (0.72 + 0.28 * best.influence),
    liveMusicDuck: liveMusicDuckAt(x, z)
  };
}
