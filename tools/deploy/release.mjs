import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { filesIn, sha256, atomicWrite } from '../precompress-dist.mjs';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const ASSET_EXTENSIONS = new Set(['.bin', '.json', '.glb', '.tflite', '.webp', '.ktx2', '.jpg', '.jpeg', '.png', '.svg', '.ico', '.woff', '.woff2', '.mp3', '.m4a', '.wav', '.ogg', '.webm', '.mp4', '.hdr', '.exr']);
export const MIME = { '.json':'application/json', '.glb':'model/gltf-binary', '.webp':'image/webp', '.ktx2':'image/ktx2', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.wav':'audio/wav', '.ogg':'audio/ogg', '.webm':'video/webm', '.mp4':'video/mp4' };
export function assetOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('SF_ASSET_ORIGIN must be an HTTPS origin without a path');
  return url.origin;
}
const nameOf = (filename) => encodeURIComponent(path.basename(filename)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export async function prepareRelease({ root = ROOT, origin = process.env.SF_ASSET_ORIGIN, output } = {}) {
  origin = assetOrigin(origin);
  const dist = path.join(root, 'dist');
  const publicFiles = await filesIn(path.join(root, 'public'));
  const candidates = new Set(publicFiles.filter((f) => ASSET_EXTENSIONS.has(path.extname(f).toLowerCase())).map((f) => path.relative(path.join(root, 'public'), f).split(path.sep).join('/')));
  const assets = {};
  const objects = new Map();
  const local = [];
  const fingerprints = [];
  let remoteBytes = 0;
  let localBytes = 0;
  for (const file of await filesIn(dist)) {
    const rel = path.relative(dist, file).split(path.sep).join('/');
    const suffix = file.endsWith('.br') ? '.br' : file.endsWith('.gz') ? '.gz' : '';
    const original = suffix ? rel.slice(0, -suffix.length) : rel;
    const bytes = await readFile(file);
    const hash = sha256(bytes);
    fingerprints.push([`dist/${rel}`, hash]);
    if (candidates.has(original)) {
      const encoding = suffix === '.br' ? 'br' : suffix === '.gz' ? 'gzip' : 'identity';
      const key = `objects/${hash}/${nameOf(file)}`;
      const object = { key, file, hash, size: bytes.length, encoding, contentType: MIME[path.extname(original).toLowerCase()] || 'application/octet-stream' };
      objects.set(key, object);
      (assets[`/${original}`] ||= {})[encoding] = { key, size: bytes.length };
      remoteBytes += bytes.length;
    } else { local.push({ file, rel }); localBytes += bytes.length; }
  }
  for (const [url, variants] of Object.entries(assets)) if (!variants.identity) throw new Error(`Missing original asset for ${url}`);
  for (const file of await filesIn(path.join(root, 'server'))) {
    if (path.basename(file) === 'asset-manifest.json') throw new Error('Source server must not contain a generated asset manifest');
    fingerprints.push([path.relative(root, file), sha256(await readFile(file))]);
  }
  const ws = path.join(root, 'node_modules/ws');
  for (const file of await filesIn(ws)) fingerprints.push([`ws/${path.relative(ws, file)}`, sha256(await readFile(file))]);
  const release = sha256(JSON.stringify({ format: 3, origin, fingerprints }));
  output ||= path.join(root, '.data/releases', release);
  // Never replace an existing deployment artifact: retrying the same release is safe.
  await mkdir(output, { recursive: true });
  for (const { file, rel } of local) {
    const target = path.join(output, 'dist', rel);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(file, target);
  }
  await cp(path.join(root, 'server'), path.join(output, 'server'), { recursive: true });
  await cp(ws, path.join(output, 'runtime-deps/ws'), { recursive: true, dereference: true });
  const manifest = { version: 1, origin, release, assets };
  await atomicWrite(path.join(output, 'server/asset-manifest.json'), JSON.stringify(manifest));
  await atomicWrite(path.join(output, 'Dockerfile'), 'FROM node:22-alpine\nWORKDIR /app\nENV NODE_ENV=production\nCOPY dist ./dist\nCOPY server ./server\nCOPY runtime-deps/ws ./node_modules/ws\nEXPOSE 8787\nCMD ["node", "server/server.mjs"]\n');
  await atomicWrite(path.join(output, '.dockerignore'), '**\n!Dockerfile\n!dist\n!dist/**\n!server\n!server/**\n!runtime-deps\n!runtime-deps/ws\n!runtime-deps/ws/**\n');
  await atomicWrite(path.join(output, '.railwayignore'), '/release-plan.json\n/assets-published.json\n/assets-verified.json\n');
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* fixture */ }
  const plan = { version: 1, release, commit, origin, output, localBytes, remoteBytes, assetCount: Object.keys(assets).length, objects: [...objects.values()] };
  await atomicWrite(path.join(output, 'release-plan.json'), JSON.stringify(plan, null, 2));
  console.log(`[release] ${JSON.stringify({ release, output, localMB: +(localBytes / 1e6).toFixed(2), remoteMB: +(remoteBytes / 1e6).toFixed(2), assets: plan.assetCount, objects: objects.size })}`);
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareRelease();
