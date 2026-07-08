/**
 * THE DEPLOY GATE. Runs the ACTUAL in-world runtime (src/gameplay/horse/
 * horseRagdoll.ts — the exact code the game renders) headlessly in Node and
 * asserts the horse stays TALL + UPRIGHT while moving, the way the game drives
 * it (sustained forward, a turn, more forward). Uprightness/height is box3d
 * physics, not rendering, so this is verifiable without WebGPU — the check I
 * should have been running all along. Deploy only if this prints PASS.
 *
 *   node --experimental-strip-types rl/tools/runtimeTest.ts
 */
import { createBox3D } from "box3d-wasm";
import { readFileSync } from "node:fs";
import { HorseRagdoll } from "../core/nodeRagdoll.ts";
import { HORSE, qRot } from "../../src/creatures/quadruped.ts";
import { type PolicyDef } from "../../src/creatures/policy.ts";

const def = JSON.parse(readFileSync("public/models/horse_policy.json", "utf8")) as PolicyDef;
const box3d = await createBox3D();
const rag = new HorseRagdoll(box3d, HORSE, def, 2.3); // the in-world horse size
const standY = rag.standY;
const upY = (q: readonly number[]) => 1 - 2 * (q[0] * q[0] + q[2] * q[2]);

// Seeded PRNG so the gate is reproducible run-to-run.
let seed = 20260705;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// Drive it the way the HERD actually does: SHARP yaw-wander (sudden heading
// changes, not a gentle arc) plus periodic sideways SHOVES to test recovery.
// Those are what make in-world horses stumble; a gentle-arc gate missed them.
const dt = 1 / 60;
let tallSum = 0;
let tallN = 0;
let worstUp = 1;
let noseSum = 0;
let noseN = 0;
let start: [number, number] | null = null;
let end: [number, number] = [0, 0];
let goalYaw = 0;
let gx = 0, gz = 1; // eased goal dir — mirrors the herd's GOAL_EASE smoothing in-world
let fell = false; // did it ever truly tip over (not just dip)?
let lastShove = -999;
let shoves = 0;
for (let i = 0; i < 720; i++) {
  if (i > 0 && i % 130 === 0) goalYaw += (rand() - 0.5) * 2.6; // wander turn (eased below, like the herd)
  const tx = Math.sin(goalYaw), tz = Math.cos(goalYaw);
  const k = 1 - Math.exp(-dt / 0.45); // GOAL_EASE, matches horseHerd
  gx += (tx - gx) * k; gz += (tz - gz) * k;
  rag.setGoal(gx, gz);
  if (!process.env.NOSHOVE && i >= 150 && (i - 150) % 170 === 0) {
    const a = rand() * Math.PI * 2; // shove sideways at 1.4 m/s (training envelope) — must recover, not fall
    rag.shove(Math.cos(a) * 1.4, Math.sin(a) * 1.4);
    lastShove = i;
    shoves++;
  }
  rag.update(dt);
  const t = rag.torsoLink;
  if (i === 60) start = [t.pos[0], t.pos[2]];
  if (i >= 90) {
    if (upY(t.quat) < 0.35) fell = true; // a real tip-over (69°+ off vertical)
    // A galloping horse BOUNDS — height oscillates every stride — so judge MEAN
    // height, not instantaneous worst (which just catches stride compression).
    tallSum += t.pos[1];
    tallN++;
    // worstUp for the "did it nearly tip" check, outside the post-shove recovery window
    if (i - lastShove > 30) worstUp = Math.min(worstUp, upY(t.quat));
    const nose = qRot(t.quat, [0, 0, 1]); // is it moving NOSE-FIRST (forward) not backward?
    noseSum += t.vel[0] * nose[0] + t.vel[2] * nose[2];
    noseN++;
  }
  end = [t.pos[0], t.pos[2]];
  if (i % 60 === 0) console.log(`t=${(i / 60).toFixed(1)}s torsoY=${t.pos[1].toFixed(3)} (${((t.pos[1] / standY) * 100) | 0}% of stand) up=${upY(t.quat).toFixed(3)}`);
}
const moved = start ? Math.hypot(end[0] - start[0], end[1] - start[1]) : 0;
const noseSpeed = noseSum / Math.max(1, noseN);
const meanTall = tallSum / Math.max(1, tallN);
const tallPct = (meanTall / standY) * 100;
console.log(`\nstandY ${standY.toFixed(2)}m  MEAN torsoY ${meanTall.toFixed(2)}m (${tallPct | 0}% of stand)  WORST up ${worstUp.toFixed(2)}  moved ${moved.toFixed(1)}m  noseSpeed ${noseSpeed.toFixed(2)} m/s  shoves=${shoves} everTippedOver=${fell}`);
const tallOK = meanTall > 0.80 * standY; // averages out gallop stride-compression
const upOK = worstUp > 0.55; // horses lean into turns/strides; only flag a near-tip
const moveOK = moved > 3;
const fwdOK = noseSpeed > 0.3; // moving NOSE-FIRST, not backward
const stoodOK = !fell; // never tipped over (the actual "falls over" failure)
console.log(tallOK && upOK && moveOK && fwdOK && stoodOK ? "PASS — runs tall + upright NOSE-FIRST and never tips over (recovers shoves + sharp turns)" : `FAIL — tall=${tallOK} up=${upOK} move=${moveOK} forward=${fwdOK} neverFell=${stoodOK} (noseSpeed ${noseSpeed.toFixed(2)})`);
