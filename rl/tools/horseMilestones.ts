/**
 * Milestone gate for the Wild Ones horses — runs the CURRENT deployed policy
 * through three scripted trials on the ACTUAL in-world runtime class
 * (CreatureRagdoll, same physics the paddock steps), and latches results into
 * public/models/horse_milestones.json. The paddock polls that file and dresses
 * the horses with their earned accessories:
 *
 *   walk   — 5 s commanded walk, never falls            -> saddle
 *   gallop — 5 s commanded gallop, fast + never falls   -> plumed headpiece
 *   jump   — hop from a walk, airborne, lands upright   -> golden wreath
 *
 *   node --experimental-strip-types rl/tools/horseMilestones.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createBox3D } from "../../src/core/box3dWorld.ts";
import { HORSE } from "../../src/creatures/quadruped.ts";
import { CreatureRagdoll } from "../../src/gameplay/pup/creatureRagdoll.ts";

const POLICY_PATH = "public/models/horse_policy.json";
const OUT_PATH = "public/models/horse_milestones.json";
const DT = 1 / 60;

type Trial = { ok: boolean; detail: string };

function scaleForGen(gen: number): number {
  return 1.0 + 1.1 * Math.min(1, gen / 400); // mirrors the paddock's growth curve
}

function run(rag: CreatureRagdoll, seconds: number, each?: (t: number) => void): { fell: boolean; meanSpeed: number; maxY: number } {
  let fell = false;
  let speedSum = 0;
  let n = 0;
  let maxY = -Infinity;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    each?.(i * DT);
    rag.update(DT);
    const t = rag.torsoLink;
    if (rag.fallen) fell = true;
    speedSum += Math.hypot(t.vel[0], t.vel[2]);
    maxY = Math.max(maxY, t.pos[1]);
    n++;
  }
  return { fell, meanSpeed: speedSum / n, maxY };
}

const def = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
const gen: number = def.meta?.gen ?? 0;
const scale = scaleForGen(gen);
const box3d = await createBox3D();

function freshRag(): CreatureRagdoll {
  const rag = new CreatureRagdoll(box3d, HORSE, def, scale);
  rag.setGoal(0, 1);
  return rag;
}

// -------- trial 1: WALK — 5 s at a calm commanded walk, never fall
const walkRag = freshRag();
walkRag.setSpeed(0.25);
const walk = run(walkRag, 5);
const V = walkRag.speedUnit;
const walkTrial: Trial = { ok: !walk.fell, detail: `fell=${walk.fell} meanSpeed=${walk.meanSpeed.toFixed(2)}m/s` };
walkRag.dispose();

// -------- trial 2: GALLOP — 5 s at a committed gallop command: stay up AND move fast
const galRag = freshRag();
galRag.setSpeed(0.8);
const gal = run(galRag, 5);
const galFast = gal.meanSpeed >= 0.42 * V; // genuinely covering ground, not shuffling
const gallopTrial: Trial = { ok: !gal.fell && galFast, detail: `fell=${gal.fell} meanSpeed=${gal.meanSpeed.toFixed(2)}m/s need>=${(0.42 * V).toFixed(2)}` };
galRag.dispose();

// -------- trial 3: JUMP — canter in FAST (like running at a rail), hop, get
// airborne, stick the landing and keep going. The fast approach makes the
// landing genuinely hard, so this unlocks after the gallop, not before.
const jmpRag = freshRag();
jmpRag.setSpeed(0.7);
const approach = run(jmpRag, 2);
jmpRag.jump();
const air = run(jmpRag, 2.5);
const airborne = air.maxY > jmpRag.standY * 1.22;
const landedTall = !jmpRag.fallen && jmpRag.torsoLink.pos[1] > jmpRag.standY * 0.65;
const jumpTrial: Trial = {
  ok: !approach.fell && airborne && !air.fell && landedTall,
  detail: `approachFell=${approach.fell} airborne=${airborne} fell=${air.fell} endTall=${(jmpRag.torsoLink.pos[1] / jmpRag.standY).toFixed(2)}`
};
jmpRag.dispose();

// -------- latch into the milestones file (earned once = earned forever)
type Milestone = { ok: boolean; gen?: number; at?: string; detail?: string };
let prev: Record<string, Milestone> = {};
if (existsSync(OUT_PATH)) {
  try { prev = JSON.parse(readFileSync(OUT_PATH, "utf8")); } catch {}
}
const latch = (key: string, trial: Trial): Milestone => {
  const old = prev[key];
  if (old?.ok) return old; // keep first-earned gen
  return trial.ok ? { ok: true, gen, at: new Date().toISOString(), detail: trial.detail } : { ok: false, detail: trial.detail };
};
const out = {
  walk: latch("walk", walkTrial),
  gallop: latch("gallop", gallopTrial),
  jump: latch("jump", jumpTrial),
  gen,
  scale: +scale.toFixed(3),
  at: new Date().toISOString()
};
writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`[milestones] gen=${gen} scale=${scale.toFixed(2)}`);
console.log(`  walk:   ${out.walk.ok ? "EARNED" : "not yet"} (${walkTrial.detail})`);
console.log(`  gallop: ${out.gallop.ok ? "EARNED" : "not yet"} (${gallopTrial.detail})`);
console.log(`  jump:   ${out.jump.ok ? "EARNED" : "not yet"} (${jumpTrial.detail})`);
