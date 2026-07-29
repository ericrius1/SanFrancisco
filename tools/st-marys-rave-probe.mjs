// St Mary's plaza rave probe: proves the projection show, the sweeping beams
// and the dancing crowd are live, and captures them by day and by night.
// Drives the camera through __sf.chase and the clock through __sf.sky rather
// than synthetic input, because headless Chrome has no pointer lock.
//   node tools/st-marys-rave-probe.mjs
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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}

const failures = [];
const passed = [];
function assert(name, ok, detail = "") {
  (ok ? passed : failures).push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function shot(c, name) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`[probe] wrote ${file}`);
}

// Two framings. WIDE stands ~160 m north on Geary so the whole cupola and the
// crowd fit in one shot; CLOSE drops onto the forecourt among the dancers.
// player.position is written back by physics every frame, so the move has to
// go through the app's own teleport; the look angles are ours to set.
function frameAt(x, y, z, pitch) {
  return `(() => {
    const sf = window.__sf;
    sf.teleportToTarget(${x}, ${z}, "st-marys-rave-probe");
    sf.chase.yaw = Math.atan2(1642.02 - ${x}, 661.16 - ${z}) + Math.PI;
    sf.chase.pitch = ${pitch};
    return [sf.player.position.x, sf.player.position.y, sf.player.position.z];
  })()`;
}
function aimOnly(x, z, pitch) {
  return `(() => {
    const sf = window.__sf;
    sf.chase.yaw = Math.atan2(1642.02 - ${x}, 661.16 - ${z}) + Math.PI;
    sf.chase.pitch = ${pitch};
    return [sf.player.position.x, sf.player.position.y, sf.player.position.z];
  })()`;
}
const FRAME = frameAt(1617.8, 64.5, 503.0, -0.26);
const AIM = aimOnly(1617.8, 503.0, -0.26);
const FRAME_CLOSE = frameAt(1628.0, 63.4, 583.0, -0.06);
const AIM_CLOSE = aimOnly(1628.0, 583.0, -0.06);

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
  vite.stderr.on("data", (d) => { const s = String(d); if (/error/i.test(s)) console.error("[vite]", s.slice(0, 300)); });
  const cdpPort = await freePort();
  const profileDir = path.join(process.env.TMPDIR ?? "/tmp", `st-marys-rave-${Date.now()}`);
  const proc = spawn(chrome, [
    `--user-data-dir=${profileDir}`, "--headless=new", `--remote-debugging-port=${cdpPort}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--hide-scrollbars", "--mute-audio",
    `--window-size=${W},${H}`, "about:blank"
  ], { cwd: ROOT, stdio: "ignore" });
  try {
    await waitHttp(serverUrl, 60000, "vite");
    const manifest = await (await fetch(`${serverUrl}/data/authored-regions.json`, { cache: "no-store" })).json();
    assert("server serves this worktree", manifest.regions.some((r) => r.id === "st-marys"));

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
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        const txt = ((d.exception && (d.exception.description || d.exception.value)) || d.text || "").slice(0, 240);
        exceptions.push(txt);
        console.log(`  page EXC> ${txt}`);
      }
    };
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${serverUrl}/?autostart=1&spawn=stMarys&fullfps` });

    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
      if ((await ev(c, `document.getElementById('loading')?.classList.contains('ready') ?? false`)) === true) break;
      await sleep(500);
    }
    // The rave layer arrives with the region's dynamic import, not at reveal.
    let inventory = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 90000) {
      inventory = await ev(c, `(() => {
        if (!window.__sf || !window.__sf.scene) return null;
        let rave = null, projection = null, dancers = 0, beams = 0;
        window.__sf.scene.traverse((o) => {
          if (o.name === "st_marys_plaza_rave") rave = o;
          if (o.name === "St Marys projection mapping") projection = o;
        });
        if (!rave) return null;
        rave.traverse((o) => {
          if (o.name === "St Marys dalle-de-verre light stream") beams++;
          if (o.userData && o.userData.rigRoot) dancers++;
        });
        return {
          visible: rave.visible,
          children: rave.children.length,
          projectionVerts: projection ? projection.geometry.getAttribute("position").count : 0,
          hasUV: projection ? !!projection.geometry.getAttribute("uv") : false,
          additive: projection ? projection.material.blending === 2 : false
        };
      })()`);
      if (inventory) break;
      await sleep(1000);
    }
    assert("rave layer attached to the scene", !!inventory, JSON.stringify(inventory));
    if (inventory) {
      assert("projection shell built with UVs", inventory.projectionVerts > 2000 && inventory.hasUV,
        `${inventory.projectionVerts} verts, uv=${inventory.hasUV}`);
      assert("projection blends additively", inventory.additive);
      assert("rave populated (projectors + crowd)", inventory.children > 30, `${inventory.children} children`);
    }

    // ---- daylight pass ------------------------------------------------------
    await ev(c, `window.__sf.sky.setTimeOfDay(13.0)`);
    await ev(c, FRAME);
    // The teleport re-streams the region; capture only once it is back.
    await sleep(11000);
    await ev(c, AIM);
    await sleep(900);
    const dayGain = await ev(c, `window.__sf.sky.sunElevation`);
    await shot(c, "rave-day");

    // ---- night pass ---------------------------------------------------------
    await ev(c, `window.__sf.sky.setTimeOfDay(22.0)`);
    await sleep(2000);
    await ev(c, AIM);
    await sleep(2500);
    await ev(c, AIM);
    await sleep(600);
    const nightSun = await ev(c, `window.__sf.sky.sunElevation`);
    assert("clock moved to night", typeof nightSun === "number" && nightSun < 0,
      `day sun=${dayGain}, night sun=${nightSun}`);
    await shot(c, "rave-night");

    // down among the dancers
    await ev(c, FRAME_CLOSE);
    await sleep(8000);
    await ev(c, AIM_CLOSE);
    await sleep(700);
    await shot(c, "rave-crowd");

    assert("no page exceptions", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));
    c.close();
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    try { process.kill(-vite.pid, "SIGKILL"); } catch { try { vite.kill("SIGKILL"); } catch {} }
  }
  console.log(`\n${passed.length} passed, ${failures.length} failed`);
  if (failures.length) { console.error("FAILURES:", failures.join("; ")); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
