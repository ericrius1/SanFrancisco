/**
 * Pure geometry-clipmap layout shared by runtime and probes.
 *
 * Every level covers a 128×128-cell square. Level zero is split into four
 * quadrants; coarser levels keep only four border strips around a 64×64-cell
 * hole. The previous level exactly fills that hole, so seven inexpensive grids
 * cover 8.192 km while concentrating one-metre triangles around the player.
 */

export const TERRAIN_CLIPMAP_GRID_CELLS = 128;
export const TERRAIN_CLIPMAP_INNER_CELLS = 64;
export const TERRAIN_CLIPMAP_CENTER_SNAP = 8;
export const TERRAIN_CLIPMAP_SPACINGS = [1, 2, 4, 8, 16, 32, 64] as const;

export type TerrainClipmapPatchLayout = {
  name: "north" | "south" | "west" | "east" | "northWest" | "northEast" | "southWest" | "southEast";
  widthCells: number;
  depthCells: number;
  offsetCellsX: number;
  offsetCellsZ: number;
};

export type TerrainClipmapLevelLayout = {
  level: number;
  spacing: number;
  halfExtent: number;
  sourceLod: number;
  patches: readonly TerrainClipmapPatchLayout[];
  triangles: number;
};

const FINE_PATCHES: readonly TerrainClipmapPatchLayout[] = [
  { name: "northWest", widthCells: 64, depthCells: 64, offsetCellsX: -32, offsetCellsZ: -32 },
  { name: "northEast", widthCells: 64, depthCells: 64, offsetCellsX: 32, offsetCellsZ: -32 },
  { name: "southWest", widthCells: 64, depthCells: 64, offsetCellsX: -32, offsetCellsZ: 32 },
  { name: "southEast", widthCells: 64, depthCells: 64, offsetCellsX: 32, offsetCellsZ: 32 }
];

const RING_PATCHES: readonly TerrainClipmapPatchLayout[] = [
  { name: "north", widthCells: 128, depthCells: 32, offsetCellsX: 0, offsetCellsZ: -48 },
  { name: "south", widthCells: 128, depthCells: 32, offsetCellsX: 0, offsetCellsZ: 48 },
  { name: "west", widthCells: 32, depthCells: 64, offsetCellsX: -48, offsetCellsZ: 0 },
  { name: "east", widthCells: 32, depthCells: 64, offsetCellsX: 48, offsetCellsZ: 0 }
];

export function terrainClipmapCenter(value: number): number {
  return Math.round(value / TERRAIN_CLIPMAP_CENTER_SNAP) * TERRAIN_CLIPMAP_CENTER_SNAP;
}

export function createTerrainClipmapLayout(): readonly TerrainClipmapLevelLayout[] {
  return TERRAIN_CLIPMAP_SPACINGS.map((spacing, level) => {
    const patches = level === 0 ? FINE_PATCHES : RING_PATCHES;
    return {
      level,
      spacing,
      halfExtent: (TERRAIN_CLIPMAP_GRID_CELLS * spacing) / 2,
      // The source lattice is 8 m. Levels at 1/2/4/8 m retain its full signal;
      // farther rings use progressively filtered manual mip levels.
      sourceLod: Math.max(0, level - 3),
      patches,
      triangles: patches.reduce(
        (sum, patch) => sum + patch.widthCells * patch.depthCells * 2,
        0
      )
    };
  });
}

/**
 * Full-resolution source-grid centre used for a direct A/B comparison with the
 * adaptive 1/2/4 m inner levels. It replaces levels 0–3 with one 8 m mesh while
 * retaining the ordinary 16/32/64 m outer rings.
 */
export function createTerrainClipmapSourceGridCenter(): TerrainClipmapLevelLayout {
  const level = 3;
  const spacing = TERRAIN_CLIPMAP_SPACINGS[level];
  return {
    level,
    spacing,
    halfExtent: (TERRAIN_CLIPMAP_GRID_CELLS * spacing) / 2,
    sourceLod: 0,
    patches: FINE_PATCHES,
    triangles: FINE_PATCHES.reduce(
      (sum, patch) => sum + patch.widthCells * patch.depthCells * 2,
      0
    )
  };
}

export function terrainClipmapTriangleCount(
  layout: readonly TerrainClipmapLevelLayout[] = createTerrainClipmapLayout()
): number {
  return layout.reduce((sum, level) => sum + level.triangles, 0);
}

export function terrainClipmapVertexCount(
  layout: readonly TerrainClipmapLevelLayout[] = createTerrainClipmapLayout()
): number {
  return layout.reduce(
    (sum, level) =>
      sum + level.patches.reduce(
        (patchSum, patch) => patchSum + (patch.widthCells + 1) * (patch.depthCells + 1),
        0
      ),
    0
  );
}
