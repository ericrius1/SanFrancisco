// Fresh-context WebGPU QA. One fixed quality configuration per browser page;
// live rAF timings are presentation intervals, never mislabeled GPU timings.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { acquirePerformanceProbe } from './performance-probe-lock.mjs';

const release = await acquirePerformanceProbe();
let browser;
const base = process.env.SF_PROBE_URL ?? 'http://localhost:5270';
const out = process.env.SF_PROBE_OUT ?? '.data/world-upgrade/baseline';
const routes = (process.env.SF_PROBE_ROUTES ?? 'goldenGate,japaneseTeaGarden,marinRedwoods').split(',');
await mkdir(out, { recursive: true });
const results = [];
try {
  browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPUDeveloperFeatures', '--use-angle=metal', '--mute-audio'],
});
  for (const route of routes) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const requests = [], errors = [], warnings = [];
    page.on('request', r => requests.push({ url: r.url(), type: r.resourceType() }));
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); else if (m.type() === 'warning') warnings.push(m.text()); });
    const start = Date.now();
    const query = route.startsWith('zone:') ? `zone=${route.slice(5)}` : `spawn=${route}`;
    await page.goto(`${base}/?autostart=1&profile&fullfps&${query}&${process.env.SF_PROBE_EXTRA ?? ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__sf?.renderer?.backend?.device && !window.__sf.worldArrival?.active, null, { timeout: 180000 });
    const bootMs = Date.now() - start;
    // Allow streaming to settle on the live renderer; no manual frame loop.
    await page.evaluate(() => { window.__sf.sky.setTimeOfDay(15); window.__sf.sky.cycleEnabled=false; window.__sf.dynRes.setEnabled(false); });
    await page.waitForFunction(() => window.__sf.renderIdle?.() && window.__sf.rings.state()==='settled', null, { timeout: 180000 });
    if (route.startsWith('zone:')) await page.waitForFunction(id => window.__sf.optionalWorldSites.find(s=>s.id===id)?.state === 'ready',route.slice(5),{timeout:120000});
    await page.waitForTimeout(30000);
    await page.waitForFunction(() => !window.__sf.pipeline.compileHeld, null, { timeout: 120000 });
    const metrics = await page.evaluate(async () => {
      const sf = window.__sf;
      const samples = [];
      let last = 0;
      if (!sf.pipeline.frameTelemetry) throw new Error("Missing authoritative presentation counter");
      let lastCalls = sf.pipeline.frameTelemetry.submittedFrames;
      const initial = { ...sf.pipeline.frameTelemetry };
      let lastRendered = performance.now();
      const renderedIntervals = [];
      let skipped = 0;
      await new Promise(resolve => {
        const step = now => {
          if (last) samples.push(now - last);
          last = now;
          const calls = sf.pipeline.frameTelemetry.submittedFrames;
          if (calls > lastCalls) { renderedIntervals.push(now-lastRendered); lastRendered=now; lastCalls=calls; }
          else skipped++;
          if (samples.length === 240) resolve(); else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      samples.sort((a,b) => a-b);
      renderedIntervals.sort((a,b)=>a-b);
      let meshes = 0;
      sf.scene.traverseVisible(o => { if (o.isMesh) meshes++; });
      return {
        p50: samples[120], p95: samples[228], p99: samples[237],
        renderedFrames: renderedIntervals.length, skippedRefreshes: skipped,
        submittedFrames: sf.pipeline.frameTelemetry.submittedFrames-initial.submittedFrames,
        compileSkippedFrames: sf.pipeline.frameTelemetry.compileSkippedFrames-initial.compileSkippedFrames,
        cpuRenderMs: sf.pipeline.frameTelemetry.cpuRenderMs,
        compileQueueDepth: sf.pipeline.compileQueueDepth, scheduler: sf.scheduler.depths(),
        drawingBuffer: [sf.renderer.domElement.width,sf.renderer.domElement.height],
        userAgent: navigator.userAgent, adapter: sf.renderer.backend.device.adapterInfo ?? sf.renderer.backend.adapter?.info,
        renderedP95: renderedIntervals[Math.floor(renderedIntervals.length*0.95)] ?? null,
        over33ms: samples.filter(n => n > 33.5).length,
        pixelRatio: sf.renderer.getPixelRatio(), visibleMeshes: meshes,
        memory: { ...sf.renderer.info.memory },
        render: { ...sf.renderer.info.render },
        position: sf.player.position.toArray(),
        streaming: {tiles:sf.tiles.backgroundStreamingDebug,terrain:sf.rings.terrain()},
        sites: sf.optionalWorldSites.map(s => ({ id:s.id, state:s.state })),
        governor: sf.dynRes?.governorEffects(),
        choir: sf.getTidalChoir?.()?.debugState(),
        cityLife: sf.getAmbientCity?.()?.debugState(),
        clouds: sf.sky.mesh.material.name === 'sf-volumetric-clouds',
        tracer: sf.tracer?.summary?.(),
      };
    });
    // GPU samples are a SEPARATE serialized manual-tick phase. Never label
    // these readback-paced ticks FPS; the presentation samples above stay live.
    metrics.gpu = await page.evaluate(async () => {
      const sf=window.__sf, r=sf.renderer;
      if (!r.hasFeature('timestamp-query')) return {available:false};
      sf.frameDriver.setManual(true);
      r.backend.trackTimestamp=true;
      const samples=[];
      try {
        for(let i=0;i<35;i++) {
          sf.tick(1/60);
          const [render,compute]=await Promise.all([r.resolveTimestampsAsync('render'),r.resolveTimestampsAsync('compute')]);
          if(i>=5&&!sf.pipeline.compileHeld&&render>0)samples.push({render,compute});
        }
        return {available:true,method:'GPU timestamps; separate serialized phase',samples};
      } finally {r.backend.trackTimestamp=false;sf.frameDriver.setManual(false);}
    });
    await page.screenshot({ path: `${out}/${route.replace(':','-')}.png` });
    const row = { route, bootMs, metrics, requests, errors, warnings };
    results.push(row);
    console.log(JSON.stringify({ route, bootMs, ...metrics, errors:errors.slice(0,5) }));
    await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
    await context.close();
    if (route.startsWith('zone:') && metrics.streaming.tiles.radius > 1000) throw new Error('Pocket escaped its residency boundary');
    if (errors.length) throw new Error(`${route}: ${errors.length} browser errors (see results.json)`);
    if (metrics.renderedFrames < 200) throw new Error(`${route}: too few actual renders to claim steady-state performance`);
  }
} finally {
  await browser?.close();
  await release();
}
