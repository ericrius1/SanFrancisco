import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WORK_ROOT = path.join(ROOT, ".data", "cinematics");
export const OUTPUT_ROOT = path.join(ROOT, "renders", "cinematics");

const activeChildren = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultLog = (message) => console.log(`[cinematic] ${message}`);

function track(child) {
  activeChildren.add(child);
  child.once("exit", () => activeChildren.delete(child));
  return child;
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2500).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

export async function stopCinematicProcesses() {
  await Promise.allSettled([...activeChildren].map(terminate));
}

export function relativeToRoot(file) {
  return path.relative(ROOT, file) || ".";
}

export async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function runCommand(command, args, { cwd = ROOT, env = process.env, capture = false, log = defaultLog } = {}) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    }));
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ code, output });
        return;
      }
      const detail = capture && output.trim() ? `\n${output.trim().slice(-6000)}` : "";
      log(`${command} failed${signal ? ` (${signal})` : ""}`);
      reject(new Error(`${command} exited ${code ?? "without a code"}${detail}`));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitHttp(url, timeoutMs, label, child) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    if (child && child.exitCode !== null) throw new Error(`${label} exited before becoming ready`);
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label} at ${url}${lastError ? ` (${lastError})` : ""}`);
}

/** Start one private Vite for a render batch, or use SF_CINE_URL verbatim. */
export async function startVite({ url = process.env.SF_CINE_URL, log = defaultLog } = {}) {
  if (url) {
    const externalUrl = String(url).replace(/\/$/, "");
    await waitHttp(externalUrl, 15_000, "external Vite");
    log(`using existing Vite at ${externalUrl}`);
    return { url: externalUrl, owned: false, close: async () => {} };
  }

  const vitePort = await freePort();
  const relayPort = await freePort();
  const viteUrl = `http://127.0.0.1:${vitePort}`;
  const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!(await fileExists(viteBin))) throw new Error(`Vite is not installed at ${relativeToRoot(viteBin)}; run npm install`);

  const child = track(spawn(process.execPath, [
    viteBin,
    "--host", "127.0.0.1",
    "--port", String(vitePort),
    "--strictPort"
  ], {
    cwd: ROOT,
    env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
    stdio: ["ignore", "pipe", "pipe"]
  }));
  let tail = "";
  const remember = (chunk) => { tail = (tail + chunk.toString()).slice(-8000); };
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);

  log(`starting private Vite at ${viteUrl} (relay ${relayPort})`);
  try {
    await waitHttp(viteUrl, 60_000, "Vite", child);
  } catch (error) {
    await terminate(child);
    throw new Error(`${error.message}${tail.trim() ? `\n${tail.trim()}` : ""}`);
  }
  return {
    url: viteUrl,
    owned: true,
    close: () => terminate(child)
  };
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate.includes("/") || await fileExists(candidate)) return candidate;
  }
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to its executable.");
}

