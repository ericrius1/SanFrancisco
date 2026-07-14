// Wildlands grass — deterministic additive ground-cover layers streamed in
// stable world tiles around the player. Coarse field blades never get replaced;
// progressively denser body/near/hero layers join them toward the player and
// extinguish whole, rank-staggered blades through wide overlap bands.

import * as THREE from "three/webgpu";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
  createMicroBladeClusterGeometry,
  setGrassMeshBounds,
  writeGrassMesh,
  type GrassEntry,
  type GrassMaterialState,
  type GrassMesh
} from "../groundcover/bladeGrass";
import { fitGroundY } from "../groundcover/grounding";
import { hash2, valueNoise } from "../groundcover/scatter";
import type { GardenTerrain } from "../garden/layout";
import { grassyGround, nearAnyWildRegion } from "./layout";
import { GRASS_TUNING } from "../../config";

export const WILD_GRASS_SPACING = 0.68;
export const WILD_GRASS_RING_RADIUS = 110;
/** Finest persistent tile size; coarser layers own larger tiles below. */
export const WILD_GRASS_TILE_SIZE = 28;
/** Maximum player motion before entering/exiting tile membership is refreshed. */
export const WILD_GRASS_STREAM_STEP = 6;
const WILD_GRASS_STREAM_MARGIN = WILD_GRASS_STREAM_STEP + 2;

const GROUND_FOOT = 0.6;
const GROUND_SLOPE_CULL = 0.85;
const GROUND_SINK = 0.05;

export type WildGrassLayerName = "far" | "mid" | "near" | "hero";

type MicroGeometrySpec = {
  kind: "micro";
  blades: number;
  width: number;
  radius: number;
  lean: number;
};

type CurvedGeometrySpec = {
  kind: "curved";
  blades: number;
  segments: number;
  width: number;
  radius: number;
  curvature: number;
};

export type WildGrassLayerSpec = {
  /** Use every Nth canonical .68m world cell on each axis. */
  gridStride: number;
  tileSize: number;
  visibleRadius: number;
  fadeBand: number;
  wind: "full" | "lite";
  interactionSlots: number;
  geometry: MicroGeometrySpec | CurvedGeometrySpec;
};

/**
 * One current wild-grass schema: placement, reach, fade, geometry, and shader
 * cost live together. The layer areas/tile sizes are chosen so a flat test
 * meadow stays close to the old high-end ~0.5M submitted-triangle / ~40-draw
 * envelope while the far silhouette reaches 110m and close blade count doubles.
 */
export const WILD_GRASS_LAYER_SPECS = {
  far: {
    gridStride: 2,
    tileSize: 80,
    visibleRadius: WILD_GRASS_RING_RADIUS,
    fadeBand: 18,
    wind: "lite",
    interactionSlots: 0,
    geometry: { kind: "micro", blades: 4, width: 0.064, radius: 0.68, lean: 0.2 }
  },
  mid: {
    gridStride: 1,
    tileSize: 56,
    visibleRadius: 60,
    fadeBand: 16,
    wind: "lite",
    interactionSlots: 0,
    geometry: { kind: "micro", blades: 2, width: 0.05, radius: 0.34, lean: 0.23 }
  },
  near: {
    gridStride: 1,
    tileSize: WILD_GRASS_TILE_SIZE,
    visibleRadius: 26,
    fadeBand: 12,
    wind: "full",
    interactionSlots: 4,
    geometry: { kind: "micro", blades: 6, width: 0.038, radius: 0.42, lean: 0.27 }
  },
  hero: {
    gridStride: 1,
    tileSize: 32,
    visibleRadius: 12,
    fadeBand: 8,
    wind: "full",
    interactionSlots: 12,
    geometry: { kind: "curved", blades: 2, segments: 1, width: 0.048, radius: 0.25, curvature: 0.3 }
  }
} as const satisfies Record<WildGrassLayerName, WildGrassLayerSpec>;

const LAYER_ORDER = ["far", "mid", "near", "hero"] as const satisfies readonly WildGrassLayerName[];

export function wildGrassLayerTriangles(spec: WildGrassLayerSpec): number {
  return spec.geometry.kind === "micro"
    ? spec.geometry.blades
    : spec.geometry.blades * (spec.geometry.segments * 2 + 1);
}

/** Additive layers that contribute at an ideal world-space distance. */
export function wildGrassLayersAt(distance: number): WildGrassLayerName[] {
  const d = Math.max(0, distance);
  return LAYER_ORDER.filter((name) => d < WILD_GRASS_LAYER_SPECS[name].visibleRadius);
}

