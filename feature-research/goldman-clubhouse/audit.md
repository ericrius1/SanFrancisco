# W6 Goldman Tennis Center clubhouse — audit

## Files changed
- `src/world/goldenGateTennis/clubhouse.ts` (NEW)
- `src/world/goldenGateTennis/npcs.ts` (NEW)
- `src/world/goldenGateTennis/index.ts` (modified)

No other files touched. (`src/main.ts` was NOT edited — see INTEGRATION SPEC.)

## What changed per file

### clubhouse.ts (new)
Enterable rebuild of the Taube Family Clubhouse replacing the solid extrude:
- `CLUBHOUSE_FRAME` local frame (cx −1363.78, cz 2197.26, yaw −0.02922 rad, 8.2 × 56 m bar) rectified off the OSM footprint's straight east edge, so the glass ribbon lands where the old extrude put it. `clubhouseToWorld/ToLocal` helpers exported.
- Shell: cream wall segments (1.5 m buried skirt), solid park-facing west wall, east court side = sill + header + glass ribbon + dark mullions. Two door OPENINGS (gaps, always walkable, ≥2 m): east/court door at local v −14.3 (on the "clubhouse court link" path), west/park door at v −16 (inside the existing `isFenceOpening` x<−1354 z2160-2232). Flat overhanging roof; unlit ceiling panel + emissive light strips (MeshBasic — NO THREE.Light); distinct floor slab with baked door ramps.
- Interior: reception desk + monitor + ball tubes, towel back-shelf, two benches + low table along the glass, trophy case (wood plinth, transparent hood, 3 gold cups), pro-shop corner (wall shelves, gondola, 4 leaning rackets), 6 wall pennants, rug runners.
- SW service wedge of the surveyed footprint kept as a solid low annex extrude (park-side massing preserved).
- Colliders: 6 shell boxes (full height, door gaps open — glass is solid), 8 furniture boxes, 3 annex edge barriers, returned as specs for the site to register.
- `groundTopAt(x,z,base)`: overlay contribution — `floorTop` inside the bar, lerp ramps out both doors, null elsewhere (35 m broad-phase).
- floorTop = dense 1 m max of `baseGroundTop` over the BAR only (+0.30 drape margin). Terrain under the bar is ~74.3–74.65; floor lands at 74.94, ~0.4 m ramp at both doors.

### npcs.ts (new)
`ClubhouseNpcs` (busker gating pattern):
- Receptionist (seed `goldman-clubhouse-reception`) parked behind the desk facing the court entry, `poseIdle` breathing.
- 4 milling members (seeds `goldman-clubhouse-member-1..4`), waypoint wander over 13 waypoints (lobby, counter, trophy case, benches, chat pair, pro shop, north nook, and 3 outdoor spots by the court door/path); inside↔outside legs always thread the east door. Chat-spot pair face each other and linger. Members 1 and 3 carry a racket prop clasped in the right mitt. Deterministic per-NPC RNG.
- Day/night: `daylight?: () => boolean` (default always-day) rechecked on a 2 s timer; at night members 2–4 hide, receptionist + member-1 remain.
- Gating: ANIM 60 m / SHOW 75 / HIDE 90 with hysteresis; ZERO work when far (one squared distance, early return); subtree matrices refreshed manually (`updateMatrixWorld(true)`) only while animating — the site root is out of the scene matrix pass.
- `dispose()` disposes rig materials only and detaches BEFORE the site's geometry-disposing traverse (rig boxes come from rig.ts's shared cache used by the player).

### index.ts (modified)
- Old `makeClubhouse` + local `polygonShape`/`degToRad` removed; builds `buildClubhouse(map)` instead.
- `installCourtGrounding` → `installSiteGrounding(map, grades, clubhouse)`: clubhouse floor/ramps checked before the court-pad loop.
- Clubhouse collider specs registered through the existing `registerStaticBox` inside the same try/rollback as the fence/net colliders.
- New `GoldenGateTennisSiteOptions.daylight?: () => boolean`.
- New `update(dt, elapsed, playerPos)` method (drives NPCs; safe to call unconditionally).
- New `groundOverlay` getter (see Open risks — golf overlay clash).
- `dispose()` calls `#npcs.dispose()` first.

## Deviations from the plan
- Interior is the rectified bar, not the raw polygon — explicitly permitted ("simplify to the main bar shape"); the SW wedge silhouette is preserved by the solid annex.
- No F1 `held.ts` attachment for NPC rackets (F1 was landing in parallel); rackets are simple props parented under `rig.handR` + `setRigClasp`, which is pose-safe and dependency-free.
- Added a `groundOverlay` getter not in the plan — needed because of the golf overlay clash below.

