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
  ["asset-pipeline", '.fo-asset-flow[aria-label="Tree asset generation pipeline"]'],
  ["forest-stage-1", '[data-pane="foliage"] .scrolly-step:nth-child(1)', "stage"],
  ["forest-stage-2", '[data-pane="foliage"] .scrolly-step:nth-child(2)', "stage"],
  ["forest-stage-3", '[data-pane="foliage"] .scrolly-step:nth-child(3)', "stage"],
  ["forest-stage-4", '[data-pane="foliage"] .scrolly-step:nth-child(4)', "stage"],
  ["lod", '[data-ftoy="lodDial"]'],
  ["gpu-meadow", '[data-ftoy="gpuMeadow"]'],
  ["flower-pipeline", '.fo-asset-flow[aria-label="Flower asset generation pipeline"]'],
  ["measure", ".bts-pane.active section:nth-last-of-type(2)"]
];
const forestStages = [];
for (const [name, selector, alignment] of targets) {
  await evaluate(cdp, `(async () => {
    const body = document.querySelector('.bts-body');
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!body || !target) return false;
    if (${JSON.stringify(alignment)} === 'stage') {
      const targetCard = target.querySelector('p') ?? target;
      let bodyRect = body.getBoundingClientRect();
      let targetRect = targetCard.getBoundingClientRect();
      // First bring the requested step into the scrollport so the diagram has
      // reached its sticky position; only then can its true bottom be measured.
      body.scrollTop = Math.max(0, body.scrollTop + targetRect.top - (bodyRect.top + bodyRect.height * 0.72));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      bodyRect = body.getBoundingClientRect();
      targetRect = targetCard.getBoundingClientRect();
      const scrolly = target.closest('.scrolly');
      const graphic = scrolly?.querySelector('.scrolly-graphic');
      const graphicRect = graphic?.getBoundingClientRect();
      const stacked = scrolly && getComputedStyle(scrolly).flexDirection === 'column';
      const readingLine = stacked && graphicRect
        ? Math.max(bodyRect.top + bodyRect.height * 0.58, graphicRect.bottom + 16)
        : bodyRect.top + bodyRect.height * 0.58;
      body.scrollTop = Math.max(0, body.scrollTop + targetRect.top - readingLine + 4);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    } else {
      body.scrollTop = Math.max(0, target.offsetTop - body.offsetTop - 28);
    }
    if (${JSON.stringify(name)} === 'gpu-meadow') target.querySelector('[data-el="run"]')?.click();
    return true;
  })()`);
  await sleep(name === "gpu-meadow" ? 2100 : 450);
  if (alignment === "stage") {
    forestStages.push(await evaluate(cdp, `(() => {
      const svg = document.querySelector('.scrolly-graphic svg');
      const opacity = (id) => Number.parseFloat(getComputedStyle(svg.getElementById(id)).opacity);
      const activeCard = document.querySelector('[data-pane="foliage"] .scrolly-step.active p');
      const activeRect = activeCard?.getBoundingClientRect();
      const scrolly = activeCard?.closest('.scrolly');
      const graphic = scrolly?.querySelector('.scrolly-graphic');
      return {
        name: ${JSON.stringify(name)},
        count: document.querySelector('[data-fo-stage-count]')?.textContent?.trim(),
        title: document.querySelector('[data-fo-stage-title]')?.textContent?.trim(),
        activeCaption: activeCard?.textContent?.trim(),
        activeCaptionOpacity: activeCard ? Number.parseFloat(getComputedStyle(activeCard).opacity) : null,
        activeCaptionRect: activeRect ? { top: Math.round(activeRect.top), bottom: Math.round(activeRect.bottom) } : null,
        stacked: scrolly ? getComputedStyle(scrolly).flexDirection === 'column' : false,
        graphicBottom: graphic ? Math.round(graphic.getBoundingClientRect().bottom) : null,
        layers: Object.fromEntries(['fo-seed', 'fo-chunk', 'fo-rings', 'fo-frustum', 'fo-forest', 'fo-you'].map(id => [id, opacity(id)]))
      };
    })()`));
  }
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

const expectedStages = [
  { count: "Stage 1 of 4", on: ["fo-seed"] },
  { count: "Stage 2 of 4", on: ["fo-chunk"] },
  { count: "Stage 3 of 4", on: ["fo-rings", "fo-forest", "fo-you"] },
  { count: "Stage 4 of 4", on: ["fo-frustum", "fo-forest", "fo-you"] }
];
writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify({ layout, forestStages, errors }, null, 2)}\n`);
console.log(JSON.stringify({ layout, forestStages, errors, captures: targets.map(([name]) => path.join(OUT, `${name}.png`)) }, null, 2));
if (layout.body.scrollWidth > layout.body.clientWidth + 1) throw new Error("foliage chapter overflows horizontally");
for (const toy of layout.toys) if (toy.scrollWidth > toy.width + 1) throw new Error(`${toy.name} overflows horizontally`);
for (let i = 0; i < expectedStages.length; i++) {
  const actual = forestStages[i];
  const expected = expectedStages[i];
  if (actual?.count !== expected.count) throw new Error(`${actual?.name ?? `stage ${i + 1}`} reported ${actual?.count ?? "no stage"}`);
  if (actual.activeCaptionOpacity < 0.99) throw new Error(`${actual.name} active caption opacity ${actual.activeCaptionOpacity}`);
  if (actual.stacked && actual.activeCaptionRect.top < actual.graphicBottom) {
    throw new Error(`${actual.name} caption overlaps sticky graphic`);
  }
  for (const [id, opacity] of Object.entries(actual.layers)) {
    const shouldShow = expected.on.includes(id);
    if (shouldShow ? opacity < 0.99 : opacity > 0.01) {
      throw new Error(`${actual.name} ${id} opacity ${opacity}; expected ${shouldShow ? "visible" : "hidden"}`);
    }
  }
}
if (errors.length > 0) throw new Error(`runtime exceptions: ${errors.join(" | ")}`);

cdp.close();
chrome.kill("SIGTERM");
