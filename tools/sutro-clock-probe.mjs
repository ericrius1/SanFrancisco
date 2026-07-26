// The pavilion clock has to TELL THE TIME, and the time it tells has to be the
// hall's own.
//
// The Blender-authored region ships a placeholder clock whose hands are frozen
// at whatever angle they were modelled at. src/world/sutroBaths/pavilionClock.ts
// hides that node and draws a working clock in its place, reading the hour the
// sky is actually rendering — which inside the out-of-time pocket is the solved
// twilight hour, not the world's wall clock.
//
// So this measures the hands, not the intent: it reads the hand meshes' roll out
// of the live scene, converts them back to an hour, and checks that hour against
// the sky's own authority. It then walks the player out of the pocket, waits for
// the authority to be handed back, and checks the hands followed.
//
//   SF_PROBE_URL=http://localhost:5240 node tools/sutro-clock-probe.mjs
//
// Evidence (screenshots + report.json) lands in .data/sutro-clock-probe.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:5240").replace(/\/$/, "");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/sutro-clock-probe");
const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Site-local metres → world. Mirrors sutroLocalToWorld in layout.ts. */
function toWorld(x, z) {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, SITE.z - s * x + c * z];
}

/** Smallest separation between two decimal hours on a 12-hour dial. */
function hourGap(a, b) {
  const delta = Math.abs((((a - b) % 12) + 12) % 12);
  return Math.min(delta, 12 - delta);
}

async function findChrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

