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
import { createBox3D } from "../src/core/box3dWorld.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { Policy, paramCount } from "../src/creatures/policy.ts";
import { DOG, HORSE, GOAT, obsDim, actDim, setTuning, type CreatureSpec } from "../src/creatures/quadruped.ts";
import { readFileSync as _readFileSync } from "node:fs";
import { Box3DEnv } from "./core/box3dEnv.ts";
import { ES, rng32 } from "./core/es.ts";
import { rollout } from "./core/rollout.ts";

// "pup" trains the DOG body but deploys to pup_policy.json — the in-world
// puppy nursery (src/gameplay/pup) polls that file and hot-swaps the brain.
const CREATURES: Record<string, CreatureSpec> = { horse: HORSE, dog: DOG, pup: DOG, goat: GOAT };

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

// Outer search loop hooks: CONFIG = a gait-tuning JSON to train under; OUT =
// where to write the resulting policy (so parallel configs don't clobber).
const CONFIG_PATH = process.env.CONFIG ?? "";
const OUT_PATH = process.env.OUT ?? `public/models/${creatureName}_policy.json`;
const WARM_PATH = process.env.WARM ?? `public/models/${creatureName}_policy.json`;
let TUNING_CFG: Record<string, number> | null = null;
if (CONFIG_PATH) {
  TUNING_CFG = JSON.parse(_readFileSync(CONFIG_PATH, "utf8"));
  setTuning(TUNING_CFG);
  console.log(`[train] tuning from ${CONFIG_PATH}: ${JSON.stringify(TUNING_CFG)}`);
}

const GENS = arg("gens", 120);
const PAIRS = arg("pairs", 96);
const EP_STEPS = arg("steps", 500);
const ROLLS = arg("rolls", 2);
const RECORD_EVERY = arg("recordEvery", 15);

const sizes = [obsDim(spec), 32, 32, actDim(spec)];
const dim = paramCount(sizes);
console.log(`[train] creature=${creatureName} obs=${sizes[0]} act=${sizes[sizes.length - 1]} params=${dim}`);

const box3d = await createBox3D();
// DOMAIN RANDOMIZATION over body size: train across several scales so the policy
// generalizes to any size (obs/reward are non-dimensional, so one policy works
// at all of them). Each fitness eval is scored across the whole range.
// Overridable so a creature trains at the scales its in-world body actually
// uses (the pup grows 0.45 -> 0.85 as generations pass).
const SCALES = (argStr("scales", "") || "0.8,1.3,1.9,2.6").split(",").map(Number);
const envs = SCALES.map((s) => new Box3DEnv(box3d, spec, { scale: s }));
const recEnv = envs[Math.min(2, envs.length - 1)]; // near the in-world size, for recorded metrics
const policy = Policy.random(sizes, rng32(1), creatureName);

// Grow a saved policy's INPUT layer to a larger obs dim by appending zero weights
// for the new inputs — so a policy trained before a new obs channel (e.g. the gait
// speed command) warm-starts as its old self and LEARNS to use the new input.
function expandPolicyInput(def: any, newIn: number): any {
  const oldIn = def.sizes?.[0];
  if (!oldIn || oldIn === newIn) return def;
  if (oldIn > newIn) return def; // can't shrink; leave as-is (mismatch will be caught)
  const out0 = def.sizes[1];
  const w = def.weights as number[];
  const nw: number[] = [];
  let k = 0;
  for (let o = 0; o < out0; o++) {
    for (let i = 0; i < oldIn; i++) nw.push(w[k++]); // old input weights for this neuron
    for (let i = oldIn; i < newIn; i++) nw.push(0); // new inputs: ignored until learned
  }
  while (k < w.length) nw.push(w[k++]); // bias0 + all later layers verbatim
  return { ...def, sizes: [newIn, ...def.sizes.slice(1)], weights: nw };
}

// --warm continues from the currently-deployed policy (refine a good gait
// under a new reward instead of relearning to stand from scratch)
if (process.argv.includes("--warm")) {
  try {
    const raw = JSON.parse(await import("node:fs").then((m) => m.readFileSync(WARM_PATH, "utf8")));
    const def = expandPolicyInput(raw, sizes[0]);
    if (def.weights?.length === dim) {
      policy.setParams(Float32Array.from(def.weights));
      const grew = raw.sizes?.[0] !== sizes[0] ? ` (expanded obs ${raw.sizes?.[0]}->${sizes[0]})` : "";
      console.log(`[train] warm-started from public/models/${creatureName}_policy.json${grew}`);
    } else console.log(`[train] warm start skipped: param mismatch (${def.weights?.length} vs ${dim})`);
  } catch (e) {
    console.log("[train] warm start failed:", (e as Error).message);
  }
}

const SIGMA = arg("sigma", 0.08);
const SIGMA_DECAY = arg("sigmaDecay", 0.996);
const es = new ES({ dim, pairs: PAIRS, sigma: SIGMA, lr: 0.03, weightDecay: 0.002, sigmaDecay: SIGMA_DECAY, seed: 2, init: policy.getParams() });

