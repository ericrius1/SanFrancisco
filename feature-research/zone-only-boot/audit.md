# Audit — Zone-only boot (`?zone=<id>`)

## Files changed
- `src/app/compose/zoneMode.ts` (new)
- `src/ui/wakeCity.ts` (new)
- `src/app/compose/initialArrival.ts`
- `src/app/compose/optionalSites.ts`
- `src/main.ts`
- `src/ui/share.ts`
- `src/ui/hud.ts`
- `docs/LAZY_LOADING.md`

## What changed per file

### src/app/compose/zoneMode.ts (new)
`ZoneSpec` type + `ZONES` table (all 11 optional-site ids) + `resolveZoneFromQuery`.
Boot-safe: imports only per-site meta constants (never site modules). Centers come
from the same meta constants optionalSites.ts uses; sutro-baths center from
`SUTRO_BATHS_ARRIVAL` (spawnPoints). Unknown id → `console.warn` + null.
bubbleRadius default 900; beach-pianist 1000.

### src/ui/wakeCity.ts (new)
`WakeCityButton` modeled 1:1 on `ShareButton`: root `.wake-city-ui`, button reuses
`.share-btn` styling, label "⛅ Wake the city". Click → disable + "Waking…" →
awaits the caller's async wake → removes its own UI.

### src/app/compose/initialArrival.ts
- Parses `?zone=`. Invite farther than `bubbleRadius` from zone center drops zone
  mode (warns). `zoneArrival = zone && !invite`.
- Resume + dev-reload snapshot ignored when `zoneArrival`.
- `authoredStart` forced null in zone mode (keyless zones have a random `spawnKey`;
  this prevents a random authored region leaking into the spawn chain).
- New `zoneSpawnPoint`: curated `resolveSpawnPoint(zone.spawnKey)` when named, else a
  synthetic walk-mode pose at the zone center. Injected into `startAt`/`scatterR` and
  returned as `spawnPoint` (so `startMode` reads walk). Spawn still refined through
  the existing open-ground search.
- THE LEVER: returns `fullTileRadius = zone ? zone.bubbleRadius : cityTileRadius`, plus
  new `zone` and `cityTileRadius` (original pre-zone `CONFIG.tileLoadRadius`). Visual
  clamp `CONFIG.tileLoadRadius = min(fullTileRadius, 1000)` preserved.

### src/app/compose/optionalSites.ts
- New option `zoneAllowlist?: ReadonlySet<OptionalSiteId>` + independent `zoneAllowed(id)`
  check added BEFORE the existing `optionalSitePerfAllowed` consult at both auto-load
  gates (`reprioritizeOptionalSitesForArrival`, `updateOptionalWorldSites`). `ensure()`
  stays un-gated.
- Foliage registrations converted to a `siteFoliageRegistrations` descriptor list tagged
  by owning zone (lands-end-cypress→lands-end, beach-pianist-grove→beach-pianist,
  corona-trees/corona-groundcover→corona). Only allowed zones' entries register at
  construction; the rest are held in `deferredFoliageRegistrations`.
- New `liftZoneRestriction()` (returned): clears the allowlist and registers the held
  foliage entries. Idempotent (guards on the null-out and `splice`s the held list).

### src/main.ts
- `worldScope { mode, zone, cityTileRadius }`, `deferredCityWork[]`, `cityWoken`,
  and `deferCity(name, run)` helper (runs inline when `cityWoken`, else pushes).
- Deferred via `deferCity`: traffic (road graph + signals + the minimap `setRoadGraph`
  re-issue), scatter boats, islands (+ vegetation arming), crab hunt, activity-landmark
  pins, park-landmark pins, citygen ring (module import moved inside the builder), and
  forest+creatures (imports already inside the builder). `islands`/`hunt`/`roadGraphPromise`
  widened to nullable with `?.` guards at every ref (setFoliageVisible closure, worldReady
  arm block, minimap chain, tick-loop updates). `armIslandsVegetation()` extracted so both
  the worldReady quiet-window and the wake path arm it.
