// Golf swing repro probe: boots headless, teleports to hole 1 tee, starts a
// round (E), holds + releases the mouse to swing, then watches for NaN camera
// poisoning / uncaught exceptions (the natureSoundscape setTargetAtTime crash).
//   node tools/golf-swing-probe.mjs
// Env: CHROME_BIN, SF_PROBE_URL (reuse a running server)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data/golf-swing-probe");
const W = 1280, H = 800;
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
async function waitHttp(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`server timeout: ${url}`);
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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}

const SNAP = `(() => {
  const s = window.__sf; if (!s) return null;
  const c = s.camera.position, p = s.player.position;
  const fin = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  return {
    cam: [c.x, c.y, c.z].map((n) => Math.round(n * 100) / 100),
    camFinite: fin(c), playerFinite: fin(p),
    mode: s.player.mode,
    golfActive: s.golf ? s.golf.active : null
  };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = await findChrome();
  const external = process.env.SF_PROBE_URL ?? null;
  const vitePort = await freePort();
  const relayPort = await freePort();
  const serverUrl = external ?? `http://127.0.0.1:${vitePort}`;
  const vite = external ? null : spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "pipe"], detached: true
  });
  vite?.stderr.on("data", (d) => { const s = String(d); if (/error/i.test(s)) console.error("[vite]", s.slice(0, 300)); });
  const profileDir = path.join(OUT, "chrome");
  const dbgPort = await freePort();
  let proc;
  try {
    await waitHttp(serverUrl, 60000);
    const golf = await (await fetch(`${serverUrl}/data/golf.json`)).json();
    const h1 = golf.holes.find((h) => h.ref === 1) ?? golf.holes[0];
    console.log(`[probe] hole ${h1.ref} tee at (${h1.teeXZ[0].toFixed(1)}, ${h1.teeXZ[1].toFixed(1)})`);

    proc = spawn(chrome, [
      `--user-data-dir=${profileDir}`, "--headless=new", `--remote-debugging-port=${dbgPort}`,
      "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
      "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, "about:blank"
    ], { cwd: ROOT, stdio: "ignore" });

    let page;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json();
        page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {}
      await sleep(300);
    }
    if (!page) throw new Error("no page target");
    const c = new Cdp(page.webSocketDebuggerUrl);
    const errors = [];
    c.onEvent = (m) => {
      if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) {
        errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400));
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push("EXC " + (((d.exception && (d.exception.description || d.exception.value)) || d.text || "")).slice(0, 400));
      }
    };
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${serverUrl}/?autostart&fullfps` });

    // wait for golf hooks (late-patched after world load)
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await sleep(1000);
      try { if (await ev(c, "!!(window.__sf && window.__sf.golf && window.__sf.player)")) break; } catch {}
    }
    if (!(await ev(c, "!!(window.__sf && window.__sf.golf)"))) throw new Error("golf never loaded");
    console.log("[probe] golf loaded");

    // teleport straight onto the tee, walking (ground height from the live map)
    await ev(c, `(() => {
      const s = window.__sf;
      const y = s.map.effectiveGround(${h1.teeXZ[0]}, ${h1.teeXZ[1]}) + 1.2;
      s.player.teleportTo({ x: ${h1.teeXZ[0]}, y, z: ${h1.teeXZ[1]}, facing: 0, mode: "walk" });
      return y;
    })()`);
    await sleep(1500);
    console.log("[probe] after tp:", JSON.stringify(await ev(c, SNAP)));
    console.log("[probe] dist to tee:", await ev(c, `(() => {
      const p = window.__sf.player.renderPosition;
      return Math.round(Math.hypot(p.x - ${h1.teeXZ[0]}, p.z - ${h1.teeXZ[1]}) * 10) / 10;
    })()`));

    // headless tab has no focus/pointer lock: fake both for the golf swing path
    await ev(c, `(() => { Object.defineProperty(document, "hasFocus", { value: () => true }); window.__sf.input.locked = true; return true; })()`);

    // E starts the round (direct call: headless focus quirks bypass the E-chain)
    const tryStart = await ev(c, `(() => {
      const s = window.__sf;
      const p = s.player.renderPosition;
      return { ret: s.golf.tryStartAtTee(s.player, s.hud), px: p.x, pz: p.z, mode: s.player.mode };
    })()`);
    console.log("[probe] tryStartAtTee:", JSON.stringify(tryStart));
    await sleep(700);
    const started = await ev(c, SNAP);
    console.log("[probe] after E:", JSON.stringify(started));
    if (!started.golfActive) throw new Error("round did not start (not near tee?)");

    // hold fire ~0.5s to charge, then release => swing
    await ev(c, `(() => { window.__sf.input.locked = true; window.__sf.input.fireHeld = true; return true; })()`);
    await sleep(500);
    console.log("[probe] charging:", JSON.stringify(await ev(c, SNAP)));
    await ev(c, `(() => { window.__sf.input.fireHeld = false; return true; })()`);

    // watch the flight, sampling ball mesh (radius 0.055 sphere) vs camera
    await ev(c, `(() => {
      const s = window.__sf;
      window.__ballMesh = null;
      s.scene.traverse((o) => {
        if (!window.__ballMesh && o.isMesh && o.geometry?.parameters?.radius === 0.055) window.__ballMesh = o;
      });
      return !!window.__ballMesh;
    })()`);
    for (let i = 0; i < 25; i++) {
      await sleep(120);
      const s = await ev(c, `(() => {
        const s = window.__sf;
        const c = s.camera.position;
        const b = window.__ballMesh ? window.__ballMesh.position : null;
        const r = (v) => [v.x, v.y, v.z].map((n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : String(n));
        return { cam: r(c), ball: b ? r(b) : null };
      })()`);
      console.log(`[probe] t+${((i + 1) * 0.12).toFixed(2)}s`, JSON.stringify(s));
    }
    console.log(`[probe] errors (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.log("  ", e);
    c.close();
  } finally {
    proc?.kill("SIGKILL");
    if (vite) { try { process.kill(-vite.pid, "SIGKILL"); } catch { vite?.kill("SIGKILL"); } }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
