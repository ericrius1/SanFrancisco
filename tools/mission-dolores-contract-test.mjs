import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APSE_RADIUS,
  createApseWallSegments,
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
assert.equal(mdInsideInterior(insideDoor.x, insideDoor.z), true, "painting rays should begin after the doorway");
assert.equal(mdInsideInterior(outsideDoor.x, outsideDoor.z), false, "painting rays must stay off outside the entrance");
assert.equal(mdInsideInterior(nearSideWall.x, nearSideWall.z), true, "the walkable aisle beside the paintings is interior");
assert.equal(mdInsideInterior(wallBand.x, wallBand.z), false, "exterior wall band is not visitor interior");
assert.equal(mdInsideInterior(apseInterior.x, apseInterior.z), true, "the sanctuary apse belongs to the interior");
assert.equal(mdInsideInterior(apseExterior.x, apseExterior.z), false, "the effect must stop beyond the apse wall");

const pipelineSource = readFileSync(path.join(ROOT, "src", "render", "pipeline.ts"), "utf8");
const radialSource = readFileSync(path.join(ROOT, "src", "render", "radialLightShafts.ts"), "utf8");
const museumCtxSource = readFileSync(path.join(ROOT, "src", "world", "missionDolores", "ctx.ts"), "utf8");
assert.match(
  pipelineSource,
  /import\("\.\/radialLightShafts"\)/,
  "the radial helper must remain behind a nested dynamic-import boundary"
);
assert.match(radialSource, /three\/addons\/tsl\/display\/radialBlur\.js/, "effect must use Three's radialBlur helper");
assert.match(
  museumCtxSource,
  /radialRays: opts\.radialRays \?\? false/,
  "generic authored art, including stained glass, must not opt into painting rays"
);
assert.match(
  museumCtxSource,
  /\{ radialRays: true \}/,
  "makePlaque painting planes must explicitly opt into the radial source"
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
  `mission dolores contract: ok (${segments.length} wall segments, ${ktxFiles.length} upright KTX2 assets, interior-only radial chunk)`
);
