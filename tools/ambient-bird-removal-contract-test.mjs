import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const creaturesPath = path.join(root, "src/gameplay/creatures.ts");
// The creature runtime wiring moved from main.ts into the compose modules
// (docs/MAIN_DECOMPOSITION.md steps 6+7) — check the whole composition root.
const wiringPaths = [
  path.join(root, "src/main.ts"),
  path.join(root, "src/app/compose/worldSystemsCore.ts"),
  path.join(root, "src/app/compose/worldSystemsNet.ts"),
  path.join(root, "src/app/compose/frameBody.ts")
];
const creatures = readFileSync(creaturesPath, "utf8");
const main = wiringPaths.map((p) => readFileSync(p, "utf8")).join("\n");

for (const forbidden of [
  /\bbirds?\b/i,
  /\bgulls?\b/i,
  /\bflocks?\b/i,
  /\bwings?\b/i,
  /instanceIndex/,
  /positionNode/,
  /three\/tsl/,
]) {
  assert.equal(
    forbidden.test(creatures),
    false,
    `ambient-bird rendering code returned to src/gameplay/creatures.ts (${forbidden})`
  );
}

assert.equal(
  /\b(gulls?|flocks?)\b/i.test(main),
  false,
  "ambient-bird runtime wiring returned to the composition root"
);
assert.match(
  main,
  /new creaturesMod\.Creatures\(scene\)/,
  "the serpent-only creature runtime should not regain a terrain dependency"
);

console.log("ambient bird removal contract: ok");
