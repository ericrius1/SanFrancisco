// Periodic watchdog for the overnight AI-car trainer.
//
// It does not train cars itself. It repeatedly runs the checkpoint audit and
// road/collider overlap audit so a long run leaves a clear pass/fail trail.
//
// Usage:
//   node tools/watch-aicars-training.mjs
//   SF_WATCH_INTERVAL_MS=300000 SF_WATCH_STOP_ON_FAIL=1 node tools/watch-aicars-training.mjs

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INTERVAL_MS = envNumber("SF_WATCH_INTERVAL_MS", 10 * 60_000);
const MAX_TRAINER_LOG_AGE_S = envNumber("SF_WATCH_MAX_TRAINER_LOG_AGE_S", 180);
const MIN_PROGRESS_RATIO = envNumber("SF_WATCH_MIN_PROGRESS_RATIO", 0.04);
const MAX_ROAD_CLAMPS_PER_KM = envNumber("SF_WATCH_MAX_ROAD_CLAMPS_PER_KM", 12_000);
const MAX_LANE_FIXES_PER_KM = envNumber("SF_WATCH_MAX_LANEFIX_PER_KM", 150);
const MIN_STOPLINE_HOLDS = envNumber("SF_WATCH_MIN_STOPLINE_HOLDS", 1);
const MAX_STOP_LINE_SPEED = envNumber("SF_WATCH_MAX_STOP_LINE_SPEED", 0.35);
const LOG = process.env.SF_WATCH_LOG || "/tmp/sf-aicars/watchdog.log";
const STOP_ON_FAIL = process.env.SF_WATCH_STOP_ON_FAIL === "1" || process.env.SF_WATCH_STOP_ON_FAIL === "true";
const PROMOTE = process.env.SF_WATCH_PROMOTE !== "0" && process.env.SF_WATCH_PROMOTE !== "false";
const CHECKPOINT = path.resolve(ROOT, process.env.SF_WATCH_CHECKPOINT || "tools/aicars-trained-v3.json");
const SERVER_LIFE = path.resolve(ROOT, process.env.SF_WATCH_SERVER_LIFE || "server/data/aicars-life.json");

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function write(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(text);
  mkdirSync(path.dirname(LOG), { recursive: true });
  appendFileSync(LOG, text);
}

function run(label, command, args) {
  const res = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = `${res.stdout || ""}${res.stderr || ""}`.trim();
  if (output) {
    for (const line of output.split(/\r?\n/)) write(`[${label}] ${line}`);
  }
  return res.status === 0;
}

function lifeAgeSum(file) {
  if (!existsSync(file)) return -Infinity;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || parsed.v !== 3 || !Array.isArray(parsed.cars)) return -Infinity;
  return parsed.cars.reduce((sum, car) => sum + (Number.isFinite(car?.ageS) ? car.ageS : 0), 0);
}

function promoteCheckpoint() {
  if (!PROMOTE) return true;
  try {
    const checkpointAge = lifeAgeSum(CHECKPOINT);
    const serverAge = lifeAgeSum(SERVER_LIFE);
    if (!Number.isFinite(checkpointAge) || checkpointAge <= serverAge) {
      write(`[promote] skipped checkpointAge=${Math.round(checkpointAge)} serverAge=${Math.round(serverAge)}`);
      return true;
    }
    mkdirSync(path.dirname(SERVER_LIFE), { recursive: true });
    const tmp = `${SERVER_LIFE}.tmp`;
    writeFileSync(tmp, readFileSync(CHECKPOINT));
    renameSync(tmp, SERVER_LIFE);
    write(`[promote] checkpoint -> ${path.relative(ROOT, SERVER_LIFE)} age=${Math.round(checkpointAge)}s`);
    return true;
  } catch (err) {
    write(`[promote] FAIL ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function tick() {
  const okCheckpoint = run("check:aicars", process.execPath, [
    "--experimental-strip-types",
    "tools/check-aicars-checkpoint.mjs",
    "--require-trainer",
    "--require-speed",
    "--max-trainer-log-age-s",
    String(MAX_TRAINER_LOG_AGE_S),
    "--min-progress-ratio",
    String(MIN_PROGRESS_RATIO),
    "--max-road-clamps-per-km",
    String(MAX_ROAD_CLAMPS_PER_KM),
    "--max-lanefix-per-km",
    String(MAX_LANE_FIXES_PER_KM),
    "--min-stopline-holds",
    String(MIN_STOPLINE_HOLDS),
    "--max-stop-line-speed",
    String(MAX_STOP_LINE_SPEED)
  ]);
  const okTraffic = run("audit:traffic", process.execPath, [
    "--experimental-strip-types",
    "tools/audit-traffic-system.mjs"
  ]);
  const okColliders = run("road-collider", process.execPath, ["tools/check-road-collider-overlap.mjs"]);
  const okPromote = okCheckpoint && okTraffic && okColliders ? promoteCheckpoint() : false;
  const ok = okCheckpoint && okTraffic && okColliders && okPromote;
  write(`[watchdog] ${ok ? "ok" : "FAIL"} checkpoint=${okCheckpoint} traffic=${okTraffic} roadCollider=${okColliders} promote=${okPromote}`);
  if (!ok && STOP_ON_FAIL) process.exit(1);
}

write(
  `[watchdog] start intervalMs=${INTERVAL_MS} maxTrainerLogAgeS=${MAX_TRAINER_LOG_AGE_S}` +
    ` minProgressRatio=${MIN_PROGRESS_RATIO} maxRoadClampsPerKm=${MAX_ROAD_CLAMPS_PER_KM}` +
    ` maxLaneFixesPerKm=${MAX_LANE_FIXES_PER_KM}` +
    ` minStoplineHolds=${MIN_STOPLINE_HOLDS}` +
    ` maxStopLineSpeed=${MAX_STOP_LINE_SPEED}` +
    ` promote=${PROMOTE} checkpoint=${path.relative(ROOT, CHECKPOINT)}` +
    ` serverLife=${path.relative(ROOT, SERVER_LIFE)} stopOnFail=${STOP_ON_FAIL} log=${LOG}`
);
tick();
setInterval(tick, INTERVAL_MS);
