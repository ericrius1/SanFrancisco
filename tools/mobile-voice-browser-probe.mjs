// Two real WebRTC peers and the production Voice/AudioEngine, without the world
// renderer: proves protection also runs when no animation frames are available.
// Fake microphones verify processing/levels, not physical loudspeaker echo.
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
const base=process.env.SF_PROBE_URL ?? 'http://localhost:5251';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
// Match Vite's current module identity after edits; otherwise an HMR timestamp
// can create a second, unused AudioEngine singleton in this fixture.
const voiceModule = await (await fetch(new URL('/src/net/voice.ts',base))).text();
const engineModule = voiceModule.match(/from "([^"]*audio\/engine[^"]*)"/)[1];
const fixture=id=>`<!doctype html><html class="${id===1?'touch-ui':''}"><script type="module">
import {Voice} from '/src/net/voice.ts';
import {audioEngine} from '${engineModule}';
const net={selfId:${id},roster:new Map([[${3-id},{}]]),setVoiceKeepAlive(){},sendRtc(to,payload){window.sendSignal(${id},to,payload)}};
const voice=new Voice(net,()=>({x:0,y:0,z:0}),()=>({x:0,y:0,z:0}));
window.probe={voice,net,audioEngine};
await audioEngine.unlock();
audioEngine.update(1,null);
window.ready=true;
</script></html>`;
const pages={}; const errors=[];
try {
 for(const id of [1,2]){
  const context=await browser.newContext({...id===1?devices['iPhone 13']:{viewport:{width:1280,height:800}},permissions:['microphone']});
  const page=pages[id]=await context.newPage();
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(({mobile})=>{
   window.pcs=[];const PC=window.RTCPeerConnection;
   window.RTCPeerConnection=class extends PC {constructor(...args){super(...args);window.pcs.push(this)}};
   window.pageVisible=true;
   Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.pageVisible?'visible':'hidden'});
   // Older capture implementations do not expose capability inspection.
   if(mobile)Object.defineProperty(MediaStreamTrack.prototype,'getCapabilities',{configurable:true,value:undefined});
  },{mobile:id===1});
  await page.exposeFunction('sendSignal',async(from,to,payload)=>{
   await pages[to].evaluate(({from,payload})=>probe.net.onRtc(from,payload),{from,payload});
  });
  await page.route('**/__mobile-voice-probe',r=>r.fulfill({contentType:'text/html',body:fixture(id)}));
  await page.goto(new URL('/__mobile-voice-probe',base).href);
  await page.waitForFunction(()=>window.ready);
 }
 const a=pages[1], b=pages[2];
 for(const p of [a,b])assert.equal(await p.evaluate(()=>probe.voice.setMic(true)),true);
 await a.evaluate(()=>probe.voice.update());
 await b.evaluate(()=>probe.voice.update());
 await a.waitForFunction(()=>probe.voice.debugState().peers.some(p=>p.conn==='connected'&&p.hasAudio));
 await b.waitForFunction(()=>probe.voice.debugState().peers.some(p=>p.conn==='connected'&&p.hasAudio));
 const active=await a.evaluate(()=>probe.voice.debugState());
 const desktop=await b.evaluate(()=>probe.voice.debugState());
 assert.ok(active.micProcessing.echoCancellation===true||active.micProcessing.echoCancellation==='all');
 assert.equal(active.micProcessing.channelCount,1);
 assert.equal(active.micProcessing.contentHint,'speech');
 assert.equal(active.worldDuck,.12);
 assert.equal(desktop.worldDuck,.35,'desktop world duck stays unchanged');
 assert.ok(Math.abs(active.peers[0].playbackGain-.675)<.001,'new phone peer starts protected, before another frame');
 assert.ok(Math.abs(desktop.peers[0].playbackGain-.972)<.001,'desktop voice level stays unchanged');
 const worldGroup=()=>probe.audioEngine.prewarmBus('world').input.gain.value;
 await a.waitForTimeout(250);
 const on=await a.evaluate(worldGroup);

 await a.evaluate(()=>probe.voice.setMic(false));
 await a.waitForTimeout(250);
 const off=await a.evaluate(()=>probe.voice.debugState());
 const full=await a.evaluate(worldGroup);

 assert.equal(off.micProcessing,null,'mic off must stop capture');
 assert.equal(off.worldDuck,1);
 assert.ok(full>on*5,`world recovers without a rendered frame: ${on} -> ${full}`);
 assert.ok(Math.abs(off.peers[0].playbackGain-1.35)<.002,'voice recovers without a rendered frame');
 await a.evaluate(()=>{window.pageVisible=false;document.dispatchEvent(new Event('visibilitychange'))});
 await a.evaluate(()=>probe.voice.setMic(true));
 await a.waitForTimeout(250);
 const hidden=await a.evaluate(()=>probe.voice.debugState());
 assert.equal(hidden.pageVisible,false);
 assert.equal(hidden.ctx,'running');
 assert.ok(Math.abs(hidden.peers[0].playbackGain-.675)<.002,'mic toggle while hidden must apply protection');
 assert.ok(await a.evaluate(worldGroup)<.001,'hidden world must stay silent');
 await a.waitForFunction(async()=>{
  const stats=await window.pcs[0].getStats();return [...stats.values()].some(s=>s.type==='inbound-rtp'&&s.kind==='audio'&&s.bytesReceived>0);
 });
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({test:'mobile voice',capture:active.micProcessing,phoneWorldDuck:active.worldDuck,desktopWorldDuck:desktop.worldDuck,newPeerGain:active.peers[0].playbackGain,micOffGain:off.peers[0].playbackGain,backgroundGain:hidden.peers[0].playbackGain,renderFrames:0,result:'PASS'}));
} finally {await browser.close()}
