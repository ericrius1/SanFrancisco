/**
 * Boot-safe sky-archipelago metadata. This file deliberately contains only
 * literals and pure arithmetic so flight, UI, and streaming can use it without
 * pulling Three.js or any island geometry into a clean city boot.
 */

export type SkyPoint = { x: number; y: number; z: number };

export type SkyIslandId =
  | "first-breath"
  | "opal-memory"
  | "broken-orrery"
  | "moonwell"
  | "last-seed";

export type SkyIslandMetadata = {
  id: SkyIslandId;
  label: string;
  epithet: string;
  biome: string;
  /** World-space centre of the analytic spherical walking surface. */
  center: Readonly<SkyPoint>;
  /** Metres. Player collision uses the sphere at this exact radius. */
  bodyRadius: number;
  /** Conservative visual/culling bound including rings and underslung rock. */
  visualRadius: number;
  /** Exact spherical collision surface; equal to `bodyRadius`. */
  landingRadius: number;
  gravity: {
    /** Radial acceleration at and just above the surface, in m/s². */
    surfaceAcceleration: number;
    /** Gravity eases toward zero only inside this deep, unreachable core. */
    innerRadius: number;
    /** Field reaches zero at this distance from `center`, in metres. */
    influenceRadius: number;
  };
  palette: {
    rock: number;
    stratum: number;
    soil: number;
    glow: number;
    accent: number;
  };
  story: {
    order: number;
    title: string;
    fragment: string;
    resolution?: string;
  };
};

export const SKY_ISLANDS: readonly SkyIslandMetadata[] = [
  {
    id: "first-breath",
    label: "The First Breath",
    epithet: "where gravity learned your name",
    biome: "windglass meadow",
    center: { x: 520, y: 390, z: 2480 },
    bodyRadius: 46,
    visualRadius: 72,
    landingRadius: 46,
    gravity: { surfaceAcceleration: 7.0, innerRadius: 32, influenceRadius: 150 },
    palette: { rock: 0x52676d, stratum: 0x8aa4a1, soil: 0x294c49, glow: 0x83fff1, accent: 0xffdc91 },
    story: {
      order: 1,
      title: "A Note Left Upwind",
      fragment: "The stone repeats a sentence in your own voice: ‘We lifted the gardens because the ground had forgotten how to dream.’ Beneath it, five seed-shaped hollows point higher."
    }
  },
  {
    id: "opal-memory",
    label: "Opal Memory Reef",
    epithet: "a sea that remembers being sky",
    biome: "prismatic cloud reef",
    center: { x: 310, y: 474, z: 2225 },
    bodyRadius: 52,
    visualRadius: 82,
    landingRadius: 52,
    gravity: { surfaceAcceleration: 6.4, innerRadius: 36, influenceRadius: 165 },
    palette: { rock: 0x52607a, stratum: 0xa197bd, soil: 0x2e3f62, glow: 0xff8ee8, accent: 0x86e9ff },
    story: {
      order: 2,
      title: "The Borrowed Ocean",
      fragment: "Opal fronds hold tiny moving horizons. Touching one reveals gardeners carrying an ocean upward, cup by cup, while something bright and patient sleeps inside the final seed."
    }
  },
  {
    id: "broken-orrery",
    label: "The Broken Orrery",
    epithet: "three moons short of an answer",
    biome: "clockwork pollen steppe",
    center: { x: 30, y: 556, z: 2040 },
    bodyRadius: 43,
    visualRadius: 83,
    landingRadius: 43,
    gravity: { surfaceAcceleration: 5.8, innerRadius: 30, influenceRadius: 145 },
    palette: { rock: 0x665b56, stratum: 0xb18a58, soil: 0x41362b, glow: 0xffd45d, accent: 0x6ca8ff },
    story: {
      order: 3,
      title: "An Orbit With One Empty Chair",
      fragment: "The rings still count a vanished world. Their inscription says the gardeners did not flee a ruin; they made these islands as an invitation, then waited for a flyer gravity could not keep."
    }
  },
  {
    id: "moonwell",
    label: "Moonwell Terraces",
    epithet: "rain falls upward here",
    biome: "silver rain terraces",
    center: { x: -215, y: 635, z: 1780 },
    bodyRadius: 58,
    visualRadius: 91,
    landingRadius: 58,
    gravity: { surfaceAcceleration: 7.3, innerRadius: 40, influenceRadius: 180 },
    palette: { rock: 0x586073, stratum: 0xb5bfd0, soil: 0x30394c, glow: 0xbcd5ff, accent: 0xd9ffb0 },
    story: {
      order: 4,
      title: "Rain From the Unmade Future",
      fragment: "Drops climb from the well and show futures that almost happened. In every one, the sleeping seed opens only after a stranger visits each garden and chooses wonder over possession."
    }
  },
  {
    id: "last-seed",
    label: "The Last Seed",
    epithet: "the smallest world, still becoming",
    biome: "dawn-orchid sanctuary",
    center: { x: -460, y: 716, z: 1535 },
    bodyRadius: 49,
    visualRadius: 78,
    landingRadius: 49,
    gravity: { surfaceAcceleration: 6.1, innerRadius: 34, influenceRadius: 165 },
    palette: { rock: 0x594f69, stratum: 0xa97994, soil: 0x352f4b, glow: 0xffa4c8, accent: 0xffedaa },
    story: {
      order: 5,
      title: "What the Gardeners Planted",
      fragment: "The last seed is warm. It was never meant to grow into a weapon, a city, or a god. It carries a new kind of gravity: the pull between places made sacred by being visited.",
      resolution: "As the shell opens, a thread of dawn joins all five islands. The gardeners are gone, but their invitation is answered: the archipelago remembers you, and begins to bloom again."
    }
  }
] as const;

