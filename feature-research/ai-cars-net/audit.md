# AI Cars — Agent D audit (multiplayer sync + persistence + deploy)

## Files changed

Created:
- `src/gameplay/aiCars/netSync.ts` — leader election, wire (de)serialization, and the
  `GhostStore` (non-leader interpolation). ~183 lines.

Modified:
- `src/gameplay/aiCars/index.ts` — leader/ghost role switching, snapshot broadcast, ghost
  rendering, remote-anchor injection, pool adoption. (This file is Agent C's, still
  untracked in git; net-sync additions layered on top.)
- `src/net/net.ts` — `cars` / `cpool` messages (send + handlers), `carsPool` from welcome,
  `CarPoolBlob` type + `parseCarPool` validator. +57 lines.
- `server/server.mjs` — `cars` / `cpool` validate+relay, in-memory `latestPool` with
  debounced `server/data/aicars-pool.json` persistence (mkdir + load-on-boot), `aicars`
  field in `welcome`. +76 lines.
- `src/main.ts` — ONE added call site: `aiCars.attachNet(net, () => remotes.positions());`
  (plus 2 comment lines). All other aiCars lines in main.ts are Agent C's pre-existing
  uncommitted work, not mine.

Not touched: policy.ts, fleet.ts, trainer.ts, roadGraph.ts, carMesh.ts, brainOverlay.ts,
statsChip.ts, index.html, vite.config.ts.

## What changed, per file

### src/gameplay/aiCars/netSync.ts (new)
- `isLeader(net)` — leader = `selfId !== 0 && selfId <= min(roster ids)`; solo/disconnected
  (`selfId === 0`) returns true so single-player keeps running the fleet locally.
- `serializeCars(cars)` — one wire row per alive car, `[slot, kind, hue0-255, x·100, y·100,
  z·100, heading·1000, speed·10, ...12 hidden bytes]`. Hidden = `policy.layerOut[0]`
  (first hidden layer, 12 wide), tanh acts quantized to bytes.
- `GhostStore` — one ghost per slot (0..maxCars-1, aligned with the leader's fleet ids so
  the shared BrainOverlay indexes match). `ingest(rows)` snaps on first sight, else stores a
  target; `advance(dt)` exp-lerps pos + shortest-arc heading toward the target (LERP_RATE 9)
  and expires ghosts silent > 1500 ms; `clear()` for handoff.

### src/gameplay/aiCars/index.ts (net-sync additions)
- `attachNet(net, remotePositions?)` — wires `net.onCars → ghosts.ingest`,
  `net.onCarPool → #receivePool`, consumes a welcome pool if present.
- `#syncRole()` (called at the top of both prePhysics and update) — recomputes leadership,
  runs `#promote()` / `#demote()` on a transition, and (as leader) calls `#maybeAdoptPool()`.
- `#promote()` (ghost→leader): drop ghosts + their meshes, reset broadcast pacing so a fresh
  `cpool` goes out immediately. `#demote()` (leader→ghost): `fleet.dispose()` (frees kinematic
  bodies via onWillRemoveBody) + clear meshes.
- `#maybeAdoptPool()` — imports the relay/leader pool into the local trainer **only if its gen
  is ahead of ours** and we haven't already adopted that exact blob. Covers both the
  ghost→leader promote AND a long-running solo leader that receives the relay's saved pool via
  `welcome` (which never triggers a role transition). Never regresses a more-advanced local gen.
- `prePhysics` — leader only: `fleet.prePhysics(dt, #combineAnchors(anchors))`. Ghosts run no
  sim. `#combineAnchors` appends cached remote-player positions (refreshed ≤ every 200 ms,
  reused Vector3 pool — no per-frame alloc) to the caller's `[player.position]`.
