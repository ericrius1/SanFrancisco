import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APSE_RADIUS,
  createApseWallSegments,
  WALL_ART_X,
  WALL_INNER_FACE_X,
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

console.log(`mission dolores contract: ok (${segments.length} wall segments, ${ktxFiles.length} upright KTX2 assets)`);
