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
  finishGrassMeshWrite,
  writeGrassMeshRange,
  type GrassEntry,
  type GrassMaterialState,
  type GrassMesh
} from "../groundcover/bladeGrass";
import { yieldToFrame } from "../../core/cooperativeWork";
import { fitGroundY } from "../groundcover/grounding";
import { hash2, r2Offset, valueNoise } from "../groundcover/scatter";
import type { GardenTerrain } from "../garden/layout";
import { grassyGround, nearAnyWildRegion } from "./layout";
import { GRASS_TUNING } from "../../config";

export const WILD_GRASS_SPACING = 0.68;
export const WILD_GRASS_RING_RADIUS = 110;
/** Finest persistent tile size; coarser layers own larger tiles below. */
export const WILD_GRASS_TILE_SIZE = 28;
/** Maximum player motion before entering/exiting tile membership is refreshed. */
export const WILD_GRASS_STREAM_STEP = 6;
export const WILD_GRASS_STREAM_MARGIN = WILD_GRASS_STREAM_STEP + 2;

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
  count: number;
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

export type WildGrassBuildJob = () => void | "again";

export type WildGrassBuildOptions = {
  /** Route bounded work through the app-wide frame scheduler when available. */
  schedule?: (job: WildGrassBuildJob) => void;
  /** CPU time target for one scheduler turn; hard cell/write caps also apply. */
  sliceBudgetMs?: number;
  /** Hidden publish lets the Wildlands preparation registry warm a layout first. */
  requirePreparation?: boolean;
  /** Deterministic clock injection for scheduler contracts. */
  now?: () => number;
};

export type WildGrass = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  /** Rebuild the current tile set after a live tuning change. */
  refresh(): void;
  /** Resolves after the currently requested generation has no remaining jobs. */
  whenSettled(): Promise<void>;
  /** Resolves once nearest non-empty coverage (or confirmed empty) exists per layer. */
  whenCriticalReady(): Promise<void>;
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

const DEFAULT_BUILD_SLICE_MS = 0.8;
const MAX_SAMPLE_STEPS_PER_SLICE = 128;
const MAX_UPLOAD_ENTRIES_PER_SLICE = 128;
const PUMP_TURNS = 4;
const SLICE_HISTOGRAM_STEP_MS = 0.05;
const SLICE_HISTOGRAM_BINS = 201;

type CellCache = Map<string, GrassEntry | null>;

type GrassTileBuild = {
  generation: number;
  layer: GrassLayerRuntime;
  key: string;
  tx: number;
  tz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  gx: number;
  gx1: number;
  gz: number;
  gz0: number;
  gz1: number;
  densityLayer: number;
  densityLayers: number;
  entries: GrassEntry[];
  bounds: THREE.Box3;
  mesh: GrassMesh | null;
  writeCursor: number;
  stage: "sample" | "allocate" | "upload" | "publish";
};

type GrassGeneration = {
  id: number;
  focus: { x: number; z: number };
  density: number;
  patchiness: number;
  cache: CellCache;
  cachedEntries: number;
  jobs: GrassTileBuild[];
  desired: Map<WildGrassLayerName, Set<string>>;
  remaining: Map<WildGrassLayerName, number>;
  criticalLayers: Set<WildGrassLayerName>;
  criticalPromise: Promise<void>;
  resolveCritical: () => void;
  criticalResolved: boolean;
};

