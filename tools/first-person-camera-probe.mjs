// End-to-end regression probe for the generated-building camera handoff.
// It drives the real app, citygen gate and Input mousemove listener, then checks
// that the settled indoor pose is a zoom-independent eye camera whose rendered
// direction matches ChaseCamera.lookDir(). Screenshots make avatar clipping and
// room framing easy to inspect.
//
//   SF_URL=http://127.0.0.1:4178 node tools/first-person-camera-probe.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data", "first-person-camera");
const W = 1600, H = 1000;
const BUILDING = { x: 951.5, z: 2400.5, y: 48.5 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Other local sessions can edit unrelated files while this probe runs. Block
// only Vite's HMR socket so those edits cannot reload the page mid-assertion.
const HMR_BLOCK = `(() => {
  const NativeWebSocket = window.WebSocket;
  const isHmr = (protocols) => protocols === "vite-hmr" || (Array.isArray(protocols) && protocols.includes("vite-hmr"));
  const StableWebSocket = function(url, protocols) {
    if (isHmr(protocols)) return { addEventListener(){}, removeEventListener(){}, send(){}, close(){}, readyState:3, binaryType:"blob" };
    return new NativeWebSocket(url, protocols);
  };
  StableWebSocket.prototype = NativeWebSocket.prototype;
  StableWebSocket.CONNECTING=NativeWebSocket.CONNECTING; StableWebSocket.OPEN=NativeWebSocket.OPEN;
  StableWebSocket.CLOSING=NativeWebSocket.CLOSING; StableWebSocket.CLOSED=NativeWebSocket.CLOSED;
  window.WebSocket = StableWebSocket;
})();`;

async function isFile(file) { try { await access(file); return true; } catch { return false; } }
async function findChrome() {
  for (const candidate of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (!candidate.includes("/") || await isFile(candidate)) return candidate;
  }
  throw new Error("Chrome not found");
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
    try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {}
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  errors = [];
  constructor(url) { this.#socket = new WebSocket(url); }
  async open() {
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", reject, { once: true });
    });
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push((message.params?.exceptionDetails?.exception?.description ?? "exception").split("\n")[0]);
      }
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
  }
  close() { this.#socket.close(); }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "page evaluation failed");
  return result.result?.value;
}
async function waitEval(cdp, expression, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await evaluate(cdp, expression)) return; } catch {}
    await sleep(300);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}
