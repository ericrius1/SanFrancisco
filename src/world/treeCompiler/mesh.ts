import {
  VEC3_UP,
  add,
  buildRotationMinimizingFrames,
  clamp,
  cross,
  length,
  normalize,
  rotateAroundAxis,
  scale,
  sub,
  type Vec3
} from "./math.ts";
import type { FoliageAnchor, SkeletonBranch } from "./skeleton.ts";
import {
  TreeCompileError,
  type CompiledTreeMesh,
  type TreeBounds,
  type TreeLodRecipe,
  type TreeRecipe,
  type VertexAttributeLayout
} from "./types.ts";

export const BRANCH_VERTEX_STRIDE_FLOATS = 12;
export const FOLIAGE_VERTEX_STRIDE_FLOATS = 17;

export const BRANCH_VERTEX_ATTRIBUTES = [
  { semantic: "position", offsetFloats: 0, components: 3 },
  { semantic: "normal", offsetFloats: 3, components: 3 },
  { semantic: "uv", offsetFloats: 6, components: 2 },
  // phase, bend weight, normalized height, branch level
  { semantic: "wind", offsetFloats: 8, components: 4 }
] as const satisfies readonly VertexAttributeLayout[];

export const FOLIAGE_VERTEX_ATTRIBUTES = [
  { semantic: "position", offsetFloats: 0, components: 3 },
  { semantic: "normal", offsetFloats: 3, components: 3 },
  { semantic: "uv", offsetFloats: 6, components: 2 },
  { semantic: "anchor", offsetFloats: 8, components: 3 },
  // phase, stiffness, normalized height, per-vertex bend weight
  { semantic: "wind", offsetFloats: 11, components: 4 },
  // palette variation, root-to-tip ambient opening
  { semantic: "material", offsetFloats: 15, components: 2 }
] as const satisfies readonly VertexAttributeLayout[];

type MutableBounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  count: number;
};

function createMutableBounds(): MutableBounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
    count: 0
  };
}

function includePoint(bounds: MutableBounds, point: Vec3): void {
  bounds.minX = Math.min(bounds.minX, point.x);
  bounds.minY = Math.min(bounds.minY, point.y);
  bounds.minZ = Math.min(bounds.minZ, point.z);
  bounds.maxX = Math.max(bounds.maxX, point.x);
  bounds.maxY = Math.max(bounds.maxY, point.y);
  bounds.maxZ = Math.max(bounds.maxZ, point.z);
  bounds.count++;
}

function finishBounds(bounds: MutableBounds): TreeBounds {
  if (bounds.count === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], sphereCenter: [0, 0, 0], sphereRadius: 0 };
  }
  const center: [number, number, number] = [
    (bounds.minX + bounds.maxX) * 0.5,
    (bounds.minY + bounds.maxY) * 0.5,
    (bounds.minZ + bounds.maxZ) * 0.5
  ];
  const dx = bounds.maxX - center[0];
  const dy = bounds.maxY - center[1];
  const dz = bounds.maxZ - center[2];
  return {
    min: [bounds.minX, bounds.minY, bounds.minZ],
    max: [bounds.maxX, bounds.maxY, bounds.maxZ],
    sphereCenter: center,
    sphereRadius: Math.sqrt(dx * dx + dy * dy + dz * dz)
  };
}

export function unionTreeBounds(a: TreeBounds, b: TreeBounds): TreeBounds {
  const bounds = createMutableBounds();
  includePoint(bounds, { x: a.min[0], y: a.min[1], z: a.min[2] });
  includePoint(bounds, { x: a.max[0], y: a.max[1], z: a.max[2] });
  includePoint(bounds, { x: b.min[0], y: b.min[1], z: b.min[2] });
  includePoint(bounds, { x: b.max[0], y: b.max[1], z: b.max[2] });
  return finishBounds(bounds);
}

function createIndexArray(vertexCount: number, indexCount: number): Uint16Array | Uint32Array {
  return vertexCount <= 65_535 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
}

function resampleBranch(branch: SkeletonBranch, stride: number): { points: Vec3[]; radii: number[] } {
  const indices: number[] = [];
  for (let index = 0; index < branch.points.length; index += stride) indices.push(index);
  const last = branch.points.length - 1;
  if (indices[indices.length - 1] !== last) indices.push(last);
  return {
    points: indices.map((index) => branch.points[index]),
    radii: indices.map((index) => branch.radii[index])
  };
}

