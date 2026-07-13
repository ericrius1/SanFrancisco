#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderCinematicAudio } from "./cinematic/audio.mjs";
import {
  REVIEW_ROOT,
  ROOT,
  auditVideo,
  captureFastProduction,
  cinematicPaths,
  createReviewArtifacts,
  fileExists,
  muxFastProduction,
  publishVideo,
  relativeToRoot,
  startVite,
  stopCinematicProcesses
} from "./cinematic/capture.mjs";
import { exportXDelivery } from "./cinematic/delivery.mjs";
import { resolveProduction } from "./cinematic/productions.mjs";
import {
  TWITTER_SUMMER_TRANSITIONS,
  assembleTwitterSummer,
  createTwitterSummerTransitionReview
} from "./cinematic/twitterSummerAssembly.mjs";

const IDS = Object.freeze(Array.from({ length: 8 }, (_, index) => `twitter-summer-${String(index + 1).padStart(2, "0")}`));
const FINAL_DURATION = 55;
const log = (message) => console.log(`[twitter-summer] ${message}`);

function usage() {
  return `
Render the eight-shot, 55-second Twitter Summer film

Usage:
  npm run render:twitter-summer
  npm run render:twitter-summer -- --reuse-shots

Options:
  --reuse-shots      Reuse individually audited shot MP4s when present
  --experimental-4k  Also generate the unsupported 2x X delivery experiment
  --skip-delivery    Stop after the audited 1080p60 master
  --help             Show this help
`.trim();
}