/** Ideal visible blade-strip density before terrain/road/slope exclusions. */
export function wildGrassBladeDensityAt(distance: number): number {
  return wildGrassLayersAt(distance).reduce((sum, name) => {
    const spec = WILD_GRASS_LAYER_SPECS[name];
    const spacing = WILD_GRASS_SPACING * spec.gridStride;
    return sum + spec.geometry.blades / (spacing * spacing);
  }, 0);
}

type GrassTile = {
  tx: number;
  tz: number;
  entries: GrassEntry[];
  mesh: GrassMesh | null;
};

type GrassLayerRuntime = {
  name: WildGrassLayerName;
  spec: WildGrassLayerSpec;
  geometry: THREE.BufferGeometry;
  material: GrassMaterialState;
  trianglesPerCluster: number;
  tiles: Map<string, GrassTile>;
};

export type WildGrassLayerStats = {
  count: number;
  tiles: number;
  draws: number;
  trianglesPerCluster: number;
  submittedTriangles: number;
};

export type WildGrassStats = {
  count: number;
  tiles: number;
  sourceCount: number;
  draws: number;
  submittedTriangles: number;
  layers: Record<WildGrassLayerName, WildGrassLayerStats>;
};

export type WildGrass = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  /** Rebuild the current tile set after a live tuning change. */
  refresh(): void;
  dispose(): void;
  stats: WildGrassStats;
};

/**
 * Stable layer coverage. At designed density (1) the base placement layer is
 * guaranteed. Patchiness changes vigour and optional density layers instead of
 * cutting holes through the lawn.
 */
export function wildGrassLayerKeep(density: number, patchiness: number, patch: number, layer: number): number {
  const d = Math.max(0, density);
  const fill = THREE.MathUtils.clamp(d - Math.max(0, layer), 0, 1);
  if (layer === 0 && d >= 1) return 1;
  const patchShape = 0.72 + THREE.MathUtils.clamp(patch, 0, 1) * 0.56;
  return THREE.MathUtils.clamp(
    fill * THREE.MathUtils.lerp(1, patchShape, THREE.MathUtils.clamp(patchiness, 0, 1)),
    0,
    1
  );
}

function tileDistance(
  tx: number,
  tz: number,
  tileSize: number,
  focus: { x: number; z: number }
): number {
  const minX = tx * tileSize;
  const minZ = tz * tileSize;
  const dx = Math.max(minX - focus.x, 0, focus.x - (minX + tileSize));
  const dz = Math.max(minZ - focus.z, 0, focus.z - (minZ + tileSize));
  return Math.hypot(dx, dz);
}

function createLayerGeometry(spec: WildGrassLayerSpec): THREE.BufferGeometry {
  return spec.geometry.kind === "micro"
    ? createMicroBladeClusterGeometry(spec.geometry)
    : createBladeClusterGeometry(spec.geometry);
}

function createEmptyLayerStats(trianglesPerCluster: number): WildGrassLayerStats {
  return { count: 0, tiles: 0, draws: 0, trianglesPerCluster, submittedTriangles: 0 };
}

