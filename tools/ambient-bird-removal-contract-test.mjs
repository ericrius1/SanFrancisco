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

// What was removed (7ee567b) was a MAP-WIDE ambient gull renderer that lived
// inside `Creatures` and wheeled flocks over every landmark — which is why that
// class needed the terrain in the first place. The checks above and below are
// what actually hold that line.
//
// This one used to ban the words "gull" and "flock" from the composition root
// outright, which also bans the opposite kind of thing: a site-scoped flock in
// its own lazily-imported module, bounded to one beach, gated on approach and
// disposed on the way out. Ocean Beach's gulls are exactly that — the same
// shape as the shorebreak and spray gates sitting beside them — so the rule is
// now the one that was meant: the root may GATE a flock, never own one.
const rootFlockState = [
  // Per-bird or per-flock arrays and counters living in the root.
  /\b(?:gull|bird|flock)s?\s*(?::\s*\w+\[\]|=\s*\[)/i,
  /\b(?:GULLS?|BIRDS?)_PER_\w+/,
  // A root-side per-frame walk over individual birds.
  /for\s*\([^)]*\b(?:gull|bird)\b[^)]*\)/i
];
for (const forbidden of rootFlockState) {
  assert.equal(
    forbidden.test(main),
    false,
    `ambient-bird runtime state returned to the composition root (${forbidden})`
  );
}
// If the root mentions a flock at all, it may only be to load a site module.
if (/\bgulls?\b/i.test(main)) {
  assert.match(
    main,
    /import\("\.\.\/\.\.\/world\/oceanBeachGulls"\)/,
    "a flock referenced from the composition root must be a lazily-imported site module"
  );
}
assert.match(
  main,
  /new creaturesMod\.Creatures\(scene\)/,
  "the serpent-only creature runtime should not regain a terrain dependency"
);

console.log("ambient bird removal contract: ok");
