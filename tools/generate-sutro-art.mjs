#!/usr/bin/env node

// Generate hall plates by delegating to the Codex CLI's image tool.
//
//   node tools/generate-sutro-art.mjs --list
//   node tools/generate-sutro-art.mjs hall-toboggan-slides bill-sutro-railroad
//   node tools/generate-sutro-art.mjs --all --variants 2
//   node tools/generate-sutro-art.mjs --accept hall-toboggan-slides=.data/codex-art/hall-toboggan-slides/v1.png
//
// WHY A DELEGATE
// This machine has no image-generation API key of its own, but the Codex CLI
// ships inside the ChatGPT app and is already signed in, and its
// `image_generation` feature is enabled. So the brief goes to `codex exec` on
// stdin, the child generates and copies the file out, and we never see or pass
// a credential — the CLI owns its own auth.
//
// THE STAGING BOUNDARY
// The child runs with `-s workspace-write` rooted at .data/codex-art, so the
// only tree it can write is scratch. Nothing it produces reaches the repo until
// a human (or an agent that has actually LOOKED at the pixels) runs --accept,
// which is the one step that writes into assets-src/. Image models get
// typography wrong often enough that an unreviewed auto-accept would be a way
// to ship a misspelled poster onto a wall; there is deliberately no flag for it.
//
// Accepted plates are re-encoded to WebP q92 to match the archive convention in
// assets-src/sutro-hall-art/README.md, then `npm run build:sutro-hall-art`
// crops and publishes them to public/sutro/art/.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/**
 * Run a command with `text` on stdin, resolving with its exit status.
 *
 * Deliberately spawn rather than promisify(execFile): the async execFile has no
 * `input` option — it is silently ignored — and `codex exec -` blocks forever
 * reading a stdin nobody writes to or closes. Closing the pipe is the whole
 * point of this helper, so the child sees EOF and starts work.
 */
