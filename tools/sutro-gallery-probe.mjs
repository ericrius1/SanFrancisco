#!/usr/bin/env node

// Lazy-loading contract for the Sutro hall's timber gallery and its pictures.
//
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/sutro-gallery-probe.mjs
//
// The gallery's media (one grain tile pair under /sutro/timber, eight
// chromolithograph plates under /sutro/art) is the kind of optional site media
// docs/LAZY_LOADING.md exists for, and tools/sutro-baths-probe.mjs cannot see it:
// its classifier only tracks the region GLB, the tile, and modules under
// src/world/sutroBaths. So this probe watches the real request waterfall across
// the three phases the contract names.
//
//   boot        far from the baths — ZERO gallery requests
//   activation  the site loads — the grain pair and every hung plate, once
//   subsequent  a lap of the hall — nothing refetched
//
// It also checks the wall itself: the bleachers are gone from the authored
// region, the boards and pictures are actually in the scene, and the pictures
// carry their maps by the time the site is revealed.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const OUT = path.join(ROOT, ".data/sutro-gallery-probe");

/** Every plate hung in timberGallery.ts, plus the shared grain pair. */
const EXPECTED_MEDIA = [
  "/sutro/timber/hall-timber-basecolor.webp",
  "/sutro/timber/hall-timber-normal.webp",
  "/sutro/art/hall-pacific-plunge.webp",
  "/sutro/art/hall-seal-rocks.webp",
  "/sutro/art/hall-carnival-night.webp",
  "/sutro/art/hall-conservatory-palms.webp",
  "/sutro/art/bill-grand-opening.webp",
  "/sutro/art/bill-swimming-carnival.webp",
  "/sutro/art/plate-tropical-ferns.webp",
  "/sutro/art/plate-museum-curios.webp"
];

const checks = [];
const expect = (id, pass, detail) => {
  checks.push({ id, pass: Boolean(pass), detail });
  process.stdout.write(`[${pass ? "PASS" : "FAIL"}] ${id}\n`);
};

const isGalleryMedia = (pathname) =>
  pathname.startsWith("/sutro/timber/") || pathname.startsWith("/sutro/art/");

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
    } catch {
      /* keep looking */
    }
  }
  throw new Error("No Chrome/Chromium found; set CHROME_BIN.");
}

async function waitHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* server still coming up */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Dev server never answered at ${url}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(BASE_URL);
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

  const requests = [];
  let phase = "boot";
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    page.on("request", (request) => {
      let pathname = request.url();
      try {
        pathname = new URL(request.url()).pathname;
      } catch {
        /* data: urls and the like */
      }
      if (isGalleryMedia(pathname)) requests.push({ phase, pathname });
    });

    // --- boot, deliberately on the other side of the city -------------------
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=missionDolores`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    await page.waitForFunction(() => Boolean(window.__sf?.player), null, { timeout: 180_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 180_000 });
    await page.waitForTimeout(2000);
    const bootRequests = requests.filter((record) => record.phase === "boot");
    expect("boot-zero-gallery-media", bootRequests.length === 0, bootRequests);
    expect(
      "boot-site-unconstructed",
      await page.evaluate(() => !window.__sf.sutroBaths),
      null
    );

    // --- activation: travel to the baths ------------------------------------
    phase = "activation";
    // The app's own landmark teleport — the same entry the minimap uses — so the
    // covered arrival runs exactly as it does for a player.
    await page.evaluate(() => {
      const arrival = window.__sf.authoredRegions.arrivalForKey("sutroBaths");
      window.__sf.teleportToTarget(arrival.x, arrival.z, "Sutro Baths · 1896");
    });
    await page.waitForFunction(() => Boolean(window.__sf.sutroBaths), null, { timeout: 180_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 180_000 });
    await page.waitForTimeout(4000);

    const activation = requests.filter((record) => record.phase === "activation");
    const seen = new Set(activation.map((record) => record.pathname));
    const missing = EXPECTED_MEDIA.filter((media) => !seen.has(media));
    const unexpected = [...seen].filter((media) => !EXPECTED_MEDIA.includes(media));
    const duplicated = [...seen].filter(
      (media) => activation.filter((record) => record.pathname === media).length > 1
    );
    expect("activation-every-plate-requested", missing.length === 0, missing);
    expect("activation-nothing-extra-requested", unexpected.length === 0, unexpected);
    expect("activation-each-media-requested-once", duplicated.length === 0, duplicated);

    // --- the wall itself ----------------------------------------------------
    const wall = await page.evaluate(() => {
      const scene = window.__sf.scene;
      const stats = window.__sf.sutroBaths?.stats ?? null;
      let bleachers = 0;
      let boards = null;
      const artMeshes = [];
      scene.traverse((object) => {
        if (/bleacher|spectator/i.test(object.name)) bleachers++;
        if (object.name === "sutro_gallery_boards") {
          boards = {
            visible: object.visible,
            triangles: (object.geometry?.getIndex()?.count ?? 0) / 3,
            hasMap: Boolean(object.material?.map),
            hasNormalMap: Boolean(object.material?.normalMap),
            vertexColors: object.material?.vertexColors === true
          };
        }
        if (object.name?.startsWith("sutro_gallery_art_")) {
          artMeshes.push({
            name: object.name,
            visible: object.visible,
            hasMap: Boolean(object.material?.map),
            hasEmissiveMap: Boolean(object.material?.emissiveMap)
          });
        }
      });
      return { stats, bleachers, boards, artMeshes };
    });
    expect("wall-no-bleachers-remain", wall.bleachers === 0, wall.bleachers);
    expect("wall-boards-present", Boolean(wall.boards) && wall.boards.triangles > 1000, wall.boards);
    expect(
      "wall-boards-textured",
      Boolean(wall.boards?.hasMap && wall.boards?.hasNormalMap && wall.boards?.vertexColors),
      wall.boards
    );
    expect(
      "wall-every-plate-mesh-mapped",
      wall.artMeshes.length === EXPECTED_MEDIA.length - 2 &&
        wall.artMeshes.every((mesh) => mesh.hasMap && mesh.hasEmissiveMap),
      wall.artMeshes
    );
    expect(
      "wall-stats-report-gallery",
      (wall.stats?.galleryBoards ?? 0) > 500 && (wall.stats?.galleryArtworks ?? 0) >= 14,
      wall.stats
    );

    // --- subsequent: walk the hall, nothing refetched ------------------------
    phase = "subsequent";
    await page.evaluate(() => {
      const sf = window.__sf;
      const site = sf.sutroBaths;
      if (!site) return;
      const { x, y, z } = sf.player.position;
      sf.player.restoreState({ x: x + 40, y, z: z - 30, heading: sf.player.heading, mode: "walk" });
    });
    await page.waitForTimeout(4000);
    const subsequent = requests.filter((record) => record.phase === "subsequent");
    expect("subsequent-zero-refetch", subsequent.length === 0, subsequent);

    await writeFile(
      path.join(OUT, "result.json"),
      JSON.stringify(
        { generatedAt: new Date().toISOString(), target: BASE_URL, checks, requests, wall },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }

  const failed = checks.filter((check) => !check.pass);
  process.stdout.write(
    `\n[sutro-gallery] ${checks.length - failed.length}/${checks.length} checks passed · ` +
      `report ${path.relative(ROOT, path.join(OUT, "result.json"))}\n`
  );
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