class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #eventListeners = new Set();

  constructor(webSocketUrl) {
    this.#socket = new WebSocket(webSocketUrl);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", reject, { once: true });
    });
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (!message.id) {
        for (const listener of this.#eventListeners) listener(message);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
    this.#socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`${pending.method}: CDP connection closed`));
      }
      this.#pending.clear();
    });
  }

  onEvent(listener) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  send(method, params = {}, timeoutMs = 180_000) {
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: CDP socket is not open`));
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
    });
  }

  close() {
    try { this.#socket.close(); } catch {}
  }
}

export async function evaluate(client, expression, { awaitPromise = true, returnByValue = true } = {}) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue,
    userGesture: true
  });
  if (result.exceptionDetails) {
    const exception = result.exceptionDetails.exception;
    const message = exception?.description ?? exception?.value ?? result.exceptionDetails.text ?? "unknown page exception";
    throw new Error(`page evaluation failed: ${message}`);
  }
  return result.result?.value;
}

async function waitForExpression(client, expression, timeoutMs, label) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await evaluate(client, expression)) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError})` : ""}`);
}

function seededRandomScript(seed) {
  return `(() => {
    let state = ${seed >>> 0} >>> 0;
    const random = () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    Object.defineProperty(Math, "random", { value: random, configurable: false, writable: false });
    Object.defineProperty(globalThis, "__sfCinematicSeed", { value: ${seed >>> 0}, configurable: false });
  })();`;
}

async function launchChrome({ production, profileDir, log = defaultLog }) {
  const chromeBin = await findChrome();
  const debuggingPort = await freePort();
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const flags = [
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars",
    "--mute-audio",
    `--window-size=${production.width},${production.height}`,
    "--force-device-scale-factor=1"
  ];
  if (process.platform === "darwin") flags.push("--use-angle=metal");
  flags.push("about:blank");

  const child = track(spawn(chromeBin, flags, { cwd: ROOT, stdio: "ignore" }));
  let version;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null) throw new Error(`Chrome exited during launch (${child.exitCode})`);
    try {
      version = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/version`)).json();
      break;
    } catch {}
    await sleep(200);
  }
  if (!version) {
    await terminate(child);
    throw new Error("Chrome did not expose a CDP endpoint");
  }

  const target = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/new?about:blank`, { method: "PUT" })).json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Network.enable"),
    client.send("Log.enable")
  ]);

  const diagnostics = { exceptions: [], console: [], networkFailures: [] };
  client.onEvent((event) => {
    if (event.method === "Runtime.exceptionThrown") {
      const details = event.params?.exceptionDetails;
      diagnostics.exceptions.push({
        text: details?.exception?.description ?? details?.text ?? "unknown exception",
        url: details?.url ?? "",
        line: details?.lineNumber ?? null
      });
    } else if (event.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(event.params?.type)) {
      diagnostics.console.push({
        type: event.params.type,
        text: (event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 2000)
      });
    } else if (event.method === "Network.loadingFailed" && !event.params?.canceled) {
      diagnostics.networkFailures.push({
        requestId: event.params?.requestId,
        errorText: event.params?.errorText ?? "unknown network failure",
        type: event.params?.type ?? ""
      });
    }
  });

  // This runs in the main world before any application or dependency script.
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: seededRandomScript(production.seed) });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: production.width,
    height: production.height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: production.width,
    screenHeight: production.height
  });

  log(`Chrome ${version.Browser ?? ""} seeded with ${production.seed}`.trim());
  return {
    client,
    diagnostics,
    close: async () => {
      try { await client.send("Browser.close", {}, 2500); } catch {}
      client.close();
      await terminate(child);
    }
  };
}

export function cinematicPaths(production) {
  const workDir = path.join(WORK_ROOT, production.id, production.take);
  const outputDir = path.join(OUTPUT_ROOT, production.id);
  const baseName = `${production.id}-${production.take}`;
  return {
    workDir,
    framesDir: path.join(workDir, "frames"),
    fastBitstream: path.join(workDir, "fast-video.h264"),
    audioFile: path.join(workDir, "audio.wav"),
    chromeProfile: path.join(workDir, "chrome"),
    workManifest: path.join(workDir, "frame-manifest.json"),
    outputDir,
    videoFile: path.join(outputDir, `${baseName}.mp4`),
    posterFile: path.join(outputDir, `${baseName}.poster.jpg`),
    contactFile: path.join(outputDir, `${baseName}.contact.jpg`),
    auditFile: path.join(outputDir, `${baseName}.audit.json`),
    outputManifest: path.join(outputDir, `${baseName}.frames.json`),
    stillsDir: path.join(outputDir, `${baseName}.stills`),
    probesDir: path.join(outputDir, `${baseName}.probes`)
  };
}

function shotUrl(viteUrl, production, { fast = false } = {}) {
  const url = new URL(viteUrl);
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("demo", production.demo);
  url.searchParams.set("manual", "1");
  url.searchParams.set("autostart", "1");
  url.searchParams.set("fullfps", "1");
  if (fast) url.searchParams.set("fastcapture", "1");
  return url.href;
}

function frameIndexAt(time, production) {
  const seconds = Number(time);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= production.duration) {
    throw new Error(`probe/still time must be in [0, ${production.duration}) (received ${time})`);
  }
  return Math.min(production.totalFrames - 1, Math.round(seconds * production.fps));
}

function selectedFrames(production, mode, probeAt) {
  if (mode === "full") return Array.from({ length: production.totalFrames }, (_, index) => index);
  const times = mode === "stills" ? production.stillTimes : probeAt;
  if (!times?.length) throw new Error("--probe-at requires at least one time in seconds");
  return [...new Set(times.map((time) => frameIndexAt(time, production)))].sort((a, b) => a - b);
}

function frameName(index, format) {
  return `frame_${String(index).padStart(6, "0")}.${format}`;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixedNumber(value) {
  return Number(value).toPrecision(17);
}

// One authoritative frame barrier: advance the pure timeline and tick exactly
// one requested dt. Screenshot capture waits for GPU + browser composition;
// fast capture instead appends a copyTextureToBuffer command to the same queue
// and lets its two staging slots overlap GPU readback with the following frame.
async function stepFrame(client, time, dt, { fastFrameIndex = null } = {}) {
  const fastEncode = Number.isInteger(fastFrameIndex)
    ? `await window.__sfFastCapture.encode(${fastFrameIndex}, desiredTime);`
    : "";
  const compositorBarrier = Number.isInteger(fastFrameIndex)
    ? ""
    : `
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await queue.onSubmittedWorkDone();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await queue.onSubmittedWorkDone();
    `;
  return evaluate(client, `(async () => {
    const sf = window.__sf;
    if (!sf || typeof sf.tick !== "function") throw new Error("window.__sf.tick is unavailable");
    if (typeof window.__sfReelStep !== "function") throw new Error("window.__sfReelStep is unavailable");
    const desiredTime = ${fixedNumber(time)};
    window.__sfReelStep(desiredTime);
    await Promise.resolve(sf.tick(${fixedNumber(dt)}));
    // A cold WebGPU boot can still be inside the app's exclusive shader/pipeline
    // warm-up. In that state tick() deliberately returns before the cinematic
    // hook. Never accept the virtual clock alone: hold this authored time and
    // issue zero-dt ticks until the actually rendered cinematic state catches up.
    let catchupTicks = 0;
    while (Math.abs(Number(window.__sfCinematicState?.time ?? -1) - desiredTime) > 1e-6) {
      if (++catchupTicks > 600) {
        throw new Error(
          "cinematic render state did not reach " + desiredTime +
          " (last " + Number(window.__sfCinematicState?.time ?? -1) + ")"
        );
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.__sfReelStep(desiredTime);
      await Promise.resolve(sf.tick(0));
    }
    const queue = sf.renderer?.backend?.device?.queue;
    if (!queue || typeof queue.onSubmittedWorkDone !== "function") {
      throw new Error("WebGPU queue.onSubmittedWorkDone is unavailable");
    }
    ${compositorBarrier}
    ${fastEncode}
    return {
      cineT: Number(window.__cineT ?? desiredTime),
      cinematicTime: Number(window.__sfCinematicState?.time ?? -1),
      catchupTicks,
      gpuComplete: true
    };
  })()`);
}

function avcCodecFor(production) {
  // High@4.2 covers 1080p60. Use High@5.1 above that envelope so resolution
  // overrides remain useful without changing the one production schema.
  return production.width * production.height * production.fps <= 1920 * 1080 * 60
    ? "avc1.64002A"
    : "avc1.640033";
}

function fastEncoderSource(production) {
  const codec = avcCodecFor(production);
  const base = {
    codec,
    width: production.width,
    height: production.height,
    bitrate: production.fastBitrate,
    framerate: production.fps,
    bitrateMode: "variable",
    latencyMode: "realtime",
    avc: { format: "annexb" }
  };
  const candidates = [
    { ...base, hardwareAcceleration: "prefer-hardware" },
    { ...base, hardwareAcceleration: "no-preference" },
    { ...base, codec: codec.replace("6400", "4D00"), hardwareAcceleration: "prefer-software" }
  ];
  return `(async () => {
    if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function") {
      throw new Error("FAST_CAPTURE_UNSUPPORTED: WebCodecs VideoEncoder/VideoFrame unavailable");
    }
    const sf = window.__sf;
    const queueFastFrame = sf?.pipeline?.queueFastFrame;
    const drainFastFrame = sf?.pipeline?.drainFastFrame;
    const captureSize = sf?.pipeline?.fastCaptureSize;
    if (typeof queueFastFrame !== "function" || typeof drainFastFrame !== "function" || !Array.isArray(captureSize)) {
      throw new Error("FAST_CAPTURE_UNSUPPORTED: final WebGPU capture target unavailable");
    }
    const overlay = window.__sfCinematicOverlayCanvas;
    if (!(overlay instanceof HTMLCanvasElement)) {
      throw new Error("FAST_CAPTURE_UNSUPPORTED: cinematic overlay canvas unavailable");
    }
    const candidates = ${JSON.stringify(candidates)};
    let chosen = null;
    for (const candidate of candidates) {
      try {
        const support = await VideoEncoder.isConfigSupported(candidate);
        if (support.supported) { chosen = support.config; break; }
      } catch {}
    }
    if (!chosen) {
      throw new Error("FAST_CAPTURE_UNSUPPORTED: no Annex-B H.264 WebCodecs configuration is supported");
    }
    const composite = document.createElement("canvas");
    composite.width = ${production.width};
    composite.height = ${production.height};
    const ctx = composite.getContext("2d", { alpha: false, desynchronized: true, colorSpace: "srgb" });
    if (!ctx) throw new Error("FAST_CAPTURE_UNSUPPORTED: 2D composite canvas unavailable");
    const world = document.createElement("canvas");
    world.width = composite.width;
    world.height = composite.height;
    const worldCtx = world.getContext("2d", { alpha: false, desynchronized: true, colorSpace: "srgb" });
    if (!worldCtx) throw new Error("FAST_CAPTURE_UNSUPPORTED: world readback canvas unavailable");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    await document.fonts?.ready;

    const toBase64 = (bytes) => {
      let binary = "";
      const stride = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += stride) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + stride)));
      }
      return btoa(binary);
    };
    let framesEncoded = 0;
    let chunksEmitted = 0;
    let bytesEmitted = 0;
    let keyframes = 0;
    let fatalError = null;
    const encoder = new VideoEncoder({
      output(chunk) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        chunksEmitted++;
        bytesEmitted += bytes.byteLength;
        if (chunk.type === "key") keyframes++;
        window.__sfCineChunk(JSON.stringify({
          kind: "chunk",
          index: chunksEmitted - 1,
          chunkType: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? null,
          data: toBase64(bytes)
        }));
      },
      error(error) {
        fatalError = String(error?.stack ?? error?.message ?? error);
        window.__sfCineChunk(JSON.stringify({ kind: "error", message: fatalError }));
      }
    });
    encoder.configure(chosen);
    const keyInterval = ${Math.max(1, production.fps * 2)};
    const fps = ${production.fps};
    const pendingOverlays = [];

    const encodePixels = async (index, pixels, overlayBitmap) => {
      if (pixels.byteLength !== composite.width * composite.height * 4) {
        throw new Error(
          "fast readback size mismatch: " + pixels.byteLength +
          " vs " + (composite.width * composite.height * 4)
        );
      }
      worldCtx.putImageData(new ImageData(pixels, composite.width, composite.height), 0, 0);
      ctx.drawImage(world, 0, 0, composite.width, composite.height);
      ctx.drawImage(overlayBitmap, 0, 0, composite.width, composite.height);
      overlayBitmap.close();
      const timestamp = Math.round(index * 1000000 / fps);
      const nextTimestamp = Math.round((index + 1) * 1000000 / fps);
      const frame = new VideoFrame(composite, {
        timestamp,
        duration: nextTimestamp - timestamp,
        alpha: "discard"
      });
      encoder.encode(frame, { keyFrame: index % keyInterval === 0 });
      frame.close();
      framesEncoded++;
      if (encoder.encodeQueueSize >= 4) await encoder.flush();
    };

    window.__sfFastCapture = {
      config: chosen,
      async encode(index) {
        if (fatalError) throw new Error(fatalError);
        pendingOverlays.push({ index, bitmap: await createImageBitmap(overlay) });
        const pixels = await queueFastFrame();
        if (!pixels) return;
        const pending = pendingOverlays.shift();
        if (!pending) throw new Error("fast overlay/readback queue underflow");
        await encodePixels(pending.index, pixels, pending.bitmap);
      },
      async finish() {
        const pixels = await drainFastFrame();
        if (pixels) {
          const pending = pendingOverlays.shift();
          if (!pending) throw new Error("fast final overlay/readback queue underflow");
          await encodePixels(pending.index, pixels, pending.bitmap);
        }
        if (pendingOverlays.length) throw new Error("fast overlay/readback queue did not fully drain");
        await encoder.flush();
        if (fatalError) throw new Error(fatalError);
        const report = { framesEncoded, chunksEmitted, bytesEmitted, keyframes, config: chosen };
        window.__sfCineChunk(JSON.stringify({ kind: "done", report }));
        encoder.close();
        return report;
      }
    };
    return { config: chosen, source: captureSize, overlay: [overlay.width, overlay.height] };
  })()`;
}

async function createFastBitstreamSink(client, file) {
  await mkdir(path.dirname(file), { recursive: true });
  await rm(file, { force: true });
  const handle = await open(file, "w");
  let writeChain = Promise.resolve();
  let chunks = 0;
  let bytes = 0;
  let keyframes = 0;
  let settled = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const off = client.onEvent((event) => {
    if (event.method !== "Runtime.bindingCalled" || event.params?.name !== "__sfCineChunk") return;
    try {
      const message = JSON.parse(event.params.payload);
      if (message.kind === "chunk") {
        const data = Buffer.from(message.data, "base64");
        chunks++;
        bytes += data.byteLength;
        if (message.chunkType === "key") keyframes++;
        writeChain = writeChain.then(() => handle.write(data));
      } else if (message.kind === "error") {
        if (!settled) {
          settled = true;
          rejectDone(new Error(`browser WebCodecs encoder failed: ${message.message}`));
        }
      } else if (message.kind === "done" && !settled) {
        settled = true;
        writeChain.then(
          () => resolveDone({ chunks, bytes, keyframes, browser: message.report }),
          rejectDone
        );
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        rejectDone(error);
      }
    }
  });
  return {
    wait: () => done,
    async close() {
      off();
      await writeChain.catch(() => {});
      await handle.close();
    }
  };
}

async function captureScreenshot(client, production) {
  const params = {
    format: production.frameFormat === "jpg" ? "jpeg" : "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: false,
    clip: {
      x: 0,
      y: 0,
      width: production.width,
      height: production.height,
      scale: 1
    }
  };
  if (production.frameFormat === "jpg") params.quality = production.jpegQuality;
  const result = await client.send("Page.captureScreenshot", params, 180_000);
  return Buffer.from(result.data, "base64");
}

async function listCapturedFrames(directory, format) {
  try {
    const pattern = new RegExp(`^frame_(\\d{6})\\.${format}$`);
    return (await readdir(directory))
      .map((name) => ({ name, match: name.match(pattern) }))
      .filter((entry) => entry.match)
      .map((entry) => ({ name: entry.name, index: Number(entry.match[1]) }))
      .sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

function captureManifestFiles(paths, mode) {
  if (mode === "full") return [paths.workManifest, paths.outputManifest];
  const directory = mode === "stills" ? paths.stillsDir : paths.probesDir;
  return [path.join(directory, "frame-manifest.json"), path.join(paths.workDir, `${mode}-frame-manifest.json`)];
}

async function persistCaptureManifest(manifestFiles, manifest) {
  await Promise.all(manifestFiles.map((file) => writeJson(file, manifest)));
}

async function sourceRevision() {
  try {
    const [{ output: head }, { output: status }] = await Promise.all([
      runCommand("git", ["rev-parse", "HEAD"], { capture: true, log: () => {} }),
      runCommand("git", ["status", "--porcelain"], { capture: true, log: () => {} })
    ]);
    return { head: head.trim(), dirty: Boolean(status.trim()) };
  } catch {
    return { head: null, dirty: null };
  }
}

/**
 * Capture a deterministic production. Preview modes still replay every frame
 * from zero and merely omit screenshots for frames that were not requested.
 * There is intentionally no FROM/TO or partial-seek API.
 */
export async function captureProduction({
  production,
  viteUrl,
  mode = "full",
  probeAt = [],
  paths = cinematicPaths(production),
  readyTimeoutMs = Number(process.env.SF_CINE_READY_TIMEOUT_MS ?? 180_000),
  log = defaultLog
}) {
  if (!["full", "stills", "probe"].includes(mode)) throw new Error(`unknown capture mode ${JSON.stringify(mode)}`);
  if (!viteUrl) throw new Error("captureProduction requires viteUrl");

  const targets = selectedFrames(production, mode, probeAt);
  const targetSet = new Set(targets);
  const lastFrame = targets.at(-1);
  const captureDir = mode === "full" ? paths.framesDir : mode === "stills" ? paths.stillsDir : paths.probesDir;
  const manifestFiles = captureManifestFiles(paths, mode);
  await rm(captureDir, { recursive: true, force: true });
  await mkdir(captureDir, { recursive: true });
  await mkdir(paths.workDir, { recursive: true });

  const manifest = {
    schema: 1,
    status: "capturing",
    production: {
      id: production.id,
      demo: production.demo,
      title: production.title,
      duration: production.duration,
      width: production.width,
      height: production.height,
      fps: production.fps,
      totalFrames: production.totalFrames,
      seed: production.seed,
      take: production.take
    },
    capture: {
      mode,
      format: production.frameFormat,
      jpegQuality: production.frameFormat === "jpg" ? production.jpegQuality : null,
      selectedFrames: targets,
      replayedFromFrame: 0,
      replayedThroughFrame: lastFrame,
      settleFrames: production.settleFrames,
      settleGapMs: production.settleGapMs,
      gpuBarrier: "WebGPUQueue.onSubmittedWorkDone before every screenshot"
    },
    url: shotUrl(viteUrl, production),
    source: await sourceRevision(),
    startedAt: new Date().toISOString(),
    frames: [],
    diagnostics: null,
    cinematicReport: null
  };
  await persistCaptureManifest(manifestFiles, manifest);

  const browser = await launchChrome({
    production,
    profileDir: `${paths.chromeProfile}-${mode}`,
    log
  });
  const { client, diagnostics } = browser;
  const startedAt = Date.now();
  try {
    const url = manifest.url;
    log(`${production.id}: ${mode} replay 0..${lastFrame} -> ${url}`);
    const navigation = await client.send("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`navigation failed: ${navigation.errorText}`);

    await waitForExpression(
      client,
      `Boolean(
        window.__sfReelArmed &&
        window.__sf &&
        typeof window.__sf.tick === "function" &&
        typeof window.__sfReelStep === "function" &&
        typeof window.__sfManual === "function" &&
        window.__sf.renderer?.backend?.device?.queue?.onSubmittedWorkDone
      )`,
      readyTimeoutMs,
      `${production.demo} __sfReelArmed + WebGPU queue`
    );

    await evaluate(client, `window.__sfManual(true); window.__sfReelStep(0); true`);
    log(`${production.id}: pre-roll/settle at frame zero (${production.settleFrames} zero-dt frames)`);
    for (let index = 0; index < production.settleFrames; index++) {
      await stepFrame(client, 0, 0);
      if (production.settleGapMs) await sleep(production.settleGapMs);
    }

    // All capture modes start here and advance monotonically one exact dt at a
    // time. A 12-second probe therefore evaluates frames 0..720; it never seeks.
    for (let index = 0; index <= lastFrame; index++) {
      const time = index / production.fps;
      const frameState = await stepFrame(client, time, production.dt);
      if (Math.abs(frameState.cineT - time) > 1e-6) {
        throw new Error(`timeline drift at frame ${index}: expected ${time}, page reported ${frameState.cineT}`);
      }
      if (Math.abs(frameState.cinematicTime - time) > 1e-6) {
        throw new Error(
          `render-state drift at frame ${index}: expected ${time}, page rendered ${frameState.cinematicTime}`
        );
      }

      if (targetSet.has(index)) {
        const bytes = await captureScreenshot(client, production);
        const name = frameName(index, production.frameFormat);
        await writeFile(path.join(captureDir, name), bytes);
        manifest.frames.push({
          index,
          time,
          file: path.relative(ROOT, path.join(captureDir, name)),
          bytes: bytes.byteLength,
          gpuComplete: frameState.gpuComplete === true
        });
      }

      if (index === 0 || index === lastFrame || (index > 0 && index % Math.max(120, production.fps * 2) === 0)) {
        const elapsed = Math.max(1, Date.now() - startedAt);
        const rate = (index + 1) / (elapsed / 1000);
        const remaining = Math.max(0, lastFrame - index);
        log(`${production.id}: frame ${index}/${lastFrame} (${time.toFixed(2)}s, ${rate.toFixed(2)} replay fps, ETA ${Math.round(remaining / Math.max(rate, 0.001))}s)`);
        await persistCaptureManifest(manifestFiles, manifest);
      }
    }

    const captured = await listCapturedFrames(captureDir, production.frameFormat);
    if (captured.length !== targets.length || captured.some((entry, index) => entry.index !== targets[index])) {
      throw new Error(`frame sequence mismatch: expected [${targets.join(",")}], found [${captured.map((entry) => entry.index).join(",")}]`);
    }
    manifest.status = "complete";
    manifest.completedAt = new Date().toISOString();
    manifest.wallSeconds = (Date.now() - startedAt) / 1000;
    manifest.diagnostics = diagnostics;
    manifest.cinematicReport = await evaluate(client, "window.__sfCinematicReport?.() ?? null");
    await persistCaptureManifest(manifestFiles, manifest);
    log(`${production.id}: captured ${targets.length} frame${targets.length === 1 ? "" : "s"} after exact replay through ${lastFrame}`);
    return { manifest, captureDir, manifestFiles, paths };
  } catch (error) {
    manifest.status = "failed";
    manifest.completedAt = new Date().toISOString();
    manifest.error = error instanceof Error ? error.message : String(error);
    manifest.diagnostics = diagnostics;
    try {
      manifest.cinematicReport = await evaluate(client, "window.__sfCinematicReport?.() ?? null");
    } catch {}
    await persistCaptureManifest(manifestFiles, manifest);
    throw error;
  } finally {
    await browser.close();
  }
}

/**
 * Browser-native review renderer. Frames stay inside Chrome: the real WebGPU
 * canvas and a deterministic overlay mirror are composited into a 2D canvas,
 * encoded by WebCodecs, and streamed as Annex-B H.264 through a CDP binding.
 * The archival PNG path above remains the fallback/master implementation.
 */
export async function captureFastProduction({
  production,
  viteUrl,
  paths = cinematicPaths(production),
  readyTimeoutMs = Number(process.env.SF_CINE_READY_TIMEOUT_MS ?? 180_000),
  log = defaultLog
}) {
  if (!viteUrl) throw new Error("captureFastProduction requires viteUrl");
  await mkdir(paths.workDir, { recursive: true });
  await mkdir(paths.outputDir, { recursive: true });
  await rm(paths.fastBitstream, { force: true });
  const manifestFiles = [paths.workManifest, paths.outputManifest];
  const manifest = {
    schema: 1,
    status: "capturing",
    production: {
      id: production.id,
      demo: production.demo,
      title: production.title,
      duration: production.duration,
      width: production.width,
      height: production.height,
      fps: production.fps,
      totalFrames: production.totalFrames,
      seed: production.seed,
      take: production.take
    },
    capture: {
      mode: "fast",
      backend: "browser-webcodecs",
      intermediate: "annexb-h264",
      bitrate: production.fastBitrate,
      replayedFromFrame: 0,
      replayedThroughFrame: production.totalFrames - 1,
      settleFrames: production.settleFrames,
      settleGapMs: production.settleGapMs,
      gpuBarrier: "ordered render→copyTextureToBuffer with two MAP_READ staging slots"
    },
    url: shotUrl(viteUrl, production, { fast: true }),
    source: await sourceRevision(),
    startedAt: new Date().toISOString(),
    diagnostics: null
  };
  await persistCaptureManifest(manifestFiles, manifest);

  const browser = await launchChrome({
    production,
    profileDir: `${paths.chromeProfile}-fast`,
    log
  });
  const { client, diagnostics } = browser;
  let sink = null;
  const startedAt = Date.now();
  try {
    sink = await createFastBitstreamSink(client, paths.fastBitstream);
    await client.send("Runtime.addBinding", { name: "__sfCineChunk" });
    log(`${production.id}: fast WebCodecs replay 0..${production.totalFrames - 1} -> ${manifest.url}`);
    const navigation = await client.send("Page.navigate", { url: manifest.url });
    if (navigation.errorText) throw new Error(`navigation failed: ${navigation.errorText}`);

    await waitForExpression(
      client,
      `Boolean(
        window.__sfReelArmed &&
        window.__sf &&
        typeof window.__sf.tick === "function" &&
        typeof window.__sfReelStep === "function" &&
        typeof window.__sfManual === "function" &&
        window.__sf.renderer?.backend?.device?.queue?.onSubmittedWorkDone &&
        window.__sfCinematicOverlayCanvas
      )`,
      readyTimeoutMs,
      `${production.demo} cinematic + WebGPU + overlay mirror`
    );

    await evaluate(client, `window.__sfManual(true); window.__sfReelStep(0); true`);
    log(`${production.id}: fast pre-roll/settle at frame zero (${production.settleFrames} zero-dt frames)`);
    for (let index = 0; index < production.settleFrames; index++) {
      await stepFrame(client, 0, 0);
      if (production.settleGapMs) await sleep(production.settleGapMs);
    }

    const encoder = await evaluate(client, fastEncoderSource(production));
    manifest.capture.encoder = encoder;
    log(
      `${production.id}: WebCodecs ${encoder.config.codec}, ` +
      `${Math.round(production.fastBitrate / 1_000_000)}Mbps, ${encoder.config.hardwareAcceleration}`
    );

    for (let index = 0; index < production.totalFrames; index++) {
      const time = index / production.fps;
      const frameState = await stepFrame(client, time, production.dt, { fastFrameIndex: index });
      if (Math.abs(frameState.cineT - time) > 1e-6 || Math.abs(frameState.cinematicTime - time) > 1e-6) {
        throw new Error(
          `fast render-state drift at frame ${index}: expected ${time}, ` +
          `clock=${frameState.cineT}, rendered=${frameState.cinematicTime}`
        );
      }
      if (index === 0 || index === production.totalFrames - 1 || (index > 0 && index % Math.max(120, production.fps * 2) === 0)) {
        const elapsed = Math.max(1, Date.now() - startedAt);
        const rate = (index + 1) / (elapsed / 1000);
        const remaining = Math.max(0, production.totalFrames - index - 1);
        log(`${production.id}: fast frame ${index}/${production.totalFrames - 1} (${time.toFixed(2)}s, ${rate.toFixed(2)} fps, ETA ${Math.round(remaining / Math.max(rate, 0.001))}s)`);
        await persistCaptureManifest(manifestFiles, manifest);
      }
    }

    const browserReport = await evaluate(client, "window.__sfFastCapture.finish()");
    const sinkReport = await sink.wait();
    if (browserReport.framesEncoded !== production.totalFrames) {
      throw new Error(`WebCodecs encoded ${browserReport.framesEncoded} frames; expected ${production.totalFrames}`);
    }
    if (sinkReport.chunks !== browserReport.chunksEmitted || sinkReport.bytes !== browserReport.bytesEmitted) {
      throw new Error(
        `WebCodecs stream mismatch: browser ${browserReport.chunksEmitted}/${browserReport.bytesEmitted}, ` +
        `node ${sinkReport.chunks}/${sinkReport.bytes}`
      );
    }
    const bitstreamInfo = await stat(paths.fastBitstream);
    if (bitstreamInfo.size <= 0) throw new Error("WebCodecs produced an empty H.264 bitstream");

    manifest.status = "complete";
    manifest.completedAt = new Date().toISOString();
    manifest.wallSeconds = (Date.now() - startedAt) / 1000;
    manifest.capture.report = sinkReport;
    manifest.capture.bitstream = path.relative(ROOT, paths.fastBitstream);
    manifest.diagnostics = diagnostics;
    manifest.cinematicReport = await evaluate(client, "window.__sfCinematicReport?.() ?? null");
    await persistCaptureManifest(manifestFiles, manifest);
    log(`${production.id}: fast encoded ${production.totalFrames} frames in ${manifest.wallSeconds.toFixed(1)}s`);
    return { manifest, bitstreamFile: paths.fastBitstream, paths };
  } catch (error) {
    manifest.status = "failed";
    manifest.completedAt = new Date().toISOString();
    manifest.error = error instanceof Error ? error.message : String(error);
    manifest.diagnostics = diagnostics;
    try {
      manifest.cinematicReport = await evaluate(client, "window.__sfCinematicReport?.() ?? null");
    } catch {}
    await persistCaptureManifest(manifestFiles, manifest);
    throw error;
  } finally {
    await sink?.close();
    await browser.close();
  }
}

async function verifyExactFrameSequence(production, framesDir) {
  const frames = await listCapturedFrames(framesDir, production.frameFormat);
  if (frames.length !== production.totalFrames) {
    throw new Error(`expected exactly ${production.totalFrames} ${production.frameFormat} frames in ${relativeToRoot(framesDir)}, found ${frames.length}`);
  }
  for (let index = 0; index < frames.length; index++) {
    if (frames[index].index !== index) throw new Error(`frame sequence has a gap at ${index} in ${relativeToRoot(framesDir)}`);
  }
  return frames;
}

export async function encodeProduction({
  production,
  paths = cinematicPaths(production),
  audioFile = paths.audioFile,
  ffmpeg = process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg",
  log = defaultLog
}) {
  await verifyExactFrameSequence(production, paths.framesDir);
  if (!(await fileExists(audioFile))) throw new Error(`cinematic audio is missing: ${relativeToRoot(audioFile)}`);
  await mkdir(paths.outputDir, { recursive: true });

  const temporary = `${paths.videoFile}.tmp.mp4`;
  await rm(temporary, { force: true });
  const inputPattern = path.join(paths.framesDir, `frame_%06d.${production.frameFormat}`);
  // PNG/JPEG screenshots do not consistently carry primaries/transfer fields.
  // Set both frame metadata (setparams, consumed by libx264 VUI) and container
  // tags below; output flags alone leave Chrome PNG input as unknown/unknown.
  const scale = [
    `scale=${production.width}:${production.height}:flags=lanczos:out_color_matrix=bt709`,
    "setsar=1",
    "format=yuv420p",
    "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
  ].join(",");
  const duration = String(production.duration);
  const keyint = Math.max(1, production.fps * 2);
  log(`${production.id}: encoding H.264 CRF ${production.crf} + AAC 192k with BT.709 tags`);
  await runCommand(ffmpeg, [
    "-hide_banner", "-y",
    "-framerate", String(production.fps),
    "-start_number", "0",
    "-i", inputPattern,
    "-i", audioFile,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-vf", scale,
    "-r", String(production.fps),
    "-fps_mode", "cfr",
    "-frames:v", String(production.totalFrames),
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "slow",
    "-crf", String(production.crf),
    "-x264-params", `keyint=${keyint}:min-keyint=${production.fps}:scenecut=40`,
    "-pix_fmt", "yuv420p",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    "-color_range", "tv",
    "-af", `apad=whole_dur=${duration}`,
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-t", duration,
    "-metadata", `title=${production.title}`,
    "-metadata", `comment=Deterministic cinematic seed ${production.seed}`,
    "-movflags", "+faststart",
    temporary
  ], { log });
  await rename(temporary, paths.videoFile);

  const info = await stat(paths.videoFile);
  let manifest;
  try { manifest = JSON.parse(await readFile(paths.workManifest, "utf8")); } catch { manifest = {}; }
  manifest.output = {
    file: path.relative(ROOT, paths.videoFile),
    bytes: info.size,
    video: { codec: "h264", crf: production.crf, pixelFormat: "yuv420p", color: "bt709" },
    audio: { codec: "aac", bitrate: 192000, sampleRate: 48000, channels: 2 }
  };
  await Promise.all([writeJson(paths.workManifest, manifest), writeJson(paths.outputManifest, manifest)]);
  return { file: paths.videoFile, bytes: info.size };
}

/** Remux the browser's already-encoded Annex-B stream and add final audio. */
export async function muxFastProduction({
  production,
  paths = cinematicPaths(production),
  audioFile = paths.audioFile,
  ffmpeg = process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg",
  log = defaultLog
}) {
  if (!(await fileExists(paths.fastBitstream))) {
    throw new Error(`fast H.264 bitstream is missing: ${relativeToRoot(paths.fastBitstream)}`);
  }
  if (!(await fileExists(audioFile))) throw new Error(`cinematic audio is missing: ${relativeToRoot(audioFile)}`);
  await mkdir(paths.outputDir, { recursive: true });
  const temporary = `${paths.videoFile}.tmp.mp4`;
  await rm(temporary, { force: true });
  const duration = String(production.duration);
  log(`${production.id}: remuxing browser H.264 + AAC 192k with BT.709 metadata`);
  await runCommand(ffmpeg, [
    "-hide_banner", "-y",
    "-f", "h264",
    "-i", paths.fastBitstream,
    "-i", audioFile,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-bsf:v",
    `setts=pts=N/${production.fps}/TB:dts=N/${production.fps}/TB:duration=1/${production.fps}/TB,` +
      "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0",
    "-frames:v", String(production.totalFrames),
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    "-color_range", "tv",
    "-af", `apad=whole_dur=${duration}`,
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-t", duration,
    "-metadata", `title=${production.title}`,
    "-metadata", `comment=Browser WebCodecs fast cinematic seed ${production.seed}`,
    "-movflags", "+faststart",
    temporary
  ], { log });
  await rename(temporary, paths.videoFile);

  const info = await stat(paths.videoFile);
  let manifest;
  try { manifest = JSON.parse(await readFile(paths.workManifest, "utf8")); } catch { manifest = {}; }
  manifest.output = {
    file: path.relative(ROOT, paths.videoFile),
    bytes: info.size,
    video: {
      codec: "h264",
      source: "browser-webcodecs",
      bitrate: production.fastBitrate,
      pixelFormat: "yuv420p",
      color: "bt709"
    },
    audio: { codec: "aac", bitrate: 192000, sampleRate: 48000, channels: 2 }
  };
  await Promise.all([writeJson(paths.workManifest, manifest), writeJson(paths.outputManifest, manifest)]);
  return { file: paths.videoFile, bytes: info.size };
}

export async function createReviewArtifacts({
  videoFile,
  posterFile,
  contactFile,
  duration,
  posterAt = Math.min(2, duration * 0.4),
  ffmpeg = process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg",
  log = defaultLog
}) {
  await mkdir(path.dirname(posterFile), { recursive: true });
  const posterTime = Math.max(0, Math.min(duration - 0.001, posterAt));
  log(`review: poster at ${posterTime.toFixed(2)}s + 12-frame contact sheet`);
  await runCommand(ffmpeg, [
    "-hide_banner", "-y",
    "-i", videoFile,
    // Output-side seek decodes from t=0; even review artifacts never rely on a
    // partial input seek that could skip state/GOP history.
    "-ss", String(posterTime),
    "-frames:v", "1",
    "-update", "1",
    "-q:v", "2",
    posterFile
  ], { log });

  const contactFps = 12 / duration;
  const contactFilter = [
    `fps=${contactFps}`,
    "scale=384:216:force_original_aspect_ratio=decrease:flags=lanczos",
    "pad=384:216:(ow-iw)/2:(oh-ih)/2:color=0x10131a",
    "tile=4x3:padding=8:margin=8:color=0x10131a"
  ].join(",");
  await runCommand(ffmpeg, [
    "-hide_banner", "-y",
    "-i", videoFile,
    "-vf", contactFilter,
    "-frames:v", "1",
    "-update", "1",
    "-q:v", "3",
    contactFile
  ], { log });
  return { posterFile, contactFile };
}

function fraction(value) {
  if (typeof value !== "string") return Number(value);
  const [numerator, denominator = "1"] = value.split("/");
  return Number(numerator) / Number(denominator);
}

export async function ffprobeVideo(videoFile, { ffprobe = process.env.FFPROBE_BIN ?? process.env.FFPROBE_PATH ?? "ffprobe" } = {}) {
  const { output } = await runCommand(ffprobe, [
    "-v", "error",
    "-count_frames",
    "-show_entries",
    "format=duration,size,bit_rate:stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height,sample_aspect_ratio,field_order,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration,color_space,color_transfer,color_primaries,color_range,bit_rate,sample_rate,channels,channel_layout",
    "-of", "json",
    videoFile
  ], { capture: true, log: () => {} });
  return JSON.parse(output);
}

async function visualDefectScan(videoFile, ffmpeg) {
  const { output } = await runCommand(ffmpeg, [
    "-hide_banner",
    "-i", videoFile,
    "-map", "0:v:0",
    "-an",
    "-vf", "blackdetect=d=0.25:pix_th=0.10,freezedetect=noise=-55dB:d=0.75",
    "-f", "null", "-"
  ], { capture: true, log: () => {} });

  const black = [...output.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)].map((match) => ({
    start: Number(match[1]),
    end: Number(match[2]),
    duration: Number(match[3])
  }));
  const starts = [...output.matchAll(/freeze_start:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...output.matchAll(/freeze_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const durations = [...output.matchAll(/freeze_duration:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const freeze = starts.map((start, index) => ({
    start,
    end: ends[index] ?? null,
    duration: durations[index] ?? (ends[index] === undefined ? null : ends[index] - start)
  }));
  return { black, freeze };
}

async function audioRms(videoFile, ffmpeg) {
  const { output } = await runCommand(ffmpeg, [
    "-hide_banner",
    "-i", videoFile,
    "-map", "0:a:0",
    "-af", "astats=metadata=1:reset=0",
    "-f", "null", "-"
  ], { capture: true, log: () => {} });
  const rmsMatches = [...output.matchAll(/RMS level dB:\s*(-?[\d.]+|-?inf)/gi)];
  const peakMatches = [...output.matchAll(/Peak level dB:\s*(-?[\d.]+|-?inf)/gi)];
  const parseDb = (match) => {
    if (!match || match[1].toLowerCase().includes("inf")) return -Infinity;
    return Number(match[1]);
  };
  return {
    rmsDb: parseDb(rmsMatches.at(-1)),
    peakDb: parseDb(peakMatches.at(-1))
  };
}

/** ffprobe + decoded black/freeze scan + final-mix RMS audit. */
export async function auditVideo({
  videoFile,
  expected,
  auditFile,
  ffmpeg = process.env.FFMPEG_BIN ?? process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobe = process.env.FFPROBE_BIN ?? process.env.FFPROBE_PATH ?? "ffprobe",
  log = defaultLog
}) {
  log(`audit: ffprobe + black/freeze scan + audio RMS for ${relativeToRoot(videoFile)}`);
  const probe = await ffprobeVideo(videoFile, { ffprobe });
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const defects = video ? await visualDefectScan(videoFile, ffmpeg) : { black: [], freeze: [] };
  const loudness = audio ? await audioRms(videoFile, ffmpeg) : { rmsDb: -Infinity, peakDb: -Infinity };
  const errors = [];
  const warnings = [];

  if (!video) errors.push("missing video stream");
  if (!audio) errors.push("missing audio stream");
  if (video && video.codec_name !== "h264") errors.push(`video codec is ${video.codec_name}, expected h264`);
  if (video && video.profile !== "High") errors.push(`H.264 profile is ${video.profile ?? "unset"}, expected High`);
  if (video && video.pix_fmt !== "yuv420p") errors.push(`pixel format is ${video.pix_fmt ?? "unset"}, expected yuv420p`);
  if (video?.sample_aspect_ratio && video.sample_aspect_ratio !== "1:1") errors.push(`sample aspect ratio is ${video.sample_aspect_ratio}, expected 1:1`);
  if (video?.field_order && video.field_order !== "progressive") errors.push(`field order is ${video.field_order}, expected progressive`);
  if (audio && audio.codec_name !== "aac") errors.push(`audio codec is ${audio.codec_name}, expected aac`);
  if (audio && Number(audio.sample_rate) !== 48_000) errors.push(`audio sample rate is ${audio.sample_rate}, expected 48000`);
  if (audio && Number(audio.channels) !== 2) errors.push(`audio has ${audio.channels} channels, expected stereo`);
  if (audio?.bit_rate && Number(audio.bit_rate) < 160_000) warnings.push(`AAC bitrate is ${audio.bit_rate}, below the 192k target`);

  if (video) {
    for (const [field, value] of [
      ["color_primaries", video.color_primaries],
      ["color_transfer", video.color_transfer],
      ["color_space", video.color_space]
    ]) {
      if (value !== "bt709") errors.push(`${field} is ${value ?? "unset"}, expected bt709`);
    }
    if (video.color_range !== "tv") errors.push(`color_range is ${video.color_range ?? "unset"}, expected tv/limited`);
  }

  if (expected && video) {
    if (Number(video.width) !== expected.width || Number(video.height) !== expected.height) {
      errors.push(`resolution is ${video.width}x${video.height}, expected ${expected.width}x${expected.height}`);
    }
    const measuredFps = fraction(video.avg_frame_rate);
    if (!Number.isFinite(measuredFps) || Math.abs(measuredFps - expected.fps) > 1e-6) {
      errors.push(`frame rate is ${video.avg_frame_rate}, expected ${expected.fps}`);
    }
    if (expected.totalFrames !== undefined) {
      const readFrames = Number(video.nb_read_frames ?? video.nb_frames);
      if (readFrames !== expected.totalFrames) errors.push(`decoded frame count is ${readFrames}, expected exactly ${expected.totalFrames}`);
    }
    if (expected.duration !== undefined) {
      const measuredDuration = Number(probe.format?.duration ?? video.duration);
      const tolerance = Math.max(0.025, 1 / expected.fps);
      if (!Number.isFinite(measuredDuration) || Math.abs(measuredDuration - expected.duration) > tolerance) {
        errors.push(`duration is ${measuredDuration}, expected ${expected.duration} ± ${tolerance.toFixed(4)}s`);
      }
    }
  }

  if (!Number.isFinite(loudness.rmsDb) || loudness.rmsDb <= -60) {
    errors.push(`audio RMS is ${Number.isFinite(loudness.rmsDb) ? loudness.rmsDb.toFixed(1) : "-inf"} dB (silent or nearly silent)`);
  }
  for (const event of defects.black) {
    warnings.push(`black segment ${event.start.toFixed(3)}s..${event.end.toFixed(3)}s (${event.duration.toFixed(3)}s)`);
  }
  for (const event of defects.freeze) {
    warnings.push(`freeze starts at ${event.start.toFixed(3)}s${event.duration === null ? "" : ` for ${event.duration.toFixed(3)}s`}`);
  }

  const report = {
    schema: 1,
    status: errors.length ? "failed" : warnings.length ? "warning" : "passed",
    file: path.relative(ROOT, videoFile),
    auditedAt: new Date().toISOString(),
    expected: expected ? {
      width: expected.width,
      height: expected.height,
      fps: expected.fps,
      duration: expected.duration,
      totalFrames: expected.totalFrames
    } : null,
    measured: {
      duration: Number(probe.format?.duration),
      bytes: Number(probe.format?.size),
      video,
      audio,
      audioRmsDb: loudness.rmsDb,
      audioPeakDb: loudness.peakDb,
      blackSegments: defects.black,
      freezeSegments: defects.freeze
    },
    errors,
    warnings
  };
  if (auditFile) await writeJson(auditFile, report);
  if (warnings.length) for (const warning of warnings) log(`WARN ${warning}`);
  if (errors.length) {
    const error = new Error(`cinematic audit failed: ${errors.join("; ")}`);
    error.report = report;
    throw error;
  }
  log(`audit ${report.status}: ${fraction(video.avg_frame_rate).toFixed(3)}fps, ${video.nb_read_frames ?? video.nb_frames} frames, RMS ${loudness.rmsDb.toFixed(1)} dB`);
  return report;
}
