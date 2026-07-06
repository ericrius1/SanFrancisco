// RECURSIVE gait search — an evolutionary loop OVER training configs, with ES
// policy-training as the inner loop and evalGait as the fitness. Each round:
// train a population of gait-tuning configs (warm from the good baseline, in
// parallel), score each with the rich evaluator, keep the elites, mutate them
// into the next round. Runs autonomously for many rounds; logs a leaderboard and
// keeps best.cfg.json / best.policy.json. The deployed policy is NOT touched until
// a human/loop deploys the winner.
//
//   GENS=70 POP=6 PARALLEL=4 ROUNDS=8 node rl/meta/search.mjs
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync, appendFileSync } from "node:fs";

const ROOT = process.cwd();
const DIR = "rl/runs/search";
mkdirSync(DIR, { recursive: true });

const GENS = Number(process.env.GENS ?? 70);
const PAIRS = Number(process.env.PAIRS ?? 48);
const STEPS = Number(process.env.STEPS ?? 440);
const PARALLEL = Number(process.env.PARALLEL ?? 4);
const POP = Number(process.env.POP ?? 6);
const ROUNDS = Number(process.env.ROUNDS ?? 8);
const ELITES = Number(process.env.ELITES ?? 2);
const WARM = process.env.WARM ?? "public/models/horse_policy.good.json";

// search space [min, max] per gait-tuning knob
const SPACE = {
  freqBase: [0.6, 0.95], freqSpan: [0.2, 0.9],
  strideBase: [0.5, 0.9], strideSpan: [0.8, 2.2],
  actFreqAuth: [0.25, 0.8], actStrideAuth: [0.25, 0.9], actKneeAuth: [0.4, 1.0],
  speedMatchA: [4, 14], progressW: [0.3, 1.1],
  tallFloorSlope: [0.05, 0.28], doneFloorSlope: [0.05, 0.24], uprightSoften: [0.15, 0.6],
  maxTorqueScale: [0.85, 1.7], gallopBlend: [0, 1]
};
const KEYS = Object.keys(SPACE);
const DEFAULT = { freqBase: 0.78, freqSpan: 0.5, strideBase: 0.68, strideSpan: 1.05, actFreqAuth: 0.5, actStrideAuth: 0.5, actKneeAuth: 0.7, speedMatchA: 10, progressW: 0.55, tallFloorSlope: 0.13, doneFloorSlope: 0.12, uprightSoften: 0.4, maxTorqueScale: 1.0, gallopBlend: 0 };

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
const lerp = ([lo, hi], t) => lo + (hi - lo) * t;
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clampCfg = (c) => { const o = {}; for (const k of KEYS) o[k] = +clamp(c[k] ?? DEFAULT[k], SPACE[k]).toFixed(4); return o; };
const mutate = (base, sigma) => { const c = {}; for (const k of KEYS) c[k] = base[k] + randn() * sigma * (SPACE[k][1] - SPACE[k][0]); return clampCfg(c); };
const randCfg = () => { const c = {}; for (const k of KEYS) c[k] = lerp(SPACE[k], Math.random()); return clampCfg(c); };

function run(cmd, args, env) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", () => res(out));
  });
}

async function trainEval(cfg, tag) {
  const cfgPath = `${DIR}/${tag}.cfg.json`, outPath = `${DIR}/${tag}.policy.json`;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  await run("node", ["--experimental-strip-types", "rl/train.ts", "--creature", "horse", "--warm", "--gens", String(GENS), "--pairs", String(PAIRS), "--steps", String(STEPS), "--sigma", "0.1", "--recordEvery", "99999"], { CONFIG: cfgPath, OUT: outPath, WARM });
  if (!existsSync(outPath)) return { cfg, score: -1, tag };
  const ev = await run("node", ["--experimental-strip-types", "rl/tools/evalGait.ts"], { POLICY: outPath });
  const m = ev.split("\n").find((l) => l.startsWith("SCORE:"));
  let score = -1, detail = null;
  if (m) { try { detail = JSON.parse(m.slice(6)); score = detail.score; } catch {} }
  return { cfg, score, detail, tag, outPath };
}

async function pool(items, fn, k) {
  const res = [];
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, worker));
  return res;
}

const LOG = `${DIR}/leaderboard.log`;
const log = (s) => { console.log(s); appendFileSync(LOG, s + "\n"); };

const SEEDS = (process.env.SEED ?? "").split(",").filter(Boolean).map((p) => { try { return clampCfg(JSON.parse(readFileSync(p, "utf8"))); } catch { return null; } }).filter(Boolean);
// seed the population around the fast-gallop config (SEEDS[0]) so the search
// refines it (fix its walk) instead of rediscovering it from scratch.
let pop = [clampCfg(DEFAULT), ...SEEDS, ...Array.from({ length: Math.max(0, POP - 2 - SEEDS.length) }, () => mutate(SEEDS[0] ?? DEFAULT, 0.2)), randCfg()].slice(0, POP);
let best = null;
for (let round = 0; round < ROUNDS; round++) {
  log(`\n=== ROUND ${round}  (pop ${pop.length}, ${GENS} gens each, ${PARALLEL} parallel) ===`);
  const scored = await pool(pop, (c, i) => trainEval(c, `r${round}_${i}`), PARALLEL);
  scored.sort((a, b) => b.score - a.score);
  for (const s of scored) {
    const d = s.detail;
    log(`  ${s.score.toFixed(1).padStart(5)}  ${d ? `gallop[q${(d.gallop.q * 100 | 0)} spd${d.gallop.speedND.toFixed(2)} str${d.gallop.strideAmp.toFixed(2)} bnd${d.gallop.boundAmp.toFixed(2)}] walk[q${(d.walk.q * 100 | 0)} spd${d.walk.speedND.toFixed(2)}] turn${(d.turnStable * 100 | 0)}` : "(failed)"}`);
  }
  if (best === null || scored[0].score > best.score) {
    best = scored[0];
    writeFileSync(`${DIR}/best.cfg.json`, JSON.stringify(best.cfg, null, 1));
    if (best.outPath && existsSync(best.outPath)) copyFileSync(best.outPath, `${DIR}/best.policy.json`);
    log(`  ** NEW BEST ${best.score.toFixed(1)}  ${JSON.stringify(best.cfg)}`);
  }
  const valid = scored.filter((s) => s.score > 0);
  const elites = valid.slice(0, ELITES).map((s) => s.cfg);
  // PRESERVE the gallop specialist (best gallop quality) even if its total is low —
  // the composite score otherwise buries the fast-gallop lineage every round.
  const bestGallop = [...valid].sort((a, b) => (b.detail?.gallop?.q ?? 0) - (a.detail?.gallop?.q ?? 0))[0];
  if (bestGallop && !elites.some((e) => e === bestGallop.cfg)) {
    elites.push(bestGallop.cfg);
    log(`  (keep gallop specialist: gallopQ ${(bestGallop.detail.gallop.q * 100 | 0)} spd ${bestGallop.detail.gallop.speedND.toFixed(2)})`);
  }
  if (elites.length === 0) elites.push(clampCfg(DEFAULT));
  const sigma = 0.18 * Math.pow(0.85, round); // anneal mutation
  pop = [...elites, ...Array.from({ length: Math.max(0, POP - elites.length - 1) }, () => mutate(elites[Math.floor(Math.random() * elites.length)], sigma)), randCfg()].slice(0, POP);
}
log(`\nBEST ${best.score.toFixed(1)}  ${JSON.stringify(best.cfg)}`);
log(`to deploy: cp ${DIR}/best.policy.json public/models/horse_policy.json`);
