// Provenance for everything this repo BAKES rather than writes by hand.
//
// The problem this solves, concretely: a `.blend` and the `.glb` baked from it
// are both tracked, so they merge like code — but nothing ever checked that the
// committed `.glb` actually came from the committed `.blend`. Edit a site in a
// worktree, commit the source without re-baking, merge, and main now ships a
// model that does not match its authoring file. Silently, forever.
//
// The mirror-image failure is generated data that is NOT tracked, like the
// terrain tile bake. Its contract test self-heals only when the bake is
// *missing*; a bake that merely went stale sails past that check and then fails
// an assertion three steps later with no hint that a rebake is the fix. That is
// exactly how a freshly merged main ended up unable to build.
//
// One mechanism covers both. After every bake, record the SHA-256 of each input
// and each output. Before every build, compare those hashes against the files
// on disk. Any drift is then a precise, named, actionable failure instead of a
// mystery — and for artifacts that are regenerable and untracked, the check can
// simply fix it.
//
// LEDGER LAYOUT — one file per artifact, `data/asset-ledger/<id>.json`.
// Deliberately not a single ledger file: two worktrees baking two different
// sites must never conflict, and two worktrees baking the SAME site must — that
// is a real conflict about which bake is authoritative, and git should say so.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER_DIR = path.join(ROOT, "data", "asset-ledger");
export const LEDGER_SCHEMA = 1;

const LFS_PREFIX = "version https://git-lfs.github.com/spec/v1";

/**
 * If this buffer is a Git LFS pointer, its object id — otherwise null.
 *
 * This matters more than it looks. The site `.blend` files are LFS-tracked, so
 * a checkout holds either the real multi-hundred-kilobyte model or a 131-byte
 * text pointer, depending on whether its LFS objects were ever fetched. Hashing
 * the bytes on disk would therefore give two different answers for the same
 * committed asset, and every unsmudged checkout would report false drift.
 *
 * An LFS pointer's `oid sha256` IS the SHA-256 of the real content, so reading
 * it through gives one fingerprint that is identical either way.
 */
function lfsPointerOid(buffer) {
  if (buffer.length > 1024) return null;
  const text = buffer.toString("utf8");
  if (!text.startsWith(LFS_PREFIX)) return null;
  const match = /^oid sha256:([0-9a-f]{64})$/m.exec(text);
  return match ? match[1] : null;
}

/** True when this path holds an LFS pointer rather than the asset itself. */
export function isUnsmudgedPointer(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  if (!existsSync(absolute)) return false;
  return lfsPointerOid(readFileSync(absolute)) !== null;
}

/**
 * Content fingerprint of a file, or null when it does not exist. Resolves LFS
 * pointers to the content they stand for, so smudged and unsmudged checkouts
 * agree.
 */
export function hashFile(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  if (!existsSync(absolute)) return null;
  const buffer = readFileSync(absolute);
  return lfsPointerOid(buffer) ?? createHash("sha256").update(buffer).digest("hex");
}

/**
 * SHA-256 over a whole directory's contents, name-sorted so it is stable across
 * filesystems. Used for bakes that emit hundreds of files (terrain tiles) where
 * listing each one in the ledger would be noise.
 */
export function hashDirectory(relativeDir, { filter = () => true } = {}) {
  const absolute = path.join(ROOT, relativeDir);
  if (!existsSync(absolute)) return null;
  const digest = createHash("sha256");
  const names = readdirSync(absolute).filter(filter).sort();
  for (const name of names) {
    digest.update(name).update("\0");
    digest.update(hashFile(path.join(relativeDir, name)) ?? "");
  }
  return digest.digest("hex");
}

function fingerprint(entries) {
  const out = {};
  for (const entry of [...entries].sort()) {
    out[entry] = entry.endsWith("/") ? hashDirectory(entry.slice(0, -1)) : hashFile(entry);
  }
  return out;
}

export function ledgerPath(id) {
  return path.join(LEDGER_DIR, `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

export function readLedgerEntry(id) {
  const file = ledgerPath(id);
  if (!existsSync(file)) return null;
  const entry = JSON.parse(readFileSync(file, "utf8"));
  if (entry.schema !== LEDGER_SCHEMA) {
    throw new Error(`${path.relative(ROOT, file)}: unsupported ledger schema ${entry.schema}`);
  }
  return entry;
}

export function listLedgerEntries() {
  if (!existsSync(LEDGER_DIR)) return [];
  return readdirSync(LEDGER_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readLedgerEntry(name.slice(0, -5)))
    .filter(Boolean);
}

/**
 * Record a completed bake.
 *
 * @param {object} options
 * @param {string} options.id            Stable artifact id, e.g. "region-sutro-baths".
 * @param {string} options.label         Human name for check output.
 * @param {string} options.bake          The exact command that reproduces this artifact.
 * @param {boolean} options.tracked      Are the outputs committed to git? Untracked
 *                                       artifacts may be healed automatically; tracked
 *                                       ones must be rebaked and committed by a person,
 *                                       because the rebake is the change.
 * @param {string[]} options.inputs      Repo-relative paths. A trailing "/" means directory.
 * @param {string[]} options.outputs     Repo-relative paths, same convention.
 */
export function recordBake({ id, label, bake, tracked, inputs, outputs }) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  const entry = {
    schema: LEDGER_SCHEMA,
    id,
    label,
    bake,
    tracked,
    // Sorted keys and a trailing newline: this file is committed, and a stable
    // serialization keeps its diffs readable and its merges honest.
    inputs: fingerprint(inputs),
    outputs: fingerprint(outputs)
  };
  writeFileSync(ledgerPath(id), `${JSON.stringify(entry, null, 2)}\n`);
  return entry;
}

/**
 * Compare a recorded bake against what is on disk now.
 *
 * `stale` means an INPUT changed — the artifact needs rebaking. `dirty` means an
 * OUTPUT changed without a rebake being recorded, which is either a hand-edited
 * generated file or a bake somebody forgot to record; both are worth saying out
 * loud rather than silently re-hashing away.
 */
export function verifyEntry(entry) {
  const problems = [];
  const notes = [];
  // An input that is still a pointer is not drift, and it is not a build
  // problem either: the baked outputs are committed, so the app builds and runs
  // fine without ever fetching the source model. It only blocks a REBAKE. So it
  // is reported as a note and never fails anything — the alternative is a build
  // that breaks on every machine that has not pulled a gigabyte of .blend files
  // it does not need.
  for (const file of Object.keys(entry.inputs)) {
    if (!file.endsWith("/") && isUnsmudgedPointer(file)) {
      notes.push({
        kind: "lfs-pointer",
        file,
        detail: "LFS object not fetched here — run `git lfs pull` before baking this artifact"
      });
    }
  }
  for (const [file, recorded] of Object.entries(entry.inputs)) {
    const current = file.endsWith("/") ? hashDirectory(file.slice(0, -1)) : hashFile(file);
    if (current === recorded) continue;
    problems.push({
      kind: current === null ? "missing-input" : "stale",
      file,
      detail: current === null ? "input is missing" : "input changed since the last bake"
    });
  }
  for (const [file, recorded] of Object.entries(entry.outputs)) {
    const current = file.endsWith("/") ? hashDirectory(file.slice(0, -1)) : hashFile(file);
    if (current === recorded) continue;
    problems.push({
      kind: current === null ? "missing-output" : "dirty",
      file,
      detail: current === null ? "output is missing" : "output changed without a recorded bake"
    });
  }
  return { id: entry.id, label: entry.label, bake: entry.bake, tracked: entry.tracked, problems, notes };
}
