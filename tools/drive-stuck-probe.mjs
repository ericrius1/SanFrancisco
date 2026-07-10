// Drive-stuck probe: reproduces / verifies the "car wedges on invisible obstacle"
// regression from the citygen collider-swap gap (suppress baked collider now,
// exact walls queued frames later → nothing solid, then walls spawn AROUND the car).
//
// Boots the real app headless (WebGPU/metal, own fresh Vite on :5198), teleports
// to each leg anchor in DRIVE mode, holds KeyW, and samples the player every
// 0.5 s. STUCK EVENT = moved < 1.2 m over 2.5 s while W is held in drive mode.
// On each event it logs position + citygenRing stats + the streaming state of
// every citygen entry within 25 m (state / live body count / pendingBuild /
// whether the player is INSIDE the footprint AABB — inside = wedged in walls,
// the regression's smoking gun), then auto-unsticks (teleport 15 m ahead along
// the current facing) and keeps driving. Anchors rotate every ~18 s for coverage.
//
//   node tools/drive-stuck-probe.mjs
// Env: SF_PROBE_URL (default http://127.0.0.1:5198), CHROME_BIN,
//      SF_LEG_SECONDS (default 60 castro / 45 others via per-leg override)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/drive-stuck-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5198";
const W = 1600, H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Facing → forward on the ground plane is (-sin f, -cos f) (matches hitch-probe
// anchors: Marina facing -1.6 drives east). +z is SOUTH in world coords.
//
// CASTRO coords: "The Castro" minimap place = (199, 3197) (src/ui/minimap.ts:248,
// Victorian/Edwardian rowhouses — the dense citygen victorian fabric). Anchors
// below are MIDPOINTS OF REAL ROAD SEGMENTS from public/data/roads.json (0.1 m
// int coords ÷10, w ≥ 7 m, len ≥ 60 m, nearest to the label point), with facing
// solved from each segment's direction — so the car spawns ON a street, nose
// down the lane, not inside a rowhouse lot.
const LEGS = [
  {
    name: "castro", seconds: Number(process.env.SF_LEG_SECONDS ?? 60),
    anchors: [
      { x: 206, z: 3194, facing: 1.58 },   // Castro St core, downhill leg
      { x: 231, z: 3083, facing: 1.65 },   // long 209 m block north of core
      { x: 169, z: 3266, facing: 1.65 },
      { x: 216, z: 3312, facing: -3.08 },  // cross street, drive the grid
      { x: 341, z: 3143, facing: -3.07 },
      { x: 93, z: 3272, facing: 1.65 },
    ],
  },
  {
    name: "downtown-grid", seconds: Number(process.env.SF_LEG_SECONDS ?? 45),
    anchors: [
      { x: 4117, z: 200, facing: Math.PI },  // FiDi (hitch-probe leg 2)
      { x: 3400, z: 700, facing: 2.2 },
      { x: 2600, z: 1200, facing: -2.6 },
      { x: 1800, z: 1800, facing: 0.4 },
    ],
  },
  {
    name: "marina", seconds: Number(process.env.SF_LEG_SECONDS ?? 45),
    anchors: [
      { x: -700, z: -2380, facing: -1.6 },   // Marina Green, east along waterfront
      { x: -400, z: -2250, facing: Math.PI },
      { x: -900, z: -2300, facing: 1.6 },
    ],
  },
];

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
async function startDevIfNeeded() {
  try { await waitHttp(SERVER_URL, 2000, "existing vite"); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"],
  });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

// Classify what physically blocks the car, from one __stuckInfo snapshot.
// "In reach" = box edge within CONTACT m of the car centre, spanning the car's
// height, not clearly behind it. Carpet blocks differently: a slab whose top
// pokes above the street (delta > 0) is a wall; a big top-y step between
// adjacent same-kind slabs is a kerb.
const CONTACT = 2.4; // car half-length ~2.2m + slack; baked boxes overshoot ~2m on top of this
function classify(info) {
  const inReach = (b) => b.edge <= CONTACT && b.spansY && b.ahead > -1.5;
  const wall = (info.cgWalls || []).find(inReach);
  const interior = (info.cgInteriors || []).find(inReach);
  if (wall || interior) {
    const b = wall ?? interior;
    return { verdict: "citygen-wall", detail: `citygen ${wall ? "wall" : "interior"} edge ${b.edge}m ahead ${b.ahead}m size(${b.hx}x${b.hy}x${b.hz}) spansY=${b.spansY}; slope ${info.slopePct}%` };
  }
  const baked = (info.buildings || []).find(inReach);
  if (baked) {
    return { verdict: "baked-obb", detail: `baked ${baked.index ? "INDEX" : "tile"} OBB edge ${baked.edge}m ahead ${baked.ahead}m centre(${baked.x},${baked.z}) size(${baked.hx}x${baked.hy}x${baked.hz}) yaw ${baked.yaw}; slope ${info.slopePct}%` };
  }
  const poking = (info.carpet || []).filter((s) => s.delta > 0.2 && s.ahead > -1);
  if (poking.length) {
    const worst = poking.reduce((a, b) => (b.delta > a.delta ? b : a));
    return { verdict: "carpet-misplaced", detail: `${poking.length} slab(s) poke above street; worst ${worst.kind}(${worst.x},${worst.z}) top ${worst.top} = ground+${worst.delta}m, ahead ${worst.ahead}m; slope ${info.slopePct}%` };
  }
  // ground-source mismatch (verified live via SF_PROBE_INSPECT): the carpet
  // floor rides effectiveGround/groundTop (draped ROAD ribbon) while the car
  // spring targets raw map.groundHeight — where the road drape stands proud,
  // the spring seats the car into the climbing slabs and the solver eats all
  // forward speed. The slabs are "misplaced" relative to the car's ground.
  if ((info.ghDelta ?? 0) > 0.35) {
    return { verdict: "carpet-misplaced", detail: `carpet floor rides groundTop while spring targets raw groundHeight: effectiveGround-groundHeight = ${info.ghDelta}m at car; carAboveGround(eg) ${info.carAboveGround}m vs rideHeight 0.85; slope ${info.slopePct}%; slab-vs-eg deltas all ≤ ${Math.max(-9, ...(info.carpet || []).map((s) => s.delta))}m (carpet itself seated correctly on the rendered road)` };
  }
  if ((info.maxStep ?? 0) > 0.35) {
    return { verdict: "carpet-step", detail: `adjacent-slab top step ${info.maxStep}m between ${info.stepPair?.join(" and ")}; slope ${info.slopePct}%` };
  }
  const nb = (info.buildings || [])[0], nw = (info.cgWalls || [])[0];
  const clear = `nearest baked edge ${nb ? nb.edge + "m" : ">12m"}, nearest cg wall ${nw ? nw.edge + "m" : ">12m"}, carpet maxStep ${info.maxStep}m, worst carpet delta ${Math.max(-9, ...(info.carpet || []).map((s) => s.delta))}m`;
  if (Math.abs(info.slopePct) >= 15) {
    return { verdict: "slope-no-blocker", detail: `slope ${info.slopePct}% with nothing in reach (${clear}); speed ${info.speed}, vel.y ${info.vel?.[1]}, rays ${info.rays?.map((r) => (r.kind ? `${r.kind}@${r.d}` : "miss")).join("/")}` };
  }
  return { verdict: "unknown", detail: `slope only ${info.slopePct}% and nothing in reach (${clear}); rays ${info.rays?.map((r) => (r.kind ? `${r.kind}@${r.d}` : "miss")).join("/")}` };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, `chrome-${process.pid}`)}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps&profile`,
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
  const pageErrors = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const txt = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      pageErrors.push(txt); console.log("[page-exception]", String(txt).slice(0, 300));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
      pageErrors.push(txt); console.log("[page-error]", txt);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for app boot...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device&&window.__sf.sky)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("app never ready");
  const tDef = Date.now();
  while (Date.now() - tDef < 60000) {
    if (await ev(c, `!!(window.__sf.citygenRing && window.__sf.citygenRing.current)`)) break;
    await sleep(1000);
  }
  if (!(await ev(c, `!!(window.__sf.citygenRing&&window.__sf.citygenRing.current)`))) throw new Error("citygen ring never ready");
  console.log(`[probe] app + citygen ring ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // self-healing install: the dev page can reload under headless (HMR/relay
  // reconnect gotcha) which wipes window.__* — re-evaluated before every use.
  const INSTALL = `(()=>{
    if (window.__key && window.__sf) return true;
    if (!window.__sf || !window.__sf.citygenRing || !window.__sf.citygenRing.current) return false;
    const sf = window.__sf;
    window.__key = (code, down) => window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code,bubbles:true}));
    window.__tp = (x, z, facing) => {
      const gy = sf.map.groundHeight(x, z);
      sf.player.teleportTo({ x, y: gy + 1.2, z, facing, mode: 'drive' });
      if (sf.chase) sf.chase.yaw = facing + Math.PI;
      return true;
    };
    window.__sample = () => {
      const p = sf.player.position;
      return { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), mode: sf.player.mode, heading: sf.player.heading };
    };
    window.__stuckInfo = () => {
      const p = sf.player.position;
      const ring = sf.citygenRing.current;
      const f = sf.player.heading - Math.PI;            // facing yaw
      const fx = -Math.sin(f), fz = -Math.cos(f);       // unit forward on ground
      const eg = (x, z) => sf.map.effectiveGround(x, z);
      const r1 = (v) => +v.toFixed(1), r2 = (v) => +v.toFixed(2);
      // XZ metrics vs an oriented box: edge distance (0 = overlapping in XZ),
      // forward projection of its centre, whether it spans the car's height.
      // Convention matches buildingBodies.ts (cosYaw=cos(yaw), sinYaw=sin(yaw)).
      const obb = (b) => {
        const dx = b.x - p.x, dz = b.z - p.z;
        const cos = Math.cos(b.yaw || 0), sin = Math.sin(b.yaw || 0);
        const ex = Math.max(0, Math.abs(dx * cos - dz * sin) - b.hx);
        const ez = Math.max(0, Math.abs(dx * sin + dz * cos) - b.hz);
        return { d: r1(Math.hypot(dx, dz)), edge: r2(Math.hypot(ex, ez)),
          ahead: r1(dx * fx + dz * fz),
          spansY: p.y > b.y - b.hy - 0.5 && p.y < b.y + b.hy + 1.0 };
      };
      // 1) baked-tile building OBB bodies (stepped world) within 12 m
      const bb = []; sf.physics.debugBuildingBodies(bb);
      const buildings = [];
      for (const b of bb) {
        const m = obb(b);
        if (m.d > 12) continue;
        buildings.push({ ...m, x: r1(b.x), y: r1(b.y), z: r1(b.z),
          hx: r1(b.hx), hy: r1(b.hy), hz: r1(b.hz), yaw: r2(b.yaw), index: b.index });
      }
      buildings.sort((a, b) => a.edge - b.edge);
      // 2) citygen exact-poly walls + interiors within 12 m
      const w = [], it = [];
      ring.debugColliders(w, it);
      const cgPick = (list) => {
        const out = [];
        for (const b of list) {
          const m = obb(b);
          if (m.d > 12) continue;
          out.push({ ...m, x: r1(b.x), y: r1(b.y), z: r1(b.z), hx: r2(b.hx), hy: r2(b.hy), hz: r2(b.hz) });
        }
        out.sort((a, b) => a.edge - b.edge);
        return out.slice(0, 12);
      };
      const cgWalls = cgPick(w), cgInteriors = cgPick(it);
      // 3) carpet slabs within 6 m: top-vs-ground delta (≈ -sink normally; > 0 =
      // slab pokes ABOVE the street = misplaced wall) + max top-y step between
      // adjacent same-kind slabs under/ahead of the car (a kerb the bumper hits)
      const slabs = []; sf.physics.debugCarpet(slabs, p.x, p.z, 6);
      // top-face plane of a tilted slab: normal = quat-rotated +Y, plane through
      // centre + normal*hy. yTop(X,Z) evaluates the physical surface the solver
      // sees — comparing THESE at a shared point measures a real discontinuity,
      // not the natural top-height difference of two slabs sitting on a grade.
      const slabTopAt = (s, X, Z) => {
        const [qx, qy, qz, qw] = s.quat;
        const nx = 2 * (qx * qy - qw * qz), ny = 1 - 2 * (qx * qx + qz * qz), nz = 2 * (qy * qz + qw * qx);
        const tx = s.x + nx * s.hy, ty = s.y + ny * s.hy, tz = s.z + nz * s.hy;
        return ty - (nx * (X - tx) + nz * (Z - tz)) / ny;
      };
      const carpet = slabs.map((s) => {
        const dx = s.x - p.x, dz = s.z - p.z;
        return { kind: s.kind, x: r1(s.x), y: r2(s.y), z: r1(s.z), hx: r2(s.hx),
          top: r2(s.y + s.hy),
          delta: r2(slabTopAt(s, s.x, s.z) - eg(s.x, s.z)),
          d: r1(Math.hypot(dx, dz)), ahead: r1(dx * fx + dz * fz) };
      });
      let maxStep = 0, stepPair = null;
      for (let i = 0; i < slabs.length; i++) for (let j = i + 1; j < slabs.length; j++) {
        const a = slabs[i], b = slabs[j];
        if (a.kind !== b.kind) continue;                // sub slabs LAYER over cells — not a step
        const aAhead = (a.x - p.x) * fx + (a.z - p.z) * fz, bAhead = (b.x - p.x) * fx + (b.z - p.z) * fz;
        if (aAhead < -2 && bAhead < -2) continue;       // both behind the car
        if (Math.hypot(a.x - b.x, a.z - b.z) > a.hx + b.hx + 1.5) continue; // not adjacent
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;      // shared-boundary midpoint
        const step = Math.abs(slabTopAt(a, mx, mz) - slabTopAt(b, mx, mz));
        if (step > maxStep) { maxStep = step; stepPair = [a.kind + "(" + r1(a.x) + "," + r1(a.z) + ")", b.kind + "(" + r1(b.x) + "," + r1(b.z) + ")"]; }
      }
      // 4) ground slope along facing (2 m sample)
      const g0 = eg(p.x, p.z);
      const slopePct = r1((eg(p.x + fx * 2, p.z + fz * 2) - g0) / 2 * 100);
      // 5) car state + 3 forward raycasts (NOTE: the query world mirrors citygen
      // walls + visual-tile building solids but NOT carpet slabs and NOT
      // index-only stepped baked bodies — an all-miss does not clear those)
      const v = sf.player.velocity;
      const rays = [];
      for (const up of [0.4, 0.9, 1.4]) {
        const o = new sf.THREE.Vector3(p.x, p.y + up, p.z);
        const dir = new sf.THREE.Vector3(fx, 0, fz);
        const h = sf.worldQueries.raycast(o, dir, 6, { ignoreSelf: true });
        rays.push(h ? { up, kind: h.kind, d: r2(h.distance) } : { up, kind: null });
      }
      // the car controller's ground source (raw heightfield) vs the surface the
      // carpet actually sits on (groundTop: terrain + draped lawns AND ROADS).
      // A big positive ghDelta = the physical floor stands proud of the spring
      // target → the spring seats the car INTO the road slabs.
      const gh = sf.map.groundHeight(p.x, p.z);
      return {
        pos: [r1(p.x), r1(p.y), r1(p.z)], carAboveGround: r2(p.y - g0),
        gh: r2(gh), ghDelta: r2(g0 - gh),
        speed: r2(sf.player.speed), vel: [r2(v.x), r2(v.y), r2(v.z)],
        heading: r2(sf.player.heading), facing: r2(f), slopePct,
        buildings, cgWalls, cgInteriors, carpet, maxStep: r2(maxStep), stepPair, rays,
        stats: ring.stats(), near: ring.debugEntriesNear ? ring.debugEntriesNear(p.x, p.z, 25) : "n/a",
      };
    };
    // Deep single-spot diagnostic: profiles the STEPPED world (the surface the
    // contact solver actually sees — carpet slabs, citygen bodies, baked OBBs)
    // via physics.world.castRayClosest, next to the visual street height, and
    // recomputes the car controller's spring request from the same inputs.
    window.__inspect = () => {
      const p = sf.player.position;
      const f = sf.player.heading - Math.PI;
      const fx = -Math.sin(f), fz = -Math.cos(f);
      const v = sf.player.velocity;
      const spec = sf.player.driveSpec;
      const world = sf.physics.world;
      const hit = { handle: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, distance: 0 };
      const r2 = (x) => +x.toFixed(2);
      const gh = sf.map.groundHeight(p.x, p.z), eg = sf.map.effectiveGround(p.x, p.z);
      const nose = spec.halfExtents[2] + 0.6;
      const aheadG = sf.map.groundHeight(p.x + fx * nose, p.z + fz * nose);
      const rideY = Math.max(gh, aheadG) + spec.rideHeight;
      // down-cast profile along facing (s metres ahead of centre), stepped world
      const prof = [];
      for (let s = -3; s <= 8.01; s += 0.5) {
        const ox = p.x + fx * s, oz = p.z + fz * s;
        const h = world.castRayClosest(ox, p.y + 4, oz, 0, -1, 0, 15, undefined, hit);
        prof.push({ s: +s.toFixed(1),
          surf: h ? r2(p.y + 4 - h.distance) : null,
          own: !!h && h.handle === sf.player.body,
          eg: r2(sf.map.effectiveGround(ox, oz)),
          ny: h ? r2(h.ny) : null });
      }
      // forward casts in the stepped world from just past the front bumper
      const bottom = p.y - spec.halfExtents[1];
      const rays = [];
      for (const dy of [0.05, 0.3, 0.6, 1.0]) {
        const ox = p.x + fx * (nose + 0.05), oz = p.z + fz * (nose + 0.05);
        const h = world.castRayClosest(ox, bottom + dy, oz, fx, 0, fz, 6, undefined, hit);
        rays.push(h ? { dy, d: r2(h.distance), n: [r2(h.nx), r2(h.ny), r2(h.nz)] } : { dy, d: null });
      }
      return { pos: [r2(p.x), r2(p.y), r2(p.z)], vel: [r2(v.x), r2(v.y), r2(v.z)],
        fwdSpeed: r2(v.x * fx + v.z * fz), gh: r2(gh), eg: r2(eg),
        aboveGh: r2(p.y - gh), rideY: r2(rideY), springVy: r2((rideY - p.y) * 10),
        rays, prof };
    };
    window.__unstick = () => {
      const p = sf.player.position;
      const ring = sf.citygenRing.current;
      const f0 = sf.player.heading - Math.PI;          // current facing
      // candidate hops 15 m out at fanned headings; take the first whose landing
      // spot is not inside any citygen footprint AABB (else last resort: straight)
      for (const df of [0, 0.5, -0.5, 1.0, -1.0, Math.PI]) {
        const f = f0 + df;
        const nx = p.x - 15 * Math.sin(f), nz = p.z - 15 * Math.cos(f);
        const near = ring.debugEntriesNear ? ring.debugEntriesNear(nx, nz, 12) : [];
        if (!near.some((n) => n.insideBB)) return window.__tp(nx, nz, f);
      }
      return window.__tp(p.x - 15 * Math.sin(f0), p.z - 15 * Math.cos(f0), f0);
    };
    return true;
  })()`;
  const ensure = async () => { for (let i = 0; i < 30; i++) { if (await ev(c, INSTALL)) return; await sleep(1000); } throw new Error("helpers never installed (page not ready)"); };
  await ensure();

  // SF_PROBE_INSPECT="x,z,facing": skip the legs — teleport to one known stuck
  // spot, hold W, and dump the stepped-world surface profile + controller spring
  // request every 0.5 s so the exact blocking geometry (or its absence) is read
  // straight off the collision world.
  if (process.env.SF_PROBE_INSPECT) {
    const [ix, iz, ifc] = process.env.SF_PROBE_INSPECT.split(",").map(Number);
    console.log(`[inspect] tp (${ix}, ${iz}) facing ${ifc}, holding W`);
    await ev(c, `window.__tp(${ix}, ${iz}, ${ifc})`);
    await sleep(3500);
    await ensure(); // page can reload during the settle sleep (HMR gotcha)
    await ev(c, `window.__tp(${ix}, ${iz}, ${ifc})`);
    await sleep(1200);
    await ensure();
    await ev(c, `window.__key('KeyW', true) ?? true`);
    for (let k = 0; k < 24; k++) {
      await sleep(500);
      await ensure();
      await ev(c, `window.__key('KeyW', true) ?? true`);
      const i = await ev(c, `window.__inspect()`);
      console.log(`[t=${(k * 0.5 + 0.5).toFixed(1)}s] pos(${i.pos.join(",")}) fwdSpd=${i.fwdSpeed} vel=[${i.vel.join(",")}] aboveGh=${i.aboveGh} gh=${i.gh} eg=${i.eg} rideY=${i.rideY} springVy=${i.springVy}`);
      console.log(`         noseRays: ${i.rays.map((r) => r.d == null ? `+${r.dy}:miss` : `+${r.dy}:${r.d}m n(${r.n.join(",")})`).join("  ")}`);
      if (k % 4 === 3) {
        console.log(`         profile (s: stepped-surf vs eg, Δ=surf-eg):`);
        console.log(`         ${i.prof.map((r) => `${r.s}:${r.surf == null ? "none" : (r.own ? "CAR" : (r.surf - r.eg).toFixed(2))}`).join(" ")}`);
      }
    }
    await ev(c, `window.__key('KeyW', false) ?? true`);
    try {
      const shot = await c.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(OUT, "inspect.png"), Buffer.from(shot.data, "base64"));
    } catch {}
    c.close(); proc.kill(); if (dev) dev.kill();
    process.exit(0);
  }

  const allEvents = [];
  for (const leg of LEGS) {
    console.log(`\n[leg] ${leg.name} (${leg.seconds}s, ${leg.anchors.length} anchors)`);
    let anchorIdx = 0;
    const goAnchor = async () => {
      const a = leg.anchors[anchorIdx % leg.anchors.length];
      await ev(c, `window.__tp(${a.x}, ${a.z}, ${a.facing})`);
      anchorIdx++;
    };
    await goAnchor();
    await sleep(3500); // let streaming settle
    await ev(c, `window.__key('KeyW', true) ?? true`);

    const events = [];
    const buf = []; // {t, x, z}
    const legEnd = Date.now() + leg.seconds * 1000;
    let nextAnchorAt = Date.now() + 18000;
    let cooldownUntil = 0;
    let lastStuck = null; // hop anchor when re-stuck near the same spot
    while (Date.now() < legEnd) {
      await sleep(500);
      await ensure();
      await ev(c, `window.__key('KeyW', true) ?? true`); // re-assert
      const s = await ev(c, `window.__sample()`);
      const now = Date.now();
      buf.push({ t: now, x: s.x, z: s.z });
      while (buf.length && buf[0].t < now - 2600) buf.shift();
      const old = buf[0];
      const moved = Math.hypot(s.x - old.x, s.z - old.z);
      if (s.mode === "drive" && now > cooldownUntil && now - old.t >= 2400 && moved < 1.2) {
        const info = await ev(c, `window.__stuckInfo()`);
        const inside = Array.isArray(info.near) && info.near.some((n) => n.insideBB);
        const cls = classify(info);
        console.log(`  [STUCK #${events.length + 1}] (${s.x}, ${s.y}, ${s.z}) moved ${moved.toFixed(2)}m/2.5s slope=${info.slopePct}% speed=${info.speed} → ${cls.verdict}`);
        console.log(`          ${cls.detail}`);
        const b0 = info.buildings[0], w0 = info.cgWalls[0], i0 = info.cgInteriors[0];
        console.log(`          nearest: baked=${b0 ? `edge${b0.edge}m ahead${b0.ahead} ${b0.index ? "idx" : "tile"}` : "none<12m"}  cgWall=${w0 ? `edge${w0.edge}m ahead${w0.ahead}` : "none<12m"}  cgInt=${i0 ? `edge${i0.edge}m` : "none<12m"}  carpet=${info.carpet.length} slabs maxStep=${info.maxStep}m  rays=${info.rays.map((r) => r.kind ? `${r.up}:${r.kind}@${r.d}` : `${r.up}:miss`).join(" ")}`);
        if (events.length < 3) {
          try {
            const shot = await c.send("Page.captureScreenshot", { format: "png" });
            const file = path.join(OUT, `classify-${events.length + 1}.png`);
            writeFileSync(file, Buffer.from(shot.data, "base64"));
            console.log(`          screenshot: ${file}`);
          } catch (err) { console.log(`          screenshot failed: ${err.message}`); }
        }
        events.push({ leg: leg.name, pos: [s.x, s.y, s.z], moved, inside, verdict: cls.verdict, detail: cls.detail, info });
        if (lastStuck && Math.hypot(s.x - lastStuck[0], s.z - lastStuck[1]) < 12) {
          await goAnchor(); // unstick didn't take — move on to the next street
        } else {
          await ev(c, `window.__unstick()`);
        }
        lastStuck = [s.x, s.z];
        buf.length = 0;
        cooldownUntil = Date.now() + 4000; // let the teleport + streaming settle
      }
      if (now > nextAnchorAt) { // rotate anchors for street coverage
        await goAnchor();
        buf.length = 0;
        nextAnchorAt = now + 18000;
        cooldownUntil = Date.now() + 4000;
      }
    }
    await ev(c, `window.__key('KeyW', false) ?? true`);
    console.log(`[leg] ${leg.name}: ${events.length} stuck events (${events.filter((e) => e.inside).length} inside-footprint)`);
    allEvents.push({ leg: leg.name, count: events.length, insideCount: events.filter((e) => e.inside).length, events });
  }

  writeFileSync(path.join(OUT, "stuck-report.json"), JSON.stringify({ when: new Date().toISOString(), legs: allEvents, pageErrors: pageErrors.slice(-50) }, null, 2));
  console.log("\n================= STUCK SUMMARY =================");
  for (const l of allEvents) {
    console.log(`${l.leg}: ${l.count} stuck events (${l.insideCount} inside a citygen footprint)`);
    const tally = {};
    for (const e of l.events) tally[e.verdict] = (tally[e.verdict] ?? 0) + 1;
    console.log(`  verdicts: ${JSON.stringify(tally)}`);
    for (const e of l.events) console.log(`  (${e.pos.join(", ")}) slope=${e.info.slopePct}% → ${e.verdict}`);
  }
  console.log(`page errors: ${pageErrors.length ? pageErrors.length : "none"}`);
  console.log(`[probe] wrote ${path.join(OUT, "stuck-report.json")}`);

  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