async function tick(cdp, count = 1, dt = 1 / 60) {
  for (let i = 0; i < count; i++) await evaluate(cdp, `window.__sf.tick(${dt})`);
}
async function screenshot(cdp, name) {
  const image = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, name);
  writeFileSync(file, Buffer.from(image.data, "base64"));
  console.log(`  saved ${file}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let baseUrl = process.env.SF_URL || null;
  let dev = null;
  if (!baseUrl) {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: ROOT, stdio: "ignore", detached: true
    });
  }

  const debugPort = await freePort();
  const chromePath = await findChrome();
  let chrome = null;
  let failed = false;
  try {
    await waitHttp(baseUrl, 120_000);
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${path.join(OUT, `chrome-${Date.now()}`)}`,
      "--headless=new", "--no-first-run", "--mute-audio",
      "--enable-features=SharedArrayBuffer,WebGPUDeveloperFeatures",
      "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu",
      `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"
    ], { stdio: "ignore" });
    const debugUrl = `http://127.0.0.1:${debugPort}`;
    await waitHttp(`${debugUrl}/json/version`, 15_000);
    const page = await (await fetch(`${debugUrl}/json/new?about:blank`, { method: "PUT" })).json();
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HMR_BLOCK });
    await cdp.send("Page.navigate", { url: `${baseUrl}/?autostart=1&profile=1&fullfps=1` });
    await waitEval(cdp, "Boolean(window.__sf?.player && window.__sf?.citygenRing?.current)", 120_000);
    await evaluate(cdp, "window.__sfManual(true)");
    await evaluate(cdp, `(() => {
      const s=window.__sf, p=s.player;
      if (p.mode !== "walk") p.trySwitch("walk");
      s.sky.cycleEnabled=false; s.sky.setTimeOfDay(11);
      p.position.set(${BUILDING.x},${BUILDING.y},${BUILDING.z});
      p.renderPosition.copy(p.position);
      s.physics.world.setBodyTransform(p.body,[${BUILDING.x},${BUILDING.y},${BUILDING.z}],[0,0,0,1]);
      return true;
    })()`);
    await tick(cdp, 180, 1 / 30);
    await waitEval(cdp, "window.__sf.citygenRing.current.isPlayerInside() && window.__sf.chase.firstPersonBlend > 0.995", 30_000);

    const inspect = () => `(() => {
      const s=window.__sf, actual=new s.THREE.Vector3(), expected=new s.THREE.Vector3(), interaction=new s.THREE.Vector3(), origin=new s.THREE.Vector3();
      s.camera.getWorldDirection(actual); s.chase.lookDir(expected); s.chase.interactionDir(interaction,s.player); s.chase.viewOrigin(origin,s.player);
      const eye=new s.THREE.Vector3(s.player.renderPosition.x,s.player.renderPosition.y+0.8,s.player.renderPosition.z);
      return { blend:s.chase.firstPersonBlend, zoom:s.chase.zoom, pitch:s.chase.pitch, yaw:s.chase.yaw,
        eyeDistance:s.camera.position.distanceTo(eye), directionDot:actual.dot(expected), interactionDot:actual.dot(interaction),
        originDistance:origin.distanceTo(s.camera.position), avatarVisible:s.player.meshes.walk.visible,
        camera:s.camera.position.toArray() };
    })()`;

    const neutral = await evaluate(cdp, inspect());
    console.log("[indoor]", JSON.stringify(neutral));
    await screenshot(cdp, "indoor-neutral.png");

    // Wheel input is intentionally inert in FPS; it must not invisibly alter the
    // outdoor boom that will be restored on exit.
    await evaluate(cdp, "window.__sf.input.wheel=1000"); await tick(cdp, 1);
    const zoomAfterIndoorWheel = await evaluate(cdp, "window.__sf.chase.zoom");

    // Exercise the real window mousemove listener used by pointer lock. The test
    // marks Input locked because headless Chrome cannot grant pointer lock.
    const beforeInput = await evaluate(cdp, "({yaw:window.__sf.chase.yaw,pitch:window.__sf.chase.pitch})");
    await evaluate(cdp, `(() => {
      const s=window.__sf, e=new MouseEvent("mousemove");
      Object.defineProperties(e,{movementX:{value:180},movementY:{value:-160}});
      s.input.locked=true; window.dispatchEvent(e); return true;
    })()`);
    await tick(cdp, 1);
    const afterInput = await evaluate(cdp, inspect());
    console.log("[mousemove]", JSON.stringify({ beforeInput, afterInput }));

    // Zoom must not move the FPS endpoint.
    await evaluate(cdp, "window.__sf.chase.zoom=0.45"); await tick(cdp, 30);
    const zoomNear = await evaluate(cdp, inspect());
    await evaluate(cdp, "window.__sf.chase.zoom=2.6"); await tick(cdp, 30);
    const zoomFar = await evaluate(cdp, inspect());
    console.log("[zoom endpoints]", JSON.stringify({ zoomNear, zoomFar }));

    // Exercise the real C/orbit ownership handoff. Orbit must restore the avatar;
    // returning indoors must restart a smooth eye transition from the orbit pose.
    await evaluate(cdp, "window.__sf.chase.zoom=1");
    await evaluate(cdp, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC'}))"); await tick(cdp, 1);
    await evaluate(cdp, "window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyC'}))");
    const orbitState = await evaluate(cdp, inspect());
    const orbitSuspended = await evaluate(cdp, "window.__sf.input.suspended");
    await evaluate(cdp, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC'}))"); await tick(cdp, 1);
    await evaluate(cdp, "window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyC'}))");
    const resumeState = await evaluate(cdp, inspect());
    const resumeSuspended = await evaluate(cdp, "window.__sf.input.suspended");
    const orbitResumeStep = Math.hypot(...resumeState.camera.map((value, index) => value - orbitState.camera[index]));
    await tick(cdp, 90);

    // The widened first-person range should allow a near-vertical look both ways.
    await evaluate(cdp, "window.__sf.input.mouseDY=-10000"); await tick(cdp, 1);
    const lookUp = await evaluate(cdp, inspect());
    await screenshot(cdp, "indoor-look-up.png");
    await evaluate(cdp, "window.__sf.input.mouseDY=10000"); await tick(cdp, 1);
    const lookDown = await evaluate(cdp, inspect());
    await screenshot(cdp, "indoor-look-down.png");

    // Move well outside and record the actual exit handoff; blend must decrease
    // monotonically and settle back to the zoomed chase pose.
    await evaluate(cdp, `(() => { const s=window.__sf,p=s.player;
      p.position.set(${BUILDING.x + 30},${BUILDING.y},${BUILDING.z}); p.renderPosition.copy(p.position);
      s.physics.world.setBodyTransform(p.body,[${BUILDING.x + 30},${BUILDING.y},${BUILDING.z}],[0,0,0,1]); return true; })()`);
    const exitBlend = [];
    for (let i = 0; i < 45; i++) {
      await tick(cdp, 1);
      exitBlend.push(await evaluate(cdp, "window.__sf.chase.firstPersonBlend"));
    }
    await tick(cdp, 90);
    const outside = await evaluate(cdp, inspect());
    const monotonicExit = exitBlend.every((value, index) => index === 0 || value <= exitBlend[index - 1] + 1e-9);

    await evaluate(cdp, "window.__sf.chase.pitch=0");
    await tick(cdp, 30);
    // Isolate the camera handoff at one stable anchor. The full app/gate path was
    // exercised above; avoiding another teleport here makes elevation continuity
    // measure the pose blend itself rather than a 30 m player jump.
    await evaluate(cdp, "window.__sf.chase.indoor=true");
    const entrySamples = [];
    for (let i = 0; i < 45; i++) {
      await evaluate(cdp, "window.__sf.chase.update(1/60,window.__sf.player,window.__sf.input)");
      entrySamples.push(await evaluate(cdp, `(() => { const s=window.__sf,d=new s.THREE.Vector3(),a=new s.THREE.Vector3();
        s.camera.getWorldDirection(d); s.chase.interactionDir(a,s.player);
        return { blend:s.chase.firstPersonBlend, y:d.y, interactionDot:d.dot(a) }; })()`));
    }
    const entryBlend = entrySamples.map((sample) => sample.blend);
    const monotonicEntry = entryBlend.every((value, index) => index === 0 || value + 1e-9 >= entryBlend[index - 1]);
    const monotonicElevation = entrySamples.every((sample, index) => index === 0 || sample.y + 1e-4 >= entrySamples[index - 1].y);
    const noPitchOvershoot = entrySamples.every((sample) => sample.y <= 0.002);
    const transitionAimAligned = entrySamples.filter((sample) => sample.blend > 0.001).every((sample) => sample.interactionDot > 0.99999);
    console.log("[entry transition]", JSON.stringify({ monotonicEntry, monotonicElevation, noPitchOvershoot,
      first:entrySamples[0], last:entrySamples.at(-1), minY:Math.min(...entrySamples.map(s=>s.y)), maxY:Math.max(...entrySamples.map(s=>s.y)) }));

    // Switching embodiment at full indoor blend must use the vehicle chase rig
    // immediately; neither camera position nor interaction origin may stay in FPS.
    await evaluate(cdp, "window.__sf.player.trySwitch('drive'); window.__sf.chase.update(1/60,window.__sf.player,window.__sf.input)");
    const vehicleState = await evaluate(cdp, `(() => { const s=window.__sf,o=new s.THREE.Vector3(),m=s.player.aimOrigin.clone();
      s.chase.viewOrigin(o,s.player); return { mode:s.player.mode,
        cameraDistance:s.camera.position.distanceTo(s.player.renderPosition), originDistance:o.distanceTo(m) }; })()`);

    const checks = {
      inside: neutral.blend > 0.995,
      eyeAttached: neutral.eyeDistance < 0.04,
      directionAligned: neutral.directionDot > 0.99999 && afterInput.directionDot > 0.99999,
      mouseYawChanged: Math.abs(afterInput.yaw - beforeInput.yaw) > 0.5,
      mousePitchChanged: Math.abs(afterInput.pitch - beforeInput.pitch) > 0.35,
      originAligned: neutral.originDistance < 0.01,
      indoorWheelIgnored: Math.abs(zoomAfterIndoorWheel - neutral.zoom) < 1e-9,
      zoomIndependent: zoomNear.eyeDistance < 0.04 && zoomFar.eyeDistance < 0.04,
      orbitOwnership: orbitSuspended && orbitState.avatarVisible && orbitState.blend < 0.001 &&
        !resumeSuspended && resumeState.blend < 0.1 && orbitResumeStep < 0.5,
      fullPitch: lookUp.pitch < -1.44 && lookDown.pitch > 1.44,
      avatarHiddenInFps: !neutral.avatarVisible && outside.avatarVisible,
      smoothEnter: monotonicEntry && monotonicElevation && noPitchOvershoot && entryBlend.at(-1) > 0.995,
      smoothExit: monotonicExit && outside.blend < 0.005,
      transitionAimAligned,
      vehicleSwitchClearsFps: vehicleState.mode === "drive" && vehicleState.cameraDistance > 5 && vehicleState.originDistance < 0.01,
      noPageErrors: cdp.errors.length === 0
    };
    for (const [name, pass] of Object.entries(checks)) console.log(`  ${pass ? "PASS" : "FAIL"} ${name}`);
    console.log("[page errors]", cdp.errors.length ? cdp.errors : "none");
    failed = Object.values(checks).some((pass) => !pass);
    cdp.close();
  } catch (error) {
    console.error("[probe]", error);
    failed = true;
  } finally {
    chrome?.kill("SIGTERM");
    if (dev) { try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
  }
  if (failed) process.exitCode = 1;
}

main();
