// Targeted gate verification against the warm iso vite (5209): boots a chrome,
// checks garden group + horse herd visibility at downtown (far) and meadow (near).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
const SERVER = "http://127.0.0.1:5209";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) return; const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }); }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); }
  close() { this.#ws.close(); }
}
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; }
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = await freePort();
const proc = spawn(CHROME, [`--user-data-dir=/tmp/gate-verify-chrome`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--use-angle=metal", "--mute-audio", "--window-size=1280,800", `${SERVER}/?autostart&fullfps`], { stdio: "ignore" });
await sleep(2500);
let page;
for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
const c = new Cdp(page.webSocketDebuggerUrl); await c.open(); await c.send("Runtime.enable");
const t0 = Date.now(); let ready = false;
while (Date.now() - t0 < 120000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {} await sleep(600); }
if (!ready) { console.log("NOT READY"); proc.kill(); process.exit(1); }
await ev(c, `window.__sfManual&&window.__sfManual(true)`);
async function probe(name, x, z) {
  await ev(c, `(()=>{const sf=window.__sf;const gy=sf.map.groundHeight(${x},${z});sf.player.teleportTo({x:${x},y:gy+1.6,z:${z},facing:0,mode:'walk'});return true;})()`);
  await ev(c, `(async()=>{const sf=window.__sf;const dev=sf.renderer.backend.device;for(let i=0;i<40;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}return true;})()`);
  const r = await ev(c, `(()=>{const sf=window.__sf;let garden=null,horseVis=0,horseTot=0,obsVis=0,obsTot=0;
    sf.scene.traverse(o=>{ if(o.name==='sf_botanical_garden') garden=o.visible; });
    // horses: HorseHerd adds each horse group + obstacle objs directly to scene; find via known child shape.
    // Use the exposed herd if present.
    const h = sf.horses; // may be undefined
    return { garden, hasHorsesApi: !!h };
  })()`);
  // horse group visibility: sample the herd through a scan of scene children that look like horses (have a 'body' child group)
  const hz = await ev(c, `(()=>{const sf=window.__sf;let shown=0,total=0;sf.scene.children.forEach(o=>{ if(o.isGroup && o.userData && o.userData.legs){ total++; if(o.visible) shown++; } });return {shown,total};})()`);
  console.log(`${name.padEnd(9)} (${x},${z}):  garden.visible=${r.garden}   horseGroups shown ${hz.shown}/${hz.total}`);
}
await probe("downtown", 4117, 200);
await probe("meadow", -2260, 2450);
await probe("downtown2", 4117, 200); // re-confirm re-hide after returning
c.close(); proc.kill(); process.exit(0);
