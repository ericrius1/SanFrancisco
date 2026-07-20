// Zone-only boot probe: boots `?zone=beach-pianist`, asserts the pocket world
// loads only the pianist site (no traffic data, no citygen/forest code, far
// sites untouched), then wakes the city and asserts the full world streams in,
// then regression-checks a default boot (no zone param) still loads everything
// and shows no wake button.
//   node tools/zone-probe.mjs   (SF_PROBE_ROOT overrides the checkout)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(process.env.SF_PROBE_ROOT ?? SELF_ROOT);
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

const SITES = `(globalThis.__sf?.optionalWorldSites ?? []).map(s => ({ id: s.id, state: s.state }))`;
const siteState = async (c, id) => (await ev(c, SITES)).find((s) => s.id === id)?.state ?? "missing";
const FOLIAGE = `(globalThis.__sf?.siteFoliage?.debugSnapshot() ?? []).map(e => ({ id: e.id, status: e.status }))`;
const foliageIds = async (c) => (await ev(c, FOLIAGE)).map((e) => e.id);
// Dynamic-import entry modules that must never be requested in a pocket boot.
// (Statically-imported source files like world/traffic/*.ts always fetch in a
// dev-server session — only execution is gated — and roads.json is fetched by
// a worker, invisible to page resource timing; those are asserted via __sf.)
const CITY_RES = `performance.getEntriesByType('resource')
  .map(r => { try { return new URL(r.name).pathname; } catch { return ""; } })
  .filter(p => /world\\/citygen\\/index|world\\/citygen\\/stream|gameplay\\/forest\\.|gameplay\\/creatures/i.test(p) && !/\\/meta\\.ts$/.test(p))`;
// Traffic executed = the TrafficLightRig group exists in the scene. (__sf
// getter snapshots go stale between refresh events and worker-script fetches
// land in the worker's own resource timeline, so the live scene ref — a stable
// __sf entry — is the only reliable execution signal.)
const TRAFFIC = `!!globalThis.__sf?.scene?.getObjectByName('TrafficLightRig')`;
const RADIUS = `globalThis.__sf?.CONFIG?.tileLoadRadius ?? -1`;

