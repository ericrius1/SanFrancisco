import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

const RELAY_PORT = process.env.SF_RELAY_PORT || "8787";
const RELAY_WS = `ws://localhost:${RELAY_PORT}`;

// Dev multiplayer with zero extra terminals: when the dev server boots, start
// the WebSocket relay (server/server.mjs) in-process on 8787 and proxy /ws to
// it. If a relay is already running on that port (another vite, or a manual
// `npm run server`), the import just logs a warning and we proxy to that one.
const relayPlugin = (): Plugin => ({
  name: "sf-multiplayer-relay",
  async configureServer() {
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

// The whole app runs on the WebGPU build of three. Addons (GLTFLoader, SkyMesh,
// PointerLockControls) and camera-controls import the bare "three" specifier;
// alias it to the WebGPU build so there is a single module/class instance and no
// duplicate-three "instanceof" breakage.
export default defineConfig({
  plugins: [relayPlugin()],
  resolve: {
    alias: [{ find: /^three$/, replacement: "three/webgpu" }],
    dedupe: ["three", "three/webgpu", "three/tsl"]
  },
  optimizeDeps: {
    exclude: ["box3d-wasm"],
    include: ["camera-controls"]
  },
  worker: {
    format: "es"
  },
  server: {
    port: 5179,
    // same-origin app services in every environment: dev proxies to the local
    // relay, prod serves everything from the same Node process as the static files
    proxy: {
      "/ws": { target: RELAY_WS, ws: true }
    },
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../box3d-wasm/packages/box3d-wasm", import.meta.url))
      ]
    }
  }
});
