/**
 * THE DEPLOY GATE. Runs the ACTUAL in-world runtime (src/gameplay/horse/
 * horseRagdoll.ts — the exact code the game renders) headlessly in Node and
 * asserts the horse stays TALL + UPRIGHT while moving, the way the game drives
 * it (sustained forward, a turn, more forward). Uprightness/height is box3d
 * physics, not rendering, so this is verifiable without WebGPU — the check I
 * should have been running all along. Deploy only if this prints PASS.
 *
 *   node --experimental-strip-types rl/tools/runtimeTest.ts
 */
import { createBox3D } from "box3d-wasm";
import { readFileSync } from "node:fs";
import { HorseRagdoll } from "../../src/gameplay/horse/horseRagdoll.ts";
import { HORSE } from "../../src/creatures/quadruped.ts";
import { type PolicyDef } from "../../src/creatures/policy.ts";

const def = JSON.parse(readFileSync("public/models/horse_policy.json", "utf8")) as PolicyDef;
const box3d = await createBox3D();
const rag = new HorseRagdoll(box3d, HORSE, def, 2.3); // the in-world horse size
const standY = rag.standY;
const upY = (q: readonly number[]) => 1 - 2 * (q[0] * q[0] + q[2] * q[2]);

const dt = 1 / 60;
let worstTorsoY = 99;
let worstUp = 1;
let start: [number, number] | null = null;
let end: [number, number] = [0, 0];
let theta = 0; // goal heading; forward for 4s then a gradual continuous turn (like the game's wander)
for (let i = 0; i < 600; i++) {
  if (i >= 240) theta += 0.006;
  rag.setGoal(Math.sin(theta), Math.cos(theta));
  rag.update(dt);
  const t = rag.torsoLink;
  if (i === 60) start = [t.pos[0], t.pos[2]];
  if (i >= 90) {
    worstTorsoY = Math.min(worstTorsoY, t.pos[1]);
    worstUp = Math.min(worstUp, upY(t.quat));
  }
  end = [t.pos[0], t.pos[2]];
  if (i % 60 === 0) console.log(`t=${(i / 60).toFixed(1)}s torsoY=${t.pos[1].toFixed(3)} (${((t.pos[1] / standY) * 100) | 0}% of stand) up=${upY(t.quat).toFixed(3)}`);
}
const moved = start ? Math.hypot(end[0] - start[0], end[1] - start[1]) : 0;
const tallPct = (worstTorsoY / standY) * 100;
console.log(`\nstandY ${standY.toFixed(2)}m  WORST torsoY ${worstTorsoY.toFixed(2)}m (${tallPct | 0}% of stand)  WORST up ${worstUp.toFixed(2)}  moved ${moved.toFixed(1)}m`);
const tallOK = worstTorsoY > 0.72 * standY;
const upOK = worstUp > 0.82;
const moveOK = moved > 2;
console.log(tallOK && upOK && moveOK ? "PASS — stands tall, upright, and moves in the real runtime" : `FAIL — tall=${tallOK} (need >72% of stand) up=${upOK} (need >0.82) move=${moveOK} (need >2m)`);