- `zoneAllowlist: new Set([zone.siteId])` passed to `createOptionalSites` in zone mode.
- `wakeCity()`: idempotent; raises `CONFIG.tileLoadRadius`/UnloadRadius to
  `cityTileRadius` (unless surf), `tiles.beginBackgroundExpansion()`, drains
  `deferredCityWork` sequentially (with `worldScope.mode` held at "zone" until the drain
  completes so the traffic/islands runners take their wake-only sub-steps), lifts the
  site restriction, clears the share zone param. Exposed as `__sf.wakeCity`.
- `WakeCityButton` constructed only in zone mode, next to `ShareButton`.

### src/ui/share.ts
`ShareButton.setZone(id | null)` + `#withZone(url)` appends `&zone=<id>` to the built
invite URL. main.ts sets it in zone mode; `wakeCity()` clears it.

### src/ui/hud.ts
`wakeCity: ".wake-city-ui"` added to the `PANELS` map.

### docs/LAZY_LOADING.md
New "Zone-only boot (`?zone=`)" section: link grammar, the fullTileRadius lever, the
allowlist, wake semantics, and how to add a zone.

## Zone ids + spawn behavior implemented
goldman (center, walk), archery (spawnKey archeryRange), pup (center, walk),
fort-mason-ensemble (center, walk), palace (palaceReverie), afterlight (center, walk),
corona (coronaHeights), lands-end (landsEnd), wave-organ (waveOrgan),
beach-pianist (beachPianist, bubble 1000), sutro-baths (sutroBaths). All others bubble 900.
Keyless zones spawn at the site center with heading 0 (refined by the open-ground search).

## Deviations from the plan
- Citygen: moved the `import("./world/citygen")` INSIDE the deferred builder (plan range
  L3228-3260 included the import line) so zone boot does not fetch the citygen chunk at
  reveal — only at wake. Full-boot await ordering is unchanged.
- Used a single `deferCity(name, run)` helper (inline in full mode, push in zone mode)
  rather than duplicated `if (full) {...} else push {...}` blocks — same effect, less
  duplication, and it closes the race where a wake click precedes the post-worldReady IIFE
  reaching its citygen/forest `deferCity` calls (those then run inline).
- `wakeCity()` keeps `worldScope.mode === "zone"` until AFTER the drain: the traffic and
  islands wake runners branch on it to re-issue `minimap.setRoadGraph` / arm island
  vegetation. `cityWoken` flips first so any late IIFE builder runs inline.

## Test results
- `tsc --noEmit`: clean.
- `vite build`: succeeds (569 modules; forest/creatures remain separate lazy chunks;
  citygen stays behind its dynamic import).
- `npm run build` fails ONLY at the pre-existing `foliage-shadow-contract-test.mjs` gate
  (asserts `.castShadow` absent from `src/world/nativeTreeForest/index.ts:445-446`). That
  file is outside this change set and the failure reproduces independent of this work.

## Open risks / notes
- Contradiction with background facts: none found. Verified `resolveInitialArrival`
  clamp/restore paths, RingCoordinator `onExpansionStalled` guard (`< fullTileRadius`),
  worldReady quiet-window restore, and that no path lowers `CONFIG.tileLoadRadius` after
  wake except surf mode (acceptable).
- Default boot (`?zone` absent): `worldScope.mode === "full"` ⇒ `cityWoken` true ⇒
  `deferCity` runs every builder inline in original order; every new branch is inert.
- Not browser-verified (task constraint: no dev server / browser). Behavior reasoned from
  code. The `__sf.wakeCity()` hook allows headless verification if desired.
- `hunt` remains in the `DebugRegistry.refs` shorthand; in zone mode `__sf.hunt` reads null
  until wake (debug surface only, not load-bearing).
