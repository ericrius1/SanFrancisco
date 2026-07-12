// CityGen rooftop collision regression (Node, no DOM/WebGPU).
//
// Bundles the real TypeScript collider + Box3D facade, verifies that a real SF
// roof and synthetic rotated/concave roofs are queryable at their visible top,
// then drops the production hoverboard body shape at ordinary and extreme
// downward speeds under the production 60 Hz / 2-substep solver settings.
//
//   npm run test:roof-collision

import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await mkdtemp(path.join(os.tmpdir(), "roof-collision-probe-"));
const outfile = path.join(tmp, "probe-runtime.mjs");

await build({
  stdin: {
    contents: `
      export { createBox3D, BodyType } from "./src/core/box3dWorld.ts";
      export { roofColliderMesh } from "./src/world/citygen/core/collider.ts";
    `,
    resolveDir: ROOT,
    sourcefile: "roof-probe-entry.ts",
    loader: "ts"
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error"
});

const { createBox3D, BodyType, roofColliderMesh } = await import(pathToFileURL(outfile).href);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const close = (a, b, eps = 0.015) => Math.abs(a - b) <= eps;

const grid = JSON.parse(await readFile(path.join(ROOT, "public/citygen/buildings.json"), "utf8"));
let real = null;
for (const list of Object.values(grid.cells)) {
  real = list.find((b) => b.id === 288543110) ?? null;
  if (real) break;
}
assert(real, "known Victorian rooftop fixture is missing");

const specs = [
  {
    name: "closed-ring",
    top: 10,
    poly: [[-4, -4], [4, -4], [4, 4], [-4, 4], [-4, -4]],
    inside: [[0, 0]],
    outside: [[6, 6]]
  },
  {
    name: "rotated",
    top: 12,
    poly: [[-5, -2], [2, -5], [5, 2], [-2, 5]],
    inside: [[0, 0]],
    outside: [[7, 7]]
  },
  {
    name: "concave-L",
    top: 18,
    poly: [[0, 0], [8, 0], [8, 3], [3, 3], [3, 8], [0, 8]],
    inside: [[1, 1], [6, 1], [1, 6]],
    outside: [[6, 6]]
  },
  {
    ...real,
    name: "real-victorian",
    inside: [[951.54, 2400.46]],
    outside: [[965, 2408]]
  }
].map((s, i) => ({
  i, id: i, base: s.top - 10, archetype: "victorian", seed: i + 1, ...s
}));

const box3d = await createBox3D();
const queryResults = [];
for (const spec of specs) {
  const mesh = roofColliderMesh(spec);
  assert(mesh, `${spec.name}: roof mesh was not generated`);
  const world = box3d.createWorld([0, 0, 0]);
  world.createStaticMesh({
    position: [mesh.x, mesh.y, mesh.z], vertices: mesh.vertices, indices: mesh.indices, friction: 0.8
  });

  for (const [x, z] of spec.inside) {
    const hit = world.castRayClosest(x, spec.top + 10, z, 0, -1, 0, 20);
    assert(hit, `${spec.name}: downward roof ray missed at (${x}, ${z})`);
    assert(close(hit.py, spec.top), `${spec.name}: roof hit y=${hit.py}, expected ${spec.top}`);
    assert(hit.ny > 0.99, `${spec.name}: roof normal points the wrong way (${hit.nx}, ${hit.ny}, ${hit.nz})`);
  }
  for (const [x, z] of spec.outside) {
    const hit = world.castRayClosest(x, spec.top + 10, z, 0, -1, 0, 20);
    assert(!hit, `${spec.name}: roof collider spills outside the footprint at (${x}, ${z})`);
  }
  queryResults.push({ name: spec.name, vertices: mesh.vertices.length / 3, triangles: mesh.indices.length / 3 });
  world.dispose();
}

// Every production footprint must receive a complete top cap. OSM occasionally
// closes a ring by repeating its first point, and one real building contains two
// lobes touching at a repeated vertex; both used to make ear clipping stop early.
const polyArea = (poly) => Math.abs(poly.reduce((sum, a, i) => {
  const b = poly[(i + 1) % poly.length];
  return sum + a[0] * b[1] - b[0] * a[1];
}, 0) / 2);
const meshTopArea = (mesh) => {
  let area = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ia = mesh.indices[i] * 3, ib = mesh.indices[i + 1] * 3, ic = mesh.indices[i + 2] * 3;
    if (mesh.vertices[ia + 1] < 0 || mesh.vertices[ib + 1] < 0 || mesh.vertices[ic + 1] < 0) continue;
    const ax = mesh.vertices[ia], az = mesh.vertices[ia + 2];
    const bx = mesh.vertices[ib], bz = mesh.vertices[ib + 2];
    const cx = mesh.vertices[ic], cz = mesh.vertices[ic + 2];
    area += Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
  }
  return area;
};
let auditedRoofs = 0;
for (const list of Object.values(grid.cells)) for (const spec of list) {
  const mesh = roofColliderMesh(spec);
  assert(mesh, `building ${spec.id}: roof mesh missing`);
  const expected = polyArea(spec.poly);
  const covered = meshTopArea(mesh);
  assert(Math.abs(covered - expected) <= 0.02, `building ${spec.id}: roof cap ${covered.toFixed(2)}m², footprint ${expected.toFixed(2)}m²`);
  auditedRoofs++;
}

function dropBoard(spec, speed) {
  const mesh = roofColliderMesh(spec);
  assert(mesh, `${spec.name}: no roof for drop`);
  const [x, z] = spec.inside[0];
  const world = box3d.createWorld([0, -10, 0]);
  world.createStaticMesh({
    position: [mesh.x, mesh.y, mesh.z], vertices: mesh.vertices, indices: mesh.indices, friction: 0.8
  });
  const board = world.createBox({
    type: BodyType.Dynamic,
    position: [x, spec.top + 8, z],
    halfExtents: [0.55, 0.25, 1.15],
    density: 60,
    friction: 0.15,
    restitution: 0.1
  });
  world.setBodyVelocity(board, [0, speed, 0], [0, 0, 0]);

  let minY = Infinity;
  // Long enough for even the deliberately extreme -400 m/s case to finish its
  // restitution bounce and settle back on the cap.
  for (let i = 0; i < 900; i++) {
    const t = world.getBodyTransform(board);
    const v = world.getBodyVelocity(board);
    minY = Math.min(minY, t.position[1]);
    // Match BoardController: attitude is code-owned and angular velocity is
    // pinned before each production physics step.
    world.setBodyTransform(board, t.position, [0, 0, 0, 1]);
    world.setBodyVelocity(board, [0, v.linear[1], 0], [0, 0, 0]);
    world.step(1 / 60, 2);
  }
  const y = world.getBodyTransform(board).position[1];
  world.dispose();
  // A speculative high-speed contact may permit a few centimetres of transient
  // overlap, but the board centre must never cross the visible roof plane.
  assert(minY >= spec.top, `${spec.name} @ ${speed}m/s crossed roof: min center y=${minY.toFixed(3)}`);
  assert(close(y, spec.top + 0.25, 0.035), `${spec.name} @ ${speed}m/s settled at y=${y.toFixed(3)}`);
  return { name: spec.name, speed, minY: Number(minY.toFixed(3)), settledY: Number(y.toFixed(3)) };
}

const drops = [];
for (const speed of [-20, -80, -400]) drops.push(dropBoard(specs[1], speed));
drops.push(dropBoard(specs[3], -20));

await rm(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, auditedRoofs, queryResults, drops }, null, 2));
