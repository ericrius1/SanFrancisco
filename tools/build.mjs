// Keep all release gates; report stage timings instead of one opaque build step.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const stages = [
  ['assets', ['tools/assets-check.mjs', '--heal']],
  ...['scene-light-budget', 'ambient-bird-removal', 'foliage-shadow', 'terrain-tiles', 'city-tile-grounding', 'building-facade']
    .map((name) => [name, [`tools/${name}-contract-test.mjs`]]),
  ['citygen-detail-policy', ['--experimental-strip-types', 'tools/citygen-detail-policy-test.mjs']],
  ['post-chain', ['tools/post-chain-contract-test.mjs']],
  ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', '.data/cache/typecheck.tsbuildinfo']],
  ['bundle', ['node_modules/vite/bin/vite.js', 'build']],
  ['compress', ['tools/precompress-dist.mjs']]
];
await mkdir(path.join(root, '.data/cache'), { recursive: true });
const timings = {};
const start = performance.now();
for (const [name, args] of stages) {
  console.log(`[build] starting ${name}`);
  const at = performance.now();
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`[build] ${name} failed (${signal || code})`)));
  });
  timings[name] = Number(((performance.now() - at) / 1000).toFixed(2));
  console.log(`[build] ${name}: ${timings[name]}s`);
}
console.log(`[build] complete ${JSON.stringify({ ...timings, total: Number(((performance.now() - start) / 1000).toFixed(2)) })}`);
