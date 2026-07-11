// Drives tools/firefly-depth-probe.html headless and asserts sprite occlusion
// under reversedDepthBuffer. Launches a private vite (never the shared 5179).
//   node tools/firefly-depth-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

const vitePort = await freePort();
const relayPort = await freePort();
const vite = spawn("npx", ["vite", "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"], {
  cwd: ROOT,
  env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
  stdio: ["ignore", "ignore", "inherit"]
});
const dport = await freePort();
let chrome;
try {
  await waitHttp(`http://127.0.0.1:${vitePort}/tools/firefly-depth-probe.html`, 30000);
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      `--remote-debugging-port=${dport}`,
      `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "ff-probe-"))}`,
      "--headless=new",
      "--no-first-run",
      "--mute-audio",
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      "--window-size=400,400",
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  let ver;
  for (let i = 0; i < 50 && !ver; i++) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  if (!ver) throw new Error("no CDP");
  const page = await (
    await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let id = 1;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {});
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = id++;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/tools/firefly-depth-probe.html` });
  const t = Date.now();
  let result;
  while (Date.now() - t < 30000) {
    result = await ev("window.__probeResult ?? null").catch(() => null);
    if (result) break;
    await sleep(300);
  }
  ws.close();
  if (!result) throw new Error("probe never produced a result");
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} finally {
  chrome?.kill("SIGTERM");
  vite.kill("SIGTERM");
}
