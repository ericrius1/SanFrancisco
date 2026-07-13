import { readFileSync } from "node:fs";

const renderCore = readFileSync(new URL("../src/app/renderCore.ts", import.meta.url), "utf8");
const markings = readFileSync(new URL("../src/world/roadMarkings.ts", import.meta.url), "utf8");

const failures = [];

if (!/reversedDepthBuffer:\s*true/.test(renderCore)) {
  failures.push("render core must keep reversed depth enabled");
}
if (!/polygonOffsetFactor\s*=\s*[1-9]/.test(markings)) {
  failures.push("road-marking slope bias must be positive for reversed depth");
}
if (!/polygonOffsetUnits\s*=\s*[1-9]/.test(markings)) {
  failures.push("road-marking constant bias must be positive for reversed depth");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("PASS: road-marking decal bias matches the reversed-depth renderer");
}
