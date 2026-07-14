// Wildlands grass — dense, deterministic ground cover streamed in stable world
// tiles around the player. Camera movement only creates entering tiles; it no
// longer rebuilds and re-uploads the complete ring every few metres.

import * as THREE from "three/webgpu";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
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

export const WILD_GRASS_RING_RADIUS = 52;
export const WILD_GRASS_SPACING = 0.68;
export const WILD_GRASS_TILE_SIZE = 20;
/** Maximum player motion before tile membership/LOD is refreshed. */
export const WILD_GRASS_STREAM_STEP = 6;
const WILD_GRASS_STREAM_MARGIN = WILD_GRASS_STREAM_STEP + 2;

const GROUND_FOOT = 0.6;
const GROUND_SLOPE_CULL = 0.85;
const GROUND_SINK = 0.05;

export type WildGrassLod = "near" | "mid" | "far";

type GrassTile = {
  tx: number;
  tz: number;
  entries: GrassEntry[];
  lod: WildGrassLod;
  mesh: GrassMesh | null;
  live: number;
};

type LodResources = {
  geometry: THREE.BufferGeometry;
  material: GrassMaterialState;
  density: number;
};

export type WildGrass = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  /** Rebuild the current tile set after a live tuning change. */
  refresh(): void;
  dispose(): void;
  stats: { count: number; tiles: number; sourceCount: number };
};

