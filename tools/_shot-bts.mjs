// Screenshot probe for the Behind-the-scenes panel: opens it, checks the tabs,
// switches to the soundscape chapter, and captures it at several scroll depths
// so the scroll-driven diagrams can be eyeballed. node tools/_shot-bts.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/bts-shots");
const SERVER_URL = "http://127.0.0.1:5192";
const W = 1200,
  H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}
async function waitHttp(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error("timeout " + url);
}
async function startDev() {
  try {
    await waitHttp(SERVER_URL, 2000);
    return null;
  } catch {}
  const relay = await freePort();
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5192", "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, SF_RELAY_PORT: String(relay) },
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(SERVER_URL, 60000);
  return child;
}
function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean))
    if (!c.includes("/") || existsSync(c)) return c;
  throw new Error("no chrome");
}
class Cdp {
  #ws;
  #id = 1;
  #p = new Map();
  constructor(u) {
    this.#ws = new WebSocket(u);
  }
  async open() {
    await new Promise((res, rej) => {
      this.#ws.addEventListener("open", res, { once: true });
      this.#ws.addEventListener("error", rej, { once: true });
    });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id);
      if (!p) return;
      this.#p.delete(m.id);
      m.error ? p.rej(new Error(p.method + ": " + m.error.message)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { res, rej, method }));
  }
  close() {
    this.#ws.close();
  }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}
async function shot(c, name) {
  const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88, fromSurface: true });
  writeFileSync(path.join(OUT, name + ".jpg"), Buffer.from(s.data, "base64"));
  console.log("  shot", name);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDev();
  const chrome = findChrome();
  const port = await freePort();
  const proc = spawn(
    chrome,
    [
      `--user-data-dir=${path.join(OUT, "chrome")}`,
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      "--hide-scrollbars",
      "--mute-audio",
      `--window-size=${W},${H}`,
      `${SERVER_URL}/?autostart&fullfps`
    ],
    { cwd: ROOT, stdio: "ignore" }
  );
  await sleep(2500);
  let page;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  const c = new Cdp(page.webSocketDebuggerUrl);
  await c.open();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    if (await ev(c, `!!document.querySelector('.share-btn')`).catch(() => false)) break;
    await sleep(500);
  }
  await sleep(1500);
  // the HUD is opacity:0 until body.started; autostart runs the sim but doesn't
  // flip that flag, so force it (and immersive off) to reveal the overlay
  await ev(c, `(()=>{document.body.classList.add('started');const h=document.getElementById('hud');h.style.opacity='1';h.style.pointerEvents='auto';return true;})()`);
  // open the panel
  const opened = await ev(
    c,
    `(()=>{const b=[...document.querySelectorAll('.share-btn')].find(x=>/Behind the scenes/i.test(x.textContent));if(!b)return'no-btn';b.click();return document.querySelectorAll('.bts-tab').length;})()`
  );
  console.log("[bts] tabs found:", opened);
  // headless captures the WebGPU surface but not the DOM overlay composited on
  // top, so hide the canvas + paint a dark page bg to photograph the panel alone
  await ev(
    c,
    `(()=>{for(const cv of document.querySelectorAll('canvas'))cv.style.display='none';document.body.style.background='#04121c';return true;})()`
  );
  await sleep(300);
  await shot(c, "01-tab-world");

  // structural sanity
  const info = await ev(
    c,
    `JSON.stringify({tabs:[...document.querySelectorAll('.bts-tab')].map(t=>t.textContent.trim()),panes:document.querySelectorAll('.bts-pane').length,soundSvgs:document.querySelectorAll('[data-pane=sound] svg').length})`
  );
  console.log("[bts]", info);

  // switch to the soundscape chapter
  await ev(c, `document.querySelector('.bts-tab[data-tab="sound"]').click()`);
  await sleep(600);
  await shot(c, "02-sound-top");

  // scroll through the scrollytelling
  const depths = [500, 1100, 1800, 2600, 3400, 4600];
  for (let i = 0; i < depths.length; i++) {
    await ev(
      c,
      `(()=>{const b=document.querySelector('.bts-body');b.scrollTop=${depths[i]};b.dispatchEvent(new Event('scroll'));return b.scrollTop;})()`
    );
    await sleep(450);
    await shot(c, `03-sound-scroll-${String(i).padStart(2, "0")}-${depths[i]}`);
  }
  const active = await ev(
    c,
    `[...document.querySelectorAll('[data-pane=sound] .scrolly-step.active')].map(s=>s.textContent.trim().slice(0,40))`
  );
  console.log("[bts] active steps at bottom:", JSON.stringify(active));

  console.log("[bts] shots in", OUT);
  c.close();
  proc.kill();
  if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => {
  console.error("[bts] FAIL", e);
  process.exit(1);
});
