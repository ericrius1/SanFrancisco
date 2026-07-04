// One-boot vantage probe: loads the app (demo=reel3&hold so it's "started" but
// idle), then teleports a boat to several candidate spots near the Bay Bridge
// and screenshots each, so we can pick a water + bridge + lights vantage without
// a full reel recapture per guess. Prints which files to inspect.
//
//   SF_CAPTURE_URL=http://127.0.0.1:5191 node tools/probe-bridge.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1920,
  H = 1080;
const SERVER_URL = process.env.SF_CAPTURE_URL ?? "http://127.0.0.1:5179";
const OUT = path.join(ROOT, ".data", "probe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// candidate boat vantages: [x, y, z, heading, pitch, zoom, timeOfDay]
const CANDS = [
  ["G", 5000, 2.1, -650, 3.05, 0.02, 1.5, 18.9],
  ["H", 5050, 2.1, -430, 3.02, 0.02, 1.5, 18.9],
  ["I", 4900, 2.1, -520, 3.12, 0.03, 1.5, 18.9],
  ["J", 5200, 2.1, -520, 2.92, 0.03, 1.5, 18.9],
  ["K", 4980, 2.1, -380, 3.0, 0.0, 1.45, 18.9],
  ["L", 5000, 2.1, -650, 3.05, 0.02, 1.5, 19.4]
];

async function isFile(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
async function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("no chrome");
}
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
      if ((await fetch(url, { cache: "no-store" })).ok) return true;
    } catch {}
    await sleep(300);
  }
  throw new Error("http timeout " + url);
}

class Cdp {
  #ws;
  #id = 1;
  #p = new Map();
  #l = new Map();
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
      if (m.id) {
        const p = this.#p.get(m.id);
        if (!p) return;
        this.#p.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {});
      }
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { res, rej }));
  }
  close() {
    this.#ws.close();
  }
}
async function evaluate(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}
async function waitEval(c, expr, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if (await evaluate(c, expr)) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("eval timeout " + expr);
}

const TELEPORT = `window.__probeBoat = (x,y,z,h,pitch,zoom,tod) => {
  const s = window.__sf; if(!s) return 'no __sf';
  const {player, physics, chase, sky} = s;
  if (sky) { sky.cycleEnabled = false; sky.setTimeOfDay(tod); }
  const hy = h/2, qy = Math.sin(hy), qw = Math.cos(hy);
  const set = () => {
    player.heading = h + Math.PI;
    player.position.set(x,y,z);
    physics.world.setBodyTransform(player.body,[x,y,z],[0,qy,0,qw]);
    physics.world.setBodyVelocity(player.body,[0,0,0],[0,0,0]);
    player.quaternion.set(0,qy,0,qw);
    player.renderPosition.set(x,y,z); player.renderQuaternion.copy(player.quaternion); player.syncMesh(0);
  };
  set(); player.trySwitch('boat'); set();
  chase.yaw = h; chase.pitch = pitch; chase.zoom = zoom;
  return 'ok';
};`;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  // reuse a running server on SERVER_URL, else start one
  let dev = null;
  try {
    await waitHttp(SERVER_URL, 2000);
  } catch {
    const relay = await freePort();
    const vitePort = Number(new URL(SERVER_URL).port || 5179);
    dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relay) },
      stdio: ["ignore", "ignore", "ignore"]
    });
    await waitHttp(SERVER_URL, 45000);
  }
  const chromePath = await findChrome();
  const dport = await freePort();
  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${dport}`,
      `--user-data-dir=${path.join(OUT, "chrome")}`,
      "--headless=new",
      "--no-first-run",
      "--mute-audio",
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      `--window-size=${W},${H}`,
      "--force-device-scale-factor=1",
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  try {
    // find CDP ws
    let ver;
    const t = Date.now();
    while (Date.now() - t < 15000) {
      try {
        ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json();
        break;
      } catch {
        await sleep(200);
      }
    }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl);
    await c.open();
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?demo=reel3&hold=1&autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player)", 120000);
    await evaluate(c, TELEPORT);
    for (const [name, x, y, z, h, pitch, zoom, tod] of CANDS) {
      const r = await evaluate(c, `window.__probeBoat(${x},${y},${z},${h},${pitch},${zoom},${tod})`);
      await sleep(1400); // let tiles stream + camera settle
      const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
      const f = path.join(OUT, `cand_${name}.jpg`);
      writeFileSync(f, Buffer.from(shot.data, "base64"));
      console.log(`[probe] ${name} (${x},${z}) -> ${r} -> ${path.relative(ROOT, f)}`);
    }
    c.close();
  } finally {
    chrome.kill("SIGTERM");
    dev?.kill("SIGTERM");
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
