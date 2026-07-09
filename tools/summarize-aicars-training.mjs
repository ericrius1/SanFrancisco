// Summarize the live overnight AI-car training run from the trainer/watchdog logs.
//
// This is intentionally read-only. Use it during long runs to answer:
// - how long the final strict watchdog gates have been active
// - how many watchdog passes/failures have occurred since that start
// - whether the latest trainer line is still clean for collisions, lights, and lanes
//
// Usage:
//   node tools/summarize-aicars-training.mjs
//   node tools/summarize-aicars-training.mjs --min-strict-hours 8 --min-watchdog-passes 48

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const trainerLog = argValue("--trainer-log", "/tmp/sf-aicars/trainer.log");
const watchdogLog = argValue("--watchdog-log", "/tmp/sf-aicars/watchdog.log");
const minStrictHours = argNumber("--min-strict-hours", 0);
const minWatchdogPasses = argNumber("--min-watchdog-passes", 0);
const maxWatchdogLogAgeS = argNumber("--max-watchdog-log-age-s", 900);
const maxTrainerLogAgeS = argNumber("--max-trainer-log-age-s", 180);
const maxRoadClampsPerKm = argNumber("--max-road-clamps-per-km", 12_000);
const maxLaneFixesPerKm = argNumber("--max-lanefix-per-km", 150);
const maxStepM = argNumber("--max-step-m", 8);
const maxYawStepRad = argNumber("--max-yaw-step-rad", 0.35);
const minProgressRatio = argNumber("--min-progress-ratio", 0.04);
const minStopLineHolds = argNumber("--min-stopline-holds", 1);

const failures = [];
const warnings = [];
const watchdog = summarizeWatchdog(watchdogLog);
const trainer = summarizeTrainer(trainerLog);

if (!watchdog.exists) failures.push(`watchdog log missing: ${watchdogLog}`);
if (!trainer.exists) failures.push(`trainer log missing: ${trainerLog}`);
if (watchdog.exists && !watchdog.strictStartAt) failures.push("no strict watchdog start found");
if (watchdog.exists && watchdog.logAgeS > maxWatchdogLogAgeS) {
  failures.push(`watchdog log age ${watchdog.logAgeS}s > ${maxWatchdogLogAgeS}s`);
}
if (watchdog.strictStartAt && watchdog.strictElapsedHours < minStrictHours) {
  failures.push(`strict watchdog elapsed ${round(watchdog.strictElapsedHours)}h < ${minStrictHours}h`);
}
if (watchdog.passCount < minWatchdogPasses) {
  failures.push(`strict watchdog passes ${watchdog.passCount} < ${minWatchdogPasses}`);
}
if (watchdog.failCount > 0) failures.push(`strict watchdog has ${watchdog.failCount} failure ticks`);
if (trainer.latest) {
  if (trainer.logAgeS > maxTrainerLogAgeS) failures.push(`trainer log age ${trainer.logAgeS}s > ${maxTrainerLogAgeS}s`);
  if (trainer.latest.collisions > 0) failures.push(`trainer logged ${trainer.latest.collisions} collisions`);
  if (trainer.latest.buildingCollisions > 0) failures.push(`trainer logged ${trainer.latest.buildingCollisions} building collisions`);
  if (trainer.latest.carCollisions > 0) failures.push(`trainer logged ${trainer.latest.carCollisions} car collisions`);
  if (trainer.latest.waterHits > 0) failures.push(`trainer logged ${trainer.latest.waterHits} water hits`);
  if (trainer.latest.redLightViolations > 0) failures.push(`trainer logged ${trainer.latest.redLightViolations} red-light violations`);
  if (trainer.latest.wrongWaySteps > 0) failures.push(`trainer logged ${trainer.latest.wrongWaySteps} wrong-way steps`);
  if (trainer.latest.stopLineHolds == null) failures.push("trainer latest line does not include stop-line holds");
  else if (trainer.latest.stopLineHolds < minStopLineHolds) failures.push(`trainer stop-line holds ${trainer.latest.stopLineHolds} < ${minStopLineHolds}`);
  if (trainer.latest.progressRatio == null) failures.push("trainer latest line does not include progress ratio");
  else if (trainer.latest.progressRatio < minProgressRatio) failures.push(`trainer progress ratio ${round(trainer.latest.progressRatio)} < ${minProgressRatio}`);
  if (trainer.latest.roadClampsPerKm == null) failures.push("trainer latest line does not include road-clamp rate");
  else if (trainer.latest.roadClampsPerKm > maxRoadClampsPerKm) {
    failures.push(`trainer road clamps ${round(trainer.latest.roadClampsPerKm)} / km > ${maxRoadClampsPerKm}`);
  }
  if (trainer.latest.laneCorrectionsPerKm == null) failures.push("trainer latest line does not include lane-correction rate");
  else if (trainer.latest.laneCorrectionsPerKm > maxLaneFixesPerKm) {
    failures.push(`trainer lane corrections ${round(trainer.latest.laneCorrectionsPerKm)} / km > ${maxLaneFixesPerKm}`);
  }
  if (trainer.latest.maxStepM == null) failures.push("trainer latest line does not include max per-step movement");
  else if (trainer.latest.maxStepM > maxStepM) failures.push(`trainer max per-step movement ${round(trainer.latest.maxStepM)}m > ${maxStepM}m`);
  if (trainer.latest.maxYawStepRad == null) failures.push("trainer latest line does not include max per-step yaw");
  else if (trainer.latest.maxYawStepRad > maxYawStepRad) {
    failures.push(`trainer max per-step yaw ${round(trainer.latest.maxYawStepRad)}rad > ${maxYawStepRad}rad`);
  }
} else if (trainer.exists) {
  failures.push("no parseable trainer stat line found");
}

