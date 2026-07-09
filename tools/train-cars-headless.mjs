// Overnight headless trainer for the continual-learning AI cars.
//
// Pure Node (no browser / GPU / network) so it survives running for many hours.
// It runs the SAME learner.ts + fleet.ts + roadGraph.ts the game uses, on the
// real SF road graph/colliders/signals with a deterministic Node world, accelerated far past
// real time. Every CHECKPOINT_MS it atomically writes the full 48-car brain set
// to a checkpoint file and logs fleet skill so progress is observable, and it
// resumes from that checkpoint on restart. `push-brains-to-prod.mjs` ships the
// checkpoint to the live relay.
//
// Run: node --experimental-strip-types tools/train-cars-headless.mjs
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as THREE from "three/webgpu";
import { RoadGraph } from "../src/gameplay/aiCars/roadGraph.ts";
import { Fleet, MAX_CARS } from "../src/gameplay/aiCars/fleet.ts";
import { Learner } from "../src/gameplay/aiCars/learner.ts";
import { decodeGroundTopDelta, decodeHeightmapBuffer } from "./terrain-codec.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CKPT = process.env.SF_CKPT || path.join(ROOT, "tools", "aicars-trained-v3.json");
const CHECKPOINT_MS = envNumber("SF_CHECKPOINT_MS", 60_000);
const DT = 1 / 60;
const BATCH = envNumber("SF_BATCH", 320); // sim substeps per event-loop tick (then yield)
const MAX_REAL_MS = envNumber("SF_MAX_REAL_MS", 0);
const FRESH = process.env.SF_FRESH === "1" || process.env.SF_FRESH === "true";
const INIT_ANCHOR = [new THREE.Vector3(0, 0, 0)]; // only to trigger city-wide placement

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function floatGrid(file) {
  const b = readFileSync(file);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

function slicedArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function loadGroundTops(meta) {
  const heightBuf = readFileSync(path.join(ROOT, "public/data/heightmap.bin"));
  const heights = decodeHeightmapBuffer(slicedArrayBuffer(heightBuf), meta);
  const deltaPath = path.join(ROOT, "public/data/groundtop-delta.bin");
  if (existsSync(deltaPath)) return decodeGroundTopDelta(readFileSync(deltaPath), heights);
  const legacyPath = path.join(ROOT, "public/data/groundtop.bin");
  if (existsSync(legacyPath)) return floatGrid(legacyPath);
  return heights;
}

function makeWorld() {
  const meta = JSON.parse(readFileSync(path.join(ROOT, "public/data/meta.json"), "utf8"));
  const { cellSize, width: W, height: H, minX, minZ } = meta.grid;
  const groundTops = loadGroundTops(meta);
  const surface = readFileSync(path.join(ROOT, "public/data/surface.bin"));
  const bridges = meta.bridges ?? [];
  const bridgeBounds = bridges.map((br) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of br.line) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const pad = br.width * 0.62;
    return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
  });

  const sampleGround = (x, z) => {
    const fx = Math.min(Math.max((x - minX) / cellSize, 0), W - 1.001);
    const fy = Math.min(Math.max((z - minZ) / cellSize, 0), H - 1.001);
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const ax = fx - ix, ay = fy - iy;
    const i = iy * W + ix;
    const h00 = groundTops[i], h10 = groundTops[i + 1], h01 = groundTops[i + W], h11 = groundTops[i + W + 1];
    return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
  };
  const bridgeDeck = (x, z) => {
    let best = -Infinity;
    for (let b = 0; b < bridges.length; b++) {
      const bb = bridgeBounds[b];
      if (x < bb.x0 || x > bb.x1 || z < bb.z0 || z > bb.z1) continue;
      const br = bridges[b];
      for (let i = 0; i < br.line.length - 1; i++) {
        const [x1, z1, h1] = br.line[i];
        const [x2, z2, h2] = br.line[i + 1];
        const dx = x2 - x1, dz = z2 - z1;
        const ll = dx * dx + dz * dz;
        if (ll < 1e-6) continue;
        const t = Math.min(1, Math.max(0, ((x - x1) * dx + (z - z1) * dz) / ll));
        const px = x1 + t * dx, pz = z1 + t * dz;
        if (Math.hypot(x - px, z - pz) < br.width * 0.62) best = Math.max(best, h1 + t * (h2 - h1));
      }
    }
    return best;
  };
  const ground = (x, z) => {
    const g = sampleGround(x, z);
    const d = bridgeDeck(x, z);
    return d > -Infinity ? Math.max(g, d) : g;
  };
  const isWater = (x, z) => {
    const ix = Math.min(Math.max(Math.round((x - minX) / cellSize), 0), W - 1);
    const iy = Math.min(Math.max(Math.round((z - minZ) / cellSize), 0), H - 1);
    return surface[iy * W + ix] === 3;
  };

  const colliders = [];
  const colDir = path.join(ROOT, "public/data/colliders");
  for (const f of readdirSync(colDir)) {
    if (!/^tile_.+\.json$/.test(f)) continue;
    const seen = new Map();
    for (const raw of JSON.parse(readFileSync(path.join(colDir, f), "utf8"))) {
      const s = seen.get(raw.i) ?? 0;
      seen.set(raw.i, s + 1);
      colliders.push({ ...raw, s, cosYaw: Math.cos(raw.yaw), sinYaw: Math.sin(raw.yaw) });
    }
  }
  const CELL = 160;
  const cells = new Map();
  const key = (cx, cz) => `${cx},${cz}`;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const r = Math.hypot(c.hx, c.hz) + 8;
    const x0 = Math.floor((c.x - r) / CELL), x1 = Math.floor((c.x + r) / CELL);
    const z0 = Math.floor((c.z - r) / CELL), z1 = Math.floor((c.z + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = key(cx, cz);
      let list = cells.get(k);
      if (!list) { list = []; cells.set(k, list); }
      list.push(i);
    }
  }
  const stamp = new Uint32Array(colliders.length);
  let stampGen = 0;
  const sweep = (p0, p1) => {
    const dxs = p1[0] - p0[0], dys = p1[1] - p0[1], dzs = p1[2] - p0[2];
    const len = Math.hypot(dxs, dys, dzs);
    if (len < 1e-6) return null;
    const pad = 18;
    const x0 = Math.floor((Math.min(p0[0], p1[0]) - pad) / CELL);
    const x1 = Math.floor((Math.max(p0[0], p1[0]) + pad) / CELL);
    const z0 = Math.floor((Math.min(p0[2], p1[2]) - pad) / CELL);
    const z1 = Math.floor((Math.max(p0[2], p1[2]) + pad) / CELL);
    let best = Infinity;
    const gen = ++stampGen;
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const list = cells.get(key(cx, cz));
      if (!list) continue;
      for (const idx of list) {
        if (stamp[idx] === gen) continue;
        stamp[idx] = gen;
        const c = colliders[idx];
        const cos = c.cosYaw, sin = c.sinYaw;
        const ox = (p0[0] - c.x) * cos - (p0[2] - c.z) * sin;
        const oz = (p0[0] - c.x) * sin + (p0[2] - c.z) * cos;
        const oy = p0[1] - c.y;
        const dx = dxs * cos - dzs * sin;
        const dz = dxs * sin + dzs * cos;
        let tmin = 0, tmax = 1, miss = false;
        for (const [o, d, h] of [[ox, dx, c.hx], [oy, dys, c.hy], [oz, dz, c.hz]]) {
          if (Math.abs(d) < 1e-9) {
            if (Math.abs(o) > h) { miss = true; break; }
            continue;
          }
          let ta = (-h - o) / d, tb = (h - o) / d;
          if (ta > tb) [ta, tb] = [tb, ta];
          tmin = Math.max(tmin, ta);
          tmax = Math.min(tmax, tb);
          if (tmin > tmax) { miss = true; break; }
        }
        if (!miss && tmin < best) best = tmin;
      }
    }
    return best === Infinity ? null : best * len;
  };

  console.log(`[trainer] world: ${colliders.length} collider boxes, ${cells.size} spatial cells`);
  return { ground, isWater, sweep, createBody: () => 1, moveBody: () => {}, removeBody: () => {} };
}

