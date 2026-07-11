// Deterministic interior finish profiles.  The footprint area is a useful proxy
// for the difference between a compact flat and a grand house, while archetype
// keeps the palette rooted in its neighbourhood.  No render objects live here:
// the profile is plain data consumed by the geometry builders.
import type { BuildingSpec } from "../core/types";
import { rng } from "../core/rng";

export type InteriorUse = "residential" | "commercial" | "loft";
export type FinishTier = 0 | 1 | 2;
export type InteriorFamily = "victorian" | "coastal" | "urban" | "industrial";

export interface InteriorStyle {
  family: InteriorFamily;
  /** 0 = simple, 1 = refined, 2 = grand. */
  tier: FinishTier;
  wall: string;
  floor: string;
  fabric: string;
  trim: string;
  windowWidth: number;
  windowSpacing: number;
  artScale: number;
  curtains: boolean;
  chandelier: boolean;
}

function familyFor(archetype: string, use: InteriorUse): InteriorFamily {
  if (use === "loft" || archetype === "soma") return "industrial";
  if (use === "commercial" || archetype === "downtown" || archetype === "chinatown") return "urban";
  if (archetype === "marina") return "coastal";
  return "victorian";
}

/**
 * Pick a stable finish tier from facts already carried by BuildingSpec.  Area is
 * deliberately the strongest signal: the large Pacific-Heights-style footprints
 * become grand much more often than narrow flats, without a second geography map.
 */
export function interiorStyle(spec: BuildingSpec, use: InteriorUse, area: number): InteriorStyle {
  const family = familyFor(spec.archetype, use);
  const roll = rng(spec.seed, 0x51f1)();
  let score = area >= 250 ? 2 : area >= 145 ? 1 : 0;
  if (family === "victorian") score += 0.55;
  else if (family === "urban") score += area >= 220 ? 0.45 : 0.1;
  else if (family === "industrial") score += area >= 360 ? 0.35 : 0;
  score += (roll - 0.5) * 0.7;
  const tier = (score >= 1.75 ? 2 : score >= 0.72 ? 1 : 0) as FinishTier;

  const palette = family === "victorian"
    ? { wall: tier === 0 ? "int.wall.warm" : "int.wall.sage", floor: "int.floor.light", fabric: tier === 2 ? "int.fabric.gold" : "int.fabric.green" }
    : family === "coastal"
      ? { wall: "int.wall.warm", floor: tier === 0 ? "int.floor.tile" : "int.floor.light", fabric: "int.fabric.blue" }
      : family === "industrial"
        ? { wall: "int.wall.cool", floor: "int.floor", fabric: "int.fabric.blue" }
        : { wall: "int.wall.cool", floor: "int.floor.tile", fabric: tier === 2 ? "int.fabric.gold" : "int.fabric.blue" };

  return {
    family,
    tier,
    wall: palette.wall,
    floor: palette.floor,
    fabric: palette.fabric,
    trim: tier === 2 ? "int.brass" : "int.trim",
    windowWidth: 1.05 + tier * 0.32,
    windowSpacing: family === "industrial" ? 3.7 : tier === 2 ? 3.2 : 2.8,
    artScale: 1 + tier * 0.25,
    curtains: family !== "industrial" && tier >= 1,
    chandelier: tier >= 1 && family !== "industrial",
  };
}
