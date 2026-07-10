// Dynamic-resolution governor acceptance probe (real boot, real rAF, WebGPU).
//
// Proves:
//   1. __sf.dynRes exists, the refresh cadence auto-detects, and the pixel
//      ratio starts at the boot ceiling min(devicePixelRatio, pixelRatioCap).
//   2. A down-step actually shrinks the drawing-buffer width (setPixelRatio +
//      setSize path), and the ladder walks 1.5 → 1.35 → 1.2 → 1.1 → 1.0,
//      holding at the floor.
//   3. An up-step raises it back a rung, and the frame is not visually broken
//      after a step (screenshot).
//
// The ceiling is min(devicePixelRatio, RENDER_MODE.pixelRatioCap): a dpr-1
// headless display collapses the ladder to one rung by design, so the probe
// emulates a retina display (dpr=2) to give the 1.5 cap real headroom. The
// governor is driven deterministically with synthetic frame deltas via the
// __sf.dynRes._test hooks (real load is not reproducible headless).
//
//   node tools/dynres-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1280, H = 800;
const OUT = "/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco--claude-worktrees-game-perf-polish-79a383/f7f3ba3e-64fa-48b4-8435-66aa9bd0340c/scratchpad";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() {
  for (const c of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"]) if (await isFile(c)) return c;
  throw new Error("no chrome");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp {
  #ws; #id = 1; #p = new Map(); errors = [];
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.method === "Runtime.exceptionThrown") { this.errors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "err"); return; }
      if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => { const to = setTimeout(() => { this.#p.delete(id); rej(new Error("timeout " + method)); }, 30000); this.#p.set(id, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } }); }); }
  close() { this.#ws.close(); }
}
async function evaluate(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; }
async function waitEval(c, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, expr)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + expr); }

let pass = 0, fail = 0;
const check = (ok, label) => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); };

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: "8797" }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(URL, 60000);
    // Emulate a retina (dpr=2) display: the boot ceiling is min(devicePixelRatio,
    // pixelRatioCap), so a dpr-1 headless display has no headroom above 1.0 by
    // design. dpr=2 lets the 1.5 cap take effect so the ladder can move.
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-dynres-" + Date.now())}`,
      "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal",
      "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures",
      `--window-size=${W},${H}`, "--force-device-scale-factor=2", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl);
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    await c.send("Page.navigate", { url: `${URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.dynRes && window.__sf.renderer)", 120000);
    await sleep(2500); // let the first frames stream + cadence lock
    console.log("[dynres] booted");

    // 1) exists + starts at the ceiling (dpr 2, cap 1.5 → ceiling 1.5 → bufW 1920)
    const s0 = await evaluate(c, `(()=>{const d=window.__sf.dynRes; const st=d.state();
      return {dpr:window.devicePixelRatio, ratio:d.ratio, ema:+d.ema.toFixed(2), budget:+d.budget.toFixed(2),
              cap:st.cap, min:st.min, cadenceLocked:st.cadenceLocked, bufW:window.__sf.renderer.domElement.width};})()`);
    console.log(`[dynres] boot state: ${JSON.stringify(s0)}`);
    check(typeof s0.ratio === "number", `__sf.dynRes exposed (ratio=${s0.ratio}, ema=${s0.ema}, budget=${s0.budget}ms)`);
    check(Math.abs(s0.cap - 1.5) < 1e-3, `ceiling = min(dpr ${s0.dpr}, pixelRatioCap 1.5) = ${s0.cap}`);
    check(Math.abs(s0.ratio - s0.cap) < 1e-3, `ratio starts at the boot ceiling (ratio=${s0.ratio} == cap=${s0.cap})`);
    check(s0.bufW === Math.round(W * 1.5), `drawing-buffer at ${s0.bufW}px for ratio 1.5 (expected ${Math.round(W * 1.5)})`);
    check(s0.cadenceLocked === true, `refresh cadence auto-detected at boot (budget=${s0.budget}ms)`);

    // arm the governor for deterministic driving: skip the 5 s streaming warmup
    // and pin a tiny budget so synthetic 50 ms frames read as sustained pressure.
    await evaluate(c, `window.__sf.dynRes._test.skipWarmup(); window.__sf.dynRes._test.setBudget(8);`);

    // 2) walk the ladder DOWN, one rung per pressured burst (≥2 s cooldown between).
    const expected = [1.5, 1.35, 1.2, 1.1, 1.0];
    const widths = [s0.bufW];
    let prev = 1.5;
    for (let step = 0; step < expected.length - 1; step++) {
      await sleep(2300); // respect the governor's ≥2 s step cooldown (+margin)
      const r = await evaluate(c, `(()=>{const d=window.__sf.dynRes; d._test.pump(50,60);
        return {ratio:d.ratio, bufW:window.__sf.renderer.domElement.width};})()`);
      const want = expected[step + 1];
      console.log(`[dynres] down-step ${step + 1}: ratio ${prev} → ${r.ratio}   bufW=${r.bufW}px`);
      check(Math.abs(r.ratio - want) < 1e-3, `down-step ${step + 1}: ratio ${prev} → ${r.ratio} (expected ${want})`);
      check(r.bufW < widths[widths.length - 1], `down-step ${step + 1}: drawing-buffer shrank ${widths[widths.length - 1]}px → ${r.bufW}px`);
      widths.push(r.bufW);
      prev = r.ratio;
    }
    check(Math.abs(prev - 1.0) < 1e-3, `reached the floor (minPixelRatio ${prev})`);
    // pumping again at the floor must not go below it
    await sleep(2300);
    const floorHold = await evaluate(c, `(()=>{const d=window.__sf.dynRes; d._test.pump(50,60);
      return {ratio:d.ratio, bufW:window.__sf.renderer.domElement.width};})()`);
    check(Math.abs(floorHold.ratio - 1.0) < 1e-3, `governor holds at the floor, never below (ratio=${floorHold.ratio})`);
    console.log(`[dynres] buffer-width ladder: ${widths.join(" → ")} → ${floorHold.bufW}`);

    // screenshot at the floor — the scene must still render cleanly after stepping
    await sleep(400);
    const shotFloor = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    writeFileSync(path.join(OUT, "dynres_floor.jpg"), Buffer.from(shotFloor.data, "base64"));

    // 3) UP-step: relaxed frames (well under budget) for 240+ frames raise a rung.
    await evaluate(c, `window.__sf.dynRes._test.setBudget(16.67);`);
    await sleep(2300);
    const rise = await evaluate(c, `(()=>{const d=window.__sf.dynRes; d._test.pump(4,260);
      return {ratio:d.ratio, bufW:window.__sf.renderer.domElement.width};})()`);
    console.log(`[dynres] up-step: ratio 1.0 → ${rise.ratio}   bufW=${rise.bufW}px`);
    check(rise.ratio > 1.0 + 1e-3, `up-step raised the ratio back a rung under low load (1.0 → ${rise.ratio})`);
    check(rise.bufW > floorHold.bufW, `up-step widened the drawing-buffer ${floorHold.bufW}px → ${rise.bufW}px`);

    // 4) syncToCap (the "." tweaks-reset path) restores the ceiling in one shot
    await sleep(200);
    const reset = await evaluate(c, `(()=>{const d=window.__sf.dynRes; d.syncToCap();
      return {ratio:d.ratio, bufW:window.__sf.renderer.domElement.width};})()`);
    check(Math.abs(reset.ratio - 1.5) < 1e-3 && reset.bufW === Math.round(W * 1.5),
      `syncToCap restored the ceiling (ratio=${reset.ratio}, bufW=${reset.bufW}px)`);

    await sleep(400);
    const shotUp = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    writeFileSync(path.join(OUT, "dynres_after_step.jpg"), Buffer.from(shotUp.data, "base64"));
    console.log("[dynres] saved dynres_floor.jpg + dynres_after_step.jpg");

    const errs = [...new Set(c.errors)].slice(0, 6);
    check(c.errors.length === 0, `no uncaught runtime errors (${c.errors.length})`);
    if (errs.length) console.log("  errors:", JSON.stringify(errs));

    console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"}  (${pass} passed, ${fail} failed)`);
    c.close();
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
