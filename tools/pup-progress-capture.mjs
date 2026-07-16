// One hourly heartbeat of the overnight pup-training watch:
//  - snapshot trainer progress (last line of rl/runs/pup_log.jsonl + checkpoint meta)
//  - run the headless in-world probe (screenshots + ground-truth state)
//  - append everything to .data/creature-nursery/progress.jsonl
//
//   node tools/pup-progress-capture.mjs [--label hour-03]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data/creature-nursery");
const argOf = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const now = new Date();
const LABEL = argOf("label", `h${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`);
mkdirSync(OUT, { recursive: true });

// trainer progress
let train = null;
try {
  const lines = readFileSync(path.join(ROOT, "rl/runs/pup_log.jsonl"), "utf8").trim().split("\n");
  train = JSON.parse(lines[lines.length - 1]);
} catch {}
let ckpt = null;
try {
  const p = JSON.parse(readFileSync(path.join(ROOT, "public/models/pup_policy.json"), "utf8"));
  ckpt = p.meta ?? null;
} catch {}

// in-world probe (screenshots + state json into OUT)
let probeOk = false;
let probeOut = "";
try {
  probeOut = execFileSync("node", ["tools/pup-verify-probe.mjs", "--out", OUT, "--label", LABEL], { cwd: ROOT, encoding: "utf8", timeout: 8 * 60 * 1000 });
  probeOk = true;
} catch (e) {
  probeOut = String(e.stdout ?? "") + String(e.stderr ?? e.message);
}
let state = null;
try { state = JSON.parse(readFileSync(path.join(OUT, `${LABEL}-state.json`), "utf8")); } catch {}

const record = {
  label: LABEL,
  at: now.toISOString(),
  trainerLastGen: train,
  checkpoint: ckpt,
  probeOk,
  world: state?.state ?? null
};
appendFileSync(path.join(OUT, "progress.jsonl"), JSON.stringify(record) + "\n");
writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record));
if (!probeOk) { console.error(probeOut.slice(-1500)); process.exit(1); }
