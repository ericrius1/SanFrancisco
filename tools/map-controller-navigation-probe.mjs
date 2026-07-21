// End-to-end regression probe for controller navigation on the expanded map.
//
// The small minimap intentionally redraws at a reduced cadence while idle. The
// expanded map must not inherit that throttle while controller input is moving
// its viewport: every input frame needs one visible canvas redraw.

import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data", "map-controller-navigation");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const FRAME_DT = 1 / 60;
const MOTION_FRAMES = 10;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const consoleErrors = [];
  const pageErrors = [];
  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.platform === "darwin" ? "metal" : "swiftshader"}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--mute-audio"
    ]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    await context.addInitScript(({ frameDt }) => {
      const state = {
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }))
      };
      const gamepad = {
        id: "Codex Standard Controller",
        index: 0,
        connected: true,
        mapping: "standard",
        timestamp: 0,
        axes: state.axes,
        buttons: state.buttons,
        vibrationActuator: null
      };
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => [gamepad]
      });
      window.__setMapProbePad = ({ lx = 0, ly = 0, rx = 0, ry = 0, lt = 0, rt = 0 }) => {
        state.axes[0] = lx;
        state.axes[1] = ly;
        state.axes[2] = rx;
        state.axes[3] = ry;
        state.buttons[6].pressed = lt > 0.5;
        state.buttons[6].touched = lt > 0;
        state.buttons[6].value = lt;
        state.buttons[7].pressed = rt > 0.5;
        state.buttons[7].touched = rt > 0;
        state.buttons[7].value = rt;
        gamepad.timestamp += frameDt * 1000;
      };
    }, { frameDt: FRAME_DT });

    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });
    await page.waitForFunction(
      () => Boolean(window.__sf?.minimap && window.__sf?.tick && window.__sfManual && document.body.classList.contains("started")),
      null,
      { timeout: 180_000 }
    );

    const result = await page.evaluate(({ frameDt, motionFrames }) => {
      window.__sfManual(true);
      const minimap = window.__sf.minimap;
      minimap.setExpanded(true);
      minimap.focusWorldPoint(384, -1952, 7200);
      minimap.update(true);

      const canvas = document.querySelector("canvas[data-big-map]");
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error("expanded map canvas was not created");
      const context2d = canvas.getContext("2d");
      if (!context2d) throw new Error("expanded map 2D context was not created");

      let frameDraws = 0;
      const originalClearRect = context2d.clearRect.bind(context2d);
      context2d.clearRect = (...args) => {
        frameDraws++;
        return originalClearRect(...args);
      };

      const runFrames = (pad) => {
        frameDraws = 0;
        const states = [];
        window.__setMapProbePad(pad);
        for (let frame = 0; frame < motionFrames; frame++) {
          window.__sf.tick(frameDt);
          states.push(minimap.debugState());
        }
        window.__setMapProbePad({});
        return { frameDraws, states };
      };

      const pan = runFrames({ lx: 0.72, ly: -0.34 });
      minimap.focusWorldPoint(384, -1952, 7200);
      minimap.update(true);
      const zoom = runFrames({ ry: -0.58 });

      // Ocean Beach sits inside the finite world but outside the overview's
      // center clamp. Drive the real left-stick path until the selection
      // crosshair reaches it, then press A through the owning map method.
      const surfTarget = minimap.focusLandmark("Ocean Beach · Surf");
      if (!surfTarget) throw new Error("Ocean Beach surf landmark was not registered");
      minimap.focusWorldPoint(384, -1952, 7200);
      minimap.update(true);
      frameDraws = 0;
      let surfFrames = 0;
      let surfDistancePx = Infinity;
      for (; surfFrames < 240; surfFrames++) {
        const state = minimap.debugState();
        const cursorWorld = state.cursorWorld ?? state.center;
        const dx = surfTarget.x - cursorWorld.x;
        const dz = surfTarget.z - cursorWorld.z;
        const dxNorm = dx / state.spanX;
        const dzNorm = dz / state.spanZ;
        surfDistancePx = Math.hypot(dxNorm * canvas.width, dzNorm * canvas.height);
        if (surfDistancePx <= 6) break;
        const magnitude = Math.hypot(dxNorm, dzNorm) || 1;
        const strength = Math.min(1, Math.max(0.25, magnitude / 0.08));
        window.__setMapProbePad({
          lx: (dxNorm / magnitude) * strength,
          ly: (dzNorm / magnitude) * strength
        });
        window.__sf.tick(frameDt);
      }
      window.__setMapProbePad({});
      const surfNavigationDraws = frameDraws;
      minimap.padSelectAtCursor();
      const surf = {
        target: surfTarget,
        frames: surfFrames,
        frameDraws: surfNavigationDraws,
        distancePx: surfDistancePx,
        state: minimap.debugState()
      };
      return { pan, zoom, surf, canvas: { width: canvas.width, height: canvas.height } };
    }, { frameDt: FRAME_DT, motionFrames: MOTION_FRAMES });

    const panCenters = result.pan.states.map((state) => state.center);
    const zoomSpans = result.zoom.states.map((state) => state.spanX);
    assert(
      result.pan.frameDraws === MOTION_FRAMES,
      `controller pan drew ${result.pan.frameDraws}/${MOTION_FRAMES} input frames`
    );
    assert(
      result.zoom.frameDraws === MOTION_FRAMES,
      `controller zoom drew ${result.zoom.frameDraws}/${MOTION_FRAMES} input frames`
    );
    assert(
      panCenters.every((center, index) => index === 0 || center.x > panCenters[index - 1].x),
      "controller pan center did not advance monotonically"
    );
    assert(
      zoomSpans.every((span, index) => index === 0 || span < zoomSpans[index - 1]),
      "controller zoom span did not decrease monotonically"
    );
    assert(result.surf.distancePx <= 6, `controller stopped ${result.surf.distancePx.toFixed(1)} px from surf`);
    assert(
      result.surf.state.selection === "Ocean Beach · Surf",
      `controller selected ${JSON.stringify(result.surf.state.selection)} instead of the surf pin`
    );
    assert(
      result.surf.frameDraws === result.surf.frames,
      `surf navigation drew ${result.surf.frameDraws}/${result.surf.frames} input frames`
    );
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
    assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);

    const screenshot = path.join(OUT, "controller-pan-zoom-final.png");
    await page.locator("canvas[data-big-map]").screenshot({ path: screenshot });
    console.log(JSON.stringify({
      url: BASE_URL,
      controllerFrames: MOTION_FRAMES,
      panCanvasDraws: result.pan.frameDraws,
      zoomCanvasDraws: result.zoom.frameDraws,
      panStart: panCenters[0],
      panEnd: panCenters.at(-1),
      zoomStartSpanM: zoomSpans[0],
      zoomEndSpanM: zoomSpans.at(-1),
      surfNavigation: {
        frames: result.surf.frames,
        canvasDraws: result.surf.frameDraws,
        remainingPx: result.surf.distancePx,
        cursor: result.surf.state.cursor,
        cursorWorld: result.surf.state.cursorWorld,
        selection: result.surf.state.selection
      },
      canvas: result.canvas,
      consoleErrors,
      pageErrors,
      screenshot
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
