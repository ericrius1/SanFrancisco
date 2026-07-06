import { createBox3D } from "box3d-wasm";
import { readFileSync } from "node:fs";
import { HorseRagdoll } from "../../src/gameplay/horse/horseRagdoll.ts";
import { HORSE, qRot } from "../../src/creatures/quadruped.ts";
import { type PolicyDef } from "../../src/creatures/policy.ts";

const def = JSON.parse(readFileSync("public/models/horse_policy.json", "utf8")) as PolicyDef;
const box3d = await createBox3D();

const rag = new HorseRagdoll(box3d, HORSE, def);
rag.setGoal(0, 1);
let disagreeUp = 0, runtimeFall = 0, trainerFall = 0;
const N = Math.round(30 / (1 / 60));
for (let i = 0; i < N; i++) {
  rag.update(1 / 60);
  const q = rag.torsoLink.quat as [number, number, number, number];
  const upClosed = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
  const upFull = qRot(q, [0, 1, 0])[1];
  const y = rag.torsoLink.pos[1];
  const runtime = upClosed < 0.3 || y < 0.785 * 0.34; // horseRagdoll.fallen
  const trainer = upFull < 0.4 || y < 0.32; // reward() done
  if (Math.abs(upClosed - upFull) > 1e-3) disagreeUp++;
  if (runtime) runtimeFall++;
  if (trainer) trainerFall++;
}
rag.dispose();
console.log(JSON.stringify({
  closedVsFull_disagree_frames: disagreeUp,
  runtimeGate_fall_frames: runtimeFall,
  trainerGate_fall_frames: trainerFall
}));
