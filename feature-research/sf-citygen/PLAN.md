# SF CityGen — a portable, SF-tuned procedural building module

**Status:** plan (written Jul 8 2026). Self-contained handoff — an agent starting cold
should need only this doc + the files it names. Read the whole thing before touching code.

**Intent (owner's words):** take the learnings from the vendored Hong-Kong building
generator, but build *our own* open-source, modular version that is deeply optimized for
this open-world San Francisco, looks authentically SF neighborhood-by-neighborhood, has no
Chinese lettering outside Chinatown, no pop-in / silhouette shift, is genuinely walkable
inside (doors you can find, stairs you can climb), and collides *solidly citywide* so
cars/players/AI agents hit buildings instead of clipping through them — "GTA-ish, while
keeping performance." And it must stay a **portable module** that can be lifted into other
projects and retuned for other cities.

---

## 1. What's wrong today (root-caused, all in one place)

The current system (`src/world/buildings/*` wrapping `vendor/BuildingGenerator`) has four
defects, each traced to a concrete cause:

| Symptom | Root cause |
|---|---|
| **Chinese lettering on buildings citywide** | The vendored generator is a *Kowloon/HK tenement kit*. Its textures (`public/buildinggen/textures/Material_*`) carry Chinese signage, AC units, clotheslines. `ring.ts` stamped that ONE kit over every mid-rise in the whole city. |
| **Buildings pop in and "shift" from the original** | The exporter (`tools/export-buildings-citywide.mjs`) collapses each OSM footprint to a **single oriented bbox**, then quantizes to integer `length`/`width` in 3 m units. The generated twin therefore has a *different silhouette* than the baked original, and swaps in a few frames after you arrive (async generate + `suppressBuilding`). |
| **Can't find the way inside** | The interior's open storefront faces the footprint OBB's `yaw`, which is **not street-aware**. The open side can face an alley or a neighbor. |
| **Cars/AI clip through buildings** | Building collision (`physics.#tileColliders` + box3d static bodies) is materialized **only around the human player** (`CONFIG.colliderRadius = 260`, `maxActiveBuildingBodies = 240`, anchor = `player.position`). Collider *data itself* only exists for visual tiles streamed near the human. AI cars training across the city are in unloaded tiles with **zero** building bodies and zero sweep data → they clip through everything. |

**Phase 0 already shipped** (this session): `src/main.ts` now calls `createChinatown`
instead of `createBuildingRing`, confining the Kowloon kit to Chinatown (where it's
correct) and restoring the good baked SF facades everywhere else. This is the safe interim
state the new module replaces.

---

## 2. The data foundation we already have (use it — don't re-fetch)

Everything the new generator needs is already baked by `tools/prepare-city.mjs`:

- **Real footprint polygons + heights**, per building, in game coords:
  `{ id, poly:[[x,z]...], h, area, c:[cx,cz], p:paletteIdx }`. (Currently consumed by the
  baked-tile pipeline and the `facade.ts` shader.) *This is the fix for "shift": build on
  the real polygon, not a bbox.*
- **District geography already in game coords** — `districtPalette(x,z,h,tags,id)` in
  `prepare-city.mjs` already partitions SF: Marina/Pac Heights (`x∈[-1600,2300], z∈[-3000,-1100]`),
  Mission/Castro/Haight (`x∈[-1200,3100], z∈[1100,4600]`), Richmond/Sunset (`x<-2900`),
  industrial/warehouse by tag, default downtown. **Extend this into the archetype
  classifier** (§4).
- **OSM tags** (`building`, `building:levels`, `amenity`, `height`) are available at prep
  time — carry the ones we need (levels, use-class, roof shape) into the export.
- **lat/lon ↔ game-coord** conversion: `tools/geo.mjs` (`lonLatToLocal`, `ORIGIN`,
  `BBOX`). Lets us pin real SF neighborhood polygons if the rectangular districts prove too
  coarse.
- **The baked facade shader** (`src/world/facade.ts`, 724 lines TSL): masonry, window
  grids, storefronts, string courses, parapet masking, per-district palette. It renders the
  WHOLE city at 120 fps and is a *great far-LOD and fallback*. Keep it.
- **Proven perf pipeline** (`src/world/buildings/pools.ts`): merged mesh per building (3
  draws), invisible shadow-proxy box (shadows are this app's #1 GPU cost), frustum cull for
  free, incremental cross-frame merge (`pump`). Reuse this machinery.

---

## 3. Architecture — `src/world/citygen/` (portable module)

Mirror the `garden/` and `wildlands/` module conventions: a self-contained folder with a
thin host API and a **pure engine core that has zero SF dependencies**, plus a **swappable
theme pack**. Portability is a first-class requirement.

```
src/world/citygen/
  index.ts          host API: createCityGen(opts, ctx) → { update, dispose, stats }
  README.md         how to lift this module + write a new theme pack for another city

  core/             ENGINE — no SF, no neighborhood, no texture knowledge
    grammar.ts      split-grammar primitives: extrude, splitFloors, splitBays,
                    repeat, inset, gable/cornice/parapet caps. CGA-style (see §7 research).
    footprint.ts    polygon ops: street-edge detection, per-edge facade framing,
                    corner handling, setback/stoop insets (uses real OSM poly).
    massing.ts      polygon → floor stack → per-face facade panels (LOD0 shell).
    mesh.ts         panels → merged BufferGeometry per material (host batches it).
    lod.ts          LOD0 shell / LOD1 detailed / LOD2 impostor selection + crossfade.
    collider.ts     building → collider box set (walls, floors, stairs) in local space.
    rng.ts          deterministic mulberry32 keyed by building id (ported/kept).
    types.ts        BuildingSpec, Archetype, ThemePack, Panel, ColliderBox …

  theme/            SF THEME PACK — the only place SF style lives
    archetypes.ts   the SF archetype table (§4) + classifier(x,z,tags,h)
    victorian.ts    bay-window rowhouse grammar + palette (Haight/Pac Hts/Mission)
    edwardian.ts    flat-front bay rowhouse
    marina.ts       Mediterranean/stucco: arched garage, tile cornice (Marina/Sunset)
    downtown.ts     commercial mid-rise / FiDi curtain-wall
    soma.ts         brick warehouse / loft (adaptive-reuse brick)
    chinatown.ts    the Kowloon-flavored pack (reuse existing look, contained here)
    materials.ts    shared themed materials (stucco/brick/wood/glass/storefront)

  interior/         WALKABLE INTERIORS (generalized from today's interior.ts)
    interior.ts     pure fn (seed, footprint, floors, archetype) → group + colliders
    props.ts        shared-geometry furnishings, themed per archetype (de-Kowloon'd)
    stairs.ts       climbable switchback stair (real step colliders)

  stream/           CITYWIDE STREAMING + PHYSICS
    ring.ts         multi-anchor streaming ring (player + all AI/vehicle anchors)
    colliderIndex.ts citywide footprint-OBB index, decoupled from visual tiles (§6)
```

**Theme-pack contract** (what makes it portable): a `ThemePack` is data + small pure
functions — `{ classify(ctx) → archetypeId, archetypes: Record<id, ArchetypeSpec> }`, where
an `ArchetypeSpec` supplies grammar parameters (floor height, bay rhythm, cornice style,
material ids, roof type, entrance rule) and material builders. Swapping cities = writing a
new theme pack; the `core/` engine never changes. Ship `README.md` documenting this so the
module can be open-sourced and reused.

---

## 4. SF archetypes — neighborhood → style (the research)

SF reads as SF because each district has a dominant residential/commercial vernacular.
Sources: SF Travel architecture guide, Ruth Krishnan "7 styles", Wikipedia "Architecture of
San Francisco", SF Planning Preservation Bulletin 18. The archetype table:

| Archetype | Where (game-coord district) | Signature 3D features to model |
|---|---|---|
| **Victorian rowhouse** (Italianate / Stick / Queen Anne) | Haight-Ashbury, Alamo Square, Pacific Heights, inner Mission | 2–3 storeys, narrow (~25 ft) party-wall lots, **angled/slanted bay windows**, tall cornice with brackets, raised stoop + garage-under, ornate trim, pitched-or-false-front roof, saturated "painted lady" palettes |
| **Edwardian rowhouse** | citywide post-1906, esp. Mission, Richmond | flatter façade, **squared bay windows**, restrained trim, boxy massing, tall double-hung windows |
| **Marina / Mediterranean (Spanish Revival)** | Marina, Sunset, parts of Richmond | boxy, **flat roof + low tile cornice**, smooth stucco, **arched garage door + arched entry**, wrought-iron balconettes, big bow picture window over garage, pastel stucco |
| **Downtown commercial mid-rise** | Financial District fringe, Union Square, Nob/Russian Hill mixed | 4–10 storeys, masonry or curtain-wall grid, ground-floor **storefront glazing + fabric awnings + signband**, flat parapet, string courses |
| **FiDi tower** (keep baked) | Financial District core, SoMa towers | > ~34 m footprint or tagged tall → **left baked** (Salesforce/Transamerica are bespoke). Generator skips these. |
| **SoMa brick warehouse / loft** | South of Market, Dogpatch, NE Mission | wide masonry box, **exposed brick, heavy timber sash**, tall industrial windows, loading-dock ground floor, sawtooth or flat roof, adaptive-reuse look |
| **Chinatown tenement** | Chinatown core only | the existing Kowloon-flavored pack — vertical signage, awnings, AC units. Contained to this archetype only. |

**Classifier** = extend `districtPalette`'s geography (already validated in game coords) +
OSM tag hints (`building`, `building:levels`, `amenity=*` → mixed-use retail ground floor).
Deterministic and seed-stable so a building looks the same across visits/clients. Add
per-building jitter within an archetype (palette, bay count, trim variant) so blocks read
varied, not cloned — via the existing `styleParams(seed)` idea in `ring.ts`.

---

## 5. Rendering & LOD — no pop, no shift

The shift/pop today comes from (a) bbox-not-polygon silhouette mismatch and (b) a hard
mesh swap. Both are designed out:

1. **Footprint-faithful massing.** Extrude the *real* `poly` to the *real* `h`. The
   generated LOD1 building occupies the same silhouette + height as its baked twin → nothing
   to "shift" to.
2. **Baked facade = the far LOD.** The baked prism + `facade.ts` shader stays as LOD2 for
   the whole distant city (already citywide, already cheap). We do NOT suppress the baked
   twin until the detailed twin is merged AND within the near band.
3. **Crossfade, not snap.** On promotion (LOD2→LOD1) fade the detailed mesh in over ~0.4 s
   (material opacity ramp) while the baked twin fades out; silhouettes already match so the
   eye sees detail resolve, not a jump. Same on demotion.
4. **Impostor option** for the mid band if merged-geometry memory is tight (borrow the
   SeedThree billboard-impostor trick from `wildlands`), but likely unnecessary — merged
   mesh + shadow proxy already scales.
5. **Reuse `pools.ts`**: merged mesh per building, shadow-proxy box, incremental `pump`
   merge, frustum cull. The engine emits the same `{geometry, material}` panel stream the
   pools already consume.

Perf contract (from existing memory + probes): near band ≈ 30–45 resident detailed
buildings, merged into 3 draws each material-class, shadows via proxy only, target keep the
city at 120 fps class. Verify with a headless WebGPU probe like `tools/wild-probe.mjs`.

---

## 6. Physics & collision — citywide, multi-anchor, walkable (GTA-ish)

This is the biggest architectural change and the fix for car-clipping. Three parts:

### 6a. Decouple collision data from visual tile streaming
Building collision must exist wherever an agent is, independent of whether that tile's GLB
is visually loaded. Build a **citywide collider index** (`stream/colliderIndex.ts`): load
the footprint OBBs + heights for the whole city (or stream them on a much coarser, wider
grid than visuals — collider boxes are tiny). Source it from the same baked collider JSON
(`public/data/colliders/tile_*.json`) but keyed for cheap spatial queries (uniform grid /
loose quadtree) rather than "is this tile visible."

### 6b. Multi-anchor static-body streaming
Generalize `physics.#updateBuildingBodies(playerPos)` to take **a list of anchors** =
player + every AI car + every active vehicle/agent. Materialize box3d static bodies for the
nearest-N buildings around *each* anchor (union, dedup by building id). box3d static AABBs
are cheap in broadphase (they never move); budget scales with anchor count (e.g. 8–12
bodies per car × 48 cars is a few hundred — fine). This makes cars hit buildings anywhere
they drive, not just near the human. AI cars already query `physics.sweepBuildings()`; point
that at the citywide index too so their *steering* sees buildings before the body even
materializes.

- Keep the existing "never spawn a static box around a body already inside it" guard.
- Hysteresis on create/destroy so bodies don't churn as cars pass.
- The generator's near buildings contribute *precise* wall colliders (per real polygon
  edge, not one bbox) so you don't clip a re-entrant façade.

### 6c. Walkable interior colliders
The generated interior contributes its own local colliders (floor slabs, stair steps as a
short collider staircase, thin partition walls) transformed by the building yaw — already
the pattern in today's `interior.ts`/`index.ts`; keep it, make the **entrance street-aware**
(§8) and the stairs real step boxes so you can walk up them. Player capsule + step height
must clear a stair rise (check `player.ts` step handling).

**Verification is mandatory here:** drive a car (and the AI training loop) into a building
and confirm no clip; walk in the front door; climb the stairs. Use the headless CDP drive
harness (see `sf-drive-test-harness`, `sf-headless-cdp-verify` memories) and the AI-car
probe. This is the acceptance gate for the physics phase.

---

## 7. Facade grammar — how the 3D detail is generated (game technique research)

Use a **split grammar / CGA-shape** approach (Müller et al., "Procedural Modeling of
Buildings"; CGA Shape; layered shape grammars). This is the industry-standard technique
(CityEngine, and the lineage behind GTA/Watch Dogs/Cities-Skylines building kits). Rules,
top-down:

- **Mass**: real footprint polygon → extrude to real height → faces (façade / roof).
- **Façade** (per polygon edge): split vertically into `groundFloor | upperFloors* |
  cornice/parapet`. Ground floor differs by archetype (stoop+garage for Victorian, arched
  garage for Marina, storefront+awning for commercial, loading dock for SoMa).
- **Floor**: split horizontally into a **bay rhythm** (`pier | bay | pier | bay …`) sized
  to the archetype (Victorian ~ one slanted bay per lot-width; commercial = regular window
  columns).
- **Bay/window**: instantiate the archetype's window asset — *real geometry* for the SF
  signature that the shader can't fake well: the **slanted/squared bay window box** that
  projects from the façade, the bracketed cornice, the arched opening. Small flat details
  (mullions, sills, trim lines) can stay shader/normal-map to keep triangle count down.
- **Kit-of-parts**: a small library of themed parts (bay box, cornice profile, storefront,
  garage door, stoop, parapet cap) instanced by the grammar. Keeps geometry shared and
  merges cheap. This is our own kit — no external textures with foreign signage.

Determinism: every rule choice is a pure function of `(building id, rule path)` via
`core/rng.ts`, so geometry is identical across clients (multiplayer-safe) and visits.

---

## 8. Interiors & street-aware entrances

- **Entrance orientation**: pick the façade edge that faces the **street**, not an arbitrary
  OBB axis. Signal for "street-facing": the polygon edge whose outward normal points toward
  the nearest road / open space (we have the road network + can raycast the collider index
  for the most-open edge). Put the door + storefront + stoop there. Guarantee the doorway is
  an actual gap in the wall colliders and the interior open side aligns with it.
- **Interiors** generalized from `interior/interior.ts` (today's is good: seeded shops +
  furnished upper floors + switchback stairs, hard perf contract — 2 shared geoms, singleton
  materials, emissive-only lighting, build <40 m / dispose >80 m). Changes: theme the shop &
  apartment fittings per archetype (café/boutique/office/loft, not only noodle-house/
  herbalist), and drive wall tints from the theme pack. Keep the build/dispose gate + the
  determinism contract.
- **Lighting stays emissive-only** (fixed LightPool; no new THREE lights — see
  `sf-vehicle-switch-lights`).

---

## 9. Phases (each = a shippable checkpoint; acceptance criteria explicit)

Sequential. main.ts has a known parallel-edit race — serialize any main.ts edits.

- **Phase 0 — Stop the bleeding. ✅ DONE.** Kowloon kit confined to Chinatown; baked
  facades restored citywide. Accept: no Chinese lettering outside Chinatown; typecheck clean.

- **Phase 1 — CityGen core + SF classifier + footprint-faithful massing. ✅ DONE (Jul 8).**
  Built: `tools/citygen-classify.mjs` (single-source SF archetype classifier),
  `tools/export-citygen.mjs` → `public/citygen/buildings.json` (91,449 buildings, real
  polygons kept — 82.3% non-rectangular; histogram victorian 22% / edwardian 6% / marina
  29% / downtown 37% / soma 4% / chinatown 1.4%), portable `src/world/citygen/core/`
  (types/rng/footprint+earclip/massing/mesh/collider — zero SF, zero THREE),
  `theme/archetypes.ts` (SF specs), `index.ts` (`generate()` pure API + `createCityGen`
  no-op stub), `README.md`. Verified: `tools/citygen-probe.mjs` all-pass + esbuild-bundled
  core unit check (convex + concave-L + real footprint → exact silhouette/area, per-edge
  colliders). tsc clean. NOT yet wired to main.ts (no visual change).
  **DECISIONS (owner):** full 3D massing (not shader-only); Victorian rowhouse = first
  vertical slice. Next: Phase 2 grammar starts with the Victorian bay-window archetype.

- **Phase 2 — Facade split-grammar + SF theme packs.** Implement `core/grammar.ts` + the
  archetype packs (Victorian bay, Edwardian, Marina, downtown, SoMa, Chinatown). Accept:
  each district visibly reads as its real SF style; blocks look varied not cloned; headless
  render probe within GPU budget.

- **Phase 3 — LOD + crossfade, kill pop-in.** Baked=LOD2, detailed=LOD1, impostor optional
  mid; crossfade on promote/demote; suppress baked twin only after detailed merge completes.
  Accept: walking/driving toward a block shows detail *resolve*, never a jump or shift; no
  double-draw; no holes at range.

- **Phase 4 — Physics citywide + multi-anchor + walkable colliders.** Collider index
  decoupled from visuals; multi-anchor body streaming (player + all AI cars + vehicles);
  generated per-edge wall + interior/stair colliders. Accept: **AI training cars no longer
  clip buildings anywhere in the city**; drive a car into a wall → solid stop; walk in the
  door and climb stairs; verified via headless drive harness + AI-car probe.

- **Phase 5 — Enterable interiors, street-aware entrances, themed + de-Kowloon'd.** Accept:
  every near building has a findable street-facing door; interior theme matches the exterior
  archetype; determinism holds across two headless clients.

- **Phase 6 — Portability + docs.** `README.md` + `ThemePack` API frozen; a second sample
  theme (or a documented "how to retune for another city") proving the core is SF-agnostic;
  remove/retire the old `vendor/BuildingGenerator` dependency for non-Chinatown use.

---

## 10. Non-negotiable constraints (carry into every phase)

- **No new THREE lights** anywhere (fixed LightPool). Interiors/signs = emissive only.
- **Determinism**: all variation from `(building id, rule path)` via mulberry32; identical
  geometry/colliders on every client + visit (multiplayer + AI-training safety).
- **Perf**: merged-mesh + shadow-proxy + frustum-cull + incremental pump; keep the city at
  120 fps class; every rendering/physics phase ends with a headless probe number, not a
  vibe.
- **Portability**: SF specifics live ONLY in `theme/`; `core/` stays city-agnostic.
- **main.ts edit race**: serialize edits to `src/main.ts`.
- **Footprint fidelity**: always build on the real OSM polygon + real height, never a bbox.