async function waitFor(c, label, predicate, timeoutMs, pollMs = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return Date.now() - t0;
    await sleep(pollMs);
  }
  let snapshot = "";
  try { snapshot = JSON.stringify(await ev(c, SITES)); } catch { /* page gone */ }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms — sites: ${snapshot}`);
}

const failures = [];
const passed = [];
function assert(name, ok, detail = "") {
  (ok ? passed : failures).push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
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
  const profileDir = path.join(process.env.TMPDIR ?? "/tmp", `zone-probe-${Date.now()}`);
  const proc = spawn(chrome, [
    `--user-data-dir=${profileDir}`, "--headless=new", `--remote-debugging-port=${cdpPort}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--hide-scrollbars", "--mute-audio",
    `--window-size=${W},${H}`, "about:blank"
  ], { cwd: ROOT, stdio: "ignore" });
  try {
    await waitHttp(serverUrl, 60000, "vite");
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
    const exceptions = [];
    c.onEvent = (m) => {
      if (m.method === "Runtime.consoleAPICalled") {
        const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        if (/\[zone\]|\[lazy-site\]|\[site-foliage\]|\[rings\]|\[spawn\]/.test(txt)) console.log(`  page> ${txt.slice(0, 160)}`);
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        const txt = ((d.exception && (d.exception.description || d.exception.value)) || d.text || "").slice(0, 220);
        exceptions.push(txt);
        console.log(`  page EXC> ${txt}`);
      }
    };
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    // The default resource-timing buffer (~250 entries) saturates during boot
    // (hundreds of module + tile requests), silently blinding later negative
    // and positive URL assertions. Raise it before any document runs.
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: "performance.setResourceTimingBufferSize(65536)" });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

    // ---- Phase A: pocket boot at the pianist zone --------------------------
    await c.send("Page.navigate", { url: `${serverUrl}/?zone=beach-pianist&autostart=1&fullfps` });
    await waitFor(c, "zone world reveal", async () =>
      (await ev(c, `document.getElementById('loading')?.classList.contains('ready') ?? false`)) === true,
    120000, 500);
    const revealAt = Date.now();
    console.log("[probe] pocket world revealed");

    const pianistMs = await waitFor(c, "beach-pianist ready", async () =>
      (await siteState(c, "beach-pianist")) === "ready", 90000);
    assert("beach-pianist site ready", true, `${(pianistMs / 1000).toFixed(1)}s after reveal`);

    const states = await ev(c, SITES);
    for (const id of ["goldman", "archery", "pup", "fort-mason-ensemble", "palace", "corona", "lands-end", "wave-organ", "sutro-baths"]) {
      const s = states.find((x) => x.id === id)?.state;
      assert(`${id} dormant in pocket boot`, s === "dormant", `state=${s}`);
    }

    // Give backgrounded P3 construction time to finish before the negative
    // assertions — if traffic/citygen were going to load, they'd load now.
    await sleep(12000);
    const cityReqs = await ev(c, CITY_RES);
    assert("zero city-chunk requests in pocket boot", cityReqs.length === 0, cityReqs.slice(0, 5).join(", ") || "none");
    assert("traffic not constructed in pocket boot", (await ev(c, TRAFFIC)) === false);
    const zoneRadius = await ev(c, RADIUS);
    assert("tile radius clamped to bubble", zoneRadius === 1000, `radius=${zoneRadius}`);

    const folIds = await foliageIds(c);
    assert("pianist grove foliage registered", folIds.includes("beach-pianist-grove"), folIds.join(","));
    assert("corona foliage not registered", !folIds.includes("corona-trees") && !folIds.includes("corona-groundcover"), folIds.join(","));

    assert("wake button present", (await ev(c, `!!document.querySelector('.wake-city-ui')`)) === true);
    assert("no page exceptions in pocket boot", exceptions.length === 0, exceptions[0] ?? "");

    // ---- Phase B: wake the city -------------------------------------------
    console.log("[probe] waking the city via __sf.wakeCity()");
    await waitFor(c, "__sf.wakeCity available", async () =>
      (await ev(c, `typeof globalThis.__sf?.wakeCity === 'function'`)) === true, 60000);
    await ev(c, `globalThis.__sf.wakeCity()`);
    const trafficMs = await waitFor(c, "traffic constructed after wake", async () =>
      (await ev(c, TRAFFIC)) === true, 90000);
    assert("traffic wakes after wake", true, `${(trafficMs / 1000).toFixed(1)}s`);
    const citygenMs = await waitFor(c, "citygen module fetched after wake", async () =>
      (await ev(c, CITY_RES)).some((p) => /world\/citygen\//i.test(p)), 120000);
    assert("citygen streams after wake", true, `${(citygenMs / 1000).toFixed(1)}s`);
    const wokenRadius = await ev(c, RADIUS);
    assert("tile radius restored after wake", wokenRadius > 1000, `radius=${wokenRadius}`);
    await waitFor(c, "wake button removed", async () =>
      (await ev(c, `!document.querySelector('.wake-city-ui')`)) === true, 30000);
    assert("wake button removed after wake", true);
    const folAfter = await foliageIds(c);
    assert("far foliage registered after wake", folAfter.includes("corona-trees"), folAfter.join(","));
    assert("no page exceptions after wake", exceptions.length === 0, exceptions[0] ?? "");
    console.log(`[probe] wake verified ${((Date.now() - revealAt) / 1000).toFixed(0)}s after reveal`);

    // ---- Phase C: default-boot regression (no zone param) ------------------
    console.log("[probe] default boot regression at the same spawn");
    exceptions.length = 0;
    await c.send("Page.navigate", { url: `${serverUrl}/?autostart=1&spawn=beachPianist&fullfps` });
    await waitFor(c, "default world reveal", async () =>
      (await ev(c, `document.getElementById('loading')?.classList.contains('ready') ?? false`)) === true,
    120000, 500);
    assert("no wake button in default boot", (await ev(c, `!document.querySelector('.wake-city-ui')`)) === true);
    const defTrafficMs = await waitFor(c, "traffic in default boot", async () =>
      (await ev(c, TRAFFIC)) === true, 120000);
    assert("traffic loads in default boot", true, `${(defTrafficMs / 1000).toFixed(1)}s`);
    const defCitygenMs = await waitFor(c, "citygen in default boot", async () =>
      (await ev(c, CITY_RES)).some((p) => /world\/citygen\//i.test(p)), 180000);
    assert("citygen loads in default boot", true, `${(defCitygenMs / 1000).toFixed(1)}s`);
    await waitFor(c, "beach-pianist ready in default boot", async () =>
      (await siteState(c, "beach-pianist")) === "ready", 90000);
    assert("beach-pianist ready in default boot", true);
    const defFol = await foliageIds(c);
    assert("all foliage registered in default boot", ["lands-end-cypress", "beach-pianist-grove", "corona-trees", "corona-groundcover"].every((id) => defFol.includes(id)), defFol.join(","));
    assert("no page exceptions in default boot", exceptions.length === 0, exceptions[0] ?? "");

    c.close();
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    try { process.kill(-vite.pid, "SIGKILL"); } catch { try { vite.kill("SIGKILL"); } catch {} }
  }

  console.log(`\n[probe] ${passed.length} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  FAIL ${f}`).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error("[probe] fatal:", e.message); process.exit(1); });
