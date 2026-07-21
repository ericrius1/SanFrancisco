// Arrival-priority probe: the destination exhibit must land right after the
// terrain/ripple reveal instead of queueing behind the whole city fill.
//   1. boot spawn at the Japanese Tea Garden → essential architecture attaches
//      within seconds of reveal (boot priority lane).
//   2. far teleport to the Archery Range → the site reaches "ready" within
//      seconds of the cover lift (arrival priority lane), not ~20 s later.
//   node tools/arrival-priority-probe.mjs   (SF_PROBE_ROOT overrides checkout)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(process.env.SF_PROBE_ROOT ?? SELF_ROOT);
const W = 1600, H = 1000;
// Generous bound for slow cold-shader machines; the old broken ordering sat at
// ~20 s+, the fixed lane lands in low single digits warm.
const EXHIBIT_DEADLINE_MS = Number(process.env.SF_PROBE_EXHIBIT_DEADLINE_MS ?? 15000);
const VEGETATION_DEADLINE_MS = Number(process.env.SF_PROBE_VEGETATION_DEADLINE_MS ?? 30000);
const TREES_DEADLINE_MS = Number(process.env.SF_PROBE_TREES_DEADLINE_MS ?? 60000);
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

const SITES = `(window.__sf?.optionalWorldSites ?? []).map(s => ({ id: s.id, state: s.state, priority: s.priority }))`;
const siteState = async (c, id) =>
  (await ev(c, SITES)).find((s) => s.id === id)?.state ?? "missing";
const TEA_PHASES = `(window.__sf?.lazyRegionTimings?.["tea-garden"]?.events ?? []).map(e => e.phase + "@" + Math.round(e.elapsedMs))`;
const teaHasPhase = async (c, phase) =>
  (await ev(c, TEA_PHASES)).some((p) => p.startsWith(`${phase}@`));
const WILD_PHASES = `(window.__sf?.lazyRegionTimings?.["wildlands"]?.events ?? []).map(e => e.phase + "@" + Math.round(e.elapsedMs))`;
const wildHasPhase = async (c, phase) =>
  (await ev(c, WILD_PHASES)).some((p) => p.startsWith(`${phase}@`));
const ringState = (c) => ev(c, `window.__sf?.rings?.state?.() ?? "?"`);