/** Read the clock out of the scene the way a visitor reads it: off the hands. */
const readDial = () => {
  const scene = window.__sf.scene;
  const find = (name) => scene.getObjectByName(name) ?? null;
  const hour = find("sutro_pavilion_clock_hour_hand");
  const minute = find("sutro_pavilion_clock_minute_hand");
  const rotor = find("sutro_pavilion_clock_sun_moon");
  const metalwork = find("sutro_pavilion_clock_metalwork");
  const dial = find("sutro_pavilion_clock_dial");
  const placeholder = find("sutro_baths_pavilion_clock");
  if (!hour || !minute) return { error: "clock hands missing from scene" };

  // Hands roll clockwise, which is negative about the dial's +z.
  const turns = (mesh, perTurn) => {
    const raw = (-mesh.rotation.z / (Math.PI * 2)) * perTurn;
    return ((raw % perTurn) + perTurn) % perTurn;
  };
  const shownHour = turns(hour, 12);
  const shownMinute = turns(minute, 60);

  const state = window.__sf.sutroBaths.debugState();
  const sky = window.__sf.sky;
  let triangles = 0;
  let draws = 0;
  for (const mesh of [hour, minute, find("sutro_pavilion_clock_second_hand"), rotor, metalwork, dial]) {
    if (!mesh) continue;
    draws++;
    triangles += mesh.geometry.attributes.position.count / 3;
  }
  return {
    shownHour,
    shownMinute,
    clockHour: state.clockHour,
    twilight: state.twilight,
    skyTimeOfDay: sky.timeOfDay,
    skyAuthority: sky.timeAuthority,
    rotorRollDeg: rotor ? (rotor.rotation.z * 180) / Math.PI : null,
    placeholderPresent: Boolean(placeholder),
    placeholderVisible: placeholder ? placeholder.visible : null,
    materials: [metalwork?.material?.name, dial?.material?.name],
    draws,
    triangles
  };
};

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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const checks = [];
  const expect = (id, pass, detail) => {
    checks.push({ id, pass: Boolean(pass), detail });
    console.log(`[${pass ? "PASS" : "FAIL"}] ${id}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };

  try {
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=sutroBaths`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForFunction(() => window.__sf?.sutroBaths, null, { timeout: 240_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 240_000 });
    await sleep(3000);
    // The HUD would sit on top of every screenshot; the canvas is the evidence.
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      for (const node of document.body.children) {
        if (node.contains(canvas)) continue;
        node.style.setProperty("opacity", "0", "important");
      }
    });

    // ---------------------------------------------------------- inside the pocket
    const [ix, iz] = toWorld(-7, -40);
    await page.evaluate(
      ([x, y, z]) => window.__sf.player.restoreState({ x, y, z, heading: 0, mode: "walk" }),
      [ix, 6.54, iz]
    );
    await sleep(9000);

    const inside = await page.evaluate(readDial);
    if (inside.error) throw new Error(inside.error);

    expect("placeholder-hidden", inside.placeholderPresent && inside.placeholderVisible === false, {
      present: inside.placeholderPresent,
      visible: inside.placeholderVisible
    });
    expect("pocket-holds-the-sky", inside.twilight.authorityHeld && inside.twilight.skyBlend > 0.99, {
      authorityHeld: inside.twilight.authorityHeld,
      skyBlend: Number(inside.twilight.skyBlend.toFixed(3))
    });
    // The whole point: the hands agree with the hour the sky is rendering.
    expect(
      "hands-read-the-pocket-hour",
      hourGap(inside.shownHour, inside.skyAuthority ?? inside.skyTimeOfDay) < 0.05,
      {
        shownHour: Number(inside.shownHour.toFixed(3)),
        skyAuthority: Number((inside.skyAuthority ?? inside.skyTimeOfDay).toFixed(3))
      }
    );
    expect(
      "minute-hand-agrees-with-hour-hand",
      Math.abs(inside.shownMinute - (inside.shownHour % 1) * 60) < 0.6,
      {
        shownMinute: Number(inside.shownMinute.toFixed(2)),
        fromHourHand: Number(((inside.shownHour % 1) * 60).toFixed(2))
      }
    );
    // The pocket solves an evening between late gold and civil twilight, so a
    // clock that agrees with it must be reading somewhere in the evening.
    expect(
      "pocket-hour-is-the-evening",
      inside.clockHour > inside.twilight.sunsetHour - 0.2 &&
        inside.clockHour < inside.twilight.twilightHour + 0.2,
      {
        clockHour: Number(inside.clockHour.toFixed(3)),
        sunset: Number(inside.twilight.sunsetHour.toFixed(3)),
        twilight: Number(inside.twilight.twilightHour.toFixed(3))
      }
    );
    // Sun-and-moon aperture: |roll| is the sun's angle from the zenith, so at
    // the pocket's hour it must be near — but not past — the horizon at 90°.
    expect(
      "sun-sits-at-the-horizon",
      Math.abs(Math.abs(inside.rotorRollDeg) - 90) < 20,
      { rotorRollDeg: Number(inside.rotorRollDeg.toFixed(2)) }
    );
    // West is dial-LEFT for a visitor facing north, and a positive roll about
    // +z carries the sun that way.
    expect("sun-is-in-the-west", inside.rotorRollDeg > 0, {
      rotorRollDeg: Number(inside.rotorRollDeg.toFixed(2))
    });
    expect("two-materials-six-draws", inside.draws === 6 && new Set(inside.materials).size === 2, {
      draws: inside.draws,
      materials: inside.materials
    });
    expect("triangle-budget", inside.triangles < 12_000, { triangles: inside.triangles });

    for (const shot of [
      { id: "clock-close", at: [0, 21, -66.2], look: [0, 21, -70.6] },
      { id: "pavilion", at: [0, 18, -56], look: [0, 20.6, -70.6] },
      { id: "from-the-deck", at: [-20, 9, -10], look: [0, 16, -70] }
    ]) {
      const [fx, fz] = toWorld(shot.at[0], shot.at[2]);
      const [tx, tz] = toWorld(shot.look[0], shot.look[2]);
      await page.evaluate(
        ([a, b, c, d, e, f]) => window.__sfFreeCam([a, b, c], [d, e, f]),
        [fx, shot.at[1], fz, tx, shot.look[1], tz]
      );
      await sleep(2200);
      await writeFile(path.join(OUT, `${shot.id}.png`), await page.screenshot({ type: "png" }));
    }
    await page.evaluate(() => window.__sfFreeCam(null));

    // ------------------------------------------------------- back out of the pocket
    // Out on the beach the pocket must release the sky, and the hands must
    // follow the world's own clock back.
    const [ox, oz] = toWorld(-7, 200);
    await page.evaluate(
      ([x, y, z]) => window.__sf.player.restoreState({ x, y, z, heading: 0, mode: "walk" }),
      [ox, 6.54, oz]
    );
    await sleep(14_000);
    const outside = await page.evaluate(readDial);

    expect("authority-handed-back", outside.skyAuthority === null, {
      skyAuthority: outside.skyAuthority
    });
    expect("hands-follow-the-world-clock", hourGap(outside.shownHour, outside.skyTimeOfDay) < 0.05, {
      shownHour: Number(outside.shownHour.toFixed(3)),
      skyTimeOfDay: Number(outside.skyTimeOfDay.toFixed(3))
    });
    expect("clock-actually-moved", hourGap(outside.shownHour, inside.shownHour) > 0.05, {
      inside: Number(inside.shownHour.toFixed(3)),
      outside: Number(outside.shownHour.toFixed(3))
    });
    expect("no-page-errors", pageErrors.length === 0, pageErrors.slice(0, 4));

    const failed = checks.filter((check) => !check.pass);
    await writeFile(
      path.join(OUT, "report.json"),
      JSON.stringify({ url: BASE_URL, inside, outside, checks }, null, 2)
    );
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · evidence in ${OUT}`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
