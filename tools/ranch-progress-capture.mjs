// One hourly heartbeat of the overnight ranch watch — ALL experiments:
//  - per-creature trainer progress (last pup/horse/goat log lines + checkpoint meta)
//  - one headless in-world probe over every pen (screenshots + ground truth)
//  - appends to .data/creature-nursery/progress.jsonl (same timeline the pup started)
//
//   node tools/ranch-progress-capture.mjs [--label h03]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data/creature-nursery");
const argOf = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const now = new Date();
const LABEL = argOf("label", `h${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`);
mkdirSync(OUT, { recursive: true });

const trainers = {};
for (const name of ["pup", "horse", "goat"]) {
  let lastGen = null;
  let ckpt = null;
  try {
    const lines = readFileSync(path.join(ROOT, `rl/runs/${name}_log.jsonl`), "utf8").trim().split("\n");
    lastGen = JSON.parse(lines[lines.length - 1]);
  } catch {}
  try {
    ckpt = JSON.parse(readFileSync(path.join(ROOT, `public/models/${name}_policy.json`), "utf8")).meta ?? null;
  } catch {}
  trainers[name] = { lastGen, ckpt };
}

let probeOk = false;
let probeOut = "";
try {
  probeOut = execFileSync("node", ["tools/ranch-verify-probe.mjs", "--out", OUT, "--label", LABEL], { cwd: ROOT, encoding: "utf8", timeout: 10 * 60 * 1000 });
  probeOk = true;
} catch (e) {
  probeOut = String(e.stdout ?? "") + String(e.stderr ?? e.message);
}
let state = null;
try { state = JSON.parse(readFileSync(path.join(OUT, `${LABEL}-state.json`), "utf8")); } catch {}

const record = {
  label: LABEL,
  at: now.toISOString(),
  trainers,
  probeOk,
  pup: state?.pup ?? null,
  ranch: state?.ranch ?? null
};
appendFileSync(path.join(OUT, "progress.jsonl"), JSON.stringify(record) + "\n");
writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record));
if (!probeOk) { console.error(probeOut.slice(-1500)); process.exit(1); }
