// Citywide building-collision acceptance probe (Node, no DOM, no WebGPU).
//
// Proves the multi-anchor building-body fix: with anchors spread across the city
// (the human player PLUS AI cars elsewhere), building static bodies are selected
// around EVERY anchor — not just the player — deduped and within budget. Also
// shows, geometrically, that a car driven at a building wall would stop (its
// segment intersects the materialised OBB) whereas with the old player-only
// anchoring that far-off building had NO body and the car clipped straight
// through.
//
// The pure selection logic (src/core/buildingBodies.ts) is bundled with esbuild
// and driven against the REAL baked collider OBBs in public/data/colliders.
//
//   node tools/collision-probe.mjs
//
// Prints PASS/FAIL lines; exits non-zero on any failure.

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- bundle the pure module -------------------------------------------------
const tmp = await mkdtemp(path.join(os.tmpdir(), "collision-probe-"));
const outfile = path.join(tmp, "buildingBodies.mjs");
await build({
  entryPoints: [path.join(ROOT, "src/core/buildingBodies.ts")],
  outfile,
  format: "esm",
  bundle: true,
  platform: "node",
  logLevel: "error"
});
const { selectBodyCandidates, obbPlanarDistance, anchorInsideCollider } = await import(outfile);

// --- load the real baked city ----------------------------------------------
const manifest = JSON.parse(await readFile(path.join(ROOT, "public/data/manifest.json"), "utf8"));
const TILE = manifest.tile;
const HALF = TILE / 2;
const keyCenter = (key) => {
  const [ix, iz] = key.split("_").map(Number);
  return [manifest.minX + ix * TILE + HALF, manifest.minZ + iz * TILE + HALF];
};

// patch derived fields exactly like colliderWorker (cosYaw/sinYaw/sub-box s)
function patch(list) {
  const seen = new Map();
  return list.map((c) => {
    const s = seen.get(c.i) ?? 0;
    seen.set(c.i, s + 1);
    return { ...c, cosYaw: Math.cos(c.yaw), sinYaw: Math.sin(c.yaw), s };
  });
}

const colDir = path.join(ROOT, "public/data/colliders");
const tiles = []; // { key, cx, cz, colliders }
for (const f of readdirSync(colDir)) {
  const m = f.match(/^tile_(.+)\.json$/);
  if (!m) continue;
  const key = m[1];
  const list = patch(JSON.parse(await readFile(path.join(colDir, f), "utf8")));
  const [cx, cz] = keyCenter(key);
  tiles.push({ key, cx, cz, colliders: list });
}
const totalBoxes = tiles.reduce((n, t) => n + t.colliders.length, 0);

let pass = 0,
  fail = 0;
const check = (ok, label) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

console.log(`\nloaded ${tiles.length} collider tiles, ${totalBoxes} building boxes  (tile=${TILE}m)`);

// --- pick well-separated anchor buildings -----------------------------------
// One "player" building and three "car" buildings, each in a DIFFERENT tile,
// spread far apart so the player-only 260m radius can't reach the car ones.
const CAR_R = 60; // matches CONFIG.carColliderRadius
const PLAYER_R = 260; // matches CONFIG.colliderRadius
const BUDGET = 700; // matches CONFIG.maxActiveBuildingBodies

// largest-footprint box in a tile → a clean, unambiguous wall to aim a car at
function bigBox(tile) {
  let best = null;
  for (const c of tile.colliders) if (!best || c.hx + c.hz > best.hx + best.hz) best = c;
  return best;
}

// choose 4 tiles that are far apart (sort by center, then spread across the list)
const withBig = tiles.filter((t) => bigBox(t)).sort((a, b) => a.cx - b.cx || a.cz - b.cz);
const pickIdx = [
  Math.floor(withBig.length * 0.15),
  Math.floor(withBig.length * 0.4),
  Math.floor(withBig.length * 0.62),
  Math.floor(withBig.length * 0.85)
];
const picks = pickIdx.map((i) => {
  const tile = withBig[i];
  const c = bigBox(tile);
  return { tile, c };
});
const [player, ...cars] = picks;

const anchorAt = ({ c }, r) => ({ x: c.x, z: c.z, r }); // anchor sitting on the building
// place each CAR anchor 25m outside the +local-x face of its target wall, aimed in
const OUT = 25;
function carApproach({ c }) {
  const off = c.hx + OUT;
  const x = c.x + off * c.cosYaw; // (dx,dz) for local (off,0): dx=lx*cos, dz=-lx*sin
  const z = c.z - off * c.sinYaw;
  return { x, z };
}

const playerAnchor = anchorAt(player, PLAYER_R);
const carAnchors = cars.map((p) => {
  const at = carApproach(p);
  return { x: at.x, z: at.z, r: CAR_R };
});
const allAnchors = [playerAnchor, ...carAnchors];

console.log(`\nanchors:`);
console.log(`  player @ tile ${player.tile.key}  (${player.c.x.toFixed(0)}, ${player.c.z.toFixed(0)})  r=${PLAYER_R}`);
cars.forEach((p, i) => {
  const a = carAnchors[i];
  const dPlayer = Math.hypot(a.x - playerAnchor.x, a.z - playerAnchor.z);
  console.log(
    `  car ${i} @ tile ${p.tile.key}  (${a.x.toFixed(0)}, ${a.z.toFixed(0)})  r=${CAR_R}  — ${dPlayer.toFixed(0)}m from player`
  );
});

const isAliveAll = () => true; // baked city: every building alive (no demolition here)

// count kept candidates whose nearest anchor is a given one
function countNear(kept, anchor) {
  let n = 0;
  for (const cand of kept) if (obbPlanarDistance(cand.c, anchor.x, anchor.z) <= anchor.r) n++;
  return n;
}

