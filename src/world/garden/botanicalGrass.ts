// SF Botanical Garden tall-grass — the GPU indirect pipeline. This used to be a
// CPU path (per-48m InstancedMesh base tiles + streamed CPU-sampled detail tiles,
// 132 hydrated draws plus a 100-180ms full-ring resample hitch dodged behind a
// focus-speed gate). It now rides the SAME architecture as the wildlands meadow:
//
//   • a garden-scoped FoliageField (player-following float clipmap: ground height,
//     keep/density, dry/style, meadow-short/vigour) sampled lazily on the CPU in
//     sub-millisecond slices — no whole-ring resample, so the hitch class is gone;
//   • createGpuGrassPlacement: one compute dispatch per additive layer scatters
//     candidates on the canonical world grid, samples the field, rejects
//     excluded/slope/out-of-range candidates and compacts survivors into storage
//     buffers; a per-frame frustum cull writes indirect draw counts (cull →
//     atomicAdd → visible-index indirection), so only in-view blades reach the
//     vertex shader with zero CPU readback in the loop.
//
// Result: 132 hydrated draws → 4 indirect draws (base carpet + near/mid/far
// detail). The garden supplies ITS OWN styling through the placement's TSL style
// hook (path-dry tint, greenBias, meadow-short lawn) and paints its keep/dry/
// meadow-stature intent into the field channels; the shared runtime owns
// placement, compaction, culling and wind.

import * as THREE from "three/webgpu";
import { float, select, vec3 } from "three/tsl";
import {
  GARDEN_SPECIES,
  gardenPathSignedDistance,
  gardenSurfaceHeight,
  inBotanicalGarden,
  meadowEllipse,
  type GardenTerrain,
  type GardenTree
} from "./layout";
import { inJapaneseTeaGarden } from "../japaneseTeaGarden/layout";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  type GrassIndirectSource,
  type GrassMaterialState
} from "../groundcover/bladeGrass";
import {
  createGpuGrassPlacement,
  type GpuGrassLayerInput,
  type GpuGrassPlacement,
  type GpuGrassStyleHook
} from "../groundcover/gpuGrassPlacement";
import {
  FoliageField,
  type FoliageFieldPaint
} from "../groundcover/foliageField";
import { requireRenderer } from "../../app/rendererRegistry";
import { governorEffects, onGovernorChange } from "../../render/adaptiveResolution";
import { BOTANICAL_GRASS_TUNING } from "./grassTuning";

export type BotanicalGrassStats = {
  gpuGenerated: true;
  /** One indirect draw per resident layer. */
  draws: number;
  /** Total candidate-buffer capacity across all layers. */
  sourceCount: number;
  layers: number;
};

type GrassFocus = { x: number; z: number };

// --- placement + density budgets -------------------------------------------------
// Capacity per layer is derived from its visibleRadius / (spacing × gridStride) ×
// MAX_DENSITY_LAYERS (fixed storage-buffer sizing that replaces the old
// MAX_LIVE_* live-instance caps). The density UNIFORM (× governor foliageScale)
// then trims within that ceiling exactly like wildlands.
const GARDEN_GRASS_SPACING = 0.5;
const MAX_DENSITY_LAYERS = 2;
// Authored ceiling for the additive fill model. Meadow keep (~0.99) fills ~1.5
// sub-layers here; QA-tunable against the meadow + collection screenshots.
const GARDEN_GRASS_DENSITY = 1.5;
// Botanical lawn reads as an even sward, not the wild meadow's patchy clumping.
const GARDEN_GRASS_PATCHINESS = 0.12;
// Retarget the paged field + GPU compactors after this much player motion.
const GARDEN_GRASS_STREAM_STEP = 6;

type GardenLayerName = "base" | "far" | "mid" | "near";

type GardenLayerDef = Readonly<{
  /** Use every Nth canonical GARDEN_GRASS_SPACING world cell on each axis. */
  gridStride: number;
  visibleRadius: number;
  fadeBand: number;
  /** Inner hole + grow-in band (see GpuGrassLayerSpec.minRadius). Only `mid`
   *  needs it: it shares `near`'s gridStride and therefore its exact anchors. */
  minRadius?: number;
  innerBand?: number;
  wind: "full" | "lite";
  interactionSlots: number;
  /** SSS only for the nearest hero layer (wildlands near/hero convention). */
  sss: boolean;
  geometry: { blades: number; segments: number; width: number; radius: number; curvature: number };
}>;

