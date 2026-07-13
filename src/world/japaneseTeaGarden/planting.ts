import {
  GUIDE_HOME,
  TEA_GARDEN_BOUNDS,
  TEA_GARDEN_TOUR_STOPS,
  TEA_GARDEN_TREES,
  distanceToTeaGardenPaths,
  inJapaneseTeaGarden,
  inTeaGardenBuilding,
  inTeaGardenWater,
  type TeaGardenTerrain,
  type TeaGardenTreeKind,
  type TeaGardenTreePlacement
} from "./layout";

export type TeaGardenTreeArchetype = "black-pine" | "japanese-maple" | "flowering-cherry" | "survivor-ginkgo";

export type TeaGardenTreeSpec = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  archetype: TeaGardenTreeArchetype;
};

export type TeaGardenShrubPalette = "azalea-evergreen" | "azalea-rose" | "azalea-pink" | "clipped-hedge";

export type TeaGardenShrubSpec = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  palette: TeaGardenShrubPalette;
  profile?: "natural" | "clipped";
};

export type TeaGardenPlanting = {
  trees: TeaGardenTreeSpec[];
  shrubs: TeaGardenShrubSpec[];
};

function hash(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function clearsGuideSightline(x: number, z: number, homeRadius = 14, stopRadius = 3.4): boolean {
  if (Math.hypot(x - GUIDE_HOME.x, z - GUIDE_HOME.z) < homeRadius) return false;
  return !TEA_GARDEN_TOUR_STOPS.some((stop) =>
    Math.hypot(x - stop.guideX, z - stop.guideZ) < stopRadius
  );
}

const PLAZA_PINES: readonly TeaGardenTreePlacement[] = [
  { x: -2330.5, z: 2190.4, kind: "pine", scale: 0.5, yaw: 0.4 },
  { x: -2323.8, z: 2187.2, kind: "pine", scale: 0.47, yaw: 1.6 },
  { x: -2316.6, z: 2189.5, kind: "pine", scale: 0.52, yaw: 2.7 },
  { x: -2307.5, z: 2202.5, kind: "pine", scale: 0.46, yaw: 3.9 },
  { x: -2313.1, z: 2206, kind: "pine", scale: 0.5, yaw: 5.1 },
  { x: -2320.3, z: 2209.2, kind: "pine", scale: 0.48, yaw: 0.9 },
  { x: -2330.7, z: 2206.5, kind: "pine", scale: 0.52, yaw: 2.2 }
] as const;

const SURVIVOR_GINKGOES = [
  { x: -2308.6, z: 2209.2, yaw: 0.7 },
  { x: -2312.8, z: 2206.9, yaw: 3.1 }
] as const;

function treeArchetype(kind: TeaGardenTreeKind): TeaGardenTreeArchetype {
  if (kind === "pine") return "black-pine";
  if (kind === "maple") return "japanese-maple";
  return "flowering-cherry";
}

/**
 * Authored specimen inventory for the shared tree renderer. This owns only the
 * Tea Garden's placement and horticultural intent; geometry, materials, wind,
 * batching, shadows, and LOD belong to the sandbox vegetation runtime.
 */
export function collectTeaGardenTrees(map: TeaGardenTerrain): TeaGardenTreeSpec[] {
  const mapped = TEA_GARDEN_TREES.filter((tree) =>
    inJapaneseTeaGarden(tree.x, tree.z) && clearsGuideSightline(tree.x, tree.z)
  );
  const trees = [...mapped, ...PLAZA_PINES].map((tree) => ({
    x: tree.x,
    y: map.groundTop(tree.x, tree.z),
    z: tree.z,
    yaw: tree.yaw,
    scale: tree.scale,
    archetype: treeArchetype(tree.kind)
  }));

  // Two young descendants of ginkgoes that survived Hiroshima, planted in
  // 2019. They are deliberately much smaller than the mature specimens.
  for (const tree of SURVIVOR_GINKGOES) {
    trees.push({
      x: tree.x,
      y: map.groundTop(tree.x, tree.z),
      z: tree.z,
      yaw: tree.yaw,
      scale: 0.48,
      archetype: "survivor-ginkgo"
    });
  }
  return trees;
}

function collectAzaleas(map: TeaGardenTerrain): TeaGardenShrubSpec[] {
  const shrubs: TeaGardenShrubSpec[] = [];
  const cell = 3.15;
  let gx = 0;
  for (let x = TEA_GARDEN_BOUNDS.minX; x <= TEA_GARDEN_BOUNDS.maxX; x += cell, gx++) {
    let gz = 0;
    for (let z = TEA_GARDEN_BOUNDS.minZ; z <= TEA_GARDEN_BOUNDS.maxZ; z += cell, gz++) {
      const px = x + (hash(gx, gz, 101) - 0.5) * cell * 0.88;
      const pz = z + (hash(gx, gz, 103) - 0.5) * cell * 0.88;
      if (!inJapaneseTeaGarden(px, pz, -0.2)) continue;
      if (inTeaGardenWater(px, pz, 1.6) || inTeaGardenBuilding(px, pz, 1.2)) continue;
      if (!clearsGuideSightline(px, pz, 5, 2.5)) continue;
      const pathDistance = distanceToTeaGardenPaths(px, pz);
      if (pathDistance < 1.1 || pathDistance > 6.2) continue;
      const edgeBand = 1 - Math.min(1, Math.abs(pathDistance - 2.3) / 3.9);
      if (hash(gx, gz, 107) > 0.16 + edgeBand * 0.34) continue;
      const paletteIndex = Math.floor(hash(gx, gz, 127) * 3);
      shrubs.push({
        x: px,
        y: map.groundTop(px, pz) + 0.02,
        z: pz,
        scale: 0.62 + hash(gx, gz, 109) * 0.82,
        yaw: hash(gx, gz, 113) * Math.PI * 2,
        palette: (["azalea-evergreen", "azalea-rose", "azalea-pink"] as const)[paletteIndex],
        profile: "natural"
      });
    }
  }
  return shrubs;
}

function collectMtFujiHedge(map: TeaGardenTerrain): TeaGardenShrubSpec[] {
  const shrubs: TeaGardenShrubSpec[] = [];
  for (let row = 0; row < 5; row++) {
    const count = 9 - row * 2;
    for (let i = 0; i < count; i++) {
      const x = -2236 + (i - (count - 1) / 2) * 1.25;
      const z = 2216.5 + row * 0.62;
      shrubs.push({
        x,
        // Preserve the clipped Mt Fuji's stepped silhouette. Shared hedge
        // geometry is root-origin (the old mound was centre-origin), so carry
        // the authored row rise directly into the root height.
        y: map.groundTop(x, z) + 0.08 + row * 0.47,
        z,
        yaw: hash(row, i, 367) * Math.PI * 2,
        scale: 0.72 + row * 0.08,
        palette: "clipped-hedge",
        profile: "clipped"
      });
    }
  }
  return shrubs;
}

/** Complete Tea Garden input for the sandbox-owned authored foliage patches. */
export function collectTeaGardenPlanting(map: TeaGardenTerrain): TeaGardenPlanting {
  return {
    trees: collectTeaGardenTrees(map),
    shrubs: [...collectAzaleas(map), ...collectMtFujiHedge(map)]
  };
}