export function createWildGrass(
  map: GardenTerrain,
  excluded?: (x: number, z: number) => boolean,
  options: WildGrassBuildOptions = {}
): WildGrass {
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

  const now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
  const sliceBudgetMs = Math.max(0.1, options.sliceBudgetMs ?? DEFAULT_BUILD_SLICE_MS);
  const fallbackSchedule = (job: WildGrassBuildJob): void => {
    void yieldToFrame().then(() => {
      if (job() === "again") fallbackSchedule(job);
    });
  };
  const schedule = options.schedule ?? fallbackSchedule;
  const requirePreparation = options.requirePreparation === true;
  let disposed = false;
  let generationId = 0;
  let generation: GrassGeneration | null = null;
  let activeJob: GrassTileBuild | null = null;
  let scheduledPumps = 0;
  let latestSliceStage: "idle" | "sample" | "allocate" | "upload" | "publish" = "idle";
  const sliceHistogram = new Uint32Array(SLICE_HISTOGRAM_BINS);
  const settledResolvers = new Set<() => void>();
  const streaming = {
    generation: 0,
    pendingJobs: 0,
    schedulerSlices: 0,
    sliceP90Ms: 0,
    maxSliceMs: 0,
    maxSampleSliceMs: 0,
    maxAllocateSliceMs: 0,
    maxUploadSliceMs: 0,
    maxPublishSliceMs: 0,
    maxSampleStepsPerSlice: 0,
    maxUploadEntriesPerSlice: 0,
    staleJobs: 0,
    preservedJobs: 0,
    publishedTiles: 0,
    criticalReady: false,
    criticalLayers: 0,
    criticalReadyAtSlice: 0,
    fullReadyAtSlice: 0,
    retainedEntryArrays: 0,
    retainedEntries: 0
  };
  group.userData.grassStreaming = streaming;

  const recordSliceTiming = (elapsed: number) => {
    const histogramIndex = Math.min(
      sliceHistogram.length - 1,
      Math.max(0, Math.floor(elapsed / SLICE_HISTOGRAM_STEP_MS))
    );
    sliceHistogram[histogramIndex]++;
    const percentileRank = Math.max(1, Math.ceil(streaming.schedulerSlices * 0.9));
    let accumulated = 0;
    for (let i = 0; i < sliceHistogram.length; i++) {
      accumulated += sliceHistogram[i];
      if (accumulated < percentileRank) continue;
      streaming.sliceP90Ms = (i + 1) * SLICE_HISTOGRAM_STEP_MS;
      break;
    }
    streaming.maxSliceMs = Math.max(streaming.maxSliceMs, elapsed);
    if (latestSliceStage === "sample") {
      streaming.maxSampleSliceMs = Math.max(streaming.maxSampleSliceMs, elapsed);
    } else if (latestSliceStage === "allocate") {
      streaming.maxAllocateSliceMs = Math.max(streaming.maxAllocateSliceMs, elapsed);
    } else if (latestSliceStage === "upload") {
      streaming.maxUploadSliceMs = Math.max(streaming.maxUploadSliceMs, elapsed);
    } else if (latestSliceStage === "publish") {
      streaming.maxPublishSliceMs = Math.max(streaming.maxPublishSliceMs, elapsed);
    }
  };

  const syncStreamingStats = () => {
    const jobs = [activeJob, ...(generation?.jobs ?? [])].filter(Boolean) as GrassTileBuild[];
    streaming.generation = generationId;
    streaming.pendingJobs = jobs.length;
    streaming.retainedEntryArrays = jobs.filter((job) => job.entries.length > 0).length;
    streaming.retainedEntries = jobs.reduce((sum, job) => sum + job.entries.length, 0) +
      (generation?.cachedEntries ?? 0);
  };

  const resolveSettled = () => {
    if (activeJob || generation?.jobs.length || scheduledPumps > 0) return;
    syncStreamingStats();
    for (const resolve of settledResolvers) resolve();
    settledResolvers.clear();
  };

  const resolveCriticalIfReady = (build: GrassGeneration) => {
    if (build.criticalResolved || build.criticalLayers.size < LAYER_ORDER.length) return;
    build.criticalResolved = true;
    streaming.criticalReady = true;
    streaming.criticalLayers = build.criticalLayers.size;
    streaming.criticalReadyAtSlice = streaming.schedulerSlices;
    build.resolveCritical();
  };

  const plantable = (x: number, z: number) => !excluded?.(x, z) && grassyGround(map, x, z);
  const sampleGround = (x: number, z: number) => map.groundHeight(x, z);

  function sampleCell(
    gx: number,
    gz: number,
    densityLayer: number,
    density: number,
    patchiness: number,
    build: GrassGeneration
  ): GrassEntry | null {
    const cache = build.cache;
    const key = `${gx},${gz},${densityLayer}`;
    if (cache.has(key)) return cache.get(key) ?? null;

    const salt = densityLayer * 101;
    // R2 low-discrepancy jitter (was raw hash2) — same in-cell clamp, far fewer
    // clumps/gaps between neighbouring blades. See scatter.r2Offset.
    const jitter = r2Offset(gx, gz, 11 + salt);
    const px = gx * WILD_GRASS_SPACING + (jitter.ox - 0.5) * WILD_GRASS_SPACING * 0.86;
    const pz = gz * WILD_GRASS_SPACING + (jitter.oz - 0.5) * WILD_GRASS_SPACING * 0.86;
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
    build.cachedEntries++;
    return entry;
  }

  function createTileBuild(
    build: GrassGeneration,
    layer: GrassLayerRuntime,
    tx: number,
    tz: number
  ): GrassTileBuild {
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
    return {
      generation: build.id,
      layer,
      key: `${tx},${tz}`,
      tx,
      tz,
      minX,
      maxX,
      minZ,
      maxZ,
      gx: gx0,
      gx1,
      gz: gz0,
      gz0,
      gz1,
      densityLayer: 0,
      densityLayers: Math.max(1, Math.ceil(build.density)),
      entries: [],
      bounds: new THREE.Box3(),
      mesh: null,
      writeCursor: 0,
      stage: build.density > 0 ? "sample" : "publish"
    };
  }

  function removeTile(layer: GrassLayerRuntime, tile: GrassTile) {
    if (!tile.mesh) return;
    group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh = null;
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
        layerCount += tile.count;
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

  const discardBuild = (job: GrassTileBuild) => {
    job.entries.length = 0;
    job.mesh?.geometry.dispose();
    job.mesh = null;
  };

  const cancelGeneration = () => {
    if (activeJob) {
      discardBuild(activeJob);
      activeJob = null;
      streaming.staleJobs++;
    }
    if (generation) {
      if (!generation.criticalResolved) {
        generation.criticalResolved = true;
        generation.resolveCritical();
      }
      streaming.staleJobs += generation.jobs.length;
      for (const job of generation.jobs) discardBuild(job);
      generation.jobs.length = 0;
      generation.cache.clear();
      generation.cachedEntries = 0;
      generation = null;
    }
    syncStreamingStats();
  };

  const retireCompletedLayer = (build: GrassGeneration, layer: GrassLayerRuntime) => {
    if ((build.remaining.get(layer.name) ?? 0) > 0) return;
    const desired = build.desired.get(layer.name)!;
    if (requirePreparation) {
      for (const key of desired) {
        const tile = layer.tiles.get(key);
        if (tile?.mesh && !tile.mesh.visible) return;
      }
    }
    for (const [key, tile] of layer.tiles) {
      if (desired.has(key)) continue;
      removeTile(layer, tile);
      layer.tiles.delete(key);
    }
  };

  const retireCompletedLayers = () => {
    if (!generation) return;
    for (const layer of layers) retireCompletedLayer(generation, layer);
    updateStats();
  };

  const advanceSampleCursor = (job: GrassTileBuild) => {
    job.densityLayer++;
    if (job.densityLayer < job.densityLayers) return;
    job.densityLayer = 0;
    job.gz += job.layer.spec.gridStride;
    if (job.gz <= job.gz1) return;
    job.gz = job.gz0;
    job.gx += job.layer.spec.gridStride;
    if (job.gx > job.gx1) job.stage = "allocate";
  };

  const sampleBuildCell = (job: GrassTileBuild, build: GrassGeneration) => {
    const entry = sampleCell(
      job.gx,
      job.gz,
      job.densityLayer,
      build.density,
      build.patchiness,
      build
    );
    if (
      entry &&
      entry.x >= job.minX && entry.x < job.maxX &&
      entry.z >= job.minZ && entry.z < job.maxZ
    ) {
      // Half-open ownership by final jittered position: different tile sizes
      // reconstruct exactly the same canonical cells without seams or swimming.
      job.entries.push(entry);
      job.bounds.min.x = Math.min(job.bounds.min.x, entry.x);
      job.bounds.min.y = Math.min(job.bounds.min.y, entry.y + entry.height * 0.5);
      job.bounds.min.z = Math.min(job.bounds.min.z, entry.z);
      job.bounds.max.x = Math.max(job.bounds.max.x, entry.x);
      job.bounds.max.y = Math.max(job.bounds.max.y, entry.y + entry.height * 0.5);
      job.bounds.max.z = Math.max(job.bounds.max.z, entry.z);
    }
    advanceSampleCursor(job);
  };

  const allocateBuildMesh = (job: GrassTileBuild) => {
    if (job.entries.length === 0) {
      job.stage = "publish";
      return;
    }
    const mesh = createGrassMesh(
      `wildlands_grass_${job.layer.name}_${job.tx}_${job.tz}`,
      job.entries.length,
      job.layer.geometry,
      job.layer.material.material,
      false
    );
    mesh.frustumCulled = true;
    mesh.userData.grassLayer = job.layer.name;
    // The mesh remains completely off-scene and invisible until every compact
    // buffer byte and conservative bound is ready.
    mesh.visible = false;
    job.mesh = mesh;
    job.stage = "upload";
  };

  const uploadBuildRange = (job: GrassTileBuild) => {
    const mesh = job.mesh!;
    const end = Math.min(job.entries.length, job.writeCursor + MAX_UPLOAD_ENTRIES_PER_SLICE);
    writeGrassMeshRange(mesh, job.entries, job.layer.spec.visibleRadius, job.writeCursor, end);
    job.writeCursor = end;
    if (end < job.entries.length) return;

    finishGrassMeshWrite(mesh, job.entries.length);
    const box = job.bounds.clone().expandByScalar(2.5);
    mesh.geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    // finishGrassMeshWrite publishes a non-zero local count; preparation still
    // owns live visibility, so reset it before the atomic group insertion.
    mesh.visible = false;
    job.stage = "publish";
  };

  const publishBuild = (job: GrassTileBuild, build: GrassGeneration) => {
    if (job.generation !== generationId || build !== generation || disposed) {
      discardBuild(job);
      streaming.staleJobs++;
      return;
    }
    const previous = job.layer.tiles.get(job.key);
    if (previous) removeTile(job.layer, previous);
    const mesh = job.mesh;
    if (mesh) {
      mesh.visible = !requirePreparation;
      group.add(mesh);
      streaming.publishedTiles++;
    }
    job.layer.tiles.set(job.key, {
      tx: job.tx,
      tz: job.tz,
      count: job.entries.length,
      mesh
    });
    // GPU attributes now own the compact 36-byte payload. Never retain the much
    // larger GrassEntry object array on a resident tile.
    job.mesh = null;
    job.entries.length = 0;
    const remaining = Math.max(0, (build.remaining.get(job.layer.name) ?? 1) - 1);
    build.remaining.set(job.layer.name, remaining);
    if ((mesh?.geometry.instanceCount ?? 0) > 0 || remaining === 0) {
      build.criticalLayers.add(job.layer.name);
      streaming.criticalLayers = build.criticalLayers.size;
      resolveCriticalIfReady(build);
    }
    retireCompletedLayer(build, job.layer);
    updateStats();
  };

  const hasBuildWork = () => Boolean(activeJob || generation?.jobs.length);

  const pumpBuildSlice = (): boolean => {
    if (disposed) return false;
    const sliceStarted = now();
    let sampleSteps = 0;
    latestSliceStage = "idle";
    while (true) {
      const build = generation;
      if (!build) return false;
      if (activeJob && activeJob.generation !== generationId) {
        discardBuild(activeJob);
        activeJob = null;
        streaming.staleJobs++;
      }
      activeJob ??= build.jobs.shift() ?? null;
      const job = activeJob;
      if (!job) {
        build.cache.clear();
        build.cachedEntries = 0;
        for (const layer of LAYER_ORDER) build.criticalLayers.add(layer);
        resolveCriticalIfReady(build);
        streaming.fullReadyAtSlice = streaming.schedulerSlices;
        retireCompletedLayers();
        syncStreamingStats();
        return false;
      }

      if (job.stage === "sample") {
        latestSliceStage = "sample";
        sampleBuildCell(job, build);
        sampleSteps++;
        streaming.maxSampleStepsPerSlice = Math.max(
          streaming.maxSampleStepsPerSlice,
          sampleSteps
        );
        if (
          sampleSteps >= MAX_SAMPLE_STEPS_PER_SLICE ||
          now() - sliceStarted >= sliceBudgetMs
        ) return true;
        continue;
      }
      if (job.stage === "allocate") {
        latestSliceStage = "allocate";
        allocateBuildMesh(job);
        return true;
      }
      if (job.stage === "upload") {
        latestSliceStage = "upload";
        const writeStarted = job.writeCursor;
        uploadBuildRange(job);
        streaming.maxUploadEntriesPerSlice = Math.max(
          streaming.maxUploadEntriesPerSlice,
          job.writeCursor - writeStarted
        );
        return true;
      }

      latestSliceStage = "publish";
      publishBuild(job, build);
      activeJob = null;
      syncStreamingStats();
      if (now() - sliceStarted >= sliceBudgetMs) return hasBuildWork();
    }
  };

  const ensureBuildPumps = () => {
    if (disposed || !hasBuildWork()) return;
    while (scheduledPumps < PUMP_TURNS) {
      scheduledPumps++;
      const pump: WildGrassBuildJob = () => {
        const started = now();
        const again = pumpBuildSlice();
        const elapsed = now() - started;
        streaming.schedulerSlices++;
        recordSliceTiming(elapsed);
        if (again) return "again";
        scheduledPumps--;
        resolveSettled();
      };
      schedule(pump);
    }
  };

  function syncLayers(focus: { x: number; z: number }, force = false) {
    if (
      !force &&
      Number.isFinite(lastSyncX) &&
      Math.hypot(focus.x - lastSyncX, focus.z - lastSyncZ) < WILD_GRASS_STREAM_STEP
    ) return;
    lastSyncX = focus.x;
    lastSyncZ = focus.z;

    if (force) cancelGeneration();
    const previousGeneration = force ? null : generation;
    const previousActiveJob = force ? null : activeJob;
    const previousJobs = previousGeneration
      ? [activeJob, ...previousGeneration.jobs].filter(Boolean) as GrassTileBuild[]
      : [];
    if (!force) activeJob = null;
    if (previousGeneration) {
      if (!previousGeneration.criticalResolved) {
        previousGeneration.criticalResolved = true;
        previousGeneration.resolveCritical();
      }
      // The job-local entry arrays own every sampled value needed to continue.
      // Drop the cross-layer cache at each focus revision so continuous travel
      // cannot grow it without bound; still-desired partial jobs survive below.
      previousGeneration.jobs.length = 0;
      previousGeneration.cache.clear();
      previousGeneration.cachedEntries = 0;
    }
    let resolveCritical!: () => void;
    const criticalPromise = new Promise<void>((resolve) => {
      resolveCritical = resolve;
    });
    const build: GrassGeneration = {
      id: ++generationId,
      focus: { x: focus.x, z: focus.z },
      density: previousGeneration?.density ?? Math.max(0, Number(GRASS_TUNING.values.density)),
      patchiness: previousGeneration?.patchiness ??
        THREE.MathUtils.clamp(Number(GRASS_TUNING.values.patchiness), 0, 1),
      cache: new Map(),
      cachedEntries: 0,
      jobs: [],
      desired: new Map(),
      remaining: new Map(),
      criticalLayers: new Set(),
      criticalPromise,
      resolveCritical,
      criticalResolved: false
    };
    generation = build;
    streaming.criticalReady = false;
    streaming.criticalLayers = 0;
    streaming.criticalReadyAtSlice = 0;
    streaming.fullReadyAtSlice = 0;

    const candidates = new Map<WildGrassLayerName, { key: string; tx: number; tz: number }[]>();

    for (const layer of layers) {
      const { tileSize, visibleRadius } = layer.spec;
      const streamRadius = visibleRadius + WILD_GRASS_STREAM_MARGIN;
      const focusTileX = Math.floor(focus.x / tileSize);
      const focusTileZ = Math.floor(focus.z / tileSize);
      const tileReach = Math.ceil(streamRadius / tileSize) + 1;
      const desired = new Set<string>();
      const layerCandidates: { key: string; tx: number; tz: number }[] = [];
      for (let tx = focusTileX - tileReach; tx <= focusTileX + tileReach; tx++) {
        for (let tz = focusTileZ - tileReach; tz <= focusTileZ + tileReach; tz++) {
          if (tileDistance(tx, tz, tileSize, focus) > streamRadius) continue;
          const key = `${tx},${tz}`;
          desired.add(key);
          if (!layer.tiles.has(key)) layerCandidates.push({ key, tx, tz });
        }
      }
      build.desired.set(layer.name, desired);
      candidates.set(layer.name, layerCandidates);
    }

    const preserved = new Map<string, GrassTileBuild>();
    for (const job of previousJobs) {
      const desired = build.desired.get(job.layer.name)!;
      if (desired.has(job.key) && !job.layer.tiles.has(job.key)) {
        job.generation = build.id;
        preserved.set(`${job.layer.name}:${job.key}`, job);
        streaming.preservedJobs++;
      } else {
        discardBuild(job);
        streaming.staleJobs++;
      }
    }

    for (const layer of layers) {
      const layerJobs: GrassTileBuild[] = [];
      for (const candidate of candidates.get(layer.name)!) {
        const id = `${layer.name}:${candidate.key}`;
        layerJobs.push(
          preserved.get(id) ?? createTileBuild(build, layer, candidate.tx, candidate.tz)
        );
        preserved.delete(id);
      }
      // Defensive: no preserved descriptor may survive without a desired slot.
      build.remaining.set(layer.name, layerJobs.length);
      build.jobs.push(...layerJobs);
      const hasContainingCoverage = [...layer.tiles.entries()].some(([key, tile]) =>
        build.desired.get(layer.name)!.has(key) &&
        tile.count > 0 &&
        tileDistance(tile.tx, tile.tz, layer.spec.tileSize, focus) === 0
      );
      if (hasContainingCoverage || layerJobs.length === 0) {
        build.criticalLayers.add(layer.name);
      }
    }
    for (const job of preserved.values()) {
      discardBuild(job);
      streaming.staleJobs++;
    }
    build.jobs.sort((a, b) => {
      const distance = tileDistance(a.tx, a.tz, a.layer.spec.tileSize, focus) -
        tileDistance(b.tx, b.tz, b.layer.spec.tileSize, focus);
      if (distance !== 0) return distance;
      const layer = LAYER_ORDER.indexOf(a.layer.name) - LAYER_ORDER.indexOf(b.layer.name);
      if (layer !== 0) return layer;
      return a.tx - b.tx || a.tz - b.tz;
    });
    // Keep the one already-running, still-desired tile at the head. Without
    // this bounded continuation exception, a player crossing the 6m refresh
    // step every frame could repeatedly place fresh zero-distance descriptors
    // ahead of the same partial tile and prevent any atomic publish forever.
    if (previousActiveJob) {
      const continuingIndex = build.jobs.indexOf(previousActiveJob);
      if (continuingIndex > 0) {
        build.jobs.splice(continuingIndex, 1);
        build.jobs.unshift(previousActiveJob);
      }
    }
    retireCompletedLayers();
    resolveCriticalIfReady(build);
    syncStreamingStats();
    ensureBuildPumps();
  }

  return {
    group,
    update(focus) {
      lastFocus.x = focus.x;
      lastFocus.z = focus.z;
      for (const layer of layers) layer.material.focus.set(focus.x, focus.z);
      if (!nearAnyWildRegion(focus.x, focus.z, WILD_GRASS_RING_RADIUS + 2)) {
        generationId++;
        cancelGeneration();
        if (stats.tiles > 0) clearTiles();
        lastSyncX = Number.NaN;
        lastSyncZ = Number.NaN;
        return;
      }
      syncLayers(focus);
      // Preparation may have revealed a completed replacement since the last
      // frame. Only then retire its outgoing coverage.
      retireCompletedLayers();
    },
    refresh() {
      if (lastFocus.x >= 1e8) return;
      generationId++;
      cancelGeneration();
      clearTiles();
      lastSyncX = Number.NaN;
      lastSyncZ = Number.NaN;
      if (nearAnyWildRegion(lastFocus.x, lastFocus.z, WILD_GRASS_RING_RADIUS + 2)) {
        syncLayers(lastFocus, true);
      }
    },
    whenSettled() {
      if (!hasBuildWork() && scheduledPumps === 0) return Promise.resolve();
      return new Promise<void>((resolve) => settledResolvers.add(resolve));
    },
    async whenCriticalReady() {
      while (!disposed) {
        const requested = generation;
        if (!requested || requested.criticalResolved) return;
        await requested.criticalPromise;
        if (requested === generation) return;
      }
    },
    dispose() {
      disposed = true;
      generationId++;
      cancelGeneration();
      clearTiles();
      for (const layer of layers) {
        layer.geometry.dispose();
        layer.material.material.dispose();
      }
      group.removeFromParent();
      group.clear();
      for (const resolve of settledResolvers) resolve();
      settledResolvers.clear();
    },
    get stats() {
      return stats;
    }
  };
}
