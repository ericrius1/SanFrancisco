// Headless state-machine probe for Command's momentary pointer-lock release.
// The browser API is mocked so the timing-sensitive quick-tap path can be
// exercised even though headless Chromium cannot grant real pointer lock.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Vite did not become ready: ${url}`);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const chrome = candidates.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");
  return chrome;
}

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const vite = spawn(path.join(ROOT, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: ROOT,
  env: { ...process.env, SF_RELAY_PORT: "8788" },
  stdio: "ignore",
  detached: true
});

let browser;
try {
  await waitHttp(url);
  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const page = await browser.newPage();
  // Keep the production startup out of this narrow input-state probe.
  await page.route("**/src/startup.ts*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" })
  );
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const results = await page.evaluate(async () => {
    const { Input } = await import("/src/core/input.ts");
    const canvas = document.createElement("canvas");
    document.body.append(canvas);

    let pointerElement = canvas;
    let exitCalls = 0;
    let requestCalls = 0;
    let deferExit = false;
    let exitPending = false;

    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: () => pointerElement
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true
    });
    Object.defineProperty(document, "exitPointerLock", {
      configurable: true,
      value: () => {
        exitCalls++;
        if (deferExit) {
          exitPending = true;
          return;
        }
        pointerElement = null;
        queueMicrotask(() => document.dispatchEvent(new Event("pointerlockchange")));
      }
    });
    Object.defineProperty(canvas, "requestPointerLock", {
      configurable: true,
      value: () => {
        requestCalls++;
        pointerElement = canvas;
        queueMicrotask(() => document.dispatchEvent(new Event("pointerlockchange")));
        return Promise.resolve();
      }
    });

    const input = new Input(canvas);
    input.locked = true;
    const settle = async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const meta = (type, code, location) =>
      window.dispatchEvent(new KeyboardEvent(type, {
        key: "Meta",
        code,
        location,
        bubbles: true
      }));
    const metaLeft = (type) => meta(type, "MetaLeft", KeyboardEvent.DOM_KEY_LOCATION_LEFT);
    const metaRight = (type) => meta(type, "MetaRight", KeyboardEvent.DOM_KEY_LOCATION_RIGHT);
    const flushExit = async () => {
      if (!exitPending) throw new Error("expected a deferred pointer-lock exit");
      exitPending = false;
      pointerElement = null;
      document.dispatchEvent(new Event("pointerlockchange"));
      await settle();
    };
    const ensureLocked = async () => {
      if (!input.locked || pointerElement !== canvas) {
        input.requestLock();
        await settle();
      }
      if (!input.locked || pointerElement !== canvas) throw new Error("probe could not establish lock");
    };
    const ensureUnlocked = async () => {
      if (input.locked || pointerElement === canvas) {
        input.releaseLock();
        await settle();
      }
      if (input.locked || pointerElement) throw new Error("probe could not release lock");
    };
    const checks = [];
    const check = (name, condition, detail) => {
      if (!condition) throw new Error(`${name}: ${detail}`);
      checks.push(name);
    };

    // Ordinary hold: down releases and up restores exactly once.
    let exitBefore = exitCalls;
    let requestBefore = requestCalls;
    metaLeft("keydown");
    await settle();
    check("hold-unlocks", !input.locked && !pointerElement && input.momentaryCursor, `locked=${input.locked} cursor=${input.momentaryCursor}`);
    metaLeft("keyup");
    await settle();
    check("release-relocks", input.locked && pointerElement === canvas && !input.momentaryCursor, `locked=${input.locked} cursor=${input.momentaryCursor}`);
    check("single-transition", exitCalls === exitBefore + 1 && requestCalls === requestBefore + 1, `exit=${exitCalls - exitBefore} request=${requestCalls - requestBefore}`);

    // Command pressed while already unlocked must not manufacture a lock.
    await ensureUnlocked();
    exitBefore = exitCalls;
    requestBefore = requestCalls;
    metaLeft("keydown");
    metaLeft("keyup");
    await settle();
    check("unlocked-stays-unlocked", !input.locked && !pointerElement && requestCalls === requestBefore && exitCalls === exitBefore, `exit=${exitCalls - exitBefore} request=${requestCalls - requestBefore}`);

    // A newer overlay/UI release during the hold cancels automatic capture.
    await ensureLocked();
    requestBefore = requestCalls;
    metaLeft("keydown");
    await settle();
    input.releaseLock();
    metaLeft("keyup");
    await settle();
    check("ui-release-cancels-relock", !input.locked && !pointerElement && requestCalls === requestBefore, `request=${requestCalls - requestBefore}`);

    // Quick taps wait for the old asynchronous exit before requesting again.
    await ensureLocked();
    deferExit = true;
    requestBefore = requestCalls;
    metaLeft("keydown");
    metaLeft("keyup");
    await settle();
    check("quick-tap-waits-for-exit", requestCalls === requestBefore && input.momentaryCursor, `request=${requestCalls - requestBefore} cursor=${input.momentaryCursor}`);
    deferExit = false;
    await flushExit();
    check("quick-tap-relocks-after-exit", input.locked && pointerElement === canvas && requestCalls === requestBefore + 1 && !input.momentaryCursor, `locked=${input.locked} request=${requestCalls - requestBefore}`);

    // Both physical Command keys participate in the hold.
    requestBefore = requestCalls;
    metaLeft("keydown");
    await settle();
    metaRight("keydown");
    metaLeft("keyup");
    await settle();
    check("dual-command-keeps-cursor", !input.locked && input.momentaryCursor && requestCalls === requestBefore, `locked=${input.locked} request=${requestCalls - requestBefore}`);
    metaRight("keyup");
    await settle();
    check("dual-command-final-release-relocks", input.locked && requestCalls === requestBefore + 1, `locked=${input.locked} request=${requestCalls - requestBefore}`);

    // Capture requests made during the clutch defer until physical release.
    await ensureUnlocked();
    requestBefore = requestCalls;
    metaLeft("keydown");
    input.requestLock();
    await settle();
    check("request-defers-during-hold", !input.locked && requestCalls === requestBefore, `locked=${input.locked} request=${requestCalls - requestBefore}`);
    metaLeft("keyup");
    await settle();
    check("deferred-request-runs-on-release", input.locked && requestCalls === requestBefore + 1, `locked=${input.locked} request=${requestCalls - requestBefore}`);

    // Focus loss handles Command-Tab / swallowed keyup without surprise re-lock.
    requestBefore = requestCalls;
    metaLeft("keydown");
    await settle();
    window.dispatchEvent(new Event("blur"));
    metaLeft("keyup");
    await settle();
    check("blur-cancels-relock", !input.locked && !pointerElement && requestCalls === requestBefore && !input.momentaryCursor, `locked=${input.locked} request=${requestCalls - requestBefore}`);

    return checks;
  });

  for (const name of results) console.log(`PASS ${name}`);
  console.log(`Command pointer-lock probe passed (${results.length} checks)`);
} finally {
  await browser?.close();
  try {
    process.kill(-vite.pid, "SIGTERM");
  } catch {
    vite.kill("SIGTERM");
  }
}
