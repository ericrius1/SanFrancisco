# Runtime terrain authority

The shipped world terrain is the WebGPU `TerrainClipmap`, built at boot from the
canonical `heightmap.bin` and `surface.bin`. Production boot does not request the
legacy Blender-exported `terrain_*.glb` chunks; `test:terrain-runtime` enforces
that zero-request contract.

Blender may preprocess the canonical source heightfield when rebuilding city
data, but it does not own the runtime terrain material. Keep these responsibilities
in the runtime pipeline:

- geometry displacement and LOD morphing;
- the filterable world-normal pyramid derived from the canonical heightfield;
- feathered surface-class weights;
- slope/altitude material blending and procedural macro/micro variation;
- received clipmap/world-field shadows.

Normal and surface mip data are generated deterministically from already-loaded
terrain data, so they add no optional network request and cannot drift from the
heightfield. Change `terrainMaterialData.ts` and its `test:terrain-clipmap`
contracts when adjusting those filters. Do not bake a second normal or material
classification into a `.blend` unless the runtime terrain authority itself is
being replaced.
