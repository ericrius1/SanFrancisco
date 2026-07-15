// Headless visual/layout probe for the Behind-the-scenes foliage chapter.
// Opens the real deep link, captures the major diagrams at desktop width, and
// fails on runtime exceptions or horizontal overflow.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = Number(process.env.SF_PROBE_WIDTH ?? 1440);
const HEIGHT = Number(process.env.SF_PROBE_HEIGHT ?? 1100);
const OUT = path.join(ROOT, WIDTH === 1440 ? ".data/bts-foliage" : `.data/bts-foliage-${WIDTH}`);
const BASE = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5196";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

class Cdp {
  #socket;
  #id = 1;
  #pending = new Map();
  constructor(url) { this.#socket = new WebSocket(url); }
  async open() {
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", reject, { once: true });
    });
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (!message.id) { this.onEvent?.(message); return; }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }
  close() { this.#socket.close(); }
}

const evaluate = async (cdp, expression) => {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};

const chromePath = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error("Chrome not found");

mkdirSync(OUT, { recursive: true });
const port = await freePort();
const chrome = spawn(chromePath, [
  `--user-data-dir=${path.join(OUT, `chrome-${process.pid}`)}`,
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--enable-unsafe-webgpu",
  "--use-angle=metal",
  "--hide-scrollbars",
  "--mute-audio",
  `--window-size=${WIDTH},${HEIGHT}`,
  `${BASE}/?autostart=1&read=bts.foliage`
], { cwd: ROOT, stdio: "ignore" });

let page;
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await sleep(250);
}
if (!page) throw new Error("Chrome page not found");

const cdp = new Cdp(page.webSocketDebuggerUrl);
const errors = [];
cdp.onEvent = (message) => {
  if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  }
};
await cdp.open();
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false
});

let ready = false;
for (let attempt = 0; attempt < 240; attempt++) {
  ready = await evaluate(cdp, `!!document.querySelector('.bts-overlay.open [data-pane="foliage"].active')`).catch(() => false);
  if (ready) break;
  await sleep(250);
}
if (!ready) throw new Error("foliage chapter did not open");
await sleep(800);

const targets = [
  ["top", ".bts-pane.active"],
  ["forest", ".scrolly"],
  ["lod", '[data-ftoy="lodDial"]'],
  ["gpu-meadow", '[data-ftoy="gpuMeadow"]'],
  ["measure", ".bts-pane.active section:nth-last-of-type(2)"]
];
for (const [name, selector] of targets) {
  await evaluate(cdp, `(() => {
    const body = document.querySelector('.bts-body');
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!body || !target) return false;
    body.scrollTop = Math.max(0, target.offsetTop - body.offsetTop - 28);
    if (${JSON.stringify(name)} === 'gpu-meadow') target.querySelector('[data-el="run"]')?.click();
    return true;
  })()`);
  await sleep(name === "gpu-meadow" ? 2100 : 450);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, "base64"));
}

const layout = await evaluate(cdp, `(() => ({
  body: (() => { const e = document.querySelector('.bts-body'); return { clientWidth:e.clientWidth, scrollWidth:e.scrollWidth, clientHeight:e.clientHeight, scrollHeight:e.scrollHeight }; })(),
  toys: [...document.querySelectorAll('[data-pane="foliage"] .ss-interactive')].map(e => ({
    name:e.dataset.ftoy, width:Math.round(e.getBoundingClientRect().width), scrollWidth:e.scrollWidth,
    svgWidth:Math.round(e.querySelector('svg')?.getBoundingClientRect().width ?? 0)
  })),
  heading:[...document.querySelectorAll('[data-pane="foliage"] h3')].map(e=>e.textContent.trim())
}))()`);

writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify({ layout, errors }, null, 2)}\n`);
console.log(JSON.stringify({ layout, errors, captures: targets.map(([name]) => path.join(OUT, `${name}.png`)) }, null, 2));
if (layout.body.scrollWidth > layout.body.clientWidth + 1) throw new Error("foliage chapter overflows horizontally");
for (const toy of layout.toys) if (toy.scrollWidth > toy.width + 1) throw new Error(`${toy.name} overflows horizontally`);
if (errors.length > 0) throw new Error(`runtime exceptions: ${errors.join(" | ")}`);

cdp.close();
chrome.kill("SIGTERM");
