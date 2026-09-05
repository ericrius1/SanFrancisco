#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const required = (name) => {
  const value = args.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

const input = resolve(required("--input"));
const outputRoot = resolve(args.get("--output") ?? "public/audio/music");
const id = required("--id");
const profile = required("--profile");
const title = required("--title");
const sourceSongId = required("--source-id");
const bpm = Number(required("--bpm"));
const key = required("--key");
const loopStartSeconds = Number(args.get("--loop-start") ?? 8);
const requestedLoopEnd = Number(args.get("--loop-end") ?? Number.POSITIVE_INFINITY);
const output = join(outputRoot, id);

const AUDIO_EXTENSIONS = new Set([".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg"]);
const sourceFiles = readdirSync(input)
  .filter((name) => AUDIO_EXTENSIONS.has(extname(name).toLowerCase()))
  .sort();
if (!sourceFiles.length) throw new Error(`no audio files found in ${input}`);
mkdirSync(output, { recursive: true });

const slug = (value) => value
  .toLowerCase()
  .replace(/\.[^.]+$/, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "") || "stem";

const roleFor = (name) => {
  const s = name.toLowerCase();
  if (/drum|percussion|kick|snare|cymbal/.test(s)) return "drums";
  if (/bass|sub/.test(s)) return "bass";
  if (/lead|melody|solo|flute|sax|woodwind|vocal/.test(s)) return "melody";
  if (/fx|other|ambience|atmos|noise/.test(s)) return "texture";
  if (/guitar|piano|keyboard|keys|synth|string|brass|organ|rhodes|pad/.test(s)) return "harmony";
  return "accent";
};

const gainFor = (role) => ({
  drums: 0.82,
  bass: 0.78,
  harmony: 0.76,
  melody: 0.68,
  texture: 0.7,
  accent: 0.58
})[role];

const durationOf = (path) => Number(execFileSync("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1",
  path
], { encoding: "utf8" }).trim());

const stems = [];
let shortest = Number.POSITIVE_INFINITY;
for (let index = 0; index < sourceFiles.length; index++) {
  const sourceName = sourceFiles[index];
  const sourcePath = join(input, sourceName);
  const stemId = `${String(index + 1).padStart(2, "0")}-${slug(sourceName)}`;
  const outputName = `${stemId}.m4a`;
  const outputPath = join(output, outputName);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", sourcePath,
    "-vn", "-map_metadata", "-1",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath
  ], { stdio: "inherit" });
  const duration = durationOf(outputPath);
  shortest = Math.min(shortest, duration);
  const role = roleFor(sourceName);
  stems.push({
    id: stemId,
    role,
    url: `/audio/music/${id}/${outputName}`,
    gain: gainFor(role)
  });
}

const loopEndSeconds = Math.max(
  loopStartSeconds + 12,
  Math.min(requestedLoopEnd, shortest - 5)
);
const set = {
  id,
  title,
  profile,
  bpm,
  key,
  durationSeconds: Number(shortest.toFixed(3)),
  loopStartSeconds,
  loopEndSeconds: Number(loopEndSeconds.toFixed(3)),
  sourceSongId,
  stems
};
writeFileSync(join(output, "set.json"), `${JSON.stringify(set, null, 2)}\n`);
console.log(`[living-score] ${id}: ${stems.length} stems × ${shortest.toFixed(1)}s`);
console.log(join(output, "set.json"));