// Heights/colours/densities ported from the old controller's base + near/mid/far
// detail geometry (blades/segments/width/radius/curvature) and its 44m near ring
// LOD bands (near<16, mid<30, far<46) plus the ~140m base view distance.
//
// The meadow is fragment-bound, not triangle-bound: what costs is BLADE
// SILHOUETTE AREA (width × height × blades/m²) times the depth complexity a
// grazing view stacks up, so the budgets below are graded on blades/m² and per-
// blade width rather than on triangle count. Two consequences worth keeping:
//   • `mid` shares `near`'s gridStride, so before `minRadius` existed the whole
//     0-16m hero ring was scattered twice at bit-identical anchors and drawn as
//     two interpenetrating tufts. `mid` now grows in as `near` dissolves out.
//   • `base` blades are 1-2px wide at 100m, where Apple's 2×2 quad shading
//     amplifies a sliver ~3×. Fewer + wider is strictly cheaper for the same
//     carpet read, so base trades a blade for width.
const GARDEN_LAYERS: Record<GardenLayerName, GardenLayerDef> = {
  // Distant carpet: coarse stride, cheap 1-segment clusters, lite wind, no trample.
  base: {
    gridStride: 3,
    visibleRadius: 136,
    fadeBand: 30,
    wind: "lite",
    interactionSlots: 0,
    sss: false,
    geometry: { blades: 2, segments: 1, width: 0.18, radius: 0.53, curvature: 0.2 }
  },
  far: {
    gridStride: 2,
    visibleRadius: 46,
    fadeBand: 16,
    wind: "lite",
    interactionSlots: 0,
    sss: false,
    geometry: { blades: 3, segments: 1, width: 0.16, radius: 0.6, curvature: 0.2 }
  },
  mid: {
    gridStride: 1,
    visibleRadius: 30,
    fadeBand: 12,
    // near dissolves over 8-16m with RANK_FADE_SOFT (0.25) of soft window, so
    // 16 - 8 × 1.5 = 4 puts mid at full size exactly where near begins to shrink.
    minRadius: 4,
    innerBand: 8,
    wind: "lite",
    interactionSlots: 4,
    sss: false,
    geometry: { blades: 3, segments: 2, width: 0.115, radius: 0.46, curvature: 0.25 }
  },
  // Hero ring at the player's feet: full wind, all 12 displacers, translucent SSS.
  // Carries one extra blade at a wider root radius to hold the sward's read now
  // that mid no longer stacks a second tuft on the same anchor.
  near: {
    gridStride: 1,
    visibleRadius: 16,
    fadeBand: 8,
    wind: "full",
    interactionSlots: 12,
    sss: true,
    geometry: { blades: 6, segments: 3, width: 0.088, radius: 0.44, curvature: 0.27 }
  }
};

const GARDEN_LAYER_ORDER: readonly GardenLayerName[] = ["base", "far", "mid", "near"] as const;

function layerTriangles(def: GardenLayerDef): number {
  return def.geometry.blades * (def.geometry.segments * 2 + 1);
}

// --- deterministic garden noise (matches the old CPU sampler's patch field) ------

function hash(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const ax = fx - ix;
  const az = fz - iz;
  const sx = ax * ax * (3 - 2 * ax);
  const sz = az * az * (3 - 2 * az);
  const n00 = hash(ix, iz, salt);
  const n10 = hash(ix + 1, iz, salt);
  const n01 = hash(ix, iz + 1, salt);
  const n11 = hash(ix + 1, iz + 1, salt);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
}

function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / Math.max(1e-5, b - a)));
  return u * u * (3 - 2 * u);
}

const TREE_BUCKET = 18;

/** Trunk-clearance test built from the garden trees (returns <0 inside a trunk's
 *  cleared radius). Same bucketed lookup the old CPU sampler used. */
function createTreeClearance(trees: GardenTree[]): (x: number, z: number) => number {
  const buckets = new Map<string, GardenTree[]>();
  const key = (ix: number, iz: number) => `${ix},${iz}`;
  for (const tree of trees) {
    const ix = Math.floor(tree.x / TREE_BUCKET);
    const iz = Math.floor(tree.z / TREE_BUCKET);
    const list = buckets.get(key(ix, iz));
    if (list) list.push(tree);
    else buckets.set(key(ix, iz), [tree]);
  }
  return (x: number, z: number) => {
    const ix = Math.floor(x / TREE_BUCKET);
    const iz = Math.floor(z / TREE_BUCKET);
    let shade = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = buckets.get(key(ix + dx, iz + dz));
        if (!list) continue;
        for (const tree of list) {
          const species = GARDEN_SPECIES[tree.species];
          const trunkClear = species.trunkR * tree.scale + BOTANICAL_GRASS_TUNING.values.treeClearance;
          const d = Math.hypot(x - tree.x, z - tree.z);
          if (d < trunkClear) return -1;
          shade = Math.max(shade, 1 - smoothstep(trunkClear, trunkClear + 4.5, d));
        }
      }
    }
    return shade;
  };
}