export const SKY_ARCHIPELAGO_CENTER = { x: 30, y: 570, z: 2020 } as const;
export const SKY_ARCHIPELAGO_LOAD_RADIUS = 1040;

const ISLAND_BY_ID = new Map(SKY_ISLANDS.map((island) => [island.id, island] as const));

export function getSkyIsland(id: SkyIslandId): SkyIslandMetadata {
  const island = ISLAND_BY_ID.get(id);
  if (!island) throw new Error(`[sky-islands] unknown island '${id}'`);
  return island;
}

export type SkyGravitySample = {
  /** World-space acceleration vector in m/s². */
  x: number;
  y: number;
  z: number;
  magnitude: number;
  /** Strongest island field as a normalized 0..1 value. */
  influence: number;
  dominantIslandId: SkyIslandId;
};

function smooth01(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Samples the combined local mini-planet field. Overlapping outskirts blend as
 * vectors, avoiding a direction snap while crossing between two islands.
 */
export function sampleSkyGravity(position: SkyPoint): SkyGravitySample | null {
  let ax = 0;
  let ay = 0;
  let az = 0;
  let strongest = 0;
  let influence = 0;
  let dominant: SkyIslandId | null = null;

  for (const island of SKY_ISLANDS) {
    const dx = island.center.x - position.x;
    const dy = island.center.y - position.y;
    const dz = island.center.z - position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 1e-5 || distance >= island.gravity.influenceRadius) continue;

    const outerSpan = Math.max(1e-5, island.gravity.influenceRadius - island.bodyRadius);
    const outer = distance <= island.bodyRadius
      ? 1
      : smooth01((island.gravity.influenceRadius - distance) / outerSpan);
    const inner = distance >= island.gravity.innerRadius
      ? 1
      : smooth01(distance / Math.max(1e-5, island.gravity.innerRadius));
    const normalized = outer * inner;
    const acceleration = island.gravity.surfaceAcceleration * normalized;
    const invDistance = 1 / distance;
    ax += dx * invDistance * acceleration;
    ay += dy * invDistance * acceleration;
    az += dz * invDistance * acceleration;

    if (acceleration > strongest) {
      strongest = acceleration;
      influence = normalized;
      dominant = island.id;
    }
  }

  if (!dominant) return null;
  return {
    x: ax,
    y: ay,
    z: az,
    magnitude: Math.hypot(ax, ay, az),
    influence,
    dominantIslandId: dominant
  };
}
