// Deterministic sea-keeping coverage for BoatController's hull buoyancy.
//
// The bay's analytic hero band is a real sea (Hs ≈ 3.4 m, 19–42 m wavelengths,
// faces past 27°, surface moving 4 m/s vertically), so "does the boat sink in
// the waves" is a question with a number attached. This probe builds the exact
// spectrum the renderer uses, sails both hulls through it on every heading, and
// asserts the two things that were wrong before the four-probe model:
//
//   1. the deck never goes meaningfully under the surface, and
//   2. the hull actually RIDES — it tracks the swell at rest, and off a crest
//      at speed it leaves the water and comes back down.
//
// A tiny velocity-integrating physics facade stands in for the solver: the
// controller writes linear/angular velocity, we integrate the pose from it.

import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createServer } from "vite";

globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const vite = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  root: process.cwd(),
  server: { middlewareMode: true }
});

const fail = [];
const check = (label, cond, detail) => {
  if (cond) return;
  fail.push(`${label}: ${detail}`);
};

try {
  const { buildCascadeSpectra, DEFAULT_OCEAN_SPECTRUM } = await vite.ssrLoadModule(
    "/src/world/ocean/spectrum.ts"
  );
  const hero = await vite.ssrLoadModule("/src/world/ocean/heroWaves.ts");
  const { waterHeight } = await vite.ssrLoadModule("/src/world/heightmap.ts");
  const { BoatController } = await vite.ssrLoadModule("/src/vehicles/boat/controller.ts");
  const { BOAT_TUNING, SPEEDBOAT_TUNING } = await vite.ssrLoadModule("/src/vehicles/boat/tuning.ts");
  const { SAILBOAT_HULL, SPEEDBOAT_HULL } = await vite.ssrLoadModule("/src/vehicles/boat/buoyancy.ts");

  const spectrum = buildCascadeSpectra(DEFAULT_OCEAN_SPECTRUM).find((s) => s.heroComponents);
  assert.ok(spectrum?.heroComponents?.length, "physics band produced no hero components");

  // --- the sea we are testing against ---------------------------------------
  const CX = 2000;
  const CZ = -2600; // open bay, clear of the Ocean Beach strip and the lagoon
  const setSea = (on) => hero.setHeroWaves(on ? spectrum.heroComponents : [], null);
  setSea(true);
  hero.setHeroFocus(CX, CZ);

  let hi = -Infinity;
  let lo = Infinity;
  for (let t = 0; t < 30; t += 0.5) {
    for (let i = -60; i <= 60; i++) {
      const h = waterHeight(CX + i * 1.3, CZ, t);
      hi = Math.max(hi, h);
      lo = Math.min(lo, h);
    }
  }
  const seaway = hi - lo;
  console.log(`sea state at (${CX}, ${CZ}): ${seaway.toFixed(2)} m trough to crest`);
  check("sea state", seaway > 3, `expected a real seaway to test in, got ${seaway.toFixed(2)} m`);

  // --- sail a hull through it ------------------------------------------------
  function sail({ tuning, hull, heading, throttle, seconds = 30 }) {
    const controller = new BoatController(tuning, hull);
    const pos = new THREE.Vector3(CX, 0, CZ);
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    const vel = new THREE.Vector3();
    const lin = [0, 0, 0];
    const ang = [0, 0, 0];
    const world = {
      createBox: () => 1,
      setBodyGravityScale() {},
      setBodyTransform() {},
      setBodyVelocity(_h, l, a) {
        [lin[0], lin[1], lin[2]] = l;
        [ang[0], ang[1], ang[2]] = a;
      }
    };
    const ctx = {
      physics: { world },
      map: {
        groundHeight: () => -40,
        isWater: () => true,
        bridgeDeck: () => -Infinity,
        effectiveGround: () => -40
      },
      body: 1,
      position: pos,
      quaternion: quat,
      velocity: vel,
      speed: 0,
      heading: 0,
      time: 0,
      indoor: false,
      raking: false,
      driveSpec: {}
    };
    const held = new Set(throttle ? ["KeyW"] : []);
    const input = {
      suspended: false,
      pressed: () => false,
      down: (c) => held.has(c),
      axis: (neg, pos2) => (held.has(pos2) ? 1 : 0) - (held.has(neg) ? 1 : 0)
    };
    const dt = 1 / 60;
    const frame = { camYaw: 0, aim: new THREE.Vector3(0, 0, -1), v: { linear: lin, angular: ang } };
    pos.y = waterHeight(pos.x, pos.z, 0) + hull.rideHeight;

    const spin = new THREE.Quaternion();
    const buried = [];
    const flying = [];
    let sumErr = 0;
    let airSteps = 0;
    let speedSum = 0;
    let steps = 0;
    for (let s = 0; s < Math.round(seconds / dt); s++) {
      ctx.time += dt;
      hero.setHeroFocus(pos.x, pos.z);
      controller.update(ctx, dt, input, frame);
      vel.set(lin[0], lin[1], lin[2]);
      pos.addScaledVector(vel, dt);
      // integrate angular velocity the way a rigid-body solver would
      spin.set(ang[0] * dt * 0.5, ang[1] * dt * 0.5, ang[2] * dt * 0.5, 0).multiply(quat);
      quat.set(quat.x + spin.x, quat.y + spin.y, quat.z + spin.z, quat.w + spin.w).normalize();
      assert.ok(Number.isFinite(pos.y) && Number.isFinite(quat.w), "boat pose went non-finite");
      if (s < 180) continue; // let her settle onto her lines first
      const wh = waterHeight(pos.x, pos.z, ctx.time);
      sumErr += (pos.y - (wh + hull.rideHeight)) ** 2;
      buried.push(Math.max(0, wh - (pos.y + hull.freeboard))); // green water over the deck
      flying.push(Math.max(0, pos.y - hull.draft - wh)); // keel clear of the sea
      if (pos.y - hull.draft > wh) airSteps++;
      speedSum += Math.hypot(lin[0], lin[2]);
      steps++;
    }
    const pct = (a, q) => {
      const sorted = [...a].sort((x, y) => x - y);
      return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    };
    return {
      followErr: Math.sqrt(sumErr / steps),
      buriedP95: pct(buried, 0.95),
      buriedMax: Math.max(...buried),
      airFrac: airSteps / steps,
      airMax: Math.max(...flying),
      speed: speedSum / steps
    };
  }

  const HEADINGS = [
    ["head sea", Math.PI / 2],
    ["following", -Math.PI / 2],
    ["beam", 0],
    ["quartering", Math.PI / 4]
  ];
  const BOATS = [
    ["sailboat", BOAT_TUNING, SAILBOAT_HULL],
    ["speedboat", SPEEDBOAT_TUNING, SPEEDBOAT_HULL]
  ];

  // 1. Moored in a seaway: she rides it. Tracking the surface within a fraction
  //    of her freeboard is the whole contract — that is "affected by the waves".
  for (const [name, tuning, hull] of BOATS) {
    const r = sail({ tuning, hull, heading: 0, throttle: false });
    console.log(
      `${name} adrift    : follows within ${r.followErr.toFixed(2)} m, ` +
        `deck buried max ${r.buriedMax.toFixed(2)} m, airborne ${(r.airFrac * 100).toFixed(0)}%`
    );
    check(`${name} adrift rides the swell`, r.followErr < 0.25, `waterline error ${r.followErr.toFixed(2)} m`);
    check(`${name} adrift stays dry`, r.buriedMax < 0.05, `deck ${r.buriedMax.toFixed(2)} m under`);
    check(`${name} adrift stays on the water`, r.airFrac < 0.02, `airborne ${(r.airFrac * 100).toFixed(0)}%`);
  }

  // 2. Under full throttle on every heading: she may leave the water off a
  //    crest, but the sea must never close over the deck.
  for (const [name, tuning, hull] of BOATS) {
    for (const [dirName, heading] of HEADINGS) {
      const r = sail({ tuning, hull, heading, throttle: true });
      console.log(
        `${name} ${dirName.padEnd(9)}: ${r.speed.toFixed(1)} m/s, ` +
          `deck buried p95 ${r.buriedP95.toFixed(2)} max ${r.buriedMax.toFixed(2)} m, ` +
          `airborne ${(r.airFrac * 100).toFixed(0)}% max ${r.airMax.toFixed(2)} m`
      );
      check(
        `${name} ${dirName} does not swamp`,
        r.buriedMax < 0.4,
        `deck went ${r.buriedMax.toFixed(2)} m under (p95 ${r.buriedP95.toFixed(2)} m)`
      );
      check(
        `${name} ${dirName} is not held under`,
        r.buriedP95 < 0.1,
        `deck under water for 5% of the run (p95 ${r.buriedP95.toFixed(2)} m)`
      );
      check(`${name} ${dirName} keeps way on`, r.speed > 4, `only made ${r.speed.toFixed(1)} m/s`);
    }
  }

  // 3. The runabout at planing speed must genuinely fly off crests — a hull
  //    glued to a height spring is the bug this model replaced.
  const planing = sail({ tuning: SPEEDBOAT_TUNING, hull: SPEEDBOAT_HULL, heading: Math.PI / 2, throttle: true });
  check(
    "speedboat leaves the water off crests",
    planing.airFrac > 0.02 && planing.airMax > 0.2,
    `airborne ${(planing.airFrac * 100).toFixed(1)}% of the run, max keel clearance ${planing.airMax.toFixed(2)} m`
  );

  // 4. Flat water (no spectral band wired — boot, the lagoon, the far sheet):
  //    the same model must settle on her lines and stay there.
  setSea(false);
  for (const [name, tuning, hull] of BOATS) {
    const r = sail({ tuning, hull, heading: 0, throttle: true, seconds: 20 });
    console.log(
      `${name} flat water: ${r.speed.toFixed(1)} m/s, waterline error ${r.followErr.toFixed(2)} m`
    );
    check(`${name} is steady in flat water`, r.followErr < 0.12, `waterline error ${r.followErr.toFixed(2)} m`);
    check(
      `${name} keeps its flat-water legs`,
      r.speed > tuning.values.maxSpeed * 0.85,
      `${r.speed.toFixed(1)} m/s of a ${tuning.values.maxSpeed} m/s boat`
    );
  }
  setSea(true);
} finally {
  await vite.close();
}

if (fail.length) {
  console.error(`\n${fail.length} boat sea-keeping check(s) failed:`);
  for (const f of fail) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\nboat sea-keeping probe: all checks passed");
