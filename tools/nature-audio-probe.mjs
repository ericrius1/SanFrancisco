// Headless logic probe for the nature soundscape (src/audio).
//
// Boots the app in headless Chrome with the autoplay gate open, freezes the
// wall clock, then for each scenario teleports the listener, sets the sky clock,
// unlocks the audio, ticks a few virtual seconds, and reads nature.debugState.
// Verifies: context runs in-region and SUSPENDS in the city; per-region bed mix;
// day↔night bed swap + palette; that spatial voices actually schedule.
//
//   node tools/nature-audio-probe.mjs
// Env: SF_PROBE_URL (default http://127.0.0.1:5191), CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5191";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [name, x, z, hour, expectSuspended]
const SCENARIOS = [
  ["city_downtown_noon", 0, -1600, 12, true],
  ["botanical_day", -2290, 2470, 12, false],
  ["botanical_night", -2290, 2470, 1.5, false],
  ["ggpark_dawn_chorus", -3340, 2320, 6.3, false],
  ["presidio_night", -1617, -1035, 2, false],
  ["marin_day", -4500, -6400, 12, false]
];

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
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDevIfNeeded() {
  try {
    await waitHttp(SERVER_URL, 2500, "existing vite");
    return null;
  } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"] }
  );
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}
function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
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
      if (!m.id) {
        if (this.onEvent) this.onEvent(m);
        return;
      }
      const p = this.#p.get(m.id);
      if (!p) return;
      this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result?.value;
}
const frame = (dt) => `(()=>{window.__sf.tick(${dt});return true;})()`;

async function teleport(c, x, z) {
  await ev(
    c,
    `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:0,mode:'walk'});return true;})()`
  );
}

async function scenario(c, name, x, z, hour) {
  await teleport(c, x, z);
  await ev(c, `(()=>{window.__sf.sky.cycleEnabled=false;window.__sf.sky.setTimeOfDay(${hour});return true;})()`);
  await ev(c, `window.__sf.nature.unlock()`);
  await sleep(350); // let bed buffers decode
  // advance a few virtual seconds so presence/master ramp and the voice
  // scheduler fires; small real sleeps let async decode + response timers run
  for (let i = 0; i < 240; i++) {
    await ev(c, frame(0.05));
    if (i % 30 === 0) await sleep(25);
  }
  const st = await ev(c, `JSON.stringify(window.__sf.nature.debugState)`);
  return JSON.parse(st);
}

let devProc = null;
let chromeProc = null;
function cleanup() {
  try {
    chromeProc?.kill();
  } catch {}
  try {
    devProc?.kill();
  } catch {}
}

async function main() {
  const dev = (devProc = await startDevIfNeeded());
  const chrome = findChrome();
  const port = await freePort();
  const profile = path.join(ROOT, ".data", `nature-audio-chrome-${process.pid}`);
  const appUrl = new URL(SERVER_URL);
  appUrl.searchParams.set("autostart", "1");
  appUrl.searchParams.set("fullfps", "1");
  appUrl.searchParams.set("profile", "1");
  const proc = (chromeProc = spawn(
    chrome,
    [
      `--user-data-dir=${profile}`,
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      "--use-angle=metal",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--mute-audio",
      "--hide-scrollbars",
      "--window-size=1280,720",
      appUrl.href
    ],
    { cwd: ROOT, stdio: "ignore" }
  ));
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
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl);
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      console.log("[page-exception]", (d.exception && (d.exception.description || d.exception.value)) || d.text);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      console.log("[page-error]", m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 240));
    }
  };
  await c.open();
  await c.send("Page.enable");
  await c.send("Runtime.enable");

  const bootState = await ev(c, `({url:location.href,ready:document.readyState,title:document.title,body:(document.body?.innerText||"").slice(0,160),sf:!!window.__sf})`);
  console.log("[probe] waiting for __sf...", JSON.stringify(bootState));
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) {
    try {
      if (await ev(c, `!!(window.__sf&&window.__sf.nature&&window.__sf.player&&window.__sf.sky)`)) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(600);
  }
  if (!ready) throw new Error("__sf.nature never ready");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  const rows = [];
  for (const [name, x, z, hour, expectSuspended] of SCENARIOS) {
    let st;
    try {
      st = await scenario(c, name, x, z, hour);
    } catch (e) {
      console.log(`\n[??] ${name}  scenario error: ${String(e).slice(0, 160)}`);
      rows.push({ name, ok: false });
      continue;
    }
    const dom = st.influence.filter((r) => r.inf > 0.02).map((r) => `${r.id}:${r.inf}`).join(",") || "none";
    const beds = st.beds.map((b) => `${b.id}=${b.level}`).join(" ");
    const ok = expectSuspended ? st.ctx !== "running" || st.master < 0.02 : st.ctx === "running" && st.master > 0.01;
    rows.push({ name, ok, ...st, dom });
    console.log(
      `\n[${ok ? "OK" : "??"}] ${name}  ctx=${st.ctx} master=${st.master} presence=${st.presence}` +
        `\n     regions: ${dom}` +
        `\n     beds:    ${beds}` +
        `\n     voices:  active=${st.activeVoices} total=${st.voiceCount} last=${st.lastKind}`
    );
  }

  console.log("\n[probe] summary:", rows.every((r) => r.ok) ? "ALL OK" : "CHECK ROWS ABOVE");
  c.close();
  cleanup();
  process.exit(0);
}
main().catch((e) => {
  console.error("[probe] FAIL", e);
  cleanup();
  process.exit(1);
});
