// Diagnose the single-building fade oscillation at the downtown roof anchor.
// Teleports, settles, freezes player, then watches per-building fade/fadeDir/state
// across many scans to see which building never settles and HOW it oscillates.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp { #ws; #id = 1; #p = new Map(); errs = []; constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function evaluate(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c, dt = 0.016) { try { await evaluate(c, `window.__sf.tick(${dt})`); } catch {} }

async function main() {
  const vitePort = await freePort(); const relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=/tmp/chrome-osc-${Date.now()}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Runtime.enable");
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5); if(!window.__f){window.__f=1;s.chase.update=()=>{};s.player.update=()=>{};} return 1;})()`);
    const gy = await evaluate(c, "window.__sf.map.groundHeight(900,2400)");
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player;const y=${gy}+2;p.position.set(900,y,2400);p.renderPosition.copy(p.position);s.physics.world.setBodyTransform(p.body,[900,y,2400],[0,0,0,1]);return 1;})()`);
    for (let i = 0; i < 120; i++) await tick(c); // long settle
    // watch: which entries have fade in (0.02..0.98) i.e. never settled, over 30 scans
    const series = [];
    for (let s = 0; s < 30; s++) {
      const near = await evaluate(c, "window.__sf.citygenRing.current.debugEntriesNear(900,2400,140)");
      series.push(near);
      await tick(c, 0.016);
    }
    // find entries whose fade was mid-range on ANY scan while hasDetail
    const byI = new Map();
    for (const scan of series) for (const e of scan) {
      if (!byI.has(e.i)) byI.set(e.i, []);
      byI.get(e.i).push(e);
    }
    const suspects = [];
    for (const [i, hist] of byI) {
      const mid = hist.filter(h => h.hasDetail && h.fade > 0.03 && h.fade < 0.97).length;
      const dirFlips = hist.reduce((n, h, k) => n + (k > 0 && h.fadeDir !== hist[k-1].fadeDir ? 1 : 0), 0);
      const detailFlips = hist.reduce((n, h, k) => n + (k > 0 && h.hasDetail !== hist[k-1].hasDetail ? 1 : 0), 0);
      if (mid >= 3 || dirFlips >= 2 || detailFlips >= 1) suspects.push({ i, d: hist[0].d, mid, dirFlips, detailFlips });
    }
    console.log("[osc] suspects (never-settling / oscillating):", JSON.stringify(suspects, null, 0));
    for (const sus of suspects.slice(0, 3)) {
      const hist = byI.get(sus.i);
      console.log(`\n[osc] building i=${sus.i} d=${sus.d}m history (fade|dir|state|pend|detail):`);
      console.log(hist.map(h => `${h.fade}|${h.fadeDir}|${h.state}|${h.pendingBuild?'P':'.'}|${h.hasDetail?'D':'.'}`).join("  "));
    }
    // also report total detail count + how many mid-fade at the last scan
    const last = series[series.length-1];
    console.log("\n[osc] last scan: entries", last.length, "hasDetail", last.filter(e=>e.hasDetail).length, "midFade", last.filter(e=>e.hasDetail&&e.fade>0.03&&e.fade<0.97).length);
    c.close();
  } finally {
    try { chrome?.kill(); } catch {}
    try { process.kill(-dev.pid); } catch {}
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
