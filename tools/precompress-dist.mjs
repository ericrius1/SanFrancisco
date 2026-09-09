// Lossless, bounded parallel compression with a content-addressed disk cache.
// The cache lives outside dist so Vite's emptyOutDir cannot erase it.
import { readFile, writeFile, readdir, mkdir, rename, copyFile, rm } from 'node:fs/promises';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);
export const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.bin', '.svg', '.mjs', '.cjs', '.glb', '.wasm']);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function filesIn(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

export async function parallel(items, concurrency, task) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  }));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

export async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}

export async function precompress({
  dist = path.join(root, 'dist'), cache = process.env.SF_COMPRESS_CACHE || path.join(root, '.data/cache/compression'),
  quality = Number(process.env.SF_BROTLI_QUALITY || 5),
  concurrency = Number(process.env.SF_COMPRESS_JOBS || Math.min(4, availableParallelism())),
  log = console.log
} = {}) {
  if (!Number.isInteger(quality) || quality < 0 || quality > 11) throw new Error('SF_BROTLI_QUALITY must be 0–11');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('SF_COMPRESS_JOBS must be 1–16');
  const started = performance.now();
  const stats = { files: 0, hits: 0, misses: 0, sourceBytes: 0, brBytes: 0, gzipBytes: 0 };
  const files = (await filesIn(dist)).filter((f) => COMPRESSIBLE.has(path.extname(f).toLowerCase()));
  let progress = performance.now();
  await parallel(files, concurrency, async (file) => {
    const source = await readFile(file);
    if (source.length < 1024) {
      await Promise.all(['br', 'gz'].map((ext) => rm(`${file}.${ext}`, { force: true })));
      return;
    }
    const hash = sha256(source);
    stats.files++;
    stats.sourceBytes += source.length;
    for (const encoding of ['br', ...(source.length <= 2 * 1024 * 1024 ? ['gz'] : [])]) {
      const version = encoding === 'br' ? `br-${process.versions.brotli}-q${quality}` : `gz-${process.versions.zlib}-q6`;
      const cached = path.join(cache, version, `${hash}.${encoding}`);
      let compressed;
      try {
        const [bytes, digest] = await Promise.all([readFile(cached), readFile(`${cached}.sha256`, 'utf8')]);
        if (sha256(bytes) === digest) compressed = bytes;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (compressed) stats.hits++;
      else {
        compressed = encoding === 'br'
          ? await brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } })
          : await deflate(source, { level: 6 });
        await atomicWrite(cached, compressed);
        await atomicWrite(`${cached}.sha256`, sha256(compressed));
        stats.misses++;
      }
      await copyFile(cached, `${file}.${encoding}`);
      stats[encoding === 'br' ? 'brBytes' : 'gzipBytes'] += compressed.length;
    }
    if (source.length > 2 * 1024 * 1024) await rm(`${file}.gz`, { force: true });
    if (performance.now() - progress > 10000) {
      progress = performance.now();
      log(`[precompress] ${stats.files} files; ${stats.hits} cached / ${stats.misses} compressed`);
    }
  });
  stats.seconds = Number(((performance.now() - started) / 1000).toFixed(2));
  log(`[precompress] ${JSON.stringify({ quality, concurrency, ...stats })}`);
  return stats;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await precompress({ dist: process.argv[2] ? path.resolve(process.argv[2]) : undefined });
}
