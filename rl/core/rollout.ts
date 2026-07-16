/**
 * Run one episode: reset, then step the policy to termination or maxSteps,
 * summing reward. Optionally records link transforms for the training video.
 * Shared by the trainer, the recorder, and the exporter. Node-only.
 */
import type { Box3DEnv } from "./box3dEnv.ts";
import type { Policy } from "../../src/creatures/policy.ts";
import { rng32 } from "./es.ts";
import type { V3 } from "../../src/creatures/quadruped.ts";

export type Frame = { t: number; goal: [number, number]; links: { pos: V3; quat: [number, number, number, number] }[]; hidden?: number[] };
export type RolloutResult = { reward: number; steps: number; frames: Frame[] | null };

export function rollout(
  env: Box3DEnv,
  policy: Policy,
  opts: { maxSteps: number; seed: number; record?: boolean; recordEvery?: number }
): RolloutResult {
  const rng = rng32(opts.seed);
  let obs = env.reset(rng);
  let total = 0;
  let steps = 0;
  const frames: Frame[] | null = opts.record ? [] : null;
  const every = opts.recordEvery ?? 2;
  for (let s = 0; s < opts.maxSteps; s++) {
    const { action, hidden } = policy.forward(obs);
    const res = env.step(action);
    total += res.reward;
    obs = res.obs;
    steps++;
    if (frames && s % every === 0) {
      frames.push({ t: s * env.dt, goal: [env.state.goal[0], env.state.goal[1]], links: env.snapshot(), hidden: Array.from(hidden) });
    }
    if (res.done) break;
  }
  return { reward: total, steps, frames };
}
