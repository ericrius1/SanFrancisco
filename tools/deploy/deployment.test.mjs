import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { precompress, filesIn } from '../precompress-dist.mjs';
import { prepareRelease, ROOT } from './release.mjs';
import { publishAssets, verifyPublicAssets } from './publish.mjs';
import { loadRemoteAssets } from '../../server/remote-assets.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sf-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['dist/models', 'public/models', 'dist/assets', 'server', 'node_modules/ws']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'dist/models/model.glb'), 'sample model data '.repeat(200));
  await cp(path.join(root, 'dist/models/model.glb'), path.join(root, 'public/models/model.glb'));
  await writeFile(path.join(root, 'dist/index.html'), '<html>fixture</html>');
  await writeFile(path.join(root, 'dist/assets/app.js'), 'console.log("hello")');
  await writeFile(path.join(root, 'server/server.mjs'), 'console.log("server")');
  await writeFile(path.join(root, 'node_modules/ws/index.js'), '/* fixture */');
  return root;
}

test('compression is lossless, reusable, invalidated by bytes/settings, and repairs corruption', async (t) => {
  const root = await fixture(t), dist = path.join(root, 'dist'), cache = path.join(root, 'cache');
  const opts = { dist, cache, log: () => {} };
  const first = await precompress(opts);
  assert.equal(first.misses, 2);
  const source = await readFile(path.join(dist, 'models/model.glb'));
  assert.deepEqual(brotliDecompressSync(await readFile(path.join(dist, 'models/model.glb.br'))), source);
  assert.deepEqual(gunzipSync(await readFile(path.join(dist, 'models/model.glb.gz'))), source);
  const warm = await precompress(opts);
  assert.equal(warm.misses, 0); assert.equal(warm.hits, 2);
  source[0] ^= 1;
  await writeFile(path.join(dist, 'models/model.glb'), source);
  assert.equal((await precompress(opts)).misses, 2);
  assert.equal((await precompress({ ...opts, quality: 7 })).misses, 1);
  for (const f of await filesIn(cache)) if (f.endsWith('.br')) await writeFile(f, 'corrupt');
  assert.equal((await precompress(opts)).misses, 1);
  await assert.rejects(precompress({ ...opts, concurrency: 0 }), /SF_COMPRESS_JOBS/);
  await writeFile(path.join(dist, 'models/model.glb'), 'tiny');
  await precompress(opts);
  await assert.rejects(stat(path.join(dist, 'models/model.glb.br')), { code: 'ENOENT' });
});