export function createWildGrass(map: GardenTerrain, excluded?: (x: number, z: number) => boolean): WildGrass {
  const group = new THREE.Group();
  group.name = "wildlands_grass";

  // Resources exist when the optional Wildlands module activates, but no mesh
  // or GPU pipeline is admitted until update() streams a non-empty tile.
  const layers = LAYER_ORDER.map((name): GrassLayerRuntime => {
    const spec = WILD_GRASS_LAYER_SPECS[name];
    const geometry = createLayerGeometry(spec);
    return {
      name,
      spec,
      geometry,
      material: createGrassMaterial({
        wind: spec.wind,
        interactionSlots: spec.interactionSlots,
        fadeMode: "rank",
        fadeBand: spec.fadeBand
      }),
      trianglesPerCluster: wildGrassLayerTriangles(spec),
      tiles: new Map()
    };
  });

  const lastFocus = { x: 1e9, z: 1e9 };
  let lastSyncX = Number.NaN;
  let lastSyncZ = Number.NaN;
  let stats: WildGrassStats = {
    count: 0,
    tiles: 0,
    sourceCount: 0,
    draws: 0,
    submittedTriangles: 0,
    layers: Object.fromEntries(
      layers.map((layer) => [layer.name, createEmptyLayerStats(layer.trianglesPerCluster)])
    ) as Record<WildGrassLayerName, WildGrassLayerStats>
  };

  const plantable = (x: number, z: number) => !excluded?.(x, z) && grassyGround(map, x, z);
  const sampleGround = (x: number, z: number) => map.groundHeight(x, z);

  type CellCache = Map<string, GrassEntry | null>;

  function sampleCell(
    gx: number,
    gz: number,
    densityLayer: number,
    density: number,
    patchiness: number,
    cache: CellCache
  ): GrassEntry | null {
    const key = `${gx},${gz},${densityLayer}`;
    if (cache.has(key)) return cache.get(key) ?? null;

    const salt = densityLayer * 101;
    const px = gx * WILD_GRASS_SPACING + (hash2(gx, gz, 11 + salt) - 0.5) * WILD_GRASS_SPACING * 0.86;
    const pz = gz * WILD_GRASS_SPACING + (hash2(gx, gz, 17 + salt) - 0.5) * WILD_GRASS_SPACING * 0.86;
    if (!plantable(px, pz)) {
      cache.set(key, null);
      return null;
    }

    const patch = valueNoise(px, pz, 26, 701);
    const keep = wildGrassLayerKeep(density, patchiness, patch, densityLayer);
    if (hash2(gx, gz, 23 + salt) > keep) {
      cache.set(key, null);
      return null;
    }

    const y = fitGroundY(sampleGround, px, pz, GROUND_FOOT, GROUND_SLOPE_CULL, -GROUND_SINK);
    if (y === null) {
      cache.set(key, null);
      return null;
    }

    const vigour = THREE.MathUtils.lerp(1, 0.82 + patch * 0.36, patchiness);
    const isTall = hash2(gx, gz, 31 + salt) < 0.23 * (0.78 + patch * 0.48);
    const baseHeight = isTall
      ? 0.9 + hash2(gx, gz, 37 + salt) * 0.7
      : 0.45 + hash2(gx, gz, 41 + salt) * 0.4;
    const height = baseHeight * vigour;
    const spread =
      (isTall ? 1.04 : 0.86) *
      (0.86 + hash2(gx, gz, 43 + salt) * 0.32) *
      (0.94 + vigour * 0.06);
    const brightness = 0.86 + hash2(gx, gz, 29 + salt) * 0.24;
    const dry = (1 - patch) * (0.12 + patchiness * 0.1);
    const entry: GrassEntry = {
      x: px,
      y,
      z: pz,
      yaw: hash2(gx, gz, 47 + salt) * Math.PI * 2,
      height,
      spread,
      color: new THREE.Color(
        brightness * (0.6 + dry * 0.28),
        brightness * (0.92 - dry * 0.14),
        brightness * (0.4 - dry * 0.06)
      ),
      windAmp: (0.72 + height * 0.34) * (isTall ? 1.08 : 1)
    };
    cache.set(key, entry);
    return entry;
  }

  function sampleTile(layer: GrassLayerRuntime, tx: number, tz: number, cache: CellCache): GrassEntry[] {
    const density = Math.max(0, Number(GRASS_TUNING.values.density));
    if (density <= 0) return [];
    const patchiness = THREE.MathUtils.clamp(Number(GRASS_TUNING.values.patchiness), 0, 1);
    const { tileSize, gridStride } = layer.spec;
    const minX = tx * tileSize;
    const maxX = minX + tileSize;
    const minZ = tz * tileSize;
    const maxZ = minZ + tileSize;
    const rawGx0 = Math.floor(minX / WILD_GRASS_SPACING) - gridStride;
    const gx1 = Math.ceil(maxX / WILD_GRASS_SPACING) + gridStride;
    const rawGz0 = Math.floor(minZ / WILD_GRASS_SPACING) - gridStride;
    const gz1 = Math.ceil(maxZ / WILD_GRASS_SPACING) + gridStride;
    const gx0 = Math.floor(rawGx0 / gridStride) * gridStride;
    const gz0 = Math.floor(rawGz0 / gridStride) * gridStride;
    const densityLayers = Math.max(1, Math.ceil(density));
    const entries: GrassEntry[] = [];

    for (let gx = gx0; gx <= gx1; gx += gridStride) {
      for (let gz = gz0; gz <= gz1; gz += gridStride) {
        for (let densityLayer = 0; densityLayer < densityLayers; densityLayer++) {
          const entry = sampleCell(gx, gz, densityLayer, density, patchiness, cache);
          if (!entry) continue;
          // Half-open ownership by final jittered position: different tile sizes
          // all reconstruct the same cells without seams, duplicates, or swimming.
          if (entry.x < minX || entry.x >= maxX || entry.z < minZ || entry.z >= maxZ) continue;
          entries.push(entry);
        }
      }
    }
    return entries;
  }

  function removeTile(layer: GrassLayerRuntime, tile: GrassTile) {
    if (!tile.mesh) return;
    group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh = null;
  }

  function createTile(
    layer: GrassLayerRuntime,
    tx: number,
    tz: number,
    cache: CellCache
  ): GrassTile {
    const entries = sampleTile(layer, tx, tz, cache);
    const tile: GrassTile = { tx, tz, entries, mesh: null };
    if (entries.length === 0) return tile;

    const mesh = createGrassMesh(
      `wildlands_grass_${layer.name}_${tx}_${tz}`,
      entries.length,
      layer.geometry,
      layer.material.material,
      false
    );
    writeGrassMesh(mesh, entries, layer.spec.visibleRadius);
    setGrassMeshBounds(mesh, entries, 2.5);
    mesh.frustumCulled = true;
    mesh.userData.grassLayer = layer.name;
    group.add(mesh);
    tile.mesh = mesh;
    return tile;
  }

  function syncLayer(layer: GrassLayerRuntime, focus: { x: number; z: number }, cache: CellCache) {
    const { tileSize, visibleRadius } = layer.spec;
    const streamRadius = visibleRadius + WILD_GRASS_STREAM_MARGIN;
    const focusTileX = Math.floor(focus.x / tileSize);
    const focusTileZ = Math.floor(focus.z / tileSize);
    const tileReach = Math.ceil(streamRadius / tileSize) + 1;
    const desired = new Set<string>();

    for (let tx = focusTileX - tileReach; tx <= focusTileX + tileReach; tx++) {
      for (let tz = focusTileZ - tileReach; tz <= focusTileZ + tileReach; tz++) {
        if (tileDistance(tx, tz, tileSize, focus) > streamRadius) continue;
        const key = `${tx},${tz}`;
        desired.add(key);
        if (!layer.tiles.has(key)) layer.tiles.set(key, createTile(layer, tx, tz, cache));
      }
    }

    for (const [key, tile] of layer.tiles) {
      if (desired.has(key)) continue;
      removeTile(layer, tile);
      layer.tiles.delete(key);
    }
  }

  function updateStats() {
    const layerStats = {} as Record<WildGrassLayerName, WildGrassLayerStats>;
    let count = 0;
    let tiles = 0;
    let draws = 0;
    let submittedTriangles = 0;

    for (const layer of layers) {
      let layerCount = 0;
      let layerDraws = 0;
      for (const tile of layer.tiles.values()) {
        if (!tile.mesh) continue;
        layerCount += tile.entries.length;
        layerDraws++;
      }
      const layerTriangles = layerCount * layer.trianglesPerCluster;
      layerStats[layer.name] = {
        count: layerCount,
        tiles: layer.tiles.size,
        draws: layerDraws,
        trianglesPerCluster: layer.trianglesPerCluster,
        submittedTriangles: layerTriangles
      };
      count += layerCount;
      tiles += layer.tiles.size;
      draws += layerDraws;
      submittedTriangles += layerTriangles;
    }

    stats = {
      count,
      tiles,
      sourceCount: count,
      draws,
      submittedTriangles,
      layers: layerStats
    };
    group.userData.grassStats = stats;
  }

  function clearTiles() {
    for (const layer of layers) {
      for (const tile of layer.tiles.values()) removeTile(layer, tile);
      layer.tiles.clear();
    }
    updateStats();
  }

  function syncLayers(focus: { x: number; z: number }, force = false) {
    if (
      !force &&
      Number.isFinite(lastSyncX) &&
      Math.hypot(focus.x - lastSyncX, focus.z - lastSyncZ) < WILD_GRASS_STREAM_STEP
    ) return;
    lastSyncX = focus.x;
    lastSyncZ = focus.z;

    // A one-sync ephemeral cache lets additive layers share canonical placement
    // and grounding work without retaining an unbounded world-cell cache.
    const cache: CellCache = new Map();
    for (const layer of layers) syncLayer(layer, focus, cache);
    updateStats();
  }

  return {
    group,
    update(focus) {
      lastFocus.x = focus.x;
      lastFocus.z = focus.z;
      for (const layer of layers) layer.material.focus.set(focus.x, focus.z);
      if (!nearAnyWildRegion(focus.x, focus.z, WILD_GRASS_RING_RADIUS + 2)) {
        if (stats.tiles > 0) clearTiles();
        lastSyncX = Number.NaN;
        lastSyncZ = Number.NaN;
        return;
      }
      syncLayers(focus);
    },
    refresh() {
      if (lastFocus.x >= 1e8) return;
      clearTiles();
      lastSyncX = Number.NaN;
      lastSyncZ = Number.NaN;
      if (nearAnyWildRegion(lastFocus.x, lastFocus.z, WILD_GRASS_RING_RADIUS + 2)) {
        syncLayers(lastFocus, true);
      }
    },
    dispose() {
      clearTiles();
      for (const layer of layers) {
        layer.geometry.dispose();
        layer.material.material.dispose();
      }
      group.removeFromParent();
      group.clear();
    },
    get stats() {
      return stats;
    }
  };
}
