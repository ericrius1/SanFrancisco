import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5243";
const OUTPUT = resolve(".data/phoenix/phoenix-runtime.png");
const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const requests = [];
const errors = [];

page.on("request", (request) => {
  const url = request.url();
  if (url.includes("phoenix") || /\/assets\/asset-[^/]+\.js/.test(url)) requests.push(url);
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(`${URL}/?autostart=1&fullfps`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 120_000 });
  await page.waitForTimeout(750);

  const bootRequests = [...requests];
  assert(!bootRequests.some((url) => url.includes("phoenix-hero")), "phoenix hero loaded before bird activation");
  assert(!bootRequests.some((url) => /\/models\/phoenix\.glb(?:\?|$)/.test(url)), "legacy phoenix loaded at boot");

  const heroResponse = page.waitForResponse(
    (response) => response.url().includes("/models/phoenix-hero.glb") && response.status() === 200,
    { timeout: 30_000 }
  );
  await page.evaluate(() => window.__sf.player.trySwitch("bird"));
  await heroResponse;
  await page.waitForFunction(
    () => window.__sf.player.meshes.bird.userData.rig && window.__sf.player.meshes.bird.userData.phoenixAsset,
    null,
    { timeout: 30_000 }
  );
  await page.waitForTimeout(2500);

  const runtime = await page.evaluate(() => {
    const { player, renderer, THREE } = window.__sf;
    const root = player.meshes.bird;
    let meshes = 0;
    let skinnedMeshes = 0;
    let triangles = 0;
    const materials = [];
    const attributes = [];
    root.traverse((object) => {
      if (!object.isMesh) return;
      meshes++;
      if (object.isSkinnedMesh) skinnedMeshes++;
      const geometry = object.geometry;
      triangles += geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position").count / 3;
      attributes.push(Object.keys(geometry.attributes));
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.push({
          type: material.type,
          name: material.name,
          hasPositionNode: !!material.positionNode,
          hasEmissiveNode: !!material.emissiveNode,
          hasThicknessNode: !!material.thicknessColorNode,
          hasBaseColor: !!material.map,
          hasNormal: !!material.normalMap,
          hasOrm: !!material.roughnessMap && !!material.metalnessMap
        });
      }
    });
    const bounds = new THREE.Box3().setFromObject(root);
    const size = bounds.getSize(new THREE.Vector3());
    return {
      mode: player.mode,
      asset: root.userData.phoenixAsset,
      meshes,
      skinnedMeshes,
      triangles,
      materials,
      attributes,
      trails: root.userData.trailPoints?.map((point) => point.name),
      wingTips: root.userData.wingTips?.map((point) => point.name),
      bounds: { x: size.x, y: size.y, z: size.z },
      frame: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }
    };
  });

  assert.equal(runtime.mode, "bird");
  assert.deepEqual(runtime.asset, { url: "/models/phoenix-hero.glb", lod: 0, featherMode: "tsl-vertex" });
  assert.equal(runtime.meshes, 1, `expected one phoenix draw mesh, got ${runtime.meshes}`);
  assert.equal(runtime.skinnedMeshes, 1, `expected one skinned phoenix mesh, got ${runtime.skinnedMeshes}`);
  assert.equal(runtime.triangles, 58_000);
  assert(runtime.materials.every((material) => material.type === "MeshSSSNodeMaterial"));
  assert(runtime.materials.every((material) => material.hasPositionNode && material.hasEmissiveNode && material.hasThicknessNode));
  assert(runtime.materials.every((material) => material.hasBaseColor && material.hasNormal && material.hasOrm));
  assert(runtime.attributes.every((names) => ["phxDynamics", "phxStyle"].every((name) => names.includes(name))));
  assert.deepEqual(runtime.trails, ["PHX_Gen_Trail_L", "PHX_Gen_Trail_R"]);
  assert.deepEqual(runtime.wingTips, ["PHX_Gen_Wingtip_L", "PHX_Gen_Wingtip_R"]);
  assert(!requests.some((url) => /\/models\/phoenix\.glb(?:\?|$)/.test(url)), "legacy phoenix was requested");
  assert.equal(requests.filter((url) => url.includes("/models/phoenix-hero.glb")).length, 1);
  assert.equal(errors.length, 0, `browser errors:\n${errors.join("\n")}`);

  mkdirSync(dirname(OUTPUT), { recursive: true });
  await page.screenshot({ path: OUTPUT });
  writeFileSync(resolve(".data/phoenix/phoenix-runtime.json"), JSON.stringify({ runtime, requests }, null, 2));
  console.log(JSON.stringify({ ok: true, screenshot: OUTPUT, runtime, requests }, null, 2));
} finally {
  await browser.close();
}
