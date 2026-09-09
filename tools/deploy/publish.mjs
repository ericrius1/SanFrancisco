// Incremental, immutable R2 publishing. Credentials are used only by this tool.
import { S3Client, ListObjectsV2Command, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parallel, sha256, atomicWrite } from '../precompress-dist.mjs';

export function r2Client(env = process.env) {
  for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) if (!env[key]) throw new Error(`Missing ${key}; see docs/DEPLOYMENT.md`);
  if (!/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID)) throw new Error('Invalid R2_ACCOUNT_ID');
  return new S3Client({ region: 'auto', forcePathStyle: true, endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }, maxAttempts: 4 });
}

export async function publishAssets(plan, { client = r2Client(), bucket = process.env.R2_BUCKET, jobs = 24 } = {}) {
  const existing = new Map();
  let continuation;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'objects/', ContinuationToken: continuation }));
    for (const object of page.Contents || []) existing.set(object.Key, object.Size);
    continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuation) throw new Error('R2 returned incomplete listing without a continuation token');
  } while (continuation);
  let uploaded = 0, reused = 0, uploadedBytes = 0;
  let progress = performance.now();
  await parallel(plan.objects, jobs, async (object) => {
    if (existing.has(object.key)) {
      if (existing.get(object.key) !== object.size) throw new Error(`Immutable object size mismatch: ${object.key}`);
      reused++; return;
    }
    const bytes = await readFile(object.file);
    if (bytes.length !== object.size || sha256(bytes) !== object.hash) throw new Error(`Asset changed after release preparation: ${object.file}; prepare a new release`);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: object.key, Body: bytes,
      ContentType: object.contentType, ContentLength: object.size,
      ...(object.encoding === 'identity' ? {} : { ContentEncoding: object.encoding }),
      CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha256: object.hash },
      // Never overwrite an object from another release, even during concurrent publishing.
      IfNoneMatch: '*'
    })).catch(async (error) => {
      if (error.$metadata?.httpStatusCode !== 412) throw error;
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.key }));
      if (head.ContentLength !== object.size || head.Metadata?.sha256 !== object.hash) throw error;
    });
    uploaded++; uploadedBytes += object.size;
    if (performance.now() - progress > 10000) {
      progress = performance.now();
      console.log(`[r2] ${uploaded} uploaded / ${reused} reused (${(uploadedBytes / 1e6).toFixed(1)} MB uploaded)`);
    }
  });
  // The marker is written only after every object is present. A failed upload cannot deploy.
  const result = { release: plan.release, origin: plan.origin, bucket, uploaded, reused, uploadedBytes };
  await atomicWrite(path.join(plan.output, 'assets-published.json'), JSON.stringify(result));
  console.log(`[r2] complete ${JSON.stringify(result)}`);
  return result;
}

export async function verifyPublicAssets(plan, { fetcher = fetch, cacheDir = fileURLToPath(new URL('../../.data/cache/r2-public/', import.meta.url)) } = {}) {
  // Content-addressed objects are immutable. Validate new destinations once and
  // recheck one of each representation on every release to detect endpoint drift.
  const cacheFile = path.join(cacheDir, `${sha256(plan.origin)}.json`);
  let verified = {};
  try { verified = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
  if (!verified || typeof verified !== 'object' || Array.isArray(verified)) verified = {};
  const signature = (object) => JSON.stringify([object.size, object.encoding, object.contentType]);
  const sampled = new Set();
  const pending = plan.objects.filter((object) => {
    const sample = !sampled.has(object.encoding);
    sampled.add(object.encoding);
    return sample || verified[object.key] !== signature(object);
  });
  let checked = 0, progress = performance.now();
  await parallel(pending, 32, async (object) => {
    const response = await fetcher(new URL(object.key, plan.origin), {
      method: 'HEAD', headers: { origin: 'https://sanfrancisco.up.railway.app', 'accept-encoding': object.encoding },
      redirect: 'error', signal: AbortSignal.timeout(30000)
    });
    if (response.status !== 200 || Number(response.headers.get('content-length')) !== object.size ||
        (response.headers.get('content-encoding') || 'identity') !== object.encoding ||
        response.headers.get('content-type')?.split(';')[0] !== object.contentType ||
        !['*', 'https://sanfrancisco.up.railway.app'].includes(response.headers.get('access-control-allow-origin'))) {
      throw new Error(`R2 public verification failed (${response.status}, type=${response.headers.get('content-type')}, encoding=${response.headers.get('content-encoding')}, CORS=${response.headers.get('access-control-allow-origin')}): ${object.key}`);
    }
    verified[object.key] = signature(object);
    checked++;
    if (performance.now() - progress > 10000) {
      progress = performance.now();
      console.log(`[r2] public verification ${checked}/${pending.length}`);
    }
  });
  await atomicWrite(cacheFile, JSON.stringify(verified));
  await atomicWrite(path.join(plan.output, 'assets-verified.json'), JSON.stringify({ release: plan.release, origin: plan.origin }));
  console.log(`[r2] verified ${checked} public objects, reused ${plan.objects.length - checked} immutable verifications (size, compression, MIME, CORS)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node tools/deploy/publish.mjs <release-plan.json>');
  const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
  await publishAssets(plan);
  await verifyPublicAssets(plan);
}
