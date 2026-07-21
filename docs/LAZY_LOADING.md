# Lazy-loading contract

San Francisco is a massive open world, so optional work is opt-in. The default
boot path should contain only the systems and assets needed to render and play
the player's immediate starting space. Everything else should cross an explicit
activation or proximity boundary before it consumes network, decode, parse, or
GPU-upload time.

## Required boundaries

1. **Clean boot** — feature constructors, saved settings, multiplayer rosters,
   hidden panels, and remote states may allocate cheap procedural fallbacks, but
   must not request optional feature media or dynamically split UI code.
2. **First activation** — load only the selected asset(s) needed for the local
   experience. Remote optional cosmetics remain fallback-only unless their
   feature is locally active and they are within the immediate relevant space.
3. **Continued use** — load one newly selected asset when it is chosen. Do not
   preload a gallery to make a customizer feel instant; use labels, procedural
   previews, or already-cached content for its catalog.
4. **Exit and ownership** — dispose owned textures, materials, geometry, workers,
   and listeners when a heavy feature is rebuilt or permanently removed. Keep a
   cache only when reuse is likely and its memory cost is bounded.

Code and assets need independent gates. Prefer dynamic `import()` for optional
modules and an explicit `activate…Assets()` function for media. A constructor
should be deterministic and network-free; activation should be idempotent and
safe if the user changes a selection while a previous request is still in
flight.

## Review and QA checklist

- Record browser network requests from a fresh profile at clean boot.
- Assert zero requests for the feature's asset directory and optional chunk.
- Activate the feature and assert only the selected/nearby assets appear.
- Open its editor without accepting any eager catalog fetches.
- Choose one uncached option and assert exactly that option is added.
- Repeat with another connected client already using the feature; their distant
  state must not pull optional assets into a clean local boot.
- Run the production build and confirm intended optional UI/systems form separate
  chunks rather than rejoining the main bundle.
- Treat any newly discovered eager optional load as a high-priority optimization
  issue, even when the individual file is small; many small eager features are
  how a massive app loses its boot budget.

The surfing implementation is the reference pattern: board mesh construction is
procedural and request-free, surf activation loads only the active surface and
optional decal, the shaping-room module is dynamically imported, catalog choices
load one at a time, and remote board art is proximity-gated behind local surf
activation.

## Arrival priority ladder (destination content loads FIRST)

After a teleport or boot spawn, the destination loads in this order — never
"whole city first, destination last":

1. Ground carpet + terrain + the point-materialize ripple (the arrival
   coordinator's own work; the travel cover waits only for this).
2. The destination exhibit (optional site / tea garden essential).
3. Nearby vegetation — grass, flowers, trees inside the destination's own
   residency rings.
4. Everything else: far tile detail, background scenery, quiet-window work.

Mechanics (copy these, do not reinvent):

- `pipeline.compileAsyncPrioritized` is the arrival compile lane: it jumps the
  serialized compile queue, bypasses the ring-settle/arrival compile blocker,
  and near-skips the stillness wait. Ordinary `renderer.compileAsync` stays
  hard-blocked until the ring settles — that is correct for background scenery
  and wrong for destination content.
- Optional sites get the lane automatically: `reprioritizeForArrival` flags the
  destination site `priority`, which skips the background queue + quiet windows
  and dispatches its `context.compile` to the priority lane. A NEW SITE NEEDS
  NO EXTRA WORK beyond registering in `optionalWorldSites` and passing
  `context.compile` into `prepareOptionalRoot`/`warmRootPaced`.
- Exhibit-site vegetation (SiteFoliageStreamer) rides the arrival vegetation
  lane when its registration ring covers the arrival focus: admission skips the
  quiet window (still after exhibit construction idle) and the warm uses the
  priority lane. Automatic for new registrations.
- Wildlands destinations: `prepareDestinationEssentials` primes the lawn under
  the cover and fires `requestWildlandsTreePrime` (wildlands.prepareAt) after
  the exhibit; both compile on the priority lane.
- The tea garden mirrors this with `ensureEssential(signal, {priority: true})`
  plus lane-routed optional foliage when destination-bound.
- Never put a destination-bound load behind `waitForWorldBackgroundWindow`:
  its settled/arrival gates are hard and its deadline caps only the motion
  wait. Quiet windows are for content the player did NOT travel to.

QA: `node tools/arrival-priority-probe.mjs` boots at the tea garden and far-
teleports to the archery range, asserting exhibit + near-vegetation timings.

## Zone-only boot (`?zone=`)

`?zone=<id>` boots a "pocket world": a minimal substrate plus one destination
site instead of the whole city. `id` is an optional-site id (`beach-pianist`,
`corona`, `lands-end`, `sutro-baths`, `palace`, `archery`, `wave-organ`,
`goldman`, `pup`, `fort-mason-ensemble`, `afterlight`). An unknown id warns and
falls through to a full boot. `?j=` invites still win as the arrival if inside
the bubble; an invite farther than the bubble drops zone mode entirely. Resume
is ignored — a returning player lands in the zone, not their downtown position.
Grammar composes with the rest: `?zone=corona&autostart=1`, and shared links
carry `zone=<id>` until the city is woken.

- **The `fullTileRadius` lever** (`app/compose/zoneMode.ts` +
  `app/compose/initialArrival.ts`). `resolveInitialArrival` returns the zone's
  `bubbleRadius` *as* `fullTileRadius` (default 900 m; beach-pianist 1000 m).
  The ring coordinator then settles at the bubble, and both radius-restore paths
  (the worldReady quiet-window block and `RingCoordinator.onExpansionStalled`)
  restore to the bubble, so nothing un-clamps the world ~20 s in. Never clamp
  only the live `CONFIG.tileLoadRadius` — the stall fallback would undo it. The
  original city radius is carried out as `cityTileRadius` for wake. Terrain
  beyond the bubble still renders as bare clipmap; `landmarks.glb` (Golden Gate
  and Bay bridges, Alcatraz) is always resident and needs no special handling.
- **The site allowlist** (`app/compose/optionalSites.ts`). `zoneAllowlist`
  restricts the two auto-load gates to the destination site (independent of the
  perf A/B flags; `ensure()` still force-loads anything). Only that zone's
  exhibit foliage registers with the `SiteFoliageStreamer`; the rest are held.
  The site itself hydrates through the normal arrival/proximity lane because the
  spawn is at the site.
- **Wake semantics** (`main.ts` `wakeCity()` + `ui/wakeCity.ts`). Skipped
  city-wide systems (traffic + signals, scatter boats, islands, crab hunt, the
  citygen ring, forest + creatures, and the minimap landmark pins) are collected
  into `deferredCityWork` instead of constructed at boot. The "Wake the city"
  HUD button raises `CONFIG.tileLoadRadius` back to `cityTileRadius`, kicks the
  background tile expansion, runs the deferred builders sequentially, lifts the
  site restriction (registering the held foliage), and clears the shared-link
  zone param. It is idempotent and also exposed as `__sf.wakeCity()`. The ring
  has already settled and the front gate is inactive post-settle, so newly
  loaded tiles simply appear — no new sweep.
- **Adding a zone.** Append a `ZoneSpec` to `ZONES` in `zoneMode.ts`: the
  optional-site `id`/`siteId`, a boot-safe `center` (import the site's meta
  constant — never the site module), a `spawnKey` when the site has one in
  `SPAWN_POINTS` (otherwise the player lands at `center`), and a `bubbleRadius`.
  Default boot (no `?zone`) must stay byte-for-byte identical: every new path is
  inert when `worldScope.mode === "full"`.
