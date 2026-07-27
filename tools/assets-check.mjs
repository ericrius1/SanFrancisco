#!/usr/bin/env node
// Are this checkout's baked assets in sync with the sources they came from?
//
//   node tools/assets-check.mjs           verify, report, exit non-zero on drift
//   node tools/assets-check.mjs --heal    additionally rebake what is safe to rebake
//   node tools/assets-check.mjs --list    show every registered artifact and its state
//
// The build runs `--heal`. Two categories, deliberately treated differently:
//
//   UNTRACKED outputs (terrain tiles) are gitignored derived data. Every
//   checkout is expected to generate its own, they are reproducible from
//   tracked sources, and a stale one is nobody's decision — so `--heal` just
//   rebakes it. This is the case that left a freshly merged main unable to
//   build: its tile bake was three days older than its source data, and the
//   old existence-only check had no way to notice.
//
//   TRACKED outputs (a .glb baked from a .blend) are committed artifacts. A
//   rebake is a content change that belongs in a commit and a review, and it
//   needs Blender, which not every machine has. So drift there is reported as
//   an error with the exact command — never silently rewritten underneath you.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { ROOT, listLedgerEntries, verifyEntry } from "./asset-ledger.mjs";

const args = process.argv.slice(2);
const heal = args.includes("--heal");
const listOnly = args.includes("--list");

const entries = listLedgerEntries();
if (entries.length === 0) {
  console.log("assets: no baked artifacts registered (data/asset-ledger/ is empty)");
  process.exit(0);
}

function describe(result) {
  const lines = [`  ${result.label} [${result.id}]`];
  for (const problem of [...result.problems, ...result.notes]) {
    lines.push(`    ${problem.kind.padEnd(14)} ${problem.file} — ${problem.detail}`);
  }
  lines.push(`    fix: ${result.bake}`);
  return lines.join("\n");
}

let results = entries.map(verifyEntry);

if (listOnly) {
  for (const result of results) {
    const state = [...result.problems, ...result.notes].map((p) => p.kind).join(",") || "ok";
    console.log(`${result.tracked ? "tracked  " : "generated"} ${result.id.padEnd(28)} ${state}`);
  }
  process.exit(0);
}

// Heal the regenerable ones first, then re-verify so the report reflects reality.
if (heal) {
  const healable = results.filter((result) => !result.tracked && result.problems.length > 0);
  for (const result of healable) {
    console.log(`assets: ${result.label} is out of date — rebaking (${result.bake})`);
    const run = spawnSync(result.bake, { cwd: ROOT, shell: true, stdio: "inherit" });
    if (run.status !== 0) {
      console.error(`assets: rebake failed for ${result.id}`);
      process.exit(run.status ?? 1);
    }
  }
  if (healable.length > 0) results = listLedgerEntries().map(verifyEntry);
}

// Notes never fail anything; they are told once, up front, so a machine that
// cannot bake a given artifact knows before it tries.
for (const result of results) {
  for (const note of result.notes) {
    console.log(`assets: note — ${result.id}: ${note.file} ${note.detail}`);
  }
}

const broken = results.filter((result) => result.problems.length > 0);
if (broken.length === 0) {
  console.log(`assets: ok (${results.length} baked artifacts match their sources)`);
  process.exit(0);
}

console.error("\nassets: baked artifacts are out of sync with their sources\n");
for (const result of broken) console.error(describe(result));
console.error(
  "\nA tracked artifact drifts when its source was committed without re-baking." +
  "\nRebake it, then commit the source, the outputs and data/asset-ledger/ together" +
  "\nso the next checkout — and main — gets a matched set.\n"
);
process.exit(1);
