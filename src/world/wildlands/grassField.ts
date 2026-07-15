// Wildlands grass — four additive WebGPU layers generated and compacted from a
// player-following foliage field. The CPU maintains only the paged ecological
// field; candidate placement, exclusions, slope fitting, density selection and
// draw counts live on the GPU.

import * as THREE from "three/webgpu";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createMicroBladeClusterGeometry,
  type GrassMaterialState
} from "../groundcover/bladeGrass";
import {
  createGpuGrassPlacement,
  type GpuGrassLayer,
  type GpuGrassPlacement
} from "../groundcover/gpuGrassPlacement";
import {
  FoliageField,
  type FoliageFieldBuildJob,
  type FoliageFieldStats
} from "../groundcover/foliageField";
import { requireRenderer, releaseRendererAttribute } from "../../app/rendererRegistry";
import type { GardenTerrain } from "../garden/layout";
import { grassyGround, nearAnyWildRegion } from "./layout";
import { GRASS_TUNING } from "../../config";

export const WILD_GRASS_SPACING = 0.68;
export const WILD_GRASS_RING_RADIUS = 110;
/** Retained as the authoring/debug reference cell; rendering no longer owns tiles. */
export const WILD_GRASS_TILE_SIZE = 28;
/** Maximum player motion before the paged field and GPU compactors retarget. */
export const WILD_GRASS_STREAM_STEP = 6;
export const WILD_GRASS_STREAM_MARGIN = WILD_GRASS_STREAM_STEP + 2;
const MAX_DENSITY_LAYERS = 3;

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
  /** Legacy authoring/debug footprint. GPU rendering emits one draw per layer. */
  tileSize: number;
  visibleRadius: number;
  fadeBand: number;
  wind: "full" | "lite";
  interactionSlots: number;
  geometry: MicroGeometrySpec | CurvedGeometrySpec;
};

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

/** Fixed GPU output capacity for one layer at the current density-slider ceiling. */
export function wildGrassGpuCandidateCapacity(
  spec: WildGrassLayerSpec,
  densityLayers = MAX_DENSITY_LAYERS
): Readonly<{ side: number; capacity: number }> {
  const step = WILD_GRASS_SPACING * spec.gridStride;
  const reach = Math.ceil(spec.visibleRadius / step) + 1;
  const side = reach * 2 + 1;
  return { side, capacity: side * side * Math.max(1, Math.floor(densityLayers)) };
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

/** CPU twin retained for deterministic authoring/quality contracts. */
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

function createLayerGeometry(spec: WildGrassLayerSpec): THREE.BufferGeometry {
  return spec.geometry.kind === "micro"
    ? createMicroBladeClusterGeometry(spec.geometry)
    : createBladeClusterGeometry(spec.geometry);
}

export type WildGrassLayerStats = {
  /** Exact compacted draw count from the shared 80-byte indirect readback. */
  count: number;
  /** One resident GPU field replaces the former tile mesh set. */
  tiles: number;
  draws: number;
  capacity: number;
  candidateSide: number;
  trianglesPerCluster: number;
  submittedTriangles: number;
};

export type WildGrassStats = {
  count: number;
  tiles: number;
  /** Candidate threads before compute rejection/compaction. */
  sourceCount: number;
  draws: number;
  submittedTriangles: number;
  gpuGenerated: true;
  indirectBytes: number;
  layers: Record<WildGrassLayerName, WildGrassLayerStats>;
};

export type WildGrassBuildJob = FoliageFieldBuildJob;

export type WildGrassBuildOptions = {
  /** Route paged-field slabs through the app-wide frame scheduler. */
  schedule?: (job: WildGrassBuildJob) => void;
  /** CPU budget for a foliage-field sampling turn. */
  sliceBudgetMs?: number;
  /** Hidden publish lets the Wildlands preparation registry warm layouts first. */
  requirePreparation?: boolean;
  /** Deterministic clock injection for field contracts. */
  now?: () => number;
};

type GrassStreamingStats = {
  generation: number;
  pendingJobs: number;
  criticalReady: boolean;
  criticalLayers: number;
  gpuDispatches: number;
  gpuCandidateThreads: number;
  indirectReadbackBytes: number;
  staleGenerations: number;
  field: FoliageFieldStats;
};

export type WildGrass = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  refresh(): void;
  whenSettled(): Promise<void>;
  whenCriticalReady(): Promise<void>;
  dispose(): void;
  stats: WildGrassStats;
};

