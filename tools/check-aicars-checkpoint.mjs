// Audit the saved AI-car training checkpoint against the current SF road graph.
//
// Usage:
//   node --experimental-strip-types tools/check-aicars-checkpoint.mjs
//   node --experimental-strip-types tools/check-aicars-checkpoint.mjs --checkpoint tools/aicars-trained-v3.json --log /tmp/sf-aicars/trainer.log

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RoadGraph } from "../src/gameplay/aiCars/roadGraph.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function argNumber(name, fallback) {
  const raw = argValue(name, null);
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const checkpointPath = path.resolve(ROOT, argValue("--checkpoint", "tools/aicars-trained-v3.json"));
const roadsPath = path.resolve(ROOT, argValue("--roads", "public/data/roads.json"));
const surfacePath = path.resolve(ROOT, argValue("--surface", "public/data/surface.bin"));
const metaPath = path.resolve(ROOT, argValue("--meta", "public/data/meta.json"));
const logPath = argValue("--log", "/tmp/sf-aicars/trainer.log");

const maxMeanLaneError = argNumber("--max-mean-lane", 0.75);
const maxLaneError = argNumber("--max-lane", 2.0);
const maxCarCollisions = argNumber("--max-car-collisions", 50);

const roads = new RoadGraph(JSON.parse(readFileSync(roadsPath, "utf8")));
const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const surface = readFileSync(surfacePath);
const { cellSize, width: W, height: H, minX, minZ } = meta.grid;

function isWater(x, z) {
  const ix = Math.min(Math.max(Math.round((x - minX) / cellSize), 0), W - 1);
  const iy = Math.min(Math.max(Math.round((z - minZ) / cellSize), 0), H - 1);
  return surface[iy * W + ix] === 3;
}

function laneCenterFor(proj, dir) {
  const lanes =
    proj.oneWayDir !== 0
      ? Math.max(1, proj.oneWayDir === 1 ? proj.forwardLanes || proj.lanes : proj.backwardLanes || proj.lanes)
      : Math.max(1, dir === 1 ? proj.forwardLanes || Math.ceil(proj.lanes / 2) : proj.backwardLanes || Math.floor(proj.lanes / 2));
  const laneW = (proj.oneWayDir !== 0 ? proj.halfWidth * 2 : proj.halfWidth) / lanes;
  return -dir * (proj.halfWidth - laneW * 0.5);
}

function latestTrainerStats(file) {
  if (!file || !existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).reverse();
  const line = lines.find((l) => l.includes("[trainer] +") && l.includes(" coll "));
  if (!line) return null;
  const rx =
    /sim ([\d.]+)h .*? coll (\d+) bld (\d+) car (\d+) water (\d+) clamp (\d+) red (\d+) wrong (\d+) lane ([\d.]+)/;
  const m = line.match(rx);
  if (!m) return { line };
  return {
    line,
    simH: Number(m[1]),
    collisions: Number(m[2]),
    buildingCollisions: Number(m[3]),
    carCollisions: Number(m[4]),
    waterHits: Number(m[5]),
    roadClamps: Number(m[6]),
    redLightViolations: Number(m[7]),
    wrongWaySteps: Number(m[8]),
    meanLaneErrorLogged: Number(m[9])
  };
}

const failures = [];
const warnings = [];
const details = [];
let wet = 0;
let noProj = 0;
let offEdge = 0;
let wrong = 0;
let stopLineNonGreen = 0;
let laneSum = 0;
let laneMax = 0;
const sampleTime = Math.max(0, ...checkpoint.cars.map((c) => Number(c.ageS) || 0));