// same episode seeds for every member within a generation -> low-variance ranking
function fitness(params: Float32Array, tag: { gen: number }): number {
  policy.setParams(params);
  let total = 0;
  const n = Math.max(ROLLS, SCALES.length);
  for (let e = 0; e < n; e++) {
    total += rollout(envs[e % SCALES.length], policy, { maxSteps: EP_STEPS, seed: 7919 * (tag.gen + 1) + e }).reward;
  }
  return total / n;
}

mkdirSync("rl/runs", { recursive: true });
mkdirSync("public/models", { recursive: true });
const logPath = `rl/runs/${creatureName}_log.jsonl`;
writeFileSync(logPath, "");

// Deploy with progress metadata so the in-world creature knows how grown-up
// this brain is (it sizes the body + labels the sign from meta.gen).
function deploy(gen: number, robust: number): void {
  writeFileSync(OUT_PATH, JSON.stringify({ ...policy.toDef(), tuning: TUNING_CFG ?? undefined, meta: { gen, robust: +robust.toFixed(1), at: Date.now() } }));
}
// gen-0 newborn goes live immediately: the world shows the untrained wiggle
// tonight and every checkpoint after this visibly improves it.
if (!process.argv.includes("--warm")) deploy(0, 0);

// Score the center policy against a FIXED shove/goal seed every generation, so the
// number is comparable gen-to-gen. rep.centerFitness uses the per-gen training seed,
// which makes it swing with shove luck — saving on that picks a lucky-easy gen, not
// the genuinely most robust policy. This is the deploy criterion.
function robustnessScore(params: Float32Array): number {
  policy.setParams(params);
  let total = 0;
  for (let e = 0; e < SCALES.length; e++) {
    total += rollout(envs[e], policy, { maxSteps: EP_STEPS, seed: 100003 + e }).reward;
  }
  return total / SCALES.length;
}

const t0 = Date.now();
let bestCenter = -Infinity;
for (let g = 0; g < GENS; g++) {
  // Speed-aware CPG hard-wires cadence+stride to the command, so gaits already
  // separate — train the full range from the start (a short walk-first warmup helps balance).
  const gaitHi = g < 15 ? 0.45 : 0.85;
  for (const e of envs) e.setGaitRange(gaitHi);
  const rep = es.step(fitness);
  const line = { gen: rep.gen, mean: +rep.meanFitness.toFixed(2), best: +rep.bestFitness.toFixed(2), center: +rep.centerFitness.toFixed(2), sigma: +rep.sigma.toFixed(4) };
  writeFileSync(logPath, JSON.stringify(line) + "\n", { flag: "a" });

  const robust = robustnessScore(rep.center);
  const improved = robust > bestCenter;
  if (improved) bestCenter = robust;
  // Deploy on robustness improvement OR as a periodic checkpoint (if not a big
  // regression), so a plateaued robustness metric never FREEZES the deployed
  // policy while training keeps improving other qualities like gait tracking.
  if (improved || (rep.gen % 15 === 0 && robust >= 0.9 * bestCenter)) {
    policy.setParams(rep.center);
    deploy(rep.gen, robust);
  }

  if (rep.gen % RECORD_EVERY === 0 || g === GENS - 1) {
    policy.setParams(rep.center);
    const roll = rollout(recEnv, policy, { maxSteps: EP_STEPS, seed: 42, record: true, recordEvery: 2 });
    const rspec = recEnv.spec; // scaled dims so the viewer renders the recorded size
    const body = {
      torso: rspec.torso.half,
      legs: rspec.legs.map((l) => ({ hip: l.hip, thigh: [l.thigh.halfHeight, l.thigh.radius], shank: [l.shank.halfHeight, l.shank.radius] }))
    };
    writeFileSync(`rl/runs/${creatureName}_gen${rep.gen}.frames.json`, JSON.stringify({ creature: creatureName, gen: rep.gen, dt: recEnv.dt * 2, body, reward: +roll.reward.toFixed(1), frames: roll.frames }));
    // locomotion metrics: did it actually travel, and along the goal?
    const fr = roll.frames!;
    const a = fr[0].links[0].pos;
    const b = fr[fr.length - 1].links[0].pos;
    const dist = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const along = (b[0] - a[0]) * fr[0].goal[0] + (b[2] - a[2]) * fr[0].goal[1];
    let hSum = 0;
    for (const f of fr) hSum += f.links[0].pos[1];
    const meanH = hSum / fr.length;
    const hPct = ((meanH / rspec.standHeight) * 100) | 0; // scale-independent: % of standing height
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `gen ${rep.gen}  center=${line.center}  best=${line.best}  sigma=${line.sigma}  steps=${roll.steps}/${EP_STEPS}  dist=${dist.toFixed(2)}m  along=${along.toFixed(2)}m  meanH=${meanH.toFixed(2)}(${hPct}%)  [${secs}s]`
    );
  }
}
console.log(`[train] done in ${((Date.now() - t0) / 1000).toFixed(0)}s. best robustness score ${bestCenter.toFixed(1)}`);
console.log(`[train] policy -> ${OUT_PATH}`);
