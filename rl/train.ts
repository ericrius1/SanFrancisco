/**
 * Train a creature locomotion policy with Evolution Strategies against box3d,
 * headless in Node. No GPU, no Python, no autodiff — just rollouts.
 *
 *   node --experimental-strip-types rl/train.ts [--gens 120] [--pairs 96] [--creature horse]
 *
 * Writes:
 *   public/models/<creature>_policy.json   best "center" policy (browser loads this)
 *   rl/runs/<creature>_log.jsonl           reward per generation (for plots)
 *   rl/runs/<creature>_gen<N>.frames.json  periodic rollout recordings (for video)
 */
import { createBox3D } from "box3d-wasm";
import { writeFileSync, mkdirSync } from "node:fs";
import { Policy, paramCount } from "../src/creatures/policy.ts";
import { DOG, HORSE, obsDim, actDim, type CreatureSpec } from "../src/creatures/quadruped.ts";
import { Box3DEnv } from "./core/box3dEnv.ts";
import { ES, rng32 } from "./core/es.ts";
import { rollout } from "./core/rollout.ts";

const CREATURES: Record<string, CreatureSpec> = { horse: HORSE, dog: DOG };

function arg(name: string, def: number): number {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}
function argStr(name: string, def: string): string {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const creatureName = argStr("creature", "horse");
const spec = CREATURES[creatureName];
if (!spec) throw new Error("unknown creature " + creatureName);

const GENS = arg("gens", 120);
const PAIRS = arg("pairs", 96);
const EP_STEPS = arg("steps", 500);
const ROLLS = arg("rolls", 2);
const RECORD_EVERY = arg("recordEvery", 15);

const sizes = [obsDim(spec), 32, 32, actDim(spec)];
const dim = paramCount(sizes);
console.log(`[train] creature=${creatureName} obs=${sizes[0]} act=${sizes[sizes.length - 1]} params=${dim}`);

const box3d = await createBox3D();
const env = new Box3DEnv(box3d, spec);
const policy = Policy.random(sizes, rng32(1), creatureName);

const es = new ES({ dim, pairs: PAIRS, sigma: 0.08, lr: 0.03, weightDecay: 0.002, sigmaDecay: 0.995, seed: 2, init: policy.getParams() });

// same episode seeds for every member within a generation -> low-variance ranking
function fitness(params: Float32Array, tag: { gen: number }): number {
  policy.setParams(params);
  let total = 0;
  for (let e = 0; e < ROLLS; e++) {
    total += rollout(env, policy, { maxSteps: EP_STEPS, seed: 7919 * (tag.gen + 1) + e }).reward;
  }
  return total / ROLLS;
}

mkdirSync("rl/runs", { recursive: true });
mkdirSync("public/models", { recursive: true });
const logPath = `rl/runs/${creatureName}_log.jsonl`;
writeFileSync(logPath, "");

const t0 = Date.now();
let bestCenter = -Infinity;
for (let g = 0; g < GENS; g++) {
  const rep = es.step(fitness);
  const line = { gen: rep.gen, mean: +rep.meanFitness.toFixed(2), best: +rep.bestFitness.toFixed(2), center: +rep.centerFitness.toFixed(2), sigma: +rep.sigma.toFixed(4) };
  writeFileSync(logPath, JSON.stringify(line) + "\n", { flag: "a" });

  if (rep.centerFitness > bestCenter) {
    bestCenter = rep.centerFitness;
    policy.setParams(rep.center);
    writeFileSync(`public/models/${creatureName}_policy.json`, JSON.stringify(policy.toDef()));
  }

  if (rep.gen % RECORD_EVERY === 0 || g === GENS - 1) {
    policy.setParams(rep.center);
    const roll = rollout(env, policy, { maxSteps: EP_STEPS, seed: 42, record: true, recordEvery: 2 });
    const body = {
      torso: spec.torso.half,
      legs: spec.legs.map((l) => ({ hip: l.hip, thigh: [l.thigh.halfHeight, l.thigh.radius], shank: [l.shank.halfHeight, l.shank.radius] }))
    };
    writeFileSync(`rl/runs/${creatureName}_gen${rep.gen}.frames.json`, JSON.stringify({ creature: creatureName, gen: rep.gen, dt: env.dt * 2, body, reward: +roll.reward.toFixed(1), frames: roll.frames }));
    // locomotion metrics: did it actually travel, and along the goal?
    const fr = roll.frames!;
    const a = fr[0].links[0].pos;
    const b = fr[fr.length - 1].links[0].pos;
    const dist = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const along = (b[0] - a[0]) * fr[0].goal[0] + (b[2] - a[2]) * fr[0].goal[1];
    let hSum = 0;
    for (const f of fr) hSum += f.links[0].pos[1];
    const meanH = hSum / fr.length;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `gen ${rep.gen}  center=${line.center}  best=${line.best}  sigma=${line.sigma}  steps=${roll.steps}/${EP_STEPS}  dist=${dist.toFixed(2)}m  along=${along.toFixed(2)}m  meanH=${meanH.toFixed(2)}  [${secs}s]`
    );
  }
}
console.log(`[train] done in ${((Date.now() - t0) / 1000).toFixed(0)}s. best center fitness ${bestCenter.toFixed(1)}`);
console.log(`[train] policy -> public/models/${creatureName}_policy.json`);