export function selectLodBranches(
  branches: readonly SkeletonBranch[],
  lod: TreeLodRecipe,
  requiredBranchIds: ReadonlySet<number> = new Set<number>()
): { selected: SkeletonBranch[]; selectedIds: ReadonlySet<number> } {
  const threshold = 1 - lod.branchRetention;
  const selectedIds = new Set<number>([0]);

  for (const branch of branches) {
    if (
      !requiredBranchIds.has(branch.id) &&
      (branch.level > lod.maxBranchLevel || branch.keepScore < threshold)
    ) continue;
    let current: SkeletonBranch | undefined = branch;
    while (current) {
      selectedIds.add(current.id);
      current = current.parent >= 0 ? branches[current.parent] : undefined;
    }
  }

  const selected = branches.filter((branch) => selectedIds.has(branch.id));
  return { selected, selectedIds };
}

export type BuiltBranchMesh = {
  mesh: CompiledTreeMesh;
  selectedIds: ReadonlySet<number>;
  branchCount: number;
  vertexCount: number;
};

export function buildBranchMesh(
  recipe: TreeRecipe,
  branches: readonly SkeletonBranch[],
  lod: TreeLodRecipe,
  maxVertices: number,
  requiredBranchIds: ReadonlySet<number> = new Set<number>()
): BuiltBranchMesh {
  const nominalIds = selectLodBranches(branches, lod).selectedIds;
  const { selected, selectedIds } = selectLodBranches(branches, lod, requiredBranchIds);
  const plans = selected.map((branch) => {
    // A selected far crown may require a twig which the normal structural LOD
    // omitted. Emit those support-only paths as one triangular connector span:
    // visibly attached, but far cheaper than restoring the detailed tube.
    const compactSupport = lod.radialSegments <= 4 && !nominalIds.has(branch.id);
    return {
      branch,
      radialSegments: compactSupport ? 3 : lod.radialSegments,
      ...resampleBranch(branch, compactSupport ? branch.points.length : lod.axialStride)
    };
  });
  let vertexCount = 0;
  let indexCount = 0;
  for (const plan of plans) {
    vertexCount += plan.points.length * (plan.radialSegments + 1);
    indexCount += (plan.points.length - 1) * plan.radialSegments * 6;
  }
  if (vertexCount > maxVertices) {
    throw new TreeCompileError(
      `${lod.name} branch mesh needs ${vertexCount} vertices, over the ${maxVertices} LOD limit`
    );
  }

  const vertices = new Float32Array(vertexCount * BRANCH_VERTEX_STRIDE_FLOATS);
  const indices = createIndexArray(vertexCount, indexCount);
  const bounds = createMutableBounds();
  let vertexCursor = 0;
  let indexCursor = 0;

  for (const plan of plans) {
    const frames = buildRotationMinimizingFrames(plan.points);
    const baseVertex = vertexCursor;
    const branchLevel01 = recipe.branchLevels.length > 0 ? plan.branch.level / recipe.branchLevels.length : 0;
    let barkV = 0;

    for (let pointIndex = 0; pointIndex < plan.points.length; pointIndex++) {
      if (pointIndex > 0) barkV += length(sub(plan.points[pointIndex], plan.points[pointIndex - 1])) / recipe.trunk.barkRepeat;
      const point = plan.points[pointIndex];
      const radius = plan.radii[pointIndex];
      const frame = frames[pointIndex];
      const along = pointIndex / (plan.points.length - 1);
      const bendWeight = clamp(along * (0.12 + plan.branch.level * 0.24), 0, 1);
      const height01 = clamp(point.y / recipe.height, 0, 1);

      for (let side = 0; side <= plan.radialSegments; side++) {
        const around = (side / plan.radialSegments) * Math.PI * 2;
        const outward = normalize(
          add(scale(frame.normal, Math.cos(around)), scale(frame.binormal, Math.sin(around)))
        );
        const position = add(point, scale(outward, radius));
        const offset = vertexCursor * BRANCH_VERTEX_STRIDE_FLOATS;
        vertices[offset] = position.x;
        vertices[offset + 1] = position.y;
        vertices[offset + 2] = position.z;
        vertices[offset + 3] = outward.x;
        vertices[offset + 4] = outward.y;
        vertices[offset + 5] = outward.z;
        vertices[offset + 6] = side / plan.radialSegments;
        vertices[offset + 7] = barkV;
        vertices[offset + 8] = plan.branch.windPhase;
        vertices[offset + 9] = bendWeight;
        vertices[offset + 10] = height01;
        vertices[offset + 11] = branchLevel01;
        includePoint(bounds, position);
        vertexCursor++;
      }
    }

    const ringSize = plan.radialSegments + 1;
    for (let span = 0; span < plan.points.length - 1; span++) {
      const ring0 = baseVertex + span * ringSize;
      const ring1 = ring0 + ringSize;
      for (let side = 0; side < plan.radialSegments; side++) {
        // CCW when viewed from outside (matches outward vertex normals + FrontSide).
        indices[indexCursor++] = ring0 + side;
        indices[indexCursor++] = ring0 + side + 1;
        indices[indexCursor++] = ring1 + side + 1;
        indices[indexCursor++] = ring0 + side;
        indices[indexCursor++] = ring1 + side + 1;
        indices[indexCursor++] = ring1 + side;
      }
    }
  }

  return {
    mesh: {
      vertices,
      vertexStrideFloats: BRANCH_VERTEX_STRIDE_FLOATS,
      attributes: BRANCH_VERTEX_ATTRIBUTES,
      indices,
      bounds: finishBounds(bounds)
    },
    selectedIds,
    branchCount: selected.length,
    vertexCount
  };
}

