// Swimming, submersion and above/below rendering in the restored Sutro baths.
//
// Drives the real walk controller (no free-cam teleporting for the gameplay
// half): drops the capsule over a bath, checks it starts swimming and floats,
// dives it with the dive key, and asserts the underwater package, the audio
// muffle and the swim voice all follow. Screenshots cover the surface view, the
// waterline and the view from under the sheet.
//
//   SF_PROBE_URL=http://localhost:5240 node tools/sutro-swim-probe.mjs

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";

const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:65120").replace(/\/$/, "");
const OUT = process.env.SF_PROBE_OUT ?? ".data/sutro-swim-probe";
const SITE = { x: -6125, z: 1117, yaw: -0.077, waterY: 5.18, basinY: 2.62 };
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Bath V, the hottest of the graduated baths: local x -4..19, z 17..26.
const BATH_V = { x: 7.5, z: 21.5 };

function localPoint(x, y, z) {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
}

const results = [];
const expect = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=metal"]
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=sutroBaths`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.__sf?.renderer?.backend?.device && window.__sf?.sutroBaths?.debugState?.().nearEffectsLoaded,
    null,
    { timeout: 240_000 }
  );
  await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 240_000 });
  await page.evaluate(() => window.__sf.hud?.setHidden?.(true));
  // Audio needs a gesture before the engine will build a graph.
  await page.mouse.click(800, 500);
  await page.waitForTimeout(400);

  const canvas = page.locator("canvas").first();
  const shot = async (name) => {
    await canvas.screenshot({ path: path.join(OUT, name) });
    console.log("shot", name);
  };

  const state = () =>
    page.evaluate(() => {
      const sf = window.__sf;
      const p = sf.player;
      return {
        y: +p.position.y.toFixed(3),
        camY: +sf.camera.position.y.toFixed(3),
        swimming: p.swimming,
        mode: p.mode,
        uw: window.__uw ? +window.__uw.ease.toFixed(3) : null,
        audio: sf.audioEngine.debugState.submersion,
        swimAudio: sf.swimAudio.debugState,
        submergedWater: sf.sutroBaths.debugState().water.staticSurface === true,
        steamVisible: sf.sutroBaths.debugState().steam?.visible ?? null
      };
    });

  // --- walk in off the deck ------------------------------------------------
  // The teleport phases below prove the swim state; this proves you can reach
  // it the way a visitor does, which also means the coping is not a wall.
  await page.evaluate(([x, y, z]) => {
    // Face along local +x, straight across bath V from the deck beside it.
    window.__sf.chase.yaw = -1.65;
    window.__sf.player.teleportTo({ x, y, z, facing: -1.65, mode: "walk" });
  }, localPoint(-7.5, SITE.waterY + 1.2, 21.5));
  await page.waitForTimeout(1500);
  const onCoping = await state();
  expect("standing on the deck beside the bath", onCoping.swimming === false, onCoping);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(3000);
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(1200);
  const wadedIn = await state();
  console.log("wadedIn:", JSON.stringify(wadedIn));
  expect("walking off the coping starts you swimming", wadedIn.swimming === true, wadedIn);
  await shot("00-walked-in.png");

  // --- drop into the hottest bath -----------------------------------------
  await page.evaluate(([x, y, z]) => {
    window.__sf.player.teleportTo({ x, y, z, facing: 0, mode: "walk" });
  }, localPoint(BATH_V.x, SITE.waterY + 2.2, BATH_V.z));
  await page.waitForTimeout(2500);

  const floating = await state();
  console.log("floating:", JSON.stringify(floating));
  expect("swimming in the bath", floating.swimming === true, floating);
  expect(
    "floats at the waterline (capsule bottom under the surface, clear of the tiles)",
    floating.y - 0.9 < SITE.waterY && floating.y - 0.9 > SITE.basinY,
    { bottom: +(floating.y - 0.9).toFixed(3), waterY: SITE.waterY, basinY: SITE.basinY }
  );
  expect("eye stays dry while surface swimming", floating.camY > SITE.waterY, floating.camY);
  expect("swim voice is running", floating.swimAudio.presence > 0.2, floating.swimAudio);
  await shot("01-surface-swim.png");

  // Free-cam the waterline from outside so the sheet's two sides are both in
  // frame, then hand the camera back.
  await page.evaluate(
    ({ eye, target }) => window.__sfFreeCam(eye, target),
    { eye: localPoint(BATH_V.x - 6, SITE.waterY - 0.55, BATH_V.z), target: localPoint(19, SITE.waterY + 0.3, BATH_V.z) }
  );
  await page.waitForTimeout(1200);
  await shot("02-from-below-the-sheet.png");
  // Straight up from the bottom of the bath: Snell's window should be a bright
  // disc overhead fading to a rippled mirror at the rim.
  await page.evaluate(
    ({ eye, target }) => window.__sfFreeCam(eye, target),
    {
      eye: localPoint(BATH_V.x, SITE.basinY + 0.6, BATH_V.z),
      target: localPoint(BATH_V.x + 0.01, SITE.waterY + 6, BATH_V.z)
    }
  );
  await page.waitForTimeout(1200);
  await shot("02b-snell-window.png");
  await page.evaluate(() => window.__sfFreeCam(null));
  await page.waitForTimeout(600);

  // --- dive: Shift is the dive key while swimming --------------------------
  await page.keyboard.down("ShiftLeft");
  await page.waitForTimeout(2200);
  const diving = await state();
  console.log("diving:", JSON.stringify(diving));
  await shot("03-underwater.png");
  await page.keyboard.up("ShiftLeft");

  expect("dive takes the capsule under", diving.y < floating.y - 0.3, {
    floatingY: floating.y,
    divingY: diving.y
  });
  expect("dive never reaches the tiles", diving.y - 0.9 > SITE.basinY - 0.01, {
    bottom: +(diving.y - 0.9).toFixed(3),
    basinY: SITE.basinY
  });
  expect("eye goes under the waterline", diving.camY < SITE.waterY, diving.camY);
  expect("underwater package engages", (diving.uw ?? 0) > 0.5, diving.uw);
  expect("world audio is muffled", diving.audio > 0.4, diving.audio);
  expect("steam hides from under the sheet", diving.steamVisible === 0, diving.steamVisible);

  // --- surface again -------------------------------------------------------
  await page.keyboard.down("Space");
  await page.waitForTimeout(2000);
  await page.keyboard.up("Space");
  await page.waitForTimeout(1200);
  const surfaced = await state();
  console.log("surfaced:", JSON.stringify(surfaced));
  expect("underwater package releases on surfacing", (surfaced.uw ?? 1) < 0.2, surfaced.uw);
  expect("audio muffle releases on surfacing", surfaced.audio < 0.2, surfaced.audio);
  expect("still swimming at the surface", surfaced.swimming === true, surfaced);
  expect("steam returns above the sheet", (surfaced.steamVisible ?? 0) > 0, surfaced.steamVisible);
  await shot("04-surfaced.png");

  // --- climb out: the deck must still be walkable --------------------------
  await page.evaluate(([x, y, z]) => {
    window.__sf.player.teleportTo({ x, y, z, facing: 0, mode: "walk" });
  }, localPoint(-7, SITE.waterY + 2.5, 50));
  await page.waitForTimeout(2000);
  const onDeck = await state();
  console.log("onDeck:", JSON.stringify(onDeck));
  expect("dry land is not swimming", onDeck.swimming === false, onDeck);
  expect("dry land is not muffled", onDeck.audio < 0.05, onDeck.audio);

  // --- the great plunge: 84 m of open water for a swimmer's-eye look --------
  await page.evaluate(([x, y, z]) => {
    window.__sf.player.teleportTo({ x, y, z, facing: 0, mode: "walk" });
  }, localPoint(-20.5, SITE.waterY + 1.6, -30));
  await page.waitForTimeout(2500);
  const plunge = await state();
  console.log("greatPlunge:", JSON.stringify(plunge));
  expect("the great plunge swims too", plunge.swimming === true, plunge);
  await page.evaluate(
    ({ eye, target }) => window.__sfFreeCam(eye, target),
    {
      eye: localPoint(-20.5, SITE.waterY + 0.28, -30),
      target: localPoint(-20.5, SITE.waterY + 1.1, 26)
    }
  );
  await page.waitForTimeout(1200);
  await shot("05-swimmer-eye-great-plunge.png");
  await page.evaluate(() => window.__sfFreeCam(null));
  await page.waitForTimeout(400);

  // --- steam actually reaches the water ------------------------------------
  //
  // The regression this guards: the pool sheet is an alpha-1 surface, and under
  // this renderer's reversed depth buffer a HIGHER renderOrder draws EARLIER —
  // so a sheet ordered "under" the steam is in fact laid down last and repaints
  // every plume out of the frame. The symptom was steam banks down the hall and
  // a mirror-clean pool wherever you actually stood. Compare the lit water with
  // the steam group hidden: over the pool the two must differ.
  await page.evaluate(
    ({ eye, target }) => window.__sfFreeCam(eye, target),
    {
      eye: localPoint(BATH_V.x, SITE.waterY + 4.4, BATH_V.z + 1),
      target: localPoint(BATH_V.x, SITE.waterY, BATH_V.z)
    }
  );
  await page.waitForTimeout(1400);
  const withSteam = path.join(OUT, "06-steam-over-water.png");
  await canvas.screenshot({ path: withSteam });
  await page.evaluate(() => {
    window.__sf.scene.traverse((o) => {
      if (o.name === "sutro_baths_thermal_steam") o.visible = false;
    });
  });
  await page.waitForTimeout(900);
  const withoutSteam = path.join(OUT, "06-steam-hidden.png");
  await canvas.screenshot({ path: withoutSteam });
  await page.evaluate(() => {
    window.__sf.scene.traverse((o) => {
      if (o.name === "sutro_baths_thermal_steam") o.visible = true;
    });
    window.__sfFreeCam(null);
  });

  // Mean absolute difference over the middle of the frame, which is all open
  // water. Unsigned on purpose: whether a plume reads lighter or darker than
  // the pool under it depends on the hour, but "the sheet ate the steam" is
  // always a near-zero difference. The sheet's own ripple over the second
  // between captures contributes well under a point.
  const poolPixels = async (file) => {
    const image = sharp(file);
    const { width, height } = await image.metadata();
    return image
      .extract({
        left: Math.round(width * 0.25),
        top: Math.round(height * 0.3),
        width: Math.round(width * 0.5),
        height: Math.round(height * 0.45)
      })
      .removeAlpha()
      .raw()
      .toBuffer();
  };
  const [pixelsOn, pixelsOff] = await Promise.all([
    poolPixels(withSteam),
    poolPixels(withoutSteam)
  ]);
  let delta = 0;
  for (let i = 0; i < pixelsOn.length; i++) delta += Math.abs(pixelsOn[i] - pixelsOff[i]);
  delta = +(delta / pixelsOn.length).toFixed(2);
  expect("steam is composited over the pool, not repainted out by the sheet", delta > 6, {
    meanAbsoluteDifference: delta
  });

  await writeFile(path.join(OUT, "results.json"), JSON.stringify({ results }, null, 2));
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