// --- CPU field paint: the OLD analytic tests, now baked into the clipmap ----------

/** In-garden ∧ not-tea-garden ∧ lawn surface ∧ not-water ∧ path-clear ∧
 *  trunk-clear. The GPU accepts a candidate only where the field's density
 *  (G channel) is > 0, so this predicate lives entirely in the paint below. */
function gardenPlantable(
  map: GardenTerrain,
  x: number,
  z: number,
  treeClearAt: (x: number, z: number) => number
): boolean {
  if (!inBotanicalGarden(x, z) || inJapaneseTeaGarden(x, z, 4)) return false;
  if (map.surfaceType(x, z) !== 1 || map.isWater(x, z)) return false;
  if (gardenPathSignedDistance(x, z) < BOTANICAL_GRASS_TUNING.values.pathMargin) return false;
  return treeClearAt(x, z) >= 0;
}

/**
 * Map the old keep/dry/tallShare logic onto the field channels the GPU reads:
 *   • density (G) ← spatial `keep` (meadow vs collection vs path-edge). The GPU
 *     `fill` model scales this by the density uniform and composes it across
 *     MAX_DENSITY_LAYERS, so a thinner keep makes a sparser patch, not a cliff.
 *   • style   (B) ← `dry` (path-proximity + low-patch), the garden hook's tint.
 *   • height  (A) ← meadow-short ↔ collection-tall stature; the hook uses it both
 *     as a gentle height vigour and as the tall-clump gate (meadow gets none).
 */
function gardenPaint(
  map: GardenTerrain,
  x: number,
  z: number,
  treeClearAt: (x: number, z: number) => number
): FoliageFieldPaint {
  const values = BOTANICAL_GRASS_TUNING.values;
  if (!gardenPlantable(map, x, z, treeClearAt)) {
    return { density: 0, species: 0.5, height: 0.9 };
  }
  const pathDistance = gardenPathSignedDistance(x, z);
  const patch = valueNoise(x, z, 31, 701);
  const inMeadow = meadowEllipse(x, z) < 1.04;

  let keep = inMeadow ? values.meadowKeep : values.collectionKeep;
  if (pathDistance < values.pathMargin + values.pathFeather) keep *= values.pathEdgeKeep;
  if (treeClearAt(x, z) > 0) keep *= 0.95;

  const nearPath = 1 - smoothstep(values.pathMargin, values.pathMargin + values.pathFeather, pathDistance);
  const dry = Math.min(1, nearPath * 0.42 + (1 - patch) * 0.18);
  // Meadow → low stature (short lawn, no tall clumps); collections → patch-driven
  // higher stature (tall clumps appear). Bilinear blend feathers the transition.
  const stature = inMeadow ? 0.6 : Math.min(1.15, 0.9 + patch * 0.2);

  return {
    density: THREE.MathUtils.clamp(keep, 0, 1),
    species: dry,
    height: stature
  };
}

// --- GPU styling hook: ports the old botanical blade material -------------------

/** Reproduce the old controller's colour/height/tall-share look as a function of
 *  the sampled field texel (dry = B/style, stature = A/height). Tuning constants
 *  are baked from BOTANICAL_GRASS_TUNING at build time. */
