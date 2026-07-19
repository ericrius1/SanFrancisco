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

import * as THREE from "three/webgpu";
import {
  abs,
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
import {
  FOLIAGE_FIELD_SIZE,
  FOLIAGE_FIELD_SPACING,
  type FoliageField
} from "./foliageField";
import { releaseRendererAttribute } from "../../app/rendererRegistry";
import type { GrassIndirectSource, GrassMaterialState, GrassMesh } from "./bladeGrass";

type N = any;

const WORLD_CELL_OFFSET = 1 << 20;
// Must be an exact multiple of the toroidal width: unlike a hash offset, this
// may not rotate the world-to-texture mapping.
const FIELD_CELL_OFFSET = FOLIAGE_FIELD_SIZE * 4096;
const HASH_TO_UNIT = 1 / 0x1_0000_0000;
const R2_A1 = 0.7548776662466927;
const R2_A2 = 0.5698402909980532;
const GROUND_FOOT = 0.6;
const GROUND_SLOPE_CULL = 0.85;
const GROUND_SINK = 0.05;
// Wind bend + trample push + grounding sink around the scaled cluster bound.
const CULL_RADIUS_SLACK = 1.25;

export type GpuGrassLayerSpec = Readonly<{
  name: string;
  gridStride: number;
  visibleRadius: number;
  fadeBand: number;
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
}>;

export type GpuGrassPlacement = Readonly<{
  layers: readonly GpuGrassLayer[];
  indirect: THREE.IndirectStorageBufferAttribute;
  /** Compacted live-instance counts per layer (placement-time, readback-safe). */
  liveCounts: THREE.StorageBufferAttribute;
  /** Placement-time pass: zero the live compaction counters. */
  reset: N;
  /** Per-frame passes: zero draw counts, then frustum-cull every live layer. */
  cullPasses: N[];
  /** Point the per-frame culls at the render camera (call before dispatch). */
  updateCullCamera(camera: THREE.Camera): void;
  focus: THREE.Vector2;
  density: { value: number };
  patchiness: { value: number };
  dispose(): void;
}>;

export type GpuGrassLayerInput = Readonly<{
  spec: GpuGrassLayerSpec;
  geometry: THREE.BufferGeometry;
  /** Build the layer material against the culled storage-read indirection. */
  materialFor(source: GrassIndirectSource): GrassMaterialState;
  trianglesPerCluster: number;
}>;

const uintHash = (gx: N, gz: N, salt: number): N => {
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

const hash01 = (gx: N, gz: N, salt: number): N =>
  float(uintHash(gx, gz, salt)).mul(HASH_TO_UNIT);

const wrapFieldCell = (value: N): N =>
  value.add(int(FIELD_CELL_OFFSET)).mod(int(FOLIAGE_FIELD_SIZE));

const fieldTexel = (field: FoliageField, cellX: N, cellZ: N): N =>
  textureLoad(
    field.texture as unknown as N,
    ivec2(wrapFieldCell(cellX), wrapFieldCell(cellZ))
  ) as N;

/** Manual bilinear read keeps RGBA32F legal without an optional filterable-f32 feature. */
const sampleField = (field: FoliageField, world: N): N => {
  const cell = (world.div(float(FOLIAGE_FIELD_SPACING)) as N);
  const base = floor(cell) as N;
  const blend = cell.sub(base) as N;
  const ix = int(base.x);
  const iz = int(base.y);
  const a = mix(fieldTexel(field, ix, iz), fieldTexel(field, ix.add(1), iz), blend.x);
  const b = mix(fieldTexel(field, ix, iz.add(1)), fieldTexel(field, ix.add(1), iz.add(1)), blend.x);
  return mix(a, b, blend.y);
};

const nearestField = (field: FoliageField, world: N): N => {
  const cell = floor(world.div(float(FOLIAGE_FIELD_SPACING)).add(0.5)) as N;
  return fieldTexel(field, int(cell.x), int(cell.y));
};

function cloneGrassGeometry(
  source: THREE.BufferGeometry,
  capacity: number,
  material: THREE.Material,
  name: string,
  indirect: THREE.IndirectStorageBufferAttribute,
  indirectOffset: number
): GrassMesh {
  const geometry = new THREE.InstancedBufferGeometry();
  if (source.index) geometry.setIndex(source.index.clone());
  for (const [attributeName, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(attributeName, attribute.clone());
  }
  for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex);

  // Instance data lives in storage buffers read through the visible-index
  // indirection — deliberately NOT vertex attributes, so the culled draw only
  // fetches instances that survived and the pipeline stays under the
  // vertex-buffer slot budget.
  geometry.instanceCount = capacity;
  geometry.setIndirect(indirect, indirectOffset);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 24_000);

  const mesh = new THREE.Mesh(geometry, material) as GrassMesh;
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.userData.grassCapacity = capacity;
  mesh.userData.grassGpuGenerated = true;
  mesh.userData.grassIndirectOffset = indirectOffset;
  return mesh;
}

export function createGpuGrassPlacement(
  field: FoliageField,
  inputs: readonly GpuGrassLayerInput[],
  spacing: number,
  maxDensityLayers: number
): GpuGrassPlacement {
  const focus = new THREE.Vector2();
  const focusU = uniform(focus);
  const densityU = uniform(1);
  const patchinessU = uniform(0.5);
  const densityNode = densityU as N;
  const patchinessNode = patchinessU as N;
  const indirectData = new Uint32Array(inputs.length * 5);
  for (let index = 0; index < inputs.length; index++) {
    indirectData[index * 5] = inputs[index].geometry.index?.count ??
      inputs[index].geometry.getAttribute("position").count;
  }
  const indirect = new THREE.IndirectStorageBufferAttribute(indirectData, 1);
  const indirectStorage = storage(indirect, "uint", indirectData.length).toAtomic();

  // Live compaction counters are separate from the draw counts: placement
  // rewrites them only when the field retargets, while the frustum pass
  // rewrites draw counts every frame.
  const liveCounts = new THREE.StorageBufferAttribute(new Uint32Array(inputs.length), 1);
  const liveStorage = storage(liveCounts, "uint", inputs.length).toAtomic();

  const reset = Fn(() => {
    atomicStore(liveStorage.element(instanceIndex), uint(0));
  })().compute(inputs.length, [64]).setName("grass live reset");

  const drawReset = Fn(() => {
    atomicStore(indirectStorage.element(instanceIndex.mul(uint(5)).add(uint(1))), uint(0));
  })().compute(inputs.length, [64]).setName("grass draw reset");

  // Frustum-cull camera state, shared by every layer's per-frame pass.
  const cullViewProjection = uniform(new THREE.Matrix4());
  const cullProjScale = uniform(new THREE.Vector2(1, 1));

  const releasable: unknown[] = [indirect, liveCounts];

  const layers = inputs.map((input, layerIndex): GpuGrassLayer => {
    const step = spacing * input.spec.gridStride;
    const reach = Math.ceil(input.spec.visibleRadius / step) + 1;
    const candidateSide = reach * 2 + 1;
    const planeCandidates = candidateSide * candidateSide;
    const capacity = planeCandidates * maxDensityLayers;

    const transformAttr = new THREE.StorageInstancedBufferAttribute(capacity, 4);
    const shapeAttr = new THREE.StorageInstancedBufferAttribute(capacity, 4);
    const colorAttr = new THREE.StorageInstancedBufferAttribute(capacity, 4);
    const visibleAttr = new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1);
    releasable.push(transformAttr, shapeAttr, colorAttr, visibleAttr);
    const transforms = storage(transformAttr, "vec4", capacity);
    const shapes = storage(shapeAttr, "vec4", capacity);
    const colors = storage(colorAttr, "vec4", capacity);
    const visibleWrite = storage(visibleAttr, "uint", capacity);

    const material = input.materialFor({
      transforms: storage(transformAttr, "vec4", capacity).toReadOnly(),
      shapes: storage(shapeAttr, "vec4", capacity).toReadOnly(),
      colors: storage(colorAttr, "vec4", capacity).toReadOnly(),
      visibleIndices: storage(visibleAttr, "uint", capacity).toReadOnly()
    });
    const mesh = cloneGrassGeometry(
      input.geometry,
      capacity,
      material.material,
      `wildlands_grass_${input.spec.name}_gpu`,
      indirect,
      layerIndex * 5 * Uint32Array.BYTES_PER_ELEMENT
    );
    mesh.userData.grassLayer = input.spec.name;
    // QA surface: probes read packed instance/visibility planes directly.
    mesh.userData.grassTransformAttr = transformAttr;
    mesh.userData.grassVisibleAttr = visibleAttr;
    mesh.userData.grassColorAttr = colorAttr;
    mesh.userData.grassShapeAttr = shapeAttr;

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

      // R2 low-discrepancy offsets with a small world-hash dither. The output
      // remains inside its canonical cell, so motion changes candidates without
      // making existing blades swim.
      const h0 = hash01(gx, gz, 11).add(float(salt).mul(0.0000001192092896));
      const h1 = hash01(gx, gz, 988).add(float(salt).mul(0.0000001788139343));
      const ox = float(gx).mul(R2_A1).add(float(gz).mul(R2_A2)).add(h0.mul(0.5)).fract();
      const oz = float(gx).mul(R2_A2).add(float(gz).mul(R2_A1)).add(h1.mul(0.5)).fract();
      const world = vec2(
        float(gx).mul(step).add(ox.sub(0.5).mul(step * 0.86)),
        float(gz).mul(step).add(oz.sub(0.5).mul(step * 0.86))
      );

      const ecoNearest = nearestField(field, world);
      const eco = sampleField(field, world);
      const patch = eco.w.sub(0.82).div(0.36).clamp(0, 1);
      const style = eco.z.clamp(0, 1);
      const authoredDensity = ecoNearest.y.clamp(0, 1);
      const fill = densityNode.mul(authoredDensity).sub(float(densityLayer)).clamp(0, 1);
      const guaranteedBase = (densityLayer.equal(uint(0)) as N)
        .and(densityNode.mul(authoredDensity).greaterThanEqual(1));
      const patchShape = float(0.72).add(patch.mul(0.56));
      const keep = select(
        guaranteedBase,
        float(1),
        fill.mul(mix(float(1), patchShape, patchinessNode.clamp(0, 1))).clamp(0, 1)
      );

      const left = sampleField(field, world.add(vec2(-GROUND_FOOT, 0))).x;
      const right = sampleField(field, world.add(vec2(GROUND_FOOT, 0))).x;
      const back = sampleField(field, world.add(vec2(0, -GROUND_FOOT))).x;
      const front = sampleField(field, world.add(vec2(0, GROUND_FOOT))).x;
      const minHeight = left.min(right).min(back).min(front);
      const maxHeight = left.max(right).max(back).max(front);
      const groundY = left.add(right).add(back).add(front).mul(0.25).sub(GROUND_SINK);
      const withinRadius = world.sub(focusU).length().lessThan(input.spec.visibleRadius);
      // Density is continuous authored data, not just a plantable bit. Any
      // positive value participates in `fill`; a painted 0.3 should make a
      // sparse patch instead of falling off the former binary 0.5 cliff.
      const accepted = authoredDensity.greaterThan(0)
        .and(hash01(gx, gz, 23).add(float(salt).mul(0.0000002384185791)).fract().lessThanEqual(keep))
        .and(maxHeight.sub(minHeight).lessThanEqual(GROUND_SLOPE_CULL))
        .and(withinRadius);

      If(accepted, () => {
        const outputIndex = atomicAdd(liveCounter, uint(1));
        If(outputIndex.lessThan(uint(capacity)), () => {
          const vigour = mix(float(1), eco.w, patchinessNode.clamp(0, 1));
          const tallChance = float(0.23).mul(float(0.78).add(patch.mul(0.48)));
          const tall = hash01(gx, gz, 31).add(float(salt).mul(0.0000002980232239)).fract()
            .lessThan(tallChance);
          const tallHeight = float(0.9).add(
            hash01(gx, gz, 37).add(float(salt).mul(0.0000003576278687)).fract().mul(0.7)
          );
          const shortHeight = float(0.45).add(
            hash01(gx, gz, 41).add(float(salt).mul(0.0000004172325134)).fract().mul(0.4)
          );
          const height = select(tall, tallHeight, shortHeight)
            .mul(vigour)
            .mul(float(0.94).add(style.mul(0.12)));
          const spread = select(tall, float(1.04), float(0.86))
            .mul(float(0.86).add(
              hash01(gx, gz, 43).add(float(salt).mul(0.0000004768371582)).fract().mul(0.32)
            ))
            .mul(float(0.94).add(vigour.mul(0.06)));
          const brightness = float(0.86).add(
            hash01(gx, gz, 29).add(float(salt).mul(0.000000536441803)).fract().mul(0.24)
          );
          const dry = float(1).sub(patch).mul(float(0.12).add(patchinessNode.mul(0.1)))
            .add(style.sub(0.5).mul(0.035)).clamp(0, 1);
          const rank = hash01(gx, gz, 59).add(float(salt).mul(0.0000005960464478)).fract()
            .mul(0.996).add(0.002);
          const yaw = hash01(gx, gz, 47).add(float(salt).mul(0.0000006556510925)).fract()
            .mul(Math.PI * 2);
          const wind = float(0.72).add(height.mul(0.34)).mul(select(tall, float(1.08), float(1)));

          transforms.element(outputIndex).assign(vec4(world.x, groundY, world.y, yaw));
          shapes.element(outputIndex).assign(vec4(spread, height, wind, input.spec.visibleRadius));
          colors.element(outputIndex).assign(vec4(
            brightness.mul(float(0.6).add(dry.mul(0.28))),
            brightness.mul(float(0.92).sub(dry.mul(0.14))),
            brightness.mul(float(0.4).sub(dry.mul(0.06))),
            rank
          ));
        });
      });
    })().compute(capacity, [256]).setName(`grass compact ${input.spec.name}`);

    // Conservative local-space bound for one cluster of this layer, scaled per
    // instance by its spread/height at cull time.
    const localRadius = input.geometry.boundingSphere?.radius ?? 1.4;
    const drawCounter = indirectStorage.element(uint(layerIndex * 5 + 1));

    const cull = Fn(() => {
      If(instanceIndex.lessThan(atomicLoad(liveCounter)), () => {
        const t = (transforms.element(instanceIndex) as N).toVar();
        const s = (shapes.element(instanceIndex) as N).toVar();
        const radius = s.x.max(s.y).mul(float(localRadius)).add(CULL_RADIUS_SLACK);
        const center = vec3(t.x, t.y.add(s.y.mul(0.55)), t.z);
        const clip = (cullViewProjection as N).mul(vec4(center, float(1)));
        // Left/right/top/bottom planes with a projection-scaled world margin;
        // no near/far test — reversed-z safe, and the placement radius already
        // bounds distance.
        const inFront = clip.w.greaterThan(radius.negate());
        const xIn = abs(clip.x).lessThan(clip.w.add(radius.mul(cullProjScale.x)));
        const yIn = abs(clip.y).lessThan(clip.w.add(radius.mul(cullProjScale.y)));
        If(inFront.and(xIn).and(yIn), () => {
          const slot = atomicAdd(drawCounter, uint(1));
          visibleWrite.element(slot).assign(instanceIndex);
        });
      });
    })().compute(capacity, [256]).setName(`grass cull ${input.spec.name}`);

    return {
      spec: input.spec,
      mesh,
      material,
      capacity,
      candidateSide,
      trianglesPerCluster: input.trianglesPerCluster,
      compute,
      cull
    };
  });

  const cullPasses = [drawReset, ...layers.map((layer) => layer.cull)];

  return {
    layers,
    indirect,
    liveCounts,
    reset,
    cullPasses,
    updateCullCamera(camera: THREE.Camera) {
      camera.updateMatrixWorld();
      cullViewProjection.value.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      );
      cullProjScale.value.set(
        camera.projectionMatrix.elements[0],
        camera.projectionMatrix.elements[5]
      );
    },
    focus,
    density: densityU,
    patchiness: patchinessU,
    dispose() {
      reset.dispose();
      drawReset.dispose();
      for (const layer of layers) {
        layer.compute.dispose();
        layer.cull.dispose();
        layer.mesh.geometry.setIndirect(null);
        layer.mesh.geometry.dispose();
        layer.mesh.removeFromParent();
      }
      for (const attribute of releasable) releaseRendererAttribute(attribute);
    }
  };
}
