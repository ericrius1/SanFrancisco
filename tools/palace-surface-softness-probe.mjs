// Headless A/B verification for Palace surface-bound sprites. Run once with
// SF_SOFT_MODE=hard and once with the default soft mode; separate browser boots
// keep shader compilation out of identical-camera captures and frame timings.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/palace-surface-softness");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5241";
const MODE = process.env.SF_SOFT_MODE === "hard" ? "hard" : "soft";
const { port: SERVER_PORT } = new URL(SERVER_URL);
const W = 1280;
const H = 720;
const DT = 1 / 60;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findChrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean)) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    return candidate;
  }
  throw new Error("Chrome was not found");
}

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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startDevIfNeeded() {
  try {
    await waitHttp(SERVER_URL, 1500);
    return null;
  } catch {}
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", SERVER_PORT, "--strictPort"],
    { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] }
  );
  await waitHttp(SERVER_URL, 60_000);
  return child;
}

class Cdp {
  #ws;
  #id = 1;
  #pending = new Map();

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
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.#ws.close();
  }
}

let ownedDev = null;
let chromeProcess = null;
let cdp = null;

function cleanup() {
  try { cdp?.close(); } catch {}
  try { chromeProcess?.kill(); } catch {}
  try { ownedDev?.kill(); } catch {}
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(`Browser evaluation failed: ${JSON.stringify(response.exceptionDetails).slice(0, 500)}`);
  }
  return response.result?.value;
}

async function tick(client, count = 1, dt = DT) {
  await evaluate(client, `(async()=>{
    const sf=window.__sf;
    const device=sf.renderer.backend.device;
    for(let i=0;i<${count};i++){
      sf.tick(${dt});
      await device.queue.onSubmittedWorkDone();
    }
    return true;
  })()`);
}

async function setCamera(client, eye, target) {
  await evaluate(
    client,
    `window.__sfFreeCam(${JSON.stringify(eye)},${JSON.stringify(target)})`
  );
  await tick(client, 3, 0);
}

async function capture(client, name) {
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  });
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  return file;
}

async function setSoftness(client, enabled) {
  return evaluate(client, `(()=>{
    const materials=window.__palaceSoftMaterials;
    for(const entry of materials){
      entry.material.opacityNode=${enabled ? "entry.opacityNode" : "null"};
      entry.material.needsUpdate=true;
    }
    return materials.length;
  })()`);
}

