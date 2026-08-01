/**
 * Walking the Sutro Baths grand spiral, up and down.
 *
 * The flight is 25 m of continuous helical collision under 128 visual treads,
 * and it has three ways to go wrong that only a walker can see:
 *
 *  1. FOOTING. `effectiveGround` is terrain and bridge decks, nothing else, so
 *     nothing in the heightmap knows a staircase is there. A walker climbing on
 *     a false "not grounded" plays the airborne pose — arms out, legs still.
 *  2. BOUNCE. A capsule driven into an incline is kicked upward by the contact
 *     solver; a controller that re-commands that kick leaves the treads.
 *  3. SNAGS. Flat slabs approximating a helix disagree with it by half-width ×
 *     yaw-step × slope, which shows up as a hidden stair of lips running
 *     against the visible one.
 *
 * So: walk the whole flight in both directions and assert footing, surface
 * tracking, and forward progress the whole way.
 *
 * Run against a dev server: SF_PROBE_URL=http://localhost:5245 node tools/sutro-spiral-walk-probe.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const URL = process.env.SF_PROBE_URL ?? "http://localhost:5240";
const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");

// Mirrors src/world/sutroBaths/layout.ts SPIRAL + SUTRO_BATHS placement.
const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const SPIRAL = {
  cx: 24.6,
  cz: 58.2,
  radius: 11.6,
  startDeg: 20.66,
  sweepDeg: 249.34,
  topY: 31.18,
  botY: 5.78
};
const CAPSULE_HALF_EXTENT = 0.9;
/**
 * Three fixed steps per rendered frame — the most frameBody's accumulator will
 * run before it gives up and drops the remainder. The walk is simulated at the
 * usual 1/60 either way; this just stops the probe paying for a full headless
 * WebGPU frame per step, which is what made a 30 s walk take a quarter hour.
 */
const STEPS_PER_TICK = 3;
const TICK_DT = STEPS_PER_TICK / 60;

const localToWorld = (lx, lz) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return { x: SITE.x + c * lx + s * lz, z: SITE.z - s * lx + c * lz };
};
const localDirToWorld = (dx, dz) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  const x = c * dx + s * dz;
  const z = -s * dx + c * dz;
  const len = Math.hypot(x, z) || 1;
  return { x: x / len, z: z / len };
};

/**
 * Walk surface + descending tangent at a fraction of the sweep, `lane` metres
 * out from the centre-line.
 *
 * The lane matters more than anything else here: a flat slab tangent to a helix
 * is exact ON the centre-line and wrong everywhere else, in proportion to the
 * distance from it. Walking the middle of the flight measures the one path the
 * approximation gets right; visitors hug the rail.
 */
function spiralAt(t, lane = 0) {
  const theta = ((SPIRAL.startDeg + SPIRAL.sweepDeg * t) * Math.PI) / 180;
  const radius = SPIRAL.radius + lane;
  const here = localToWorld(
    SPIRAL.cx + radius * Math.cos(theta),
    SPIRAL.cz + radius * Math.sin(theta)
  );
  // Local position derivative with θ is (−sin θ, cos θ): downhill as θ grows.
  const down = localDirToWorld(-Math.sin(theta), Math.cos(theta));
  return { ...here, y: SPIRAL.topY + (SPIRAL.botY - SPIRAL.topY) * t, down };
}

/** Sweep fraction nearest a world point, for progress + surface comparison. */
function spiralT(x, z) {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  const dx = x - SITE.x;
  const dz = z - SITE.z;
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  const deg = (Math.atan2(lz - SPIRAL.cz, lx - SPIRAL.cx) * 180) / Math.PI;
  let along = deg - SPIRAL.startDeg;
  while (along < -180) along += 360;
  while (along > 180) along -= 360;
  if (along < -20) along += 360;
  return along / SPIRAL.sweepDeg;
}

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--mute-audio"
  ]
});
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

/**
 * One walked traverse of the flight.
 *
 * The camera yaw is steered along the helix every step (forward is
 * (−sin yaw, −cos yaw)) and KeyW is held, so this drives the real walk
 * controller through the real input path rather than pushing the body around.
 */
