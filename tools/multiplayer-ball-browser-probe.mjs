import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";

function chromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const result = candidates.find((candidate) => existsSync(candidate));
  if (!result) throw new Error("Chrome/Chromium not found; set CHROME_BIN");
  return result;
}

const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--hide-scrollbars",
    "--mute-audio"
  ]
});

const contexts = [];
try {
  const errors = [[], []];
  const pages = await Promise.all([0, 1].map(async (index) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors[index].push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors[index].push(message.text());
    });
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    return page;
  }));

  await Promise.all(pages.map((page) => page.waitForFunction(
    () => window.__sf?.fetchBall && window.__sf?.net?.status === "online" && window.__sf.net.roster.size === 1,
    undefined,
    { timeout: 150_000 }
  )));

  // Saved positions can place the two clean browser contexts across the city.
  // Co-locate them so the receiver's intentional 150 m visibility cap does not
  // discard a throw that no nearby player could see in real play either.
  const meetup = await pages[0].evaluate(() => ({
    x: window.__sf.player.position.x,
    z: window.__sf.player.position.z,
    facing: window.__sf.player.heading
  }));
  await Promise.all(pages.map((page) => page.evaluate((target) => {
    const sf = window.__sf;
    sf.player.teleportTo({
      x: target.x,
      y: sf.map.effectiveGround(target.x, target.z) + 0.9,
      z: target.z,
      facing: target.facing,
      mode: "walk"
    });
  }, meetup)));
  await pages[0].waitForTimeout(500);

  const initialCounts = await Promise.all(pages.map((page) => page.evaluate(() => {
    let count = 0;
    window.__sf.fetchBall.visitFreeBalls(() => count++);
    return count;
  })));
  assert.deepEqual(initialCounts, [0, 0], "ball probe did not begin from a clean world");

  const launched = await pages[0].evaluate(() => {
    const sf = window.__sf;
    return sf.fetchBall.throwForCinematic(new sf.THREE.Vector3(0, 0.1, 0));
  });
  assert.equal(launched, true, "local client rejected the authored throw");

  await pages[1].waitForFunction(() => {
    let count = 0;
    window.__sf.fetchBall.visitFreeBalls(() => count++);
    return count === 1;
  }, undefined, { timeout: 10_000 });

  const sampleRemote = (page) => page.evaluate(() => {
    const samples = [];
    const sf = window.__sf;
    sf.fetchBall.visitFreeBalls((id, state) => samples.push({
      id,
      x: state.x,
      y: state.y,
      z: state.z,
      vx: state.vx,
      vy: state.vy,
      vz: state.vz
    }));
    return {
      samples,
      ownsCameraTarget: sf.fetchBall.activeBallWorld(new sf.THREE.Vector3())
    };
  });

  const before = await sampleRemote(pages[1]);
  await pages[1].waitForTimeout(500);
  const after = await sampleRemote(pages[1]);
  assert.equal(before.samples.length, 1, "friend did not receive exactly one ball");
  assert.equal(after.samples.length, 1, "friend's replicated ball disappeared during flight");
  const a = before.samples[0];
  const b = after.samples[0];
  assert.equal(a.id, b.id, "replicated ball identity changed during flight");
  assert.ok(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 0.5, "replicated ball did not advance through physics");
  assert.equal(before.ownsCameraTarget, false, "friend's ball hijacked the local fetch camera target");

  await pages[1].waitForFunction(() => {
    let settled = false;
    window.__sf.fetchBall.visitFreeBalls((_id, state) => {
      if (state.grounded && Math.hypot(state.vx, state.vz) < 0.15) settled = true;
    });
    return settled;
  }, undefined, { timeout: 20_000 });

  const pickupRequested = await pages[1].evaluate(() => {
    const sf = window.__sf;
    const position = new sf.THREE.Vector3();
    sf.fetchBall.visitFreeBalls((_id, state) => position.set(state.x, state.y, state.z));
    return sf.fetchBall.tryPickup(position);
  });
  assert.equal(pickupRequested, true, "friend could not request pickup of the settled remote ball");

  await Promise.all([
    pages[0].waitForFunction(() => {
      let count = 0;
      window.__sf.fetchBall.visitFreeBalls(() => count++);
      return count === 0;
    }, undefined, { timeout: 10_000 }),
    pages[1].waitForFunction(() => {
      let count = 0;
      window.__sf.fetchBall.visitFreeBalls(() => count++);
      return count === 0 && window.__sf.fetchBall.hasBallInHand();
    }, undefined, { timeout: 10_000 })
  ]);

  assert.equal(await pages[0].evaluate(() => window.__sf.fetchBall.hasBallInHand()), false, "thrower regained the picked-up ball");
  assert.equal(await pages[1].evaluate(() => window.__sf.fetchBall.hasBallInHand()), true, "friend did not receive the picked-up ball");

  const gpuErrors = errors.flat().filter((message) => /WebGPU|GPUValidation|WGSL|render pipeline|bind group|TypeError/i.test(message));
  assert.deepEqual(gpuErrors, [], `browser errors: ${gpuErrors.join("\n")}`);
  console.log("multiplayer ball browser probe passed", JSON.stringify({ before, after, pickupRequested }));
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