- `update` — leader path renders `fleet.cars` (unchanged behaviour) then `#broadcast(frameDt)`
  (8 Hz `cars`, `cpool` on gen-change throttled ≥ 5 s). Ghost path advances `GhostStore` and
  renders each active ghost. Both share a new `#renderCar(...)` helper (mesh attach + terrain
  mirror + wheel spin + overlay). Ghost overlays get `[hidden, zeros]` layerOut and a zero obs
  column (hidden-only, per plan).
- `stats()` — a ghost surfaces the leader's received gen; leader uses `fleet.stats()`.
- `netDebug()` — read-only `{ ready, leader, gen, aliveCars, ghostCars }` for headless tests.

### src/net/net.ts
- `onCars`, `onCarPool` callbacks + `carsPool: CarPoolBlob | null` (populated from the welcome
  and every `cpool`). `sendCars(rows)` / `sendCarPool(blob)`. `parseCarPool` strictly validates
  gen + `weights`/`d` (finite-number rows). `CarPoolBlob = {v:1,gen,weights}` is structurally
  identical to trainer's `PoolBlob`, so no cross-module import (net stays decoupled from aiCars).

### server/server.mjs
- Persistence block: `DATA_DIR`/`POOL_FILE`, `validCarPool` (gen finite + ≤ 8 genomes each of
  ≤ 160 finite params), `loadPool()` on boot, `schedulePoolWrite()` (10 s debounce, coalesced,
  unref'd). `latestPool` held in memory.
- `cars` handler: rows array (≤ 32) each length-20 of finite numbers → relay to others.
- `cpool` handler: `validCarPool(gen,d)` → store `latestPool`, schedule write, relay.
- `welcome` gains `aicars: latestPool` only when a pool exists (keeps the welcome small).
- All validation strict (type-checked, length-capped) since this is a public relay.

### src/main.ts
- Added `aiCars.attachNet(net, () => remotes.positions());` right after the net fireworks
  wiring. `remotes.positions()` returns `{id,name,hue,x,z,mode}[]`, structurally compatible
  with the `{x,z}[]` anchor source. Diff kept to the one call site + 2 comment lines.

## Message byte sizes (measured)

Serialized with realistic magnitudes (24 cars; SF coords up to ±600000 after ×100; 6 genomes
× 146 params rounded 3 dp):
- `cars` snapshot: **2024 bytes** (24 rows).
- `cpool`: **5596 bytes** (6 genomes).
- `welcome` + saved pool: **5666 bytes**.

All well under `MSG_MAX_BYTES` 16384. Leader send rate = state 12 Hz + cars 8 Hz + rare cpool
≈ 20 msg/s, under `MSG_BUDGET_PER_SEC` 80.

## Test results

`npx tsc --noEmit` — **exit 0** (strict + noUnusedLocals), verified after every change.
`npm run build` — **exit 0**.
`node --check server/server.mjs` — OK.

### Local 2-client verify (real headless Chrome via raw CDP)
No playwright is installed anywhere on this machine (checked ~/codeprojects and the global
cache), so I drove real Chrome (`/Applications/Google Chrome.app`) with
`--headless=new --use-angle=metal --enable-unsafe-webgpu --enable-features=Vulkan` over CDP
using the repo's own `ws` module (per the sf-headless-cdp-verify recipe). App booted with
`?fullfps&profile&autostart` — **NOTE: a production build only exposes `window.__sf` when
`?profile` is set** (`import.meta.env.DEV` is false in `dist/`); `?autostart` alone is not
enough. Both clients hit the built app served by a standalone relay
(`PORT=8788 node server/server.mjs`, serving `dist/`), because vite's in-process relay plugin
can't coexist with a second relay on the same port (the WebSocketServer has no `error`
handler and crashes on EADDRINUSE) — serving the build directly is also the prod-like path and
makes the relay-restart test trivial.

Harness (scratchpad `aicars/`): `cdp.mjs`, `verify.mjs`, `restart-welcome.mjs`,
`capture-ghost.mjs`.

