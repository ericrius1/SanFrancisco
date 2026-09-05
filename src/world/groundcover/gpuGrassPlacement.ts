// WebGPU grass placement/compaction + per-frame GPU frustum culling. One
// compute dispatch per additive layer reconstructs the canonical world grid,
// samples the player-following foliage field, rejects excluded/slope/density
// candidates, and atomically compacts the survivors into persistent storage
// buffers ("live" instances, recounted only when the focus moves).
//
// Every frame a second, much cheaper pass frustum-tests each live instance
// against the render camera and appends survivors into a compact
// visible-index buffer while bumping the layer's indirect draw instanceCount
// (the false-earth architecture: cull → atomicAdd → index indirection). The
// vertex shader resolves instances through that indirection, so blades behind
// the camera never reach vertex shading, with zero CPU readback in the loop.
//
// This module is now a thin grass-specific layer over the shared GPU indirect
// runtime (../../render/gpuIndirect): the instance arenas, indirect draw meshes,
// visible-index buffers, cull-camera uniforms, clip-space frustum test and
// disposal are generic and shared with other instanced systems. What stays here
// is grass's own placement/compaction ("false-earth") stage, its density layers,
// the per-consumer styling hook, and the rank-fade acceptance that keeps the cull
// in lockstep with the blade material's edge dissolve.

