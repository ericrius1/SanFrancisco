// One-off introspection of the live Sutro hall: what the materials actually
// are at runtime, and whether staticAmbience's grade/glass/lamp writes landed.
//
//   SF_PROBE_URL=http://localhost:PORT node tools/sutro-introspect.mjs

import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:5240").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    try {
      await access(c);
      return c;
    } catch {
      /* next */
    }
  }
  throw new Error("no chrome");
}

const browser = await chromium.launch({
  executablePath: await findChrome(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
    "--use-angle=metal",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--mute-audio"
  ]
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e)));

await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=sutroBaths`, {
  waitUntil: "domcontentloaded",
  timeout: 120_000
});
await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 180_000 });
await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 180_000 });
await sleep(4000);

const out = await page.evaluate(() => {
  const sf = window.__sf;
  const byMaterial = new Map();
  let meshCount = 0;
  // The authored region root, wherever it hangs.
  sf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.name || "";
    const parentChain = [];
    let p = o;
    while (p) {
      if (p.name) parentChain.push(p.name);
      p = p.parent;
    }
    const chain = parentChain.join("/");
    if (!/sutro/i.test(chain) && !/sutro/i.test(n)) return;
    meshCount++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (!byMaterial.has(m)) {
        byMaterial.set(m, {
          name: m.name,
          ctor: m.constructor?.name,
          isMeshStandardMaterial: m.isMeshStandardMaterial === true,
          isNodeMaterial: m.isNodeMaterial === true,
          transparent: m.transparent,
          depthWrite: m.depthWrite,
          opacity: m.opacity,
          roughness: m.roughness,
          metalness: m.metalness,
          emissiveIntensity: m.emissiveIntensity,
          emissiveHex: m.emissive?.getHexString?.() ?? null,
          colorHex: m.color?.getHexString?.() ?? null,
          hasEmissiveNode: Boolean(m.emissiveNode),
          hasColorNode: Boolean(m.colorNode),
          meshes: []
        });
      }
      const e = byMaterial.get(m);
      if (e.meshes.length < 4) e.meshes.push(n);
    }
  });

  // Water material specifically.
  let water = null;
  sf.scene.traverse((o) => {
    if (o.isMesh && /sutro.*water|water.*sutro/i.test(o.name || "")) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      water = {
        mesh: o.name,
        ctor: m?.constructor?.name,
        roughness: m?.roughness,
        metalness: m?.metalness,
        envMap: Boolean(m?.envMap),
        envMapIntensity: m?.envMapIntensity,
        transparent: m?.transparent
      };
    }
  });

  return {
    meshCount,
    environmentIntensity: sf.scene.environmentIntensity,
    hasEnvironmentNode: Boolean(sf.scene.environmentNode),
    environmentNodeCtor: sf.scene.environmentNode?.constructor?.name ?? null,
    sceneEnvironment: Boolean(sf.scene.environment),
    toneMappingExposure: sf.renderer.toneMappingExposure,
    lightCount: (() => {
      let n = 0;
      const kinds = [];
      sf.scene.traverse((o) => {
        if (o.isLight) {
          n++;
          kinds.push(`${o.type}:${o.name || "?"}:${o.intensity}`);
        }
      });
      return { n, kinds };
    })(),
    sutro: sf.sutroBaths?.debugState?.() ?? null,
    water,
    materials: [...byMaterial.values()]
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