test('release keeps code local, versions changed assets, routes compression and byte ranges', async (t) => {
  const root = await fixture(t);
  await precompress({ dist: path.join(root, 'dist'), cache: path.join(root, 'cache'), log: () => {} });
  const plan = await prepareRelease({ root, origin: 'https://assets.example.com' });
  assert.equal(plan.assetCount, 1);
  assert.equal(plan.objects.length, 3);
  await assert.rejects(stat(path.join(plan.output, 'dist/models/model.glb')), { code: 'ENOENT' });
  await stat(path.join(plan.output, 'dist/assets/app.js'));
  assert.ok(!(await readFile(path.join(plan.output, 'Dockerfile'), 'utf8')).includes('RUN'));
  const routes = await loadRemoteAssets(path.join(plan.output, 'server/asset-manifest.json'));
  const server = createServer((req, res) => { if (!routes.handle(req, res, new URL(req.url, 'http://localhost').pathname)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function request(headers = {}, method = 'GET', pathname = '/models/model.glb') {
    return fetch(url + pathname, { method, headers, redirect: 'manual' });
  }
  const br = await request({ 'accept-encoding': 'br,gzip' });
  assert.equal(br.status, 307); assert.match(br.headers.get('location'), /\.br$/); assert.equal(br.headers.get('cache-control'), 'no-cache');
  const gz = await request({ 'accept-encoding': 'br;q=0, gzip;q=1' });
  assert.match(gz.headers.get('location'), /\.gz$/);
  const raw = await request({ 'accept-encoding': 'br;q=0,gzip;q=0' });
  assert.match(raw.headers.get('location'), /model\.glb$/);
  const range = await request({ 'accept-encoding': 'br,gzip', range: 'bytes=0-99' });
  assert.equal(range.headers.get('location'), raw.headers.get('location'));
  assert.equal((await request({}, 'HEAD')).status, 307);
  assert.equal((await request({}, 'POST')).status, 405);
  assert.equal((await request({ 'accept-encoding': '*;q=0' })).status, 406);
  assert.equal((await request({}, 'GET', '/constructor')).status, 404);
  assert.equal((await request({}, 'GET', '/models/model.glb?v=old')).headers.get('location'), (await request()).headers.get('location'));
  const again = await prepareRelease({ root, origin: 'https://assets.example.com' });
  assert.equal(again.release, plan.release);
  await writeFile(path.join(root, 'dist/models/model.glb'), 'changed model data '.repeat(200));
  await precompress({ dist: path.join(root, 'dist'), cache: path.join(root, 'cache'), log: () => {} });
  const changed = await prepareRelease({ root, origin: 'https://assets.example.com' });
  assert.notEqual(changed.release, plan.release);
  const newRoutes = await loadRemoteAssets(path.join(changed.output, 'server/asset-manifest.json'));
  assert.notEqual(newRoutes.release, routes.release);
  // The previous artifact remains available for rollback.
  assert.equal(JSON.parse(await readFile(path.join(plan.output, 'server/asset-manifest.json'), 'utf8')).release, plan.release);
});

test('R2 uploads only missing objects and never marks failed uploads complete', async (t) => {
  const root = await fixture(t);
  const plan = await prepareRelease({ root, origin: 'https://assets.example.com' });
  const storage = new Map();
  const client = { async send(command) {
    const args = command.input;
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [...storage].map(([Key, obj]) => ({ Key, Size: obj.ContentLength })) };
    if (command.constructor.name === 'PutObjectCommand') {
      assert.equal(args.IfNoneMatch, '*');
      assert.match(args.CacheControl, /immutable/);
      storage.set(args.Key, args); return {};
    }
    throw new Error('Unexpected command');
  } };
  assert.equal((await publishAssets(plan, { client, bucket: 'fixture' })).uploaded, 1);
  const warm = await publishAssets(plan, { client, bucket: 'fixture' });
  assert.equal(warm.uploaded, 0); assert.equal(warm.reused, 1);
  await writeFile(path.join(root, 'dist/models/model.glb'), 'new model');
  const changed = await prepareRelease({ root, origin: 'https://assets.example.com' });
  assert.equal((await publishAssets(changed, { client, bucket: 'fixture' })).uploaded, 1);
  const failed = { ...changed, output: path.join(root, 'failed') };
  const brokenClient = { async send(command) { if (command.constructor.name === 'ListObjectsV2Command') return {}; throw new Error('network failed'); } };
  await assert.rejects(publishAssets(failed, { client: brokenClient, bucket: 'fixture' }), /network failed/);
  await assert.rejects(stat(path.join(failed.output, 'assets-published.json')), { code: 'ENOENT' });
  await writeFile(changed.objects[0].file, 'mutated after preparation');
  await assert.rejects(publishAssets(failed, { client: brokenClient, bucket: 'fixture' }), /changed after release preparation/);
});

test('asset delivery preserves bytes, compression headers, CORS, seeking, and conditional reads', async () => {
  const { default: worker } = await import('./asset-worker.mjs');
  const bytes = new TextEncoder().encode('0123456789');
  const key = `objects/${'a'.repeat(64)}/model.bin`;
  const object = (part = bytes, encoding) => ({ size: bytes.length, uploaded: new Date('2026-09-08T00:00:00Z'), httpEtag: '"fixture"',
    httpMetadata: { contentEncoding: encoding }, body: new Response(part).body,
    writeHttpMetadata(headers) { headers.set('content-type', 'application/octet-stream'); if (encoding) headers.set('content-encoding', encoding); }
  });
  const env = { ASSETS: {
    async head(k) { return k === key ? object() : null; },
    async get(k, opts) { return k === key ? object(opts?.range ? bytes.slice(opts.range.offset, opts.range.offset + opts.range.length) : bytes) : null; }
  } };
  const request = (init = {}, suffix = key) => worker.fetch(new Request(`https://assets.example.com/${suffix}`, init), env, { waitUntil() {} });
  let response = await request();
  assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  response = await request({ headers: { range: 'bytes=2-4' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-4/10'); assert.equal(await response.text(), '234');
  response = await request({ headers: { range: 'bytes=-3' } }); assert.equal(await response.text(), '789');
  assert.equal((await request({ headers: { range: 'bytes=20-30' } })).status, 416);
  assert.equal((await request({ headers: { range: 'bytes=2-4', 'if-range': '"old"' } })).status, 200);
  assert.equal((await request({ headers: { 'if-none-match': 'W/"fixture"' } })).status, 304);
  response = await request({ method: 'HEAD' }); assert.equal(response.headers.get('content-length'), '10'); assert.equal(await response.text(), '');
  assert.equal((await request({ method: 'PUT' })).status, 405);
  assert.equal((await request({ method: 'OPTIONS' })).status, 204);
  assert.equal((await request({}, 'objects/not-a-hash/file')).status, 404);
  env.ASSETS.get = async () => object(bytes, 'br');
  assert.equal((await request()).headers.get('content-encoding'), 'br');
});

test('public verification caches immutable objects, samples each encoding, and rejects endpoint drift', async (t) => {
  const root = await fixture(t);
  await precompress({ dist: path.join(root, 'dist'), cache: path.join(root, 'cache'), log: () => {} });
  const plan = await prepareRelease({ root, origin: 'https://assets.example.com' });
  // Add a second identity destination to distinguish cached objects from samples.
  plan.objects.push({ ...plan.objects[0], key: `${plan.objects[0].key}-second` });
  let calls = 0, fail = false;
  const options = { cacheDir: path.join(root, 'verified'), fetcher: async (url, request) => {
    calls++;
    const object = plan.objects.find((o) => new URL(o.key, plan.origin).href === String(url));
    assert.equal(request.headers['accept-encoding'], object.encoding);
    return new Response(null, { status: fail ? 404 : 200, headers: {
      'content-length': String(object.size), 'content-type': object.contentType,
      'content-encoding': object.encoding, 'access-control-allow-origin': '*'
    } });
  } };
  await verifyPublicAssets(plan, options);
  assert.equal(calls, plan.objects.length);
  calls = 0;
  await verifyPublicAssets(plan, options);
  assert.equal(calls, new Set(plan.objects.map((o) => o.encoding)).size);
  fail = true;
  await assert.rejects(verifyPublicAssets(plan, options), /public verification failed/);
});
