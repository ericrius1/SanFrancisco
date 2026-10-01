// Real touch DOM/Input/time easing, with a tiny sky fixture so WebKit can run it
// without WebGPU. SF_PROBE_BROWSER=webkit; SF_PROBE_URL points at Vite.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, webkit, devices } from 'playwright-core';
const base = process.env.SF_PROBE_URL ?? 'http://localhost:5251';
const engine = process.env.SF_PROBE_BROWSER ?? 'chromium';
const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const styles = [...source.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(([s]) => s).join('\n');
const fixture = `<!doctype html><html class="touch-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body class="started"><canvas id="world"></canvas><div id="hud"></div>
<script type="module">
import { Input } from '/src/core/input.ts';
import { installTouchControls } from '/src/ui/touchControls.ts';
import { createTimeScrubAndTuningGestures } from '/src/app/compose/timeScrub.ts';
const input = new Input(document.querySelector('#world'));
const sky = {timeOfDay:23, cycleEnabled:true, advanceCivilHours(h){this.timeOfDay=(this.timeOfDay+h+24)%24}};
const controls = installTouchControls(input, () => sky.timeOfDay);
const gestures = createTimeScrubAndTuningGestures({input,sky,hud:{message(){}}});
window.probe = {input,sky,controls,look:0,surf:0,blocked:false};
function frame(){
 requestAnimationFrame(frame); input.pollDriver(1/60);
 gestures.update(1/60,false,false,false,!probe.blocked);
 probe.look += Math.abs(input.mouseDX)+Math.abs(input.mouseDY);
 probe.surf += Math.abs(input.surfDX)+Math.abs(input.surfDY);
 input.endFrame();
}
frame();
</script></body></html>`;
const browser = await (engine === 'webkit' ? webkit : chromium).launch({headless:true,...(engine === 'webkit' ? {} : {executablePath:process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'})});
await mkdir('.data/mobile-audio-time',{recursive:true});
try {
 const page = await browser.newPage({...devices['iPhone 13'],deviceScaleFactor:1});
 const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/__mobile-time-probe',r=>r.fulfill({contentType:'text/html',body:fixture}));
 await page.goto(new URL('/__mobile-time-probe',base).href);
 await page.waitForFunction(()=>window.probe);
 const clock=page.getByRole('slider',{name:'Time of day. Drag left or right'});
 const box=await clock.boundingBox();
 assert.ok(box.width>=44&&box.height>=44);
 const drag = async (dx) => {
  const r=await clock.boundingBox(); const x=r.x+20, y=r.y+r.height/2;
  await page.mouse.move(x,y); await page.mouse.down();
  await page.mouse.move(x+dx,y,{steps:12}); await page.mouse.up();
 };
 await drag(80);
 await page.waitForFunction(()=>probe.sky.cycleEnabled);
 assert.ok(Math.abs(await page.evaluate(()=>probe.sky.timeOfDay)-3)<.02,'80px scrub advances four hours across midnight');
 assert.match(await clock.getAttribute('aria-valuetext'),/AM/);
 await page.evaluate(()=>probe.input.setMode('surf'));
 await drag(-80);
 await page.waitForFunction(()=>probe.sky.cycleEnabled);
 const state=await page.evaluate(()=>({hour:probe.sky.timeOfDay,look:probe.look,surf:probe.surf}));
 assert.ok(Math.abs(state.hour-23)<.02);
 assert.equal(state.look,0,'time drag must not move the camera');
 assert.equal(state.surf,0,'time drag must not steer the surfboard');
 // A lost finger must release the clock, even without pointerup.
 await page.mouse.move(box.x+20,box.y+20); await page.mouse.down();
 await page.waitForFunction(()=>probe.input.timeScrubHeld);
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
 await page.waitForFunction(()=>!probe.input.timeScrubHeld && probe.sky.cycleEnabled);
 await page.mouse.up();
 await clock.focus(); await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>Math.abs(probe.sky.timeOfDay-23.25)<.02);
 for(const [name,width,height] of [['portrait',390,844],['small',320,568],['landscape',844,390]]){
  await page.setViewportSize({width,height});
  const layout=await page.evaluate(()=>{
   const c=document.querySelector('.tc-clock'),r=c.getBoundingClientRect();
   const intersects=s=>{const b=document.querySelector(s).getBoundingClientRect();return r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top};
   return {visible:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.tc-clock')===c,menuOverlap:intersects('.tc-top'),actionOverlap:intersects('.tc-actions')};
  });
  assert.deepEqual(layout,{visible:true,hit:true,menuOverlap:false,actionOverlap:false},name);
  await page.screenshot({path:`.data/mobile-audio-time/clock-${engine}-${name}.png`});
 }
 assert.deepEqual(errors,[]);
 console.log(`mobile time (${engine}): drag, wrap, surf isolation, blur, accessibility and three layouts passed`);
} finally {await browser.close()}
