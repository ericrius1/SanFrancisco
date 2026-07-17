# Browser testing

- Run browser testing headlessly or in the background. Do not open browser instances in the Codex app unless the user explicitly asks for an interactive/visible browser.
- Local development auto-enters the world with a generated name once the world is ready. Agents do not need to fill in or submit the start form.
- When testing a preview or production build, open it with `?autostart=1` (preserving any existing query parameters).
- Use `?startscreen=1` only when the start/loading experience itself is under test.

# Asset-generation API keys

- `TRIPO_API_KEY` (Tripo text/image-to-3D, rigging, retargeting — used by the `threejs-3d-generator` skill and `tools/tripo_multiview_asset.py`) lives in the repo-root `.env` (gitignored; also mirrored at the main checkout root for worktrees). `SSL_CERT_FILE` sits beside it because the framework Python 3.11 install can't find system certs.
- Load it before running generation tooling: `set -a; . ./.env; set +a` (or `. ../../..../.env` from a worktree if the local copy is missing).

# Rendering platform

- This project is WebGPU-only. Do not add, preserve, test, or recommend WebGL/WebGL2 fallback renderers, compatibility branches, transform-feedback/PBO paths, or duplicate shader implementations.
- Start the renderer with a WebGPU backend directly and fail clearly when WebGPU, an adapter, or a device is unavailable. Never silently switch rendering APIs.
- Optimize rendering and simulation work for WebGPU compute, storage buffers/textures, WGSL, and TSL without constraining designs around legacy graphics APIs.
- Treat any newly introduced WebGL/WebGL2 fallback as a project-policy regression.

# Runnable feature handoffs

- When a feature is completed in a git worktree, keep a local preview running from that exact worktree and share a clickable `http://localhost:<port>/?autostart=1` link in the final response (verify it returns 200 first). A filesystem path, worktree path, screenshot, or render link is not a substitute for the running link.
- Use a plain background/session dev server. Do NOT set up OS-level services (launchd, LaunchAgents, cron, etc.) to make the preview outlive the session — the user prefers to just ask for a fresh link if the server has stopped.
- The main-repo dev server on the default port (5179) serves the MAIN repo, not the worktree, so start the worktree preview on its own port (the `sf-verify` launch config uses 5240).

# Video rendering

- Use the system `video-rendering` skill for video work.
- Publish approved videos to `/Users/eric/videos/my creations/sf/renders/cinematics` and keep only final MP4 files there.
- Keep frames, review MP4s, manifests, audits, contacts, posters, probes, logs, and temporary encodes under `.data/`; do not create platform-specific publish folders.

# Unified vegetation system

- All new trees, shrubs, flowers, and grass MUST plant through the shared vegetation runtime. Never build bespoke primitive foliage (icosahedron/sphere canopy blobs, cone pines, hand-rolled trunk+blob groups) — that is a visual-quality and performance regression, even for a "small" decorative grove.
  - Trees: `createAuthoredTreePatch` (`src/world/vegetation/authoredTrees.ts`) over the shared `NativeTreeForest`. Pick a species from `src/world/vegetation/nativeTreeRecipes.ts` (redwood, cypress, windswept cypress, pine, oak, eucalyptus, maple, cherry, ginkgo, magnolia, palm…); extend the recipe file if a genuinely new species is needed.
  - Shrubs: `createAuthoredShrubPatch`; flowers: `createAuthoredFlowerPatch` (`src/world/vegetation/`).
  - Grass/groundcover: `src/world/groundcover/` (bladeGrass + shared wind/trample).
- Regions own botanical intent only — positions, archetype ids, yaw, scale. The shared runtime owns compilation, instancing/batching, wind shading, LOD grades, chunk culling, and shadow proxies. Do not duplicate any of those per region.
- Region vegetation is lazy: put placements in a separate `vegetation.ts` module, dynamic-import it on first approach, call `patch.update(focus)` each frame while visible, `await patch.ready`, warm the detached group off-frame (`prepareFoliage` hook → `prepareOptionalRoot`), then attach. Reference implementations: `src/world/coronaHeights/vegetation.ts`, `src/world/landsEnd/vegetation.ts`, `src/world/sutroBaths/vegetation.ts`.
- Respect the master foliage toggle: expose `setFoliageVisible` and gate per-frame updates on it.

# Massive-app loading policy

- Treat this as a massive open-world app. Boot may load only the fundamentals needed for the player's immediate starting space; optional regions, activities, vehicles, editors, cinematics, and their media must lazy-load by default.
- Use explicit first-use gates and dynamic imports. Constructing an object, hydrating a roster/config, or creating a hidden UI must not fetch that feature's optional images, audio, models, shaders, or code chunks.
- Being present under `public/` is not permission to preload. Customizers must load only the currently selected asset when the feature activates, request a newly selected asset on demand, and never fetch a catalog merely to draw thumbnails.
- Multiplayer does not bypass the gate. Distant or off-activity remote players keep procedural/fallback visuals; optional remote cosmetics may hydrate only after the local feature is active and the remote is in the player's immediate relevant space.
- Whenever adding a feature or running an optimization review, flag eager optional loading as a high-priority regression. Prefer unloading/disposal when leaving heavy activities if a safe ownership boundary exists.
- Browser QA for a lazy feature must inspect the real request waterfall in three phases: clean boot, first activation, and one subsequent choice/action. Assert zero feature requests at boot, selected/nearby-only requests on activation, and exactly the newly requested asset afterward. Also confirm the production build emits a separate chunk when code splitting is intended.
- See `docs/LAZY_LOADING.md` for the implementation contract and acceptance checklist.