async function measure(client, label) {
  return evaluate(client, `(async()=>{
    const sf=window.__sf;
    const renderer=sf.renderer;
    const device=renderer.backend.device;
    for(let i=0;i<30;i++){
      sf.tick(${DT});
      await device.queue.onSubmittedWorkDone();
    }
    const samples=[];
    renderer.info.autoReset=false;
    for(let i=0;i<80;i++){
      const start=performance.now();
      sf.tick(${DT});
      await device.queue.onSubmittedWorkDone();
      samples.push(performance.now()-start);
    }
    renderer.info.reset();
    sf.tick(${DT});
    await device.queue.onSubmittedWorkDone();
    const draws=renderer.info.render.drawCalls ?? renderer.info.render.calls ?? 0;
    renderer.info.autoReset=true;
    samples.sort((a,b)=>a-b);
    const percentile=(p)=>+samples[Math.min(samples.length-1,Math.floor(samples.length*p))].toFixed(3);
    return {label:${JSON.stringify(label)},p50Ms:percentile(0.5),p95Ms:percentile(0.95),drawCalls:draws};
  })()`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDevIfNeeded();

  const chrome = await findChrome();
  const debugPort = await freePort();
  const profileDir = path.join(OUT, `chrome-${Date.now()}`);
  chromeProcess = spawn(
    chrome,
    [
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      "--hide-scrollbars",
      "--mute-audio",
      `--window-size=${W},${H}`,
      `${SERVER_URL}/?autostart=1&fullfps=1`
    ],
    { cwd: ROOT, stdio: "ignore" }
  );

  await sleep(2500);
  let page;
  for (let i = 0; i < 90; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      page = targets.find((target) =>
        target.type === "page" && target.url.includes("127.0.0.1") && target.webSocketDebuggerUrl
      );
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error("The Palace probe could not find the app page");

  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false
  });

  const readyStart = Date.now();
  while (Date.now() - readyStart < 180_000) {
    try {
      const ready = await evaluate(
        cdp,
        `!!(window.__sf?.player && window.__sf?.renderer?.backend?.device && window.__sf?.renderIdle?.())`
      );
      if (ready) break;
    } catch {}
    await sleep(500);
  }

  await evaluate(cdp, `window.__sf.ensureOptionalWorldSite("palace")`);
  await evaluate(cdp, `(async()=>{
    while(!window.__sf.palaceReverie) await new Promise(resolve=>setTimeout(resolve,100));
    window.__sfManual(true);
    const sf=window.__sf;
    sf.sky.cycleEnabled=false;
    sf.sky.setTimeOfDay(19.92);
    sf.WORLD_TUNING.values.fogMaster=0.22;
    sf.sky.applyFogParams();
    sf.renderer.toneMappingExposure=1.1;
    Object.assign(sf.POSTFX_TUNING.values,{ink:false,dream:true,retro:false});
    sf.pipeline.applyPostFx();
    sf.palaceReverie.setCinematicProgress(5,true);
    document.body.classList.add("started");
    document.getElementById("hud")?.style.setProperty("display","none");
    document.getElementById("loading")?.style.setProperty("display","none");
    const root=sf.palaceReverie.root;
    const materials=[];
    root.traverse(object=>{
      const material=object.material;
      if(material?.name==="palace-surface-soft-sprite" && material.opacityNode){
        materials.push({material,opacityNode:material.opacityNode});
      }
    });
    window.__palaceSoftMaterials=materials;
    return materials.length;
  })()`);

  const setup = await evaluate(cdp, `(()=>{
    const sf=window.__sf;
    const lamp=sf.palaceReverie.lamps.lamps[0];
    const playerX=lamp.x+30;
    const playerZ=lamp.z+30;
    sf.player.teleportTo({
      x:playerX,
      y:sf.map.groundHeight(playerX,playerZ)+1.5,
      z:playerZ,
      facing:0,
      mode:"walk"
    });
    return {
      lamp:{x:lamp.x,y:lamp.y,z:lamp.z},
      materialCount:window.__palaceSoftMaterials.length
    };
  })()`);

  if (MODE === "hard") await setSoftness(cdp, false);
  await tick(cdp, 50);

  const lantern = await evaluate(cdp, `(()=>{
    const sf=window.__sf;
    const lanternGroup=sf.scene.getObjectByName("palace-reverie-lanterns");
    const sprite=lanternGroup.children.find(object=>object.isSprite);
    sprite.updateWorldMatrix(true,false);
    const world=sprite.getWorldPosition(new sf.THREE.Vector3());
    return {x:world.x,y:world.y,z:world.z};
  })()`);

  const lampEye = [setup.lamp.x + 4.8, setup.lamp.y + 1.15, setup.lamp.z + 3.2];
  const lampTarget = [setup.lamp.x, setup.lamp.y + 0.82, setup.lamp.z];
  await setCamera(cdp, lampEye, lampTarget);
  await tick(cdp, 20);
  const lampCapture = await capture(cdp, `lamp-${MODE}`);

  const lanternEye = [lantern.x + 5.3, lantern.y + 1.0, lantern.z + 3.5];
  const lanternTarget = [lantern.x, lantern.y - 0.05, lantern.z];
  await setCamera(cdp, lanternEye, lanternTarget);
  await tick(cdp, 20);
  const waterCapture = await capture(cdp, `water-${MODE}`);
  const performance = await measure(cdp, MODE === "hard" ? "hard-baseline" : "surface-soft");

  const report = {
    mode: MODE,
    serverUrl: SERVER_URL,
    materialCount: setup.materialCount,
    captures: { lamp: lampCapture, water: waterCapture },
    performance
  };
  writeFileSync(path.join(OUT, `report-${MODE}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  cleanup();
}

main().catch((error) => {
  cleanup();
  console.error(error);
  process.exitCode = 1;
});