async function traverse(direction, fromT, toT, lane = 0) {
  const start = spiralAt(fromT, lane);
  const startHeading = Math.atan2(
    -(direction === "down" ? start.down.x : -start.down.x),
    -(direction === "down" ? start.down.z : -start.down.z)
  );
  await page.evaluate(
    ({ start: spot, heading }) => {
      window.__sf.player.restoreState({
        x: spot.x,
        y: spot.y + 1.1,
        z: spot.z,
        heading: heading + Math.PI,
        mode: "walk"
      });
      window.__sf.chase.cutTo(window.__sf.player);
    },
    { start, heading: startHeading }
  );
  // Let the body settle onto the treads before any of this counts.
  for (let i = 0; i < 30; i++) await page.evaluate((dt) => window.__sf.tick(dt), TICK_DT);

  await page.keyboard.down("KeyW");
  const samples = await page.evaluate(
    async ({ direction: dir, toT: target, lane: holdLane, geometry, tickDt }) => {
      const sf = window.__sf;
      const { site, spiral } = geometry;
      const cos = Math.cos(site.yaw);
      const sin = Math.sin(site.yaw);
      const tOf = (x, z) => {
        const lx = cos * (x - site.x) - sin * (z - site.z);
        const lz = sin * (x - site.x) + cos * (z - site.z);
        const deg = (Math.atan2(lz - spiral.cz, lx - spiral.cx) * 180) / Math.PI;
        let along = deg - spiral.startDeg;
        while (along < -180) along += 360;
        while (along > 180) along -= 360;
        if (along < -20) along += 360;
        return along / spiral.sweepDeg;
      };
      const radiusOf = (x, z) => {
        const lx = cos * (x - site.x) - sin * (z - site.z);
        const lz = sin * (x - site.x) + cos * (z - site.z);
        return Math.hypot(lx - spiral.cx, lz - spiral.cz);
      };
      const out = [];
      for (let step = 0; step < 900; step++) {
        const p = sf.player.position;
        const t = tOf(p.x, p.z);
        const radius = radiusOf(p.x, p.z);
        // Steer along the tangent at wherever we actually are, leaning in or
        // out to hold the lane — a straight-tangent walk drifts outward.
        const theta = ((spiral.startDeg + spiral.sweepDeg * t) * Math.PI) / 180;
        const sign = dir === "down" ? 1 : -1;
        const drift = Math.max(-0.6, Math.min(0.6, radius - (spiral.radius + holdLane)));
        const dlx = -Math.sin(theta) * sign - Math.cos(theta) * drift;
        const dlz = Math.cos(theta) * sign - Math.sin(theta) * drift;
        const wx = cos * dlx + sin * dlz;
        const wz = -sin * dlx + cos * dlz;
        sf.chase.yaw = Math.atan2(-wx, -wz);
        sf.tick(tickDt);
        out.push({
          t,
          radius,
          y: sf.player.position.y,
          grounded: sf.player.walkGrounded,
          vy: sf.player.velocity.y
        });
        if (dir === "down" ? t >= target : t <= target) break;
      }
      return out;
    },
    { direction, toT, lane, geometry: { site: SITE, spiral: SPIRAL }, tickDt: TICK_DT }
  );
  await page.keyboard.up("KeyW");
  return samples;
}