import * as THREE from "three/webgpu";
import {
  atomicAdd,
  atomicLoad,
  atomicStore,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  mix,
  select,
  storage,
  textureLoad,
  uint,
  uniform,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { laptopProfile } from "../../render/laptopProfiles";
import { type FoliageField } from "./foliageField";
import { rankAnnulusAccept } from "./rankDissolve";
import { releaseRendererAttribute } from "../../app/rendererRegistry";
import {
  buildCullPass,
  createCullCamera,
  createIndirectDrawSet,
  createInstanceArena,
  createVisibleBuffer,
  type IndirectDrawEntry,
  type InstanceArena,
  type VisibleBuffer
} from "../../render/gpuIndirect";
import type { GrassIndirectSource, GrassMaterialState, GrassMesh } from "./bladeGrass";

type N = any;

const WORLD_CELL_OFFSET = 1 << 20;
const HASH_TO_UNIT = 1 / 0x1_0000_0000;
const R2_A1 = 0.7548776662466927;
const R2_A2 = 0.5698402909980532;
const GROUND_FOOT = 0.6;
const GROUND_SLOPE_CULL = 1.15;
const GROUND_SINK = 0.05;
// Wind bend + trample push + grounding sink around the scaled cluster bound.
const CULL_RADIUS_SLACK = 1.25;

export type GpuGrassLayerSpec = Readonly<{
  name: string;
  gridStride: number;
  /** Authored outer radius. Sizes the candidate grid and bounds `radiusNode`. */
  visibleRadius: number;
  fadeBand: number;
  /** Inner hole radius. Layers that share a gridStride (and therefore scatter at
   *  BIT-IDENTICAL anchors — same cell, same R2 offset, same yaw/height/rank) are
   *  otherwise additive clones: every cluster inside the inner layer's disc is
   *  drawn twice with two geometries. Set this on the OUTER member of such a pair
   *  and it becomes a real LOD ladder — the inner layer owns the hero ring, this
   *  one grows in across `innerBand` by the same per-instance rank the outer
   *  dissolve already uses, so the handoff is a stochastic crossfade, not a ring.
   *  Use `rankHandoffRadius(innerRadius, innerFadeBand)` (rankDissolve.ts) so this
   *  layer is at full size before the inner layer starts shrinking. */
  minRadius?: number;
  /** Width of the inner grow-in band. Match the inner layer's `fadeBand` so the
   *  two ramps are exact complements. Defaults to this layer's `fadeBand`. */
  innerBand?: number;
  /** Candidate planes per cell. Defaults to the placement-wide maximum; a layer
   *  whose consumer expresses density through its own keep shape (wildflowers)
   *  wants exactly one. */
  densityLayers?: number;
  /** Decorrelates this layer's scatter from every other layer on the same
   *  `gridStride`. Layers sharing a stride reconstruct the SAME canonical cells,
   *  and every placement hash is keyed on those cells alone — so without a salt
   *  they land on bit-identical anchors and stack instead of filling the gaps
   *  between each other. Additive layers (a near/mid/hero grass ladder that is
   *  meant to accumulate coverage) want distinct odd salts here; a real LOD
   *  ladder that hands off through `minRadius` wants them to MATCH, so the same
   *  cluster is drawn by exactly one rung. Default 0 keeps the historical
   *  scatter. */
  placementSalt?: number;
  /** `average` seats a cluster on its footprint mean (blades hug the surface);
   *  `lowest` seats it on the footprint minimum, so a wildflower's wide skirt of
   *  petals never floats off a rise. */
  groundFit?: "average" | "lowest";
  /** Half-span of the four ground taps. Defaults to the blade footprint. */
  groundFoot?: number;
  /** Extra sink applied after grounding. */
  groundSink?: number;
  /** Reject a candidate whose footprint rises more than this across the taps. */
  slopeCull?: number;
}>;

export type GpuGrassLayer = Readonly<{
  spec: GpuGrassLayerSpec;
  mesh: GrassMesh;
  material: GrassMaterialState;
  capacity: number;
  candidateSide: number;
  trianglesPerCluster: number;
  compute: N;
  cull: N;
  cullDispatch: THREE.IndirectStorageBufferAttribute;
}>;

export type GpuGrassPlacement = Readonly<{
  layers: readonly GpuGrassLayer[];
  indirect: THREE.IndirectStorageBufferAttribute;
  /** Compacted live-instance counts per layer (placement-time, readback-safe). */
  liveCounts: THREE.StorageBufferAttribute;
  /** Placement-time pass: zero the live compaction counters. */
  reset: N;
  /** After placement: publish live-count-sized workgroups for each cull. */
  finalize: N[];
  /** Per-frame passes: zero draw counts, then frustum-cull every live layer. */
  cullPasses: N[];
  /** Point the per-frame culls at the render camera (call before dispatch). */
  updateCullCamera(camera: THREE.Camera): void;
  focus: THREE.Vector2;
  /** Live field focus for the per-instance rank fade; set before each cull. */
  cullFocus: THREE.Vector2;
  density: { value: number };
  patchiness: { value: number };
  dispose(): void;
}>;

/** Everything a per-consumer styling hook needs to turn one accepted candidate
 *  into a blade's shape/colour. All fields are TSL nodes evaluated inside the
 *  placement compute pass; `hash01(gx, gz, salt)` and `saltF` (the density-layer
 *  dither) reproduce the canonical per-candidate randomness. */
export type GpuGrassStyleContext = Readonly<{
  /** Canonical world grid cell for this candidate (int nodes). */
  gx: N;
  gz: N;
  /** Density-layer salt as uint / float — fold into hashes to decorrelate layers. */
  salt: N;
  saltF: N;
  /** Per-candidate hash seed: mixes `base` with this candidate's density layer
   *  and the layer's `placementSalt`. Prefer this over folding `saltF` into a
   *  hash as an epsilon — a fractional dither of ~1e-5 leaves two density layers
   *  on the same anchor, which is a stack rather than a scatter. Identity
   *  (`seed(b) === b`) on density layer 0 with no placement salt. */
  seed: (base: number) => N;
  /** World XZ (vec2) and fitted ground Y (float) of the candidate. */
  world: N;
  groundY: N;
  /** Bilinearly-sampled field texel: R height · G density · B style · A vigour. */
  eco: N;
  /** Nearest (unfiltered) field texel — species/style ids must not interpolate. */
  ecoNearest: N;
  /** Renormalized vigour patch (0..1) and clamped style channel (0..1). */
  patch: N;
  style: N;
  /** Placement density and patchiness uniform nodes. */
  density: N;
  patchiness: N;
  /** Canonical integer hash → [0,1). Accepts a `seed(...)` node as the salt. */
  hash01: (gx: N, gz: N, salt: number | N) => N;
  /** Distance from the placement focus (metres). */
  distance: N;
  /** The layer this candidate belongs to. */
  spec: GpuGrassLayerSpec;
}>;

/** Per-blade visual output of a styling hook. Fade `rank` stays owned by the
 *  placement pass (it must match the cull threshold), so hooks never emit it. */
export type GpuGrassStyle = Readonly<{
  height: N;
  spread: N;
  yaw: N;
  wind: N;
  /** Linear RGB tint (vec3). */
  color: N;
}>;

export type GpuGrassStyleHook = (ctx: GpuGrassStyleContext) => GpuGrassStyle;

export type GpuGrassLayerInput = Readonly<{
  spec: GpuGrassLayerSpec;
  geometry: THREE.BufferGeometry;
  /** Build the layer material against the culled storage-read indirection. */
  materialFor(source: GrassIndirectSource): GrassMaterialState;
  trianglesPerCluster: number;
  /** Optional per-consumer styling. Omit for the shared wildlands meadow look. */
  style?: GpuGrassStyleHook;
  /** Replace the built-in density/patchiness keep roll. Return a bool node: the
   *  wildflower ring rolls its own baked clump/drift keep and species match here,
   *  while the field's plantability, slope and radius gates still apply. */
  select?: (ctx: GpuGrassStyleContext) => N;
  /** Field this layer samples. Defaults to the placement's field — the wildflower
   *  horizon tier reads a coarser, much wider square than its own near tiers. */
  field?: FoliageField;
  /** Live outer radius (uniform node), clamped by the spec's authored radius.
   *  Omit for a fixed ladder rung. */
  radiusNode?: N;
  /** Fraction of the candidate grid this layer reserves instance slots for. A
   *  layer that keeps only one species (or a deliberately sparse horizon band)
   *  never approaches 1; reserving its true expectation plus headroom is what
   *  keeps a four-species ladder inside the old single-tier memory envelope. */
  capacityFraction?: number;
}>;

const uintHash = (gx: N, gz: N, salt: number | N): N => {
  const ux = uint(gx.add(int(WORLD_CELL_OFFSET)));
  const uz = uint(gz.add(int(WORLD_CELL_OFFSET)));
  const h = ux.mul(uint(374761393))
    .add(uz.mul(uint(668265263)))
    .add(uint(salt).mul(uint(2246822519)))
    .toVar();
  h.assign(h.bitXor(h.shiftRight(uint(15))).mul(uint(2246822519)));
  h.assign(h.bitXor(h.shiftRight(uint(13))).mul(uint(3266489917)));
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  return h;
};

const hash01 = (gx: N, gz: N, salt: number | N): N =>
  float(uintHash(gx, gz, salt)).mul(HASH_TO_UNIT);

// Must be an exact multiple of the field's toroidal width: unlike a hash offset,
// this may not rotate the world-to-texture mapping.
const fieldCellOffset = (field: FoliageField): number => field.size * 4096;

const wrapFieldCell = (field: FoliageField, value: N): N =>
  value.add(int(fieldCellOffset(field))).mod(int(field.size));

const fieldTexel = (field: FoliageField, cellX: N, cellZ: N): N =>
  textureLoad(
    field.texture as unknown as N,
    ivec2(wrapFieldCell(field, cellX), wrapFieldCell(field, cellZ))
  ) as N;

/** Manual bilinear read keeps RGBA32F legal without an optional filterable-f32 feature. */
const sampleField = (field: FoliageField, world: N): N => {
  const cell = (world.div(float(field.spacing)) as N);
  const base = floor(cell) as N;
  const blend = cell.sub(base) as N;
  const ix = int(base.x);
  const iz = int(base.y);
  const a = mix(fieldTexel(field, ix, iz), fieldTexel(field, ix.add(1), iz), blend.x);
  const b = mix(fieldTexel(field, ix, iz.add(1)), fieldTexel(field, ix.add(1), iz.add(1)), blend.x);
  return mix(a, b, blend.y);
};

const nearestField = (field: FoliageField, world: N): N => {
  const cell = floor(world.div(float(field.spacing)).add(0.5)) as N;
  return fieldTexel(field, int(cell.x), int(cell.y));
};

// The shared wildlands meadow styling — extracted verbatim so it is the default
// hook when a consumer passes no `style`. Output is bit-identical to the former
// inline block; consumers (e.g. the botanical garden) supply their own hook.
const defaultGrassStyle: GpuGrassStyleHook = ({ gx, gz, eco, patch, style, patchiness, hash01, seed }) => {
  const vigour = mix(float(1), eco.w, patchiness.clamp(0, 1));
  const tallChance = float(0.23).mul(float(0.78).add(patch.mul(0.48)));
  const tall = hash01(gx, gz, seed(31)).lessThan(tallChance);
  const tallHeight = float(0.9).add(hash01(gx, gz, seed(37)).mul(0.7));
  const shortHeight = float(0.45).add(hash01(gx, gz, seed(41)).mul(0.4));
  const height = select(tall, tallHeight, shortHeight)
    .mul(vigour)
    .mul(float(0.94).add(style.mul(0.12)));
  const spread = select(tall, float(1.04), float(0.86))
    .mul(float(0.86).add(hash01(gx, gz, seed(43)).mul(0.32)))
    .mul(float(0.94).add(vigour.mul(0.06)));
  const brightness = float(0.86).add(hash01(gx, gz, seed(29)).mul(0.24));
  const dry = float(1).sub(patch).mul(float(0.12).add(patchiness.mul(0.1)))
    .add(style.sub(0.5).mul(0.035)).clamp(0, 1);
  const yaw = hash01(gx, gz, seed(47)).mul(Math.PI * 2);
  const wind = float(0.72).add(height.mul(0.34)).mul(select(tall, float(1.08), float(1)));
  // Red and blue were crushed hard enough (0.60 / 0.40) that the blade field
  // rendered as a far more saturated green than the ground it stands on, so the
  // edge of the blade ring showed up as a colour step against the terrain and
  // every gap between blades read as bare dirt. Measured against the rendered
  // terrain (tools/foliage-look-shot.mjs reports the band ratio), the field was
  // 18% short in red and 38% short in blue; these lift it onto the ground's
  // colour while keeping grass unmistakably green. The physical reading is
  // skylight — real grass is not a pure-green emitter.
  const color = vec3(
    brightness.mul(float(0.70).add(dry.mul(0.26))),
    brightness.mul(float(0.96).sub(dry.mul(0.14))),
    brightness.mul(float(0.66).sub(dry.mul(0.08)))
  );
  return { height, spread, yaw, wind, color };
};

// Per-layer state assembled in the first pass, consumed once the shared indirect
// draw set (which needs every material up front) exists.
type LayerBuild = {
  input: GpuGrassLayerInput;
  arena: InstanceArena;
  visible: VisibleBuffer;
  material: GrassMaterialState;
  capacity: number;
  candidates: number;
  candidateSide: number;
  reach: number;
  step: number;
  planeCandidates: number;
  densityLayers: number;
  localRadius: number;
  styleHook: GpuGrassStyleHook;
  field: FoliageField;
  name: string;
};

// The three vec4 instance planes every grass layer writes: anchorXYZ+yaw,
// spread/height/wind/fadeRadius, and normalized RGB tint + fade rank.
const GRASS_ARENA_ATTRS = [
  { name: "transforms", format: "vec4" },
  { name: "shapes", format: "vec4" },
  { name: "colors", format: "vec4" }
] as const;

export function createGpuGrassPlacement(
  field: FoliageField,
  inputs: readonly GpuGrassLayerInput[],
  spacing: number,
  maxDensityLayers: number,
  namePrefix = "wildlands"
): GpuGrassPlacement {
  const focus = new THREE.Vector2();
  const focusU = uniform(focus);
  const densityU = uniform(1);
  const distantCoverageU = uniform(laptopProfile().distantCoverage);
  const patchinessU = uniform(0.5);
  const densityNode = densityU as N;
  const patchinessNode = patchinessU as N;

  // Live compaction counters are separate from the draw counts: placement
  // rewrites them only when the field retargets, while the frustum pass
  // rewrites draw counts every frame.
  const liveCounts = new THREE.StorageBufferAttribute(new Uint32Array(inputs.length), 1);
  const liveStorage = storage(liveCounts, "uint", inputs.length).toAtomic();

  const reset = Fn(() => {
    atomicStore(liveStorage.element(instanceIndex), uint(0));
  })().compute(inputs.length, [64]).setName(`${namePrefix} live reset`);

  // Live field focus for the per-instance rank fade. Kept separate from the
  // placement `focus` (which only retargets every stream step): the material's
  // fade tracks the player every frame, so the cull must read the SAME live
  // focus to stay in lockstep with the material's shrink.
  const cullFocus = new THREE.Vector2();
  const cullFocusU = uniform(cullFocus);
  const cullCamera = createCullCamera();

  // Pass 1: build each layer's arena, visible buffer and material. The material
  // reads the arena/visible buffers through the culled indirection, and the
  // shared indirect draw set (pass 2) needs every material to make its mesh.
  const builds: LayerBuild[] = inputs.map((input): LayerBuild => {
    const step = spacing * input.spec.gridStride;
    const reach = Math.ceil(input.spec.visibleRadius / step) + 1;
    const candidateSide = reach * 2 + 1;
    const planeCandidates = candidateSide * candidateSide;
    const densityLayers = Math.max(1, Math.floor(input.spec.densityLayers ?? maxDensityLayers));
    const candidates = planeCandidates * densityLayers;
    // A layer that keeps only a slice of its candidates (one wildflower species,
    // a sparse horizon band) reserves that slice plus headroom, not the grid.
    const capacity = Math.max(
      64,
      Math.ceil(candidates * Math.min(1, Math.max(0.02, input.capacityFraction ?? 1)))
    );
    const styleHook = input.style ?? defaultGrassStyle;
    // The cull scales this per instance by its spread/height; a missing bound
    // would silently fall back to a fixed guess and over-admit tiny accents.
    if (!input.geometry.boundingSphere) input.geometry.computeBoundingSphere();

    const arena = createInstanceArena(GRASS_ARENA_ATTRS, capacity);
    const visible = createVisibleBuffer(capacity);
    const material = input.materialFor({
      transforms: arena.read("transforms"),
      shapes: arena.read("shapes"),
      colors: arena.read("colors"),
      visibleIndices: visible.read
    });
    return {
      input,
      arena,
      visible,
      material,
      capacity,
      candidates,
      candidateSide,
      reach,
      step,
      planeCandidates,
      densityLayers,
      // Conservative local-space bound for one cluster of this layer, scaled per
      // instance by its spread/height at cull time.
      localRadius: input.geometry.boundingSphere?.radius ?? 1.4,
      styleHook,
      field: input.field ?? field,
      name: `${namePrefix}_${input.spec.name}_gpu`
    };
  });

  const entries: IndirectDrawEntry[] = builds.map((build) => ({
    geometry: build.input.geometry,
    material: build.material.material,
    capacity: build.capacity,
    visible: build.visible,
    name: build.name
  }));
  const drawSet = createIndirectDrawSet(entries, namePrefix);

  // Pass 2: build each layer's placement/compaction compute and per-frame cull.
  const layers = builds.map((build, layerIndex): GpuGrassLayer => {
    const { input, arena, capacity, candidates, candidateSide, reach, step, planeCandidates, localRadius, styleHook } = build;
    const layerField = build.field;
    // Live outer radius. `shapes.w` carries it per instance, so the material's
    // dissolve and the cull's acceptance both follow a tunable reach with no
    // pipeline rebuild; the authored radius stays the hard bound on the grid.
    const radiusNode: N = input.radiusNode
      ? (input.radiusNode as N).clamp(0, input.spec.visibleRadius)
      : float(input.spec.visibleRadius);
    const record = drawSet.records[layerIndex];
    const mesh = record.mesh as GrassMesh;
    mesh.userData.grassCapacity = capacity;
    mesh.userData.grassGpuGenerated = true;
    mesh.userData.grassIndirectOffset = layerIndex * 5 * Uint32Array.BYTES_PER_ELEMENT;
    mesh.userData.grassLayer = input.spec.name;
    // QA surface: probes read packed instance/visibility planes directly.
    mesh.userData.grassTransformAttr = arena.attribute("transforms");
    mesh.userData.grassVisibleAttr = build.visible.attribute;
    mesh.userData.grassColorAttr = arena.attribute("colors");
    mesh.userData.grassShapeAttr = arena.attribute("shapes");

    const transforms = arena.write("transforms");
    const shapes = arena.write("shapes");
    const colors = arena.write("colors");
    const liveCounter = liveStorage.element(uint(layerIndex));

    const compute = Fn(() => {
      const densityLayer = instanceIndex.div(uint(planeCandidates));
      const planar = instanceIndex.mod(uint(planeCandidates));
      const localX = int(planar.mod(uint(candidateSide))).sub(int(reach));
      const localZ = int(planar.div(uint(candidateSide))).sub(int(reach));
      const centerGx = int(floor(focusU.x.div(float(step))));
      const centerGz = int(floor(focusU.y.div(float(step))));
      const gx = centerGx.add(localX);
      const gz = centerGz.add(localZ);
      const salt = densityLayer.mul(uint(101));
      // The decorrelating hash seed. Every placement hash is keyed on the
      // canonical cell alone, so the density layers used to differ by nothing
      // but a ~1e-5 additive dither on the R2 offset — i.e. every extra layer
      // stacked a second cluster on the SAME anchor (measured: 3 instances per
      // distinct anchor) instead of filling the half-metre gap beside it. Same
      // story across layers sharing a gridStride. Folding the salt into the
      // integer seed makes each (layer, density layer) an independent point set.
      // Deliberately identity for density layer 0 with no placement salt, so the
      // wildflower ladder's single-layer rungs keep their exact prior scatter.
      const saltSeed = densityLayer.mul(uint(0x9e3779b1))
        .add(uint((input.spec.placementSalt ?? 0) >>> 0))
        .toVar();
      const seed = (base: number): N => uint(base).add(saltSeed);

      // R2 low-discrepancy offsets with a world-hash dither. The output remains
      // inside its canonical cell, so motion changes candidates without making
      // existing blades swim.
      const h0 = hash01(gx, gz, seed(11));
      const h1 = hash01(gx, gz, seed(988));
      const ox = float(gx).mul(R2_A1).add(float(gz).mul(R2_A2)).add(h0.mul(0.5)).fract();
      const oz = float(gx).mul(R2_A2).add(float(gz).mul(R2_A1)).add(h1.mul(0.5)).fract();
      const world = vec2(
        float(gx).mul(step).add(ox.sub(0.5).mul(step * 0.86)),
        float(gz).mul(step).add(oz.sub(0.5).mul(step * 0.86))
      );

      const ecoNearest = nearestField(layerField, world);
      const eco = sampleField(layerField, world);
      const patch = eco.w.sub(0.82).div(0.36).clamp(0, 1);
      const style = eco.z.clamp(0, 1);
      const authoredDensity = ecoNearest.y.clamp(0, 1);
      const distance = world.sub(focusU).length().toVar();
      const groundFoot = Math.max(0.05, Number(input.spec.groundFoot ?? GROUND_FOOT));
      const left = sampleField(layerField, world.add(vec2(-groundFoot, 0))).x;
      const right = sampleField(layerField, world.add(vec2(groundFoot, 0))).x;
      const back = sampleField(layerField, world.add(vec2(0, -groundFoot))).x;
      const front = sampleField(layerField, world.add(vec2(0, groundFoot))).x;
      const minHeight = left.min(right).min(back).min(front);
      const maxHeight = left.max(right).max(back).max(front);
      // Blades hug the mean; a wildflower's wide petal skirt seats on the
      // footprint minimum so it can never hover off the crown of a rise.
      const groundY = (input.spec.groundFit === "lowest"
        ? minHeight
        : left.add(right).add(back).add(front).mul(0.25)
      ).sub(Number(input.spec.groundSink ?? GROUND_SINK));
      // The candidate grid is a square; only its inscribed disc is this layer's.
      const withinRadius = distance.lessThan(radiusNode);
      const context: GpuGrassStyleContext = {
        gx,
        gz,
        salt,
        saltF: float(salt),
        world,
        groundY,
        eco,
        ecoNearest,
        patch,
        style,
        density: densityNode,
        patchiness: patchinessNode,
        hash01,
        seed,
        distance,
        spec: input.spec
      };

      const rolled = input.select
        ? input.select(context)
        : (() => {
          // Density is continuous authored data, not just a plantable bit. Any
          // positive value participates in `fill`; a painted 0.3 should make a
          // sparse patch instead of falling off the former binary 0.5 cliff.
          const fill = densityNode.mul(authoredDensity).sub(float(densityLayer)).clamp(0, 1);
          const guaranteedBase = (densityLayer.equal(uint(0)) as N)
            .and(densityNode.mul(authoredDensity).greaterThanEqual(1));
          const patchShape = float(0.72).add(patch.mul(0.56));
          const keep = select(
            guaranteedBase,
            float(1),
            fill.mul(mix(float(1), patchShape, patchinessNode.clamp(0, 1))).clamp(0, 1)
          );
          return hash01(gx, gz, seed(23)).lessThanEqual(keep);
        })();
      const accepted = authoredDensity.greaterThan(0)
        .and(rolled)
        .and(maxHeight.sub(minHeight).lessThanEqual(Number(input.spec.slopeCull ?? GROUND_SLOPE_CULL)))
        .and(withinRadius);

      If(accepted, () => {
        const outputIndex = atomicAdd(liveCounter, uint(1));
        If(outputIndex.lessThan(uint(capacity)), () => {
          const styled = styleHook(context);
          // Fade rank stays here (not in the hook): the per-frame cull pass reads
          // the SAME expression as its extinction threshold, so styling can never
          // desynchronize the edge dissolve.
          const rank = hash01(gx, gz, seed(59)).mul(0.996).add(0.002);
          transforms.element(outputIndex).assign(vec4(world.x, groundY, world.y, styled.yaw));
          shapes.element(outputIndex).assign(vec4(styled.spread, styled.height, styled.wind, radiusNode));
          colors.element(outputIndex).assign(vec4(styled.color, rank));
        });
      });
    })().compute(candidates, [256]).setName(`scatter compact ${input.spec.name}`);

    // Per-instance rank fade — the extra acceptance the shared frustum cull can't
    // own: a cluster survives only while its distance fade to the field focus
    // still exceeds its stable rank. The material shrinks the near-band clusters
    // to nothing just before this rejection, so the edge dissolves without a pop.
    // A layer with `minRadius` also carries the mirrored INNER rejection, which
    // is what keeps co-located layers from drawing the same anchor twice.
    const cullDispatch = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
    const cull = buildCullPass({
      name: `scatter cull ${input.spec.name}`,
      dispatch: capacity,
      camera: cullCamera,
      activeCount: () => atomicLoad(liveCounter),
      instance: (idx: N) => {
        const t = (transforms.element(idx) as N).toVar();
        const s = (shapes.element(idx) as N).toVar();
        const rank = (colors.element(idx) as N).w;
        const dist = t.xz.sub(cullFocusU).length();
        // Inner acceptance is the outer test read backwards: rank r survives the
        // outer edge longest and the inner edge shortest, so the two bands of a
        // co-located pair partition the clusters instead of doubling them. The
        // material shrinks against this exact same window (rankDissolve.ts).
        let accept = rankAnnulusAccept(dist, rank, {
          visibleRadius: s.w,
          fadeBand: input.spec.fadeBand,
          minRadius: input.spec.minRadius,
          innerBand: input.spec.innerBand
        });
        // Keep the hero 60 m intact. Stable ranks thin overlapping distant
        // clusters gradually across a broad band, with no placement rebuild.
        const distanceGrade = dist.sub(60).div(140).clamp(0, 1);
        const coverage = mix(float(1), distantCoverageU, distanceGrade);
        accept = accept.and(rank.lessThanEqual(coverage));
        const radius = s.x.max(s.y).mul(float(localRadius)).add(CULL_RADIUS_SLACK);
        const center = vec3(t.x, t.y.add(s.y.mul(0.55)), t.z);
        return { center, radius, accept, emit: () => record.append(idx) };
      }
    });
    // Retain the capacity guard in the generated shader, but launch only the
    // compacted population. The GPU publishes this buffer after placement;
    // there is no per-frame readback, allocation, or extra dispatch.
    cull.dispatchSize = cullDispatch;

    return {
      spec: input.spec,
      mesh,
      material: build.material,
      capacity,
      candidateSide,
      trianglesPerCluster: input.trianglesPerCluster,
      compute,
      cull,
      cullDispatch
    };
  });

  const dispatchWrites = layers.map(layer => storage(layer.cullDispatch, "uint", 3));
  let dispatchReady = false;
  // WebGPU guarantees eight storage buffers per shader stage: one live-count
  // buffer plus at most seven dispatch buffers. Flower fields have 11 layers.
  const finalize: N[] = [];
  for (let first = 0; first < layers.length; first += 7) {
    const end = Math.min(first + 7, layers.length);
    finalize.push(Fn(() => {
      for (let index = first; index < end; index++) {
        const count = (atomicLoad(liveStorage.element(uint(index))) as N).min(uint(layers[index].capacity));
        dispatchWrites[index].element(uint(0)).assign(count.add(uint(255)).div(uint(256)));
        dispatchWrites[index].element(uint(1)).assign(uint(1));
        dispatchWrites[index].element(uint(2)).assign(uint(1));
      }
    })().compute(1).setName(`${namePrefix} publish cull dispatch ${first}`));
  }
  // Before placement initializes indirect buffers, only reset the draws.
  // Initialization, binding and submission of this final pass are synchronous.
  finalize[finalize.length - 1]?.onInit(() => { dispatchReady = true; });

  const cullPasses = [drawSet.drawReset, ...layers.map((layer) => layer.cull)];
  const emptyCullPasses = [drawSet.drawReset];

  return {
    layers,
    indirect: drawSet.indirect,
    liveCounts,
    reset,
    finalize,
    get cullPasses() { return dispatchReady ? cullPasses : emptyCullPasses; },
    updateCullCamera(camera: THREE.Camera) {
      cullCamera.update(camera);
      distantCoverageU.value = laptopProfile().distantCoverage;
    },
    focus,
    cullFocus,
    density: densityU,
    patchiness: patchinessU,
    dispose() {
      reset.dispose();
      for (const pass of finalize) pass.dispose();
      for (const layer of layers) {
        layer.compute.dispose();
        layer.cull.dispose();
        releaseRendererAttribute(layer.cullDispatch);
      }
      // Releases the shared indirect buffer, every layer geometry (setIndirect
      // null + dispose + detach) and the draw-reset compute.
      drawSet.dispose();
      for (const build of builds) {
        build.arena.dispose();
        build.visible.dispose();
      }
      releaseRendererAttribute(liveCounts);
    }
  };
}
