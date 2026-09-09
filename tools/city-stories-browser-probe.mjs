// Real WebGPU world + user-facing notebook/conversation controls, in background.
// SF_PROBE_URL=http://localhost:5274 node tools/city-stories-browser-probe.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const base = process.env.SF_PROBE_URL ?? 'http://localhost:5274';
const executablePath = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(p => p && existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPUDeveloperFeatures', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const requests = [], errors = [], logs = [];
page.on('request', r => requests.push(new URL(r.url()).pathname));
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' || /city-stories|city online/.test(m.text())) logs.push(m.text()); });
const chapters = () => [...new Set(requests.filter(p => /cityStories\/chapters\//.test(p)))];
await mkdir('.data/city-stories', { recursive: true });
const press = async key => { await page.keyboard.press(key); await page.waitForTimeout(350); };
try {
  await page.goto(`${base}/?autostart=1&spawn=presidio&profile=1&fullfps=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__sf?.cityStories?.debugState.ready && !window.__sf.worldArrival.active,
    null, { timeout: 180000 });
  await page.waitForTimeout(1800);
  assert.deepEqual(chapters(), [], 'Clean boot loaded story chapters');
  assert(!requests.some(p => /cityStories\/(runtime|journal|provider)\./.test(p)), 'Clean boot imported optional story systems');
  console.log('PASS clean boot: no optional story runtime, journal or chapters');
  await page.keyboard.down('KeyW');
  await page.locator('.city-stories-button').click();
  await page.locator('.story-journal[open]').waitFor();
  await page.keyboard.up('KeyW');
  assert.equal(await page.evaluate(() => window.__sf.input.keys.has('KeyW')), false, 'Journal stranded a held movement key');
  assert.equal(await page.getByRole('button', { name: /^Visit / }).count(), 16);
  assert.deepEqual(chapters(), [], 'Opening notebook fetched the cast');
  await page.screenshot({ path: '.data/city-stories/notebook-empty.png' });
  await page.getByRole('button', { name: 'Visit Ferry Building · Embarcadero', exact: true }).click();
  await page.waitForFunction(() => window.__sf.cityStories.debugState.loadedPlaces.includes('ferry') && !window.__sf.worldArrival.active,
    null, { timeout: 120000 });
  await page.waitForFunction(() => !!window.__sf.cityStories.debugState.selected, null, { timeout: 10000 });
  const first = await page.evaluate(() => window.__sf.cityStories.debugState);
  assert.equal(first.residents.filter(r => r.place === 'ferry').length, 2);
  assert.deepEqual(chapters(), ['/src/gameplay/cityStories/chapters/ferry.ts']);
  console.log('PASS first approach: just the two Ferry residents loaded');
  await press('KeyE');
  await page.waitForFunction(() => window.__sf.cityStories.active);
  await page.locator('.city-story-dialogue[data-state="turn"] .projected-dialogue__body').waitFor({ state: 'visible' });
  await press('ArrowDown');
  await press('Enter');
  await page.waitForFunction(() => window.__sf.cityStories.debugState.notes.some(n => n.heardReflection));
  const heard = await page.evaluate(() => window.__sf.cityStories.debugState.notes.find(n => n.heardReflection));
  await page.screenshot({ path: '.data/city-stories/conversation.png' });
  await press('Escape');
  assert.equal(await page.evaluate(() => window.__sf.cityStories.active), false);
  await page.locator('.city-stories-button').click();
  await page.locator('.story-journal[open]').waitFor();
  assert((await page.locator('.story-journal__notes').innerText()).includes(heard.lastText));
  await page.screenshot({ path: '.data/city-stories/notebook-remembered.png' });
  // One subsequent destination, proving chapter granularity and distant unload.
  await page.getByRole('button', { name: 'Visit Coit Tower', exact: true }).click();
  await page.waitForFunction(() => window.__sf.cityStories.debugState.loadedPlaces.includes('coit') && !window.__sf.worldArrival.active,
    null, { timeout: 120000 });
  const second = await page.evaluate(() => window.__sf.cityStories.debugState);
  assert(!second.loadedPlaces.includes('ferry'), 'Distant residents stayed resident');
  assert.equal(second.residents.filter(r => r.place === 'coit').length, 2);
  assert.deepEqual(chapters().sort(), ['/src/gameplay/cityStories/chapters/coit.ts', '/src/gameplay/cityStories/chapters/ferry.ts']);
  console.log('PASS next destination: only Coit chapter requested; Ferry rigs unloaded');
  assert(second.notes.some(n => n.id === heard.id && n.heardReflection), 'Memory lost on unload');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sf.city-stories.v1')));
  assert(saved.entries.some(e => e.id === heard.id && e.heardReflection));
  if (process.env.SF_STORY_SWEEP === '1') {
    for (const [id, label] of [['golden-gate', 'Golden Gate Bridge'], ['sutro', 'Sutro Baths'],
      ['skate-plaza', 'Golden Gate Park · Skate Plaza']]) {
      await page.locator('.city-stories-button').click();
      await page.getByRole('button', { name: `Visit ${label}`, exact: true }).click();
      await page.waitForFunction(id => !window.__sf.worldArrival.active
        && window.__sf.cityStories.debugState.residents.filter(r => r.place === id).length === 2,
        id, { timeout: 120000 });
      const state = await page.evaluate(() => window.__sf.cityStories.debugState);
      await page.screenshot({ path: `.data/city-stories/place-${id}.png` });
      console.log(`PASS authored surface: ${label} (${state.residents.length} nearby residents)`);
    }
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile('.data/city-stories/browser-audit.json', JSON.stringify({ first, second, chapters: chapters(), errors, logs }, null, 2));
  console.log('PASS conversation keyboard, Escape, notebook notes, saved listening history');
} catch (error) {
  await page.screenshot({ path: '.data/city-stories/failure.png' }).catch(() => {});
  await writeFile('.data/city-stories/browser-failure.json', JSON.stringify({ error: String(error), errors, logs,
    state: await page.evaluate(() => ({ stories: window.__sf?.cityStories?.debugState, player: window.__sf?.player?.position,
      arrival: window.__sf?.worldArrival?.active })).catch(() => null), requests }, null, 2));
  throw error;
} finally { await browser.close(); }
