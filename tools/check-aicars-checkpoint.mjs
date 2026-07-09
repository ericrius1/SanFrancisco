// Audit the saved AI-car training checkpoint against the current SF road graph.
//
// Usage:
//   node --experimental-strip-types tools/check-aicars-checkpoint.mjs
//   node --experimental-strip-types tools/check-aicars-checkpoint.mjs --checkpoint tools/aicars-trained-v3.json --log /tmp/sf-aicars/trainer.log

import { readFileSync, existsSync, statSync } from "node:fs";
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

function argFlag(name) {
  return process.argv.includes(name);
}

const checkpointPath = path.resolve(ROOT, argValue("--checkpoint", "tools/aicars-trained-v3.json"));
const roadsPath = path.resolve(ROOT, argValue("--roads", "public/data/roads.json"));
const surfacePath = path.resolve(ROOT, argValue("--surface", "public/data/surface.bin"));
const metaPath = path.resolve(ROOT, argValue("--meta", "public/data/meta.json"));
const logPath = argValue("--log", "/tmp/sf-aicars/trainer.log");

const maxMeanLaneError = argNumber("--max-mean-lane", 0.75);
const maxLaneError = argNumber("--max-lane", 2.0);
const maxCarCollisions = argNumber("--max-car-collisions", 0);
const requireTrainer = argFlag("--require-trainer");
const requireSpeed = argFlag("--require-speed");
const maxTrainerLogAgeS = argNumber("--max-trainer-log-age-s", 0);
const minProgressRatio = argNumber("--min-progress-ratio", -Infinity);
const maxRoadClampsPerKm = argNumber("--max-road-clamps-per-km", Infinity);
const maxLaneFixesPerKm = argNumber("--max-lanefix-per-km", Infinity);
const minStopLineHolds = argNumber("--min-stopline-holds", 0);
const minFollowingGapM = argNumber("--min-following-gap-m", 8);
const maxStopLineSpeed = argNumber("--max-stop-line-speed", 0.35);

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
  const st = statSync(file);
  const meta = {
    logMtime: new Date(st.mtimeMs).toISOString(),
    logAgeS: round((Date.now() - st.mtimeMs) / 1000)
  };
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return { ...meta, line: null, parsed: false };
  const lines = raw.split(/\r?\n/).reverse();
  const line = lines.find((l) => l.includes("[trainer] +") && l.includes(" coll "));
  if (!line) return { ...meta, line: null, parsed: false };
  const rx =
    /sim ([\d.]+)h .*? coll (\d+) bld (\d+) car (\d+) water (\d+) clamp (\d+) red (\d+)(?: hold (\d+))? wrong (\d+) lane ([\d.]+)(?: prog (-?[\d.]+) dist (\d+)(?: clampkm (-?[\d.]+))?(?: lanefix (\d+))?)?/;
  const m = line.match(rx);
  if (!m) return { ...meta, line, parsed: false };
  const roadClamps = Number(m[6]);
  const stopLineHolds = m[8] == null ? null : Number(m[8]);
  const distanceM = m[12] == null ? null : Number(m[12]);
  const laneCorrections = m[14] == null ? null : Number(m[14]);
  return {
    ...meta,
    line,
    parsed: true,
    simH: Number(m[1]),
    collisions: Number(m[2]),
    buildingCollisions: Number(m[3]),
    carCollisions: Number(m[4]),
    waterHits: Number(m[5]),
    roadClamps,
    redLightViolations: Number(m[7]),
    stopLineHolds,
    wrongWaySteps: Number(m[9]),
    meanLaneErrorLogged: Number(m[10]),
    progressRatio: m[11] == null ? null : Number(m[11]),
    distanceM,
    roadClampsPerKm: distanceM && distanceM > 0 ? roadClamps / (distanceM / 1000) : null,
    laneCorrections,
    laneCorrectionsPerKm: distanceM && distanceM > 0 && laneCorrections != null ? laneCorrections / (distanceM / 1000) : null
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
let stoppedAtNonGreenStopLine = 0;
let movingAtNonGreenStopLine = 0;
let unknownStopLineSpeed = 0;
let carsWithSpeed = 0;
let carsMissingSpeed = 0;
let laneSum = 0;
let laneMax = 0;
const projectedCars = new Map();
const sampleTime = Math.max(0, ...checkpoint.cars.map((c) => Number(c.ageS) || 0));

for (const car of checkpoint.cars ?? []) {
  if (typeof car.speed === "number" && Number.isFinite(car.speed)) carsWithSpeed++;
  else carsMissingSpeed++;
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
  projectedCars.set(car.id, { car, proj, dir });
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
    const hasSpeed = typeof car.speed === "number" && Number.isFinite(car.speed);
    const approachSpeed = hasSpeed ? car.speed * dot : NaN;
    stopLineNonGreen++;
    if (!hasSpeed) {
      unknownStopLineSpeed++;
      details.push({ id: car.id, type: "non-green-stop-line-speed-unknown", state: signal.state, distance: round(signal.distance) });
    } else if (approachSpeed > maxStopLineSpeed) {
      movingAtNonGreenStopLine++;
      details.push({
        id: car.id,
        type: "moving-at-non-green-stop-line",
        state: signal.state,
        distance: round(signal.distance),
        speed: round(car.speed),
        approachSpeed: round(approachSpeed)
      });
    } else {
      stoppedAtNonGreenStopLine++;
      details.push({
        id: car.id,
        type: "held-at-non-green-stop-line",
        state: signal.state,
        distance: round(signal.distance),
        speed: round(car.speed),
        approachSpeed: round(approachSpeed)
      });
    }
  }
}