type FoliageShape = {
  vertices: readonly (readonly [x: number, y: number, u: number, v: number])[];
  indices: readonly number[];
};

const LEAF_SHAPE: FoliageShape = {
  vertices: [
    [0, 0, 0.5, 0],
    [-0.32, 0.22, 0.18, 0.22],
    [0.32, 0.22, 0.82, 0.22],
    [-0.5, 0.55, 0, 0.55],
    [0.5, 0.55, 1, 0.55],
    [-0.28, 0.82, 0.22, 0.82],
    [0.28, 0.82, 0.78, 0.82],
    [0, 1, 0.5, 1]
  ],
  indices: [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6, 5, 7, 6]
};

const BLADE_SHAPE: FoliageShape = {
  vertices: [
    [0, 0, 0.5, 0],
    [-0.5, 0.14, 0, 0.14],
    [0.5, 0.14, 1, 0.14],
    [0, 1, 0.5, 1]
  ],
  indices: [0, 1, 2, 1, 3, 2]
};

function usesDimensionalBroadleaves(recipe: TreeRecipe, lod: TreeLodRecipe): boolean {
  const index = recipe.lods.findIndex((candidate) => candidate === lod || candidate.name === lod.name);
  return recipe.foliage.kind === "leaf" && index >= 0 && index <= 1;
}

function foliageElementsPerAnchor(
  recipe: TreeRecipe,
  lod: TreeLodRecipe
): { vertices: number; indices: number } {
  switch (recipe.foliage.kind) {
    case "leaf":
      return {
        vertices: LEAF_SHAPE.vertices.length * (usesDimensionalBroadleaves(recipe, lod) ? 2 : 1),
        indices: LEAF_SHAPE.indices.length * (usesDimensionalBroadleaves(recipe, lod) ? 2 : 1)
      };
    case "needle": {
      const blades = recipe.foliage.needleBlades ?? 3;
      return { vertices: BLADE_SHAPE.vertices.length * blades, indices: BLADE_SHAPE.indices.length * blades };
    }
    case "rosette": {
      const petals = recipe.foliage.rosettePetals ?? 7;
      return { vertices: BLADE_SHAPE.vertices.length * petals, indices: BLADE_SHAPE.indices.length * petals };
    }
  }
}

type FoliageWriter = {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCursor: number;
  indexCursor: number;
  bounds: MutableBounds;
};

