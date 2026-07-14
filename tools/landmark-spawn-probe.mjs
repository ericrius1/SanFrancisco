// Random-landmark spawn-pool verify.
//
// Boots the app headless (WebGPU via ANGLE-metal) against an already-running
// dev server and checks the new arrival policy end to end:
//   1. Fresh boots (localStorage cleared) land at RANDOM pool landmarks (varied).
//   2. A planted localStorage position RESUMES there instead of a random pick.
//   3. Every LANDMARK_POOL coordinate is on non-water ground (findOpenSpawn safe),
//      and no boot trips the [spawn] no-open-ground fallback.
//
//   SF_PROBE_URL=http://localhost:51142 node tools/landmark-spawn-probe.mjs
// Env: SF_PROBE_URL (required — a running vite), CHROME_BIN, SF_PROBE_OUT.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/landmark-spawn");
const URL_BASE = process.env.SF_PROBE_URL ?? "http://localhost:51142";
const W = 1600, H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// Intended (pre-findOpenSpawn) coordinates, mirroring src/world/spawnPoints.ts
// LANDMARK_POOL. missionDolores/oceanBeach resolve dynamically in the app, so
// they carry loose anchors used only for the nearest-name readout.
const POOL = [
  ["goldenGate", -2982, -2798], ["coit", 3366, -1405], ["transamerica", 3680, 120],
  ["salesforce", 4117, 130], ["embarcadero", 4340, -380], ["downtown", 3900, 200],
  ["bayfront", 3000, -2600], ["marinaGreen", -700, -2350], ["palaceReverie", -248, -1410],
  ["presidio", -2275, -640], ["missionDolores", 250, 2560], ["coronaHeights", 398, 2752],
  ["sutroTower", -720, 3846], ["oceanBeach", -6250, 900], ["landsEnd", -5872, 792],
  ["japaneseTeaGarden", -2239, 2196], ["teaGardenDrumBridge", -2280, 2195],
  ["botanicalGarden", -2290, 2470], ["archeryRange", -5547, 2079], ["marinRedwoods", -3150, -5100]
];
const nearest = (x, z) => {
  let best = null, bd = Infinity;
  for (const [k, kx, kz] of POOL) { const d = Math.hypot(x - kx, z - kz); if (d < bd) { bd = d; best = k; } }
  return { key: best, dist: Math.round(bd) };
};

async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
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
  close() { this.#ws.close(); }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result?.value;
}

// Capture [spawn] console lines across the whole run.
const spawnLogs = [];

async function bootAndRead(c, query, storageJs) {
  // Mutate localStorage on the currently-loaded origin, then navigate so the
  // fresh boot reads it. Same origin ⇒ storage persists across the navigation.
  await ev(c, storageJs);
  spawnLogs.length = 0;
  await c.send("Page.navigate", { url: `${URL_BASE}${query}` });
  // Poll for the placed player.
  let pos = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    pos = await ev(c, `(() => { const p = window.__sf && window.__sf.player; return p ? {x: Math.round(p.position.x), y: Math.round(p.position.y), z: Math.round(p.position.z), mode: p.mode} : null; })()`);
    if (pos) break;
  }
  await sleep(400);
  const arrival = spawnLogs.find((l) => l.includes("arrival")) ?? null;
  const fallback = spawnLogs.find((l) => l.includes("no open ground")) ?? null;
  return { pos, arrival, fallback };
}

(async () => {
  // Make sure the dev server is actually up.
  try { if (!(await fetch(URL_BASE, { cache: "no-store" })).ok) throw 0; }
  catch { console.error(`[probe] no server at ${URL_BASE} — start sf-verify first`); process.exit(2); }

  const chrome = await findChrome();
  const port = 9333;
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${URL_BASE}/?startscreen=1`
  ], { cwd: ROOT, stdio: "ignore" });

  await sleep(2500);
  let page;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes("localhost") && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) { console.error("no app page target"); proc.kill("SIGKILL"); process.exit(1); }

  const c = new Cdp(page.webSocketDebuggerUrl);
  c.onEvent = (m) => {
    if (m.method === "Runtime.consoleAPICalled") {
      const txt = (m.params.args || []).map((a) => a.value ?? "").join(" ");
      if (txt.includes("[spawn]")) spawnLogs.push(txt);
    }
  };
  await c.open();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await sleep(500);

  const results = { random: [], resume: null, ground: [], fallbacks: [] };

  // 1) Six fresh boots — expect varied random pool landmarks.
  console.log("\n=== 1. Random landmark on fresh boot (localStorage cleared) ===");
  for (let i = 0; i < 6; i++) {
    const r = await bootAndRead(c, "/?autostart=1", `localStorage.removeItem('sf-player')`);
    const near = r.pos ? nearest(r.pos.x, r.pos.z) : null;
    console.log(`  boot ${i + 1}: ${r.arrival ?? "(no arrival log)"} | pos=${r.pos ? `${r.pos.x},${r.pos.z}` : "?"} | ~${near ? near.key + " (" + near.dist + "m)" : "?"}`);
    if (r.fallback) console.log(`      ⚠ fallback: ${r.fallback}`);
    results.random.push({ ...r, near });
  }

  // 2) Planted position — expect resume, not random.
  console.log("\n=== 2. Resume when a saved position exists ===");
  const planted = { mode: "walk", x: 1512, y: 40, z: -333, heading: 0 };
  {
    const r = await bootAndRead(c, "/?autostart=1", `localStorage.setItem('sf-player', ${JSON.stringify(JSON.stringify(planted))})`);
    const ok = r.pos && Math.abs(r.pos.x - planted.x) < 40 && Math.abs(r.pos.z - planted.z) < 40 && (r.arrival || "").includes("resume");
    console.log(`  planted (${planted.x},${planted.z}) → ${r.arrival ?? "(no log)"} | pos=${r.pos ? `${r.pos.x},${r.pos.z}` : "?"} | ${ok ? "PASS ✓" : "FAIL ✗"}`);
    results.resume = { ...r, ok };
  }

  // 3) Ground-truth: every pool coordinate on non-water land.
  console.log("\n=== 3. Pool ground check (isWater / groundTop) ===");
  await bootAndRead(c, "/?autostart=1", `localStorage.removeItem('sf-player')`); // ensure __sf.map is live
  const ground = await ev(c, `(() => {
    const m = window.__sf && window.__sf.map; if (!m) return null;
    const pool = ${JSON.stringify(POOL)};
    return pool.map(([k, x, z]) => ({ k, water: m.isWater(x, z), g: Math.round(m.groundTop(x, z)) }));
  })()`);
  if (ground) for (const g of ground) {
    const flag = g.water ? "WATER ⚠" : "land";
    console.log(`  ${g.k.padEnd(20)} ground=${String(g.g).padStart(4)}m  ${flag}`);
    if (g.water) results.fallbacks.push(g.k);
  }

  const anyFallback = results.random.some((r) => r.fallback);
  const waterKeys = results.fallbacks;
  const distinct = new Set(results.random.map((r) => r.near?.key).filter(Boolean));
  console.log("\n=== SUMMARY ===");
  console.log(`  random variety: ${distinct.size} distinct landmarks across 6 boots`);
  console.log(`  resume: ${results.resume?.ok ? "PASS" : "FAIL"}`);
  console.log(`  boot fallbacks triggered: ${anyFallback ? "YES ⚠" : "none"}`);
  console.log(`  pool coords in water: ${waterKeys.length ? waterKeys.join(", ") + " ⚠" : "none"}`);

  c.close();
  proc.kill("SIGKILL");
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
