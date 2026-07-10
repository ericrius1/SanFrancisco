// Course/terrain authority regression: the rendered golf sheet, golf ball,
// world raycasts and player physics carpet must all resolve the same height.
// Run: npm run test:golf:terrain

import { readFileSync } from "node:fs";
import { WorldMap } from "../src/world/heightmap.ts";
import { GolfCourse } from "../src/gameplay/golf/data.ts";
import { decodeGroundTopDelta, decodeHeightmapBuffer } from "./terrain-codec.mjs";

const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

const meta = JSON.parse(readFileSync(new URL("../public/data/meta.json", import.meta.url), "utf8"));
const heightBuffer = readFileSync(new URL("../public/data/heightmap.bin", import.meta.url));
const heights = decodeHeightmapBuffer(
  heightBuffer.buffer.slice(heightBuffer.byteOffset, heightBuffer.byteOffset + heightBuffer.byteLength),
  meta
);
const deltaBuffer = readFileSync(new URL("../public/data/groundtop-delta.bin", import.meta.url));
const groundTops = decodeGroundTopDelta(deltaBuffer, heights);
const data = JSON.parse(readFileSync(new URL("../public/data/golf.json", import.meta.url), "utf8"));

const map = new WorldMap();
Object.assign(map, { meta, heights, groundTops, surface: new Uint8Array(heights.length) });
globalThis.fetch = async () => new Response(JSON.stringify(data), { status: 200 });
const course = await GolfCourse.load(map);

assert(map.groundRevision === 1, `golf overlay did not advance ground revision (${map.groundRevision})`);

let minLift = Infinity;
let maxLift = -Infinity;
let maxAuthorityError = 0;
const grades = { green: [], tee: [] };
const bounds = course.boundaryAABB;
for (let z = bounds.minZ; z <= bounds.maxZ; z += 4) {
  for (let x = bounds.minX; x <= bounds.maxX; x += 4) {
    if (!course.contains(x, z)) continue;
    const y = course.ground(x, z);
    const lift = y - map.baseGroundTop(x, z);
    minLift = Math.min(minLift, lift);
    maxLift = Math.max(maxLift, lift);
    maxAuthorityError = Math.max(maxAuthorityError, Math.abs(map.groundTop(x, z) - y));

    const kind = course.surfaceAt(x, z).kind;
    if (kind === "green" || kind === "tee") {
      const e = 0.5;
      const dx = (course.ground(x + e, z) - course.ground(x - e, z)) / (2 * e);
      const dz = (course.ground(x, z + e) - course.ground(x, z - e)) / (2 * e);
      grades[kind].push(Math.hypot(dx, dz));
    }
  }
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)] ?? Infinity;
};
const greenP90 = percentile(grades.green, 0.9);
const teeP90 = percentile(grades.tee, 0.9);

assert(minLift >= -1e-5, `course sheet dips below baked terrain by ${(-minLift).toFixed(3)}m`);
assert(maxLift <= 0.751, `course fill exceeds 0.75m budget (${maxLift.toFixed(3)}m)`);
assert(maxAuthorityError < 1e-6, `WorldMap/golf ground mismatch is ${maxAuthorityError.toFixed(6)}m`);
assert(greenP90 < 0.09, `green p90 grade is ${(greenP90 * 100).toFixed(1)}%`);
assert(teeP90 < 0.16, `tee p90 grade is ${(teeP90 * 100).toFixed(1)}%`);

for (const line of data.paths) {
  for (const [x, z] of line) {
    if (!course.contains(x, z)) assert(course.surfaceAt(x, z).kind === "out", "path beyond course fence is not out of bounds");
  }
}
for (const hole of course.holes) {
  assert(course.clearsProceduralTrees(...hole.teeXZ), `hole ${hole.ref} tee does not clear procedural trees`);
  assert(course.clearsProceduralTrees(...hole.pinXZ), `hole ${hole.ref} green does not clear procedural trees`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      groundRevision: map.groundRevision,
      sampled: { green: grades.green.length, tee: grades.tee.length },
      liftMetres: { min: Number(minLift.toFixed(3)), max: Number(maxLift.toFixed(3)) },
      maxAuthorityError,
      gradeP90: { green: Number(greenP90.toFixed(3)), tee: Number(teeP90.toFixed(3)) }
    },
    null,
    2
  )
);
