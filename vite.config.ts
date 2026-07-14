import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

// Soft HMR is the default: in-place module swaps work, full page reloads are
// suppressed so multi-agent edits do not interrupt a play session.
//   SF_FULL_RELOAD=1 — restore Vite automatic full reloads (`npm run dev:hmr`)
//   SF_HMR=0         — disable the HMR websocket entirely (`npm run dev:play`)
const HMR_ENABLED = process.env.SF_HMR !== "0";
const FULL_RELOAD_ENABLED = process.env.SF_FULL_RELOAD === "1";

const RELAY_PORT = process.env.SF_RELAY_PORT || "8787";
const RELAY_WS = `ws://localhost:${RELAY_PORT}`;
const NATIVE_BASIS_PATH = "/native-foliage/basis-r185/";

/** True if nothing is listening on the relay port (best-effort; race still handled in server.mjs). */
function relayPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => {
      s.close(() => resolve(true));
    });
    s.listen(port, "0.0.0.0");
  });
}

// Dev multiplayer with zero extra terminals: when the dev server boots, start
// the WebSocket relay (server/server.mjs) in-process on 8787 and proxy /ws to
// it. If a relay is already running on that port (another vite, or a manual
// `npm run server`), skip starting and proxy to that one.
const relayPlugin = (): Plugin => ({
  name: "sf-multiplayer-relay",
  async configureServer() {
    const port = Number(RELAY_PORT);
    if (!(await relayPortFree(port))) {
      console.warn(`[sf] relay port ${port} already in use — proxying to existing relay`);
      return;
    }
    // server.mjs reads PORT at import — pin it to the relay port for the
    // import, then restore (hosting panels/preview harnesses inject PORT for
    // the dev server itself, which must not leak into the relay)
    const orig = process.env.PORT;
    process.env.PORT = RELAY_PORT;
    try {
      await import("./server/server.mjs");
    } catch (err) {
      console.warn("[sf] relay failed to start:", err);
    } finally {
      if (orig === undefined) delete process.env.PORT;
      else process.env.PORT = orig;
    }
  }
});

/**
 * Soft HMR: keep in-place module swaps, block every automatic full page reload.
 *
 * Vite still reloads on (1) full-reload WS messages, (2) HMR websocket reconnect
 * after a server restart, and (3) circular-import HMR failures via location.reload.
 * (1) is dropped on the server; (2)+(3) are neutered by rewriting the Vite client.
 */
const softHmrPlugin = (): Plugin => ({
  name: "sf-soft-hmr",
  configureServer(server) {
    if (FULL_RELOAD_ENABLED || !HMR_ENABLED) return;
    const send = server.ws.send.bind(server.ws);
    server.ws.send = ((payload: unknown, ...args: unknown[]) => {
      if (
        payload &&
        typeof payload === "object" &&
        "type" in payload &&
        (payload as { type?: string }).type === "full-reload"
      ) {
        const path =
          "path" in payload && typeof (payload as { path?: unknown }).path === "string"
            ? (payload as { path: string }).path
            : "";
        console.info(`[sf] full reload suppressed${path ? ` (${path})` : ""} — refresh manually when ready`);
        return;
      }
      return (send as (...a: unknown[]) => unknown)(payload, ...args);
    }) as typeof server.ws.send;
  },
  transform(code, id) {
    if (FULL_RELOAD_ENABLED || !HMR_ENABLED) return null;
    // @vite/client — also match query-suffixed / Windows paths
    const bare = id.split("?", 1)[0].replace(/\\/g, "/");
    if (!bare.endsWith("/vite/dist/client/client.mjs")) return null;
    if (!code.includes("location.reload()")) return null;
    return code.replaceAll(
      "location.reload()",
      '(console.info("[sf] automatic reload suppressed — refresh manually when ready"), undefined)'
    );
  }
});

/**
 * Three's KTX2 loader contains static new URL() fallbacks, so Rollup otherwise
 * emits a second unused Basis JS/WASM pair even when setTranscoderPath() points
 * at our versioned public copy. Rewrite those two fallback constants as well;
 * fail the build if a Three upgrade changes the pinned r185 source contract.
 */
