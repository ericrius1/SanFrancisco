# Fast releases

`npm run build` keeps every existing asset/contract/typecheck gate, prints timings for each stage, and creates the complete standalone `dist/` build. Brotli quality 5 and gzip level 6 run with up to four parallel jobs. Compressed outputs are cached by source SHA-256, codec version, and settings under `.data/cache/compression`; cache hits are checked for corruption. TypeScript uses an incremental cache under `.data/cache`. Neither cache belongs in git or the runtime image.

GitHub auto-deploy is disabled for this service so a source push cannot replace a verified R2 release. Use `npm run deploy` for production releases; the GitHub repository remains connected for source history.

The fast deployment path builds on your machine (or a CI runner), publishes only missing immutable R2 objects, verifies public access, and uploads a small runtime directory to Railway. Railway's Dockerfile only copies files: no install, TypeScript, Vite, asset bake, or compression. This avoids needing a Docker daemon or private image registry. Railway's normal source-build Dockerfile remains usable for standalone deployments.

## Setup

Use Node 22 or newer. Install app dependencies normally and deployment dependencies separately:

```bash
npm ci
npm ci --prefix tools/deploy
```

Create a local `.env.deploy` (gitignored, excluded from Docker/Railway uploads, `chmod 600 .env.deploy`):

```dotenv
R2_ACCOUNT_ID=a789b3932240b19bdf0252f9192c852f
R2_BUCKET=sanfrancisco-assets
R2_ACCESS_KEY_ID=your_bucket_scoped_access_key
R2_SECRET_ACCESS_KEY=your_bucket_scoped_secret
SF_ASSET_ORIGIN=https://sanfrancisco-assets.ericrius1.workers.dev
RAILWAY_PROJECT_ID=c850bd47-c03f-4281-90c1-69931cd227dc
RAILWAY_SERVICE_ID=a5360ede-d049-45f0-85d3-e8d9429df6d3
RAILWAY_ENVIRONMENT_ID=3c821965-db09-4c59-8d72-789cb767b60c
```

Set the Railway service health-check path to `/healthz` in its settings (already configured for this service). The runtime Dockerfile is detected automatically; the pipeline does not depend on Railway’s deprecated Config as Code files.

The R2 token needs Object Read & Write on **sanfrancisco-assets only**. It stays on the builder; Railway receives no R2 credentials. Sign in to Railway with `npx @railway/cli@5.49.6 login`, or set a project-scoped `RAILWAY_TOKEN` in CI.

### Asset endpoint

The public endpoint serves `objects/<sha256>/<filename>`; original, Brotli, and gzip representations have different hashes and URLs. Objects have their original MIME type, the applicable Content-Encoding, and immutable one-year cache headers. Original files remain available for byte-range requests. No release deletes old objects.

When a domain is managed by this Cloudflare account, connect a dedicated subdomain directly to R2, enable CORS for GET/HEAD from the game and local previews, and create a cache rule for all objects at that hostname (Cloudflare's default extension list excludes some model/data formats). Set `SF_ASSET_ORIGIN` to that HTTPS origin.

Without a managed domain, deploy the read-only Worker in `tools/deploy/asset-worker.mjs` with the ASSETS binding to this bucket. It supplies CORS, MIME/encoding metadata, conditional reads and ranges. It forwards stored compressed bytes without an additional Worker cache layer. Deployment configuration is in `tools/deploy/wrangler.jsonc`:

```bash
npx wrangler@4.130.0 deploy --config tools/deploy/wrangler.jsonc
```

Use its returned workers.dev origin. Browser immutable caching works there; use a managed custom domain for edge-cache configuration. The Worker runs under the account's Workers plan and request limits. A managed domain can be attached later without changing asset keys. R2's rate-limited r2.dev development URL is not the production endpoint.

## Deploy

```bash
npm run deploy
```

The command fails before uploading to Railway unless every asset is present in R2. New public URLs must pass HEAD checks for size, MIME, encoding, and CORS; successful checks for immutable objects are cached by origin under `.data/cache/r2-public`. Every deployment rechecks one object of each encoding to detect endpoint changes, and downloads each encoding twice to verify decoded content hashes. Remove that cache to force a complete public recheck. Uploads use conditional writes and content hashes; retries cannot replace an older release's objects. A changed asset uploads only its new representations. An unchanged asset is reused. Typecheck and all release gates remain required.

`npm run deploy -- --prepare-only` runs the build and prepares a release without uploading it. `npm run deploy:prepare` packages an already completed build. Artifacts are retained under `.data/releases/<release-hash>/`; `release-plan.json` records build commit, files, sizes, and expected hashes. Do not rebuild `dist/` while publishing a prepared plan: the publisher rejects assets that changed after preparation.

For a prepared release, `npm run deploy:publish -- /absolute/path/to/release-plan.json` uploads and verifies assets without touching Railway. The WebSocket dependency is staged as `runtime-deps/ws` because Railway upload filtering excludes `node_modules`; Docker copies it to `node_modules/ws` inside the image. The release directory contains only local code/runtime files, a server-side asset map, the tiny Dockerfile. The app never fetches this map at boot; server redirects happen only when the browser actually requests an asset. WebSocket and API routes stay on Railway.

After the CLI finishes the image build, the deploy script polls `/healthz` for the exact release hash for up to three minutes. A build alone is not reported as deployment success. Set SF_APP_ORIGIN if deploying to another hostname.

## Rollback

Use Railway's deployment history to roll back to the previous successful image. Its asset map points to the old immutable objects, which remain in R2. Retained local runtime directories can also be uploaded again with Railway's `up --path-as-root --no-gitignore` command and the same explicit project/service/environment. No rebuild or asset rebake is needed. Never delete R2 objects merely because a newer release exists; retain everything needed by releases you may roll back to.

## Verification

```bash
npm run test:deployment
```

These tests exercise lossless compression, cache reuse/invalidation/corruption, immutable release maps, HTTP encoding negotiation and ranges, incremental uploads, failed-upload handling, and the R2 delivery Worker. Browser QA uses a fresh headless WebGPU context and checks actual asset requests at boot, feature activation, and subsequent selection. The worker and server must never fetch optional assets to hydrate a hidden UI or render a catalog.

Tuning (optional): `SF_BROTLI_QUALITY=0..11`, `SF_COMPRESS_JOBS=1..16`, and `SF_COMPRESS_CACHE=/persistent/cache/path`. Defaults favor frequent releases. A persistent builder can share the compression cache between checkouts because keys include content and codec settings. Keep TypeScript caches separate per checkout. No OS service is installed by the deploy tooling.