// --- 1. BEFORE: player-only anchoring (the bug) -----------------------------
const before = selectBodyCandidates([playerAnchor], tiles, BUDGET, isAliveAll, TILE);
console.log(`\n[1] BEFORE — player-only anchor (old behaviour)`);
console.log(`    bodies near player: ${countNear(before, playerAnchor)}`);
let beforeCarsAllZero = true;
carAnchors.forEach((a, i) => {
  const n = countNear(before, a);
  console.log(`    bodies near car ${i}: ${n}`);
  if (n !== 0) beforeCarsAllZero = false;
});
check(countNear(before, playerAnchor) > 0, `player has building bodies`);
check(beforeCarsAllZero, `car regions have ZERO bodies (cars clip through — the bug)`);

// --- 2. AFTER: multi-anchor -------------------------------------------------
const after = selectBodyCandidates(allAnchors, tiles, BUDGET, isAliveAll, TILE);
console.log(`\n[2] AFTER — multi-anchor (player + ${carAnchors.length} cars)`);
const nPlayerAfter = countNear(after, playerAnchor);
console.log(`    bodies near player: ${nPlayerAfter}`);
let afterCarsAllPositive = true;
carAnchors.forEach((a, i) => {
  const n = countNear(after, a);
  console.log(`    bodies near car ${i}: ${n}`);
  if (n === 0) afterCarsAllPositive = false;
});
check(nPlayerAfter > 0, `player still has building bodies (not regressed)`);
check(afterCarsAllPositive, `EVERY car region now has building bodies`);

// --- 3. dedup + budget ------------------------------------------------------
const ids = new Set(after.map((c) => `${c.key}:${c.c.i}:${c.c.s}`));
check(ids.size === after.length, `candidates are deduped by key:i:s (${after.length} unique)`);
check(after.length <= BUDGET, `within budget (${after.length} ≤ ${BUDGET})`);
// ranked nearest-first
let sorted = true;
for (let i = 1; i < after.length; i++) if (after[i].d < after[i - 1].d) sorted = false;
check(sorted, `ranked by ascending wall distance`);

// --- 4. budget saturation still covers cars (nearest wins) ------------------
const tight = selectBodyCandidates(allAnchors, tiles, 120, isAliveAll, TILE);
let tightCarsCovered = true;
carAnchors.forEach((a) => {
  if (countNear(tight, a) === 0) tightCarsCovered = false;
});
check(tight.length <= 120, `tight budget respected (${tight.length} ≤ 120)`);
check(tightCarsCovered, `even a tight 120 budget still covers every car (nearest walls win)`);

// --- 5. altitude-aware anti-wedge guard -------------------------------------
// A player genuinely inside a box must defer its creation, but an airborne
// hoverboard over the same footprint must be allowed to materialise the roof.
const guardBox = { i: 0, s: 0, x: 0, y: 5, z: 0, hx: 5, hy: 5, hz: 5, cosYaw: 1, sinYaw: 0 };
check(anchorInsideCollider(guardBox, { x: 0, y: 5, z: 0, r: 260 }, 2.5), `embedded player defers building body creation`);
check(!anchorInsideCollider(guardBox, { x: 0, y: 10, z: 0, r: 260 }, 2.5), `anchor on a roof/deck top materializes its support body`);
check(!anchorInsideCollider(guardBox, { x: 0, y: 20, z: 0, r: 260 }, 2.5), `airborne player above roof does NOT defer body creation`);
check(anchorInsideCollider(guardBox, { x: 0, z: 0, r: 60 }, 2.5), `altitude-less auxiliary anchor stays conservative`);

// --- 6. geometric proof: a car driven at the wall STOPS ---------------------
// 2D slab test (x,z) of the drive segment against the target OBB, mirroring
// physics.sweepBuildings. Returns hit distance along the segment, or null.
function sweepSegmentXZ(c, x0, z0, x1, z1) {
  const dxs = x1 - x0,
    dzs = z1 - z0;
  const cos = c.cosYaw,
    sin = c.sinYaw;
  const ox = (x0 - c.x) * cos - (z0 - c.z) * sin;
  const oz = (x0 - c.x) * sin + (z0 - c.z) * cos;
  const dx = dxs * cos - dzs * sin;
  const dz = dxs * sin + dzs * cos;
  let tmin = 0,
    tmax = 1;
  for (const [o, d, h] of [
    [ox, dx, c.hx],
    [oz, dz, c.hz]
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(o) > h) return null;
      continue;
    }
    let t0 = (-h - o) / d,
      t1 = (h - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return null;
  }
  const segLen = Math.hypot(dxs, dzs);
  return tmin * segLen;
}

console.log(`\n[3] geometric — car driven at each wall stops (segment hits the OBB)`);
let allStop = true;
cars.forEach((p, i) => {
  const a = carAnchors[i];
  const c = p.c;
  // drive 30m straight toward the wall centre
  const dirx = c.x - a.x,
    dirz = c.z - a.z;
  const L = Math.hypot(dirx, dirz) || 1;
  const x1 = a.x + (dirx / L) * 30,
    z1 = a.z + (dirz / L) * 30;
  const hit = sweepSegmentXZ(c, a.x, a.z, x1, z1);
  const dist = obbPlanarDistance(c, a.x, a.z);
  const ok = hit != null && hit < 30 && hit > 0;
  if (!ok) allStop = false;
  console.log(`    car ${i}: standoff ${dist.toFixed(1)}m → wall hit at ${hit == null ? "MISS" : hit.toFixed(1) + "m"}`);
});
check(allStop, `every car's drive segment stops at its wall (would pass through with no body)`);

// --- summary ----------------------------------------------------------------
await writeFile(path.join(tmp, "done"), "").catch(() => {});
await rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
