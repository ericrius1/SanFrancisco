// Contract probe for the Sutro Baths out-of-time pocket.
//
// The pocket takes the WORLD clock over while a visitor is inside the restored
// hall and hides far-world roots nobody inside can see. Both of those are
// global side effects, so the thing that actually matters is that they are
// handed back — every time, on every exit path. This probe walks a visitor in
// and out and asserts:
//
//   1. outside, the sky follows real SF time and nothing is hidden;
//   2. deep inside, the sky is held at the authored sunset↔twilight band, the
//      lamps are up, and the far world is thinned;
//   3. back outside, the real clock returns immediately and every hidden root
//      is visible again (no leaked pin, no permanently missing city);
//   4. far enough away that the site sleeps, the same holds — sleeping must
//      release, not strand.
//
// It also guards the arrival itself. The baths sit on an authored groundTop
// floor, so a travel transition WAITS for that region's covered pipeline warm.
// That warm used to run in the normal compile queue, which the pipeline parks
// for the whole duration of an active arrival — so the arrival waited on a
// compile that was waiting on the arrival, and only its 18 s timeout broke the
// tie. Time-to-interactive is asserted here so that can never come back.
//
// Run against an existing dev or preview server:
//   SF_PROBE_URL=http://localhost:5179 node tools/sutro-pocket-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:5179").replace(/\/$/, "");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/sutro-pocket-probe");
const SITE = { x: -6125, z: 1117, yaw: -0.077, deckY: 5.62 };
/** A travel transition onto the authored deck must be interactive well inside
 *  this. The deadlock above produced 18 s; a healthy arrival is under one. */
