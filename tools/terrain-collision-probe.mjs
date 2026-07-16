// Shared-edge terrain collision regression (Node, no DOM/WebGPU).
//
// Verifies pure patch topology/coverage, upward winding, safe cliff holes, a
// dynamic car-sized box crossing internal triangle edges without snagging, and
// the create-new/destroy-old handoff used by Physics at patch boundaries.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await mkdtemp(path.join(os.tmpdir(), "terrain-collision-probe-"));
const outfile = path.join(tmp, "probe-runtime.mjs");

await build({
  stdin: {
    contents: `
      export { createBox3D, BodyType } from "./src/core/box3dWorld.ts";
      export {
        buildTerrainCollisionPatch,
        terrainPatchCovers
      } from "./src/core/terrainCollisionPatch.ts";
    `,
    resolveDir: ROOT,
    sourcefile: "terrain-collision-probe-entry.ts",
    loader: "ts"
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error"
});

const {
  createBox3D,
  BodyType,
  buildTerrainCollisionPatch,
  terrainPatchCovers
} = await import(pathToFileURL(outfile).href);
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

const smoothSurface = {
  groundTop(x, z) {
    return 0.015 * x + 0.18 * Math.sin(z / 18) + 0.08 * Math.sin(x / 11);
  }
};
const patch = buildTerrainCollisionPatch(smoothSurface, 0, 0, {
  halfSize: 32,
  step: 4,
  maxEdgeRise: 4
});
assert(patch.vertices.length / 3 === 17 * 17, "patch must share its 17×17 vertex lattice");
assert(patch.indices.length / 3 === 16 * 16 * 2, "ordinary terrain must emit two triangles per quad");
assert(patch.holeCount === 0, "smooth terrain unexpectedly produced a hole");
assert(terrainPatchCovers(patch, 0, 0, 5), "centre footprint should be mesh-covered");
assert(!terrainPatchCovers(patch, 30, 0, 5), "boundary footprint should request box fallback");

// The right half jumps by 20 m. Quads crossing the discontinuity must disappear,
// while ordinary cells on both sides remain represented.
const cliff = buildTerrainCollisionPatch(
  { groundTop: (x) => (x > 0 ? 20 : 0) },
  0,
  0,
  { halfSize: 16, step: 4, maxEdgeRise: 4 }
);
assert(cliff.holeCount === 8, `cliff boundary should remove one 8-quad column, got ${cliff.holeCount}`);
assert(!terrainPatchCovers(cliff, 0, 0, 5), "cliff footprint must retain box fallback");
assert(terrainPatchCovers(cliff, -10, 0, 2), "flat terrain beside cliff should stay mesh-covered");

const productionPatch = buildTerrainCollisionPatch(smoothSurface, 0, 0);
assert(productionPatch.vertices.length / 3 === 61 * 61, "production patch lattice changed unexpectedly");
assert(productionPatch.indices.length / 3 === 60 * 60 * 2, "production patch triangle count changed unexpectedly");

const box3d = await createBox3D();
// Measure the synchronous runtime work at production dimensions. This is
// reported rather than hard-gated because CI/desktop CPU timing varies widely.
const perfWorld = box3d.createWorld([0, 0, 0]);
const buildMs = [];
for (let i = 0; i < 7; i++) {
  const t0 = performance.now();
  const body = perfWorld.createStaticMesh({
    position: [0, 0, 0],
    vertices: productionPatch.vertices,
    indices: productionPatch.indices,
    friction: 0.8
  });
  buildMs.push(performance.now() - t0);
  perfWorld.destroyBody(body);
}
perfWorld.dispose();
buildMs.sort((a, b) => a - b);

const world = box3d.createWorld([0, -9.81, 0]);
let ground = world.createStaticMesh({
  position: [patch.centerX, 0, patch.centerZ],
  vertices: patch.vertices,
  indices: patch.indices,
  friction: 0.05
});
const car = world.createBox({
  type: BodyType.Dynamic,
  position: [-24, smoothSurface.groundTop(-24, 0) + 1.4, 0],
  halfExtents: [1.0, 0.45, 2.0],
  density: 133,
  friction: 0.05,
  restitution: 0
});

// First settle, then continually request forward speed as CarController does.
for (let i = 0; i < 120; i++) world.step(1 / 60, 2);
let previousX = world.getBodyTransform(car).position[0];
let worstAdvance = Infinity;
for (let i = 0; i < 150; i++) {
  const v = world.getBodyVelocity(car);
  world.setBodyVelocity(car, [12, v.linear[1], 0], [0, 0, 0]);
  world.step(1 / 60, 2);
  const x = world.getBodyTransform(car).position[0];
  worstAdvance = Math.min(worstAdvance, x - previousX);
  previousX = x;
  if (i === 70) {
    // Production handoff order: install the replacement before removing the old.
    const replacement = world.createStaticMesh({
      position: [patch.centerX, 0, patch.centerZ],
      vertices: patch.vertices,
      indices: patch.indices,
      friction: 0.05
    });
    world.destroyBody(ground);
    ground = replacement;
  }
}
const final = world.getBodyTransform(car).position;
assert(final[0] > 5, `car failed to cross the shared triangle lattice (x=${final[0].toFixed(3)})`);
assert(worstAdvance > -0.05, `an internal edge reversed the car by ${worstAdvance.toFixed(3)} m in one step`);
assert(Number.isFinite(final[1]), "car height became non-finite after patch handoff");

world.dispose();
await rm(tmp, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  patch: {
    vertices: patch.vertices.length / 3,
    triangles: patch.indices.length / 3,
    holes: patch.holeCount
  },
  cliffHoles: cliff.holeCount,
  productionPatch: {
    vertices: productionPatch.vertices.length / 3,
    triangles: productionPatch.indices.length / 3,
    medianCreateMs: Number(buildMs[Math.floor(buildMs.length / 2)].toFixed(3)),
    maxCreateMs: Number(buildMs.at(-1).toFixed(3))
  },
  drive: {
    finalX: Number(final[0].toFixed(3)),
    finalY: Number(final[1].toFixed(3)),
    worstAdvance: Number(worstAdvance.toFixed(4))
  }
}, null, 2));
