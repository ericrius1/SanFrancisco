// Build here, publish changed assets, then upload only the verified runtime bundle.
import { spawn } from 'node:child_process';
import { ROOT, prepareRelease } from './release.mjs';
import { publishAssets, verifyPublicAssets } from './publish.mjs';

async function run(command, args, cwd = ROOT) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${signal || code}`)));
  });
}
const args = process.argv.slice(2);
if (args.some((a) => !['--prepare-only'].includes(a))) throw new Error('Usage: npm run deploy [-- --prepare-only]');
// Validate configuration before doing expensive work; never guess which service to replace.
for (const name of ['SF_ASSET_ORIGIN', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_ENVIRONMENT_ID']) {
  if (!process.env[name]) throw new Error(`Missing ${name}; see docs/DEPLOYMENT.md`);
}
if (!args.includes('--prepare-only')) {
  for (const name of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (!process.env[name]) throw new Error(`Missing ${name}`);
}
await run('npm', ['run', 'build']);
const plan = await prepareRelease();
if (args.includes('--prepare-only')) process.exit(0);
await publishAssets(plan);
await verifyPublicAssets(plan);
// Only this small directory is uploaded. Railway does no npm install, tsc, Vite,
// asset generation, or compression; its Dockerfile just assembles the runtime.
await run('npx', ['--yes', '@railway/cli@5.49.6', 'up', plan.output, '--path-as-root', '--no-gitignore',
  '--project', process.env.RAILWAY_PROJECT_ID,
  '--service', process.env.RAILWAY_SERVICE_ID,
  '--environment', process.env.RAILWAY_ENVIRONMENT_ID, '--ci'], plan.output);
const healthUrl = new URL('/healthz', process.env.SF_APP_ORIGIN || 'https://sanfrancisco.up.railway.app');
const deadline = Date.now() + 180000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(healthUrl, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const health = await response.json();
    if (response.ok && health.ok && health.release === plan.release) { healthy = true; break; }
  } catch { /* The previous deployment remains live until Railway switches traffic. */ }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!healthy) throw new Error(`Railway did not serve release ${plan.release} within 3 minutes; inspect deployment logs before retrying`);
// Exercise the live redirect and decompression path used by the browser's boot.
for (const asset of ['/data/meta.json', '/data/manifest.json']) {
  const response = await fetch(new URL(asset, healthUrl), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Live boot asset failed: ${asset} (${response.status})`);
  await response.json();
}
console.log(`[deploy] healthy release ${plan.release}; retained artifact: ${plan.output}`);