- **Phase 1 (leader trains, ghost receives) — PASS.** Client A (leader) reached **24 alive
  cars** and gen advanced (0→1, and 2→… when starting from a saved pool). Client B (ghost)
  showed **24 ghost cars** active with the received gen — no local sim, driven purely by
  snapshots.
- **Phase 2 (leader handoff) — PASS.** Killed client A; client B **promoted within one round**
  (roster empty → leader), spawned a real 24-car fleet, and **continued from the received gen
  (e.g. 1 or 2), not 0**, then kept evolving (→ 3).
- **Relay persistence — PASS.** After training, the relay debounce-wrote
  `server/data/aicars-pool.json` (gen 2, 6 genomes, 146 params each, 5496 bytes). Restarted
  the relay: it logged `loaded AI-cars pool gen 2 (6 genomes)` on boot, the `welcome` to a
  fresh client carried `carsPool {gen:2}`, and that solo client **adopted gen 2** (not 0) via
  `#maybeAdoptPool`. (`restart-welcome.mjs`: RESTART-WELCOME PASS.)

### Screenshots (scratchpad `aicars/`)
- `ghost-cars.png` — **money shot**: a purple ghost car on a Mission street with its floating
  brain-lattice overlay above it (node column + fanned edges), rendered on the non-leader
  client entirely from received snapshots + hidden-activation bytes.
- `ghost-side-local.png` — earlier ghost-client frame (player on a hoverboard; cars off-frame
  but 20 ghosts numerically active).

## Deploy — BLOCKED (environmental, not code)

`railway` CLI is logged in (Eric, ericrius1@gmail.com) and linked (project `sanfrancisco`,
env `production`, service `sanfrancisco`). `railway whoami/status/domain` all succeed and a
plain `curl https://backboard.railway.com` returns 200 (TLS fine for small requests).

**`railway up --detach` fails every attempt (4×) with the same TLS-layer error uploading the
source tarball:**
```
error sending request for url (.../up?serviceId=...)
Caused by: client error (SendRequest) / connection error / received fatal alert: BadRecordMac
```
`BadRecordMac` is a corrupted TLS record mid-stream on the large multipart upload — a
network/proxy/TLS-path problem specific to the big `up` POST body, not auth and not the code.
Per task instructions ("if railway CLI needs login/fails, STOP and report instead of retrying
blindly"), I stopped after confirming it's reproducible and environmental rather than
reconfiguring deploy infra.

**Consequences / notes:**
- Prod verification against the new build could NOT be performed — the deploy did not land.
- The current prod URL is **`https://sanfrancisco.up.railway.app`** (healthz `{"ok":true}`),
  running the OLD build. The URL in memory
  (`sanfrancisco-production-8511.up.railway.app`) is **stale — it now 404s** ("Application not
  found"); memory should be updated.
- To finish deploy from a healthy network: `npm run build` (already clean) then
  `railway up --detach`, poll `https://sanfrancisco.up.railway.app/healthz`, then run the same
  2-client harness with `SF_BASE=https://sanfrancisco.up.railway.app` (verify.mjs already reads
  `SF_BASE`).

## Open risks / notes

- **Railway disk is ephemeral across redeploys** — `server/data/aicars-pool.json` is wiped on
  each deploy, so the pool resets to gen 0 (or rebuilds from a connected client's localStorage).
  Documented and accepted per plan. Within a running instance it survives restarts fine.
- Leader handoff can transiently have two leaders or none for < 1 s while rosters converge;
  the deterministic min-id rule resolves it and ghosts simply time out — acceptable for a co-op
  sandbox.
- Ghost overlays show hidden activations only (input/output columns dim by design) — the leader
  syncs 12 hidden bytes/car, not the full obs/output, to keep snapshots ~2 KB.
- Removed the local-test `server/data/` artifact from the working tree so it isn't committed;
  the server recreates the dir on boot via `mkdir -p`.
- `netDebug()` is a small read-only accessor added purely for headless verification (no
  algorithm change); mirrors the debugState pattern used elsewhere.
