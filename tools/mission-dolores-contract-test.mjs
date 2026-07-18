import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APSE_RADIUS,
  createApseWallSegments,
  createMuseumFloorCollisionMesh,
  FOOT_HALF_W,
  mdInsideInterior,
  mdToWorldXZ,
  WALL_THICKNESS,
  WALL_ART_X,
  WALL_INNER_FACE_X,
  Z_ENTRANCE,
  Z_APSE
} from "../src/world/missionDolores/layout.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EPS = 1e-8;
const segments = createApseWallSegments();

assert.equal(segments.length, 12, "sanctuary wall should retain its authored 12-segment arc");
assert.ok(segments[0].x > 0 && segments.at(-1).x < 0, "apse must run east-to-west behind the altar");
assert.ok(segments.every((s) => s.z >= Z_APSE), "every apse segment must stay behind the sanctuary mouth");
assert.ok(Math.max(...segments.map((s) => s.z)) > Z_APSE + APSE_RADIUS - 0.2, "apse must reach the rear crown");
for (let i = 0; i < segments.length; i++) {
  const mirror = segments[segments.length - 1 - i];
  assert.ok(Math.abs(segments[i].x + mirror.x) < EPS, `apse segment ${i} must mirror across the centre aisle`);
  assert.ok(Math.abs(segments[i].z - mirror.z) < EPS, `apse segment ${i} must share its mirror depth`);
}
assert.ok(
  Math.abs(WALL_INNER_FACE_X - WALL_ART_X - 0.07) < EPS,
  "14 cm gallery boards must sit with their backs flush to the inner wall"
);

const insideDoor = mdToWorldXZ(0, Z_ENTRANCE + WALL_THICKNESS / 2 + 0.05);
const outsideDoor = mdToWorldXZ(0, Z_ENTRANCE - 0.05);
const nearSideWall = mdToWorldXZ(WALL_INNER_FACE_X - 0.1, 0);
const wallBand = mdToWorldXZ(WALL_INNER_FACE_X + 0.1, 0);
const apseInterior = mdToWorldXZ(0, Z_APSE + APSE_RADIUS * 0.5);
const apseExterior = mdToWorldXZ(0, Z_APSE + APSE_RADIUS + 0.1);
assert.equal(mdInsideInterior(insideDoor.x, insideDoor.z), true, "museum interior should begin after the doorway");
assert.equal(mdInsideInterior(outsideDoor.x, outsideDoor.z), false, "forecourt must stay outside the museum interior");
assert.equal(mdInsideInterior(nearSideWall.x, nearSideWall.z), true, "the walkable aisle beside the paintings is interior");
assert.equal(mdInsideInterior(wallBand.x, wallBand.z), false, "exterior wall band is not visitor interior");
assert.equal(mdInsideInterior(apseInterior.x, apseInterior.z), true, "the sanctuary apse belongs to the interior");
assert.equal(mdInsideInterior(apseExterior.x, apseExterior.z), false, "museum interior must stop beyond the apse wall");

const pipelineSource = readFileSync(path.join(ROOT, "src", "render", "pipeline.ts"), "utf8");
const pianoGodRaysSource = readFileSync(path.join(ROOT, "src", "render", "pianoGodRays.ts"), "utf8");
const museumIndexSource = readFileSync(path.join(ROOT, "src", "world", "missionDolores", "index.ts"), "utf8");
const mainSource = readFileSync(path.join(ROOT, "src", "main.ts"), "utf8");
const minimapLandmarksSource = readFileSync(path.join(ROOT, "src", "app", "compose", "minimapLandmarks.ts"), "utf8");
const playerSource = readFileSync(path.join(ROOT, "src", "player", "player.ts"), "utf8");
assert.match(
  pipelineSource,
  /import\("\.\/pianoGodRays"\)/,
  "the piano god-ray stack must remain behind a nested dynamic-import boundary"
);
assert.doesNotMatch(
  pipelineSource,
  /import\("\.\/radialLightShafts"\)/,
  "the superseded radial-blur system must not be selectable by the render pipeline"
);
assert.match(
  pianoGodRaysSource,
  /three\/addons\/tsl\/display\/GodraysNode\.js/,
  "piano effect must use Three's official WebGPU GodraysNode"
);
assert.match(
  pianoGodRaysSource,
  /three\/addons\/tsl\/display\/BilateralBlurNode\.js/,
  "piano effect must use the official bilateral cleanup pass"
);
assert.match(
  pianoGodRaysSource,
  /three\/addons\/tsl\/display\/depthAwareBlend\.js/,
  "piano effect must use the official depth-aware composite"
);
assert.doesNotMatch(mainSource, /museumRays/, "Mission Dolores must not be able to enable god rays");
assert.doesNotMatch(mainSource, /missionDolores\?\.radialLightSource/, "museum source must remain detached from rendering");
assert.match(mainSource, /setPianoGodRaysArea\(/, "only the piano area gate may select the god-ray graph");

const floor = createMuseumFloorCollisionMesh();
assert.equal(floor.indices.length, 6 + 24 * 3, "floor collision must include the nave and 24-segment apse fan");
for (let i = 0; i < floor.indices.length; i += 3) {
  const ia = floor.indices[i] * 3;
  const ib = floor.indices[i + 1] * 3;
  const ic = floor.indices[i + 2] * 3;
  const ux = floor.vertices[ib] - floor.vertices[ia];
  const uz = floor.vertices[ib + 2] - floor.vertices[ia + 2];
  const vx = floor.vertices[ic] - floor.vertices[ia];
  const vz = floor.vertices[ic + 2] - floor.vertices[ia + 2];
  assert.ok(uz * vx - ux * vz > 0, `floor triangle ${i / 3} must wind upward`);
}
assert.equal(floor.vertices[0], -FOOT_HALF_W, "nave collision must reach the west floor edge");
assert.equal(floor.vertices[2], Z_ENTRANCE, "nave collision must begin at the portal, after the ramp");
assert.match(museumIndexSource, /createStaticMesh\(/, "the authored floor must own an exact stepped-world collider");
assert.match(museumIndexSource, /takeFloorHandoffHeight/, "lazy floor activation must expose a one-shot body handoff");
assert.match(playerSource, /recoverOntoWalkSurface/, "the player must resynchronize after a late floor handoff");
assert.match(minimapLandmarksSource, /const missionDoloresSpawn = SPAWN_POINTS\.missionDolores/, "the map pin must use the safe forecourt spawn");
assert.doesNotMatch(
  minimapLandmarksSource,
  /addLandmark\(MISSION_DOLORES_CENTER\.x, MISSION_DOLORES_CENTER\.z, "Mission Dolores/,
  "the safe Mission pin must never be overwritten with the unsupported interior center"
);

const artDir = path.join(ROOT, "public", "francis", "art");
const ktxFiles = readdirSync(artDir).filter((name) => name.endsWith(".ktx2")).sort();
assert.equal(ktxFiles.length, 20, "the complete St. Francis art collection should be optimized");
for (const file of ktxFiles) {
  const stem = file.slice(0, -".ktx2".length);
  const bytes = readFileSync(path.join(artDir, file));
  assert.notEqual(
    bytes.indexOf(Buffer.from("KTXorientation\0ru")),
    -1,
    `${file} must use the lower-left KTX origin Three samples upright`
  );
  assert.ok(readdirSync(artDir).includes(`${stem}.webp`), `${file} must keep its WebP fallback pair`);
}

console.log(
  `mission dolores contract: ok (${segments.length} wall segments, ${floor.indices.length / 3} floor triangles, ${ktxFiles.length} upright KTX2 assets, god rays hard-disabled)`
);
