// Pure golf regression probe: course associations/official scorecard, caddie
// choices, power-meter distance estimates, and calibrated flight/putt ranges.
// Run: npm run test:golf

import { readFileSync } from "node:fs";
import { BALL_RADIUS, CLUBS, estimatedCarry, suggestedClubIndex } from "../src/gameplay/golf/ball.ts";

const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

function inRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function inPoly(x, z, poly) {
  return inRing(x, z, poly.o) && !poly.i.some((ring) => inRing(x, z, ring));
}

const data = JSON.parse(readFileSync(new URL("../public/data/golf.json", import.meta.url), "utf8"));
assert(data.holes.length === 18, `expected 18 holes, got ${data.holes.length}`);
assert(data.holes.reduce((sum, h) => sum + h.par, 0) === 72, "course is not par 72");
assert(data.greens.length === 20 && data.tees.length === 56 && data.bunkers.length === 48, "OSM feature counts changed");
assert(data.fairways.length === 19 && data.paths.length === 28, "fairway/path counts changed");

const officialHcp = [7, 15, 1, 17, 13, 3, 5, 9, 11, 10, 4, 2, 12, 14, 16, 8, 6, 18];
const officialBlack = [372, 472, 385, 130, 307, 388, 219, 378, 524, 501, 418, 453, 180, 344, 171, 382, 350, 506];
for (const h of data.holes) {
  assert(h.hcp === officialHcp[h.ref - 1], `hole ${h.ref} handicap is stale`);
  assert(h.yardages.black === officialBlack[h.ref - 1], `hole ${h.ref} black yardage is stale`);
  assert(inPoly(h.teeXZ[0], h.teeXZ[1], data.tees[h.tee]), `hole ${h.ref} tee centroid is outside tee polygon`);
  assert(inPoly(h.pinXZ[0], h.pinXZ[1], data.greens[h.green]), `hole ${h.ref} pin is outside green polygon`);
}

const caddie = [
  [20, "fairway", "wedge"],
  [50, "fairway", "wedge"],
  [90, "fairway", "iron9"],
  [120, "fairway", "iron7"],
  [145, "fairway", "iron5"],
  [165, "fairway", "iron3"],
  [190, "fairway", "wood3"],
  [220, "fairway", "driver"],
  [250, "fairway", "driver"],
  [50, "rough", "wedge"],
  [90, "rough", "wood3"],
  [12, "green", "putter"],
  [40, "bunker", "sand"]
];
for (const [distance, lie, expected] of caddie) {
  const got = CLUBS[suggestedClubIndex(distance, lie)].id;
  assert(got === expected, `auto-caddie ${distance}m/${lie}: expected ${expected}, got ${got}`);
}

const GRAVITY = 9.81;
const DRAG = 0.0016;
const H = 1 / 120;
function flatCarry(club, power) {
  let x = 0;
  let y = BALL_RADIUS + 0.02;
  let vx = Math.cos(club.loft) * club.speed * power;
  let vy = Math.sin(club.loft) * club.speed * power;
  for (let i = 0; i < 60 / H; i++) {
    const speed = Math.hypot(vx, vy);
    const k = 1 - Math.min(0.9, DRAG * speed * H);
    vx *= k;
    vy = vy * k - GRAVITY * H;
    x += vx * H;
    y += vy * H;
    if (y <= BALL_RADIUS) return x;
  }
  return x;
}

let worstEstimatePct = 0;
for (const club of CLUBS) {
  let previous = -1;
  for (const power of [0, 0.25, 0.5, 0.75, 1]) {
    const estimate = estimatedCarry(club, power, "fairway");
    assert(estimate >= previous, `${club.id} estimate is not monotonic at ${power}`);
    previous = estimate;
    if (power === 1) assert(Math.abs(estimate - club.carry) < 0.75, `${club.id} full estimate misses advertised carry`);
    if (club.id !== "putter" && power >= 0.25) {
      const actual = flatCarry(club, power);
      worstEstimatePct = Math.max(worstEstimatePct, Math.abs(estimate - actual) / Math.max(1, actual));
    }
  }
}
assert(worstEstimatePct < 0.16, `force-meter estimate error too high: ${(worstEstimatePct * 100).toFixed(1)}%`);

const putter = CLUBS.find((c) => c.id === "putter");
const flatPutt = (putter.speed * putter.speed) / (2 * 0.55);
assert(Math.abs(flatPutt - putter.carry) < 0.5, `putter rolls ${flatPutt.toFixed(1)}m, advertises ${putter.carry}m`);

console.log(
  JSON.stringify(
    {
      ok: true,
      course: { holes: data.holes.length, par: 72, greens: data.greens.length, tees: data.tees.length, bunkers: data.bunkers.length },
      caddie: caddie.map(([distance, lie]) => ({ distance, lie, club: CLUBS[suggestedClubIndex(distance, lie)].id })),
      worstEstimatePct: Number((worstEstimatePct * 100).toFixed(1)),
      flatPuttMetres: Number(flatPutt.toFixed(1))
    },
    null,
    2
  )
);
