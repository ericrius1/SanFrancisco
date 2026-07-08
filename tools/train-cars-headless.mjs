// Overnight headless trainer for the continual-learning AI cars.
//
// Pure Node (no browser / GPU / network) so it survives running for many hours.
// It runs the SAME learner.ts + fleet.ts + roadGraph.ts the game uses, on the
// real SF road graph with a clear-everywhere physics stub, accelerated far past
// real time. Every CHECKPOINT_MS it atomically writes the full 48-car brain set
// to a checkpoint file and logs fleet skill so progress is observable, and it
// resumes from that checkpoint on restart. `push-brains-to-prod.mjs` ships the
// checkpoint to the live relay.
//
// Run: node --experimental-strip-types tools/train-cars-headless.mjs
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as THREE from "three/webgpu";
import { RoadGraph } from "../src/gameplay/aiCars/roadGraph.ts";
import { Fleet, MAX_CARS } from "../src/gameplay/aiCars/fleet.ts";
import { Learner } from "../src/gameplay/aiCars/learner.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CKPT = process.env.SF_CKPT || path.join(ROOT, "tools", "aicars-trained.json");
const CHECKPOINT_MS = 60_000;
const DT = 1 / 60;
const BATCH = 4000;              // sim substeps per event-loop tick (then yield)
const ANCHORS = [new THREE.Vector3(1500, 0, -300)]; // Mission grid — road-dense, all cars NEAR

// ---- clear-everywhere world stub (brains learn road-following; the live client
//      re-teaches building avoidance against real colliders) ----
const world = {
  ground: () => 0,
  isWater: () => false,
  sweep: () => null,
  createBody: () => 1,
  moveBody: () => {},
  removeBody: () => {}
};

const roads = new RoadGraph(JSON.parse(readFileSync(path.join(ROOT, "public/data/roads.json"), "utf8")));
const learner = new Learner(MAX_CARS);
const fleet = new Fleet(world, roads, learner);

// resume
let resumed = 0;
if (existsSync(CKPT)) {
  try {
    const blob = JSON.parse(readFileSync(CKPT, "utf8"));
    if (fleet.importState(blob)) resumed = blob.cars?.length ?? 0;
  } catch (e) { console.warn("[trainer] checkpoint load failed, fresh start:", e.message); }
}
// ensure fleet is initialized even with no checkpoint (first prePhysics does #placeAll)
fleet.prePhysics(DT, ANCHORS);
console.log(`[trainer] start — ${MAX_CARS} cars${resumed ? `, resumed ${resumed} from checkpoint` : " (fresh)"}`);

let simSteps = 0;
const t0 = Date.now();

function stats() {
  const skills = [];
  for (let i = 0; i < MAX_CARS; i++) skills.push(learner.skill(i));
  skills.sort((a, b) => a - b);
  const median = skills[skills.length >> 1];
  const best = skills[skills.length - 1];
  const st = fleet.exportState();
  let km = 0, age = 0, nan = 0;
  for (const c of st.cars) {
    km += c.odoM;
    if (c.ageS > age) age = c.ageS;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.rhoBar)) nan++;
  }
  return { median, best, km: km / 1000, ageH: age / 3600, nan, st };
}

function checkpoint() {
  const s = stats();
  try {
    const tmp = CKPT + ".tmp";
    writeFileSync(tmp, JSON.stringify(s.st));
    renameSync(tmp, CKPT);
  } catch (e) { console.warn("[trainer] checkpoint write failed:", e.message); }
  const realMin = (Date.now() - t0) / 60000;
  console.log(
    `[trainer] +${realMin.toFixed(1)}min real | sim ${(simSteps * DT / 3600).toFixed(1)}h | ` +
    `skill med ${s.median.toFixed(1)} best ${s.best.toFixed(1)} | ${s.km.toFixed(0)} km | ` +
    `eldest ${s.ageH.toFixed(1)}h${s.nan ? ` | ⚠ ${s.nan} NaN` : ""}`
  );
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  if (stopping) process.exit(0);
  stopping = true;
  console.log(`[trainer] ${sig} — final checkpoint`);
  checkpoint();
  process.exit(0);
});

setInterval(checkpoint, CHECKPOINT_MS);

// accelerated run loop — batch of substeps, then yield so timers/signals fire
function tick() {
  if (stopping) return;
  try {
    for (let i = 0; i < BATCH; i++) { fleet.prePhysics(DT, ANCHORS); simSteps++; }
  } catch (e) {
    console.error("[trainer] step error (continuing):", e.message);
  }
  setImmediate(tick);
}
tick();
