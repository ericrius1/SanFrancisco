// Sky-flicker visual repro: boots headless at Ocean Beach, freecams toward the
// ghost-ship horizon proxy, burst-captures frames, and reports transient dark
// blobs in the sky (objects visible in some frames and gone in others).
//
//   node tools/sky-flicker-repro.mjs
// Env: CHROME_BIN, SF_SHOTS (default 70)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/sky-flicker-repro");
const SHOTS = Number(process.env.SF_SHOTS ?? 70);
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
      if (!m.id) return;
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { try { this.#ws.close(); } catch {} }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 900)}`);
  return r.result?.value;
}

async function main() {
  mkdirSync(path.join(OUT, "shots"), { recursive: true });
  const vitePort = await freePort();
  const vite = spawn(path.join(ROOT, "node_modules/.bin/vite"), ["--port", String(vitePort), "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  const viteLog = [];
  vite.stdout.on("data", (d) => viteLog.push(String(d)));
  vite.stderr.on("data", (d) => viteLog.push(String(d)));
  try {
    await waitHttp(`http://localhost:${vitePort}/`, 30000, "vite");
    const dbgPort = await freePort();
    const headed = process.env.SF_HEADED === "1";
    const chrome = spawn(await findChrome(), [
      `--remote-debugging-port=${dbgPort}`,
      ...(headed ? ["--window-position=-3400,60"] : ["--headless=new"]),
      "--use-angle=metal", "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,WebGPU", "--hide-scrollbars", "--mute-audio",
      `--window-size=${W},${H}`, "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${path.join(OUT, "chrome-profile")}`,
      "about:blank"
    ], { stdio: "ignore" });
    try {
      await waitHttp(`http://127.0.0.1:${dbgPort}/json/version`, 15000, "chrome");
      const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      const cdp = new Cdp(page.webSocketDebuggerUrl);
      await cdp.open();
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Runtime.enable");
      await cdp.send("Page.navigate", { url: `http://localhost:${vitePort}/?autostart=1&spawn=oceanBeach&fullfps=1${process.env.SF_QS ?? ""}` });
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        const ready = await ev(cdp, `!!(window.__sf && window.__sf.player && document.body.classList.contains("started"))`).catch(() => false);
        if (ready) break;
        await sleep(1000);
      }
      if (!(await ev(cdp, `!!window.__sf`))) throw new Error("no __sf: " + viteLog.slice(-5).join(""));
      await sleep(4000);

      // Freecam: eye above the beach, looking at the ghost ship proxy.
      const aim = await ev(cdp, `(() => {
        const sf = window.__sf;
        const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
        let p = proxy ? proxy.position : { x: -4170, y: 460, z: -2450 };
        if ("${process.env.SF_AIM ?? ""}" === "fixed") p = { x: -4100, y: 455, z: -2500 };
        const eye = [sf.player.position.x, sf.player.position.y + 8, sf.player.position.z];
        window.__sfFreeCam(eye, [p.x, p.y, p.z]);
        const hour = Number("${process.env.SF_HOUR ?? ""}");
        if (Number.isFinite(hour)) sf.sky.setTimeOfDay(hour);
        document.body.classList.add("hide-hud");
        const hud = document.getElementById("hud"); if (hud) hud.style.display = "none";
        return { proxy: !!proxy, target: [p.x, p.y, p.z], eye };
      })()`);
      console.log("[repro] aim:", JSON.stringify(aim));
      if (process.env.SF_HIDE) {
        // Hide every scene object whose name matches the prefix list (comma
        // separated), now and on any future attach.
        console.log("[repro] hide:", await ev(cdp, `(() => {
          const prefixes = ${JSON.stringify((process.env.SF_HIDE || "").split(","))};
          const sf = window.__sf; let n = 0;
          const match = (o) => o.name && prefixes.some((p) => o.name.startsWith(p));
          sf.scene.traverse((o) => { if (match(o)) { o.visible = false; n++; } });
          const origAdd = sf.THREE.Object3D.prototype.add;
          sf.THREE.Object3D.prototype.add = function (...objs) {
            for (const o of objs) if (o && match(o)) o.visible = false;
            return origAdd.apply(this, objs);
          };
          return n + " hidden";
        })()`));
      }
      if (process.env.SF_PATCH === "realwalk") {
        // REAL walking via the scripted InputDriver (full player.update, trample,
        // chase camera) while the pixel spy watches the sky band.
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const canvas = document.querySelector("canvas");
          const off = document.createElement("canvas");
          off.width = 220; off.height = 138;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          window.__walkSpy = { events: [], frame: 0, err: null };
          const spy = window.__walkSpy;
          sf.input.setDriver({
            update(dt, controls) {
              spy.frame++;
              if (spy.frame === 1 && sf.chase) sf.chase.yaw = Number("${process.env.SF_YAW ?? "3.14"}");
              controls.hold("KeyW");
              // slow weave so the camera sweeps sky+grass; occasional look up
              controls.look(Math.sin(spy.frame * 0.004) * 3.0, Math.sin(spy.frame * 0.0113) * 1.4);
              try {
                ctx.drawImage(canvas, 0, 0, 220, 138);
                const img = ctx.getImageData(0, 4, 220, 44).data;
                let hits = 0, cx = 0, cy = 0;
                for (let p = 0; p < img.length; p += 4) {
                  const r = img[p], g = img[p + 1], b = img[p + 2];
                  const bright = (r + g + b) / 3;
                  const greenish = g > b + 12 && g > 60;
                  const cream = bright > 228 && b < 246;
                  const darkblob = bright < 100;
                  if (greenish || cream || darkblob) { hits++; cx += (p / 4) % 220; cy += Math.floor(p / 4 / 220); }
                }
                if (hits >= 3 && hits < 2500) {
                  spy.events.push({ frame: spy.frame, hits, px: Math.round(cx / hits * (1600 / 220)), py: Math.round((cy / hits + 4) * (1000 / 138)) });
                  if (spy.events.length > 80) spy.events.shift();
                }
              } catch (err) { spy.err = String(err); }
            }
          });
          return "real-walk driver installed";
        })()`));
        await sleep(Number(process.env.SF_SPY_SECONDS ?? 90) * 1000);
        const out = await ev(cdp, `(() => { const sf = window.__sf; return { frames: window.__walkSpy.frame, err: window.__walkSpy.err, eventCount: window.__walkSpy.events.length, events: window.__walkSpy.events.slice(-20), pos: sf.player.position.toArray().map(Math.round) }; })()`);
        writeFileSync(path.join(OUT, "realwalk.json"), JSON.stringify(out, null, 1));
        console.log("[repro] realwalk:", JSON.stringify(out).slice(0, 700));
      }
      if (process.env.SF_PATCH === "grasswalk") {
        // Drive the player along the beach through wildlands grass while a
        // pixel spy watches the sky band for grass-colored/bright spikes
        // (stretched or misplaced blade instances). Camera trails the player.
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const canvas = document.querySelector("canvas");
          const off = document.createElement("canvas");
          off.width = 220; off.height = 138;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          window.__walkSpy = { events: [], frame: 0, err: null, moved: 0 };
          const spy = window.__walkSpy;
          const base = { x: sf.player.position.x, z: sf.player.position.z };
          const speed = Number("${process.env.SF_WALK_SPEED ?? "0.12"}");
          const freeze = "${process.env.SF_FREEZE_GRASS ?? ""}" === "1";
          if (freeze && sf.wildlands && sf.wildlands.grass && sf.wildlands.grass.update) {
            sf.wildlands.grass.update = () => {};
          }
          const scan = () => {
            spy.frame++;
            // stroll north along the dune line, gentle weave
            const t = spy.frame;
            sf.player.position.x = base.x + Math.sin(t * 0.005) * 25;
            sf.player.position.z = base.z - t * speed;
            spy.moved = Math.round(t * speed);
            window.__sfFreeCam(
              [sf.player.position.x + 3, sf.player.position.y + 2.2, sf.player.position.z + 26],
              [sf.player.position.x, sf.player.position.y + 14, sf.player.position.z - 60]
            );
            try {
              ctx.drawImage(canvas, 0, 0, 220, 138);
              // sky band: rows 4..52 of 138 (~upper 40%)
              const img = ctx.getImageData(0, 4, 220, 48).data;
              let hits = 0, cx = 0, cy = 0;
              for (let p = 0; p < img.length; p += 4) {
                const r = img[p], g = img[p + 1], b = img[p + 2];
                const bright = (r + g + b) / 3;
                const greenish = g > b + 12 && g > 60;
                const cream = bright > 225 && b < 245;
                const darkblob = bright < 105;
                if (greenish || cream || darkblob) { hits++; cx += (p / 4) % 220; cy += Math.floor(p / 4 / 220); }
              }
              if (hits >= 3 && hits < 2500) {
                spy.events.push({ frame: spy.frame, hits, px: Math.round(cx / hits * (1600 / 220)), py: Math.round((cy / hits + 4) * (1000 / 138)) });
                if (spy.events.length > 60) spy.events.shift();
              }
            } catch (err) { spy.err = String(err); }
            requestAnimationFrame(scan);
          };
          requestAnimationFrame(scan);
          return "walk spy on" + (freeze ? " (grass streaming frozen)" : "");
        })()`));
        await sleep(Number(process.env.SF_SPY_SECONDS ?? 60) * 1000);
        const out = await ev(cdp, `window.__walkSpy && { frames: window.__walkSpy.frame, movedMeters: window.__walkSpy.moved, err: window.__walkSpy.err, eventCount: window.__walkSpy.events.length, events: window.__walkSpy.events.slice(-15) }`);
        writeFileSync(path.join(OUT, "grasswalk.json"), JSON.stringify(out, null, 1));
        console.log("[repro] grasswalk:", JSON.stringify(out).slice(0, 600));
      }
      if (process.env.SF_PATCH === "echochurn") {
        // Waterline churn: oscillate the (freecam-frozen) player across the
        // shoreline so water-echo eligibility flaps, while an in-page pixel
        // scanner watches the sky for one-frame dark flashes.
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const v = new sf.THREE.Vector3();
          const canvas = document.querySelector("canvas");
          const off = document.createElement("canvas");
          off.width = 200; off.height = 125;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          window.__churnSpy = { events: [], frame: 0, echoTransitions: 0, activeFrames: 0, err: null };
          const spy = window.__churnSpy;
          const baseX = sf.player.position.x;
          const baseZ = sf.player.position.z;
          // find the waterline west of the player once
          let shore = null;
          for (let dx = 0; dx > -260; dx -= 2) {
            if (sf.map.isWater(baseX + dx, baseZ)) { shore = baseX + dx; break; }
          }
          if (shore === null) return "no water found west";
          // camera hovers just past the waterline looking further out to sea, so
          // the mirror footprint between camera and player is always on water.
          window.__sfFreeCam([shore - 10, 8, baseZ], [shore - 200, 0, baseZ]);
          const origEmit = sf.water.echoes.emit.bind(sf.water.echoes);
          spy.emits = 0;
          sf.water.echoes.emit = (s) => { spy.emits++; return origEmit(s); };
          let lastVisible = false;
          const scan = () => {
            spy.frame++;
            // every 12 frames hop across the waterline: wet <-> dry
            const wet = Math.floor(spy.frame / 12) % 2 === 0;
            sf.player.position.x = wet ? shore - 60 : shore + 40;
            sf.player.position.z = baseZ;
            if (wet && !spy.guardSample && spy.frame > 30) {
              const cam = sf.camera.position;
              const sx = sf.player.position.x, sy = sf.player.position.y, sz = sf.player.position.z;
              const srcWater = sf.map.isWater(sx, sz);
              const altitude = sy; // waterHeight ~ swell around 0
              const camAlt = cam.y;
              const mirrorT = camAlt / Math.max(0.1, camAlt + altitude);
              const cx = cam.x + (sx - cam.x) * mirrorT;
              const cz = cam.z + (sz - cam.z) * mirrorT;
              const fwd = new sf.THREE.Vector3();
              sf.camera.getWorldDirection(fwd);
              const toEcho = new sf.THREE.Vector3(cx - cam.x, -cam.y, cz - cam.z);
              spy.guardSample = {
                playerY: +sy.toFixed(2), camY: +cam.y.toFixed(2), camX: Math.round(cam.x),
                srcWater, mirrorWater: sf.map.isWater(cx, cz), cx: Math.round(cx),
                dot: +toEcho.dot(fwd).toFixed(2), dist: Math.round(toEcho.length())
              };
            }
            const nowVisible = sf.water.echoes.shadows.visible || sf.water.echoes.lights.visible;
            if (nowVisible !== lastVisible) spy.echoTransitions++;
            if (nowVisible) spy.activeFrames++;
            lastVisible = nowVisible;
            try {
              ctx.drawImage(canvas, 0, 0, 200, 125);
              const img = ctx.getImageData(0, 6, 200, 52).data;
              let dark = 0, cx = 0, cy = 0;
              for (let p = 0; p < img.length; p += 4) {
                const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
                if (lum < 105) { dark++; cx += (p / 4) % 200; cy += Math.floor(p / 4 / 200); }
              }
              if (dark >= 2 && dark < 900) {
                spy.events.push({ frame: spy.frame, dark, px: Math.round(cx / dark * 8), py: Math.round((cy / dark + 6) * 8) });
                if (spy.events.length > 40) spy.events.shift();
              }
            } catch (err) { spy.err = String(err); }
            requestAnimationFrame(scan);
          };
          requestAnimationFrame(scan);
          return "churn spy on, shore at x=" + Math.round(shore) + " (player base x=" + Math.round(baseX) + ")";
        })()`));
        await sleep(Number(process.env.SF_SPY_SECONDS ?? 90) * 1000);
        const out = await ev(cdp, `window.__churnSpy && { frames: window.__churnSpy.frame, transitions: window.__churnSpy.echoTransitions, activeFrames: window.__churnSpy.activeFrames, emits: window.__churnSpy.emits, guard: window.__churnSpy.guardSample, err: window.__churnSpy.err, events: window.__churnSpy.events }`);
        writeFileSync(path.join(OUT, "echochurn.json"), JSON.stringify(out, null, 1));
        console.log("[repro] echochurn:", JSON.stringify(out).slice(0, 800));
      }
      if (process.env.SF_PATCH === "framespy") {
        if (process.env.SF_UNMITIGATE === "1") {
          console.log("[repro] unmitigate:", await ev(cdp, `(() => {
            const sf = window.__sf;
            let n = 0;
            const force = (o) => { Object.defineProperty(o, "visible", { get: () => true, set: () => {} }); n++; };
            const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
            if (proxy) force(proxy);
            const roots = new Set();
            sf.scene.traverse((o) => {
              if (o.name === "mainSail" || o.name === "jibSail") {
                let r = o;
                for (let p = o.parent; p && p !== sf.scene; p = p.parent) r = p;
                roots.add(r);
              }
            });
            // speedboat mounts: force every mount mesh via debug list linkage —
            // walk scene groups whose child names include propeller/hullish parts
            for (const r of roots) force(r);
            return n + " roots forced visible";
          })()`));
        }
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const v = new sf.THREE.Vector3();
          const canvas = document.querySelector("canvas");
          const off = document.createElement("canvas");
          off.width = 200; off.height = 125;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          window.__frameSpy = { events: [], frame: 0 };
          let current = [];
          let previous = [];
          const origRender = sf.renderer.renderObject.bind(sf.renderer);
          sf.renderer.renderObject = (object, ...rest) => {
            try {
              v.setFromMatrixPosition(object.matrixWorld);
              const dx = v.x - sf.camera.position.x, dz = v.z - sf.camera.position.z;
              const d = Math.hypot(dx, dz);
              if (d > 200) current.push([object.name || object.type, Math.round(v.x), Math.round(v.y), Math.round(v.z), Math.round(d)]);
            } catch {}
            return origRender(object, ...rest);
          };
          const scan = () => {
            window.__frameSpy.frame++;
            try {
              ctx.drawImage(canvas, 0, 0, 200, 125);
              const img = ctx.getImageData(0, 8, 200, 55).data; // sky band rows 8..63 (~y64..504 full)
              let dark = 0, cx = 0, cy = 0;
              for (let p = 0; p < img.length; p += 4) {
                const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
                if (lum < 105) { dark++; cx += (p / 4) % 200; cy += Math.floor(p / 4 / 200); }
              }
              if (dark >= 2 && dark < 900) {
                window.__frameSpy.events.push({
                  frame: window.__frameSpy.frame, dark,
                  px: Math.round(cx / dark * 8), py: Math.round((cy / dark + 8) * 8),
                  draws: current.slice(0, 400), prevDraws: previous.slice(0, 400)
                });
                if (window.__frameSpy.events.length > 25) window.__frameSpy.events.shift();
              }
            } catch (err) { window.__frameSpy.err = String(err); }
            previous = current;
            current = [];
            requestAnimationFrame(scan);
          };
          requestAnimationFrame(scan);
          return "frame spy on";
        })()`));
        await sleep(Number(process.env.SF_SPY_SECONDS ?? 90) * 1000);
        const out = await ev(cdp, `(() => { const e = window.__frameSpy.events; return { err: window.__frameSpy.err, frames: window.__frameSpy.frame, count: e.length, events: e.map(ev => ({ frame: ev.frame, dark: ev.dark, px: ev.px, py: ev.py, draws: ev.draws, prevDraws: ev.prevDraws })) }; })()`);
        writeFileSync(path.join(OUT, "framespy.json"), JSON.stringify(out, null, 1));
        console.log("[repro] framespy: frames=" + out.frames + " events=" + out.count + " err=" + out.err);
      }
      if (process.env.SF_PATCH === "mountcheck") {
        console.log("[repro] mounts:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const px = sf.player.position;
          const mounts = sf.abandonedMounts.debugMounts().map((m) => m.mode + " d=" + Math.round(Math.hypot(m.x - px.x, m.z - px.z)));
          const vis = [];
          sf.scene.traverse((o) => {
            if (o.name === "mainSail" || (o.name || "").toLowerCase().includes("hull") || (o.name || "").toLowerCase().includes("speedboat")) {
              let v = true;
              for (let p = o; p; p = p.parent) if (!p.visible) { v = false; break; }
              vis.push(o.name + ":" + (v ? "VIS" : "hid"));
            }
          });
          return JSON.stringify({ mounts, vis });
        })()`));
      }
      if (process.env.SF_PATCH === "gatecheck") {
        await sleep(3000);
        console.log("[repro] gatecheck:", await ev(cdp, `(async () => {
          const sf = window.__sf;
          const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
          if (!proxy) return "no proxy";
          const hull = proxy.children.find((c) => c.isMesh);
          const THREE = sf.THREE;
          const frustum = new THREE.Frustum();
          const m = new THREE.Matrix4();
          const sphere = new THREE.Sphere();
          let drawn = 0;
          hull.onBeforeRender = () => { drawn++; };
          const stats = { frames: 0, visFail: 0, layerFail: 0, frustumFail: 0, pass: 0, drawn: 0, sampleY: [] };
          await new Promise((done) => {
            const step = () => {
              stats.frames++;
              let vis = true;
              for (let p = hull; p; p = p.parent) if (!p.visible) { vis = false; break; }
              if (!vis) stats.visFail++;
              else if (!hull.layers.test(sf.camera.layers)) stats.layerFail++;
              else {
                m.multiplyMatrices(sf.camera.projectionMatrix, sf.camera.matrixWorldInverse);
                frustum.setFromProjectionMatrix(m, sf.camera.coordinateSystem, sf.camera.reversedDepth);
                hull.geometry.computeBoundingSphere();
                sphere.copy(hull.geometry.boundingSphere).applyMatrix4(hull.matrixWorld);
                if (!frustum.intersectsSphere(sphere)) { stats.frustumFail++; if (stats.sampleY.length < 5) stats.sampleY.push([Math.round(sphere.center.x), Math.round(sphere.center.y), Math.round(sphere.center.z), Math.round(sphere.radius)]); }
                else stats.pass++;
              }
              if (stats.frames < 400) requestAnimationFrame(step);
              else { stats.drawn = drawn; done(); }
            };
            requestAnimationFrame(step);
          });
          return JSON.stringify(stats);
        })()`));
      }
      if (process.env.SF_PATCH === "hullspy") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
          if (!proxy) return "no proxy";
          window.__hullSpy = { draws: [], frames: 0 };
          const v = new sf.THREE.Vector3();
          let frame = 0;
          const tick = () => { frame++; window.__hullSpy.frames = frame; requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
          proxy.traverse((o) => {
            if (!o.isMesh) return;
            o.onBeforeRender = () => {
              v.setFromMatrixPosition(o.matrixWorld);
              window.__hullSpy.draws.push({ t: Math.round(performance.now()), frame, name: o.name || o.type, y: Math.round(v.y) });
              if (window.__hullSpy.draws.length > 8000) window.__hullSpy.draws.shift();
            };
          });
          return "hull spy on " + proxy.children.length + " children";
        })()`));
      }
      if (process.env.SF_PATCH === "pinproxy") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
          if (!proxy) return "no proxy";
          const beacon = sf.ghostShipBeacon;
          const pose = beacon.pose;
          beacon.update = () => pose;   // freeze route-follow
          // 800m ahead of the freecam eye toward the aim, at 250m altitude
          const eye = sf.camera.position;
          proxy.position.set(eye.x + 700, 250, eye.z - 400);
          proxy.rotation.set(0, 1.2, 0);
          proxy.updateMatrixWorld(true);
          return "proxy pinned at " + proxy.position.toArray().map(Math.round).join(",");
        })()`));
      }
      if (process.env.SF_PATCH === "drawspy2") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const v = new sf.THREE.Vector3();
          window.__spy2 = [];
          const orig = sf.renderer.renderObject.bind(sf.renderer);
          sf.renderer.renderObject = (object, ...rest) => {
            try {
              v.setFromMatrixPosition(object.matrixWorld);
              const dx = v.x - sf.camera.position.x, dz = v.z - sf.camera.position.z;
              const dist = Math.hypot(dx, dz);
              if (v.y > 60 && dist > 40 && dist < 9000) {
                window.__spy2.push({ t: Math.round(performance.now()), name: object.name || object.type, x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) });
                if (window.__spy2.length > 20000) window.__spy2.shift();
              }
            } catch {}
            return orig(object, ...rest);
          };
          return "spy2 installed";
        })()`));
      }
      if (process.env.SF_PATCH === "noboats") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const mounts = sf.abandonedMounts;
          const info = mounts && mounts.debugMounts ? mounts.debugMounts() : null;
          // hide every mount mesh that contains a sail (scatter boats) — walk the
          // scene for groups containing mainSail/jibSail and hide the whole group.
          let hidden = 0;
          const roots = new Set();
          sf.scene.traverse((o) => {
            if (o.name === "mainSail" || o.name === "jibSail" || o.name === "speedboat-hull") {
              let r = o;
              for (let p = o.parent; p && p !== sf.scene; p = p.parent) r = p;
              roots.add(r);
            }
          });
          for (const r of roots) { r.visible = false; hidden++; }
          return JSON.stringify({ mounts: info, hiddenRoots: hidden });
        })()`));
      }
      if (process.env.SF_PATCH === "drawspy") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const suspect = /car_|sail|surfboard|scooter|launcher|phoenix|board-|sole-|busker/i;
          window.__drawSpy = [];
          const orig = sf.renderer.renderObject.bind(sf.renderer);
          sf.renderer.renderObject = (object, ...rest) => {
            try {
              if (object && object.name && suspect.test(object.name)) {
                let vis = true;
                for (let p = object; p; p = p.parent) { if (!p.visible) { vis = false; break; } }
                window.__drawSpy.push({ t: Math.round(performance.now()), name: object.name, vis, inScene: (() => { for (let p = object; p; p = p.parent) if (p === sf.scene) return true; return false; })() });
                if (window.__drawSpy.length > 5000) window.__drawSpy.shift();
              }
            } catch {}
            return orig(object, ...rest);
          };
          return "draw spy installed";
        })()`));
      }
      if (process.env.SF_PATCH === "gatecompile2") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          window.__compileDepth = 0;
          window.__linger = 0;
          let chain = Promise.resolve();
          const origCompile = sf.renderer.compileAsync.bind(sf.renderer);
          sf.renderer.compileAsync = (...a) => {
            const run = async () => {
              window.__compileDepth++;
              try { return await origCompile(...a); }
              finally { window.__compileDepth--; window.__linger = 2; }
            };
            const p = chain.then(run, run);
            chain = p.catch(() => {});
            return p;
          };
          if (!sf.pipeline || typeof sf.pipeline.render !== "function") return "no pipeline.render";
          const origRender = sf.pipeline.render.bind(sf.pipeline);
          sf.pipeline.render = (...a) => {
            if (window.__compileDepth > 0) return;
            if (window.__linger > 0) { window.__linger--; return; }
            return origRender(...a);
          };
          return "compile gate v2 installed";
        })()`));
      }
      if (process.env.SF_PATCH === "gatecompile") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          window.__compileDepth = 0;
          const origCompile = sf.renderer.compileAsync.bind(sf.renderer);
          sf.renderer.compileAsync = async (...a) => {
            window.__compileDepth++;
            try { return await origCompile(...a); } finally { window.__compileDepth--; }
          };
          if (!sf.pipeline || typeof sf.pipeline.render !== "function") return "no pipeline.render";
          const origRender = sf.pipeline.render.bind(sf.pipeline);
          sf.pipeline.render = (...a) => {
            if (window.__compileDepth > 0) return;
            return origRender(...a);
          };
          return "compile gate installed";
        })()`));
      }
      if (process.env.SF_PATCH === "freezering") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          if (!sf.citygenRing) return "no citygenRing";
          sf.citygenRing.update = () => {};
          return "ring frozen";
        })()`));
        await sleep(3000); // let in-flight fades settle before measuring
      }
      if (process.env.SF_PATCH === "nocull") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf; let n = 0;
          sf.scene.traverse((o) => { if (o.isBatchedMesh) { o.perObjectFrustumCulled = false; o.sortObjects = false; n++; } });
          // keep future batches patched too
          const proto = sf.THREE.BatchedMesh.prototype;
          if (!proto.__noCullPatch) {
            proto.__noCullPatch = true;
            const orig = Object.getOwnPropertyDescriptor(proto, "perObjectFrustumCulled");
            void orig;
          }
          const origAdd = sf.THREE.Object3D.prototype.add;
          sf.THREE.Object3D.prototype.add = function (...objs) {
            for (const o of objs) if (o && o.isBatchedMesh) { o.perObjectFrustumCulled = false; o.sortObjects = false; }
            return origAdd.apply(this, objs);
          };
          return n + " batches patched";
        })()`));
      }
      await sleep(800);

      const bounce = process.env.SF_BOUNCE === "1";
      const shotTimes = [];
      for (let i = 0; i < SHOTS; i++) {
        if (bounce && i % 8 === 0) {
          await ev(cdp, `(() => {
            const sf = window.__sf;
            if (!window.__bounceBase) window.__bounceBase = { x: sf.player.position.x, z: sf.player.position.z, n: 0 };
            const b = window.__bounceBase; b.n++;
            const off = (b.n % 2) ? 1500 : 0;
            sf.player.position.x = b.x + off;
            return "bounce " + b.n + " off=" + off;
          })()`);
        }
        if (["drawspy", "drawspy2", "hullspy"].includes(process.env.SF_PATCH || "")) shotTimes.push(await ev(cdp, `Math.round(performance.now())`));
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(path.join(OUT, "shots", `s${String(i).padStart(3, "0")}.png`), Buffer.from(shot.data, "base64"));
      }
      if (process.env.SF_PATCH === "realwalk") {
        // REAL walking via the scripted InputDriver (full player.update, trample,
        // chase camera) while the pixel spy watches the sky band.
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const canvas = document.querySelector("canvas");
          const off = document.createElement("canvas");
          off.width = 220; off.height = 138;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          window.__walkSpy = { events: [], frame: 0, err: null };
          const spy = window.__walkSpy;
          sf.input.setDriver({
            update(dt, controls) {
              spy.frame++;
              if (spy.frame === 1 && sf.chase) sf.chase.yaw = Number("${process.env.SF_YAW ?? "3.14"}");
              controls.hold("KeyW");
              // slow weave so the camera sweeps sky+grass; occasional look up
              controls.look(Math.sin(spy.frame * 0.004) * 3.0, Math.sin(spy.frame * 0.0113) * 1.4);
              try {
                ctx.drawImage(canvas, 0, 0, 220, 138);
                const img = ctx.getImageData(0, 4, 220, 44).data;
                let hits = 0, cx = 0, cy = 0;
                for (let p = 0; p < img.length; p += 4) {
                  const r = img[p], g = img[p + 1], b = img[p + 2];
                  const bright = (r + g + b) / 3;
                  const greenish = g > b + 12 && g > 60;
                  const cream = bright > 228 && b < 246;
                  const darkblob = bright < 100;
                  if (greenish || cream || darkblob) { hits++; cx += (p / 4) % 220; cy += Math.floor(p / 4 / 220); }
                }
                if (hits >= 3 && hits < 2500) {
                  spy.events.push({ frame: spy.frame, hits, px: Math.round(cx / hits * (1600 / 220)), py: Math.round((cy / hits + 4) * (1000 / 138)) });
                  if (spy.events.length > 80) spy.events.shift();
                }
              } catch (err) { spy.err = String(err); }
            }
          });
          return "real-walk driver installed";
        })()`));
        await sleep(Number(process.env.SF_SPY_SECONDS ?? 90) * 1000);
        const out = await ev(cdp, `(() => { const sf = window.__sf; return { frames: window.__walkSpy.frame, err: window.__walkSpy.err, eventCount: window.__walkSpy.events.length, events: window.__walkSpy.events.slice(-20), pos: sf.player.position.toArray().map(Math.round) }; })()`);
        writeFileSync(path.join(OUT, "realwalk.json"), JSON.stringify(out, null, 1));
        console.log("[repro] realwalk:", JSON.stringify(out).slice(0, 700));
      }
      if (process.env.SF_PATCH === "grasswalk") {
        // Drive the player along the beach through wildlands grass while a
        // pixel spy watches the sky band for grass-colored/bright spikes
        // (stretched or misplaced blade instances). Camera trails the player.
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const canvas = document.querySelector("canvas");
          const off = document.createElement("canvas");
          off.width = 220; off.height = 138;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          window.__walkSpy = { events: [], frame: 0, err: null, moved: 0 };
          const spy = window.__walkSpy;
          const base = { x: sf.player.position.x, z: sf.player.position.z };
          const speed = Number("${process.env.SF_WALK_SPEED ?? "0.12"}");
          const freeze = "${process.env.SF_FREEZE_GRASS ?? ""}" === "1";
          if (freeze && sf.wildlands && sf.wildlands.grass && sf.wildlands.grass.update) {
            sf.wildlands.grass.update = () => {};
          }
          const scan = () => {
            spy.frame++;
            // stroll north along the dune line, gentle weave
            const t = spy.frame;
            sf.player.position.x = base.x + Math.sin(t * 0.005) * 25;
            sf.player.position.z = base.z - t * speed;
            spy.moved = Math.round(t * speed);
            window.__sfFreeCam(
              [sf.player.position.x + 3, sf.player.position.y + 2.2, sf.player.position.z + 26],
              [sf.player.position.x, sf.player.position.y + 14, sf.player.position.z - 60]
            );
            try {
              ctx.drawImage(canvas, 0, 0, 220, 138);
              // sky band: rows 4..52 of 138 (~upper 40%)
              const img = ctx.getImageData(0, 4, 220, 48).data;
              let hits = 0, cx = 0, cy = 0;
              for (let p = 0; p < img.length; p += 4) {
                const r = img[p], g = img[p + 1], b = img[p + 2];
                const bright = (r + g + b) / 3;
                const greenish = g > b + 12 && g > 60;
                const cream = bright > 225 && b < 245;
                const darkblob = bright < 105;
                if (greenish || cream || darkblob) { hits++; cx += (p / 4) % 220; cy += Math.floor(p / 4 / 220); }
              }
              if (hits >= 3 && hits < 2500) {
                spy.events.push({ frame: spy.frame, hits, px: Math.round(cx / hits * (1600 / 220)), py: Math.round((cy / hits + 4) * (1000 / 138)) });
                if (spy.events.length > 60) spy.events.shift();
              }
            } catch (err) { spy.err = String(err); }
            requestAnimationFrame(scan);
          };
          requestAnimationFrame(scan);
          return "walk spy on" + (freeze ? " (grass streaming frozen)" : "");
        })()`));
        await sleep(Number(process.env.SF_SPY_SECONDS ?? 60) * 1000);
        const out = await ev(cdp, `window.__walkSpy && { frames: window.__walkSpy.frame, movedMeters: window.__walkSpy.moved, err: window.__walkSpy.err, eventCount: window.__walkSpy.events.length, events: window.__walkSpy.events.slice(-15) }`);
        writeFileSync(path.join(OUT, "grasswalk.json"), JSON.stringify(out, null, 1));
        console.log("[repro] grasswalk:", JSON.stringify(out).slice(0, 600));
      }
      if (process.env.SF_PATCH === "echochurn") {
        // Waterline churn: oscillate the (freecam-frozen) player across the
        // shoreline so water-echo eligibility flaps, while an in-page pixel
        // scanner watches the sky for one-frame dark flashes.
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const v = new sf.THREE.Vector3();
          const canvas = document.querySelector("canvas");
          const off = document.createElement("canvas");
          off.width = 200; off.height = 125;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          window.__churnSpy = { events: [], frame: 0, echoTransitions: 0, activeFrames: 0, err: null };
          const spy = window.__churnSpy;
          const baseX = sf.player.position.x;
          const baseZ = sf.player.position.z;
          // find the waterline west of the player once
          let shore = null;
          for (let dx = 0; dx > -260; dx -= 2) {
            if (sf.map.isWater(baseX + dx, baseZ)) { shore = baseX + dx; break; }
          }
          if (shore === null) return "no water found west";
          // camera hovers just past the waterline looking further out to sea, so
          // the mirror footprint between camera and player is always on water.
          window.__sfFreeCam([shore - 10, 8, baseZ], [shore - 200, 0, baseZ]);
          const origEmit = sf.water.echoes.emit.bind(sf.water.echoes);
          spy.emits = 0;
          sf.water.echoes.emit = (s) => { spy.emits++; return origEmit(s); };
          let lastVisible = false;
          const scan = () => {
            spy.frame++;
            // every 12 frames hop across the waterline: wet <-> dry
            const wet = Math.floor(spy.frame / 12) % 2 === 0;
            sf.player.position.x = wet ? shore - 60 : shore + 40;
            sf.player.position.z = baseZ;
            if (wet && !spy.guardSample && spy.frame > 30) {
              const cam = sf.camera.position;
              const sx = sf.player.position.x, sy = sf.player.position.y, sz = sf.player.position.z;
              const srcWater = sf.map.isWater(sx, sz);
              const altitude = sy; // waterHeight ~ swell around 0
              const camAlt = cam.y;
              const mirrorT = camAlt / Math.max(0.1, camAlt + altitude);
              const cx = cam.x + (sx - cam.x) * mirrorT;
              const cz = cam.z + (sz - cam.z) * mirrorT;
              const fwd = new sf.THREE.Vector3();
              sf.camera.getWorldDirection(fwd);
              const toEcho = new sf.THREE.Vector3(cx - cam.x, -cam.y, cz - cam.z);
              spy.guardSample = {
                playerY: +sy.toFixed(2), camY: +cam.y.toFixed(2), camX: Math.round(cam.x),
                srcWater, mirrorWater: sf.map.isWater(cx, cz), cx: Math.round(cx),
                dot: +toEcho.dot(fwd).toFixed(2), dist: Math.round(toEcho.length())
              };
            }
            const nowVisible = sf.water.echoes.shadows.visible || sf.water.echoes.lights.visible;
            if (nowVisible !== lastVisible) spy.echoTransitions++;
            if (nowVisible) spy.activeFrames++;
            lastVisible = nowVisible;
            try {
              ctx.drawImage(canvas, 0, 0, 200, 125);
              const img = ctx.getImageData(0, 6, 200, 52).data;
              let dark = 0, cx = 0, cy = 0;
              for (let p = 0; p < img.length; p += 4) {
                const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
                if (lum < 105) { dark++; cx += (p / 4) % 200; cy += Math.floor(p / 4 / 200); }
              }
              if (dark >= 2 && dark < 900) {
                spy.events.push({ frame: spy.frame, dark, px: Math.round(cx / dark * 8), py: Math.round((cy / dark + 6) * 8) });
                if (spy.events.length > 40) spy.events.shift();
              }
            } catch (err) { spy.err = String(err); }
            requestAnimationFrame(scan);
          };
          requestAnimationFrame(scan);
          return "churn spy on, shore at x=" + Math.round(shore) + " (player base x=" + Math.round(baseX) + ")";
        })()`));
        await sleep(Number(process.env.SF_SPY_SECONDS ?? 90) * 1000);
        const out = await ev(cdp, `window.__churnSpy && { frames: window.__churnSpy.frame, transitions: window.__churnSpy.echoTransitions, activeFrames: window.__churnSpy.activeFrames, emits: window.__churnSpy.emits, guard: window.__churnSpy.guardSample, err: window.__churnSpy.err, events: window.__churnSpy.events }`);
        writeFileSync(path.join(OUT, "echochurn.json"), JSON.stringify(out, null, 1));
        console.log("[repro] echochurn:", JSON.stringify(out).slice(0, 800));
      }
      if (process.env.SF_PATCH === "framespy") {
        if (process.env.SF_UNMITIGATE === "1") {
          console.log("[repro] unmitigate:", await ev(cdp, `(() => {
            const sf = window.__sf;
            let n = 0;
            const force = (o) => { Object.defineProperty(o, "visible", { get: () => true, set: () => {} }); n++; };
            const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
            if (proxy) force(proxy);
            const roots = new Set();
            sf.scene.traverse((o) => {
              if (o.name === "mainSail" || o.name === "jibSail") {
                let r = o;
                for (let p = o.parent; p && p !== sf.scene; p = p.parent) r = p;
                roots.add(r);
              }
            });
            // speedboat mounts: force every mount mesh via debug list linkage —
            // walk scene groups whose child names include propeller/hullish parts
            for (const r of roots) force(r);
            return n + " roots forced visible";
          })()`));
        }
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const v = new sf.THREE.Vector3();
          const canvas = document.querySelector("canvas");
          const off = document.createElement("canvas");
          off.width = 200; off.height = 125;
          const ctx = off.getContext("2d", { willReadFrequently: true });
          window.__frameSpy = { events: [], frame: 0 };
          let current = [];
          let previous = [];
          const origRender = sf.renderer.renderObject.bind(sf.renderer);
          sf.renderer.renderObject = (object, ...rest) => {
            try {
              v.setFromMatrixPosition(object.matrixWorld);
              const dx = v.x - sf.camera.position.x, dz = v.z - sf.camera.position.z;
              const d = Math.hypot(dx, dz);
              if (d > 200) current.push([object.name || object.type, Math.round(v.x), Math.round(v.y), Math.round(v.z), Math.round(d)]);
            } catch {}
            return origRender(object, ...rest);
          };
          const scan = () => {
            window.__frameSpy.frame++;
            try {
              ctx.drawImage(canvas, 0, 0, 200, 125);
              const img = ctx.getImageData(0, 8, 200, 55).data; // sky band rows 8..63 (~y64..504 full)
              let dark = 0, cx = 0, cy = 0;
              for (let p = 0; p < img.length; p += 4) {
                const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
                if (lum < 105) { dark++; cx += (p / 4) % 200; cy += Math.floor(p / 4 / 200); }
              }
              if (dark >= 2 && dark < 900) {
                window.__frameSpy.events.push({
                  frame: window.__frameSpy.frame, dark,
                  px: Math.round(cx / dark * 8), py: Math.round((cy / dark + 8) * 8),
                  draws: current.slice(0, 400), prevDraws: previous.slice(0, 400)
                });
                if (window.__frameSpy.events.length > 25) window.__frameSpy.events.shift();
              }
            } catch (err) { window.__frameSpy.err = String(err); }
            previous = current;
            current = [];
            requestAnimationFrame(scan);
          };
          requestAnimationFrame(scan);
          return "frame spy on";
        })()`));
        await sleep(Number(process.env.SF_SPY_SECONDS ?? 90) * 1000);
        const out = await ev(cdp, `(() => { const e = window.__frameSpy.events; return { err: window.__frameSpy.err, frames: window.__frameSpy.frame, count: e.length, events: e.map(ev => ({ frame: ev.frame, dark: ev.dark, px: ev.px, py: ev.py, draws: ev.draws, prevDraws: ev.prevDraws })) }; })()`);
        writeFileSync(path.join(OUT, "framespy.json"), JSON.stringify(out, null, 1));
        console.log("[repro] framespy: frames=" + out.frames + " events=" + out.count + " err=" + out.err);
      }
      if (process.env.SF_PATCH === "mountcheck") {
        console.log("[repro] mounts:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const px = sf.player.position;
          const mounts = sf.abandonedMounts.debugMounts().map((m) => m.mode + " d=" + Math.round(Math.hypot(m.x - px.x, m.z - px.z)));
          const vis = [];
          sf.scene.traverse((o) => {
            if (o.name === "mainSail" || (o.name || "").toLowerCase().includes("hull") || (o.name || "").toLowerCase().includes("speedboat")) {
              let v = true;
              for (let p = o; p; p = p.parent) if (!p.visible) { v = false; break; }
              vis.push(o.name + ":" + (v ? "VIS" : "hid"));
            }
          });
          return JSON.stringify({ mounts, vis });
        })()`));
      }
      if (process.env.SF_PATCH === "gatecheck") {
        await sleep(3000);
        console.log("[repro] gatecheck:", await ev(cdp, `(async () => {
          const sf = window.__sf;
          const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
          if (!proxy) return "no proxy";
          const hull = proxy.children.find((c) => c.isMesh);
          const THREE = sf.THREE;
          const frustum = new THREE.Frustum();
          const m = new THREE.Matrix4();
          const sphere = new THREE.Sphere();
          let drawn = 0;
          hull.onBeforeRender = () => { drawn++; };
          const stats = { frames: 0, visFail: 0, layerFail: 0, frustumFail: 0, pass: 0, drawn: 0, sampleY: [] };
          await new Promise((done) => {
            const step = () => {
              stats.frames++;
              let vis = true;
              for (let p = hull; p; p = p.parent) if (!p.visible) { vis = false; break; }
              if (!vis) stats.visFail++;
              else if (!hull.layers.test(sf.camera.layers)) stats.layerFail++;
              else {
                m.multiplyMatrices(sf.camera.projectionMatrix, sf.camera.matrixWorldInverse);
                frustum.setFromProjectionMatrix(m, sf.camera.coordinateSystem, sf.camera.reversedDepth);
                hull.geometry.computeBoundingSphere();
                sphere.copy(hull.geometry.boundingSphere).applyMatrix4(hull.matrixWorld);
                if (!frustum.intersectsSphere(sphere)) { stats.frustumFail++; if (stats.sampleY.length < 5) stats.sampleY.push([Math.round(sphere.center.x), Math.round(sphere.center.y), Math.round(sphere.center.z), Math.round(sphere.radius)]); }
                else stats.pass++;
              }
              if (stats.frames < 400) requestAnimationFrame(step);
              else { stats.drawn = drawn; done(); }
            };
            requestAnimationFrame(step);
          });
          return JSON.stringify(stats);
        })()`));
      }
      if (process.env.SF_PATCH === "hullspy") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
          if (!proxy) return "no proxy";
          window.__hullSpy = { draws: [], frames: 0 };
          const v = new sf.THREE.Vector3();
          let frame = 0;
          const tick = () => { frame++; window.__hullSpy.frames = frame; requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
          proxy.traverse((o) => {
            if (!o.isMesh) return;
            o.onBeforeRender = () => {
              v.setFromMatrixPosition(o.matrixWorld);
              window.__hullSpy.draws.push({ t: Math.round(performance.now()), frame, name: o.name || o.type, y: Math.round(v.y) });
              if (window.__hullSpy.draws.length > 8000) window.__hullSpy.draws.shift();
            };
          });
          return "hull spy on " + proxy.children.length + " children";
        })()`));
      }
      if (process.env.SF_PATCH === "pinproxy") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
          if (!proxy) return "no proxy";
          const beacon = sf.ghostShipBeacon;
          const pose = beacon.pose;
          beacon.update = () => pose;   // freeze route-follow
          // 800m ahead of the freecam eye toward the aim, at 250m altitude
          const eye = sf.camera.position;
          proxy.position.set(eye.x + 700, 250, eye.z - 400);
          proxy.rotation.set(0, 1.2, 0);
          proxy.updateMatrixWorld(true);
          return "proxy pinned at " + proxy.position.toArray().map(Math.round).join(",");
        })()`));
      }
      if (process.env.SF_PATCH === "drawspy2") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const v = new sf.THREE.Vector3();
          window.__spy2 = [];
          const orig = sf.renderer.renderObject.bind(sf.renderer);
          sf.renderer.renderObject = (object, ...rest) => {
            try {
              v.setFromMatrixPosition(object.matrixWorld);
              const dx = v.x - sf.camera.position.x, dz = v.z - sf.camera.position.z;
              const dist = Math.hypot(dx, dz);
              if (v.y > 60 && dist > 40 && dist < 9000) {
                window.__spy2.push({ t: Math.round(performance.now()), name: object.name || object.type, x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) });
                if (window.__spy2.length > 20000) window.__spy2.shift();
              }
            } catch {}
            return orig(object, ...rest);
          };
          return "spy2 installed";
        })()`));
      }
      if (process.env.SF_PATCH === "noboats") {
        console.log("[repro] patch:", await ev(cdp, `(() => {
          const sf = window.__sf;
          const mounts = sf.abandonedMounts;
          const info = mounts && mounts.debugMounts ? mounts.debugMounts() : null;
          // hide every mount mesh that contains a sail (scatter boats) — walk the
          // scene for groups containing mainSail/jibSail and hide the whole group.
          let hidden = 0;
          const roots = new Set();
          sf.scene.traverse((o) => {
            if (o.name === "mainSail" || o.name === "jibSail" || o.name === "speedboat-hull") {
              let r = o;
              for (let p = o.parent; p && p !== sf.scene; p = p.parent) r = p;
              roots.add(r);
            }
          });
          for (const r of roots) { r.visible = false; hidden++; }
          return JSON.stringify({ mounts: info, hiddenRoots: hidden });
        })()`));
      }
      if (process.env.SF_PATCH === "hullspy") {
        const spy = await ev(cdp, `({ frames: window.__hullSpy.frames, draws: window.__hullSpy.draws.length, sample: window.__hullSpy.draws.slice(-30), byFrame: (() => { const s = new Set(); for (const d of window.__hullSpy.draws) s.add(d.frame); return s.size; })() })`);
        writeFileSync(path.join(OUT, "hullspy.json"), JSON.stringify({ shotTimes, spy }, null, 1));
        console.log("[repro] hullspy:", JSON.stringify({ frames: spy.frames, draws: spy.draws, drawFrames: spy.byFrame }));
      }
      if (process.env.SF_PATCH === "drawspy2") {
        const spy = await ev(cdp, `window.__spy2`);
        writeFileSync(path.join(OUT, "drawspy2.json"), JSON.stringify({ shotTimes, spy }, null, 1));
        console.log("[repro] spy2 events:", spy.length);
      }
      if (process.env.SF_PATCH === "drawspy") {
        const spy = await ev(cdp, `window.__drawSpy`);
        writeFileSync(path.join(OUT, "drawspy.json"), JSON.stringify({ shotTimes, spy }, null, 1));
        console.log("[repro] drawspy events:", spy.length);
        const counts = {};
        for (const s of spy) counts[`${s.name}|vis=${s.vis}`] = (counts[`${s.name}|vis=${s.vis}`] || 0) + 1;
        for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log("   ", v, k);
      }
      console.log("[repro] captured", SHOTS, "shots at", OUT);
      // proxy pose + whether detailed ship loaded
      console.log("[repro] state:", JSON.stringify(await ev(cdp, `(() => {
        const sf = window.__sf;
        const proxy = sf.scene.getObjectByName("ghost_ship_horizon_proxy");
        return { proxyVisible: proxy ? proxy.visible : null, proxyPos: proxy ? proxy.position.toArray().map(Math.round) : null, ghostLoaded: !!sf.ghostShip, online: (() => { try { return sf.net && sf.net.online ? sf.net.online() : null; } catch { return null; } })() };
      })()`)));
      cdp.close();
    } finally { chrome.kill("SIGKILL"); }
  } finally { vite.kill("SIGKILL"); }
}
main().catch((e) => { console.error("[repro] FAILED:", e.message); process.exit(1); });
