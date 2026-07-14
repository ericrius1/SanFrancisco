// Headless verification for the thrown-ball impact SFX (ground thud + water
// plonk + fey-realm magic echo). Boots the app in headless Chrome (WebGPU via
// ANGLE-metal), unlocks audio, then:
//   A. calls ballImpactAudio.ground()/water() directly — builds and exercises
//      the whole WebAudio graph incl. the persistent magic-echo feedback line;
//   B. throws a real free ball with throwForCinematic and ticks until it lands,
//      proving stepBall -> fetchBall.onGroundImpact -> ground() end to end.
// Any page exception or console.error during the run fails the probe.
//
//   node tools/ball-impact-audio-probe.mjs
// Always starts its own throwaway Vite on a free port and kills it after, so it
// never serves stale code from (or disturbs) a human's shared dev server.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1280, H = 720;
const DT = 1 / 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
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
  close() { this.#ws.close(); }
}

let ownedDev = null, chromeProc = null, activeCdp = null;
function cleanup() {
  try { activeCdp?.close(); } catch {}
  try { chromeProc?.kill(); } catch {}
  try { ownedDev?.kill(); } catch {}
  activeCdp = null; chromeProc = null; ownedDev = null;
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(DT)); await sleep(60); } }

async function main() {
  const vitePort = await freePort();
  const relay = await freePort();
  const url = `http://127.0.0.1:${vitePort}`;
  console.log(`[probe] starting Vite at ${url}`);
  ownedDev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(url, 60000, "vite");

  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(ROOT, ".data", "ball-impact-audio-probe-chrome");
  chromeProc = spawn(chrome, [
    `--user-data-dir=${profile}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--autoplay-policy=no-user-gesture-required", "--mute-audio",
    `--window-size=${W},${H}`, `${url}/?autostart&fullfps`
  ], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);

  let page;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl);
  activeCdp = c;
  const pageErrors = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      const where = `${d.url || d.scriptId || "?"}:${d.lineNumber}:${d.columnNumber}`;
      pageErrors.push(`exception: ${String(text).slice(0, 300)} @ ${where}`);
      console.log("[page-exception]", String(text).slice(0, 300), "@", where);
      if (d.stackTrace) console.log("[page-exception-stack]", JSON.stringify(d.stackTrace.callFrames?.slice(0, 4)));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const text = m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300);
      pageErrors.push(`console.error: ${text}`);
      console.log("[page-error]", text);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.ballImpactAudio&&window.__sf.fetchBall)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready (see [page-exception]/[page-error] above)");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // let world-arrival + render warmup finish so fetchBall.update runs live
  await settle(c, 80);
  await ev(c, `window.__sf.nature.unlock()`);
  await sleep(300);

  const results = [];
  const push = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} — ${detail}`); };

  // ---- part A: direct graph exercise (warmup-independent) ------------------
  // ground()/water() no-op until the shared voice buffers finish decoding after
  // unlock; the suspended context only resumes once nature.update runs a few
  // frames while our keep-awake bit is set (autoplay resume needs the tick).
  let a = null;
  for (let i = 0; i < 60; i++) {
    a = await ev(c, `(()=>{
      const sf=window.__sf, p=sf.player.renderPosition;
      sf.ballImpactAudio.ground(p.x, p.y, p.z, 6.0);
      sf.ballImpactAudio.water(p.x, p.y, p.z, 6.0);
      return sf.ballImpactAudio.debugState;
    })()`);
    await tick(c, DT); await tick(c, DT);
    if (a && a.groundCount > 0 && a.waterCount > 0 && a.context === "running") break;
    await sleep(80);
  }
  a = await ev(c, `window.__sf.ballImpactAudio.debugState`);
  console.log("[probe] after direct calls:", JSON.stringify(a));
  push("audio-graph-lives",
    !!a && a.groundCount > 0 && a.waterCount > 0 && a.context === "running",
    `ctx ${a?.context}, ground ${a?.groundCount}, water ${a?.waterCount}`);

  const baseGround = a?.groundCount ?? 0;

  // ---- part B: end-to-end thrown ball lands and thuds ---------------------
  // Re-throw every 60 ticks in case the first toss left a clear window before
  // the sim was fully live; a downward arc lands within ~1 s once stepping.
  let landed = null;
  for (let i = 0; i < 240; i++) {
    if (i % 60 === 0) {
      await ev(c, `(()=>{ const sf=window.__sf, T=sf.THREE;
        sf.fetchBall.throwForCinematic(new T.Vector3(2.4, -3.5, 0)); return true; })()`);
    }
    await tick(c, DT);
    landed = await ev(c, `window.__sf.ballImpactAudio.debugState`);
    if (landed.groundCount > baseGround) break;
  }
  console.log("[probe] after throw:", JSON.stringify(landed));
  push("thrown-ball-thuds",
    !!landed && landed.groundCount > baseGround,
    `groundCount ${baseGround} -> ${landed?.groundCount} (thrown ball registered a ground impact)`);

  push("no-console-errors", pageErrors.length === 0,
    pageErrors.length === 0 ? "clean run" : `${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ").slice(0, 400)}`);

  cleanup();
  const failed = results.filter((r) => !r.pass).length;
  if (failed > 0) { console.error(`[probe] FAIL — ${failed} assertion(s)`); process.exit(1); }
  console.log("[probe] PASS — all assertions green");
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[probe] FAIL", e); process.exit(1); });
