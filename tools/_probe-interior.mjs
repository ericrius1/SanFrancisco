// Interior probe: boots the app on its OWN vite (relay 8795, chrome-int profile),
// teleports into Chinatown, forces generated-building interiors to build, and
// screenshots one of each shop type + an upper apartment + the stairwell. Also
// checks determinism: build → dispose → rebuild the same interior and compare a
// full geometry signature.
//   node tools/_probe-interior.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = "/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/96e2d226-a5bb-4a84-ab31-2af9185c15aa/scratchpad";
const PROFILE = path.join(OUT, "chrome-int");
const RELAY = 8795;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue; return c;
  }
  throw new Error("no chrome");
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer(); s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function waitHttp(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); }
  throw new Error("http timeout " + url);
}
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.#p.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 30000);
      this.#p.set(id, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } });
    });
  }
  close() { this.#ws.close(); }
}
async function evaluate(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}
async function waitEval(c, expr, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await evaluate(c, expr)) return; } catch {} await sleep(300); }
  throw new Error("eval timeout " + expr);
}
async function tick(c) { try { await evaluate(c, "window.__sf.tick(0.016)"); } catch {} }
async function shot(c, name) {
  const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
  const f = path.join(OUT, name);
  writeFileSync(f, Buffer.from(s.data, "base64"));
  console.log("  saved", f);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await rm(PROFILE, { recursive: true, force: true });  // never serve stale cache
  const vitePort = await freePort();
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(RELAY) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(SERVER_URL, 60000);
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${dport}`, `--user-data-dir=${PROFILE}`,
      "--headless=new", "--no-first-run", "--mute-audio",
      "--enable-features=SharedArrayBuffer", "--use-angle=metal",
      "--enable-unsafe-webgpu", "--enable-gpu",
      "--enable-features=WebGPUDeveloperFeatures",
      `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"
    ], { stdio: "ignore" });

    let t = Date.now();
    while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl);
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player)", 120000);
    console.log("[probe] app booted");

    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(13.5);
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics) s.aiCars.postPhysics=()=>{}; } }catch{}
      if(!window.__camFrozen){window.__camFrozen=true; s.chase.update=()=>{};}
      // hide every player embodiment so no avatar enters a shot
      try{ for(const m of Object.values(s.player.meshes)) m.visible=false; }catch{}
      return 1;})()`);

    await waitEval(c, "Boolean(window.__sf.buildings && window.__sf.buildings.current && window.__sf.buildings.current.count>0)", 120000);

    // helpers installed in-page: mulberry32 (matches interiorProps.rng) to derive
    // shop type per seed, local->world transform, teleport+pump+frame.
    await evaluate(c, `window.__ip = (function(){
      const S = window.__sf;
      const SCALE = 3.0;
      function rng(seed){ let a=(seed|0)+0x6d2b79f5; return ()=>{ a|=0; a=(a+0x6d2b79f5)|0; let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }
      function shopType(seed){ return (rng(seed)()*4)|0; }
      function w(bx,bz,yaw,lx,lz){ const c=Math.cos(yaw),s=Math.sin(yaw); return [bx+lx*c+lz*s, bz-lx*s+lz*c]; }
      function ground(x,z){ return +S.map.groundHeight(x,z); }
      async function tickN(n){ for(let i=0;i<n;i++) S.tick(0.016); }
      function pump(px,py,pz){ const p=S.player; p.position.set(px,py,pz); p.renderPosition.set(px,py,pz);
        try{S.physics.world.setBodyTransform(p.body,[px,py,pz],[0,0,0,1]);}catch{} S.buildings.current.update(p.position,0.25); }
      // find the built interior group nearest to (bx,bz)
      function findInterior(bx,bz){ let best=null,bd=1e9; S.scene.traverse(o=>{ if(o.name==='generatedBuilding'&&o.children.length){ const d=Math.hypot(o.position.x-bx,o.position.z-bz); if(d<bd){bd=d;best=o;} } }); return best&&bd<6?best:null; }
      // full geometry signature of an interior (positions+scales+material uuid)
      function signature(outer){ const it=outer.children.find(k=>k.name==='generatedInterior'); if(!it) return null;
        const parts=[]; it.traverse(m=>{ if(m.isMesh){ const p=m.position,sc=m.scale; parts.push(p.x.toFixed(3)+','+p.y.toFixed(3)+','+p.z.toFixed(3)+','+sc.x.toFixed(3)+','+sc.y.toFixed(3)+','+sc.z.toFixed(3)+','+m.material.uuid.slice(0,6)); } });
        return {n:parts.length, sig:parts.join('|')}; }
      return { SCALE, rng, shopType, w, ground, tickN, pump, findInterior, signature };
    })(); 1`);

    const CX = 3300, CZ = -400;

    // build the pool of nearby candidates grouped by shop type
    const cands = await evaluate(c, `(async()=>{
      const ip=window.__ip;
      const data=await (await fetch('/buildinggen/chinatown.json')).json();
      // representative mid-size storefronts (most of the city is width 3-4,
      // length 4-7) so the hero shots aren't cavernous edge cases
      const near=data.buildings
        .map(b=>({...b, d:Math.hypot(b.x-${CX},b.z-(${CZ}))}))
        .filter(b=>b.d<90 && b.width>=3 && b.width<=4 && b.length>=4 && b.length<=7 && b.floors>=5)
        .sort((a,b)=>a.d-b.d);
      const byType={}; for(const b of near){ const t=ip.shopType(b.seed); (byType[t]=byType[t]||[]).push(b); }
      const pickT=t=> (byType[t]&&byType[t][0]) || null;
      const tall = near.filter(b=>b.floors>=8).sort((a,b)=>a.d-b.d)[0] || near[0];
      return { convenience:pickT(0), noodle:pickT(1), electronics:pickT(2), herbalist:pickT(3), tall,
        counts:{0:(byType[0]||[]).length,1:(byType[1]||[]).length,2:(byType[2]||[]).length,3:(byType[3]||[]).length} };
    })()`);
    console.log("[probe] candidate counts by type:", JSON.stringify(cands.counts));

    // warm the ring near center (first build fetches the 20 MB kit)
    const CY = await evaluate(c, `+window.__sf.map.groundHeight(${CX},${CZ}).toFixed(2)`);
    for (let i = 0; i < 45; i++) { await evaluate(c, `window.__ip.pump(${CX}, ${CY}+1.5, ${CZ})`); await tick(c); await sleep(120); }
    console.log("[probe] ring warmed:", JSON.stringify(await evaluate(c, "window.__sf.buildings.current.stats()")));

    // shoot a building of a given type: teleport onto it, pump so its interior
    // builds, frame the camera INSIDE, screenshot. `view`: shop|upper|stair
    async function shoot(b, name, view) {
      if (!b) { console.log("  (no candidate for " + name + ")"); return; }
      const frame = `const ip=window.__ip, b=${JSON.stringify(b)}; const gy=ip.ground(b.x,b.z);
        const ix=b.length*1.5-0.35, iz=b.width*1.5-0.35, roomH=3.0, frontZ=-iz; const C=window.__sf.camera; let cw,lw,cy,ly;
        if('${view}'==='upper'){ cw=ip.w(b.x,b.z,b.yaw,-ix*0.28,frontZ+0.5); lw=ip.w(b.x,b.z,b.yaw,ix*0.15,iz*0.6); cy=gy+roomH+1.6; ly=gy+roomH+1.35; }
        else if('${view}'==='stair'){ cw=ip.w(b.x,b.z,b.yaw,-ix*0.12,-iz*0.05); lw=ip.w(b.x,b.z,b.yaw,ix*0.65,iz*0.7); cy=gy+1.6; ly=gy+2.3; }
        else { cw=ip.w(b.x,b.z,b.yaw,0,frontZ+0.3); lw=ip.w(b.x,b.z,b.yaw,-ix*0.15,iz*0.75); cy=gy+1.75; ly=gy+1.2; }
        C.position.set(cw[0],cy,cw[1]); C.lookAt(lw[0],ly,lw[1]);`;
      const info = await evaluate(c, `(async()=>{
        const _b=${JSON.stringify(b)}, _ip=window.__ip, _gy=_ip.ground(_b.x,_b.z);
        for(let i=0;i<16;i++){ _ip.pump(_b.x, _gy+1.5, _b.z); _ip.tickN(1); }
        const outer=_ip.findInterior(_b.x,_b.z);
        ${frame}
        const sig=outer?_ip.signature(outer):null;
        return { built:!!outer, meshCount: sig?sig.n:0, seed:_b.seed, floors:_b.floors, len:_b.length, wid:_b.width };
      })()`);
      for (let i = 0; i < 8; i++) await tick(c);
      await evaluate(c, `(()=>{ ${frame} return 1; })()`);   // re-apply camera after ticks
      await sleep(300);
      console.log("  " + name + ":", JSON.stringify(info));
      await shot(c, name + ".jpg");
      return info;
    }

    console.log("[probe] shop screenshots:");
    await shoot(cands.convenience, "interior_shop_convenience", "shop");
    await shoot(cands.noodle, "interior_shop_noodle", "shop");
    await shoot(cands.electronics, "interior_shop_electronics", "shop");
    await shoot(cands.herbalist, "interior_shop_herbalist", "shop");
    // pick the primary "interior_shop.jpg" (electronics has the strongest hero)
    await shoot(cands.electronics || cands.convenience, "interior_shop", "shop");
    await shoot(cands.tall, "interior_upper", "upper");
    await shoot(cands.tall, "interior_stair", "stair");

    // ---- determinism: build -> dispose (move far) -> rebuild -> compare ------
    // Driven from Node so async exterior (re)creation resolves between pumps
    // (a single in-page loop would stall the ring's await-based loads).
    const tb = cands.tall;
    if (tb) {
      const gy = await evaluate(c, `window.__ip.ground(${tb.x},${tb.z})`);
      const pumpAt = async (x, z, n) => { for (let i = 0; i < n; i++) { await evaluate(c, `window.__ip.pump(${x},${gy}+1.5,${z})`); await tick(c); await sleep(60); } };
      const sig = async () => evaluate(c, `(()=>{const o=window.__ip.findInterior(${tb.x},${tb.z}); return o?window.__ip.signature(o):null;})()`);
      await pumpAt(tb.x, tb.z, 10);
      const a = await sig();
      await pumpAt(tb.x + 400, tb.z, 24);        // move away → interior disposes
      const gone = !(await sig());
      await pumpAt(tb.x, tb.z, 24);              // return → rebuild
      const c2 = await sig();
      console.log("[probe] DETERMINISM:", JSON.stringify({
        disposed: gone, n1: a && a.n, n2: c2 && c2.n,
        identical: !!(a && c2 && a.sig === c2.sig),
      }));
    }

    c.close();
    console.log("[probe] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