const world = makeWorld();

const roads = new RoadGraph(JSON.parse(readFileSync(path.join(ROOT, "public/data/roads.json"), "utf8")));
const learner = new Learner(MAX_CARS);
const fleet = new Fleet(world, roads, learner);

// resume
let resumed = 0;
if (FRESH) {
  console.log(`[trainer] fresh start requested; ignoring existing checkpoint at ${CKPT}`);
} else if (existsSync(CKPT)) {
  try {
    const blob = JSON.parse(readFileSync(CKPT, "utf8"));
    if (fleet.importState(blob)) resumed = blob.cars?.length ?? 0;
  } catch (e) { console.warn("[trainer] checkpoint load failed, fresh start:", e.message); }
}
// ensure fleet is initialized even with no checkpoint (first prePhysics does #placeAll)
fleet.prePhysics(DT, INIT_ANCHOR);
// each car is its own anchor → every car stays NEAR (fully simulated) wherever it
// scattered to, and (because they're spread city-wide) they never pile up on each
// other the way one clustered anchor made them. The Vector3s mutate in place.
const anchors = fleet.cars.map((c) => c.pos);
console.log(`[trainer] start — ${MAX_CARS} cars${resumed ? `, resumed ${resumed} from checkpoint` : " (fresh)"}`);

