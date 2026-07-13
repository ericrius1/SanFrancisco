#!/usr/bin/env node

import { exportXDelivery } from "./cinematic/delivery.mjs";
import { relativeToRoot, stopCinematicProcesses } from "./cinematic/capture.mjs";

function usage() {
  return `
X delivery export for an existing cinematic MP4

Usage:
  npm run deliver:x -- renders/cinematics/roqn-open-road/roqn-open-road-fast.mp4
  npm run deliver:x -- <input.mp4> --experimental-4k --force

Options:
  --experimental-4k  Also make a 2x Lanczos A/B candidate; X support is not guaranteed
  --output-dir <dir>  Default renders/cinematics/delivery/x
  --force             Replace existing delivery files
  --help              Show this help
`.trim();
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = { inputFile: null, outputDir: undefined, experimental4k: false, force: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      if (options.inputFile) throw new Error(`unexpected positional argument ${JSON.stringify(argument)}`);
      options.inputFile = argument;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--experimental-4k") options.experimental4k = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--output-dir") {
      options.outputDir = valueAfter(argv, index, argument);
      index += 1;
    } else throw new Error(`unknown option ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.inputFile) throw new Error(`choose an input MP4\n\n${usage()}`);
  const report = await exportXDelivery(options);
  console.log(`\n${"─".repeat(72)}`);
  console.log("X DELIVERY — complete");
  for (const variant of report.variants) {
    console.log(`${variant.label.padEnd(25)} ${relativeToRoot(variant.outputFile)}`);
    console.log(`${"".padEnd(25)} ${(variant.bytes / 1_000_000).toFixed(1)} MB, SSIM ${variant.similarity.ssim?.toFixed(6) ?? "n/a"}`);
  }
  console.log(`${"manifest".padEnd(25)} ${relativeToRoot(report.manifestFile)}`);
  console.log(`${"─".repeat(72)}\n`);
}

main()
  .catch((error) => {
    console.error(`[delivery:x] ERROR: ${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  })
  .finally(() => stopCinematicProcesses());
