#!/usr/bin/env node

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderCinematicAudio } from "./cinematic/audio.mjs";
import {
  OUTPUT_ROOT,
  ROOT,
  WORK_ROOT,
  auditVideo,
  captureFastProduction,
  captureProduction,
  cinematicPaths,
  createReviewArtifacts,
  encodeProduction,
  fileExists,
  muxFastProduction,
  relativeToRoot,
  startVite,
  stopCinematicProcesses
} from "./cinematic/capture.mjs";
import { productionIds, resolveProduction } from "./cinematic/productions.mjs";
import { combineCinematics } from "./cinematic/transition.mjs";

const log = (message) => console.log(`[cinematic] ${message}`);

function usage() {
  return `
Deterministic San Francisco cinematic renderer

Usage:
  node tools/render-cinematic.mjs hoverboard --full
  node tools/render-cinematic.mjs hoverboard --fast
  node tools/render-cinematic.mjs dog-park --stills
  node tools/render-cinematic.mjs hoverboard --probe-at 2.4,7.1,12.35
  node tools/render-cinematic.mjs --all
  node tools/render-cinematic.mjs --combine
  node tools/render-cinematic.mjs --all --combine

Modes:
  --full               Capture every frame from zero, render audio, encode, and audit
  --fast               Browser WebCodecs review render; no PNG sequence (implies --full)
  --stills             Replay from zero and capture the production's review stills
  --probe-at <times>   Replay from zero and capture comma-separated times in seconds
  --all                Apply the selected mode to hoverboard and dog-park
  --combine            Combine existing/new individual films with the plume-to-play transition

Settings (environment equivalents use SF_CINE_*):
  --width <px>         Default 1920 (SF_CINE_WIDTH)
  --height <px>        Default 1080 (SF_CINE_HEIGHT)
  --fps <number>       Default 60 (SF_CINE_FPS)
  --format png|jpg     Master frame format; default png (SF_CINE_FORMAT)
  --jpeg-quality <n>   JPEG quality 1..100; default 95
  --crf <n>            H.264 CRF 14..16; default 15
  --fast-bitrate <n>   WebCodecs H.264 bitrate; default 24000000
  --take <name>        Output take name; default master
  --seed <integer>     Override the production's deterministic seed
  --settle-frames <n>  Zero-dt WebGPU/world pre-roll frames
  --settle-gap-ms <n>  Wall-time gap between settle frames
  --url <vite-url>     Use an existing Vite instead of a private server
  --help               Show this help

Outputs: renders/cinematics/**    Work/master frames: .data/cinematics/**
`.trim();
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function numeric(value, option) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${option} requires a finite number (received ${JSON.stringify(value)})`);
  return number;
}

function setMode(options, mode, flag) {
  if (options.mode && options.mode !== mode) throw new Error(`${flag} cannot be combined with --${options.mode}`);
  options.mode = mode;
}

function parseProbeTimes(value) {
  const values = String(value).split(",").map((part) => part.trim()).filter(Boolean);
  if (!values.length) throw new Error("--probe-at requires one or more comma-separated seconds");
  return values.map((part) => numeric(part, "--probe-at"));
}

function parseArgs(argv) {
  const options = {
    productionId: null,
    mode: null,
    all: false,
    combine: false,
    fast: false,
    probeAt: [],
    overrides: {},
    viteUrl: undefined,
    help: false
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      if (options.productionId) throw new Error(`unexpected positional argument ${JSON.stringify(argument)}`);
      options.productionId = argument;
      continue;
    }
    if (argument === "--help") options.help = true;
    else if (argument === "--full") setMode(options, "full", argument);
    else if (argument === "--fast") {
      options.fast = true;
      setMode(options, "full", argument);
    }
    else if (argument === "--stills") setMode(options, "stills", argument);
    else if (argument === "--all") options.all = true;
    else if (argument === "--combine") options.combine = true;
    else if (argument === "--png") options.overrides.frameFormat = "png";
    else if (argument === "--jpg" || argument === "--jpeg") options.overrides.frameFormat = "jpg";
    else if (argument.startsWith("--probe-at=")) {
      setMode(options, "probe", "--probe-at");
      options.probeAt.push(...parseProbeTimes(argument.slice(argument.indexOf("=") + 1)));
    } else if (argument === "--probe-at") {
      setMode(options, "probe", argument);
      options.probeAt.push(...parseProbeTimes(valueAfter(argv, index, argument)));
      index += 1;
    } else {
      const mappings = {
        "--width": ["width", true],
        "--height": ["height", true],
        "--fps": ["fps", true],
        "--format": ["frameFormat", false],
        "--jpeg-quality": ["jpegQuality", true],
        "--crf": ["crf", true],
        "--fast-bitrate": ["fastBitrate", true],
        "--take": ["take", false],
        "--seed": ["seed", true],
        "--settle-frames": ["settleFrames", true],
        "--settle-gap-ms": ["settleGapMs", true]
      };
      if (argument === "--url") {
        options.viteUrl = valueAfter(argv, index, argument);
        index += 1;
      } else if (mappings[argument]) {
        const [key, isNumeric] = mappings[argument];
        const raw = valueAfter(argv, index, argument);
        options.overrides[key] = isNumeric ? numeric(raw, argument) : raw;
        index += 1;
      } else {
        throw new Error(`unknown option ${argument}`);
      }
    }
  }

  if (options.all && options.productionId) throw new Error("choose a production id or --all, not both");
  if (options.productionId && !productionIds().includes(options.productionId)) {
    throw new Error(`unknown production ${JSON.stringify(options.productionId)}; choose ${productionIds().join(", ")}`);
  }
  if (options.mode === "probe" && !options.probeAt.length) throw new Error("--probe-at requires at least one time");
  if (options.fast && options.mode !== "full") throw new Error("--fast only supports full-film capture");
  if (options.fast && options.overrides.take === undefined) options.overrides.take = "fast";
  return options;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function renderFull(production, viteUrl, { fast = false } = {}) {
  const paths = cinematicPaths(production);
  if (fast) await captureFastProduction({ production, viteUrl, paths, log });
  else await captureProduction({ production, viteUrl, mode: "full", paths, log });

  log(`${production.id}: rendering picture-locked deterministic audio`);
  const audio = await renderCinematicAudio(production, paths.audioFile);
  log(`${production.id}: audio ${audio.rmsDb.toFixed(1)} dB RMS, ${audio.peakDb.toFixed(1)} dB peak`);

  const encoded = fast
    ? await muxFastProduction({ production, paths, audioFile: audio.file, log })
    : await encodeProduction({ production, paths, audioFile: audio.file, log });
  await createReviewArtifacts({
    videoFile: encoded.file,
    posterFile: paths.posterFile,
    contactFile: paths.contactFile,
    duration: production.duration,
    posterAt: production.posterAt,
    log
  });
  const audit = await auditVideo({
    videoFile: encoded.file,
    expected: production,
    auditFile: paths.auditFile,
    log
  });
  return { production, paths, audio, encoded, audit };
}

async function runCaptures(options, productions) {
  if (!options.mode || !productions.length) return [];
  const vite = await startVite({ url: options.viteUrl, log });
  const results = [];
  try {
    for (const production of productions) {
      if (options.mode === "full") {
        results.push(await renderFull(production, vite.url, { fast: options.fast }));
      } else {
        const capture = await captureProduction({
          production,
          viteUrl: vite.url,
          mode: options.mode,
          probeAt: options.probeAt,
          log
        });
        results.push({ production, paths: cinematicPaths(production), capture });
      }
    }
  } finally {
    await vite.close();
  }
  return results;
}

function combinedPaths(take) {
  const outputDir = path.join(OUTPUT_ROOT, "combined");
  const workDir = path.join(WORK_ROOT, "combined", take);
  const baseName = `hoverboard-to-dog-park-${take}`;
  return {
    outputDir,
    workDir,
    videoFile: path.join(outputDir, `${baseName}.mp4`),
    posterFile: path.join(outputDir, `${baseName}.poster.jpg`),
    contactFile: path.join(outputDir, `${baseName}.contact.jpg`),
    auditFile: path.join(outputDir, `${baseName}.audit.json`),
    manifestFile: path.join(outputDir, `${baseName}.manifest.json`)
  };
}

async function combineRendered(productionMap) {
  const hoverboard = productionMap.get("hoverboard");
  const dogPark = productionMap.get("dog-park");
  const hoverPaths = cinematicPaths(hoverboard);
  const dogPaths = cinematicPaths(dogPark);
  for (const source of [hoverPaths.videoFile, dogPaths.videoFile]) {
    if (!(await fileExists(source))) {
      throw new Error(`cannot combine: missing ${relativeToRoot(source)} (run --all first, or --all --combine)`);
    }
  }

  if (hoverboard.width !== dogPark.width || hoverboard.height !== dogPark.height || hoverboard.fps !== dogPark.fps) {
    throw new Error("combined productions must resolve to the same width, height, and fps");
  }
  const paths = combinedPaths(hoverboard.take);
  await mkdir(paths.workDir, { recursive: true });
  log("combined: rendering deterministic plume-to-play transition");
  const transition = await combineCinematics({
    hoverboardPath: hoverPaths.videoFile,
    dogParkPath: dogPaths.videoFile,
    outputPath: paths.videoFile,
    workDir: paths.workDir,
    fps: hoverboard.fps,
    width: hoverboard.width,
    height: hoverboard.height,
    ffmpeg: process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg"
  });

  const duration = Number(transition.expectedDuration ?? transition.duration);
  const totalFrames = Math.round(duration * hoverboard.fps);
  await createReviewArtifacts({
    videoFile: paths.videoFile,
    posterFile: paths.posterFile,
    contactFile: paths.contactFile,
    duration,
    posterAt: Math.min(hoverboard.posterAt, duration - 0.001),
    log
  });
  const audit = await auditVideo({
    videoFile: paths.videoFile,
    expected: {
      width: hoverboard.width,
      height: hoverboard.height,
      fps: hoverboard.fps,
      duration,
      totalFrames
    },
    auditFile: paths.auditFile,
    log
  });
  const info = await stat(paths.videoFile);
  await writeJson(paths.manifestFile, {
    schema: 1,
    id: "hoverboard-to-dog-park",
    sources: [path.relative(ROOT, hoverPaths.videoFile), path.relative(ROOT, dogPaths.videoFile)],
    output: path.relative(ROOT, paths.videoFile),
    bytes: info.size,
    width: hoverboard.width,
    height: hoverboard.height,
    fps: hoverboard.fps,
    duration,
    totalFrames,
    transition,
    audit: { file: path.relative(ROOT, paths.auditFile), status: audit.status }
  });
  return { paths, transition, audit };
}

function printSummary(results, combined) {
  console.log(`\n${"─".repeat(72)}`);
  console.log("CINEMATIC PIPELINE — complete");
  console.log("─".repeat(72));
  for (const result of results) {
    if (result.encoded) {
      console.log(`${result.production.id.padEnd(12)} ${relativeToRoot(result.paths.videoFile)}`);
      console.log(`${"".padEnd(12)} poster ${relativeToRoot(result.paths.posterFile)}`);
      console.log(`${"".padEnd(12)} contact ${relativeToRoot(result.paths.contactFile)}`);
      console.log(`${"".padEnd(12)} audit ${result.audit.status}, audio ${result.audit.measured.audioRmsDb.toFixed(1)} dB RMS`);
    } else {
      console.log(`${result.production.id.padEnd(12)} ${result.capture.manifest.capture.mode}: ${relativeToRoot(result.capture.captureDir)}`);
    }
  }
  if (combined) {
    console.log(`${"combined".padEnd(12)} ${relativeToRoot(combined.paths.videoFile)}`);
    console.log(`${"".padEnd(12)} transition ${combined.transition.transitionDuration.toFixed(2)}s, audit ${combined.audit.status}`);
  }
  console.log(`${"─".repeat(72)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.productionId && !options.all && !options.combine) {
    throw new Error(`choose a production, --all, or --combine\n\n${usage()}`);
  }

  // A named production or --all defaults to a full render. Bare --combine is
  // deliberately composition-only and reuses already audited individual films.
  if (!options.mode && (options.productionId || options.all)) options.mode = "full";
  if (!options.mode && options.combine && options.productionId) options.mode = "full";
  if (options.mode && options.combine && !options.productionId && !options.all) options.all = true;

  const ids = options.all ? productionIds() : options.productionId ? [options.productionId] : [];
  const productionMap = new Map(productionIds().map((id) => [
    id,
    resolveProduction(id, { overrides: options.overrides })
  ]));
  const selected = ids.map((id) => productionMap.get(id));
  const results = await runCaptures(options, selected);
  const combined = options.combine ? await combineRendered(productionMap) : null;
  printSummary(results, combined);
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.error(`[cinematic] ${signal}; stopping Chrome/Vite`);
    await stopCinematicProcesses();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

main()
  .catch((error) => {
    console.error(`[cinematic] ERROR: ${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  })
  .finally(() => stopCinematicProcesses());