let simSteps = 0;
const t0 = Date.now();

function stats() {
  const skills = [];
  for (let i = 0; i < MAX_CARS; i++) skills.push(learner.skill(i));
  skills.sort((a, b) => a - b);
  const median = skills[skills.length >> 1];
  const best = skills[skills.length - 1];
  const st = fleet.exportState();
  let km = 0, age = 0, nan = 0;
  for (const c of st.cars) {
    km += c.odoM;
    if (c.ageS > age) age = c.ageS;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.rhoBar)) nan++;
  }
  return { median, best, km: km / 1000, ageH: age / 3600, nan, st, diag: fleet.diagnostics() };
}

function checkpoint() {
  const s = stats();
  try {
    const tmp = CKPT + ".tmp";
    writeFileSync(tmp, JSON.stringify(s.st));
    renameSync(tmp, CKPT);
  } catch (e) { console.warn("[trainer] checkpoint write failed:", e.message); }
  const realMin = (Date.now() - t0) / 60000;
  console.log(
    `[trainer] +${realMin.toFixed(1)}min real | sim ${(simSteps * DT / 3600).toFixed(1)}h | ` +
    `skill med ${s.median.toFixed(1)} best ${s.best.toFixed(1)} | ${s.km.toFixed(0)} km | ` +
    `eldest ${s.ageH.toFixed(1)}h | coll ${s.diag.collisions}` +
    ` bld ${s.diag.buildingCollisions} car ${s.diag.carCollisions} water ${s.diag.waterHits} clamp ${s.diag.roadClamps}` +
    ` red ${s.diag.redLightViolations} ` +
    `wrong ${s.diag.wrongWaySteps} lane ${s.diag.meanLaneError.toFixed(2)}${s.nan ? ` | WARN ${s.nan} NaN` : ""}`
  );
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  if (stopping) process.exit(0);
  stopping = true;
  console.log(`[trainer] ${sig} — final checkpoint`);
  checkpoint();
  process.exit(0);
});

if (CHECKPOINT_MS > 0) setInterval(checkpoint, CHECKPOINT_MS);

// accelerated run loop — batch of substeps, then yield so timers/signals fire
function tick() {
  if (stopping) return;
  try {
    for (let i = 0; i < BATCH; i++) { fleet.prePhysics(DT, anchors); simSteps++; }
  } catch (e) {
    console.error("[trainer] step error (continuing):", e.message);
  }
  if (MAX_REAL_MS > 0 && Date.now() - t0 >= MAX_REAL_MS) {
    stopping = true;
    console.log(`[trainer] max real runtime reached (${MAX_REAL_MS}ms) — final checkpoint`);
    checkpoint();
    process.exit(0);
  }
  setImmediate(tick);
}
tick();