async function waitFor(c, label, predicate, timeoutMs, pollMs = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return Date.now() - t0;
    await sleep(pollMs);
  }
  let snapshot = "";
  try {
    snapshot = JSON.stringify({ sites: await ev(c, SITES), tea: await ev(c, TEA_PHASES) });
  } catch { /* page gone */ }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms — ${snapshot}`);
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
  const profileDir = path.join(process.env.TMPDIR ?? "/tmp", `arrival-priority-probe-${Date.now()}`);
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
        if (/\[lazy-site\]|\[lazy:tea-garden\]|\[tea-garden\]|\[compile\]/.test(txt)) {
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

    // ---- Scenario 1: boot spawn at the Japanese Tea Garden -----------------
    await c.send("Page.navigate", { url: `${serverUrl}/?autostart=1&spawn=japaneseTeaGarden&fullfps&profile=1` });
    await waitFor(c, "world reveal", async () =>
      (await ev(c, `document.getElementById('loading')?.classList.contains('ready') ?? false`)) === true,
    120000, 500);
    const revealAt = Date.now();
    console.log(`[probe] revealed at tea garden; ring=${await ringState(c)}`);

    const teaMs = await waitFor(c, "tea-garden essential attached", async () =>
      teaHasPhase(c, "essential-attached"), 60000);
    const teaRing = await ringState(c);
    assert("tea garden essential attaches after boot reveal", true,
      `${((Date.now() - revealAt) / 1000).toFixed(1)}s after reveal (ring=${teaRing})`);
    assert(`tea garden essential under ${EXHIBIT_DEADLINE_MS / 1000}s`, teaMs < EXHIBIT_DEADLINE_MS,
      `${(teaMs / 1000).toFixed(1)}s`);
    console.log(`[probe] tea phases: ${JSON.stringify(await ev(c, TEA_PHASES))}`);

    // Destination-bound optional foliage (the garden's own trees) rides the
    // arrival lane too — no settled-gated quiet window.
    const teaTreesMs = await waitFor(c, "tea-garden optional trees compiled", async () =>
      teaHasPhase(c, "optional-tree-compile-end"), 60000);
    assert("tea garden trees follow essential on arrival lane", teaTreesMs < VEGETATION_DEADLINE_MS,
      `${(teaTreesMs / 1000).toFixed(1)}s`);

    // ---- Scenario 2: far teleport to the Archery Range ---------------------
    console.log("[probe] far teleport to Archery Range");
    const tpAt = Date.now();
    await ev(c, `window.__sf.teleportToTarget(-5533, 2079, 'Archery Range')`);
    const archeryMs = await waitFor(c, "archery ready", async () =>
      (await siteState(c, "archery")) === "ready", 60000, 100);
    const archeryRing = await ringState(c);
    assert("archery loads at far-teleport destination", true,
      `${((Date.now() - tpAt) / 1000).toFixed(1)}s after teleport (ring=${archeryRing})`);
    assert(`archery ready under ${EXHIBIT_DEADLINE_MS / 1000}s`, archeryMs < EXHIBIT_DEADLINE_MS,
      `${(archeryMs / 1000).toFixed(1)}s`);
    const archeryPriorityUsed = await ev(c,
      `(window.__sf?.optionalWorldSites ?? []).find(s => s.id === "archery")?.state === "ready"`);
    assert("archery site registry reports ready", archeryPriorityUsed === true);

    // GG Park destination vegetation: lawn under the cover, trees right after
    // the exhibit — both on the arrival lane, not behind the city fill.
    const lawnMs = await waitFor(c, "wildlands groundcover attached", async () =>
      wildHasPhase(c, "groundcover-attached"), 60000);
    assert("destination lawn attaches on arrival lane", lawnMs < VEGETATION_DEADLINE_MS,
      `${((Date.now() - tpAt) / 1000).toFixed(1)}s after teleport`);
    const treesMs = await waitFor(c, "wildlands destination trees ready", async () =>
      wildHasPhase(c, "destination-trees-ready"), 90000);
    assert("destination trees prime after exhibit", treesMs < TREES_DEADLINE_MS,
      `${((Date.now() - tpAt) / 1000).toFixed(1)}s after teleport`);
    console.log(`[probe] wildlands phases: ${JSON.stringify(await ev(c, WILD_PHASES))}`);

    // ---- Scenario 3: background-parked site upgraded by a teleport ---------
    // Walk-near a site so its BACKGROUND load starts and parks in the settle-
    // gated quiet window (movement held), then teleport to that same site: the
    // priority upgrade must interrupt the park, not wait out the city fill.
    console.log("[probe] raw-pose near Wave Organ; holding KeyW");
    await ev(c, `window.__sf.player.teleportTo({ x: 324, y: 6, z: -1582, facing: 0, mode: 'walk' })`);
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });
    await waitFor(c, "wave-organ background-queued", async () => {
      const s = await siteState(c, "wave-organ");
      return s === "queued" || s === "loading" || s === "ready";
    }, 45000, 200);
    const parkedState = await siteState(c, "wave-organ");
    if (parkedState === "ready") {
      console.log("[probe] wave-organ finished before the teleport — upgrade path not exercised");
    } else {
      await sleep(1000);
      console.log(`[probe] wave-organ ${parkedState} (parked); teleporting onto it`);
      const upgradeAt = Date.now();
      await ev(c, `window.__sf.teleportToTarget(324, -2052, 'Wave Organ')`);
      const upgradeMs = await waitFor(c, "wave-organ ready after upgrade", async () =>
        (await siteState(c, "wave-organ")) === "ready", 60000, 100);
      assert(`parked background site upgrades to ready under ${EXHIBIT_DEADLINE_MS / 1000}s`,
        upgradeMs < EXHIBIT_DEADLINE_MS, `${(upgradeMs / 1000).toFixed(1)}s (was parked ${parkedState})`);
    }
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });

    assert("zero page exceptions", exceptions.length === 0,
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
