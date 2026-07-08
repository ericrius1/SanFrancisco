import { createBox3D } from "box3d-wasm";
import { readFileSync } from "node:fs";
import { HorseRagdoll } from "../core/nodeRagdoll.ts";
import { HORSE } from "../../src/creatures/quadruped.ts";
import { type PolicyDef } from "../../src/creatures/policy.ts";
const def = JSON.parse(readFileSync("public/models/horse_policy.json", "utf8")) as PolicyDef;
const box3d = await createBox3D();
const rag = new HorseRagdoll(box3d, HORSE, def, 2.3);
const standY = rag.standY, dt = 1/60;
const upY = (q:readonly number[]) => 1 - 2*(q[0]*q[0]+q[2]*q[2]);
rag.setSpeed(0.8);
for (let i=0;i<120;i++){ rag.setGoal(0,1); rag.update(dt); } // trot a bit
const yBefore = rag.torsoLink.pos[1];
rag.jump();
let peak = 0;
for (let i=0;i<50;i++){ rag.setGoal(0,1); rag.update(dt); peak = Math.max(peak, rag.torsoLink.pos[1]); }
// recover window
let up2 = 1;
for (let i=0;i<150;i++){ rag.setGoal(0,1); rag.update(dt); up2 = Math.min(up2, upY(rag.torsoLink.quat)); }
const rose = (peak - yBefore)/standY;
const recovered = upY(rag.torsoLink.quat) > 0.7 && rag.torsoLink.pos[1] > 0.7*standY;
console.log(`jump: rose ${(rose*100)|0}% of stand (peak ${peak.toFixed(2)}m)  worstUpAfter ${up2.toFixed(2)}  recovered ${recovered}`);
console.log(rose > 0.15 && recovered ? "PASS — hops and lands back on its feet" : "PARTIAL — jump weak or landing shaky (policy still training)");