for (const car of checkpoint.cars ?? []) {
  const proj = roads.project(car.x, car.z);
  if (isWater(car.x, car.z)) {
    wet++;
    details.push({ id: car.id, type: "water", x: round(car.x), z: round(car.z) });
  }
  if (!proj) {
    noProj++;
    details.push({ id: car.id, type: "no-road-projection", x: round(car.x), z: round(car.z) });
    continue;
  }
  if (Math.abs(proj.lateral) > proj.halfWidth * 0.92) {
    offEdge++;
    details.push({ id: car.id, type: "off-edge", lateral: round(proj.lateral), halfWidth: round(proj.halfWidth) });
  }
  const dir =
    proj.oneWayDir ||
    ((Math.sin(car.heading) * proj.tangentX + Math.cos(car.heading) * proj.tangentZ) >= 0 ? 1 : -1);
  const dot = Math.sin(car.heading) * proj.tangentX * dir + Math.cos(car.heading) * proj.tangentZ * dir;
  if (proj.oneWayDir && dot < -0.15) {
    wrong++;
    details.push({ id: car.id, type: "wrong-way", dot: round(dot), segId: proj.segId });
  }
  const laneErr = Math.abs((proj.lateral - laneCenterFor(proj, dir)) / Math.max(2, proj.halfWidth));
  laneSum += laneErr;
  laneMax = Math.max(laneMax, laneErr);
  const signal = roads.signals.query(proj.segId, proj.s, dir, sampleTime, 4.5);
  if (signal.hasSignal && signal.stopRequired && signal.distance < 1.6) {
    stopLineNonGreen++;
    details.push({ id: car.id, type: "at-non-green-stop-line", state: signal.state, distance: round(signal.distance) });
  }
}

let closePairs = 0;
for (let i = 0; i < checkpoint.cars.length; i++) {
  for (let j = i + 1; j < checkpoint.cars.length; j++) {
    const a = checkpoint.cars[i];
    const b = checkpoint.cars[j];
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 3.85) {
      closePairs++;
      details.push({ type: "close-pair", a: a.id, b: b.id, distance: round(d) });
    }
  }
}

const meanLaneError = checkpoint.cars.length ? laneSum / checkpoint.cars.length : 0;
const trainer = latestTrainerStats(logPath);

if (wet) failures.push(`${wet} checkpoint cars are in water`);
if (noProj) failures.push(`${noProj} checkpoint cars have no road projection`);
if (offEdge) failures.push(`${offEdge} checkpoint cars are outside the road edge tolerance`);
if (wrong) failures.push(`${wrong} checkpoint cars are facing against one-way road direction`);
if (closePairs) failures.push(`${closePairs} checkpoint car pairs are closer than the hard spacing threshold`);
if (meanLaneError > maxMeanLaneError) failures.push(`mean lane error ${round(meanLaneError)} > ${maxMeanLaneError}`);
if (laneMax > maxLaneError) failures.push(`max lane error ${round(laneMax)} > ${maxLaneError}`);
if (stopLineNonGreen) {
  warnings.push(`${stopLineNonGreen} cars are at a non-green stop line; verify trainer red-light violations stay zero`);
}

if (trainer) {
  if (trainer.buildingCollisions > 0) failures.push(`trainer logged ${trainer.buildingCollisions} building collisions`);
  if (trainer.waterHits > 0) failures.push(`trainer logged ${trainer.waterHits} water hits`);
  if (trainer.redLightViolations > 0) failures.push(`trainer logged ${trainer.redLightViolations} red-light violations`);
  if (trainer.wrongWaySteps > 0) failures.push(`trainer logged ${trainer.wrongWaySteps} wrong-way steps`);
  if (trainer.carCollisions > maxCarCollisions) {
    failures.push(`trainer logged ${trainer.carCollisions} car collisions > ${maxCarCollisions}`);
  }
} else {
  warnings.push(`trainer log unavailable or unparsable: ${logPath}`);
}

const summary = {
  checkpoint: path.relative(ROOT, checkpointPath),
  cars: checkpoint.cars?.length ?? 0,
  simH: round(sampleTime / 3600),
  wet,
  noProj,
  offEdge,
  wrong,
  closePairs,
  stopLineNonGreen,
  meanLaneError: round(meanLaneError),
  laneMax: round(laneMax),
  trainer,
  warnings,
  failures,
  details: details.slice(0, 20)
};

console.log(`[aicars-checkpoint] ${failures.length ? "FAIL" : "ok"} ${summary.cars} cars, sim ${summary.simH}h`);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exit(1);

function round(n) {
  return Math.round(n * 1000) / 1000;
}
