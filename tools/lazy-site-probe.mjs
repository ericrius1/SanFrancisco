// Lazy-site scheduler probe: boots at Lands End while "walking", asserts the
// destination exhibit takes the arrival priority lane, far sites never load,
// a teleport-away aborts an in-flight site, and a ready site distance-unloads.
//   node tools/lazy-site-probe.mjs   (SF_PROBE_ROOT overrides the checkout)
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

const SITES = `(__sf?.optionalWorldSites ?? []).map(s => ({ id: s.id, state: s.state, priority: s.priority }))`;
const siteState = async (c, id) =>
  (await ev(c, SITES)).find((s) => s.id === id)?.state ?? "missing";

async function waitFor(c, label, predicate, timeoutMs, pollMs = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return Date.now() - t0;
    await sleep(pollMs);
  }
  let snapshot = "";
  try {
    snapshot = JSON.stringify(await ev(c, SITES));
  } catch { /* page gone */ }
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
  const profileDir = path.join(process.env.TMPDIR ?? "/tmp", `lazy-site-probe-${Date.now()}`);
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
    const lazyLog = [];
    const exceptions = [];
    c.onEvent = (m) => {
      if (m.method === "Runtime.consoleAPICalled") {
        const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        if (/\[lazy-site\]|\[authored-region\]|\[spawn\]/.test(txt)) {
          lazyLog.push(txt.slice(0, 160));
          console.log(`  page> ${txt.slice(0, 160)}`);
        }
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        const txt = ((d.exception && (d.exception.description || d.exception.value)) || d.text || "").slice(0, 220);
        exceptions.push(txt);
        console.log(`  page EXC> ${txt}`);
      }
    };
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${serverUrl}/?autostart=1&spawn=landsEnd&fullfps` });

    // ---- Scenario 1: boot at Lands End, walking the whole time -------------
    await waitFor(c, "world reveal", async () =>
      (await ev(c, `document.getElementById('loading')?.classList.contains('ready') ?? false`)) === true,
    120000, 500);
    console.log("[probe] revealed; holding KeyW (walking)");
    const revealAt = Date.now();
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });

    const landsEndMs = await waitFor(c, "lands-end ready", async () =>
      (await siteState(c, "lands-end")) === "ready", 45000);
    assert("lands-end ready while walking", true, `${((Date.now() - revealAt) / 1000).toFixed(1)}s after reveal`);
    assert("lands-end ready under 20s", landsEndMs < 20000, `${(landsEndMs / 1000).toFixed(1)}s`);

    const farStates = await ev(c, SITES);
    for (const id of ["goldman", "archery", "palace", "corona", "wave-organ", "pup", "fort-mason-ensemble"]) {
      const s = farStates.find((x) => x.id === id)?.state;
      assert(`${id} untouched at Lands End boot`, s === "dormant", `state=${s}`);
    }
    // meta.ts files are boot-eligible coordinate registries; everything else
    // under a feature directory must stay unrequested at a Lands End boot.
    const goldmanReqs = await ev(c, `performance.getEntriesByType('resource')
      .map(r => new URL(r.name).pathname)
      .filter(p => /goldenGateTennis|pickleball/i.test(p) && !/\\/meta\\.ts$/.test(p))`);
    assert("zero goldman/pickleball feature requests at boot", goldmanReqs.length === 0, goldmanReqs.join(", ") || "none");
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });

    // ---- Scenario 2: teleport toward Goldman, then away mid-load ----------
    console.log("[probe] teleporting near Goldman Tennis Center");
    await ev(c, `__sf.teleportToTarget(-1350, 2150, 'Goldman Courts')`);
    await waitFor(c, "goldman queued/loading", async () => {
      const s = await siteState(c, "goldman");
      return s === "queued" || s === "loading" || s === "ready";
    }, 30000, 100);
    const midState = await siteState(c, "goldman");
    if (midState === "ready") {
      console.log("[probe] goldman finished before we could interrupt — skipping abort assert");
      await ev(c, `__sf.teleportToTarget(-5920, 760, 'Lands End')`);
    } else {
      console.log(`[probe] goldman ${midState}; teleporting away to Lands End`);
      await ev(c, `__sf.teleportToTarget(-5920, 760, 'Lands End')`);
      await waitFor(c, "goldman back to dormant (aborted)", async () =>
        (await siteState(c, "goldman")) === "dormant", 30000);
      assert("teleport-away aborts in-flight goldman", true);
      await sleep(4000);
      const after = await siteState(c, "goldman");
      assert("goldman stays dormant after abort", after === "dormant", `state=${after}`);
      assert("goldman instance cleared", (await ev(c, `__sf.goldenGateTennis == null`)) === true);
    }
    // Reload-after-unload sanity: lands-end was unloaded while we were away
    // (or is mid-reload) and the return teleport must rebuild it cleanly.
    await waitFor(c, "lands-end ready again after return", async () =>
      (await siteState(c, "lands-end")) === "ready", 90000);
    assert("lands-end reloads cleanly after unload", true);

    // ---- Scenario 3: full load near Goldman, then distance unload ---------
    console.log("[probe] teleporting to Goldman and letting it finish");
    await ev(c, `__sf.teleportToTarget(-1350, 2150, 'Goldman Courts')`);
    const goldmanMs = await waitFor(c, "goldman ready", async () =>
      (await siteState(c, "goldman")) === "ready", 60000);
    assert("goldman loads at destination", true, `${(goldmanMs / 1000).toFixed(1)}s`);
    await waitFor(c, "lands-end unloaded after leaving", async () =>
      (await siteState(c, "lands-end")) === "dormant", 30000);
    assert("lands-end distance-unloads beyond 1km", true);
    assert("lands-end instance disposed", (await ev(c, `__sf.landsEnd == null`)) === true);
    await waitFor(c, "sutro-baths unloaded after leaving", async () =>
      (await siteState(c, "sutro-baths")) === "dormant", 30000);
    assert("sutro-baths distance-unloads beyond 1km", true);
    assert("sutro-baths instance disposed", (await ev(c, `__sf.sutroBaths == null`)) === true);
    console.log("[probe] teleporting 2.3km away (Corona Heights)");
    await ev(c, `__sf.teleportToTarget(408, 2760, 'Corona Heights')`);
    await waitFor(c, "goldman unloaded", async () =>
      (await siteState(c, "goldman")) === "dormant", 30000);
    assert("goldman distance-unloads beyond 1km", true);
    assert("goldman instance disposed", (await ev(c, `__sf.goldenGateTennis == null`)) === true);
    assert("pickleball controller disposed", (await ev(c, `__sf.pickleballController == null`)) === true);
    const coronaMs = await waitFor(c, "corona ready at destination", async () =>
      (await siteState(c, "corona")) === "ready", 60000);
    assert("corona loads at destination", true, `${(coronaMs / 1000).toFixed(1)}s`);

    // ---- Scenario 4: corona teardown (physics colliders) + final return ---
    console.log("[probe] returning to Lands End");
    await ev(c, `__sf.teleportToTarget(-5920, 760, 'Lands End')`);
    await waitFor(c, "corona unloaded", async () =>
      (await siteState(c, "corona")) === "dormant", 30000);
    assert("corona distance-unloads beyond 1km", true);
    assert("corona instance disposed", (await ev(c, `__sf.coronaHeights == null`)) === true);
    await waitFor(c, "lands-end ready on second return", async () =>
      (await siteState(c, "lands-end")) === "ready", 90000);
    assert("lands-end reloads again cleanly", true);

    assert("zero page exceptions across load/abort/unload cycles", exceptions.length === 0,
      exceptions.slice(0, 3).join(" | ") || "none");
    c.close();
  } finally {
    proc.kill("SIGKILL");
    try { process.kill(-vite.pid, "SIGKILL"); } catch { vite.kill("SIGKILL"); }
  }
  console.log(`\n[probe] ${passed.length} passed, ${failures.length} failed`);
  if (failures.length) { console.log("failures:", failures); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
