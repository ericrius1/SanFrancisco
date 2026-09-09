import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPUDeveloperFeatures', '--use-angle=metal', '--mute-audio']
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("crash", () => console.log("BROWSER PAGE CRASHED"));
page.on("close", () => console.log("Browser page closed"));
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(`${process.env.SF_PROBE_URL ?? 'http://localhost:5250'}/?autostart=1`, {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, {timeout: 180000});
  await page.waitForFunction(() => !window.__sf.worldArrival.active && document.body.classList.contains('started'), null, {timeout: 180000});
  console.log('World ready');
  await page.evaluate(async () => {
    window.timeTest = window.__sf.worldTime;
    window.__sf.frameDriver.setManual(true);
  });
  console.log("Manual clock ready");
  const tick = () => page.evaluate(() => window.__sf.tick(1/60));
  // Real keyboard and wheel events, including the unlocked pointer path.
  console.log('Sending X gesture');
  await page.keyboard.down('x');
  await page.mouse.move(500, 350);
  await page.mouse.wheel(-2000, 200);
  await page.waitForTimeout(80);
  await tick();
  assert.equal(await page.evaluate(() => window.timeTest.scale), 0);
  await page.keyboard.up('x');
  await tick();
  assert.equal(await page.evaluate(() => window.timeTest.scale), 0, 'release reset world speed');
  console.log("Freeze gesture passed");
  const frozen = await page.evaluate(() => {
    const { player, sky, chase, input } = window.__sf;
    const before = { player: player.time, world: player.environmentTime, sky: sky.timeOfDay, yaw: chase.yaw, clock: window.timeTest.nowMs() };
    for (let i = 0; i < 12; i++) window.__sf.tick(1/60);
    return { player: player.time - before.player, world: player.environmentTime - before.world,
      sky: sky.timeOfDay - before.sky, yaw: chase.yaw - before.yaw, clock: window.timeTest.nowMs() - before.clock,
      wheel: input.wheel, wheelX: input.wheelX };
  });
  assert(frozen.player > 0.15, 'player clock stopped');
  assert.equal(frozen.world, 0); assert.equal(frozen.clock, 0);
  assert.equal(frozen.wheel, 0); assert.equal(frozen.wheelX, 0);
  await page.keyboard.down('w');
  const frozenWalkDistance = await page.evaluate(() => {
    const start = window.__sf.player.position.clone();
    for (let i = 0; i < 20; i++) window.__sf.tick(1/60);
    return Math.hypot(window.__sf.player.position.x - start.x, window.__sf.player.position.z - start.z);
  });
  await page.keyboard.up('w');
  assert(frozenWalkDistance > 0.2, 'player could not walk through frozen world');
  await page.keyboard.down('x'); await page.mouse.wheel(500, 0); await page.waitForTimeout(80); await tick(); await page.keyboard.up('x');
  assert.equal(await page.evaluate(() => window.timeTest.scale), 0.5);
  await page.keyboard.down('x');
  await page.mouse.move(600, 350);
  await tick();
  await page.keyboard.up('x');
  assert(Math.abs(await page.evaluate(() => window.timeTest.scale) - 0.7) < 1e-9, 'mouse scrub did not change world speed');
  await page.mouse.move(500, 350); // keep wheel input over the world canvas
  const beforeZ = await page.evaluate(() => window.__sf.sky.timeOfDay);
  await page.keyboard.down('z'); await page.mouse.wheel(100, 0);
  await page.waitForTimeout(80);
  await tick(); await page.keyboard.up('z');
  assert(Math.abs(await page.evaluate(() => window.__sf.sky.timeOfDay) - beforeZ) > 0.001, 'Z time-of-day scrub regressed');
  assert(Math.abs(await page.evaluate(() => window.timeTest.scale) - 0.7) < 1e-9, 'Z changed world speed');
  console.log('World/player clock, mouse scrub and Z regression assertions passed');
  await page.keyboard.press('/'); await tick();
  await page.getByText('world time · X + ↔', {exact:true}).waitFor({timeout: 60000});
  const row = page.locator('.tp-lblv').filter({ has: page.getByText('world time · X + ↔', {exact:true}) });
  const field = row.locator('input[type="text"]');
  console.log("Panel ready");
  await field.fill('0.25'); await field.press('Enter');
  assert(Math.abs(await page.evaluate(() => window.timeTest.scale) - 0.25) < 1e-9, 'panel did not update shared clock');
  await page.evaluate(() => { window.timeTest.scale = 0.75; });
  await page.waitForTimeout(300); await tick();
  assert(Math.abs(Number(await field.inputValue()) - 0.75) < 1e-9, 'gesture state did not refresh panel');
  console.log(JSON.stringify({frozen, frozenWalkDistance, panelSynced:true, errors}));
  assert.deepEqual(errors, []);
} catch (error) { console.error(error); process.exitCode = 1; } finally {
  await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 5000))]);
}
