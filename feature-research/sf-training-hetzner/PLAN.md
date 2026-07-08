# SF — Move Multiplayer + Continual Training to One Hetzner Box

**Status:** plan, pre-implementation. Hand to an Opus UltraCode agent (sub-agent coordination).
**Author context:** written 2026-07-08. Read this whole doc before touching code.

> **Design stance:** we ship in phases, but we design the *foundations* (perception,
> typed multi-species pipeline, learning-capable authority, layered world) in from the
> very first commit so nothing has to be torn out later. Cars are the first species,
> not the only one. See §5.

---

## 0. Decisions locked (do not relitigate)

1. **Runtime stays Node** (V8). Same engine speed as Deno; avoids Bun/JSC WASM-perf and `Math.*` determinism regressions. No runtime migration.
2. **Physics stays `box3d-wasm`** in training AND game (sim-to-real parity is the core invariant). This forbids GPU-batched physics engines.
3. **No GPU.** Physics is CPU sequential WASM with no GPU path; the policy nets are 146/133 params (hand-rolled, zero-alloc in `learner.ts`) — far too small to benefit, and per-step CPU↔GPU sync would make it *slower*. Hardware acceleration here = **CPU cores + SIMD-compiled WASM**, not GPU. Do not provision a GPU box. (More entities per world = *more* CPU physics; still zero GPU pull.)
4. **One machine** hosts everything for now: multiplayer relay + live world authority + background training farm. Simplicity over horizontal scale. Region/species sharding is explicitly deferred (design so it's addable later, build it single-box now).
5. **Hardware: Hetzner Cloud CAX31** — 8 ARM (Ampere Altra) vCPU, 16 GB, 160 GB NVMe, €20.99/mo ex-VAT (~$22–23 for a US buyer, no EU VAT) + ~€0.60 IPv4. Fallback CAX21 (4 core / 8 GB / €10.49) if budget must stay strictly under $20.
6. **Training model:** background farm trains fast (headless, many× real-time, cores-parallel); a **promotion step every 1–6 h** loads the current champion brains into the live world; the live world runs **inference** at 1× and the in-world NN lattice is an **inference visualization**, not a literal training view.
7. **Scale target:** 5–50 concurrent players. Inter-player data is tiny (poses at 12 Hz; audio is P2P WebRTC, not through the relay).
8. **No architecture search, no topology evolution (out of scope).** Nets are static, hand-sized per species; learning is **weights-only** (cars: online actor-critic in `learner.ts`; creatures: ES in `rl/`). The tasks are low-dim and capacity-saturated, and the rhythmic prior is already injected via the CPG — topology evolution buys little, conflicts with the persistent-lifelong-learner car model, produces GPU-hostile irregular nets, and would break fixed-shape assumptions. Keep the `v` version field on brain blobs; net shapes never change at runtime. No NEAT, no NAS, no net-shape search.
9. **Design multi-species + interaction in from day one (build in phases).** Even though cars ship first and the live world is inference-only in v1, four seams are architected from the first commit so later species and emergent cross-entity behavior *drop in* rather than force a rewrite: (a) a **shared perception / entity registry**, (b) an **entity-type-tagged data pipeline** (brains, snapshots, persistence, viz), (c) a **learning-capable authority** (learning is a per-entity toggle, off in v1), (d) a **layered world spec** (roads + colliders + other-entity obstacles), not a hardcoded empty stub. Details in §5.

---

## 1. What exists today (verified file references)

**Relay** — `server/server.mjs`
- Single-room WebSocket presence relay + static host for `dist/`. Node + `ws`, pure JS.
- **Simulates nothing.** Clients own their physics; server relays transforms (`snap` at 12 Hz).
- AI-cars persistence: accepts `brain` blobs **only from the leader**, `leaderId()` = lowest connected id (`server.mjs:134`), strict per-blob validation (`validBrain`, `server.mjs:67`), stores latest-per-car in `lifeById` (keyed by car id), debounce-writes `server/data/aicars-life.json` (`scheduleLifeWrite`, `server.mjs:114`), hands the fleet to newcomers via `welcome.aicarsLife` (`server.mjs:388`). **Note the hardcoded car shape:** `ACTOR_LEN=146`, `CRITIC_LEN=133`, `CARS_ROW_LEN=20` (`server.mjs:50`) — the validator + wire format assume "car" everywhere. §5 generalizes this.
- **KNOWN BUG we are fixing:** on Railway the disk is ephemeral — a redeploy wipes `aicars-life.json` (`server.mjs:41`). A real disk on the droplet fixes this.

**Client-side fleet sim + net** — `src/gameplay/aiCars/`
- `fleet.ts` — 48 persistent cars, `prePhysics`/afterSteps, city-wide placement. Sensors → 9-float obs (`fleet.ts:534`): speed, lateral, heading err (sin/cos), curvature, `clearAhead/Left/Right`.
- **Perception is siloed today (this is the key limitation for interaction):** `#clearAhead` (`fleet.ts:619`) sweeps buildings via `world.sweep` **and loops `this.cars`** — so a car senses other **cars** and static walls, but is **blind to every non-car entity** (a horse/deer walking in front produces no obs change). Water reads blocked (`fleet.ts:643`).
- `learner.ts` — **online continuing actor-critic**, average-reward, eligibility traces (λ0.9). Actor `[9,12,2]`, critic `[9,12,1]`, hand-rolled flat Float32Array, zero-alloc. `learnStep` is a separate call from `actorForward` (`fleet.ts:551`/`:557`) — so **inference-without-learning is already a one-line gate**.
- `roadGraph.ts` — road-follow graph from `public/data/roads.json`.
- `netSync.ts` — `isLeader(net)` = lowest live id (`netSync.ts:48`); `serializeCars()` → wire rows `[slot,kind,hue,x,y,z,heading,speed, …12 hidden bytes]` (car-specific, `ROW_LEN=8+HIDDEN`); `GhostStore` (non-leaders interpolate, no re-sim). **Consistency is snapshot-driven, not lockstep.**
- `policy.ts` — dependency-free Policy type/impl mirrored into the brain overlay.

**Headless trainers (offline today)**
- `tools/train-cars-headless.mjs` — runs the *real* `fleet.ts`/`learner.ts` headless with a **"clear-everywhere" world stub** (`ground:()=>0`, `isWater:()=>false`, `sweep:()=>null`). Consequence: cars train sensing **each other** (car-vs-car cone still runs) but **blind to buildings/water** — "building avoidance is re-taught live against real colliders." `BATCH=4000` substeps/tick, checkpoints 48 brains to `tools/aicars-trained.json` every 60 s, resumes on restart. **~90% of the farm already.**
- `tools/push-brains-to-prod.mjs` — one-shot: connects to relay, uploads checkpoint if leader, disconnects.
- `rl/train.ts` + `rl/core/{box3dEnv,es,rollout}.ts` — ES for creatures (horse/dog), `box3d-wasm`, CPU. **Each creature trains fully isolated** — one ragdoll per private world, sees no other entities. Writes `public/models/<creature>_policy.json`. `expandPolicyInput` (`train.ts:70`) already grows a net's input layer + warm-starts — reuse this when obs dims change.
- Creatures: `src/creatures/{policy,quadruped}.ts`; horses run in-world (`sf-horse-herd` memory), CPG-driven gait, deterministic-local.

**Two gaps we are closing:** (1) always-on training is offline (local Mac → file → push) and in-world training only exists while a human tab is leader; (2) entities are **perceptually siloed** — cars can't sense creatures, creatures can't sense anything, so no cross-species encounters can be learned anywhere.

---

## 2. Hard constraints

- Physics = `box3d-wasm`, unchanged, in farm + live + game. No surrogate models, no alternate engines.
- No behavior change for existing clients: the wire protocol stays **backward-compatible**; ghosts keep interpolating. New fields are additive; "car" stays the default type with today's exact shapes.
- Deterministic-friendly: seeded RNG paths preserved. ARM vs x86 `Math.*`/libm can differ slightly — online/robust policies tolerate it; don't assume bit-identical cross-arch rollouts.
- Keep the relay a **trust boundary**: strict blob validation stays (now per entity-type); add authority auth; humans can never inject brains or become the authority.
- ARM64 target: no x86-only native deps (today: none). Keep it that way.

---

## 3. Target architecture (one box, three processes)

Three separate processes (crash isolation — a physics NaN in the farm must not drop players), supervised by `docker compose` (or systemd):

```
                      Hetzner CAX31 (8 ARM cores, 16 GB)
 ┌──────────────────────────────────────────────────────────────────┐
 │  [relay]      server.mjs — ws presence + static dist/ + persist    │  ~<1 core
 │      ▲  ws (ents/brain/snap)   entity-type-aware validate+store     │
 │      │                                                             │
 │  [authority]  live world @ 1× over a WORLD SPEC (roads+colliders+   │  ~1 core
 │      │        entities) with a SHARED PERCEPTION REGISTRY. Runs      │
 │      │        every species; LEARNING TOGGLE off in v1 (inference).  │
 │      │        Emits typed snapshots + brain updates. Sole leader.    │
 │      │                                                             │
 │  [farm]       accelerated headless training, worker_threads, N       │  ~5–6 cores
 │               box3d worlds in parallel over the SAME world-spec API   │  (throttled)
 │               (roads+colliders from day one). Writes champions.      │
 └──────────────────────────────────────────────────────────────────┘
     persistent volume  /data  → life.json, champions/, models/
```

- **relay** = `server/server.mjs`, add authority-token acceptance + make the validator/store **entity-type-aware** (§5b). Serves `dist/` + `/ws`.
- **authority** = a NEW long-lived process built from `train-cars-headless.mjs`, but stepping a **layered world** (world-spec) with the **shared perception registry**, running **all species**, with a per-entity **learning toggle** (off = inference in v1). Presents the auth token → sole leader. Humans never leader.
- **farm** = a NEW worker-thread harness over the **same world-spec API** (roads + colliders instantiated from day one, so static avoidance trains headless — closing the v1 hole in §5d). One `box3d-wasm` world per worker. Writes champions. No client traffic.
- **promotion** = timer (1–6 h, or "on improvement") loads latest champions → authority hot-swaps → broadcasts brain updates → relay persists.

---

## 4. The train⇄world loop (resolves fast-vs-watchable)

```
 farm (fast, hidden)  ──champions──►  /data/champions/<kind>.json
        │                                     │
        │ many× real-time, cores-parallel     │ every 1–6h (or on improvement)
        ▼                                     ▼
   accumulates experience            authority hot-swaps brains (per kind)
   (cars: online AC; creatures: ES)          │
                                              ▼
                                 live world @ 1× runs INFERENCE
                                 → typed snapshot → relay → players watch
                                 → in-world NN lattice = inference viz
```

- **v1 (ship first):** live authority is inference-only (learning toggle off); farm does all learning; promotion swaps champions on the timer.
- **v2 interaction slice (designed-in, enabled later):** flip the learning toggle **on** for a subset of entities in the live shared world so cars + creatures *learn from actually meeting each other* (§5). Because the toggle, perception registry, typed pipeline, and layered world all exist from v1, v2 is a **config/enable step, not a rewrite**. Promotion then only overwrites a live brain when a champion is measurably better (`learner.skill(i)` compare).

---

## 5. Interaction, perception & shared-world training (foundational — build the seams from day one)

The goal: a car learning to drive should actually **come across** things — walls, water, other cars, and **other species** (a deer) — and (eventually) both sides adapt to the encounter. Today that can't happen anywhere, because perception is siloed and the pipeline is car-only. Four foundational pieces make it possible; **all four are cheap to stub now and expensive to retrofit later**, so build the seams from the first commit even where behavior stays v1.

### 5a. Shared perception / entity registry — *the non-optional foundation*
A common spatial index every entity writes into each step (`pos`, `radius`, `kind`, `velocity`, `id`) and queries for "who's near me." Generalize `#clearAhead`'s car-only loop (`fleet.ts:623`) into an **all-entities cone query** against the registry. The world object owns it; extend the world interface (`ground/isWater/sweep`) with `registerEntity()` / `queryNearby(pos, radius|cone)`. **Without this, entities co-exist visually but are invisible to each other's brains** — a car drives *through* a deer because its obs never changed. Cars are the first consumer; creatures register from day one even before their obs uses it.

### 5b. Entity-type-tagged data pipeline — *forward-compat or bust*
Every stage that is car-shaped today must carry a **`kind`** and a per-kind shape, so adding deer/bird later doesn't break the relay, wire, persistence, or viz:
- **Brain blob:** add `kind`; validator holds a **per-kind spec** (shape lengths + field bounds). `kind:"car"` keeps today's exact 146/133 shape (back-compat).
- **Snapshot rows:** generalize `cars` → a typed `ents` message; each row carries `kind`; the car row stays byte-identical (kind 0). Viz + `GhostStore` switch on `kind`.
- **Persistence:** `lifeById` keyed by `(kind,id)`; champions at `/data/champions/<kind>.json`.
- **Viz:** the in-world NN lattice reads `kind` to know which net shape to render.
Do this generalization **now, with only "car" populated** — that's the whole point: the schema is future-proof, the data is still just cars until other species arrive.

### 5c. Learning-capable authority — *v2 as a toggle, not a rewrite*
`actorForward` (control) and `learnStep` (learning) are already separate calls (`fleet.ts:557`/`:551`). Gate `learnStep` behind a **per-entity `learn` flag**. v1: authority runs with `learn=false` (pure inference); farm runs `learn=true`. v2: authority flips `learn=true` for a chosen subset in the live shared world. One flag, designed in from the start.

### 5d. Layered world spec — *close the v1 static-avoidance hole*
Strict v1 (inference-only live) has a hole: today building avoidance is "re-taught live" *because the live client learns* — but if live is inference-only, **nobody teaches static avoidance** unless the farm does. Fix by making the world a **spec-driven layered environment**, not a hardcoded empty stub: `world = makeWorld({ roads, colliders?, entities? })`. The "clear-everywhere" stub becomes just `{roads}` (a config, not a code path). **Farm loads real colliders from day one** (baked city collider set) so `world.sweep` is real and cars learn wall/water avoidance headless + fast. Optionally seed farm worlds with other-entity obstacles for early cross-species exposure.

### The interaction tier (where emergent cross-species behavior forms)
- **Fast isolated/simple farm** — locomotion + road-following + car-vs-car + (now) static colliders. Parallel across cores. Skill acquisition.
- **Shared-world tier** — one (or a few) rich instances where cars + creatures co-exist **and learn from meeting each other** (learning toggle on). Runs near **1× on ~1 core** (a single shared world can't shard across cores). This is the v2 slice; the natural host is the live authority itself.
- **Multi-agent honesty:** co-training two learning species is higher-variance/slower to converge (each is a moving target for the other). Mitigations: alternate which side learns, or keep one scripted/simple while the other learns, or accept slow co-adaptation. For a co-op sandbox the slow emergent messiness is the *feature*, not a bug.

---

## 6. Workstreams (agent-parallelizable)

Dependency order: **WS-F and WS-G are foundational** (schema + perception) and should land first or alongside the spine; **WS-A** (infra) is independent; **WS-B** is the protocol/authority spine (depends on F+G contracts); **WS-C** (farm) depends on F+G contracts; **WS-D** depends on B+C; **WS-H** (interaction tier) depends on B+C+F and is a later phase; **WS-E** is cross-cutting.

### WS-F — Shared perception & entity registry (foundational)
- Add a spatial index to the world object; extend the world interface with `registerEntity()`/`queryNearby()`. Generalize `fleet.ts` `#clearAhead`/`#probe` to query all nearby entities, not just `this.cars`.
- Cars are the first consumer; creatures register (write) from day one even before consuming it. Keep the 9-float car obs shape stable now (obs-dim change is a **versioned event** — R8; use `expandPolicyInput` when it must grow).

### WS-G — Typed multi-species data pipeline (foundational)
- Generalize brain blob / snapshot / persistence / viz to carry `kind` + per-kind spec (§5b), with `kind:"car"` byte-compatible with today. Freeze this schema in `CONTRACTS.md` before B/C fan out.

### WS-A — Infra, container, deploy (independent)
- `Dockerfile` on `node:22-slim` (arm64). Multi-stage: build `dist/`, then runtime image with `server/`, compiled `src/`/`tools/` (see R4), `public/`, `vendor/box3d-wasm`, `node_modules`.
- `docker-compose.yml`: services `relay`, `authority`, `farm`; `restart: always`; named volume at `/data`; env for token, promotion interval, worker count, world-spec toggles.
- Move persistence to `/data` (env `SF_DATA_DIR`): life.json, `champions/`, `models/`. Fixes the ephemeral-disk bug.
- Hetzner: CAX31 (ARM) in a low-latency region, attach a Volume for `/data`, firewall to 80/443(+22), Docker, deploy via `docker context`/SSH or `deploy.sh`. TLS via **Caddy on-box** (recommended) or Cloudflare. Document DNS.
- Health: extend `/healthz` (`server.mjs:170`); authority + farm heartbeats.

### WS-B — Authority + auth-token protocol (spine; depends on F+G contracts)
- Authority token (env secret) in `server.mjs`: `{t:"hi", authority:true, token}` → sole leader; the `brain`/snapshot gates change from "lowest id" to "authenticated authority" (`server.mjs:431`). Keep per-kind `validBrain`. Humans never leader; `netSync.ts:isLeader` yields when a real authority is present (solo/offline still self-leads).
- Build the authority process from `train-cars-headless.mjs`: step a **world-spec** world with the **perception registry**, run **all species**, **learning toggle off (v1)**, at 1× wall-clock; each snapshot tick emit typed `ents`; load champions from `/data` on boot + promotion.
- Backward-compat: message shapes additive; non-authority clients keep ghosting.

### WS-C — Training farm (depends on F+G contracts; parallel to B)
- `tools/train-farm.mjs`: `worker_threads` pool, `N = cores − 2`, one `box3d-wasm` world per worker over the **world-spec API with real colliders loaded (§5d)**.
- **Cars:** shard the 48 online learners across workers; accelerated; reduce to champions → `/data/champions/car.json` (typed blob).
- **Creatures:** fan `rl/train.ts` ES `pairs` evals across workers → `/data/champions/<creature>.json` / `models/`.
- `SharedArrayBuffer` for zero-copy param broadcast where it helps.
- **Throttle** to <~70% avg CPU (CAX fair-use + player responsiveness); env knob.
- Optional: rebuild `box3d-wasm` with emscripten `-msimd128` (sibling `../box3d-wasm`), re-vendor via `npm run sync:box3d`, benchmark. Same engine (parity), CPU.

### WS-D — Promotion / hot-swap (depends on B + C)
- Authority promotion trigger: interval (`SF_PROMOTE_EVERY`, default 2 h) or farm "improved" signal → atomically load `/data/champions/*` → hot-swap per kind (`fleet.importState`) → broadcast brain updates. Guard: validate + (v2) beat incumbent skill. Log before/after skill + odometer.

### WS-H — Shared-world interaction tier (v2 slice; depends on B+C+F; later phase)
- Enable the **learning toggle** for a subset of live-world entities so cross-species encounters are learned in situ. Add cross-species reward terms (near-miss/collision penalties reading the perception registry). Start with cars-learn / creatures-scripted, then allow slow co-adaptation. Keep it scoped and behind a flag.

### WS-E — Observability & safety (cross-cutting)
- Per-process structured logs + status line (players, per-kind counts, median/best skill, last promotion, farm gens/s, avg CPU).
- Verify crash isolation (kill farm → relay+authority+players survive; farm resumes from `/data`).
- Ensure authority `ents`/`brain` cadence fits `MSG_BUDGET_PER_SEC`.
- Backups: periodic copy of `/data` life + champions.

---

## 7. Protocol changes (concrete, all additive)

- `hi` gains optional `authority: boolean` + `token: string`. Relay verifies `token === SF_AUTHORITY_TOKEN`.
- `brain` blob gains `kind`; validator = **per-kind spec table** (`car` → 146/133 as today). Accept only from the authenticated authority.
- Snapshots: add a typed `ents` message (rows carry `kind`); **keep `cars` working** for back-compat (kind = car). Only the authority may emit.
- Persistence keyed by `(kind,id)`; `welcome` hands back the typed set.
- No-authority fallback = today's lowest-id behavior (solo/dev unchanged).

---

## 8. Resource budget (8 ARM cores, 16 GB)

| Consumer | CPU | Notes |
|---|---|---|
| relay | «1 core | 50 players × 12 Hz tiny snapshots; JSON only |
| authority (live world @1×) | ~1 core | all species, inference + perception queries + serialize |
| shared-world interaction tier (v2) | ~1 core | if enabled; a single shared world ≈ 1 core, can't shard |
| farm | ~4–6 cores | `worker_threads`, throttled <~70% total |
| headroom | ~0.5 core | OS, TLS proxy, spikes |

Colliders + perception queries make each world step heavier → the shared/live worlds run near 1×; the isolated farm stays fast/parallel. 16 GB is ample.

---

## 9. Risks & mitigations

- **R1 — CAX shared-vCPU throttle** if the farm pegs all cores 24/7. Throttle to <~70% avg; monitor; rescale to dedicated only as last resort (4× cost).
- **R2 — ARM `box3d-wasm`.** Verify the single-file `box3d.mjs` initializes + rollouts are sane on ARM in Phase 0 before anything else.
- **R3 — ARM vs x86 float drift.** Train champions ON the droplet going forward; don't rely on cross-arch determinism.
- **R4 — `--experimental-strip-types` in 24/7 prod.** Prefer an esbuild/tsc → plain-JS build step for authority + farm. Decide in WS-A.
- **R5 — authority = single point of failure.** `restart: always` + fast boot-from-`/data`. Sharding is the eventual HA story, deferred.
- **R6 — security.** Token-gate authority; per-kind validation; expose only 80/443(/22).
- **R7 — multi-agent non-stationarity (v2/WS-H).** Co-learning species is unstable/slow. Mitigate: alternate learners, scripted-obstacle role, or accept slow co-adaptation. Keep behind a flag; v1 unaffected.
- **R8 — obs/schema change = versioned event.** Growing an obs dim or a per-kind shape must bump a version and use `expandPolicyInput` (warm-start) — never a silent in-place change (breaks persisted brains). The typed pipeline (§5b) makes this a controlled, per-kind step.

---

## 10. Suggested phase order

- **Phase 0 — de-risk (½ day):** stand up CAX31, Docker, run existing `train-cars-headless.mjs` in a container on ARM against `/data`. Prove box3d-wasm trains on the box. Gate everything on this.
- **Phase 1 — infra + foundational schema (WS-A + WS-G):** container/compose/volume/deploy/TLS **and** freeze the typed-entity schema + `CONTRACTS.md` (data is still cars-only). Relay serves `dist/` from the box.
- **Phase 2 — authority + perception (WS-B + WS-F):** token protocol, perception registry, learning-capable authority (learn=off). Live world runs on the box, always-on, humans never leader; cars now sense all registered entities (only cars exist yet, but the channel is live).
- **Phase 3 — farm with colliders (WS-C):** worker-thread accelerated training over the world-spec **with real colliders** (static avoidance trained headless). Parallel with Phase 2.
- **Phase 4 — promotion (WS-D):** timed hot-swap champions → live. Loop closed; v1 complete.
- **Phase 5 — interaction tier (WS-H):** enable the learning toggle for a live subset; add cross-species reward terms; first real "car meets deer and adapts." The v2 slice.
- **Phase 6 — polish (WS-E):** observability, backups, throttle tuning, optional SIMD wasm.

---

## 11. Sub-agent coordination guidance (for the UltraCode agent)

- **Freeze contracts before fan-out (`CONTRACTS.md`):** (1) typed brain/snapshot/checkpoint schema — `kind` + per-kind spec, `car`=146/133 back-compat; (2) perception interface — `registerEntity`/`queryNearby` signatures + world-spec shape `{roads,colliders?,entities?}`; (3) the `learn` toggle location; (4) `/data` layout (`life.json`, `champions/<kind>.json`, `models/`); (5) `hi` authority-token fields; (6) env names (`SF_AUTHORITY_TOKEN`, `SF_PROMOTE_EVERY`, `SF_FARM_WORKERS`, `SF_DATA_DIR`, `SF_WORLD_SPEC`). Every sub-agent reads it.
- **Fan-out safely:** WS-G (schema) and WS-F (perception) are foundational — land or freeze them first; they touch `server.mjs`, `netSync.ts`, `fleet.ts`. WS-A (infra) is independent and parallel. WS-B and WS-C both consume F+G contracts — sequence B's relay edits as a single sub-agent to avoid `server.mjs` races. WS-D after B+C. WS-H last.
- **Additive protocol only:** existing clients (`snap`/`cars`/ghosts) must keep working; `car` stays the default type at its exact current shape. A reviewer sub-agent diffs the protocol.
- **Verify on the box** (ARM parity is the point): Phase 0 gate + a headless-client smoke test that receives typed snapshots from the authority.
- **Parity is sacred:** no swapping `box3d-wasm` for another engine to "go faster." SIMD rebuild of the *same* engine is the only physics-speed lever.
- **Perception is the unlock:** any "entities interact" work must go through the shared registry (§5a) — never a species-specific hard-coded loop like today's `this.cars`.

---

## 12. Open questions for Eric (answer before Phase 2)

1. Promotion cadence default — 1 h / 2 h / 6 h? (env-tunable regardless; default 2 h.)
2. v1 inference-only base is set; confirm the interaction tier (WS-H/Phase 5) is the intended path for "cars meet deer and adapt" (recommended), vs keeping live pure-inference forever.
3. TLS: Caddy on-box (recommended) or Cloudflare in front?
4. Migration: dual-run alongside Railway then cut over (recommended), or hard cutover?
5. Budget: CAX31 (~$23, 8 core) vs strict-under-$20 CAX21 (4 core)? More cores = materially faster farm (and headroom for the v2 interaction tier).
6. Which species after cars for the first cross-species encounter — deer, or the existing horses (already CPG-driven and in-world)?
