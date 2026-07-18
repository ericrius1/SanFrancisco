# main.ts decomposition plan

## Why (measured, July 2026)

- `src/main.ts` is ~5,900 lines / 265 KB with **146 static imports**; every
  fundamental system is constructed inside one `boot()` closure and exposed via
  a ~130-entry `__sf` object literal.
- Consequences: the entry chunk carried everything (2.6 MB before the vendor
  split), nothing inside `boot()` is unit-testable, every feature edit touches
  the same file (merge conflicts), and closure-scoped wiring makes lazy-loading
  each new feature a bespoke exercise.
- The boot sequence itself is fine (map → gpu → tiles → physics → systems →
  warmup → reveal, all `bootMark`ed). The problem is that "systems" is a
  2.2k-line inline block.

## Target shape

```
src/app/
  boot/            # one module per boot stage, explicit inputs/outputs
    bootMap.ts     # WorldMap.load + ground prep
    bootGpu.ts     # renderCore + textures
    bootTiles.ts   # TileStreamer + authored regions
    bootPhysics.ts
  compose/         # feature wiring extracted from boot()'s system block
    scatterBoats.ts, clickTools.ts, spawnTables.ts, ...
  gameLoop.ts      # tick() phase dispatch driven by the registry
  systems.ts       # SystemRegistry: typed {id, instance, update?, prePhysics?}
main.ts            # composition root ONLY: ordered create* calls + reveal
```

- **AppContext** replaces closure capture: `{ renderer, scene, camera, map,
  physics, tiles, player, audio, net, scheduler, tracer }` handed to every
  `create*(ctx)`.
- **SystemRegistry**: each feature registers `{ id, update?, prePhysics?,
  project?, dispose? }`. `tick()` walks registry lanes (the tracer phase names
  already define the lanes). `__sf` debug exposure derives from the registry —
  the 130-entry literal dies.
- **Lazy stays the law**: optional sites keep their dynamic-import gates; new
  rule — any feature whose module graph exceeds ~50 KB must load behind a
  first-use gate (see docs/LAZY_LOADING.md).

## Extraction order (each step lands alone, verified by boot-probe + test:*)

1. **Pure data/wiring blocks → `app/compose/`** (zero behavior change):
   scatter-boat spawns (done — `src/gameplay/scatterBoats.ts`), spawn tables,
   click-tool cycling, selector wiring.
2. **`tick()` → `app/gameLoop.ts`**: move the phase dispatch; systems register
   update callbacks instead of being name-called in the loop body.
3. **Selectors/customizers** behind one lazy `SelectorHub` (avatar/board/
   scooter selectors are still static imports; car/surfboard already dynamic —
   unify on dynamic).
4. **`__sf` from registry** — exposure becomes `registry.debugView()`.
5. **Boot stages → `app/boot/*`** with explicit result types; `main.ts` ends
   under ~300 lines.

## Landed so far (`src/app/compose/`)

Each module exports one `create*`/`wire*`/`register*` function taking explicit
typed params, with a header comment pointing back here. `main.ts` calls each
once. All landed with zero behavior change (tsc green, boot-probe reveal + zero
page errors, feature probes passing).

**Round 1** (narrow, ≤~6 outer vars): `initialArrival.ts` (spawn-table
resolution), `backgroundAdmission.ts` (post-reveal quiet-window pacing),
`oceanKite.ts` (kid-with-a-kite lazy encounter), `escapeStack.ts` (Esc overlay
priority), `timeScrub.ts` (Z/N trackpad gestures), `minimapLandmarks.ts` (static
pins), `carLanding.ts` (hard-landing feedback).

**Round 2** (deeper feature wiring; design taken seriously over the outer-var
bar):

- `toolCycle.ts` — click-tool selection + Ctrl-digit cycling. Late-bound
  `getToolbar`/`getFetchBall` getters break the Toolbar↔setTool and
  fetchBall-null-until-built capture cycles.
- `teaGarden.ts` — Japanese Tea Garden destination load + baked-building swap +
  rake/paint/water/interact delegates. Owns the null-until-approached site;
  main routes its scattered call sites (paintballs water, net rake, minigame
  session, fetchBall pond, setFoliageVisible, interact/update/project) through
  the controller's null-checking methods. The region module under
  `src/world/japaneseTeaGarden/` is unchanged. (Net rake handlers are wired
  right after the controller exists — net's no-op defaults absorb any hydration
  that lands during a boot `await`, and `replayRakeStamps` re-applies.)
- `optionalSites.ts` — the ~11 lazily-imported authored sites
  (Goldman/pickleball, archery, pup, Fort Mason, palace, afterlight, Corona
  Heights, Lands End, Wave Organ, Beach Pianist, Sutro Baths) + exhibit
  vegetation + the streaming perf A/B panel + serialized load queue + distance
  unload + arrival re-prioritization. The controller **owns** the site refs;
  `main.ts` keeps thin `let` aliases only so its hot loop and the `__sf` literal
  read the concrete instances unchanged. `onSitesChanged` fires at exactly the
  old `refreshOptionalSiteDebug` points, re-syncing those aliases and refreshing
  `__sf` (byte-for-byte the prior payload) in one place. Probe-visible `__sf`
  keys are preserved via `sites.list`/`sites.ensure`/`sites.streamingIdle`.

Deliberately **left** in `main.ts` (not clean self-contained wiring): the ghost
ship (its `teleportAboardGhostShip` boarding flow orchestrates
`navigation.teleportCustom` + embodiments + chase + player, and its ride-camera
state is shared with the general `exitToWalk` handler — a runtime-only
`ensure`/`update`/beacon split would fragment that state); hunt/satchel and dog
park (≈5 lines each — a module would be more wiring than content); buskers
(already `app/systems/buskers` + `gameplay/buskers/conversation`); paintballs
(firing is interleaved in the tool-fire block; its water hooks already route
through `teaGarden`).

## Rules going forward

- No new system constructions inside `main.ts` — new features ship as
  `app/compose/<feature>.ts` (or a lazy module) and register themselves.
- A system's per-frame work must be registered with a tracer phase name so
  hitch attribution keeps working.
- Anything optional obeys the massive-app loading policy (no eager asset or
  chunk fetches at boot).
