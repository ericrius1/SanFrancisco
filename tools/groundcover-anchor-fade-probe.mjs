// Drives the WebGPU-only rendered regression in groundcover-anchor-fade-probe.html.
// It launches an isolated Vite server and Chrome profile, then fails unless the
// production shared grass and flower positionNode graphs retain
// full/half/zero pixels at a large world coordinate.
//
//   node tools/groundcover-anchor-fade-probe.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "/tools/groundcover-anchor-fade-probe.html";
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

async function waitHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  const chrome = candidates.find((candidate) => !candidate.includes("/") || existsSync(candidate));
  if (!chrome) throw new Error("No Chrome/Chromium executable found. Set CHROME_BIN to run the WebGPU probe.");
  return chrome;
}

class Cdp {
  #ws;
  #id = 1;
  #pending = new Map();
  diagnostics = [];

  constructor(url) {
    this.#ws = new WebSocket(url);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener("open", resolve, { once: true });
      this.#ws.addEventListener("error", reject, { once: true });
    });
    this.#ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.method === "Runtime.exceptionThrown") {
        this.diagnostics.push(message.params?.exceptionDetails?.text ?? "browser exception");
      }
      if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
        this.diagnostics.push(message.params.entry.text);
      }
      if (!message.id || !this.#pending.has(message.id)) return;
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (response.exceptionDetails) {
      throw new Error(`Browser evaluation failed: ${JSON.stringify(response.exceptionDetails).slice(0, 1200)}`);
    }
    return response.result?.value;
  }

  close() {
    this.#ws.close();
  }
}

const vitePort = await freePort();
const relayPort = await freePort();
const debugPort = await freePort();
const vite = spawn(
  "npx",
  ["vite", "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"],
  {
    cwd: ROOT,
    env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
    stdio: ["ignore", "ignore", "inherit"]
  }
);

let chrome;
let cdp;
try {
  const url = `http://127.0.0.1:${vitePort}${FIXTURE}`;
  await waitHttp(url, 45_000);

  chrome = spawn(findChrome(), [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "groundcover-fade-probe-"))}`,
    "--headless=new",
    "--no-first-run",
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--window-size=400,400",
    "about:blank"
  ], { stdio: "ignore" });

  let version;
  for (let attempt = 0; attempt < 75 && !version; attempt++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error("Chrome DevTools endpoint never became available.");

  const page = await (
    await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })
  ).json();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.navigate", { url });

  const started = Date.now();
  let result;
  while (Date.now() - started < 120_000) {
    result = await cdp.evaluate("window.__probeResult ?? null").catch(() => null);
    if (result) break;
    await sleep(300);
  }
  if (!result) {
    const diagnostic = cdp.diagnostics.length ? ` Browser errors: ${cdp.diagnostics.join(" | ")}` : "";
    throw new Error(`Ground-cover probe never produced a result.${diagnostic}`);
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.unavailable) {
    console.error(`WebGPU unavailable: ${result.error}`);
    process.exitCode = 1;
  } else if (!result.ok) {
    console.error("Ground-cover anchor fade regression FAILED.");
    process.exitCode = 1;
  } else {
    console.log("Ground-cover anchor fade regression passed on WebGPU.");
  }
} finally {
  cdp?.close();
  chrome?.kill("SIGTERM");
  vite.kill("SIGTERM");
}
