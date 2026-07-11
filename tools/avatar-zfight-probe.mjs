// Avatar z-fight probe. Boots the real app headless, stands the player idle,
// parks the chase camera behind them (the exact view from the bug video),
// captures consecutive frames, and reports:
//   1. per-pixel flicker between consecutive frames inside the avatar bbox
//      (temporal instability = z-fighting / shadow flicker),
//   2. an analytic coplanar-face audit of every mesh under the player rig —
//      pairs of world-space axis-aligned faces on the same plane with
//      overlapping extents (the geometric cause of z-fighting).
//   node tools/avatar-zfight-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/avatar-zfight");
const TMP = path.join(process.env.TMPDIR ?? "/tmp", "sf-avatar-zfight-probe");
const PROFILE_ROOT = path.join(TMP, "profile");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5237";
const W = 900, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue;
    return c;
  }
  throw new Error("No Chrome found.");
}
function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDev() {
  try { await waitHttp(SERVER_URL, 2000, "existing vite"); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(SERVER_URL, 90000, "vite");
  return child;
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
  close() { this.#ws.close(); }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 1200)}`);
  return r.result?.value;
}

// minimal PNG decode (RGBA8, non-interlaced) so we can diff without deps
function decodePng(buf) {
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`png fmt ${bitDepth}/${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(row, 0, rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const cc = x >= bpp && prev ? prev[x - bpp] : 0;
      switch (filter) {
        case 1: row[x] = (row[x] + a) & 255; break;
        case 2: row[x] = (row[x] + b) & 255; break;
        case 3: row[x] = (row[x] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
          row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc)) & 255; break;
        }
      }
    }
  }
  return { w, h, bpp, data: out };
}

function diffFrames(a, b) {
  const { w, h, bpp } = a;
  let changed = 0;
  const mask = Buffer.alloc(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += bpp) {
    const d = Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2]);
    if (d > 24) { changed++; mask[i] = 255; }
  }
  return { changed, frac: changed / (w * h), mask };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDev();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(PROFILE_ROOT, "run-" + Date.now())}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--autoplay-policy=no-user-gesture-required", "--mute-audio",
    "--hide-scrollbars", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
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
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) {
    try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {}
    await sleep(600);
  }
  if (!ready) throw new Error("app never ready");
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  const P = `const sf=window.__sf; const dev=sf.renderer.backend.device;
    const tick=async(n)=>{ for(let i=0;i<n;i++){ sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); } };`;

  for (let k = 0; k < 12; k++) {
    try { await ev(c, `(async()=>{ ${P} await tick(20); return true; })()`); } catch {}
    await sleep(250);
  }

  // force the jacket avatar from the bug video, stand idle, sun behind camera-ish
  const setup = await ev(c, `(async()=>{ ${P}
    sf.player.setAvatar({skin:1,hair:"mohawk",hat:"none",outfit:"jacket",color:5,accent:7});
    await tick(30);
    const p = sf.player.renderPosition;
    return {pos:[p.x,p.y,p.z], mode: sf.player.mode};
  })()`);
  console.log("[setup]", JSON.stringify(setup));

  // analytic coplanar audit over the player mesh subtree
  const audit = await ev(c, `(async()=>{ ${P}
    await tick(2);
    const walkRoot = sf.player.meshes.walk;
    const v = new sf.THREE.Vector3();
    const boxes = [];
    walkRoot.updateWorldMatrix(true, true);
    walkRoot.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      let vis = true, p = o;
      while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; }
      if (!vis) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      // world corners (rig boxes stay axis-aligned while idle-ish; good enough to find planes)
      const mn = new sf.THREE.Vector3(Infinity,Infinity,Infinity), mx = new sf.THREE.Vector3(-Infinity,-Infinity,-Infinity);
      for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
        v.set(cx, cy, cz).applyMatrix4(o.matrixWorld);
        mn.min(v); mx.max(v);
      }
      const color = o.material?.color ? "#" + o.material.color.getHexString() : null;
      boxes.push({ name: o.name || o.parent?.name || "mesh", color, min: [mn.x, mn.y, mn.z], max: [mx.x, mx.y, mx.z] });
    });
    // coplanar pairs: same axis-plane within eps and overlapping in the other two axes
    const eps = 2e-3;
    const pairs = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i], B = boxes[j];
      for (let ax = 0; ax < 3; ax++) {
        const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
        const ovl = Math.min(A.max[o1], B.max[o1]) - Math.max(A.min[o1], B.min[o1]) > 0.005 &&
                    Math.min(A.max[o2], B.max[o2]) - Math.max(A.min[o2], B.min[o2]) > 0.005;
        if (!ovl) continue;
        for (const [fa, fb, kind] of [
          [A.min[ax], B.min[ax], "min/min"], [A.max[ax], B.max[ax], "max/max"],
          [A.min[ax], B.max[ax], "min/max"], [A.max[ax], B.min[ax], "max/min"]
        ]) {
          if (Math.abs(fa - fb) < eps) pairs.push({ a: A.name, aColor: A.color, b: B.name, bColor: B.color, axis: "xyz"[ax], kind, plane: +fa.toFixed(4) });
        }
      }
    }
    return { meshCount: boxes.length, boxes, pairs };
  })()`);
  writeFileSync(path.join(OUT, "audit.json"), JSON.stringify(audit, null, 2));
  console.log(`[audit] meshes=${audit.meshCount} coplanarPairs=${audit.pairs.length}`);
  for (const p of audit.pairs) console.log("  pair:", JSON.stringify(p));

  // live mode: real chase cam, real clock — the conditions from the bug video
  await ev(c, `window.__sfManual&&window.__sfManual(false)`);
  await sleep(3000);

  // rapid consecutive frames while the app free-runs
  const frames = [];
  for (let i = 0; i < 10; i++) {
    const s = await c.send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(s.data, "base64");
    writeFileSync(path.join(OUT, `frame_${i}.png`), buf);
    frames.push(decodePng(buf));
    await sleep(60);
  }
  const diffs = [];
  for (let i = 1; i < frames.length; i++) {
    const d = diffFrames(frames[i - 1], frames[i]);
    diffs.push({ pair: `${i - 1}->${i}`, changed: d.changed, frac: +d.frac.toFixed(5) });
  }
  console.log("[frame-diffs]", JSON.stringify(diffs));
  writeFileSync(path.join(OUT, "diffs.json"), JSON.stringify({ setup, diffs }, null, 2));

  c.close(); proc.kill(); if (dev) dev.kill();
  console.log("[artifacts] " + OUT);
  process.exit(0);
}
main().catch((e) => { console.error("[avatar-zfight-probe] FAIL", e); process.exit(1); });