function parseArgs(argv) {
  const options = { reuseShots: false, experimental4k: false, skipDelivery: false, help: false };
  for (const argument of argv) {
    if (argument === "--reuse-shots") options.reuseShots = true;
    else if (argument === "--experimental-4k") options.experimental4k = true;
    else if (argument === "--skip-delivery") options.skipDelivery = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown option ${argument}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function reusableShot(production, paths) {
  if (!(await fileExists(paths.videoFile)) || !(await fileExists(paths.auditFile))) return null;
  try {
    const audit = await readJson(paths.auditFile);
    if (audit.status === "failed" || Number(audit.expected?.duration) !== production.duration) return null;
    const frames = await readJson(paths.outputManifest);
    const info = await stat(paths.videoFile);
    return {
      id: production.id,
      reused: true,
      videoFile: paths.videoFile,
      bytes: info.size,
      captureWallSeconds: Number(frames.wallSeconds ?? 0),
      auditStatus: audit.status
    };
  } catch {
    return null;
  }
}

async function renderShot(production, viteUrl, { reuseShots }) {
  const paths = cinematicPaths(production);
  if (reuseShots) {
    const reused = await reusableShot(production, paths);
    if (reused) {
      log(`${production.id}: reusing ${relativeToRoot(paths.videoFile)}`);
      return reused;
    }
  }

  const startedAt = performance.now();
  const capture = await captureFastProduction({ production, viteUrl, paths, log });
  log(`${production.id}: rendering picture-locked score movement`);
  const audio = await renderCinematicAudio(production, paths.audioFile);
  const encoded = await muxFastProduction({ production, paths, audioFile: audio.file, log });
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
  const info = await stat(encoded.file);
  return {
    id: production.id,
    reused: false,
    videoFile: encoded.file,
    bytes: info.size,
    captureWallSeconds: capture.manifest.wallSeconds,
    totalWallSeconds: (performance.now() - startedAt) / 1000,
    audioRmsDb: audio.rmsDb,
    auditStatus: audit.status
  };
}

function finalPaths() {
  const outputDir = path.join(REVIEW_ROOT, "twitter-summer");
  const base = path.join(outputDir, "twitter-summer-master");
  return {
    outputDir,
    videoFile: `${base}.mp4`,
    posterFile: `${base}.poster.jpg`,
    contactFile: `${base}.contact.jpg`,
    auditFile: `${base}.audit.json`,
    manifestFile: `${base}.manifest.json`
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const runStartedAt = new Date();
  const runClock = performance.now();
  const productions = IDS.map((id) => resolveProduction(id, { overrides: { take: "fast" } }));
  const shots = [];
  let vite = null;
  try {
    for (const production of productions) {
      if (options.reuseShots) {
        const reused = await reusableShot(production, cinematicPaths(production));
        if (reused) {
          log(`${production.id}: reusing ${relativeToRoot(reused.videoFile)}`);
          shots.push(reused);
          continue;
        }
      }
      vite ??= await startVite({ log });
      shots.push(await renderShot(production, vite.url, { ...options, reuseShots: false }));
    }
  } finally {
    await vite?.close();
  }

  const paths = finalPaths();
  await mkdir(paths.outputDir, { recursive: true });
  const assemblyStarted = performance.now();
  const assembly = await assembleTwitterSummer({
    clips: shots.map((shot) => shot.videoFile),
    outputFile: paths.videoFile,
    width: productions[0].width,
    height: productions[0].height,
    fps: productions[0].fps,
    log
  });
  const assemblyWallSeconds = (performance.now() - assemblyStarted) / 1000;
  await createReviewArtifacts({
    videoFile: paths.videoFile,
    posterFile: paths.posterFile,
    contactFile: paths.contactFile,
    duration: FINAL_DURATION,
    posterAt: 49.2,
    log
  });
  const transitionReview = await createTwitterSummerTransitionReview({
    videoFile: paths.videoFile,
    outputDir: path.join(paths.outputDir, "transition-review"),
    transitions: assembly.transitions,
    log
  });
  const audit = await auditVideo({
    videoFile: paths.videoFile,
    expected: {
      width: productions[0].width,
      height: productions[0].height,
      fps: productions[0].fps,
      duration: FINAL_DURATION,
      totalFrames: FINAL_DURATION * productions[0].fps
    },
    auditFile: paths.auditFile,
    log
  });
  const masterInfo = await stat(paths.videoFile);
  const publishedMaster = await publishVideo(paths.videoFile, {
    filename: "twitter-summer-master.mp4",
    log
  });

  let delivery = null;
  if (!options.skipDelivery) {
    delivery = await exportXDelivery({
      inputFile: paths.videoFile,
      experimental4k: options.experimental4k,
      force: true,
      log
    });
  }
  const report = {
    schema: 1,
    id: "twitter-summer",
    title: "Summer in Motion",
    startedAt: runStartedAt.toISOString(),
    completedAt: new Date().toISOString(),
    wallSeconds: (performance.now() - runClock) / 1000,
    duration: FINAL_DURATION,
    width: productions[0].width,
    height: productions[0].height,
    fps: productions[0].fps,
    totalFrames: FINAL_DURATION * productions[0].fps,
    cleanPlate: true,
    shots: shots.map((shot, index) => ({ ...shot, index: index + 1, videoFile: path.relative(ROOT, shot.videoFile) })),
    transitions: TWITTER_SUMMER_TRANSITIONS,
    transitionReview,
    assembly: { ...assembly, wallSeconds: assemblyWallSeconds },
    master: {
      file: path.relative(ROOT, paths.videoFile),
      published: publishedMaster.file,
      bytes: masterInfo.size,
      poster: path.relative(ROOT, paths.posterFile),
      contact: path.relative(ROOT, paths.contactFile),
      audit: path.relative(ROOT, paths.auditFile),
      auditStatus: audit.status
    },
    xDelivery: delivery ? {
      manifest: path.relative(ROOT, delivery.manifestFile),
      variants: delivery.variants.map((variant) => ({
        id: variant.id,
        file: variant.publishedFile,
        bytes: variant.bytes,
        ssim: variant.similarity.ssim
      }))
    } : null
  };
  await writeFile(paths.manifestFile, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${"─".repeat(76)}`);
  console.log("SUMMER IN MOTION — complete");
  for (const shot of shots) {
    console.log(`${shot.id.padEnd(20)} capture ${shot.captureWallSeconds.toFixed(1).padStart(6)}s  ${shot.reused ? "reused" : shot.auditStatus}`);
  }
  console.log(`${"assembly".padEnd(20)} ${assemblyWallSeconds.toFixed(1).padStart(6)}s  ${audit.status}`);
  console.log(`${"master".padEnd(20)} ${relativeToRoot(publishedMaster.file)}`);
  if (delivery) for (const variant of delivery.variants) console.log(`${variant.id.padEnd(20)} ${relativeToRoot(variant.publishedFile)}`);
  console.log(`${"total wall".padEnd(20)} ${report.wallSeconds.toFixed(1)}s`);
  console.log(`${"─".repeat(76)}\n`);
}

main()
  .catch((error) => {
    console.error(`[twitter-summer] ERROR: ${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  })
  .finally(() => stopCinematicProcesses());
