import { createServer } from "node:net";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

// Soft HMR is the default: in-place module swaps work, full page reloads are
// suppressed so multi-agent edits do not interrupt a play session.
//   SF_FULL_RELOAD=1 — restore Vite automatic full reloads
//   SF_HMR=0         — disable the HMR websocket entirely (no soft swaps)
const HMR_ENABLED = process.env.SF_HMR !== "0";
const FULL_RELOAD_ENABLED = process.env.SF_FULL_RELOAD === "1";

const RELAY_PORT = process.env.SF_RELAY_PORT || "8787";
const RELAY_WS = `ws://localhost:${RELAY_PORT}`;

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

/** Drop Vite full-reload WS payloads unless SF_FULL_RELOAD=1. Soft updates pass through. */
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
  }
});

// The whole app runs on the WebGPU build of three. Addons (GLTFLoader, SkyMesh,
// PointerLockControls) and camera-controls import the bare "three" specifier;
// alias it to the WebGPU build so there is a single module/class instance and no
// duplicate-three "instanceof" breakage.
export default defineConfig({
  plugins: [relayPlugin(), softHmrPlugin()],
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
