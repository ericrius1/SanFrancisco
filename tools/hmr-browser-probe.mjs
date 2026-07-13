// Real Vite + Chrome/WebGPU HMR verification for the first replaceable feature.
// Boots once, invalidates three busker modules without changing their contents,
// and proves the GPU/game runtime stays alive while each trio is replaced.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (!candidate.includes("/") || (await exists(candidate))) return candidate;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
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
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class Cdp {
  #socket;
  #id = 1;
  #pending = new Map();
  onEvent = () => {};

  constructor(url) {
    this.#socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", reject, { once: true });
    });
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (!message.id) {
        this.onEvent(message);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.#id++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }

  close() {
    this.#socket.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const chrome = await findChrome();
const [vitePort, relayPort, debugPort] = await Promise.all([freePort(), freePort(), freePort()]);
const profile = path.join(tmpdir(), `sf-hmr-browser-profile-${process.pid}`);
await rm(profile, { recursive: true, force: true });

const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: ROOT,
  env: { ...process.env, SF_HMR: "1", SF_RELAY_PORT: String(relayPort) },
  stdio: ["ignore", "pipe", "pipe"]
});
const viteOutput = [];
vite.stdout.on("data", (chunk) => viteOutput.push(chunk.toString()));
vite.stderr.on("data", (chunk) => viteOutput.push(chunk.toString()));

const browser = spawn(chrome, [
  `--user-data-dir=${profile}`,
  "--headless=new",
  `--remote-debugging-port=${debugPort}`,
  "--enable-unsafe-webgpu",
  "--enable-features=WebGPUDeveloperFeatures",
  "--use-angle=metal",
  "--mute-audio",
  "--hide-scrollbars",
  "--window-size=1280,800",
  "about:blank"
], { cwd: ROOT, stdio: "ignore" });

