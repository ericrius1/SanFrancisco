#!/usr/bin/env node
// Press-play launcher for a worktree preview.
//
// The whole point is that running it TWICE is fine. `vite --strictPort` is
// correct but unforgiving: the first launch leaves a server on the port, and
// the second one dies with "Port NNNN is already in use" — which is what the
// bare command in a handoff message does to you every second time.
//
// So: if something is already serving THIS worktree on that port, just open the
// browser at it. If the port is held by something that is NOT this worktree,
// say so plainly and stop, because silently opening another worktree's build is
// how you end up reviewing the wrong code. Only start a server when the port is
// genuinely free.
//
//   node tools/play.mjs --port 5264 --open "/?autostart=1&spawn=skatePlaza"
//
// Options:
//   --port <n>      dev server port (required)
//   --relay <n>     relay port (default: port + 3000)
//   --open <path>   path to open in the browser (default "/?autostart=1")
//   --marker <path> file the server must serve to prove it is this worktree
//   --contains <s>  string the served file must contain. Must be CODE, not a
//                   comment: vite transforms TS through esbuild, which strips
//                   comments, so a doc-comment phrase never survives the wire.
//   --no-open       start/attach without launching a browser
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const PORT = Number(arg("port", ""));
if (!Number.isInteger(PORT) || PORT < 1024) {
  console.error("usage: node tools/play.mjs --port <n> [--open <path>] [--marker <path>]");
  process.exit(2);
}
const RELAY = Number(arg("relay", String(PORT + 3000)));
const OPEN_PATH = arg("open", "/?autostart=1");
const MARKER = arg("marker", "/src/vehicles/skate/streetSpots.ts");
const CONTAINS = arg("contains", "SkateStreetSpots");
const BASE = `http://localhost:${PORT}`;

/**
 * Does a live server on this port serve OUR tree, as a vite dev server?
 *
 * Three things have to hold, because each one alone has a false positive:
 * `/@vite/client` proves it is a dev server at all (a stray `python -m
 * http.server` answers everything else), the marker path proves the branch is
 * present, and the content check proves it is the version we expect rather
 * than a stale sibling worktree.
 */
async function servesThisWorktree() {
  try {
    const opts = { cache: "no-store", signal: AbortSignal.timeout(2500) };
    const vite = await fetch(`${BASE}/@vite/client`, opts);
    if (!vite.ok) return false;
    const res = await fetch(`${BASE}${MARKER}`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    if (!CONTAINS) return true;
    return (await res.text()).includes(CONTAINS);
  } catch {
    return false;
  }
}
async function portAnswers() {
  try {
    await fetch(BASE, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
}
function openBrowser() {
  if (flag("no-open")) return;
  const url = `${BASE}${OPEN_PATH}`;
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  console.log(`[play] opened ${url}`);
}

async function main() {
  if (await servesThisWorktree()) {
    console.log(`[play] reusing the server already running on ${PORT} (it serves this worktree)`);
    openBrowser();
    return;
  }
  if (await portAnswers()) {
    console.error(
      `[play] port ${PORT} is held by a server that is NOT this worktree.\n` +
        `       Refusing to open it — you would be looking at someone else's build.\n` +
        `       Either stop it:  kill $(lsof -ti :${PORT})\n` +
        `       or pick another: node tools/play.mjs --port ${PORT + 2} --open "${OPEN_PATH}"`
    );
    process.exit(1);
  }

  console.log(`[play] starting dev server on ${PORT} (relay ${RELAY})`);
  const dev = spawn("npm", ["run", "dev", "--", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, SF_RELAY_PORT: String(RELAY) },
    stdio: "inherit"
  });
  dev.on("exit", (code) => process.exit(code ?? 0));
  const onStop = () => dev.kill("SIGINT");
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  // Open only once it can actually serve the app.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await servesThisWorktree()) {
      openBrowser();
      return;
    }
    await sleep(500);
  }
  console.error("[play] server did not come up within 120s — see the output above");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
