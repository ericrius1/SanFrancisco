/**
 * Focused Node probe:
 *   node --experimental-strip-types src/world/treeCompiler/probe.ts
 */

import {
  BRANCH_VERTEX_STRIDE_FLOATS,
  FOLIAGE_VERTEX_STRIDE_FLOATS,
  compileTree,
  treePrototypeTransferables,
  type CompiledTreePrototype,
  type FoliageKind,
  type TreeRecipe
} from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Native tree compiler probe failed: ${message}`);
}

function testRecipe(kind: FoliageKind): TreeRecipe {
  return {
    version: 1,
    name: `probe-${kind}`,
    height: 11,
    trunk: {
      segments: 10,
      radius: 0.42,
      tipRadiusRatio: 0.08,
      flare: 0.55,
      curveDeg: 8,
      curveNoiseDeg: 3,
      leanDeg: 2.5,
      barkRepeat: 1.8
    },
    branchLevels: [
      {
        count: 8,
        segments: 6,
        start: 0.24,
        end: 0.92,
        lengthRatio: [0.32, 0.48],
        radiusRatio: [0.28, 0.42],
        downAngleDeg: 66,
        downAngleJitterDeg: 9,
        rotateJitterDeg: 7,
        curveDeg: 11,
        curveJitterDeg: 8,
        gravity: 0.08,
        taper: 0.94
      },
      {
        count: 4,
        segments: 4,
        start: 0.38,
        end: 0.96,
        lengthRatio: [0.27, 0.4],
        radiusRatio: [0.22, 0.35],
        downAngleDeg: 54,
        downAngleJitterDeg: 12,
        rotateJitterDeg: 10,
        curveDeg: 16,
        curveJitterDeg: 12,
        gravity: 0.13,
        taper: 0.97
      }
    ],
    foliage: {
      kind,
      placement: {
        // Deliberately higher than the far LOD's tube limit: distant crowns
        // must survive even when their supporting twigs are omitted.
        minBranchLevel: 2,
        start: 0.46,
        end: 0.98,
        anchorsPerMeter: 3.8,
        tipBias: 1.35,
        whorlSize: 2,
        azimuthJitterDeg: 8,
        maxAnchors: 3_000
      },
      length: kind === "needle" ? [0.3, 0.5] : [0.38, 0.68],
      width: kind === "needle" ? [0.035, 0.065] : [0.18, 0.31],
      outwardAngleDeg: kind === "rosette" ? 84 : 58,
      outwardAngleJitterDeg: 13,
      droop: 0.08,
      stiffness: 0.78,
      needleBlades: 3,
      rosettePetals: 7
    },
    lods: [
      {
        name: "near",
        branchRetention: 1,
        foliageRetention: 1,
        maxBranchLevel: 2,
        radialSegments: 8,
        axialStride: 1,
        foliageScale: 1
      },
      {
        name: "mid",
        branchRetention: 0.58,
        foliageRetention: 0.54,
        maxBranchLevel: 2,
        radialSegments: 6,
        axialStride: 2,
        foliageScale: 1.14
      },
      {
        name: "far",
        branchRetention: 0.26,
        foliageRetention: 0.18,
        maxBranchLevel: 1,
        radialSegments: 4,
        axialStride: 3,
        foliageScale: 1.42
      }
    ]
  };
}

function arraysEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function assertFinite(prototype: CompiledTreePrototype): void {
  for (const lod of prototype.lods) {
    for (const value of lod.branch.vertices) assert(Number.isFinite(value), `${lod.name} branch contains NaN/Infinity`);
    for (const value of lod.foliage.vertices) assert(Number.isFinite(value), `${lod.name} foliage contains NaN/Infinity`);
    const branchVertexCount = lod.branch.vertices.length / BRANCH_VERTEX_STRIDE_FLOATS;
    const foliageVertexCount = lod.foliage.vertices.length / FOLIAGE_VERTEX_STRIDE_FLOATS;
    for (const index of lod.branch.indices) assert(index < branchVertexCount, `${lod.name} branch index out of range`);
    for (const index of lod.foliage.indices) assert(index < foliageVertexCount, `${lod.name} foliage index out of range`);
  }
}

/** Face winding must agree with authored outward vertex normals (FrontSide bark). */
function assertBranchWindingOutward(prototype: CompiledTreePrototype): void {
  for (const lod of prototype.lods) {
    const { vertices, indices } = lod.branch;
    const stride = BRANCH_VERTEX_STRIDE_FLOATS;
    let checked = 0;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const i0 = indices[i]! * stride;
      const i1 = indices[i + 1]! * stride;
      const i2 = indices[i + 2]! * stride;
      const ax = vertices[i0]!;
      const ay = vertices[i0 + 1]!;
      const az = vertices[i0 + 2]!;
      const e1x = vertices[i1]! - ax;
      const e1y = vertices[i1 + 1]! - ay;
      const e1z = vertices[i1 + 2]! - az;
      const e2x = vertices[i2]! - ax;
      const e2y = vertices[i2 + 1]! - ay;
      const e2z = vertices[i2 + 2]! - az;
      const fx = e1y * e2z - e1z * e2y;
      const fy = e1z * e2x - e1x * e2z;
      const fz = e1x * e2y - e1y * e2x;
      const nx = (vertices[i0 + 3]! + vertices[i1 + 3]! + vertices[i2 + 3]!) / 3;
      const ny = (vertices[i0 + 4]! + vertices[i1 + 4]! + vertices[i2 + 4]!) / 3;
      const nz = (vertices[i0 + 5]! + vertices[i1 + 5]! + vertices[i2 + 5]!) / 3;
      const align = fx * nx + fy * ny + fz * nz;
      assert(align > 0, `${lod.name} branch triangle ${i / 3} faces inward (dot=${align})`);
      checked++;
      if (checked >= 64) break;
    }
    assert(checked > 0, `${lod.name} branch has no triangles to check`);
  }
}

const first = compileTree(testRecipe("leaf"), 0x5eed1234);
const repeated = compileTree(testRecipe("leaf"), 0x5eed1234);
const changed = compileTree(testRecipe("leaf"), 0x5eed1235);

assert(first.skeletonFingerprint === repeated.skeletonFingerprint, "same seed changed skeleton fingerprint");
assert(arraysEqual(first.skeleton.points, repeated.skeleton.points), "same seed changed skeleton points");
assert(arraysEqual(first.lods[0].branch.vertices, repeated.lods[0].branch.vertices), "same seed changed branches");
assert(arraysEqual(first.lods[0].foliage.vertices, repeated.lods[0].foliage.vertices), "same seed changed foliage");
assert(first.skeletonFingerprint !== changed.skeletonFingerprint, "different seed reused skeleton fingerprint");
assert(first.stats.skeletonBranches === 41, "unexpected shared-skeleton branch count");
assert(first.skeleton.pointOffsets.length === first.stats.skeletonBranches + 1, "invalid point offset table");
assert(first.lods[0].stats.branches >= first.lods[1].stats.branches, "mid LOD restored branches");
assert(first.lods[1].stats.branches >= first.lods[2].stats.branches, "far LOD restored branches");
assert(first.lods[0].stats.foliageAnchors >= first.lods[1].stats.foliageAnchors, "mid LOD restored foliage");
assert(first.lods[1].stats.foliageAnchors >= first.lods[2].stats.foliageAnchors, "far LOD restored foliage");
assert(first.lods[2].stats.foliageAnchors > 0, "far crown vanished with its supporting twigs");
for (let index = 0; index < first.lods.length; index++) {
  const expected = Math.max(1, Math.ceil(first.stats.foliageAnchors * testRecipe("leaf").lods[index].foliageRetention));
  assert(first.lods[index].stats.foliageAnchors === expected, `${first.lods[index].name} missed its foliage budget`);
}
assert(first.bounds.sphereRadius > 0, "tree bounds are empty");
assert(first.shadow.canopyRadii.every((radius) => radius > 0), "shadow canopy is empty");
assert(treePrototypeTransferables(first).length === 19, "unexpected transferable buffer count");
assertFinite(first);
assertBranchWindingOutward(first);

const needle = compileTree(testRecipe("needle"), 0xabc123);
const rosette = compileTree(testRecipe("rosette"), 0xabc123);
assert(needle.lods[0].stats.foliageVertices > first.lods[0].stats.foliageVertices, "needle clusters were not expanded");
assert(rosette.lods[0].stats.foliageVertices > needle.lods[0].stats.foliageVertices, "rosettes were not expanded");
assertFinite(needle);
assertFinite(rosette);

const invalid = testRecipe("leaf");
invalid.lods[2].branchRetention = 0.9;
let rejectedInvalidLod = false;
try {
  compileTree(invalid, 1);
} catch {
  rejectedInvalidLod = true;
}
assert(rejectedInvalidLod, "invalid non-nested LOD recipe was accepted");

console.log(
  JSON.stringify(
    {
      ok: true,
      fingerprint: first.skeletonFingerprint,
      skeleton: {
        branches: first.stats.skeletonBranches,
        points: first.stats.skeletonPoints,
        foliageAnchors: first.stats.foliageAnchors
      },
      lods: first.lods.map((lod) => ({ name: lod.name, ...lod.stats })),
      foliageKinds: {
        leafVertices: first.lods[0].stats.foliageVertices,
        needleVertices: needle.lods[0].stats.foliageVertices,
        rosetteVertices: rosette.lods[0].stats.foliageVertices
      }
    },
    null,
    2
  )
);
