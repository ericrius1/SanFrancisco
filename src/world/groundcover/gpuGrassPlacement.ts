// WebGPU grass placement/compaction. One compute dispatch per additive layer
// reconstructs the canonical world grid, samples the player-following foliage
// field, rejects excluded/slope/density candidates, and atomically compacts the
// survivors into render attributes. A shared indirect buffer turns the four
// outputs into four exact-count draws without any CPU placement or readback in
// the render path.

import * as THREE from "three/webgpu";
import {
  atomicAdd,
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
  vec4
} from "three/tsl";
import {
  FOLIAGE_FIELD_SIZE,
  FOLIAGE_FIELD_SPACING,
  type FoliageField
} from "./foliageField";
import type { GrassMaterialState, GrassMesh } from "./bladeGrass";

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

export type GpuGrassLayerSpec = Readonly<{
  name: string;
  gridStride: number;
  visibleRadius: number;
  fadeBand: number;
}>;

export type GpuGrassLayer = Readonly<{
  spec: GpuGrassLayerSpec;
  mesh: GrassMesh;
  capacity: number;
  candidateSide: number;
  trianglesPerCluster: number;
  compute: N;
}>;

export type GpuGrassPlacement = Readonly<{
  layers: readonly GpuGrassLayer[];
  indirect: THREE.IndirectStorageBufferAttribute;
  reset: N;
  focus: THREE.Vector2;
  density: { value: number };
  patchiness: { value: number };
  dispose(): void;
}>;

export type GpuGrassLayerInput = Readonly<{
  spec: GpuGrassLayerSpec;
  geometry: THREE.BufferGeometry;
  material: GrassMaterialState;
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

  const transform = new THREE.StorageInstancedBufferAttribute(capacity, 4);
  const shape = new THREE.StorageInstancedBufferAttribute(capacity, 4);
  const color = new THREE.StorageInstancedBufferAttribute(capacity, 4);
  geometry.setAttribute("aGrassTransform", transform);
  geometry.setAttribute("aGrassShape", shape);
  geometry.setAttribute("aGrassColor", color);
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

  const reset = Fn(() => {
    atomicStore(indirectStorage.element(instanceIndex.mul(uint(5)).add(uint(1))), uint(0));
  })().compute(inputs.length, [64]).setName("grass indirect reset");

  const layers = inputs.map((input, layerIndex): GpuGrassLayer => {
    const step = spacing * input.spec.gridStride;
    const reach = Math.ceil(input.spec.visibleRadius / step) + 1;
    const candidateSide = reach * 2 + 1;
    const planeCandidates = candidateSide * candidateSide;
    const capacity = planeCandidates * maxDensityLayers;
    const mesh = cloneGrassGeometry(
      input.geometry,
      capacity,
      input.material.material,
      `wildlands_grass_${input.spec.name}_gpu`,
      indirect,
      layerIndex * 5 * Uint32Array.BYTES_PER_ELEMENT
    );
    mesh.userData.grassLayer = input.spec.name;

    const transformAttr = mesh.geometry.getAttribute("aGrassTransform") as THREE.StorageInstancedBufferAttribute;
    const shapeAttr = mesh.geometry.getAttribute("aGrassShape") as THREE.StorageInstancedBufferAttribute;
    const colorAttr = mesh.geometry.getAttribute("aGrassColor") as THREE.StorageInstancedBufferAttribute;
    const transforms = storage(transformAttr, "vec4", capacity);
    const shapes = storage(shapeAttr, "vec4", capacity);
    const colors = storage(colorAttr, "vec4", capacity);
    const instanceCounter = indirectStorage.element(uint(layerIndex * 5 + 1));

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
        const outputIndex = atomicAdd(instanceCounter, uint(1));
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

    return {
      spec: input.spec,
      mesh,
      capacity,
      candidateSide,
      trianglesPerCluster: input.trianglesPerCluster,
      compute
    };
  });

  return {
    layers,
    indirect,
    reset,
    focus,
    density: densityU,
    patchiness: patchinessU,
    dispose() {
      reset.dispose();
      for (const layer of layers) {
        layer.compute.dispose();
        layer.mesh.geometry.setIndirect(null);
        layer.mesh.geometry.dispose();
        layer.mesh.removeFromParent();
      }
    }
  };
}