function createGardenStyleHook(): GpuGrassStyleHook {
  const values = BOTANICAL_GRASS_TUNING.values;
  const brightnessBase = Number(values.brightness);
  const greenBias = Number(values.greenBias);
  const heightScale = Number(values.heightScale);
  const tallShare = Number(values.tallShare);

  return ({ gx, gz, saltF, eco, hash01 }) => {
    const h = (salt: number, dither: number) => hash01(gx, gz, salt).add(saltF.mul(dither)).fract();
    const dry = eco.z.clamp(0, 1);
    const stature = eco.w.clamp(0.25, 2);
    // Meadow (low stature) grows no tall clumps; collections (high stature) do.
    const tallAllow = stature.smoothstep(0.7, 0.85);
    const tallChance = float(tallShare).mul(tallAllow);
    const tall = h(31, 0.0000002980232239).lessThan(tallChance);
    const tallHeight = float(0.9).add(h(37, 0.0000003576278687).mul(0.7));
    const shortHeight = float(0.44).add(h(41, 0.0000004172325134).mul(0.38));
    // Vigour is decoupled from meadow-shortness so blade height stays roughly
    // uniform (only the tall-clump gate reads the meadow flag).
    const vigour = float(0.85).add(stature.mul(0.22));
    const height = select(tall, tallHeight, shortHeight).mul(vigour).mul(float(heightScale));
    const spread = select(tall, float(1.05), float(0.84))
      .mul(float(0.84).add(h(43, 0.0000004768371582).mul(0.34)))
      .mul(float(0.96).add(vigour.mul(0.04)));
    const brightness = float(brightnessBase).mul(float(0.86).add(h(29, 0.000000536441803).mul(0.26)));
    const color = vec3(
      brightness.mul(float(0.62).add(dry.mul(0.25))).mul(float(1 - greenBias * 0.2)),
      brightness.mul(float(0.9).sub(dry.mul(0.15))),
      brightness.mul(float(0.42).sub(dry.mul(0.08))).mul(float(1 - greenBias * 0.45))
    );
    const yaw = h(47, 0.0000006556510925).mul(Math.PI * 2);
    const wind = float(0.74).add(height.mul(0.34)).mul(select(tall, float(1.08), float(1)));
    return { height, spread, yaw, wind, color };
  };
}

/**
 * The garden's tall-grass. A THREE.Group holding the four GPU-generated indirect
 * meshes; nothing is hydrated on the CPU. Driven by the garden's per-frame update
 * (updateFocus retargets the field/placement, cullFrame runs the per-frame
 * frustum cull), gated by the garden distance gate / park() and the master
 * foliage toggle upstream.
 */
export class BotanicalGrassController extends THREE.Group {
  readonly stats: BotanicalGrassStats;

  #renderer: THREE.WebGPURenderer;
  #field: FoliageField;
  #gpu: GpuGrassPlacement;
  #materials: GrassMaterialState[] = [];
  #disposed = false;
  #asleep = true;
  #generation = 0;
  #lastSyncX = Number.NaN;
  #lastSyncZ = Number.NaN;
  #lastFocus: GrassFocus = { x: 1e9, z: 1e9 };
  #lastFoliageScale: number;
  #unsubscribeGovernor: () => void;

