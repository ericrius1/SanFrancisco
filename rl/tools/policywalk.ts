import { createBox3D } from "box3d-wasm";
import { readFileSync } from "node:fs";
import { Policy, type PolicyDef } from "../../src/creatures/policy.ts";
import { HORSE, qRot } from "../../src/creatures/quadruped.ts";
import { Box3DEnv } from "../core/box3dEnv.ts";
import { rollout } from "../core/rollout.ts";

const def = JSON.parse(readFileSync("public/models/horse_policy.json", "utf8")) as PolicyDef;
const pol = new Policy(def);
console.log("policy sizes", def.sizes.join("x"), "params", def.weights.length);
const box3d = await createBox3D();
const env = new Box3DEnv(box3d, HORSE);
let sumSpeed = 0;
let sumUp = 0;
for (let s = 0; s < 5; s++) {
  const r = rollout(env, pol, { maxSteps: 500, seed: 10 + s, record: true, recordEvery: 5 });
  const F = r.frames!;
  const a = F[0].links[0].pos;
  const b = F[F.length - 1].links[0].pos;
  const along = (b[0] - a[0]) * F[0].goal[0] + (b[2] - a[2]) * F[0].goal[1];
  const speed = along / (r.steps / 120);
  const up = qRot(env.state.torso.quat as [number, number, number, number], [0, 1, 0]);
  const meanH = F.reduce((s2, f) => s2 + f.links[0].pos[1], 0) / F.length;
  sumSpeed += speed;
  sumUp += up[1];
  console.log(`goal ${s}: steps ${r.steps}/500  along ${along.toFixed(2)}m  speed ${speed.toFixed(2)} m/s  meanH ${meanH.toFixed(2)}  finalUp ${up[1].toFixed(2)}`);
}
console.log(`AVG speed ${(sumSpeed / 5).toFixed(2)} m/s  upright ${(sumUp / 5).toFixed(2)}`);
console.log(sumSpeed / 5 > 0.8 && sumUp / 5 > 0.7 ? "RUNS_WELL" : "needs more training");
