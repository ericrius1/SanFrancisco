// Placement audit for the restored Sutro Baths.
//
// The hall's contents are authored in four independent files — bathers.ts places
// people, parlour.ts places furniture, candles and lamps, vegetation.ts places
// planters and blooms, layout.ts owns the pool rectangles — and nothing made
// them agree. That produced exactly the failures you would expect: someone
// seated inside a poppy bed, a standing pair sharing ground with a candle stand,
// two overlapping benches with both occupants in the wreckage.
//
// So this measures the real thing: every person and every placed object in WORLD
// space, out of the live scene, and fails on any pair that occupies the same
// ground. It deliberately reads the scene rather than the authored tables, so it
// also catches whatever the shared vegetation runtime decides to plant.
//
// A seated person is expected to be inside their own chair, so seat furniture is
// exempt for them; what must hold is that nobody shares a seat and that nobody,
// seated or standing, is inside a plant pot, a candle, a lamp post or a table.
//
//   SF_PROBE_URL=http://localhost:5179 node tools/sutro-placement-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:5179").replace(/\/$/, "");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/sutro-placement-probe");
const SITE = { x: -6125, z: 1117, yaw: -0.077, deckY: 5.62 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function local(x, y, z) {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
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
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=sutroBaths`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForFunction(() => window.__sf?.sutroBaths, null, { timeout: 240_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 240_000 });
    await sleep(2500);
    // Stand inside so the site is awake and the whole cast has hydrated.
    await page.evaluate(
      ([x, y, z]) => window.__sf.player.restoreState({ x, y, z, heading: 0, mode: "walk" }),
      local(-7, SITE.deckY + 0.92, 0)
    );
    await sleep(6000);

    const report = await page.evaluate((deckY) => {
      const THREE = window.__sf.THREE;
      const scene = window.__sf.scene;
      const toLocal = (x, z) => {
        const dx = x + 6125;
        const dz = z - 1117;
        const c = Math.cos(-0.077);
        const s = Math.sin(-0.077);
        return { x: c * dx - s * dz, z: s * dx + c * dz };
      };
      const items = [];
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();

      const bathers = scene.getObjectByName("sutroBaths.bathers");
      for (const rig of bathers?.children ?? []) {
        const mesh = rig.children.find((child) => child.isSkinnedMesh);
        const at = toLocal(rig.position.x, rig.position.z);
        items.push({
          kind: "person",
          id: (mesh?.name ?? "?").replace("sutro_bather_", ""),
          x: rig.position.x,
          z: rig.position.z,
          y: rig.position.y,
          lx: Number(at.x.toFixed(2)),
          lz: Number(at.z.toFixed(2)),
          r: 0.3
        });
      }
      for (const rootName of ["sutro_baths_parlour", "sutro_baths_unified_foliage"]) {
        scene.getObjectByName(rootName)?.traverse((object) => {
          if (!object.isInstancedMesh) return;
          object.geometry.computeBoundingSphere();
          const base = object.geometry.boundingSphere?.radius ?? 0.2;
          for (let i = 0; i < object.count; i++) {
            object.getMatrixAt(i, m);
            m.decompose(p, q, sc);
            const world = p.clone().applyMatrix4(object.matrixWorld);
            const at = toLocal(world.x, world.z);
            items.push({
              kind: object.name.replace("sutro_parlour_", "").replace("sutro_baths_", ""),
              id: `${object.name}#${i}`,
              x: world.x,
              z: world.z,
              y: world.y,
              lx: Number(at.x.toFixed(2)),
              lz: Number(at.z.toFixed(2)),
              r: base * Math.max(sc.x, sc.z)
            });
          }
        });
      }

      const SEAT_KINDS = /^(chair_|bench_)/;
      const SITTING_BELOW = 0.8; // hips this far above the deck ⇒ seated
      const conflicts = [];
      const people = items.filter((item) => item.kind === "person");
      for (let a = 0; a < people.length; a++) {
        for (let b = a + 1; b < people.length; b++) {
          const A = people[a];
          const B = people[b];
          const d = Math.hypot(A.x - B.x, A.z - B.z);
          if (d < 0.62 && Math.abs(A.y - B.y) < 1.6) {
            conflicts.push({
              kind: "person/person",
              a: A.id,
              b: B.id,
              d: Number(d.toFixed(2)),
              at: [A.lx, A.lz]
            });
          }
        }
      }
      for (const person of people) {
        const sitting = person.y - deckY < SITTING_BELOW;
        for (const item of items) {
          if (item.kind === "person") continue;
          if (sitting && SEAT_KINDS.test(item.kind)) continue;
          if (item.y - person.y > 1.4 || person.y - item.y > 1.6) continue;
          const d = Math.hypot(person.x - item.x, person.z - item.z);
          // A seated person sits a chair's reach from their own table centre.
          if (sitting && item.kind === "table_tops" && d > 0.8) continue;
          const pad = /planter|blooms/.test(item.kind)
            ? 1.0
            : /candle|lamp/.test(item.kind)
              ? 0.34
              : 0.4;
          const limit = pad + Math.min(item.r, 0.9);
          if (d < limit) {
            conflicts.push({
              kind: `${sitting ? "seated" : "standing"}/${item.kind}`,
              a: person.id,
              b: item.id,
              d: Number(d.toFixed(2)),
              need: Number(limit.toFixed(2)),
              at: [person.lx, person.lz]
            });
          }
        }
      }
      const counts = {};
      for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
      return { counts, people: people.length, conflicts };
    }, SITE.deckY);

    const checks = [];
    const expect = (id, pass, detail) => {
      checks.push({ id, pass: Boolean(pass), detail });
      console.log(`[${pass ? "PASS" : "FAIL"}] ${id}`);
    };
    expect("cast-fully-hydrated", report.people >= 40, { people: report.people });
    const shared = report.conflicts.filter((c) => c.kind === "person/person");
    expect("nobody-shares-a-seat", shared.length === 0, shared.slice(0, 6));
    const inPlants = report.conflicts.filter((c) => /planter|blooms/.test(c.kind));
    expect("nobody-standing-in-the-planting", inPlants.length === 0, inPlants.slice(0, 6));
    const inProps = report.conflicts.filter((c) => /candle|lamp|table_tops/.test(c.kind));
    expect("nobody-inside-a-candle-lamp-or-table", inProps.length === 0, inProps.slice(0, 6));
    const inFurniture = report.conflicts.filter((c) => /^standing\/(chair_|bench_)/.test(c.kind));
    expect("nobody-standing-in-the-furniture", inFurniture.length === 0, inFurniture.slice(0, 6));
    expect("no-page-errors", pageErrors.length === 0, pageErrors.slice(0, 4));

    const pass = checks.every((check) => check.pass);
    await writeFile(
      path.join(OUT, "result.json"),
      JSON.stringify(
        { generatedAt: new Date().toISOString(), target: BASE_URL, pass, checks, ...report },
        null,
        2
      )
    );
    console.log(
      `[sutro-placement] ${report.people} people, ${Object.keys(report.counts).length} object kinds, ` +
        `${report.conflicts.length} raw conflicts`
    );
    console.log(`[sutro-placement] report: ${path.join(OUT, "result.json")}`);
    if (!pass) process.exitCode = 1;
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