  constructor(map: GardenTerrain, trees: GardenTree[]) {
    super();
    this.name = "sfbg_procedural_grass";
    this.#renderer = requireRenderer();

    const treeClearAt = createTreeClearance(trees);
    this.#field = new FoliageField({
      groundHeight: (x, z) => gardenSurfaceHeight(map, x, z),
      plantable: (x, z) => gardenPlantable(map, x, z, treeClearAt),
      paint: (x, z) => gardenPaint(map, x, z, treeClearAt)
    });

    const styleHook = createGardenStyleHook();
    const sourceGeometries: THREE.BufferGeometry[] = [];
    const inputs: GpuGrassLayerInput[] = GARDEN_LAYER_ORDER.map((name) => {
      const def = GARDEN_LAYERS[name];
      const geometry = createBladeClusterGeometry(def.geometry);
      sourceGeometries.push(geometry);
      return {
        spec: {
          name,
          gridStride: def.gridStride,
          visibleRadius: def.visibleRadius,
          fadeBand: def.fadeBand,
          minRadius: def.minRadius,
          innerBand: def.innerBand
        },
        geometry,
        materialFor: (source: GrassIndirectSource) => {
          const material = createGrassMaterial({
            sss: def.sss,
            wind: def.wind,
            interactionSlots: def.interactionSlots,
            fadeMode: "rank",
            fadeBand: def.fadeBand,
            // Must mirror the spec exactly: the cull rejects, the material shrinks.
            minRadius: def.minRadius,
            innerBand: def.innerBand,
            indirectSource: source
          });
          this.#materials.push(material);
          return material;
        },
        trianglesPerCluster: layerTriangles(def),
        style: styleHook
      };
    });

    this.#gpu = createGpuGrassPlacement(
      this.#field,
      inputs,
      GARDEN_GRASS_SPACING,
      MAX_DENSITY_LAYERS,
      "sfbg"
    );
    for (const geometry of sourceGeometries) geometry.dispose();
    for (const layer of this.#gpu.layers) {
      // Visible from the start (with a 0-instance indirect draw) so the garden's
      // deferred compileAsync warms all four blade pipelines before reveal; the
      // per-frame cull fills the real counts once the field pages in. park()
      // hides them; the whole garden group is distance-gated above this.
      layer.mesh.visible = true;
      this.add(layer.mesh);
    }

    this.stats = {
      gpuGenerated: true,
      draws: this.#gpu.layers.length,
      sourceCount: this.#gpu.layers.reduce((sum, layer) => sum + layer.capacity, 0),
      layers: this.#gpu.layers.length
    };
    // QA surface: probes read live per-frame draw counts straight off the shared
    // indirect buffer (renderer.getArrayBufferAsync) and the paged field.
    this.userData.grassStats = { ...this.stats };
    this.userData.grassIndirect = this.#gpu.indirect;
    this.userData.foliageField = this.#field;

    this.#lastFoliageScale = governorEffects().foliageScale;
    this.#unsubscribeGovernor = onGovernorChange((effects) => {
      if (effects.foliageScale === this.#lastFoliageScale) return;
      this.#lastFoliageScale = effects.foliageScale;
      if (!this.#asleep && this.#lastFocus.x < 1e8) this.#requestGeneration(this.#lastFocus);
    });
  }

  /** Retarget the paged field + GPU compactors toward `focus` (stream-step gated,
   *  like wildlands). Called every active frame from the garden update path. */
  updateFocus(focus: GrassFocus): void {
    if (this.#disposed) return;
    this.#asleep = false;
    for (const layer of this.#gpu.layers) layer.mesh.visible = true;
    this.#lastFocus.x = focus.x;
    this.#lastFocus.z = focus.z;
    // The blade material's rank fade tracks the live player every frame.
    for (const material of this.#materials) material.focus.set(focus.x, focus.z);
    if (
      Number.isFinite(this.#lastSyncX) &&
      Math.hypot(focus.x - this.#lastSyncX, focus.z - this.#lastSyncZ) < GARDEN_GRASS_STREAM_STEP
    ) return;
    this.#lastSyncX = focus.x;
    this.#lastSyncZ = focus.z;
    this.#requestGeneration(focus);
  }

  /** Per-frame GPU frustum cull against the render camera. Cheap; no readback. */
  cullFrame(camera: THREE.Camera): void {
    if (this.#disposed || this.#asleep) return;
    // Read the SAME live focus as the material shrink so the rank fade and the
    // cull's extinction threshold stay in lockstep.
    this.#gpu.cullFocus.set(this.#lastFocus.x, this.#lastFocus.z);
    this.#gpu.updateCullCamera(camera);
    this.#renderer.compute(this.#gpu.cullPasses);
  }

  /** Distance-gated / foliage-off: hide every layer and stop paging. Any in-flight
   *  retarget is dropped so it cannot re-reveal blades while parked. */
  park(): void {
    if (this.#asleep) return;
    this.#asleep = true;
    this.#generation++;
    this.#lastSyncX = Number.NaN;
    this.#lastSyncZ = Number.NaN;
    for (const layer of this.#gpu.layers) layer.mesh.visible = false;
  }

  #requestGeneration(focus: GrassFocus): void {
    if (this.#disposed) return;
    const id = ++this.#generation;
    const destination = { x: focus.x, z: focus.z };
    void (async () => {
      await this.#field.request(destination);
      if (this.#disposed || id !== this.#generation) return;
      this.#gpu.focus.set(destination.x, destination.z);
      this.#gpu.cullFocus.set(destination.x, destination.z);
      // Effective density = authored ceiling × governor foliage scale (1.0, or
      // 0.7 at L4) — the governor axis only ever trims, like wildlands.
      this.#gpu.density.value = GARDEN_GRASS_DENSITY * governorEffects().foliageScale;
      this.#gpu.patchiness.value = GARDEN_GRASS_PATCHINESS;
      for (const material of this.#materials) material.focus.set(destination.x, destination.z);
      // Reset + all four compactors share one command encoder; rendering can only
      // ever observe the complete old field or the complete new field.
      await this.#renderer.computeAsync([this.#gpu.reset, ...this.#gpu.layers.map((layer) => layer.compute)]);
      if (this.#disposed || id !== this.#generation) return;
      // Re-cull immediately so this frame draws a visibility set that matches the
      // freshly compacted instance buffers.
      this.#renderer.compute(this.#gpu.cullPasses);
    })().catch((error) => {
      if (!this.#disposed) console.warn("[sfbg-grass] placement generation failed", error);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation++;
    this.#unsubscribeGovernor();
    this.#field.dispose();
    this.#gpu.dispose();
    for (const material of this.#materials) material.material.dispose();
    this.removeFromParent();
    this.clear();
  }
}

export function buildBotanicalGrass(map: GardenTerrain, trees: GardenTree[]): BotanicalGrassController {
  return new BotanicalGrassController(map, trees);
}
