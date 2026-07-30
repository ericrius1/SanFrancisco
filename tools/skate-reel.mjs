// Real-time skate reel: plays a scripted line through the skatepark with the
// ORDINARY chase camera and grabs a frame every few hundred milliseconds, so
// what lands on disk is what a player would actually see.
//
// Deliberately not the deterministic probe. `__sfManual` ticking is right for
// measurements but wrong for screenshots — with the render loop driven by hand
// the compositor hands back the previous frame, and every "different" pose
// comes out looking identical. Letting the page's own rAF run fixes that.
//
//   node tools/skate-reel.mjs [label]
// Env: SF_REEL_OUT (default .data/skate-reel)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINAL_OUT = path.resolve(ROOT, process.env.SF_REEL_OUT ?? ".data/skate-reel");
const TMP = path.join(process.env.TMPDIR ?? "/tmp", "sf-skate-reel");
const OUT = path.join(TMP, "out");
const LABEL = process.argv[2] ?? "reel";
const W = 1280;
const H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}
async function waitHttp(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`timeout ${url}`);
}
class Cdp {
  #ws;
  #id = 1;
  #p = new Map();
  constructor(u) {
    this.#ws = new WebSocket(u);
  }
  async open() {
    await new Promise((res, rej) => {
      this.#ws.addEventListener("open", res, { once: true });
      this.#ws.addEventListener("error", rej, { once: true });
    });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id);
      if (!p) return;
      this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { res, rej, method }));
  }
  close() {
    this.#ws.close();
  }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 700)}`);
  return r.result?.value;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const vitePort = await freePort();
  const relay = await freePort();
  const url = `http://127.0.0.1:${vitePort}`;
  const dev = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"] }
  );
  await waitHttp(url, 120000);
  const marker = await (await fetch(`${url}/src/vehicles/skate/controller.ts`)).text();
  if (!marker.includes("SkateController")) throw new Error("server is not serving this worktree");

  const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
  const port = await freePort();
  const proc = spawn(
    chrome,
    [
      `--user-data-dir=${path.join(TMP, "profile", String(Date.now()))}`,
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      "--hide-scrollbars",
      "--mute-audio",
      `--window-size=${W},${H}`,
      `${url}/?autostart&fullfps&spawn=skatePlaza`
    ],
    { cwd: ROOT, stdio: "ignore" }
  );
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
  if (!page) throw new Error("no app page");
  const c = new Cdp(page.webSocketDebuggerUrl);
  await c.open();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 300000) {
    try {
      if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer)`)) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(700);
  }
  if (!ready) throw new Error("app never ready");
  console.log("ready in", ((Date.now() - t0) / 1000).toFixed(0), "s");

  // Real time from here: the page keeps its own rAF, we only send keys.
  await ev(c, `(()=>{ const sf=window.__sf; sf.sky.setTimeOfDay(10.5); sf.hud.setPanelHidden&&sf.hud.setPanelHidden('help',true); return true; })()`);
  await sleep(1500);

  const key = (code, down) =>
    ev(c, `window.dispatchEvent(new KeyboardEvent('${down ? "keydown" : "keyup"}',{code:'${code}',bubbles:true}))`);
  const place = (dx, dz, facing) =>
    ev(c, `(()=>{ const sf=window.__sf, m=sf.map;
      const X=${dx}, Z=${dz};
      sf.player.teleportTo({x:X, y:m.effectiveGround(X,Z)+0.6, z:Z, facing:${facing}, mode:'skate'});
      return true; })()`);

  let frame = 0;
  const shots = [];
  const grab = async (tag) => {
    const s = await c.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, `${String(frame++).padStart(2, "0")}-${tag}-${LABEL}.png`);
    writeFileSync(file, Buffer.from(s.data, "base64"));
    shots.push(file);
    return file;
  };
  const roll = async (ms, tag, every = 400) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(every);
      await grab(tag);
    }
  };

  const centre = await ev(
    c,
    `(async()=>{ const m = await import('/src/world/skatePlaza/meta.ts'); return m.SKATE_PLAZA_CENTER; })()`
  );

  // --- 1. push and roll across the park ----------------------------------
  await place(centre.x - 6, centre.z - 26, 0);
  await sleep(1400);
  await key("KeyW", true);
  await roll(2600, "push");

  // --- 2. ollie + kickflip ------------------------------------------------
  await key("Space", true);
  await sleep(340);
  await key("Space", false);
  await sleep(90);
  await key("KeyQ", true);
  await sleep(60);
  await key("KeyQ", false);
  await roll(1400, "kickflip", 220);

  // --- 3. carve ------------------------------------------------------------
  await key("KeyA", true);
  await roll(1200, "carve", 300);
  await key("KeyA", false);

  // --- 4. line at the flat bar --------------------------------------------
  await key("KeyW", false);
  await place(centre.x - 26, centre.z - 12, Math.PI / 2);
  await sleep(1200);
  await key("KeyW", true);
  await sleep(2200);
  await key("Space", true);
  await sleep(120);
  await key("Space", false);
  await roll(2000, "grind", 260);

  // --- 5. drop into the bowl ----------------------------------------------
  await key("KeyW", false);
  await place(centre.x + 15, centre.z - 4, 0);
  await sleep(1200);
  await key("KeyW", true);
  await roll(3000, "bowl", 320);
  await key("KeyW", false);
  await sleep(600);
  await grab("bowl-end");

  // --- 6. the park from above ---------------------------------------------
  const overheadJs =
    "(()=>{ const sf=window.__sf, m=sf.map;" +
    " const X=" + centre.x + ", Z=" + centre.z + "; const y=m.groundTop(X,Z);" +
    " window.__sfFreeCam([X-6, y+46, Z-52],[X, y, Z+2]); return true; })()";
  await ev(c, overheadJs);
  await sleep(1600);
  await grab("park-overhead");
  await ev(c, "window.__sfFreeCam(null)");

  // --- 7. street spots: long rails that appear wherever you skate ----------
  // A Castro-grade block, so both a level rail and a plunging one can appear.
  await place(3376, -976, 0.6);
  await sleep(1500);
  await key("KeyW", true);
  await roll(3500, "street", 500);
  await key("KeyW", false);
  await sleep(600);
  const spots = await ev(
    c,
    "window.__sf.streetSpots ? [window.__sf.streetSpots.spotCount, window.__sf.streetSpots.segmentCount] : -1"
  );
  console.log("street spots / segments:", JSON.stringify(spots));

  // Straight down from high up: the only way to see how a 40–100 m rail lies
  // on a hill without a building getting between us and it.
  const topDown =
    "(()=>{ const sf=window.__sf, p=sf.player.renderPosition;" +
    " window.__sfFreeCam([p.x+1, p.y+150, p.z+1],[p.x, p.y, p.z]); return true; })()";
  await ev(c, topDown);
  await sleep(1800);
  await grab("street-topdown");
  await ev(c, "window.__sfFreeCam(null)");

  // --- 8. grind a generated street rail -----------------------------------
  const aimed = await ev(
    c,
    "(async()=>{ const sf=window.__sf;" +
      " const mod = await import('/src/vehicles/skate/rails.ts');" +
      " const p = sf.player.position;" +
      " const street = mod.allGrindRails().filter(r=>r.id.startsWith('skate-street'));" +
      " if (!street.length) return null;" +
      " let best=null, bd=1e9;" +
      " for (const r of street) { const mx=(r.ax+r.bx)/2, mz=(r.az+r.bz)/2;" +
      "   const d=Math.hypot(mx-p.x, mz-p.z); if (d<bd) { bd=d; best=r; } }" +
      " const dx=best.bx-best.ax, dz=best.bz-best.az, L=Math.hypot(dx,dz);" +
      " const ux=dx/L, uz=dz/L;" +
      " const X=best.ax-ux*15, Z=best.az-uz*15;" +
      " sf.player.teleportTo({x:X, y:sf.map.effectiveGround(X,Z)+0.6, z:Z, facing:Math.atan2(-ux,-uz), mode:'skate'});" +
      " return { id: best.id, ax:best.ax, az:best.az, ux, uz, drop:+(best.ay-best.by).toFixed(2) }; })()"
  );
  console.log("aimed at street rail:", JSON.stringify(aimed));
  if (aimed) {
    await sleep(1400);
    await key("KeyW", true);
    await sleep(2400);
    await key("Space", true);
    await sleep(130);
    await key("Space", false);
    await roll(2600, "street-grind", 300);
    await key("KeyW", false);
    await sleep(400);
    const grinding = await ev(c, "window.__sf.player.skateState.grinding");
    console.log("locked onto a street rail:", grinding);
  }

  console.log(JSON.stringify({ frames: shots.length, out: FINAL_OUT }, null, 1));
  c.close();
  proc.kill();
  dev.kill();
  await sleep(600);
  mkdirSync(FINAL_OUT, { recursive: true });
  cpSync(OUT, FINAL_OUT, { recursive: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
