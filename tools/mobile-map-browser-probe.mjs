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
  // Chromium delivers real multitouch through the browser input pipeline.
  // Playwright WebKit exposes taps only; exercise its PointerEvent handlers
  // with a capture shim, then finish with a native tap to verify selection.
  const cdp = engine === "chromium" ? await page.context().newCDPSession(page) : null;
  let fingers = [];
  if (!cdp) await canvas.evaluate(el => {
    const captured = new Set();
    el.setPointerCapture = id => captured.add(id);
    el.hasPointerCapture = id => captured.has(id);
    el.releasePointerCapture = id => captured.delete(id);
  });
  const touch = async (type, points) => {
    if (cdp) await cdp.send("Input.dispatchTouchEvent", {
      type,
      // CDP touchEnd lists the fingers being lifted; the helper takes those
      // remaining on the glass, matching a native TouchEvent.touches list.
      touchPoints:type === "touchEnd" && points.length
        ? fingers.filter(p=>!points.some(a=>a.id===p.id)) : points
    });
    else {
      await canvas.evaluate((el, {type, points, previous}) => {
        const emit = (name, point) => el.dispatchEvent(new PointerEvent(name, {
          bubbles:true, cancelable:true, pointerType:"touch", pointerId:point.id,
          isPrimary:point.id===1, clientX:point.x, clientY:point.y,
          button:0, buttons:name==="pointerup"||name==="pointercancel"?0:1
        }));
        if (type === "touchStart") for (const p of points) {
          if (!previous.some(a=>a.id===p.id)) emit("pointerdown", p);
        }
        if (type === "touchMove") for (const p of points) emit("pointermove", p);
        if (type === "touchEnd" || type === "touchCancel") for (const p of previous) {
          if (!points.some(a=>a.id===p.id)) emit(type==="touchCancel"?"pointercancel":"pointerup", p);
        }
      }, {type,points,previous:fingers});
    }
    fingers = points;
    // Native touch moves may be coalesced until the next browser frame.
    if (cdp) await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  const read = () => page.evaluate(()=>probe.minimap.debugState());
  await page.evaluate(()=>probe.minimap.focusWorldPoint(0,0,6000));
  const r = await canvas.boundingBox();
  const cx = r.x+r.width*.58, cy = r.y+r.height*.54;
  const pair = (distance, dx=0, dy=0) => [
    {id:1,x:cx+dx-distance/2,y:cy+dy}, {id:2,x:cx+dx+distance/2,y:cy+dy}
  ];
  const worldAt = (state,x,y) => ({
    x:state.center.x+((x-r.x)/r.width-.5)*state.spanX,
    z:state.center.z+((y-r.y)/r.height-.5)*state.spanZ
  });
  const near = (a,b,message) => assert.ok(Math.abs(a-b)<1,`${message}: ${a} vs ${b}`);
  const before = await read(), anchor = worldAt(before,cx,cy);
  await touch("touchStart",pair(80).slice(0,1));
  await touch("touchStart",pair(80));
  await touch("touchMove",pair(160));
  const zoomed = await read();
  near(zoomed.spanX,before.spanX/2,"spreading fingers doubles magnification");
  near(worldAt(zoomed,cx,cy).x,anchor.x,"pinch preserves horizontal focal point");
  near(worldAt(zoomed,cx,cy).z,anchor.z,"pinch preserves vertical focal point");
  await touch("touchMove",pair(160,12,15));
  const panned = await read();
  near(worldAt(panned,cx+12,cy+15).x,anchor.x,"two fingers also pan horizontally");
  near(worldAt(panned,cx+12,cy+15).z,anchor.z,"two fingers also pan vertically");
  const remaining = pair(160,12,15).slice(1);
  await touch("touchEnd",remaining);
  near((await read()).center.x,panned.center.x,"lifting one finger must not jump");
  await touch("touchMove",remaining.map(p=>({...p,x:p.x+20})));
  near((await read()).center.x,panned.center.x-20/r.width*panned.spanX,"remaining finger continues panning");
  await touch("touchEnd",[]);
  assert.equal((await read()).selection,null,"pinch must not select a teleport destination");
  await page.waitForTimeout(80);
  await canvas.dispatchEvent("click",{clientX:cx,clientY:cy});
  assert.equal((await read()).selection,null,"late compatibility click must also be suppressed");
  assert.equal(await page.evaluate(()=>visualViewport.scale),1,"pinch zooms the map, not the browser page");
  await page.touchscreen.tap(cx,cy);
  assert.notEqual((await read()).selection,null,"first tap after a pinch must still select");

  await page.evaluate(()=>probe.minimap.focusWorldPoint(0,0,4000));
  await touch("touchStart",pair(160));
  await touch("touchMove",pair(80));
  near((await read()).spanX,8000,"bringing fingers together zooms out");
  await touch("touchMove",pair(2));
  near((await read()).spanX,16000,"zoom out respects map bounds");
  await touch("touchCancel",[]);
  await page.evaluate(()=>probe.minimap.focusWorldPoint(0,0,4000));
  await touch("touchStart",pair(40));
  await touch("touchMove",pair(240));
  near((await read()).spanX,1200,"zoom in respects the closest detail level");
  await touch("touchCancel",[]);
  await page.touchscreen.tap(cx,cy);
  assert.notEqual((await read()).selection,null,"cancelled pinch must not leave fingers stuck");
  // Closing while two fingers are down must release their state on reopen.
  await page.evaluate(()=>probe.minimap.focusWorldPoint(0,0,4000));
  await touch("touchStart",pair(80));
  await page.evaluate(()=>probe.minimap.setExpanded(false));
  await touch("touchEnd",[]);
  await page.locator(".tc-map").tap();
  await page.waitForFunction(()=>probe.minimap.expanded);
  await page.touchscreen.tap(cx,cy);
  assert.notEqual((await read()).selection,null,"reopened map accepts a fresh tap");
  // Mouse/trackpad zoom still uses the same span and selection rules.
  const wheelBefore = (await read()).spanX;
  await page.mouse.move(cx,cy);
  if (cdp) await page.mouse.wheel(0,-150);
  else await canvas.dispatchEvent("wheel",{deltaY:-150,clientX:cx,clientY:cy});
  await page.waitForFunction(span=>probe.minimap.debugState().spanX<span,wheelBefore);
  assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(()=>probe.teleports.length),1,"gestures must never teleport");
  console.log(`mobile map (${engine}): open/select/teleport, pinch in/out, focal point, two-finger pan, finger handoff, bounds, cancellation, reopen and wheel passed`);
} finally {
  await browser.close();
}
