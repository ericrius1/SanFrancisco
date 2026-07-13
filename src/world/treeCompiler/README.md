# Native tree compiler core

`compileTree(recipe, seed)` is a pure TypeScript compiler. It does not import
Three.js, access the DOM, load textures, or depend on a runtime tree
generator. It can run on the main thread, in a worker, or in an offline asset
build.

## Output contract

- One deterministic centerline skeleton is grown first. All LODs prune stable
  subsets of that skeleton and stable subsets of the same foliage anchors.
- Branches are merged tapered tubes with rotation-minimizing frames and
  world-scale bark UVs.
- Leaves, crossed needle clusters, and petal rosettes are flattened into a
  merged foliage mesh. Each vertex carries the supporting anchor plus packed
  wind, height, palette, and root-to-tip channels.
- Each mesh uses one interleaved vertex buffer and one index buffer. Branches
  use a 12-float stride; foliage uses a 17-float stride. Vertex buffers are not
  WGSL storage structs, so 16-byte struct padding does not apply. A future
  storage-buffer form should repack into aligned `vec4` fields.
- Bounds, byte/triangle statistics, a skeleton fingerprint, and an analytic
  canopy shadow profile are emitted with the meshes.
- `treePrototypeTransferables()` returns the unique buffers for zero-copy
  worker handoff.

### Interleaved attributes

| Mesh | Floats | Channels |
| --- | ---: | --- |
| branch | 12 | `position.xyz`, `normal.xyz`, `uv.xy`, `wind(phase, bendWeight, height01, branchLevel01)` |
| foliage | 17 | `position.xyz`, `normal.xyz`, `uv.xy`, `anchor.xyz`, `wind(phase, stiffness, height01, tipWeight)`, `material(palette, ambientOpening)` |

Positions, normals, and foliage anchors are tree-local. A whole-tree instance
transform must be applied identically to `position` and `anchor`; wind can then
rotate or offset the local `position - anchor` vector before world placement.
Branch wind is rooted at tree-local ground and uses its height/bend channels.
The typed index array (`Uint16Array` or `Uint32Array`) determines index format.

## LOD continuity

Recipes list LODs from near to far. Validation requires branch retention,
foliage retention, maximum branch level, and tessellation to stay monotonic.
A farther LOD therefore cannot restore a branch or foliage anchor removed by a
nearer LOD. Required ancestors are retained whenever a child survives.

The compiler intentionally owns no runtime policy. Placement, prototype
sharing, culling, hysteresis, texture/material selection, and shadows remain
renderer concerns.