let closePairs = 0;
let unsafeFollowingPairs = 0;
for (let i = 0; i < checkpoint.cars.length; i++) {
  for (let j = i + 1; j < checkpoint.cars.length; j++) {
    const a = checkpoint.cars[i];
    const b = checkpoint.cars[j];
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 3.85) {
      closePairs++;
      details.push({ type: "close-pair", a: a.id, b: b.id, distance: round(d) });
    }
    const pa = projectedCars.get(a.id);
    const pb = projectedCars.get(b.id);
    if (pa && pb && pa.proj.segId === pb.proj.segId && pa.dir === pb.dir) {
      const lateralGap = Math.abs(pa.proj.lateral - pb.proj.lateral);
      const laneTolerance = Math.max(1.15, Math.min(pa.proj.halfWidth, pb.proj.halfWidth) * 0.28);
      const alongGap = Math.abs(pa.proj.s - pb.proj.s);
      if (lateralGap <= laneTolerance && alongGap > 0.01 && alongGap < minFollowingGapM) {
        unsafeFollowingPairs++;
        details.push({
          type: "unsafe-following-gap",
          a: a.id,
          b: b.id,
          gap: round(alongGap),
          lateralGap: round(lateralGap),
          segId: pa.proj.segId
        });
      }
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
if (unsafeFollowingPairs) failures.push(`${unsafeFollowingPairs} same-lane checkpoint car pairs are below ${minFollowingGapM}m following gap`);
if (requireSpeed && carsMissingSpeed) failures.push(`${carsMissingSpeed} checkpoint cars are missing speed`);
if (unknownStopLineSpeed) failures.push(`${unknownStopLineSpeed} non-green stop-line cars are missing speed in the checkpoint`);
if (movingAtNonGreenStopLine) failures.push(`${movingAtNonGreenStopLine} cars are approaching faster than ${maxStopLineSpeed}m/s at a non-green stop line`);
if (meanLaneError > maxMeanLaneError) failures.push(`mean lane error ${round(meanLaneError)} > ${maxMeanLaneError}`);
if (laneMax > maxLaneError) failures.push(`max lane error ${round(laneMax)} > ${maxLaneError}`);

if (trainer) {
  if (maxTrainerLogAgeS > 0 && trainer.logAgeS > maxTrainerLogAgeS) {
    failures.push(`trainer log is stale: ${trainer.logAgeS}s old > ${maxTrainerLogAgeS}s`);
  }
  if (!trainer.parsed) {
    const msg = `trainer log unavailable or unparsable: ${logPath}`;
    if (requireTrainer) failures.push(msg);
    else warnings.push(msg);
  } else {
    if (trainer.buildingCollisions > 0) failures.push(`trainer logged ${trainer.buildingCollisions} building collisions`);
    if (trainer.waterHits > 0) failures.push(`trainer logged ${trainer.waterHits} water hits`);
    if (trainer.redLightViolations > 0) failures.push(`trainer logged ${trainer.redLightViolations} red-light violations`);
    if (minStopLineHolds > 0) {
      if (trainer.stopLineHolds == null) {
        failures.push("trainer log does not include stop-line hold count");
      } else if (trainer.stopLineHolds < minStopLineHolds) {
        failures.push(`trainer stop-line holds ${trainer.stopLineHolds} < ${minStopLineHolds}`);
      }
    }
    if (trainer.wrongWaySteps > 0) failures.push(`trainer logged ${trainer.wrongWaySteps} wrong-way steps`);
    if (trainer.carCollisions > maxCarCollisions) {
      failures.push(`trainer logged ${trainer.carCollisions} car collisions > ${maxCarCollisions}`);
    }
    if (Number.isFinite(minProgressRatio)) {
      if (trainer.progressRatio == null) {
        failures.push("trainer log does not include progress ratio");
      } else if (trainer.progressRatio < minProgressRatio) {
        failures.push(`trainer progress ratio ${round(trainer.progressRatio)} < ${minProgressRatio}`);
      }
    }
    if (Number.isFinite(maxRoadClampsPerKm)) {
      if (trainer.roadClampsPerKm == null) {
        failures.push("trainer log does not include distance for road-clamp rate");
      } else if (trainer.roadClampsPerKm > maxRoadClampsPerKm) {
        failures.push(`trainer road clamps ${round(trainer.roadClampsPerKm)} / km > ${maxRoadClampsPerKm}`);
      }
    }
    if (Number.isFinite(maxLaneFixesPerKm)) {
      if (trainer.laneCorrectionsPerKm == null) {
        failures.push("trainer log does not include lane-correction rate");
      } else if (trainer.laneCorrectionsPerKm > maxLaneFixesPerKm) {
        failures.push(`trainer lane corrections ${round(trainer.laneCorrectionsPerKm)} / km > ${maxLaneFixesPerKm}`);
      }
    }
  }
} else {
  const msg = `trainer log missing: ${logPath}`;
  if (requireTrainer) failures.push(msg);
  else warnings.push(msg);
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
  unsafeFollowingPairs,
  minFollowingGapM,
  carsWithSpeed,
  carsMissingSpeed,
  requireSpeed,
  stopLineNonGreen,
  stoppedAtNonGreenStopLine,
  movingAtNonGreenStopLine,
  unknownStopLineSpeed,
  maxStopLineSpeed,
  maxLaneFixesPerKm,
  minStopLineHolds,
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
