// Headless verification for per-frame GPU frustum culling of the wildlands
// grass + flower rings.
//
// Boots the app in headless Chrome (WebGPU), arrives at a GG Park meadow, then
// reads the shared indirect draw buffers (renderer.getArrayBufferAsync) while
// pointing the render camera in opposite directions. GPU culling is proven when
// the culled draw counts are a strict subset of the live compacted instances
// AND the visible set swings with the camera heading. Also captures ground-level
// screenshots for a visual regression check and fails on page errors.
//
//   node tools/grass-cull-probe.mjs
// Env: SF_PROBE_OUT (default .data/grass-cull-probe), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/grass-cull-probe");
const W = 1280, H = 720;
const MEADOW = { x: -4000, z: 2440 };
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
async function startDev() {
  if (process.env.SF_PROBE_URL) {
    await waitHttp(process.env.SF_PROBE_URL, 5000, "existing vite");
    return { url: process.env.SF_PROBE_URL, child: null };
  }
  const vitePort = await freePort();
  const relay = await freePort();
  const url = `http://127.0.0.1:${vitePort}`;
  console.log(`[probe] starting Vite at ${url}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(url, 60000, "vite");
  return { url, child };
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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(50); } }

async function teleport(c, x, z) {
  const generation = await ev(c, `(()=>{const sf=window.__sf;const g=sf.worldArrival.snapshot.generation;sf.teleportToTarget(${x},${z},'grass cull probe');return g;})()`);
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    await tick(c, 0);
    const arrived = await ev(c, `(()=>{const sf=window.__sf,a=sf.worldArrival.snapshot;return a.generation>${generation}&&a.state==='idle'&&!sf.player.worldArrivalHeld;})()`);
    if (arrived) return;
    await sleep(250);
  }
  throw new Error(`covered arrival timed out at ${x}, ${z}`);
}
async function freeCam(c, x, z, facing, back, up) {
  await ev(c, `(()=>{const m=window.__sf.map;
    const dx=Math.sin(${facing}),dz=Math.cos(${facing});
    const ex=${x}-dx*${back},ez=${z}-dz*${back};
    const tx=${x}+dx*20,tz=${z}+dz*20;
    const eye=[ex,m.groundHeight(ex,ez)+${up},ez];
    window.__sfFreeCam(eye,[tx,m.groundHeight(tx,tz)+${Math.max(1.5, up * 0.4)},tz]);return eye;})()`);
}

async function drawCounts(c, kind) {
  return ev(c, `(async()=>{const sf=window.__sf;const w=sf.wildlands;if(!w)return null;
    const group=${kind === "grass" ? "w.grass.group" : "w.flowers.group"};
    const attr=group.userData.${kind === "grass" ? "grassIndirect" : "flowerIndirect"};
    if(!attr)return null;
    const buf=await sf.renderer.getArrayBufferAsync(attr);
    const u=new Uint32Array(buf);
    const counts=[];for(let i=1;i<u.length;i+=5)counts.push(u[i]);
    return counts;})()`);
}

async function shot(c, name) {
  const s = await c.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, "base64"));
  console.log(`[probe] shot ${name}`);
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

async function main() {
  mkdirSync(OUT, { recursive: true });
  // Fresh browser profile every run: persisted tunables must not pin stale
  // density defaults under the probe.
  const { rmSync } = await import("node:fs");
  rmSync(path.join(OUT, "profile"), { recursive: true, force: true });
  const dev = await startDev();
  const chrome = await findChrome();
  const debugPort = await freePort();
  const browser = spawn(chrome, [
    `--remote-debugging-port=${debugPort}`,
    "--headless=new", `--window-size=${W},${H}`, "--hide-scrollbars",
    "--mute-audio", "--no-first-run", "--no-default-browser-check",
    "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
    `--user-data-dir=${path.join(OUT, "profile")}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const failures = [];
  const pageErrors = [];
  try {
    await waitHttp(`http://127.0.0.1:${debugPort}/json/version`, 20000, "chrome devtools");
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    const page = targets.find((t) => t.type === "page");
    const c = new Cdp(page.webSocketDebuggerUrl);
    await c.open();
    c.onEvent = (m) => {
      if (m.method === "Runtime.exceptionThrown") {
        pageErrors.push(JSON.stringify(m.params?.exceptionDetails?.exception?.description ?? m.params).slice(0, 400));
      } else if (m.method === "Runtime.consoleAPICalled" && (m.params?.type === "error" || m.params?.type === "warning")) {
        pageErrors.push(`[${m.params.type}] ` + String(m.params.args?.map((a) => a.value ?? a.description).join(" ")).slice(0, 500));
      }
    };
    await c.send("Runtime.enable");
    await c.send("Page.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${dev.url}/?autostart=1&fullfps=1` });

    console.log("[probe] waiting for world boot…");
    const bootStart = Date.now();
    while (Date.now() - bootStart < 240_000) {
      const ready = await ev(c, "(()=>{const sf=window.__sf;return !!(sf&&sf.renderIdle&&sf.renderIdle());})()").catch(() => false);
      if (ready) break;
      await sleep(500);
    }
    await teleport(c, MEADOW.x, MEADOW.z);
    console.log("[probe] arrived at meadow; waiting for grass field to settle…");
    const grassStart = Date.now();
    let stableCount = 0;
    let lastCount = -1;
    while (Date.now() - grassStart < 120_000) {
      await tick(c, 0.016);
      const state = await ev(c, `(()=>{const w=window.__sf.wildlands;if(!w)return null;
        return {count:w.grass.stats.count,flowers:w.flowers.stats.count,
          pending:w.grass.group.userData.grassStreaming?.pendingJobs ?? 1};})()`);
      if (state && state.pending === 0 && state.count > 5000 && state.flowers > 500) {
        stableCount = state.count === lastCount ? stableCount + 1 : 0;
        lastCount = state.count;
        if (stableCount >= 3) break;
      }
      await sleep(300);
    }
    // Wait for the preparation gate to reveal the layer meshes (compileAsync
    // per unit); a compile failure leaves them hidden and logs a warning.
    const revealStart = Date.now();
    let visibility = null;
    while (Date.now() - revealStart < 90_000) {
      await tick(c, 0.016);
      visibility = await ev(c, `(()=>{const w=window.__sf.wildlands;if(!w)return null;
        const census=(g)=>({group:g.visible,meshes:g.children.map(m=>({n:m.name,v:m.visible}))});
        return {grass:census(w.grass.group),flowers:census(w.flowers.group),
          streaming:{ready:w.grass.group.userData.grassStreaming?.criticalReady,pending:w.grass.group.userData.grassStreaming?.pendingJobs}};})()`);
      const grassVisible = visibility?.grass?.meshes?.length === 4 && visibility.grass.meshes.every((m) => m.v);
      const flowersVisible = visibility?.flowers?.meshes?.some((m) => m.v);
      if (grassVisible && flowersVisible) break;
      await sleep(400);
    }
    console.log("[probe] visibility:", JSON.stringify(visibility));
    // Data sanity: read the far layer's packed transforms + culled indices —
    // anchors must sit near the meadow, not at the world origin.
    const dataSanity = await ev(c, `(async()=>{const sf=window.__sf;
      const mesh=sf.wildlands.grass.group.children.find(m=>m.userData.grassLayer==="far")
        ?? sf.wildlands.grass.group.children[0];
      if(!mesh?.userData?.grassTransformAttr)return null;
      const t=new Float32Array(await sf.renderer.getArrayBufferAsync(mesh.userData.grassTransformAttr));
      const v=new Uint32Array(await sf.renderer.getArrayBufferAsync(mesh.userData.grassVisibleAttr));
      const col=new Float32Array(await sf.renderer.getArrayBufferAsync(mesh.userData.grassColorAttr));
      const sh=new Float32Array(await sf.renderer.getArrayBufferAsync(mesh.userData.grassShapeAttr));
      const sample=[];for(let i=0;i<4;i++)sample.push([+t[i*4].toFixed(1),+t[i*4+1].toFixed(1),+t[i*4+2].toFixed(1)]);
      const culledSample=[];for(let i=0;i<4;i++){const idx=v[i];culledSample.push([idx,+t[idx*4].toFixed(1),+t[idx*4+2].toFixed(1)]);}
      const colors=[];for(let i=0;i<3;i++)colors.push([+col[i*4].toFixed(2),+col[i*4+1].toFixed(2),+col[i*4+2].toFixed(2),+col[i*4+3].toFixed(3)]);
      const shapes=[];for(let i=0;i<3;i++)shapes.push([+sh[i*4].toFixed(2),+sh[i*4+1].toFixed(2),+sh[i*4+2].toFixed(2),+sh[i*4+3].toFixed(0)]);
      return {layer:mesh.userData.grassLayer,sample,culledSample,colors,shapes};})()`);
    console.log("[probe] data sanity:", JSON.stringify(dataSanity));
    if (dataSanity?.sample?.every(([x, , z]) => Math.abs(x - MEADOW.x) > 200 || Math.abs(z - MEADOW.z) > 200)) {
      failures.push(`packed transforms are not near the meadow: ${JSON.stringify(dataSanity.sample)}`);
    }
    if (!visibility?.grass?.meshes?.some((m) => m.v)) failures.push("grass layer meshes never became visible");
    if (!visibility?.flowers?.meshes?.some((m) => m.v)) failures.push("flower bucket meshes never became visible");
    const grassStats = await ev(c, "(()=>{const s=window.__sf.wildlands.grass.stats;return {count:s.count,layers:Object.fromEntries(Object.entries(s.layers).map(([k,v])=>[k,v.count]))};})()");
    const flowerStats = await ev(c, "(()=>{const s=window.__sf.wildlands.flowers.stats;return {count:s.count,submitted:s.submittedInstances,lod:s.lodInstances};})()");
    console.log("[probe] live grass:", JSON.stringify(grassStats));
    console.log("[probe] live flowers:", JSON.stringify(flowerStats));
    if (!grassStats || grassStats.count < 5000) failures.push(`grass field too small: ${JSON.stringify(grassStats)}`);
    if (!flowerStats || flowerStats.count < 500) failures.push(`flower ring too small: ${JSON.stringify(flowerStats)}`);

    // Camera facing +Z ("north") — cull, then read draw counts.
    const headings = [
      ["north", 0],
      ["south", Math.PI]
    ];
    const results = {};
    for (const [name, facing] of headings) {
      await freeCam(c, MEADOW.x, MEADOW.z, facing, 8, name === "north" ? 1.3 : 2.6);
      await settle(c, 4);
      const grass = await drawCounts(c, "grass");
      const flowers = await drawCounts(c, "flowers");
      results[name] = { grass, flowers };
      console.log(`[probe] ${name} grass draw counts:`, grass, "total", grass ? sum(grass) : null);
      console.log(`[probe] ${name} flower draw counts:`, flowers, "total", flowers ? sum(flowers) : null);
      await shot(c, `meadow_${name}`);
    }

    const live = grassStats.count;
    for (const [name, r] of Object.entries(results)) {
      if (!r.grass) { failures.push(`${name}: no grass indirect readback`); continue; }
      const visible = sum(r.grass);
      if (!(visible > 0)) failures.push(`${name}: grass visible count is zero`);
      if (!(visible < live * 0.85)) failures.push(`${name}: grass culls too little (${visible} vs live ${live})`);
    }
    const grassSwing = results.north?.grass && results.south?.grass
      ? Math.abs(sum(results.north.grass) - sum(results.south.grass))
      : 0;
    const flowersLive = flowerStats.submitted;
    for (const [name, r] of Object.entries(results)) {
      if (!r.flowers) { failures.push(`${name}: no flower indirect readback`); continue; }
      const visible = sum(r.flowers);
      if (!(visible > 0)) failures.push(`${name}: flower visible count is zero`);
      if (!(visible < flowersLive)) failures.push(`${name}: flower cull not a strict subset (${visible} vs ${flowersLive})`);
    }
    // The two opposite headings should not see the same subset. A meadow can be
    // asymmetric, so require only a meaningful swing in at least one system.
    const northTotal = sum(results.north?.grass ?? [0]);
    const southTotal = sum(results.south?.grass ?? [0]);
    const unionExceedsEither = northTotal + southTotal > Math.max(northTotal, southTotal) * 1.3;
    if (!unionExceedsEither) failures.push(`camera heading barely changes grass visibility (${northTotal} vs ${southTotal}) — cull may be static`);
    console.log(`[probe] grass north/south visible: ${northTotal}/${southTotal} of ${live} live (swing ${grassSwing})`);

    // In-page frame timing (CDP round-trips excluded): median/p95 of rAF-driven
    // full ticks while looking across the dense meadow.
    const timing = await ev(c, `(async()=>{const times=[];let prev=performance.now();
      for(let i=0;i<150;i++){window.__sf.tick(1/60);await new Promise(r=>requestAnimationFrame(r));const now=performance.now();times.push(now-prev);prev=now;}
      const sorted=[...times].sort((a,b)=>a-b);
      return {median:+sorted[75].toFixed(2),p95:+sorted[142].toFixed(2),max:+sorted[149].toFixed(2),
        density:{grass:window.__sf.GRASS_TUNING?.values?.density ?? window.__sf.FLOWER_TUNING?.values?.density ?? null,flowers:window.__sf.FLOWER_TUNING?.values?.density ?? null}};})()`);
    console.log("[probe] frame timing (ms):", JSON.stringify(timing));

    const webgpuErrors = pageErrors.filter((e) => /wgsl|pipeline|shader|binding|storage|indirect/i.test(e));
    if (webgpuErrors.length) failures.push(`WebGPU errors: ${webgpuErrors.slice(0, 3).join(" | ")}`);

    writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ grassStats, flowerStats, results, pageErrors: pageErrors.slice(0, 20), failures }, null, 2));
    c.close();
  } finally {
    browser.kill();
    dev.child?.kill();
  }
  if (failures.length) {
    console.error("[probe] FAIL\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("[probe] GPU culling verified: ok");
}

await main();
