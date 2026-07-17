/**
 * Guards the single-AudioContext invariant.
 *
 * Every `new AudioContext()` / `webkitAudioContext` in src/ must live in a file
 * on the ALLOWLIST. The consolidation is complete: the only permitted site is
 * engine.ts, which owns the app's one shared context. Every feature rides that
 * context via `audioEngine.bus()`. `OfflineAudioContext` (offline render) is
 * always allowed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

// The single permanent invariant: only the engine may construct a context.
const ALLOWLIST = new Set(["src/audio/engine.ts"]);

// Strip OfflineAudioContext so its "AudioContext(" substring never trips us.
const PATTERN = /new\s+(?:window\.)?(?:webkit)?AudioContext\s*\(|webkitAudioContext/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

const offenders = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).split("\\").join("/");
  if (ALLOWLIST.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const stripped = line.replace(/OfflineAudioContext/g, "");
    if (PATTERN.test(stripped)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}

if (offenders.length > 0) {
  console.error("audio-context-guard: AudioContext constructed outside the allowlist:");
  for (const o of offenders) console.error("  " + o);
  console.error("\nFeatures must get their context from src/audio/engine.ts (audioEngine.bus()).");
  process.exit(1);
}

console.log("audio-context-guard: ok (all AudioContext sites on the allowlist)");