function emitShape(
  writer: FoliageWriter,
  anchor: FoliageAnchor,
  shape: FoliageShape,
  alongAxis: Vec3,
  widthAxis: Vec3,
  normalHint: Vec3,
  lengthScale: number,
  widthScale: number,
  droop: number,
  camber = 0
): void {
  const baseVertex = writer.vertexCursor;
  const faceNormal = normalize(normalHint, normalize(cross(widthAxis, alongAxis)));

  for (const [x, y, u, v] of shape.vertices) {
    const downward = scale(VEC3_UP, -droop * lengthScale * y * y);
    const centerBias = Math.max(0, 1 - Math.abs(x) * 1.7);
    const curved = scale(faceNormal, Math.sin(Math.PI * y) * centerBias * widthScale * camber);
    const position = add(
      add(
        add(add(anchor.position, scale(alongAxis, lengthScale * y)), scale(widthAxis, widthScale * x)),
        downward
      ),
      curved
    );
    // A gentle dome normal keeps a crown volumetric without extra geometry.
    const normal = normalize(
      add(add(faceNormal, scale(anchor.radial, 0.22)), add(scale(VEC3_UP, 0.12), scale(widthAxis, x * 0.12)))
    );
    const offset = writer.vertexCursor * FOLIAGE_VERTEX_STRIDE_FLOATS;
    writer.vertices[offset] = position.x;
    writer.vertices[offset + 1] = position.y;
    writer.vertices[offset + 2] = position.z;
    writer.vertices[offset + 3] = normal.x;
    writer.vertices[offset + 4] = normal.y;
    writer.vertices[offset + 5] = normal.z;
    writer.vertices[offset + 6] = u;
    writer.vertices[offset + 7] = v;
    writer.vertices[offset + 8] = anchor.position.x;
    writer.vertices[offset + 9] = anchor.position.y;
    writer.vertices[offset + 10] = anchor.position.z;
    writer.vertices[offset + 11] = anchor.windPhase;
    writer.vertices[offset + 12] = anchor.stiffness;
    writer.vertices[offset + 13] = anchor.height01;
    writer.vertices[offset + 14] = y;
    writer.vertices[offset + 15] = anchor.palette;
    writer.vertices[offset + 16] = 0.45 + y * 0.55;
    includePoint(writer.bounds, position);
    writer.vertexCursor++;
  }

  for (const localIndex of shape.indices) writer.indices[writer.indexCursor++] = baseVertex + localIndex;
}

function emitLeaf(writer: FoliageWriter, recipe: TreeRecipe, lod: TreeLodRecipe, anchor: FoliageAnchor): void {
  const along = anchor.direction;
  const width = normalize(cross(along, anchor.radial), { x: 1, y: 0, z: 0 });
  const normal = normalize(cross(width, along), anchor.radial);
  const lodIndex = recipe.lods.findIndex((candidate) => candidate === lod || candidate.name === lod.name);
  const detailScale = lodIndex === 0 ? 0.78 : lodIndex === 1 ? 0.86 : 1;
  const length = anchor.length * lod.foliageScale * detailScale;
  const leafWidth = anchor.width * lod.foliageScale * detailScale;
  emitShape(
    writer,
    anchor,
    LEAF_SHAPE,
    along,
    width,
    normal,
    length,
    leafWidth,
    recipe.foliage.droop,
    lodIndex <= 1 ? 0.12 : 0.035
  );

  if (!usesDimensionalBroadleaves(recipe, lod)) return;
  // A second, narrower leaf surface shares the exact branch attachment and
  // bends around the midrib. This removes the single-card silhouette at close
  // range without increasing instance attributes or draw calls.
  const crossedWidth = normalize(rotateAroundAxis(width, along, Math.PI * 0.43));
  const crossedNormal = normalize(cross(crossedWidth, along), anchor.radial);
  emitShape(
    writer,
    anchor,
    LEAF_SHAPE,
    along,
    crossedWidth,
    crossedNormal,
    length * 0.96,
    leafWidth * 0.82,
    recipe.foliage.droop * 0.9,
    -0.075
  );
}

function emitNeedles(writer: FoliageWriter, recipe: TreeRecipe, lod: TreeLodRecipe, anchor: FoliageAnchor): void {
  const bladeCount = recipe.foliage.needleBlades ?? 3;
  const baseWidth = normalize(cross(anchor.direction, anchor.radial), { x: 1, y: 0, z: 0 });
  for (let blade = 0; blade < bladeCount; blade++) {
    const angle = (blade / bladeCount) * Math.PI * 2;
    const spread = rotateAroundAxis(anchor.radial, anchor.direction, angle);
    const along = normalize(add(anchor.direction, scale(spread, 0.26)));
    const width = normalize(rotateAroundAxis(baseWidth, anchor.direction, angle));
    const normal = normalize(cross(width, along), spread);
    emitShape(
      writer,
      anchor,
      BLADE_SHAPE,
      along,
      width,
      normal,
      anchor.length * lod.foliageScale,
      // Native conifer textures describe a whole needle spray, not one needle.
      // Each crossed blade is therefore a broad spray card; the alpha silhouette
      // supplies the individual needles while two cards provide crown volume.
      anchor.width * lod.foliageScale * 1.45,
      recipe.foliage.droop
    );
  }
}