const ARRIVAL_INTERACTIVE_BUDGET_MS = 5_000;
const ROAD_STAND = [-6084.4, 32.2, 1183.4];
const FAR_STAND = [-5200, 60, 1500];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pool-local metres → world. */
function local(x, y, z) {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

const checks = [];
function expect(id, pass, detail) {
  checks.push({ id, pass: Boolean(pass), detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id}`);
}

const run = async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.env.SF_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader")}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--mute-audio"
    ]
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  try {
    // Boot well away from the baths so the visit below is a true cold runtime
    // arrival (the boot path uses a different, unblocked compile lane).
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=oceanBeach`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForFunction(
      () => window.__sf?.renderer?.backend?.device && window.__sf?.player,
      null,
      { timeout: 240_000 }
    );
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 240_000 });
    await sleep(2500);

    // Every root the interior thinning is allowed to hide.
    //
    // These roots have OTHER owners: the citygen ring hides its distant chunks,
    // and the traffic system retires rigs that are no longer near the player —
    // which, after travelling five kilometres, is most of them. So neither
    // "nothing is hidden afterwards" nor "each root visible before is visible
    // after" is a sound invariant; both fail on work that is nothing to do with
    // the pocket. What must hold is that the thinning does not leave the world
    // MORE hidden than it found it, and that it reports itself released. The
    // per-root list is kept as diagnostics for reading a real failure.
    const thinnableRoots = await page.evaluate(() => {
      const pattern =
        /^(cityGen|wildlands_|TrafficLightRig|tileBuildingBatch|tileRoadBatch|tileShadowProxy:|landmarkShadowProxy|golf|palace_fine_arts_lagoon|ocean-beach-surf-shack)/;
      window.__pocketRoots = () =>
        window.__sf.scene.children.filter((child) => pattern.test(child.name ?? ""));
      let next = 0;
      window.__pocketWasVisible = new Map();
      for (const root of window.__pocketRoots()) {
        root.userData.__pocketProbeId = next++;
        window.__pocketWasVisible.set(root.userData.__pocketProbeId, root.visible);
      }
      // Roots that were visible before the visit but are hidden now.
      window.__pocketUnrestored = () =>
        window.__pocketRoots()
          .filter(
            (root) =>
              window.__pocketWasVisible.get(root.userData.__pocketProbeId) === true && !root.visible
          )
          .map((root) => root.name);
      return next;
    });

    const snapshot = () =>
      page.evaluate(() => {
        const sf = window.__sf;
        const twilight = sf.sutroBaths?.debugState?.().twilight ?? null;
        const roots = window.__pocketRoots();
        return {
          timeOfDay: Number(sf.sky.timeOfDay.toFixed(3)),
          realTime: sf.sky.realTime === true,
          authority: sf.sky.timeAuthority,
          twilight,
          rootsHidden: roots.filter((root) => !root.visible).length,
          rootsTotal: roots.length,
          unrestored: window.__pocketUnrestored()
        };
      });

    /**
     * Wait for the pocket's sky crossfade to land.
     *
     * The handover is deliberately WALL-CLOCK paced (twilight.ts,
     * SKY_FADE_IN_SECONDS / SKY_FADE_OUT_SECONDS) rather than parametrized by how
     * far inside the visitor has walked: driving the hour off position meant
     * someone pacing about the hall dragged the sun and moon back and forth at
     * walking speed. A fixed post-move sleep therefore samples mid-handover, so
     * every clock assertion below waits for the fade to finish instead.
     * `skyBlend` reaching its end stop IS the "handover complete" signal.
     */
    const settleSkyCrossfade = (direction) =>
      page.evaluate(async (dir) => {
        const started = performance.now();
        const deadline = started + 20_000;
        const read = () => window.__sf.sutroBaths?.debugState?.().twilight?.skyBlend ?? 0;
        const done = (blend) => (dir === "in" ? blend >= 0.999 : blend <= 0.001);
        while (performance.now() < deadline) {
          const blend = read();
          if (done(blend)) return { blend, waitedMs: Math.round(performance.now() - started), dir };
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { blend: read(), waitedMs: Math.round(performance.now() - started), dir, timedOut: true };
      }, direction);

    const stand = async (point) => {
      await page.evaluate(([x, y, z]) => {
        const sf = window.__sf;
        sf.player.restoreState({ x, y, z, heading: sf.player.heading, mode: "walk" });
      }, point);
      await sleep(3600);
    };

    const outside = await snapshot();
    expect(
      "outside-world-clock-untouched",
      outside.realTime && outside.authority === null && outside.twilight === null,
      outside
    );

    // --- travel to the baths and time it ------------------------------------
    const arrival = await page.evaluate(async ([tx, tz, budget]) => {
      const sf = window.__sf;
      const started = performance.now();
      sf.teleportToTarget(tx, tz, "Sutro Baths");
      const deadline = started + budget + 20_000;
      while (performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (sf.worldArrival?.active === false) {
          return { interactiveMs: Math.round(performance.now() - started), state: "idle" };
        }
      }
      return {
        interactiveMs: Math.round(performance.now() - started),
        state: sf.worldArrival?.snapshot?.state ?? "unknown"
      };
    }, [SITE.x, SITE.z, ARRIVAL_INTERACTIVE_BUDGET_MS]);
    expect(
      "arrival-not-visual-blocked",
      arrival.state === "idle",
      arrival
    );
    expect(
      "arrival-interactive-within-budget",
      arrival.interactiveMs < ARRIVAL_INTERACTIVE_BUDGET_MS,
      { ...arrival, budgetMs: ARRIVAL_INTERACTIVE_BUDGET_MS }
    );
    await page.waitForFunction(() => Boolean(window.__sf?.sutroBaths), null, { timeout: 120_000 });
    await sleep(2500);

    await stand(local(-7, SITE.deckY + 0.92, 0));
    const faded = await settleSkyCrossfade("in");
    expect("inside-sky-crossfade-completed", faded.blend >= 0.999, faded);

    const inside = await snapshot();
    expect("inside-pocket-engaged", inside.twilight?.depth > 0.9, inside);
    expect("inside-clock-held", inside.authority !== null, inside);
    expect(
      "inside-clock-is-the-authored-band",
      inside.timeOfDay >= Math.min(inside.twilight.sunsetHour, inside.twilight.twilightHour) - 0.05 &&
        inside.timeOfDay <= Math.max(inside.twilight.sunsetHour, inside.twilight.twilightHour) + 0.05,
      inside
    );

    // The regression this file now guards: the hour must be a function of the
    // CLOCK, not of where the visitor stands. Walk the length of the hall — a
    // large change in `depth` — and the held hour may only drift by the slow
    // sunset↔twilight cycle, never by the walk.
    const walkDrift = await page.evaluate(async ([a, b]) => {
      const sf = window.__sf;
      const samples = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        sf.player.restoreState({
          x: a[0] + (b[0] - a[0]) * t,
          y: a[1] + (b[1] - a[1]) * t,
          z: a[2] + (b[2] - a[2]) * t,
          heading: sf.player.heading,
          mode: "walk"
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const tw = sf.sutroBaths?.debugState?.().twilight;
        samples.push({ hour: sf.sky.timeOfDay, depth: tw?.depth ?? 0, skyBlend: tw?.skyBlend ?? 0 });
      }
      const hours = samples.map((s) => s.hour);
      const depths = samples.map((s) => s.depth);
      return {
        hourSpread: Math.max(...hours) - Math.min(...hours),
        depthSpread: Math.max(...depths) - Math.min(...depths),
        skyBlendMin: Math.min(...samples.map((s) => s.skyBlend))
      };
    }, [local(-7, SITE.deckY + 0.92, -62), local(-7, SITE.deckY + 0.92, 62)]);
    // 1.5 s of walking at the authored drift rate cannot move the hour this far,
    // so anything above it means position leaked back into the sky.
    expect(
      "inside-hour-does-not-track-position",
      walkDrift.hourSpread < 0.05 && walkDrift.skyBlendMin >= 0.999,
      walkDrift
    );
    expect("inside-lamps-up", inside.twilight?.lampGlow > 0.9, inside);
    expect("inside-exterior-thinned", inside.twilight?.exteriorThinned === true, inside);
    expect(
      "inside-thinning-hid-something",
      inside.rootsTotal === 0 || inside.unrestored.length > 0,
      { justHidden: inside.unrestored.length, hidden: inside.rootsHidden, total: inside.rootsTotal }
    );

    // --- the EDGE of the pocket ---------------------------------------------
    //
    // The pocket used to let go from the inside. Its latch and the indoor camera
    // both read feathered blends that had already collapsed several metres
    // inside the building — twice as fast in a corner, where two axis feathers
    // multiplied — so walking over to the glass, standing in the north corner or
    // taking the outer edge of the spiral snapped the sky back to the real
    // afternoon and swung the camera out to third person, all while the visitor
    // was still on the deck. Both are measured from the WALL now. These stands
    // are the ones that used to break: the room must still be at evening, still
    // hold the clock, and still be in the eye rig at every one of them.
    for (const [label, point] of [
      ["east-glass", local(36.4, SITE.deckY + 0.92, 0)],
      ["north-corner", local(33, SITE.deckY + 0.92, 70)],
      ["south-corner", local(-33, SITE.deckY + 0.92, -70)],
      // Two metres PAST the portal: the deliberate buffer, so a step out of the
      // doorway and back cannot flip anything.
      ["portal-buffer", local(40.9, 32.1, 63.1)]
    ]) {
      await stand(point);
      const edge = await snapshot();
      const indoorCamera = await page.evaluate(() => window.__sf.chase?.indoor === true);
      expect(
        `edge-${label}-still-inside`,
        edge.twilight?.inside === true && edge.authority !== null && indoorCamera,
        { ...edge, indoorCamera }
      );
      expect(`edge-${label}-room-still-lit`, edge.twilight?.lampGlow > 0.6, edge);
    }

    await stand(ROAD_STAND);
    const unfaded = await settleSkyCrossfade("out");
    expect("exit-sky-crossfade-completed", unfaded.blend <= 0.001, unfaded);
    const back = await snapshot();
    expect("exit-clock-released", back.authority === null && back.realTime, back);
    expect(
      "exit-clock-back-to-real-time",
      Math.abs(back.timeOfDay - outside.timeOfDay) < 0.5,
      { before: outside.timeOfDay, after: back.timeOfDay }
    );
    expect("exit-pocket-collapsed", back.twilight?.depth === 0, back);
    expect(
      "exit-exterior-restored",
      back.rootsHidden <= outside.rootsHidden && back.twilight?.exteriorThinned === false,
      {
        hiddenBefore: outside.rootsHidden,
        hiddenAfter: back.rootsHidden,
        total: back.rootsTotal,
        stillHiddenFromBefore: back.unrestored.slice(0, 8)
      }
    );

    await stand(FAR_STAND);
    await sleep(2500);
    const asleep = await snapshot();
    expect("asleep-clock-released", asleep.authority === null && asleep.realTime, asleep);
    expect("asleep-no-thinning-leak", asleep.twilight?.exteriorThinned !== true, asleep);
    expect(
      "asleep-exterior-restored",
      asleep.rootsHidden <= outside.rootsHidden && asleep.twilight?.exteriorThinned !== true,
      { hiddenBefore: outside.rootsHidden, hiddenAfter: asleep.rootsHidden }
    );

    expect("no-page-errors", pageErrors.length === 0, pageErrors.slice(0, 4));

    const report = {
      generatedAt: new Date().toISOString(),
      target: BASE_URL,
      thinnableRoots,
      pass: checks.every((check) => check.pass),
      checks,
      arrival,
      phases: { outside, inside, back, asleep },
      pageErrors
    };
    await writeFile(path.join(OUT, "result.json"), JSON.stringify(report, null, 2));
    console.log(`[sutro-pocket] report: ${path.join(OUT, "result.json")}`);
    if (!report.pass) process.exitCode = 1;
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
