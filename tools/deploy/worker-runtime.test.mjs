import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import http from 'node:http';
import { sha256 } from '../precompress-dist.mjs';

test('real Workers runtime sends one Brotli encoding and correct range/CORS headers', async (t) => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: fileURLToPath(new URL('./asset-worker.mjs', import.meta.url)), compatibilityDate: '2026-09-08', r2Buckets: ['ASSETS'] }));
  t.after(() => mf.dispose());
  const bucket = await mf.getR2Bucket('ASSETS');
  const source = Buffer.from('Brotli must remain lossless across the Workers HTTP boundary. '.repeat(100));
  const compressed = brotliCompressSync(source);
  const brKey = `objects/${sha256(compressed)}/model.glb.br`;
  const rawKey = `objects/${sha256(source)}/model.glb`;
  await bucket.put(brKey, compressed, { httpMetadata: { contentType: 'model/gltf-binary', contentEncoding: 'br', cacheControl: 'public, max-age=31536000, immutable' } });
  await bucket.put(rawKey, source, { httpMetadata: { contentType: 'model/gltf-binary' } });
  const base = await mf.ready;
  async function get(key, headers, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(key, base), { headers, method }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }); req.on('error', reject); req.end();
    });
  }
  const br = await get(brKey, { 'accept-encoding': 'br', origin: 'https://sanfrancisco.up.railway.app' });
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.deepEqual(br.body, compressed);
  assert.deepEqual(brotliDecompressSync(br.body), source);
  assert.equal(br.headers['access-control-allow-origin'], '*');
  const repeat = await get(brKey, { 'accept-encoding': 'br' });
  assert.deepEqual(repeat.body, compressed, 'a repeated download must not compress the Brotli bytes again');
  const head = await get(brKey, { 'accept-encoding': 'identity' }, 'HEAD');
  assert.equal(head.status, 200); assert.equal(+head.headers['content-length'], compressed.length);
  const range = await get(rawKey, { range: 'bytes=10-39' });
  assert.equal(range.status, 206); assert.deepEqual(range.body, source.subarray(10, 40));
  assert.equal(range.headers['content-range'], `bytes 10-39/${source.length}`);
  assert.equal((await get(rawKey, { 'if-none-match': range.headers.etag })).status, 304);
});