function report(label, samples, fromT, toT) {
  const surfaceY = (t) => SPIRAL.topY + (SPIRAL.botY - SPIRAL.topY) * t;
  let airborne = 0;
  let maxAbove = 0;
  let maxBelow = 0;
  let worstT = 0;
  // A hop is the body climbing away from the treads under its own momentum:
  // rising while walking DOWN a stair, or rising faster than the stair does
  // while walking up it. This is the bounce, counted.
  const climbRate = ((SPIRAL.topY - SPIRAL.botY) / (SPIRAL.radius * ((SPIRAL.sweepDeg * Math.PI) / 180))) * 3.2;
  let hops = 0;
  let hopping = false;
  const feet = [];
  for (const sample of samples) {
    if (!sample.grounded) airborne++;
    const offset = sample.y - CAPSULE_HALF_EXTENT - surfaceY(sample.t);
    if (offset > maxAbove) {
      maxAbove = offset;
      worstT = sample.t;
    }
    if (offset < maxBelow) maxBelow = offset;
    feet.push(offset);
    const rising = sample.vy > climbRate * 1.5 + 0.35;
    if (rising && !hopping) hops++;
    hopping = rising;
  }
  const reached = samples.length ? samples[samples.length - 1].t : fromT;
  const progress = Math.abs(reached - fromT) / Math.abs(toT - fromT);
  // Stall detector: the longest stretch that made no headway at all. A walker
  // covers ~16 cm per sample, so a centimetre is standing still.
  let stall = 0;
  let run = 0;
  for (let i = 1; i < samples.length; i++) {
    const moved = Math.abs(samples[i].t - samples[i - 1].t) * SPIRAL.radius * ((SPIRAL.sweepDeg * Math.PI) / 180);
    if (moved < 0.01) run++;
    else run = 0;
    if (run > stall) stall = run;
  }
  const summary = {
    label,
    samples: samples.length,
    seconds: +((samples.length * STEPS_PER_TICK) / 60).toFixed(2),
    progress: +progress.toFixed(3),
    airborneSteps: airborne,
    airbornePct: +((airborne / Math.max(1, samples.length)) * 100).toFixed(1),
    hops,
    feetAboveSurface: +maxAbove.toFixed(3),
    feetBelowSurface: +maxBelow.toFixed(3),
    worstAboveAtDeg: +(worstT * SPIRAL.sweepDeg + SPIRAL.startDeg).toFixed(1),
    longestStallSamples: stall,
    medianFootOffset: +feet.sort((a, b) => a - b)[Math.floor(feet.length / 2)].toFixed(3)
  };
  console.log(`[spiral] ${JSON.stringify(summary)}`);
  return summary;
}

try {
  await page.goto(`${URL}/?autostart=1&fullfps&spawn=sutroBaths`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 240_000 });
  await page.waitForFunction(
    () => window.__sf?.player?.walkGrounded && !window.__sf.player.worldArrivalHeld,
    null,
    { timeout: 240_000 }
  );
  // The flight's colliders stream with the tile; give them the same settling
  // window a visitor walking in from the terrace would have had.
  for (let i = 0; i < 80; i++) await page.evaluate((dt) => window.__sf.tick(dt), TICK_DT);

  // Start a couple of treads in from each end so the landings at the head and
  // the fan are not what is being measured. Both lanes: the middle of the
  // flight is where the slab approximation is exact, the inside rail is where
  // it is worst, and a visitor picks whichever they like.
  const runs = [];
  for (const [name, lane] of [["middle", 0], ["inner rail", -2]]) {
    runs.push(report(`descend · ${name}`, await traverse("down", 0.02, 0.96, lane), 0.02, 0.96));
    runs.push(report(`ascend · ${name}`, await traverse("up", 0.96, 0.04, lane), 0.96, 0.04));
  }

  for (const run of runs) {
    assert(run.progress > 0.9, `${run.label} stopped at ${(run.progress * 100).toFixed(0)}% of the flight`);
    // Footing: the walk pose is chosen from this, so a few frames of flicker
    // are survivable and a stair-long false airborne is the bug this exists for.
    assert(run.airbornePct < 2, `${run.label} read airborne for ${run.airbornePct}% of the flight`);
    // Tracking: the soles stay within a tread's rise of the authored helix.
    // Anything more is the body leaving the stair between contacts.
    assert(run.feetAboveSurface < 0.2, `${run.label} floated ${run.feetAboveSurface} m over the treads`);
    // …and they get there by walking, not by hopping the whole way down.
    assert(run.hops < 12, `${run.label} bounced off the treads ${run.hops} times`);
    assert(run.longestStallSamples < 10, `${run.label} jammed for ${run.longestStallSamples} samples`);
  }

  const fatal = errors.filter((message) => !/favicon|Failed to load resource/i.test(message));
  assert.equal(fatal.length, 0, `page errors: ${fatal.slice(0, 3).join(" | ")}`);
  console.log("[spiral] PASS");
} finally {
  await browser.close();
}
