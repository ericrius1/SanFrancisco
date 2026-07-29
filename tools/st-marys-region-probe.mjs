// St Mary's Cathedral authored-region probe: a clean far boot must never fetch
// the region GLB; a spawn at the cathedral must stream it, keep the page free
// of exceptions, and produce screenshots for visual review.
//   node tools/st-marys-region-probe.mjs   (SF_PROBE_ROOT overrides the checkout)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(process.env.SF_PROBE_ROOT ?? SELF_ROOT);
const OUT = path.join(ROOT, ".data", "st-marys-probe");
const W = 1600, H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`timeout ${label}: ${url}`);
}

class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) { if (this.onEvent) this.onEvent(m); return; }
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { try { this.#ws.close(); } catch {} }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

const failures = [];
const passed = [];
function assert(name, ok, detail = "") {
  (ok ? passed : failures).push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function bootScenario(c, serverUrl, query, label) {
  const requests = [];
  const exceptions = [];
  c.onEvent = (m) => {
    if (m.method === "Network.requestWillBeSent") {
      requests.push(m.params.request.url);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const txt = ((d.exception && (d.exception.description || d.exception.value)) || d.text || "").slice(0, 220);
      exceptions.push(txt);
      console.log(`  page EXC> ${txt}`);
    } else if (m.method === "Runtime.consoleAPICalled") {
      const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (/\[authored-region\]|\[spawn\]|st-marys/.test(txt)) console.log(`  page> ${txt.slice(0, 160)}`);
    }
  };
  await c.send("Page.navigate", { url: `${serverUrl}/?${query}` });
  const t0 = Date.now();
  let revealed = false;
  while (Date.now() - t0 < 150000) {
    revealed = (await ev(c, `document.getElementById('loading')?.classList.contains('ready') ?? false`)) === true;
    if (revealed) break;
    await sleep(500);
  }
  assert(`${label}: world revealed`, revealed);
  return { requests, exceptions };
}

async function shot(c, name) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`[probe] wrote ${file}`);
  return file;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = await findChrome();
  const vitePort = await freePort();
  const relayPort = await freePort();
  const serverUrl = `http://127.0.0.1:${vitePort}`;
  console.log(`[probe] root=${ROOT} server=${serverUrl}`);
  const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "pipe", "pipe"], detached: true
  });
  vite.stdout.on("data", () => {});
  vite.stderr.on("data", (d) => { const s = String(d); if (/error/i.test(s)) console.error("[vite]", s.slice(0, 400)); });
  const cdpPort = await freePort();
  const profileDir = path.join(process.env.TMPDIR ?? "/tmp", `st-marys-probe-${Date.now()}`);
  const proc = spawn(chrome, [
    `--user-data-dir=${profileDir}`, "--headless=new", `--remote-debugging-port=${cdpPort}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--hide-scrollbars", "--mute-audio",
    `--window-size=${W},${H}`, "about:blank"
  ], { cwd: ROOT, stdio: "ignore" });
  try {
    await waitHttp(serverUrl, 60000, "vite");
    // The probe must serve THIS checkout: fetch a file we just changed.
    const manifest = await (await fetch(`${serverUrl}/data/authored-regions.json`, { cache: "no-store" })).json();
    assert("server serves this worktree (st-marys in manifest)",
      manifest.regions.some((r) => r.id === "st-marys"));

    let page;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
        page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {}
      await sleep(300);
    }
    if (!page) throw new Error("no page target");
    const c = new Cdp(page.webSocketDebuggerUrl);
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

    // ---- Scenario 1: clean boot 7.7 km away must not fetch the region -----
    const far = await bootScenario(c, serverUrl, "autostart=1&spawn=sutroBaths&fullfps", "far boot");
    await sleep(12000);
    const farFetched = far.requests.filter((u) => u.includes("/regions/st-marys.glb"));
    assert("far boot: zero st-marys region requests", farFetched.length === 0, farFetched.join(","));

    // ---- Scenario 2: spawn at the cathedral streams it in ------------------
    const near = await bootScenario(c, serverUrl, "autostart=1&spawn=stMarys&fullfps", "cathedral boot");
    const t0 = Date.now();
    let fetched = false;
    while (Date.now() - t0 < 30000) {
      fetched = near.requests.some((u) => u.includes("/regions/st-marys.glb"));
      if (fetched) break;
      await sleep(500);
    }
    assert("cathedral boot: /regions/st-marys.glb streamed", fetched);
    await sleep(14000); // settle: materialize birth fade + compile
    assert("cathedral boot: no page exceptions", near.exceptions.length === 0,
      near.exceptions.slice(0, 2).join(" | "));
    await shot(c, "arrival");
    // back away up the plaza for an exterior view of the cupola
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyS", key: "s", windowsVirtualKeyCode: 83 });
    await sleep(9000);
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyS", key: "s", windowsVirtualKeyCode: 83 });
    await sleep(1200);
    await shot(c, "backed-off");
    // C toggles the wider view camera
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyC", key: "c", windowsVirtualKeyCode: 67 });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyC", key: "c", windowsVirtualKeyCode: 67 });
    await sleep(2500);
    await shot(c, "view-toggle");
    c.close();
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    try { process.kill(-vite.pid, "SIGKILL"); } catch { try { vite.kill("SIGKILL"); } catch {} }
  }
  console.log(`\n${passed.length} passed, ${failures.length} failed`);
  if (failures.length) { console.error("FAILURES:", failures.join("; ")); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
