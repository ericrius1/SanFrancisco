// Real map/touch UI without the WebGPU world: usable in WebKit, whose test
// browser has no WebGPU. Run against Vite; SF_PROBE_BROWSER=webkit uses WebKit.
// SF_PROBE_URL=http://localhost:5251 node tools/mobile-map-browser-probe.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, webkit, devices } from "playwright-core";

const base = process.env.SF_PROBE_URL ?? "http://localhost:5251";
const engine = process.env.SF_PROBE_BROWSER ?? "chromium";
const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const styles = [...source.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(([s]) => s).join("\n");
const fixture = `<!doctype html><html class="touch-ui"><head>
<meta name="viewport" content="width=device-width,initial-scale=1">${styles}
</head><body class="started"><canvas id="world"></canvas><div id="hud"></div>
<script type="module">
import { Input } from '/src/core/input.ts';
import { installTouchControls } from '/src/ui/touchControls.ts';
import { Minimap } from '/src/ui/minimap.ts';
// Small terrain fixture; the production Input, touch DOM, map, and CSS run unchanged.
const map = {
  meta: { grid: { minX:-8000, minZ:-9000, width:100, height:100, cellSize:160 }, landmarks:{}, bridges:[] },
  heights: new Float32Array(10000), surface: new Uint8Array(10000), isWater: () => false
};
const self = { x:0, z:0, name:'Tester', fx:0, fz:1, hue:0 };
const input = new Input(document.querySelector('#world'));
installTouchControls(input);
const minimap = new Minimap(map, () => self, () => []);
const probe = window.probe = { input, minimap, transitions:[], teleports:[] };
minimap.onExpandChange = on => {
  probe.transitions.push(on);
  input.suspended = on;
  if (on) input.releaseLock(); // Same ownership handoff as worldSystemsNet.
};
minimap.onTeleport = (x, z) => probe.teleports.push({x, z});
function frame() {
  // The real renderer schedules another frame even if this frame throws.
  requestAnimationFrame(frame);
  input.pollDriver(1/60);
  if (input.pressedRaw('KeyM')) minimap.setExpanded(!minimap.expanded);
  minimap.update();
  input.endFrame();
}
frame();
</script></body></html>`;

const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  ...(engine === "webkit" ? {} : {
    executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  })
});
try {
  const page = await browser.newPage({ ...devices["iPhone 13"], deviceScaleFactor: 1 });
  const errors = [];
  const atlas = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/map/")) atlas.push(new URL(request.url()).pathname);
  });
  // iOS Safari has no Pointer Lock API. Reproduce that contract in Chromium too.
  await page.addInitScript(() => Object.defineProperty(document, "exitPointerLock", { configurable:true, value:undefined }));
  await page.route("**/__mobile-map-probe", route => route.fulfill({ contentType:"text/html", body:fixture }));
  await page.goto(new URL("/__mobile-map-probe", base).href);
  await page.waitForFunction(() => Boolean(window.probe));
  assert.deepEqual(atlas, [], "map art must remain unloaded before opening the map");

  await page.locator(".tc-map").tap();
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => ({ expanded:probe.minimap.expanded, transitions:probe.transitions }));
  assert.deepEqual(errors, [], "opening the map must not call an unavailable pointer-lock API");
  assert.equal(opened.expanded, true, "the map must stay open after a touch tap");
  assert.deepEqual(opened.transitions, [true], "one tap must open the map exactly once");
  assert.deepEqual(atlas, ["/map/historical-atlas/city-overview.webp"], "first activation loads only the map overview");

  const canvas = page.locator("canvas[data-big-map]");
  const rect = await canvas.boundingBox();
  await page.touchscreen.tap(rect.x + rect.width * 0.54, rect.y + rect.height * 0.53);
  const teleport = page.getByRole("button", { name:"Teleport to selected location" });
  await teleport.waitFor({ state:"visible" });
  await teleport.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const button = await teleport.boundingBox();
  assert.ok(button.width >= 44 && button.height >= 44, "teleport must have a usable touch target");
  await teleport.tap();
  const afterTeleport = await page.evaluate(() => ({ expanded:probe.minimap.expanded, teleports:probe.teleports }));
  assert.equal(afterTeleport.expanded, false, "teleport closes the map");
  assert.equal(afterTeleport.teleports.length, 1, "a teleport tap must reach the navigation callback exactly once");
  assert.ok(Number.isFinite(afterTeleport.teleports[0].x) && Number.isFinite(afterTeleport.teleports[0].z));

  await page.locator(".tc-map").tap();
  await page.getByRole("button", { name:"Close map" }).tap();
  assert.equal(await page.evaluate(() => probe.minimap.expanded), false, "close must work without a keyboard");
  assert.deepEqual(errors, []);
  assert.deepEqual(atlas, ["/map/historical-atlas/city-overview.webp"], "selecting, teleporting, and reopening must reuse the overview");
  console.log(`mobile map (${engine}): stable open, touch selection, teleport, close, and lazy atlas passed`);
} finally {
  await browser.close();
}