if (watchdog.strictStartAt && watchdog.passCount === 0) warnings.push("strict watchdog has not reached its first scheduled pass yet");
if (trainer.latest && trainer.latest.realMin < 30) warnings.push(`current trainer process is only ${round(trainer.latest.realMin)} real minutes old`);

const summary = {
  status: failures.length ? "FAIL" : "ok",
  trainerLog,
  watchdogLog,
  watchdog,
  trainer,
  thresholds: {
    minStrictHours,
    minWatchdogPasses,
    maxWatchdogLogAgeS,
    maxTrainerLogAgeS,
    maxRoadClampsPerKm,
    maxLaneFixesPerKm,
    maxStepM,
    maxYawStepRad,
    minProgressRatio,
    minStopLineHolds
  },
  warnings,
  failures
};

console.log(
  `[aicars-report] ${summary.status}` +
    ` strict=${round(watchdog.strictElapsedHours)}h` +
    ` passes=${watchdog.passCount}` +
    ` fails=${watchdog.failCount}` +
    ` trainer=${trainer.latest ? `${round(trainer.latest.realMin)}min/${round(trainer.latest.simH)}simh` : "none"}`
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exit(1);

function summarizeWatchdog(file) {
  const result = {
    exists: existsSync(file),
    logAgeS: null,
    strictStartAt: null,
    strictElapsedHours: 0,
    passCount: 0,
    failCount: 0,
    lastOkAt: null,
    lastFailAt: null,
    lastLine: null
  };
  if (!result.exists) return result;
  const st = statSync(file);
  result.logAgeS = round((Date.now() - st.mtimeMs) / 1000);
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  let startIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("[watchdog] start") && /minStoplineHolds=([1-9]\d*)/.test(lines[i])) {
      startIndex = i;
      result.strictStartAt = lineTime(lines[i]);
      break;
    }
  }
  if (startIndex < 0) return result;
  result.strictElapsedHours = result.strictStartAt ? round((Date.now() - Date.parse(result.strictStartAt)) / 3_600_000) : 0;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("[watchdog] ok checkpoint=true traffic=true roadCollider=true promote=true")) {
      result.passCount++;
      result.lastOkAt = lineTime(line);
    } else if (line.includes("[watchdog] FAIL")) {
      result.failCount++;
      result.lastFailAt = lineTime(line);
    }
    if (line.includes("[watchdog] ")) result.lastLine = line;
  }
  return result;
}

function summarizeTrainer(file) {
  const result = {
    exists: existsSync(file),
    logAgeS: null,
    currentRunLines: 0,
    latest: null,
    latestLine: null,
    currentRunStartSeen: false
  };
  if (!result.exists) return result;
  const st = statSync(file);
  result.logAgeS = round((Date.now() - st.mtimeMs) / 1000);
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  let startIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("[trainer] start")) {
      startIndex = i;
      result.currentRunStartSeen = true;
      break;
    }
  }
  const scan = startIndex >= 0 ? lines.slice(startIndex + 1) : lines;
  for (const line of scan) {
    const parsed = parseTrainerLine(line);
    if (!parsed) continue;
    result.currentRunLines++;
    result.latest = parsed;
    result.latestLine = line;
  }
  return result;
}

function parseTrainerLine(line) {
  const rx =
    /\[trainer\] \+([\d.]+)min real \| sim ([\d.]+)h .*? \| (\d+) km \| eldest ([\d.]+)h \| coll (\d+) bld (\d+) car (\d+) water (\d+) clamp (\d+) red (\d+)(?: hold (\d+))? wrong (\d+) lane ([\d.]+)(?: prog (-?[\d.]+) dist (\d+)(?: clampkm (-?[\d.]+))?(?: lanefix (\d+)(?: step ([\d.]+) yaw ([\d.]+)(?: recover (\d+))?)?)?)?/;
  const m = line.match(rx);
  if (!m) return null;
  const distanceM = m[15] == null ? null : Number(m[15]);
  const roadClamps = Number(m[9]);
  const laneCorrections = m[17] == null ? null : Number(m[17]);
  return {
    realMin: Number(m[1]),
    simH: Number(m[2]),
    totalKm: Number(m[3]),
    eldestH: Number(m[4]),
    collisions: Number(m[5]),
    buildingCollisions: Number(m[6]),
    carCollisions: Number(m[7]),
    waterHits: Number(m[8]),
    roadClamps,
    redLightViolations: Number(m[10]),
    stopLineHolds: m[11] == null ? null : Number(m[11]),
    wrongWaySteps: Number(m[12]),
    meanLaneError: Number(m[13]),
    progressRatio: m[14] == null ? null : Number(m[14]),
    distanceM,
    roadClampsPerKm: distanceM && distanceM > 0 ? roadClamps / (distanceM / 1000) : null,
    laneCorrections,
    laneCorrectionsPerKm: distanceM && distanceM > 0 && laneCorrections != null ? laneCorrections / (distanceM / 1000) : null,
    maxStepM: m[18] == null ? null : Number(m[18]),
    maxYawStepRad: m[19] == null ? null : Number(m[19]),
    forcedRoadRecoveries: m[20] == null ? null : Number(m[20])
  };
}

function lineTime(line) {
  const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)/);
  return m ? m[1] : null;
}

function round(n) {
  if (n == null || !Number.isFinite(n)) return n;
  return Math.round(n * 1000) / 1000;
}