## Test results
- `npx tsc --noEmit` clean.
- Headless probe (own vite on a free port + SF_RELAY_PORT=8788, headless Chrome WebGPU/metal, real name-gate entry, teleport to the site, `goldenGateTennis.update()` driven manually per frame): **5/5 assertions pass, zero console errors/page exceptions.**
  - floor grounding: groundTop inside = 74.94 vs base 74.37; outside door 74.55 (gentle ramp)
  - colliders: ray from lobby hits the west wall at 3.46 m; ray out through the east door opening hits nothing within 12 m
  - NPC group present (5 rigs) and visible; a member demonstrably displaced mid-route
- Screenshots (inspected, iterated 4×): `a-exterior-from-courts.jpg` (pavilion + glass ribbon, NPCs visible through the glass, walker outside on the path, door ramp), `b-interior-reception.jpg` (desk, receptionist, towel shelf, rug, light strips, courts through glass), `b2-interior-lounge-south.jpg` (corridor, benches, trophy case with cups, pennants), `c-npc-midwalk.jpg` (chat pair, one carrying a racket). Probe + shots: scratchpad `clubhouse-probe/`. Vite/Chrome killed after each run.
- Iterations fixed en route: lawn drape poking through the floor (floor terrace margin + bar-only sampling — the outline's uphill annex vertices were hoisting the floor 1.7 m), ceiling z-fight with the roof underside, hemisphere ground-bounce turning the ceiling mud-brown (now unlit).

## Draw-call cost
Old clubhouse = 3 draws. New = 13 static meshes (walls, roof, floor+ramps, dark frames, glass, wood, whites, accents, gold, case glass, ceiling, light strips, annex) → **+10 static draws**, all merged per material. NPCs = 5 shared-cache rigs (same cost class as buskers/remotes), fully hidden beyond 90 m and animated only within 60 m.

## Open risks / cross-cutting bug (needs orchestrator action)
1. **Single ground-overlay slot clash (pre-existing, now load-bearing):** `WorldMap.setGroundTopOverlay` holds ONE overlay. The deferred Presidio golf load (`src/gameplay/golf/data.ts:183`) installs its own and silently REPLACES the tennis site's — and the wildlands region gate that triggers it includes GG Park. This already flattened the Goldman court terracing before W6; it now also kills the clubhouse floor/ramp grounding (player would clip into the raised floor). Verified in the probe; the probe re-asserts via the new `goldenGateTennis.groundOverlay` getter. Proper fix (NOT in my file list, not made): either make heightmap.ts hold an overlay list, or have golf compose the previous overlay: `const prev = map.groundTopOverlay; map.setGroundTopOverlay((x,z,base)=>{ const b = prev ? prev(x,z,base) : base; return course.contains(x,z) ? course.ground(x,z,b) : b; })` (requires exposing the current overlay or an `addGroundTopOverlay`). W2/W4 own the golf/main seams.
2. NPC leg y-values lerp between waypoint heights; outdoor waypoint heights are sampled once at construction (fine unless the terrain overlay under them changes later).
3. If future code parents anything else under the site group at runtime, remember the group is `matrixWorldAutoUpdate=false` (NPCs handle their own refresh).

## INTEGRATION SPEC (exact main.ts wiring)
1. Per-frame NPC driver — in `tick()`, near the other feature updates (e.g. right after `pickleball` / dog-park updates), add:
   ```ts
   goldenGateTennis?.update(dt, elapsed, player.position);
   ```
   Signature: `update(dt: number, elapsed: number, playerPos: THREE.Vector3)`. Early-returns on one squared distance when the player is >90 m from the clubhouse; safe to call every frame unconditionally.
2. Optional day/night thinning — where the site is created (main.ts:500):
   ```ts
   goldenGateTennis = createGoldenGateTennisSite(map, {
     physics,
     daylight: () => sky.sunElevation > 0   // or the project's preferred day predicate
   }).addTo(scene);
   ```
   Omitting `daylight` keeps the full crowd at all hours.
3. REQUIRED for grounding to work in-game: resolve the golf overlay clash (Open risks #1). Until overlays chain, a stopgap after the golf course loads is:
   ```ts
   // after loadGolfCourse(map) resolves, re-compose the tennis grounding:
   const tennisOverlay = goldenGateTennis?.groundOverlay;
   // ...combine with golf's overlay instead of letting golf replace it
   ```
   but the clean fix belongs in heightmap.ts (overlay list) or golf/data.ts (compose `prev`).
