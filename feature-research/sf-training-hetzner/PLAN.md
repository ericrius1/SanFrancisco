# SF — Move Multiplayer + Continual Training to One Hetzner Box

**Status:** plan, pre-implementation. Hand to an Opus UltraCode agent (sub-agent coordination).
**Author context:** written 2026-07-08. Read this whole doc before touching code.

---

## 0. Decisions locked (do not relitigate)

1. **Runtime stays Node** (V8). Same engine speed as Deno; avoids Bun/JSC WASM-perf and `Math.*` determinism regressions. No runtime migration.
2. **Physics stays `box3d-wasm`** in training AND game (sim-to-real parity is the core invariant). This forbids GPU-batched physics engines.
3. **No GPU.** Physics is CPU sequential WASM with no GPU path; the policy nets are 146/133 params (hand-rolled, zero-alloc in `learner.ts`) — far too small to benefit, and per-step CPU↔GPU sync would make it *slower*. Hardware acceleration here = **CPU cores + SIMD-compiled WASM**, not GPU. Do not provision a GPU box.
4. **One machine** hosts everything for now: multiplayer relay + live world authority + background training farm. Simplicity over horizontal scale. Region/species sharding is explicitly deferred (design so it's addable later, build it single-box now).
5. **Hardware: Hetzner Cloud CAX31** — 8 ARM (Ampere Altra) vCPU, 16 GB, 160 GB NVMe, €20.99/mo ex-VAT (~$22–23 for a US buyer, no EU VAT) + ~€0.60 IPv4. Fallback CAX21 (4 core / 8 GB / €10.49) if budget must stay strictly under $20.
6. **Training model:** background farm trains fast (headless, many× real-time, cores-parallel); a **promotion step every 1–6 h** loads the current champion brains into the live world; the live world runs **inference** at 1× and the in-world NN lattice is an **inference visualization**, not a literal training view.
7. **Scale target:** 5–50 concurrent players. Inter-player data is tiny (poses at 12 Hz; audio is P2P WebRTC, not through the relay).
8. **No architecture search, no topology evolution (out of scope).** Nets are static, hand-sized per species; learning is **weights-only** (cars: online actor-critic in `learner.ts`; creatures: ES in `rl/`). The tasks are low-dim and capacity-saturated, and the rhythmic prior is already injected via the CPG — topology evolution buys little, conflicts with the persistent-lifelong-learner car model, produces GPU-hostile irregular nets, and would break the fixed-shape assumptions in the relay validator / wire format / NN-lattice viz. Keep the existing `v` version field on brain blobs for hygiene, but net shapes never change at runtime. No NEAT, no NAS, no `CONFIG`-driven net-shape search.

---

## 1. What exists today (verified file references)

**Relay** — `server/server.mjs`
- Single-room WebSocket presence relay + static host for `dist/`. Node + `ws`, pure JS.
- **Simulates nothing.** Clients own their physics; server relays transforms (`snap` at 12 Hz).
- AI-cars persistence: accepts `brain` blobs **only from the leader**, `leaderId()` = lowest connected id (`server.mjs:134`), strict per-blob validation (`validBrain`, `server.mjs:67`), stores latest-per-car in `lifeById`, debounce-writes `server/data/aicars-life.json` (`scheduleLifeWrite`, `server.mjs:114`), hands the fleet to newcomers via `welcome.aicarsLife` (`server.mjs:388`).
- **KNOWN BUG we are fixing:** on Railway the disk is ephemeral — a redeploy wipes `aicars-life.json` (`server.mjs:41`). A real disk on the droplet fixes this.

**Client-side fleet sim + net** — `src/gameplay/aiCars/`
- `fleet.ts` — 48 persistent cars, `prePhysics`/afterSteps, city-wide placement.
- `learner.ts` — **online continuing actor-critic**, average-reward, eligibility traces (λ0.9). Actor `[9,12,2]`, critic `[9,12,1]`, all hand-rolled flat Float32Array, zero-alloc hot paths. `ACTOR_SIZES`/`CRITIC_SIZES` exported. Server hardcodes the param lengths (146/133) to validate blobs.
- `roadGraph.ts` — road-follow graph from `public/data/roads.json`.
- `netSync.ts` — `isLeader(net)` = lowest live id (`netSync.ts:48`); `serializeCars()` → wire rows `[slot,kind,hue,x,y,z,heading,speed, …12 hidden bytes]`; `GhostStore` (non-leaders interpolate, no re-sim). **Consistency is snapshot-driven, not lockstep** — so moving the sim to a headless authority changes nothing for clients.
- `policy.ts` — dependency-free Policy type/impl mirrored into the brain overlay.

**Headless trainers (offline today)**
- `tools/train-cars-headless.mjs` — runs the *real* `fleet.ts`/`learner.ts` headless in Node with a "clear-everywhere" world stub (`ground:()=>0`, `sweep:()=>null`), `BATCH=4000` substeps/tick, checkpoints all 48 brains to `tools/aicars-trained.json` every 60 s, resumes on restart. **This is ~90% of the training farm already.**
- `tools/push-brains-to-prod.mjs` — connects to the live relay as a client; if it is leader (lowest id, i.e. nobody else on) it uploads the checkpoint brains, then disconnects. One-shot file drop, not a live sim.
- `rl/train.ts` + `rl/core/{box3dEnv,es,rollout}.ts` — Evolution Strategies for creatures (horse/dog), `box3d-wasm`, pure CPU. Writes `public/models/<creature>_policy.json`. Episodic (not online) — this is the "ES farm" case.
- Creatures: `src/creatures/{policy,quadruped}.ts`; horses run in-world (see `sf-horse-herd` memory), deterministic-local.

**The gap we are closing:** always-on training is offline (local Mac → file → push), and in-world training only exists while some human's browser tab happens to be leader. We want a persistent headless authority that IS the world, on a box we own.

---

## 2. Hard constraints

- Physics = `box3d-wasm`, unchanged, in farm + live + game. No surrogate models, no alternate engines.
- No behavior change for existing clients: the wire protocol (`snap`, `cars`, `brain`, `paint`, `fw`, `note`, `rtc`) stays compatible; ghosts keep interpolating.
- Deterministic-friendly: seeded RNG paths preserved. Note ARM vs x86 `Math.*`/libm can differ slightly — online/robust policies tolerate it, but do not assume bit-identical rollouts across the Mac and the droplet.
- Keep the relay a **trust boundary**: strict blob validation stays; add authority auth (below); humans can never inject brains or become the authority.
- ARM64 target: no x86-only native deps (today: none — `ws`, `three` pure JS, box3d = portable WASM). Keep it that way.

---

## 3. Target architecture (one box, three processes)

Run **three separate processes** (crash isolation — a physics NaN in the farm must not drop players), supervised by `docker compose` (or systemd):

```
                      Hetzner CAX31 (8 ARM cores, 16 GB)
 ┌──────────────────────────────────────────────────────────────────┐
 │  [relay]      server.mjs  — ws presence + static dist/ + persist   │  ~<1 core
 │      ▲  ws (cars/brain/snap)                                        │
 │      │                                                             │
 │  [authority]  live world sim @ 1× — inference of champion brains,  │  ~1 core
 │      │        emits `cars` snapshots + `brain` updates, holds the   │
 │      │        auth token so it is ALWAYS leader                     │
 │      │                                                             │
 │  [farm]       accelerated headless training, worker_threads,        │  ~5–6 cores
 │               N box3d worlds in parallel, writes champion            │  (nice/throttled)
 │               checkpoints to /data; promotes into [authority]       │
 └──────────────────────────────────────────────────────────────────┘
     persistent volume  /data  → aicars-life.json, checkpoints, models
```

- **relay** = `server/server.mjs`, mostly unchanged (add authority-token acceptance). Serves the built `dist/` and `/ws`. Egress trivial (Hetzner includes 20+ TB).
- **authority** = a NEW long-lived process. Promote `train-cars-headless.mjs` into a persistent client that connects to the relay, runs the fleet at **1× real-time inference**, and emits `cars` rows (`serializeCars`) each snapshot tick + `brain` updates on promotion. It presents the **auth token** so the relay treats it as the sole leader. Humans are never leader.
- **farm** = a NEW worker-thread harness wrapping `learner.ts` (cars) and `rl/` ES (creatures), running many× real-time with no rendering, one `box3d-wasm` instance per worker. Writes champion checkpoints. Does NOT talk to clients.
- **promotion** = a timer (config: 1–6 h, or "on skill improvement") that atomically loads the latest champion checkpoint into the authority, which then broadcasts the new brains.

---

## 4. The train⇄world loop (resolves fast-vs-watchable)

```
 farm (fast, hidden)  ──checkpoint──►  /data/champion.json
        │                                     │
        │ many× real-time, cores-parallel     │ every 1–6h (or on improvement)
        ▼                                     ▼
   accumulates experience            authority hot-swaps brains
   (cars: online AC; creatures: ES)          │
                                              ▼
                                 live world @ 1× runs INFERENCE
                                 → cars/snapshot → relay → players watch
                                 → in-world NN lattice = inference viz
```

- **v1 (ship first):** live authority is inference-only; the farm does all learning; promotion swaps champions on the timer. Simplest to reason about, matches the stated preference.
- **v2 (optional later):** let the live authority also learn slowly at 1× (cars visibly adapt in-world), and promotion only overwrites a live brain when the farm's is measurably better (compare `learner.skill(i)`). More honest ("really learning in the world") at the cost of a merge policy. Do not build v2 until v1 is solid.

---

## 5. Workstreams (agent-parallelizable)

Dependencies noted so sub-agents can fan out. **WS-A and WS-C have no dependency on each other and can run in parallel first.** WS-B is the protocol spine. WS-D depends on B+C. WS-E is cross-cutting.

### WS-A — Infra, container, deploy (independent)
- `Dockerfile` on `node:22-slim` (arm64 base). Multi-stage: build `dist/` (`npm run build`), then a runtime image with `server/`, `src/` (or precompiled JS — see risk R4), `public/`, `vendor/box3d-wasm`, `node_modules`.
- `docker-compose.yml` with services `relay`, `authority`, `farm`; `restart: always`; a named volume mounted at `/data`; env for the auth token + promotion interval + worker count.
- Move persistence path off the repo: `LIFE_FILE`, checkpoints, `public/models/*` champions → `/data` (env-overridable). Fixes the ephemeral-disk bug for good.
- Hetzner provisioning notes: create CAX31 (Ampere ARM) in a low-latency region, attach a Volume for `/data`, firewall to expose only 80/443 (+22 for SSH), install Docker, deploy via `docker context`/SSH or a small `deploy.sh` (rsync build + `docker compose up -d`). TLS via a reverse proxy (Caddy/Traefik) terminating `wss://` in front of the relay, OR keep the relay behind Cloudflare. Document DNS for the game domain.
- Health: keep/extend `/healthz` (`server.mjs:170`); add authority + farm heartbeat endpoints or log lines.

### WS-B — Authority + auth-token protocol (spine)
- Add an **authority token** (env secret) to `server/server.mjs`. A client that sends `{t:"hi", authority:true, token:"…"}` and matches the secret becomes the **sole leader**; `leaderId()`/the `brain` gate (`server.mjs:431`) change from "lowest id" to "is the authenticated authority". Humans can never be authority.
- Mirror on the client/authority side: `netSync.ts:isLeader` currently returns true for the lowest live id and for solo. Introduce an explicit authority role so a browser client is **never** leader when a real authority is connected. Solo/offline single-player still self-leads (unchanged) — gate this on "no authority present".
- Keep strict `validBrain`; the token gates *who* may write, validation gates *what*. Both stay.
- Build the **authority process** from `train-cars-headless.mjs`: keep the world stub + fleet/learner wiring, but (a) connect to the relay as an authority client, (b) run at 1× wall-clock (real-time pacing, not `BATCH=4000` burst), (c) each snapshot tick send `serializeCars(fleet.cars)` as a `cars` message and send `brain` updates on promotion, (d) load champion brains from `/data` on boot and on promotion signal.
- Backward-compat: existing message shapes unchanged; non-authority clients keep ghosting.

### WS-C — Training farm (independent of B)
- New `tools/train-farm.mjs` (or `rl/farm.ts`): a `worker_threads` pool, `N = cores − 2` workers (leave cores for relay + authority), each worker owns one `box3d-wasm` instance.
- **Cars:** shard the 48 continual learners across workers; run accelerated (step physics as fast as CPU allows, e.g. the existing `BATCH` burst pattern), periodically reduce to a champion set and write `/data/aicars-champion.json` (same v2 blob shape the relay already validates).
- **Creatures:** wrap `rl/train.ts` ES so the `pairs` fitness evaluations fan out across workers (embarrassingly parallel — this is the big ES speedup). Write `/data/models/<creature>_policy.json` champions.
- Use `SharedArrayBuffer` to broadcast policy params to workers without per-generation copies where it helps.
- **Throttle:** cap worker count and/or insert yields so average CPU stays <~70% (respect CAX shared-vCPU fair-use AND keep the box responsive for players). Make it an env knob.
- Optional but recommended: rebuild `box3d-wasm` with emscripten `-msimd128` in the sibling `../box3d-wasm` repo and re-vendor via `npm run sync:box3d`; benchmark the solver speedup. Keeps parity (same engine), pure CPU.

### WS-D — Promotion / hot-swap (depends on B + C)
- A promotion trigger in the authority: on an interval (env `PROMOTE_EVERY`, default e.g. 2 h) OR on a farm "improved" signal, atomically read the latest `/data` champions and hot-swap them into the running fleet (`fleet.importState` / per-car brain set), then broadcast `brain` updates so the relay persists and re-serves them.
- Guard: only promote if the champion validates and (v2) beats the incumbent skill. Log every promotion with before/after skill + odometer.

### WS-E — Observability & safety (cross-cutting)
- Structured logs per process; a tiny status line (players online, cars alive, median/best skill, last promotion, farm gens/s).
- Crash isolation verified: kill -9 the farm → relay + authority + players survive; restart farm resumes from `/data`.
- Rate budgets already exist in the relay (`MSG_BUDGET_PER_SEC`); ensure the authority's `cars`/`brain` cadence fits under it (it did as a human leader; keep it).
- Backups: periodic copy of `/data/aicars-life.json` + champions (cron to a second volume or object storage).

---

## 6. Protocol changes (concrete)

- `hi` gains optional `authority: boolean` + `token: string`. Relay verifies `token === process.env.SF_AUTHORITY_TOKEN`; on match, marks the connection as authority.
- `brain` accept gate: `if (conn.isAuthority && validBrain(msg.d))` instead of `if (id === leaderId() && …)`.
- `cars` snapshots: only broadcast from the authority connection (ignore from anyone else).
- Everything else unchanged. If no authority is connected, fall back to today's lowest-id behavior so solo/dev still works.

---

## 7. Resource budget (8 ARM cores, 16 GB)

| Consumer | CPU | Notes |
|---|---|---|
| relay | «1 core | 50 players × 12 Hz tiny snapshots; JSON only |
| authority | ~1 core | 1× sim of 48 cars + ~8 horses, inference + serialize |
| farm | ~5–6 cores | `worker_threads`, throttled to keep avg <~70% total |
| headroom | ~0.5 core | OS, TLS proxy, spikes |

RAM: each box3d world is small; 16 GB is ample for ~6 workers + Node heaps.

---

## 8. Risks & mitigations

- **R1 — CAX shared-vCPU throttle** if the farm pegs all cores 24/7. Mitigate: throttle farm (worker cap + yields), target <~70% avg. Monitor; if throttled and it matters, rescale to dedicated (4× cost — last resort).
- **R2 — ARM `box3d-wasm` load/behavior.** WASM is portable and V8-arm64 runs it, but verify the vendored single-file `box3d.mjs` initializes on the droplet and that rollouts are sane. Do this in Phase 0 before building anything else.
- **R3 — ARM vs x86 float drift.** `Math.*`/libm differences → policies trained on the Mac may not reproduce bit-identically on ARM. Online/robust policies tolerate it; don't rely on cross-arch determinism. Train the champions ON the droplet going forward.
- **R4 — `--experimental-strip-types` in long-running prod.** Fine on Node 22, but for a 24/7 process prefer a build step (esbuild/tsc → plain JS) for the authority + farm so there are no strip-types edge cases or startup cost. Decide in WS-A.
- **R5 — authority is a single point of failure** for the live world. `restart: always` + fast boot-from-`/data`. Acceptable for a co-op sandbox; sharding (multi-authority) is the eventual HA story, deferred.
- **R6 — security.** Token-gate the authority (WS-B). Keep strict validation. Only expose 80/443(/22). The relay stays cheat-tolerant-by-design for player poses (nothing competitive), but brains are now token-protected.

---

## 9. Suggested phase order

- **Phase 0 — de-risk (do first, ~half day):** stand up a CAX31, install Docker, run the *existing* `train-cars-headless.mjs` in a container on ARM against `/data`. Prove box3d-wasm runs and trains on the droplet. Gate everything else on this.
- **Phase 1 — infra (WS-A):** Dockerfile + compose + volume + deploy path + TLS. Relay serving `dist/` from the box, players can connect (no authority yet — lowest-id human leads, as today).
- **Phase 2 — authority (WS-B):** token protocol + persistent authority process. Live world now runs on the box, always-on, humans never leader.
- **Phase 3 — farm (WS-C):** worker-thread accelerated training + champion checkpoints. (Can be built in parallel with Phase 2.)
- **Phase 4 — promotion (WS-D):** timed hot-swap champions → live. Close the loop.
- **Phase 5 — polish (WS-E):** observability, backups, throttle tuning, optional SIMD wasm rebuild.

---

## 10. Sub-agent coordination guidance (for the UltraCode agent)

- **Fan-out safely:** WS-A (infra) and WS-C (farm harness) touch disjoint files and can run as parallel sub-agents. WS-B edits `server/server.mjs` + `src/gameplay/aiCars/netSync.ts` + `src/net/net.ts` — keep it a single sub-agent to avoid edit races on the relay. WS-D depends on B+C landing; run it after.
- **Shared contracts to freeze before fan-out:** (1) the champion checkpoint JSON shape (reuse the existing v2 `brain` blob the relay already validates), (2) the `/data` path layout, (3) the `hi` authority-token fields, (4) env var names (`SF_AUTHORITY_TOKEN`, `SF_PROMOTE_EVERY`, `SF_FARM_WORKERS`, `SF_DATA_DIR`). Write these into a short `CONTRACTS.md` first; every sub-agent reads it.
- **Do not break the wire protocol.** Any new message must be additive; existing clients (`snap`/`cars`/`brain`/ghosts) must keep working unchanged. Have a reviewer sub-agent diff the protocol.
- **Verify on the box, not just locally** (ARM parity is the whole point): Phase 0 gate + a smoke test that connects a headless client and confirms it receives `cars` snapshots from the authority.
- **Keep parity sacred:** no sub-agent may swap `box3d-wasm` for another engine to "go faster." SIMD rebuild of the *same* engine is the only physics-speed lever allowed.

---

## 11. Open questions for Eric (answer before Phase 2)

1. Promotion cadence default — 1 h, 2 h, or 6 h? (env-tunable regardless.)
2. v1 inference-only live world, or go straight to v2 (live world also learns slowly + promote-if-better)? Recommend v1 first.
3. Domain/DNS + TLS choice: Cloudflare in front, or Caddy/Traefik on the box?
4. Keep the relay reachable at the current Railway URL during migration (dual-run), or hard cutover to the Hetzner box?
5. Budget ceiling confirm: CAX31 (~$23, 8 core) vs strict-under-$20 CAX21 (4 core)? More cores = materially faster farm.