function initialStats(layers: readonly GpuGrassLayer[]): WildGrassStats {
  const layerStats = {} as Record<WildGrassLayerName, WildGrassLayerStats>;
  let sourceCount = 0;
  for (const layer of layers) {
    const name = layer.spec.name as WildGrassLayerName;
    layerStats[name] = {
      count: 0,
      tiles: 1,
      draws: 0,
      capacity: layer.capacity,
      candidateSide: layer.candidateSide,
      trianglesPerCluster: layer.trianglesPerCluster,
      submittedTriangles: 0
    };
    sourceCount += layer.capacity;
  }
  return {
    count: 0,
    tiles: layers.length,
    sourceCount,
    draws: 0,
    submittedTriangles: 0,
    gpuGenerated: true,
    indirectBytes: layers.length * 5 * Uint32Array.BYTES_PER_ELEMENT,
    layers: layerStats
  };
}

export function createWildGrass(
  map: GardenTerrain,
  excluded?: (x: number, z: number) => boolean,
  options: WildGrassBuildOptions = {}
): WildGrass {
  const renderer = requireRenderer();
  const group = new THREE.Group();
  group.name = "wildlands_grass";
  const requirePreparation = options.requirePreparation === true;
  const materials: GrassMaterialState[] = [];
  const sourceGeometries: THREE.BufferGeometry[] = [];

  const inputs = LAYER_ORDER.map((name) => {
    const spec = WILD_GRASS_LAYER_SPECS[name];
    const geometry = createLayerGeometry(spec);
    const material = createGrassMaterial({
      wind: spec.wind,
      interactionSlots: spec.interactionSlots,
      fadeMode: "rank",
      fadeBand: spec.fadeBand
    });
    sourceGeometries.push(geometry);
    materials.push(material);
    return {
      spec: { name, gridStride: spec.gridStride, visibleRadius: spec.visibleRadius, fadeBand: spec.fadeBand },
      geometry,
      material,
      trianglesPerCluster: wildGrassLayerTriangles(spec)
    };
  });

  const field = new FoliageField({
    groundHeight: (x, z) => map.groundHeight(x, z),
    plantable: (x, z) => !excluded?.(x, z) && grassyGround(map, x, z),
    schedule: options.schedule,
    now: options.now,
    sliceBudgetMs: options.sliceBudgetMs
  });
  const gpu: GpuGrassPlacement = createGpuGrassPlacement(
    field,
    inputs,
    WILD_GRASS_SPACING,
    MAX_DENSITY_LAYERS
  );
  for (const geometry of sourceGeometries) geometry.dispose();
  for (const layer of gpu.layers) {
    layer.mesh.visible = false;
    group.add(layer.mesh);
  }

  let stats = initialStats(gpu.layers);
  let disposed = false;
  let generation = 0;
  let activePromise: Promise<void> = Promise.resolve();
  let lastSyncX = Number.NaN;
  let lastSyncZ = Number.NaN;
  const lastFocus = { x: 1e9, z: 1e9 };
  const streaming: GrassStreamingStats = {
    generation: 0,
    pendingJobs: 0,
    criticalReady: false,
    criticalLayers: 0,
    gpuDispatches: 0,
    gpuCandidateThreads: stats.sourceCount,
    indirectReadbackBytes: stats.indirectBytes,
    staleGenerations: 0,
    field: field.stats
  };
  group.userData.grassStats = stats;
  group.userData.grassStreaming = streaming;
  group.userData.foliageField = field;

  const publishStats = (commands: Uint32Array): void => {
    const layers = {} as Record<WildGrassLayerName, WildGrassLayerStats>;
    let count = 0;
    let draws = 0;
    let submittedTriangles = 0;
    for (let index = 0; index < gpu.layers.length; index++) {
      const layer = gpu.layers[index];
      const name = layer.spec.name as WildGrassLayerName;
      const compacted = Math.min(layer.capacity, commands[index * 5 + 1] ?? 0);
      const triangles = compacted * layer.trianglesPerCluster;
      layer.mesh.userData.grassLastCount = compacted;
      layers[name] = {
        count: compacted,
        tiles: 1,
        draws: compacted > 0 ? 1 : 0,
        capacity: layer.capacity,
        candidateSide: layer.candidateSide,
        trianglesPerCluster: layer.trianglesPerCluster,
        submittedTriangles: triangles
      };
      count += compacted;
      draws += compacted > 0 ? 1 : 0;
      submittedTriangles += triangles;
    }
    stats = {
      count,
      tiles: gpu.layers.length,
      sourceCount: gpu.layers.reduce((sum, layer) => sum + layer.capacity, 0),
      draws,
      submittedTriangles,
      gpuGenerated: true,
      indirectBytes: gpu.indirect.array.byteLength,
      layers
    };
    group.userData.grassStats = stats;
  };

  const requestGeneration = (focus: { x: number; z: number }, force = false): void => {
    if (disposed) return;
    if (
      !force && Number.isFinite(lastSyncX) &&
      Math.hypot(focus.x - lastSyncX, focus.z - lastSyncZ) < WILD_GRASS_STREAM_STEP
    ) return;
    lastSyncX = focus.x;
    lastSyncZ = focus.z;
    const id = ++generation;
    streaming.generation = id;
    streaming.pendingJobs = 1;
    streaming.criticalReady = false;
    streaming.criticalLayers = 0;
    const destination = { x: focus.x, z: focus.z };

    const run = (async () => {
      await field.request(destination);
      if (disposed || id !== generation) {
        streaming.staleGenerations++;
        return;
      }
      gpu.focus.set(destination.x, destination.z);
      gpu.density.value = THREE.MathUtils.clamp(Number(GRASS_TUNING.values.density), 0, 2.5);
      gpu.patchiness.value = THREE.MathUtils.clamp(Number(GRASS_TUNING.values.patchiness), 0, 1);
      for (const material of materials) material.focus.set(destination.x, destination.z);

      // Reset and all four compactors share one command encoder. Rendering can
      // therefore observe only the old complete field or the new complete field.
      await renderer.computeAsync([gpu.reset, ...gpu.layers.map((layer) => layer.compute)]);
      const readback = await renderer.getArrayBufferAsync(gpu.indirect);
      if (disposed || id !== generation) {
        streaming.staleGenerations++;
        return;
      }
      publishStats(new Uint32Array(readback as ArrayBuffer));
      streaming.gpuDispatches++;
      streaming.criticalReady = true;
      streaming.criticalLayers = gpu.layers.length;
      if (!requirePreparation) {
        for (const layer of gpu.layers) layer.mesh.visible = true;
      }
    })().finally(() => {
      if (id === generation) streaming.pendingJobs = 0;
      streaming.field = field.stats;
    });
    activePromise = run;
  };

  const waitForLatest = async (): Promise<void> => {
    while (!disposed) {
      const requested = activePromise;
      await requested;
      if (requested === activePromise) return;
    }
  };

  return {
    group,
    update(focus) {
      lastFocus.x = focus.x;
      lastFocus.z = focus.z;
      for (const material of materials) material.focus.set(focus.x, focus.z);
      if (!nearAnyWildRegion(focus.x, focus.z, WILD_GRASS_RING_RADIUS + 2)) {
        generation++;
        streaming.generation = generation;
        streaming.pendingJobs = 0;
        streaming.criticalReady = false;
        group.visible = false;
        lastSyncX = Number.NaN;
        lastSyncZ = Number.NaN;
        return;
      }
      group.visible = true;
      requestGeneration(focus);
    },
    refresh() {
      if (lastFocus.x >= 1e8) return;
      if (!nearAnyWildRegion(lastFocus.x, lastFocus.z, WILD_GRASS_RING_RADIUS + 2)) return;
      requestGeneration(lastFocus, true);
    },
    whenSettled: waitForLatest,
    whenCriticalReady: waitForLatest,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      field.dispose();
      gpu.dispose();
      releaseRendererAttribute(gpu.indirect);
      for (const material of materials) material.material.dispose();
      group.removeFromParent();
      group.clear();
    },
    get stats() {
      return stats;
    }
  };
}