const nativeFoliageBasisPlugin = (): Plugin => ({
  name: "sf-native-foliage-basis",
  enforce: "pre",
  transform(source, id) {
    if (!id.split("?", 1)[0].endsWith("/three/examples/jsm/loaders/KTX2Loader.js")) return null;
    const wasmSource = "const WASM_BIN_URL = new URL( '../libs/basis/basis_transcoder.wasm', import.meta.url ).toString();";
    const jsSource = "const WASM_JS_URL = new URL( '../libs/basis/basis_transcoder.js', import.meta.url ).toString();";
    if (!source.includes(wasmSource) || !source.includes(jsSource)) {
      throw new Error("Three KTX2Loader Basis URL contract changed; update the pinned native foliage transform");
    }
    return source
      .replace(wasmSource, `const WASM_BIN_URL = '${NATIVE_BASIS_PATH}basis_transcoder.wasm';`)
      .replace(jsSource, `const WASM_JS_URL = '${NATIVE_BASIS_PATH}basis_transcoder.js';`);
  }
});

/** Absolute folder for H-key in-game stills (local play only). */
const IN_GAME_SHOTS_DIR =
  process.env.SF_IN_GAME_SHOTS_DIR || "/Users/eric/videos/my creations/sf/in_game_shots";

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeShotFilename(raw: string | undefined): string {
  const fallback = `sf-${Date.now()}.png`;
  if (!raw) return fallback;
  const base = raw.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!base || base === "." || base === ".." || !base.endsWith(".png")) return fallback;
  return base;
}

/**
 * POST /api/in-game-shot — body is raw PNG bytes; writes into IN_GAME_SHOTS_DIR.
 * Dev-only path so H can dump stills without a Downloads dialog.
 */
const inGameShotPlugin = (): Plugin => ({
  name: "sf-in-game-shot",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = req.url?.split("?", 1)[0];
      if (url !== "/api/in-game-shot" || req.method !== "POST") {
        next();
        return;
      }
      try {
        const body = await readRequestBody(req as IncomingMessage);
        if (body.length < 8 || body[0] !== 0x89 || body[1] !== 0x50) {
          (res as ServerResponse).statusCode = 400;
          (res as ServerResponse).end("expected a PNG body");
          return;
        }
        const filename = safeShotFilename(
          typeof req.headers["x-sf-filename"] === "string" ? req.headers["x-sf-filename"] : undefined
        );
        await mkdir(IN_GAME_SHOTS_DIR, { recursive: true });
        const path = join(IN_GAME_SHOTS_DIR, filename);
        await writeFile(path, body);
        console.info(`[sf] in-game shot ${filename} (${body.length} bytes) → ${path}`);
        (res as ServerResponse).setHeader("Content-Type", "application/json");
        (res as ServerResponse).end(JSON.stringify({ ok: true, path, bytes: body.length }));
      } catch (err) {
        console.warn("[sf] in-game shot save failed:", err);
        (res as ServerResponse).statusCode = 500;
        (res as ServerResponse).end(err instanceof Error ? err.message : "save failed");
      }
    });
  }
});

// The whole app runs on the WebGPU build of three. Addons (GLTFLoader, SkyMesh,
// PointerLockControls) and camera-controls import the bare "three" specifier;
// alias it to the WebGPU build so there is a single module/class instance and no
// duplicate-three "instanceof" breakage.
export default defineConfig({
  plugins: [relayPlugin(), softHmrPlugin(), nativeFoliageBasisPlugin(), inGameShotPlugin()],
  define: {
    "import.meta.env.SF_FULL_RELOAD": FULL_RELOAD_ENABLED
  },
  resolve: {
    alias: [{ find: /^three$/, replacement: "three/webgpu" }],
    dedupe: ["three", "three/webgpu", "three/tsl"]
  },
  optimizeDeps: {
    exclude: ["box3d-wasm"],
    include: ["camera-controls", "three/webgpu", "three/tsl", "lil-gui", "tweakpane"]
  },
  worker: {
    format: "es"
  },
  server: {
    port: 5179,
    hmr: HMR_ENABLED,
    // pre-transform the module graph on boot instead of paying it on first page load
    warmup: {
      clientFiles: ["./src/**/*.ts"]
    },
    // Playwright profiles, probes, and agent scratch under .data must not trigger HMR
    watch: {
      ignored: ["**/.data/**", "**/node_modules/**", "**/.git/**"]
    },
    // same-origin app services in every environment: dev proxies to the local
    // relay, prod serves everything from the same Node process as the static files
    proxy: {
      "/ws": { target: RELAY_WS, ws: true },
      "/api/weather": { target: `http://localhost:${RELAY_PORT}` }
    },
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../box3d-wasm/packages/box3d-wasm", import.meta.url))
      ]
    }
  }
});
