/**
 * RICH gait-quality evaluator — the "look at the results" the old gaitTest lacked.
 * gaitTest only asked "upright + moving?", so a stable WEAK SHUFFLE passed. This
 * scores what actually makes a gait look right: forward speed, STRIDE reach (hip
 * fore-aft swing), BOUNDING (torso vertical oscillation — a gallop has flight),
 * upright TIGHTNESS (not just mean), fall rate, and turn stability. Emits a
 * composite gait score (0-100) + a per-gait breakdown, and a machine-readable
 * SCORE:<json> line the outer search loop parses.
 *
 *   POLICY=public/models/horse_policy.json node --experimental-strip-types rl/tools/evalGait.ts
 */
import { createBox3D } from "box3d-wasm";
import { readFileSync } from "node:fs";
import { HorseRagdoll } from "../core/nodeRagdoll.ts";
import { HORSE, qRot, qRotInv } from "../../src/creatures/quadruped.ts";
import { type PolicyDef } from "../../src/creatures/policy.ts";

const POLICY = process.env.POLICY ?? "public/models/horse_policy.json";
const SCALE = Number(process.env.SCALE ?? 2.3);
const def = JSON.parse(readFileSync(POLICY, "utf8")) as PolicyDef;
const box3d = await createBox3D();
const upY = (q: readonly number[]) => 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
const dt = 1 / 60;

// fore-aft swing angle of a leg's thigh in the torso frame (0 = straight down)
function thighSwing(torsoQ: readonly number[], thighQ: readonly number[]): number {
  const dw = qRot(thighQ as any, [0, -1, 0]);
  const dt2 = qRotInv(torsoQ as any, dw);
  return Math.atan2(dt2[2], -dt2[1]);
}

type GaitMetrics = {
  name: string; cmd: number; speedND: number; strideAmp: number; boundAmp: number;
  cleanFrac: number; fell: boolean; q: number;
};

function runGait(name: string, cmd: number, turn: boolean): GaitMetrics {
  const rag = new HorseRagdoll(box3d, HORSE, def, SCALE);
  const unit = rag.speedUnit;
  const standY = rag.standY;
  rag.setSpeed(cmd);
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let goalYaw = 0, gx = 0, gz = 1;
  let fell = false, spdSum = 0, cleanN = 0, n = 0;
  let swingMin = 9, swingMax = -9, yMin = 9, yMax = -9;
  for (let i = 0; i < 840; i++) { // 14s
    const period = turn ? 90 : 150;
    if (i > 0 && i % period === 0) goalYaw += (rand() - 0.5) * (turn ? 2.6 : 1.6);
    const tx = Math.sin(goalYaw), tz = Math.cos(goalYaw), k = 1 - Math.exp(-dt / 0.45);
    gx += (tx - gx) * k; gz += (tz - gz) * k;
    rag.setGoal(gx, gz);
    rag.setSpeed(cmd);
    rag.update(dt);
    const t = rag.torsoLink;
    if (i >= 150) { // after it settles into the gait
      const up = upY(t.quat);
      if (up < 0.35) fell = true;
      if (up > 0.9) cleanN++;
      const nose = qRot(t.quat, [0, 0, 1]);
      spdSum += (t.vel[0] * nose[0] + t.vel[2] * nose[2]) / unit;
      // stride reach: front-left thigh fore-aft swing extremes
      const sw = thighSwing(t.quat, rag.legLinks[0].thigh.quat);
      if (sw < swingMin) swingMin = sw;
      if (sw > swingMax) swingMax = sw;
      // bounding: torso height oscillation
      const yn = t.pos[1] / standY;
      if (yn < yMin) yMin = yn;
      if (yn > yMax) yMax = yn;
      n++;
    }
  }
  const speedND = spdSum / n;
  const strideAmp = swingMax - swingMin; // rad peak-to-peak
  const boundAmp = yMax - yMin; // fraction of standing height
  const cleanFrac = cleanN / n;

  // per-gait quality (0..1)
  let q = 0;
  const notFell = fell ? 0.25 : 1;
  if (cmd < 0.35) {
    // WALK: slow + very clean + calm (little bound)
    const speedScore = 1 - Math.min(1, Math.abs(speedND - 0.22) / 0.25);
    const calm = 1 - Math.min(1, boundAmp / 0.35);
    q = notFell * (0.35 * speedScore + 0.45 * cleanFrac + 0.2 * calm);
  } else if (cmd < 0.65) {
    // TROT: mid speed, clean, moderate stride
    const speedScore = 1 - Math.min(1, Math.abs(speedND - 0.5) / 0.35);
    const strideScore = Math.min(1, strideAmp / 0.8);
    q = notFell * (0.4 * speedScore + 0.35 * cleanFrac + 0.25 * strideScore);
  } else {
    // GALLOP: FAST + big stride + some bound, mostly upright (dips allowed)
    const speedScore = Math.min(1, speedND / 0.7);
    const strideScore = Math.min(1, strideAmp / 1.0);
    const boundScore = Math.min(1, boundAmp / 0.22);
    q = notFell * (0.42 * speedScore + 0.24 * strideScore + 0.14 * boundScore + 0.2 * cleanFrac);
  }
  return { name, cmd, speedND, strideAmp, boundAmp, cleanFrac, fell, q };
}

const results = [
  runGait("walk", 0.25, false),
  runGait("trot", 0.5, false),
  runGait("gallop", 0.8, false),
  runGait("turn", 0.55, true) // sharp-turn stability probe
];

for (const r of results) {
  console.log(
    `${r.name.padEnd(7)} cmd ${r.cmd.toFixed(2)}  speed ${r.speedND.toFixed(2)}  stride ${r.strideAmp.toFixed(2)}  bound ${r.boundAmp.toFixed(2)}  clean ${(r.cleanFrac * 100 | 0)}%  fell ${r.fell}  q ${r.q.toFixed(2)}`
  );
}
const [walk, trot, gallop, turn] = results;
const turnStable = turn.fell ? 0 : turn.cleanFrac;
// gallop weighted heaviest (the gap); turn stability gates the whole thing
const score = 100 * (0.28 * walk.q + 0.17 * trot.q + 0.45 * gallop.q + 0.1 * turnStable);
console.log(`\nGAIT SCORE ${score.toFixed(1)} / 100   (walk ${(walk.q * 100 | 0)} trot ${(trot.q * 100 | 0)} gallop ${(gallop.q * 100 | 0)} turnStable ${(turnStable * 100 | 0)})`);
console.log(`SCORE:${JSON.stringify({ score: +score.toFixed(1), walk, trot, gallop, turnStable: +turnStable.toFixed(2) })}`);
