/**
 * Verifies the "fall → lie limp → get back up" behavior on the ACTUAL runtime
 * ragdoll (no browser/scene needed — it's pure box3d):
 *   1) run normally a moment, 2) hard shove to knock it down,
 *   3) setDowned(true) + step ~10s → must lie LOW and LIMP (not spring up, not explode),
 *   4) setDowned(false) + reset() → must stand back up tall.
 *
 *   node --experimental-strip-types rl/tools/downedTest.ts
 */
import { createBox3D } from "box3d-wasm";
import { readFileSync } from "node:fs";
import { HorseRagdoll } from "../../src/gameplay/horse/horseRagdoll.ts";
import { HORSE } from "../../src/creatures/quadruped.ts";
import { type PolicyDef } from "../../src/creatures/policy.ts";

const def = JSON.parse(readFileSync("public/models/horse_policy.json", "utf8")) as PolicyDef;
const box3d = await createBox3D();
const rag = new HorseRagdoll(box3d, HORSE, def, 2.3);
const standY = rag.standY;
const dt = 1 / 60;
const pct = () => ((rag.torsoLink.pos[1] / standY) * 100) | 0;

// 1) run a moment
for (let i = 0; i < 60; i++) { rag.setGoal(0, 1); rag.update(dt); }
console.log(`running: ${pct()}% tall`);

// 2) knock it down hard, 3) go limp for 10s
rag.shove(6, 0.5); // big sideways hit -> it should go down
rag.setDowned(true);
let minY = 9, maxY = -9;
for (let i = 0; i < 600; i++) { // 10s limp
  rag.update(dt);
  const y = rag.torsoLink.pos[1];
  if (i > 60) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
}
const downPct = pct();
const stirred = (maxY - minY) / standY; // limp body should barely move once settled
console.log(`after 10s limp: ${downPct}% tall  (settle drift ${(stirred * 100) | 0}% of stand)`);

// 4) get back up
rag.setDowned(false);
rag.reset();
for (let i = 0; i < 30; i++) { rag.setGoal(0, 1); rag.update(dt); }
const upPct = pct();
console.log(`after get-up reset: ${upPct}% tall`);

const layDown = downPct < 55;          // it actually lay LOW while downed
const limp = stirred < 0.25;           // stayed put (limp), didn't flail/explode
const gotUp = upPct > 70;              // stood back up after reset
console.log(layDown && limp && gotUp ? "PASS — falls, lies limp ~10s, then stands back up" : `FAIL — layDown=${layDown} limp=${limp} gotUp=${gotUp}`);