/**
 * Stable layer coverage. At the designed density (1) the base layer is
 * guaranteed, regardless of noise; patchiness changes vigour and the optional
 * extra layers instead of carving conspicuous holes through the field.
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

export function wildGrassLod(distanceToTile: number, stagger = 0): WildGrassLod {
  const d = Math.max(0, distanceToTile + stagger);
  if (d < 17) return "near";
  if (d < 36) return "mid";
  return "far";
}

function tileDistance(tx: number, tz: number, focus: { x: number; z: number }): number {
  const minX = tx * WILD_GRASS_TILE_SIZE;
  const minZ = tz * WILD_GRASS_TILE_SIZE;
  const dx = Math.max(minX - focus.x, 0, focus.x - (minX + WILD_GRASS_TILE_SIZE));
  const dz = Math.max(minZ - focus.z, 0, focus.z - (minZ + WILD_GRASS_TILE_SIZE));
  return Math.hypot(dx, dz);
}

function tileLod(tx: number, tz: number, focus: { x: number; z: number }): WildGrassLod {
  const stagger = (hash2(tx, tz, 149) - 0.5) * 5;
  return wildGrassLod(tileDistance(tx, tz, focus), stagger);
}

function lodSubset(entries: readonly GrassEntry[], lod: WildGrassLod, density: number): GrassEntry[] {
  if (density >= 0.999) return entries.slice();
  const salt = lod === "mid" ? 181 : 191;
  return entries.filter((entry) => {
    const hx = Math.round(entry.x * 100);
    const hz = Math.round(entry.z * 100);
    return hash2(hx, hz, salt + Math.round(entry.yaw * 100)) < density;
  });
}

export function createWildGrass(map: GardenTerrain, excluded?: (x: number, z: number) => boolean): WildGrass {
  const group = new THREE.Group();
  group.name = "wildlands_grass";

  // Geometry gets simpler while individual clusters widen with distance. At
  // defaults the raw placement is ~4x denser than the old patch ring, but the
  // live triangle budget remains in the same range (~0.2M before frustum cull).
  const lods: Record<WildGrassLod, LodResources> = {
    near: {
      geometry: createBladeClusterGeometry({ blades: 5, segments: 3, width: 0.088, radius: 0.38, curvature: 0.27 }),
      material: createGrassMaterial({ wind: "full", interactionSlots: 12 }),
      density: 1
    },
    mid: {
      geometry: createBladeClusterGeometry({ blades: 4, segments: 2, width: 0.115, radius: 0.46, curvature: 0.25 }),
      material: createGrassMaterial({ wind: "lite", interactionSlots: 4 }),
      density: 0.7
    },
    far: {
      geometry: createBladeClusterGeometry({ blades: 3, segments: 1, width: 0.16, radius: 0.6, curvature: 0.2 }),
      material: createGrassMaterial({ wind: "lite", interactionSlots: 0 }),
      density: 0.42
    }
  };
  const lodResources = [lods.near, lods.mid, lods.far] as const;

  const tiles = new Map<string, GrassTile>();
  const lastFocus = { x: 1e9, z: 1e9 };
  let lastSyncX = Number.NaN;
  let lastSyncZ = Number.NaN;
  let count = 0;
  let sourceCount = 0;

  const plantable = (x: number, z: number) => !excluded?.(x, z) && grassyGround(map, x, z);
  const sampleGround = (x: number, z: number) => map.groundHeight(x, z);

  function sampleTile(tx: number, tz: number): GrassEntry[] {
    const density = Math.max(0, Number(GRASS_TUNING.values.density));
    if (density <= 0) return [];
    const patchiness = THREE.MathUtils.clamp(Number(GRASS_TUNING.values.patchiness), 0, 1);
    const minX = tx * WILD_GRASS_TILE_SIZE;
    const maxX = minX + WILD_GRASS_TILE_SIZE;
    const minZ = tz * WILD_GRASS_TILE_SIZE;
    const maxZ = minZ + WILD_GRASS_TILE_SIZE;
    const gx0 = Math.floor(minX / WILD_GRASS_SPACING) - 1;
    const gx1 = Math.ceil(maxX / WILD_GRASS_SPACING) + 1;
    const gz0 = Math.floor(minZ / WILD_GRASS_SPACING) - 1;
    const gz1 = Math.ceil(maxZ / WILD_GRASS_SPACING) + 1;
    const layers = Math.max(1, Math.ceil(density));
    const entries: GrassEntry[] = [];

    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let layer = 0; layer < layers; layer++) {
          const salt = layer * 101;
          const px = gx * WILD_GRASS_SPACING + (hash2(gx, gz, 11 + salt) - 0.5) * WILD_GRASS_SPACING * 0.86;
          const pz = gz * WILD_GRASS_SPACING + (hash2(gx, gz, 17 + salt) - 0.5) * WILD_GRASS_SPACING * 0.86;
          // Assign by final jittered position, so neighbouring tiles neither
          // duplicate nor lose candidates along their shared edge.
          if (px < minX || px >= maxX || pz < minZ || pz >= maxZ) continue;
          if (!plantable(px, pz)) continue;

          const patch = valueNoise(px, pz, 26, 701);
          const keep = wildGrassLayerKeep(density, patchiness, patch, layer);
          if (hash2(gx, gz, 23 + salt) > keep) continue;

          const y = fitGroundY(sampleGround, px, pz, GROUND_FOOT, GROUND_SLOPE_CULL, -GROUND_SINK);
          if (y === null) continue;

          const vigour = THREE.MathUtils.lerp(1, 0.82 + patch * 0.36, patchiness);
          const isTall = hash2(gx, gz, 31 + salt) < 0.23 * (0.78 + patch * 0.48);
          const baseHeight = isTall ? 0.9 + hash2(gx, gz, 37 + salt) * 0.7 : 0.45 + hash2(gx, gz, 41 + salt) * 0.4;
          const height = baseHeight * vigour;
          const spread = (isTall ? 1.04 : 0.86) * (0.86 + hash2(gx, gz, 43 + salt) * 0.32) * (0.94 + vigour * 0.06);
          const brightness = 0.86 + hash2(gx, gz, 29 + salt) * 0.24;
          const dry = (1 - patch) * (0.12 + patchiness * 0.1);
          entries.push({
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
          });
        }
      }
    }
    return entries;
  }

  function removeMesh(tile: GrassTile) {
    if (!tile.mesh) return;
    group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh = null;
    tile.live = 0;
  }

  function applyLod(tile: GrassTile, lod: WildGrassLod) {
    if (tile.mesh && tile.lod === lod) return;
    removeMesh(tile);
    tile.lod = lod;
    if (tile.entries.length === 0) return;
    const resource = lods[lod];
    const visible = lodSubset(tile.entries, lod, resource.density);
    const mesh = createGrassMesh(
      `wildlands_grass_${tile.tx}_${tile.tz}_${lod}`,
      tile.entries.length,
      resource.geometry,
      resource.material.material,
      false
    );
    writeGrassMesh(mesh, visible, WILD_GRASS_RING_RADIUS);
    setGrassMeshBounds(mesh, tile.entries, 2.5);
    mesh.frustumCulled = true;
    group.add(mesh);
    tile.mesh = mesh;
    tile.live = visible.length;
  }

  function clearTiles() {
    for (const tile of tiles.values()) removeMesh(tile);
    tiles.clear();
    count = 0;
    sourceCount = 0;
    group.userData.grassStats = { count, tiles: 0, sourceCount };
  }

  function syncTiles(focus: { x: number; z: number }, force = false) {
    const focusTileX = Math.floor(focus.x / WILD_GRASS_TILE_SIZE);
    const focusTileZ = Math.floor(focus.z / WILD_GRASS_TILE_SIZE);
    if (
      !force &&
      Number.isFinite(lastSyncX) &&
      Math.hypot(focus.x - lastSyncX, focus.z - lastSyncZ) < WILD_GRASS_STREAM_STEP
    ) return;
    lastSyncX = focus.x;
    lastSyncZ = focus.z;

    // Keep a movement-step margin outside the zero-alpha rim. This guarantees
    // continuous forward coverage between syncs while still sampling only
    // entering tiles; existing deterministic tile entries remain untouched.
    const streamRadius = WILD_GRASS_RING_RADIUS + WILD_GRASS_STREAM_MARGIN;
    const tileReach = Math.ceil(streamRadius / WILD_GRASS_TILE_SIZE) + 1;
    const desired = new Set<string>();
    for (let tx = focusTileX - tileReach; tx <= focusTileX + tileReach; tx++) {
      for (let tz = focusTileZ - tileReach; tz <= focusTileZ + tileReach; tz++) {
        if (tileDistance(tx, tz, focus) > streamRadius) continue;
        const key = `${tx},${tz}`;
        desired.add(key);
        let tile = tiles.get(key);
        if (!tile) {
          tile = { tx, tz, entries: sampleTile(tx, tz), lod: "far", mesh: null, live: 0 };
          tiles.set(key, tile);
        }
        applyLod(tile, tileLod(tx, tz, focus));
      }
    }
    for (const [key, tile] of tiles) {
      if (desired.has(key)) continue;
      removeMesh(tile);
      tiles.delete(key);
    }

    count = 0;
    sourceCount = 0;
    for (const tile of tiles.values()) {
      count += tile.live;
      sourceCount += tile.entries.length;
    }
    group.userData.grassStats = { count, tiles: tiles.size, sourceCount };
  }

  return {
    group,
    update(focus) {
      lastFocus.x = focus.x;
      lastFocus.z = focus.z;
      for (const resource of lodResources) resource.material.focus.set(focus.x, focus.z);
      if (!nearAnyWildRegion(focus.x, focus.z, WILD_GRASS_RING_RADIUS + 2)) {
        if (tiles.size > 0) clearTiles();
        lastSyncX = Number.NaN;
        lastSyncZ = Number.NaN;
        return;
      }
      syncTiles(focus);
    },
    refresh() {
      if (lastFocus.x >= 1e8) return;
      clearTiles();
      lastSyncX = Number.NaN;
      lastSyncZ = Number.NaN;
      if (nearAnyWildRegion(lastFocus.x, lastFocus.z, WILD_GRASS_RING_RADIUS + 2)) syncTiles(lastFocus, true);
    },
    dispose() {
      clearTiles();
      for (const resource of lodResources) {
        resource.geometry.dispose();
        resource.material.material.dispose();
      }
      group.removeFromParent();
      group.clear();
    },
    get stats() {
      return { count, tiles: tiles.size, sourceCount };
    }
  };
}