function runWithStdin(command, args, text, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s`, stdout, stderr });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: String(error.message ?? error), stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, error: code === 0 ? null : `exit ${code}`, stdout, stderr });
    });

    child.stdin.on("error", () => {
      /* the child may exit before the prompt is fully flushed */
    });
    child.stdin.end(text);
  });
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "assets-src/sutro-hall-art");
const BRIEFS = path.join(SOURCE, "briefs");
const STAGING = path.join(ROOT, ".data/codex-art");

/** Plate aspects, mirrored from tools/build-sutro-hall-art.mjs. */
const ASPECT = { wide: "LANDSCAPE 3:2", tall: "PORTRAIT 2:3" };

/**
 * Resolve the Codex binary. It is NOT on PATH: it ships inside the ChatGPT app
 * bundle, and the authoritative pointer is CODEX_CLI_PATH in the Codex config,
 * which moves with app versions — so read that before falling back to the
 * current known location.
 */
function resolveCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;

  const config = path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex"), "config.toml");
  if (existsSync(config)) {
    const match = readFileSync(config, "utf8").match(/^\s*CODEX_CLI_PATH\s*=\s*"([^"]+)"/m);
    if (match && existsSync(match[1])) return match[1];
  }

  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (existsSync(bundled)) return bundled;

  try {
    return execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "No Codex CLI found. Set CODEX_BIN, or check CODEX_CLI_PATH in ~/.codex/config.toml."
    );
  }
}

function briefNames() {
  if (!existsSync(BRIEFS)) return [];
  return readdirSync(BRIEFS)
    .filter((f) => f.endsWith(".txt") && !f.startsWith("_"))
    .map((f) => f.replace(/\.txt$/, ""))
    .sort();
}

/**
 * Compose the prompt exactly as the hand-run sessions did: the plate's own brief
 * followed by the shared style block. The shared block is what makes eight
 * independently generated plates read as one collection, so it is appended
 * verbatim and last, where it cannot be diluted by the subject text.
 */
function composePrompt(name, outFile) {
  const brief = path.join(BRIEFS, `${name}.txt`);
  if (!existsSync(brief)) throw new Error(`No brief for "${name}" at ${brief}`);
  const shared = path.join(BRIEFS, "_shared-style.txt");
  const style = existsSync(shared) ? readFileSync(shared, "utf8").trim() : "";

  // The first eight briefs were written for hand-run sessions and open with
  // their own "generate and copy to <absolute path>" preamble, pinned to the
  // worktree they were authored in. That path no longer exists and would fight
  // the one below, so everything before "Image brief" is dropped: the brief
  // proper starts there, and this file owns the delivery instruction.
  const raw = readFileSync(brief, "utf8").trim();
  const start = raw.search(/^Image brief/m);
  const body = start === -1 ? raw : raw.slice(start);

  return [
    "Generate ONE image with your image generation tool, then copy it to",
    outFile,
    "with `cp`. Reply with only the absolute path you wrote.",
    "",
    body,
    "",
    style
  ].join("\n");
}

async function generate(codex, name, variant, aspectHint) {
  const dir = path.join(STAGING, name);
  mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `v${variant}.png`);
  const prompt = composePrompt(name, outFile) + (aspectHint ? `\n\nAspect: ${aspectHint}.` : "");

  const started = Date.now();
  process.stdout.write(`  → ${name} v${variant} …\n`);
  const run = await runWithStdin(
    codex,
    [
      "exec",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-C",
      dir,
      "-o",
      path.join(dir, `v${variant}.last.txt`),
      "-"
    ],
    prompt,
    12 * 60_000
  );
  if (!run.ok) {
    return { name, variant, ok: false, error: `${run.error}: ${(run.stderr || run.stdout).slice(-300)}` };
  }

  if (!existsSync(outFile)) {
    return { name, variant, ok: false, error: "child reported success but wrote no file" };
  }
  const meta = await sharp(outFile).metadata();
  return {
    name,
    variant,
    ok: true,
    file: outFile,
    size: `${meta.width}x${meta.height}`,
    seconds: Math.round((Date.now() - started) / 1000)
  };
}

/** Contact sheet so a reviewer sees every variant of every plate at once. */
async function contactSheet(results, file) {
  const good = results.filter((r) => r.ok);
  if (!good.length) return null;
  const cols = Math.min(4, good.length);
  const rows = Math.ceil(good.length / cols);
  const cw = 480;
  const ch = 360;
  const tiles = await Promise.all(
    good.map((r) => sharp(r.file).resize(cw, ch, { fit: "contain", background: "#141414" }).toBuffer())
  );
  await sharp({ create: { width: cw * cols, height: ch * rows, channels: 3, background: "#141414" } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * cw, top: Math.floor(i / cols) * ch })))
    .png()
    .toFile(file);
  return file;
}

/** The one step that writes into the repo. Re-encodes to the archive format. */
async function accept(pairs) {
  mkdirSync(SOURCE, { recursive: true });
  for (const pair of pairs) {
    const [name, from] = pair.split("=");
    if (!name || !from) throw new Error(`--accept expects name=path, got "${pair}"`);
    const src = path.isAbsolute(from) ? from : path.join(ROOT, from);
    if (!existsSync(src)) throw new Error(`No such file: ${src}`);
    const dest = path.join(SOURCE, `${name}.webp`);
    await sharp(src).webp({ quality: 92 }).toFile(dest);
    const meta = await sharp(dest).metadata();
    process.stdout.write(`accepted ${name}: ${meta.width}x${meta.height} -> ${path.relative(ROOT, dest)}\n`);
  }
  process.stdout.write("\nNow run: npm run build:sutro-hall-art\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    for (const n of briefNames()) {
      const has = ["webp", "png"].some((e) => existsSync(path.join(SOURCE, `${n}.${e}`)));
      process.stdout.write(`${has ? "have" : "MISSING"}  ${n}\n`);
    }
    return;
  }

  const acceptAt = argv.indexOf("--accept");
  if (acceptAt !== -1) return accept(argv.slice(acceptAt + 1));

  const variantsAt = argv.indexOf("--variants");
  const variants = variantsAt === -1 ? 1 : Number(argv[variantsAt + 1] ?? 1);
  const aspectAt = argv.indexOf("--aspect");
  const aspect = aspectAt === -1 ? null : ASPECT[argv[aspectAt + 1]] ?? argv[aspectAt + 1];

  const flagged = new Set(["--variants", "--aspect"]);
  const names = argv.includes("--all")
    ? briefNames().filter((n) => !["webp", "png"].some((e) => existsSync(path.join(SOURCE, `${n}.${e}`))))
    : argv.filter((a, i) => !a.startsWith("--") && !flagged.has(argv[i - 1]));

  if (!names.length) {
    process.stdout.write("Nothing to generate. Use --list, --all, or name plates explicitly.\n");
    return;
  }

  const codex = resolveCodex();
  process.stdout.write(`codex: ${codex}\nplates: ${names.join(", ")}\nvariants: ${variants}\n\n`);

  const jobs = [];
  for (const name of names) for (let v = 1; v <= variants; v++) jobs.push({ name, variant: v });

  // Bounded concurrency: each child is a full model session, and swamping the
  // account with a dozen at once buys nothing over a steady few.
  const LIMIT = 4;
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(LIMIT, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        results.push(await generate(codex, job.name, job.variant, aspect));
      }
    })
  );

  results.sort((a, b) => a.name.localeCompare(b.name) || a.variant - b.variant);
  process.stdout.write("\n--- results ---\n");
  for (const r of results) {
    process.stdout.write(
      r.ok
        ? `  ok    ${r.name} v${r.variant}  ${r.size}  ${r.seconds}s  ${path.relative(ROOT, r.file)}\n`
        : `  FAIL  ${r.name} v${r.variant}  ${r.error}\n`
    );
  }

  mkdirSync(STAGING, { recursive: true });
  const sheet = await contactSheet(results, path.join(STAGING, "contact.png"));
  writeFileSync(path.join(STAGING, "results.json"), JSON.stringify(results, null, 2));
  if (sheet) process.stdout.write(`\ncontact sheet: ${path.relative(ROOT, sheet)}\n`);
  process.stdout.write("REVIEW THE PIXELS (typography especially), then --accept name=path\n");
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
