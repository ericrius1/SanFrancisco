// Scout candidate centres for the Mission Dolores basilica: for each, stream the
// area and report nearby tall building count + terrain range over an 28x84 footprint.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp { #ws; #id = 1; #p = new Map(); constructor(u){this.#ws=new WebSocket(u);} async open(){await new Promise((res,rej)=>{this.#ws.addEventListener("open",res,{once:true});this.#ws.addEventListener("error",rej,{once:true});});this.#ws.addEventListener("message",(e)=>{const m=JSON.parse(e.data.toString());if(m.id){const p=this.#p.get(m.id);if(!p)return;this.#p.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result??{});}});} send(method,params={}){const id=this.#id++;this.#ws.send(JSON.stringify({id,method,params}));return new Promise((res,rej)=>this.#p.set(id,{res,rej}));} close(){this.#ws.close();} }
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, expr, ms){const t=Date.now();while(Date.now()-t<ms){try{if(await ev(c,expr))return;}catch{}await sleep(300);}throw new Error("eval timeout "+expr);}

const CANDIDATES = [
  ["mission-flat", 2100, 3010],
  ["dolores-park-N", 1560, 3235],
  ["dolores-park-E", 1600, 3330],
  ["marina-green", -700, -2380],
  ["marina-green-E", -450, -2360],
  ["crissy-field", -1500, -2760],
  ["gg-park-meadow", -2600, 1150],
  ["ggpark-metson", -3800, 1500],
  ["mission-dolores-real", 1509, 2844],
  ["potrero-flat", 2450, 3050]
];

async function main() {
  const vitePort = await freePort(); const relayPort = await freePort();
  const URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort), SF_HMR: "0" }, stdio: ["ignore","ignore","ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  try {
    await waitHttp(URL, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=/tmp/md-scout-${Date.now()}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", "--window-size=800,600", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Runtime.enable"); await c.send("Page.enable");
    await c.send("Page.navigate", { url: `${URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.citygenRing && window.__sf.map)", 120000);
    await ev(c, `(()=>{const s=window.__sf; s.chase.update=()=>{}; s.player.update=()=>{}; return 1;})()`);
    console.log("name               | ground min/max/range (28x84) | tall bldgs <45m");
    for (const [name, cx, cz] of CANDIDATES) {
      const y = await ev(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundHeight(${cx},${cz})+2; p.position.set(${cx},y,${cz}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${cx},y,${cz}],[0,0,0,1]); return y;})()`);
      for (let i = 0; i < 55; i++) { try { await ev(c, "window.__sf.tick(0.05)"); } catch {} }
      const res = await ev(c, `(()=>{const s=window.__sf; let mn=1e9,mx=-1e9;
        for(let dz=-42;dz<=42;dz+=6) for(let dx=-14;dx<=14;dx+=4){ const g=s.map.baseGroundTop(${cx}+dx,${cz}+dz); if(g<mn)mn=g; if(g>mx)mx=g; }
        let tall=0; try{ const bs=s.citygenRing.current?.debugBuildings?.()||[]; for(const b of bs){ if((b.top-b.base)>4 && Math.hypot((b.cx??b.x)-${cx},(b.cz??b.z)-${cz})<45) tall++; } }catch(e){ tall=-1; }
        return {mn:+mn.toFixed(1),mx:+mx.toFixed(1),tall}; })()`);
      console.log(`${name.padEnd(20)}| ${String(res.mn).padStart(6)} ${String(res.mx).padStart(6)} ${String((res.mx-res.mn).toFixed(1)).padStart(6)}       | ${res.tall}`);
    }
    c.close();
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