let cdp;
try {
  await waitHttp(`http://127.0.0.1:${vitePort}`, 20_000);
  let page;
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(100);
  }
  if (!page) throw new Error("Chrome debugging target did not appear");

  cdp = new Cdp(page.webSocketDebuggerUrl);
  const errors = [];
  let navigations = 0;
  cdp.onEvent = (message) => {
    if (message.method === "Page.frameNavigated") navigations++;
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  };
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", {
    url: `http://127.0.0.1:${vitePort}/?autostart&fullfps`
  });
  await waitFor(
    cdp,
    "Boolean(window.__sf?.buskers && window.__sf?.renderIdle?.())",
    60_000,
    "game boot/render idle"
  );

  await evaluate(cdp, `(() => {
    const sf = window.__sf;
    window.__sfManual(true);
    window.__hmrBase = {
      timeOrigin: performance.timeOrigin,
      renderer: sf.renderer,
      device: sf.renderer.backend.device,
      canvas: sf.renderer.domElement,
      scene: sf.scene,
      camera: sf.camera,
      player: sf.player,
      physics: sf.physics,
      pipeline: sf.pipeline,
      facade: sf.buskers
    };
    return true;
  })()`);

  const navigationBaseline = navigations;
  const modules = [
    "src/gameplay/buskers/song.ts",
    "src/gameplay/buskers/flutist.ts",
    "src/gameplay/buskers/index.ts"
  ];
  const swaps = [];
  for (let index = 0; index < modules.length; index++) {
    const expected = index + 1;
    await evaluate(cdp, `(() => {
      window.__hmrPrevious = {
        current: window.__sf.buskers.current,
        group: window.__sf.buskers.group,
        state: window.__sf.buskers.current.snapshotState(),
        playerMode: window.__sf.player.mode,
        playerPosition: window.__sf.player.position.clone()
      };
      return true;
    })()`);
    const started = performance.now();
    const when = new Date(Date.now() + expected * 1000);
    await utimes(path.join(ROOT, modules[index]), when, when);
    await waitFor(
      cdp,
      "window.__sf.buskers.hotStatus.pending === true",
      10_000,
      `queued busker HMR generation ${expected}`
    );
    await evaluate(cdp, "window.__sf.tick(0); true");
    await waitFor(
      cdp,
      `window.__sf.buskers.generation >= ${expected}`,
      2_000,
      `busker HMR generation ${expected}`
    );
    const result = await evaluate(cdp, `(() => {
      const sf = window.__sf;
      const base = window.__hmrBase;
      const previous = window.__hmrPrevious;
      const nextState = sf.buskers.current.snapshotState();
      let perchCount = 0;
      sf.scene.traverse((object) => { if (object.name === "busker_perch_rock") perchCount++; });
      return {
        generation: sf.buskers.generation,
        stableRuntime:
          performance.timeOrigin === base.timeOrigin &&
          sf.renderer === base.renderer &&
          sf.renderer.backend.device === base.device &&
          sf.renderer.domElement === base.canvas &&
          sf.scene === base.scene &&
          sf.camera === base.camera &&
          sf.player === base.player &&
          sf.physics === base.physics &&
          sf.pipeline === base.pipeline &&
          sf.buskers === base.facade,
        replaced: sf.buskers.current !== previous.current && sf.buskers.group !== previous.group,
        oldDetached: previous.group.parent === null,
        onePerch: perchCount === 1,
        stateStable:
          nextState.version === previous.state.version &&
          nextState.visible === previous.state.visible &&
          nextState.songIndex === previous.state.songIndex &&
          nextState.phase === previous.state.phase &&
          Math.abs(nextState.phaseTime - previous.state.phaseTime) < 0.001 &&
          Math.abs(nextState.silenceRemaining - previous.state.silenceRemaining) < 0.001 &&
          Math.abs(nextState.elapsed - previous.state.elapsed) < 0.001 &&
          Math.hypot(
            nextState.placement.x - previous.state.placement.x,
            nextState.placement.z - previous.state.placement.z,
            nextState.placement.yaw - previous.state.placement.yaw
          ) < 0.001,
        playerStable:
          sf.player.mode === previous.playerMode &&
          sf.player.position.distanceTo(previous.playerPosition) < 0.001,
        canvasCount: document.querySelectorAll("#app canvas").length,
        overlay: Boolean(document.querySelector("vite-error-overlay"))
      };
    })()`);
    assert.equal(result.generation, expected);
    assert.equal(result.stableRuntime, true, `${modules[index]} replaced the stable runtime`);
    assert.equal(result.replaced, true, `${modules[index]} did not replace the concrete trio`);
    assert.equal(result.oldDetached, true, `${modules[index]} left the old group attached`);
    assert.equal(result.onePerch, true, `${modules[index]} left duplicate perch meshes`);
    assert.equal(result.stateStable, true, `${modules[index]} reset the busker transport or placement state`);
    assert.equal(result.playerStable, true, `${modules[index]} moved or changed the player`);
    assert.equal(result.canvasCount, 1);
    assert.equal(result.overlay, false);
    swaps.push({ module: modules[index], latencyMs: Math.round(performance.now() - started) });
  }

  await evaluate(cdp, `(() => {
    window.__hmrTuningBefore = {
      generation: window.__sf.buskers.generation,
      current: window.__sf.buskers.current,
      renderer: window.__sf.renderer,
      player: window.__sf.player
    };
    return true;
  })()`);
  const tuningLogOffset = viteOutput.join("").length;
  const tuningStarted = performance.now();
  const tuningFile = "src/gameplay/buskers/tuning.ts";
  const tuningWhen = new Date(Date.now() + 4000);
  await utimes(path.join(ROOT, tuningFile), tuningWhen, tuningWhen);
  const tuningDeadline = Date.now() + 10_000;
  while (
    Date.now() < tuningDeadline &&
    !viteOutput.join("").slice(tuningLogOffset).includes("/src/gameplay/buskers/tuning.ts")
  ) {
    await sleep(100);
  }
  assert.match(
    viteOutput.join("").slice(tuningLogOffset),
    /\/src\/gameplay\/buskers\/tuning\.ts/,
    "Vite did not process the busker tuning edit"
  );
  await sleep(750);
  const tuningAfter = await evaluate(cdp, `(() => ({
    stable:
      window.__sf.buskers.generation === window.__hmrTuningBefore.generation &&
      window.__sf.buskers.current === window.__hmrTuningBefore.current &&
      window.__sf.renderer === window.__hmrTuningBefore.renderer &&
      window.__sf.player === window.__hmrTuningBefore.player,
    overlay: Boolean(document.querySelector("vite-error-overlay"))
  }))()`);
  assert.equal(tuningAfter.stable, true, "tuning defaults replaced live game objects");
  assert.equal(tuningAfter.overlay, false);
  swaps.push({ module: tuningFile, latencyMs: Math.round(performance.now() - tuningStarted) });

  assert.equal(navigations, navigationBaseline, "feature HMR triggered a page navigation");
  assert.deepEqual(errors, [], `browser exceptions: ${errors.join("\n")}`);

  // A shared player/rig edit is intentionally outside the partial boundary.
  // Prove that fallback reloads restore the tab-scoped play/camera state.
  errors.length = 0;
  const reloadNavigationBaseline = navigations;
  const reloadTimeOrigin = await evaluate(cdp, "performance.timeOrigin");
  const captured = await evaluate(cdp, `(() => {
    const sf = window.__sf;
    sf.chase.yaw = 0.71;
    sf.chase.pitch = -0.18;
    sf.chase.zoom = 1.37;
    sf.net.setName("HMR Tester");
    document.body.classList.add("started");
    return {
      mode: sf.player.mode,
      x: sf.player.position.x,
      z: sf.player.position.z,
      heading: sf.player.heading,
      name: sf.net.name,
      camera: { yaw: sf.chase.yaw, pitch: sf.chase.pitch, zoom: sf.chase.zoom }
    };
  })()`);
  const reloadStarted = performance.now();
  const structuralFile = "src/player/rig.ts";
  const structuralWhen = new Date(Date.now() + 5000);
  await utimes(path.join(ROOT, structuralFile), structuralWhen, structuralWhen);
  await waitFor(
    cdp,
    `performance.timeOrigin !== ${JSON.stringify(reloadTimeOrigin)} &&
      Boolean(window.__sfDevReloadRestored) &&
      Boolean(window.__sf?.renderIdle?.()) &&
      document.body.classList.contains("started")`,
    60_000,
    "full-reload state restoration"
  );
  const restored = await evaluate(cdp, `(() => {
    const sf = window.__sf;
    const angleError = Math.abs(Math.atan2(
      Math.sin(sf.player.heading - ${JSON.stringify(captured.heading)}),
      Math.cos(sf.player.heading - ${JSON.stringify(captured.heading)})
    ));
    return {
      state:
        sf.player.mode === ${JSON.stringify(captured.mode)} &&
        Math.hypot(sf.player.position.x - ${JSON.stringify(captured.x)}, sf.player.position.z - ${JSON.stringify(captured.z)}) < 0.25 &&
        angleError < 0.05,
      camera:
        Math.abs(sf.chase.yaw - ${JSON.stringify(captured.camera.yaw)}) < 0.001 &&
        Math.abs(sf.chase.pitch - ${JSON.stringify(captured.camera.pitch)}) < 0.001 &&
        Math.abs(sf.chase.zoom - ${JSON.stringify(captured.camera.zoom)}) < 0.001,
      name: sf.net.name,
      snapshotConsumed: sessionStorage.getItem("sf-dev-reload-v1") === null,
      canvasCount: document.querySelectorAll("#app canvas").length,
      overlay: Boolean(document.querySelector("vite-error-overlay"))
    };
  })()`);
  assert.ok(navigations > reloadNavigationBaseline, "structural edit did not reload the page");
  assert.equal(restored.state, true, "full reload did not restore player state");
  assert.equal(restored.camera, true, "full reload did not restore chase camera state");
  assert.equal(restored.name, captured.name, "full reload did not restore the player name");
  assert.equal(restored.snapshotConsumed, true, "full reload left a stale dev snapshot");
  assert.equal(restored.canvasCount, 1);
  assert.equal(restored.overlay, false);
  assert.deepEqual(errors, [], `full-reload browser exceptions: ${errors.join("\n")}`);
  console.log(`[hmr-browser] passed ${swaps.length} partial swaps`, swaps);
  console.log(`[hmr-browser] full reload restored state in ${Math.round(performance.now() - reloadStarted)}ms`);
} catch (error) {
  console.error(viteOutput.join("").slice(-4000));
  throw error;
} finally {
  cdp?.close();
  browser.kill("SIGTERM");
  vite.kill("SIGTERM");
  await sleep(250);
  await rm(profile, { recursive: true, force: true });
}