function emitRosette(writer: FoliageWriter, recipe: TreeRecipe, lod: TreeLodRecipe, anchor: FoliageAnchor): void {
  const petalCount = recipe.foliage.rosettePetals ?? 7;
  const frameNormal = normalize(anchor.direction);
  const firstPetal = normalize(
    sub(anchor.radial, scale(frameNormal, anchor.radial.x * frameNormal.x + anchor.radial.y * frameNormal.y + anchor.radial.z * frameNormal.z)),
    { x: 1, y: 0, z: 0 }
  );
  for (let petal = 0; petal < petalCount; petal++) {
    const angle = (petal / petalCount) * Math.PI * 2;
    const along = normalize(rotateAroundAxis(firstPetal, frameNormal, angle));
    const width = normalize(cross(frameNormal, along));
    emitShape(
      writer,
      anchor,
      BLADE_SHAPE,
      along,
      width,
      frameNormal,
      anchor.length * lod.foliageScale,
      anchor.width * lod.foliageScale,
      recipe.foliage.droop * 0.45
    );
  }
}

export type BuiltFoliageMesh = {
  mesh: CompiledTreeMesh;
  anchorCount: number;
  vertexCount: number;
};

/** Stable, nested crown subset used by both mesh emission and branch closure. */
export function selectLodFoliageAnchors(
  recipe: TreeRecipe,
  anchors: readonly FoliageAnchor[],
  lod: TreeLodRecipe
): FoliageAnchor[] {
  const silhouetteFloor = recipe.foliage.kind === "rosette"
    ? Math.min(3, anchors.length)
    : Math.min(1, anchors.length);
  const selectedCount = anchors.length === 0
    ? 0
    : Math.max(silhouetteFloor, Math.ceil(anchors.length * lod.foliageRetention));
  return [...anchors]
    .sort((a, b) => b.keepScore - a.keepScore || a.id - b.id)
    .slice(0, selectedCount)
    .sort((a, b) => a.id - b.id);
}

/** Every visible crown anchor requires its supporting branch and full ancestry. */
export function collectFoliageSupportBranchIds(
  branches: readonly SkeletonBranch[],
  anchors: readonly FoliageAnchor[]
): ReadonlySet<number> {
  const required = new Set<number>([0]);
  for (const anchor of anchors) {
    let branch: SkeletonBranch | undefined = branches[anchor.branchId];
    while (branch) {
      required.add(branch.id);
      branch = branch.parent >= 0 ? branches[branch.parent] : undefined;
    }
  }
  return required;
}

export function buildFoliageMesh(
  recipe: TreeRecipe,
  selected: readonly FoliageAnchor[],
  lod: TreeLodRecipe,
  maxVertices: number
): BuiltFoliageMesh {
  const elements = foliageElementsPerAnchor(recipe, lod);
  const vertexCount = selected.length * elements.vertices;
  const indexCount = selected.length * elements.indices;
  if (vertexCount > maxVertices) {
    throw new TreeCompileError(
      `${lod.name} foliage mesh needs ${vertexCount} vertices, over the remaining ${maxVertices} LOD limit`
    );
  }

  const writer: FoliageWriter = {
    vertices: new Float32Array(vertexCount * FOLIAGE_VERTEX_STRIDE_FLOATS),
    indices: createIndexArray(vertexCount, indexCount),
    vertexCursor: 0,
    indexCursor: 0,
    bounds: createMutableBounds()
  };

  for (const anchor of selected) {
    switch (recipe.foliage.kind) {
      case "leaf":
        emitLeaf(writer, recipe, lod, anchor);
        break;
      case "needle":
        emitNeedles(writer, recipe, lod, anchor);
        break;
      case "rosette":
        emitRosette(writer, recipe, lod, anchor);
        break;
    }
  }

  return {
    mesh: {
      vertices: writer.vertices,
      vertexStrideFloats: FOLIAGE_VERTEX_STRIDE_FLOATS,
      attributes: FOLIAGE_VERTEX_ATTRIBUTES,
      indices: writer.indices,
      bounds: finishBounds(writer.bounds)
    },
    anchorCount: selected.length,
    vertexCount
  };
}
