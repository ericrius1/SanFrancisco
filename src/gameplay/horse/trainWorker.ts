/// <reference lib="webworker" />
/**
 * Live in-browser trainer. Runs Evolution Strategies against box3d headless in a
 * Web Worker — the SAME rl/ code the Node CLI uses — and streams the improving
 * policy back to the main thread each generation, so the herd can hot-swap it
 * and you watch the creatures learn in the patch. Creature-agnostic (spec by
 * name), so this is the seed for training different creatures across the city.
 */
import { createBox3D } from "box3d-wasm";
import { HORSE, DOG, obsDim, actDim, type CreatureSpec } from "../../creatures/quadruped.ts";
import { Policy, paramCount, type PolicyDef } from "../../creatures/policy.ts";
import { Box3DEnv } from "../../../rl/core/box3dEnv.ts";
import { ES, rng32 } from "../../../rl/core/es.ts";
import { rollout } from "../../../rl/core/rollout.ts";

const SPECS: Record<string, CreatureSpec> = { horse: HORSE, dog: DOG };
let running = false;

type Msg = { type: string; creature?: string; pairs?: number; steps?: number; init?: PolicyDef };

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as Msg;
  if (msg.type === "stop") { running = false; return; }
  if (msg.type !== "start" || running) return;
  running = true;

  const spec = SPECS[msg.creature ?? "horse"] ?? HORSE;
  const sizes = [obsDim(spec), 32, 32, actDim(spec)];
  const dim = paramCount(sizes);
  const box3d = await createBox3D();
  const env = new Box3DEnv(box3d, spec);
  const policy = Policy.random(sizes, rng32(1), spec.name);
  if (msg.init && msg.init.weights?.length === dim) policy.setParams(Float32Array.from(msg.init.weights));

  const es = new ES({ dim, pairs: msg.pairs ?? 40, sigma: 0.08, lr: 0.03, weightDecay: 0.002, sigmaDecay: 0.997, seed: 2, init: policy.getParams() });
  const EP = msg.steps ?? 380;
  const fitness = (params: Float32Array, tag: { gen: number }) => {
    policy.setParams(params);
    let tot = 0;
    for (let e2 = 0; e2 < 2; e2++) tot += rollout(env, policy, { maxSteps: EP, seed: 7919 * (tag.gen + 1) + e2 }).reward;
    return tot / 2;
  };

  let best = -Infinity;
  let bestDef: PolicyDef = policy.toDef();
  while (running) {
    const rep = es.step(fitness);
    if (rep.centerFitness > best) {
      best = rep.centerFitness;
      policy.setParams(rep.center);
      bestDef = policy.toDef();
    }
    (self as unknown as Worker).postMessage({ type: "progress", gen: rep.gen, fitness: +rep.centerFitness.toFixed(0), best: +best.toFixed(0), policy: bestDef });
    await new Promise((r) => setTimeout(r, 0)); // let a 'stop' message land between gens
  }
};
