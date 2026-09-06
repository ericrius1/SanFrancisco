// Headless WebGPU acceptance: personal flight, radial worlds, story, and request gates.
import { chromium } from 'playwright-core';
import { writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.data/sky-flight/');
await mkdir(out, { recursive: true });
const base = (process.env.SF_PROBE_URL ?? 'http://localhost:5260').replace(/\/$/, '');
let chrome;
for (const candidate of [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean)) {
  try { await access(candidate); chrome = candidate; break; } catch {}
}
if (!chrome) throw new Error('Set CHROME_BIN to Chrome/Chromium with WebGPU support');
const browser = await chromium.launch({executablePath:chrome,headless:true,args:['--enable-unsafe-webgpu','--enable-gpu','--enable-features=WebGPUDeveloperFeatures',`--use-angle=${process.platform === 'darwin' ? 'metal' : 'vulkan'}`,'--disable-background-timer-throttling','--disable-renderer-backgrounding','--mute-audio']});
const page = await browser.newPage({viewport:{width:1440,height:960}});
const requests=[]; const errors=[]; const checks=[];
const check=(name,pass,detail)=>{checks.push({name,pass,detail}); console.log(JSON.stringify(checks.at(-1)))};
page.on('request',r=>requests.push(r.url()));
page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});
page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
try {
 console.log('BOOT');
 await page.goto(`${base}/?autostart=1&zone=corona&profile=1&fullfps=1`,{waitUntil:'domcontentloaded',timeout:120000});
 await page.waitForFunction(()=>window.__sf?.skyFlight && document.body.classList.contains('started'),null,{timeout:180000});
 console.log('READY');
 await page.waitForFunction(()=>window.__sf.renderIdle(),null,{timeout:120000});
 const optional=u=>/\/src\/(world\/(skyIslands\/(index|vegetation)|vegetation\/alienFlowerForms)|ui\/skyFlight)\.ts/.test(u);
 check('zero optional sky requests at boot',requests.filter(optional).length===0,requests.filter(optional));
 await page.screenshot({path:out+'boot.png'});
 await page.locator('#sky-flight-launch').click();
 await page.locator('.sf-gravity-range').waitFor({state:'visible'});
 check('panel-only first activation',requests.filter(optional).every(u=>u.includes('/ui/')),requests.filter(optional));
 await page.screenshot({path:out+'panel.png'});
 await page.locator('.sf-flight-launch').click();
 check('close restores input',await page.evaluate(()=>!window.__sf.input.suspended));
 console.log('MOTION');
 const motion=await page.evaluate(()=>{
  const sf=window.__sf;window.__sfManual(true);
  sf.player.respawn({x:0,y:250,z:-2000,heading:0});sf.player.skyFlight.setGravity(0);sf.chase.pitch=0;sf.chase.yaw=0;
  const step=n=>{for(let i=0;i<n;i++)sf.tick(1/60)};
  sf.input.setDriver({update(dt,c){c.hold('Space');c.hold('KeyW')}});
  const start=sf.player.position.clone();step(90);const moved=sf.player.position.clone();
  sf.input.setDriver(null);step(150);const hoverStart=sf.player.position.clone();step(60);const hoverEnd=sf.player.position.clone();
  sf.physics.world.setBodyVelocity(sf.player.body,[0,0,0],[0,0,0]);sf.player.skyFlight.setGravity(1);step(60);const down=sf.player.velocity.y;
  sf.physics.world.setBodyVelocity(sf.player.body,[0,0,0],[0,0,0]);sf.player.skyFlight.setGravity(-1);step(60);const up=sf.player.velocity.y;
  sf.player.skyFlight.setGravity(0);step(90);
  sf.chase.manualFirstPerson=true;step(75);const eye={blend:sf.chase.firstPersonBlend,hidden:!sf.player.meshes.walk.visible};
  sf.chase.manualFirstPerson=false;step(60);
  window.__sfManual(false);
  return {start:start.toArray(),moved:moved.toArray(),hoverDrift:hoverEnd.distanceTo(hoverStart),down,up,eye,enabled:sf.player.skyFlight.enabled};
 });
 check('WASD and ascent move avatar',motion.moved[1]>motion.start[1]+15&&motion.moved[2]<motion.start[2]-15,motion);
 check('zero gravity holds hover',motion.hoverDrift<0.15,motion.hoverDrift);
 check('positive and inverse gravity',motion.down< -5&&motion.up>5,{down:motion.down,up:motion.up});
 check('first person animated eye',motion.eye.blend>.99&&motion.eye.hidden,motion.eye);
 console.log('TRAVEL');
 const firstPin=await page.evaluate(()=>window.__sf.minimap.focusLandmark('Sky Planetoid · The First Breath'));
 check('first planetoid is a map destination',firstPin?.x===520&&firstPin?.z===2480,firstPin);
 const before=requests.length;
 await page.evaluate(()=>window.__sf.minimap.padTeleport());
 await page.waitForFunction(()=>window.__sf.player.position.y>420&&window.__sf.player.position.z>2400&&!window.__sf.worldArrival.active,null,{timeout:150000});
 await page.waitForFunction(()=>window.__sf.skyFlight.debugSnapshot().visited.includes('first-breath'),null,{timeout:90000});
 check('first garden loads on approach',requests.slice(before).some(u=>u.includes('/world/skyIslands/index.ts')),requests.slice(before).filter(optional));
 await page.waitForFunction(()=>window.__sf.siteFoliage.debugSnapshot().some(e=>e.id==='sky-garden-first-breath'&&e.status==='ready'),null,{timeout:120000});
 check('nearby only foliage',await page.evaluate(()=>window.__sf.siteFoliage.debugSnapshot().filter(e=>e.id.startsWith('sky-garden-')&&e.status==='ready').every(e=>e.id==='sky-garden-first-breath')));
 await page.screenshot({path:out+'first-garden.png'});
 console.log('ORBIT');
 const orbit=await page.evaluate(()=>{
  const sf=window.__sf;window.__sfManual(true);sf.player.skyFlight.setGravity(0);sf.chase.yaw=0;sf.chase.pitch=0;
  sf.input.setDriver({update(dt,c){c.hold('KeyW')}});
  for(let i=0;i<480;i++)sf.tick(1/60);
  sf.input.setDriver(null);
  const p=sf.player.position;const r=Math.hypot(p.x-520,p.y-390,p.z-2480);
  const result={position:p.toArray(),radius:r,up:sf.player.skyFlight.up.toArray(),cameraUp:new sf.THREE.Vector3(0,1,0).applyQuaternion(sf.camera.quaternion).toArray(),grounded:sf.player.skyFlight.grounded};
  window.__sfManual(false);return result;
 });
 check('walk curves around mini planet',orbit.radius>46.7&&orbit.radius<49&&orbit.up[1]<.9,orbit);
 await page.screenshot({path:out+'curved-surface.png'});
 const secondStart=requests.length;
 await page.evaluate(()=>window.__sf.skyFlight.travel('opal-memory'));
 await page.waitForFunction(()=>window.__sf.skyFlight.debugSnapshot().visited.includes('opal-memory'),null,{timeout:150000});
 check('second island reuses cached sky code',requests.slice(secondStart).filter(optional).length===0,requests.slice(secondStart).filter(optional));
 await page.screenshot({path:out+'second-garden.png'});
 await page.evaluate(()=>window.__sf.skyFlight.open());
 await page.screenshot({path:out+'journal.png'});
 const snapshot=await page.evaluate(()=>window.__sf.skyFlight.debugSnapshot());
 check('journal saves each visited world',snapshot.visited.includes('first-breath')&&snapshot.visited.includes('opal-memory'),snapshot);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'mobile-panel.png'});
 await page.setViewportSize({width:1440,height:960});
 await page.locator('.sf-flight-launch').click();
 for (const id of ['broken-orrery','moonwell','last-seed']) {
   console.log('DISCOVER',id);
   await page.evaluate(id=>window.__sf.skyFlight.travel(id),id);
   await page.waitForFunction(id=>window.__sf.skyFlight.debugSnapshot().visited.includes(id),id,{timeout:90000});
 }
 const complete=await page.evaluate(()=>({ ...window.__sf.skyFlight.debugSnapshot(), saved:JSON.parse(localStorage.getItem('sf.sky-flight.discovered.v1')) }));
 check('all five gardens awaken and persist',complete.visited.length===5&&complete.awakened&&complete.saved.length===5,complete);
 await page.evaluate(()=>window.__sf.skyFlight.open());
 await page.screenshot({path:out+'completed-journal.png'});
 await page.locator('.sf-flight-launch').click();
 const departure=await page.evaluate(()=>{
   const sf=window.__sf;window.__sfManual(true);
   sf.input.setDriver({update(dt,c){c.hold('Space');c.hold('ShiftLeft')}});
   for(let i=0;i<90;i++)sf.tick(1/60);
   sf.input.setDriver(null);
   const p=sf.player.position; const radius=Math.hypot(p.x+460,p.y-716,p.z-1535);
   window.__sfManual(false);return {radius,grounded:sf.player.skyFlight.grounded};
 });
 check('launch clears local gravity well',departure.radius>150&&!departure.grounded,departure);
 await page.screenshot({path:out+'flight.png'});
 await page.evaluate(()=>{const sf=window.__sf;sf.setFoliageVisible(false)});
 check('master foliage toggle hides sky gardens',await page.evaluate(()=>!window.__sf.siteFoliage.root.visible));
 check('no fatal browser errors',errors.filter(e=>!/Failed to load resource|WebSocket|404/.test(e)).length===0,errors.slice(-20));
} catch(e){console.error(e);check('probe completes',false,String(e)); console.log('FAILSTATE',await page.evaluate(()=>{const s=window.__sf;return {p:s?.player.position.toArray(),v:s?.player.velocity.toArray(),active:s?.player.skyFlight.active,ground:s?.player.skyFlight.grounded,field:s?.player.skyFlight.currentIsland?.id,held:s?.player.worldArrivalHeld,arrival:s?.worldArrival.active,debug:s?.skyFlight.debugSnapshot()}}).catch(()=>null)); await page.screenshot({path:out+'failure.png',timeout:15000}).catch(()=>{});}
await writeFile(out+'browser-report.json',JSON.stringify({checks,errors,requests},null,2));
await browser.close();
if(checks.some(c=>!c.pass))process.exitCode=1;
