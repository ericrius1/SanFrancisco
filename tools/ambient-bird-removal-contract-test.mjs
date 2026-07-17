import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const creaturesPath = path.join(root, "src/gameplay/creatures.ts");
const mainPath = path.join(root, "src/main.ts");
const creatures = readFileSync(creaturesPath, "utf8");
const main = readFileSync(mainPath, "utf8");

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
  "ambient-bird runtime wiring returned to src/main.ts"
);
assert.match(
  main,
  /new creaturesMod\.Creatures\(scene\)/,
  "the serpent-only creature runtime should not regain a terrain dependency"
);

console.log("ambient bird removal contract: ok");
