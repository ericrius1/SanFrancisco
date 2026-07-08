# SeedTrees Everywhere — replace all simple trees with SeedThree across Marin + the city

**Status:** plan, ready for agent execution (written Jul 7 2026)
**Owner intent:** kill the old stylized/merged "simple" trees; every tree in the world renders through the SeedThree pipeline (same look as the Botanical Garden), WITHOUT losing the current 120fps-class performance.
**This doc is self-contained** — an agent starting cold should need nothing else. Read the whole doc before starting any phase. Phases are sequential; do not parallelize edits to `src/main.ts` or `src/world/flora.ts` across agents (this repo has a known parallel-agent edit-race history on main.ts).

---

## 1. Current tree inventory (verified Jul 7 2026)

| System | File | Trees | Mechanism | Fate |
|---|---|---|---|---|
| Botanical Garden | `src/world/garden/` | 916 | SeedThree near/far LOD (the reference implementation) | KEEP — source of the tech |
| Park scatter | `src/world/flora.ts` | ≤620 (`PARK_TREE_CAP`, 1/250m² lawn) | per-streamed-tile merged mesh (`grn_` masks → one merged geometry per tile, streams with tile) | REPLACE |
| Marin near-field | `src/world/flora.ts` | caps: conifer 900, cypress 340, oak 340 (+bush 1260) | camera-following instanced pools, `NEAR_R=360`, cell 26, rebuild on 18m move | REPLACE trees; bushes stay |
| Marin far forest | `src/world/flora.ts` | (far pools, same species bank) | instanced far pools over `MARIN` bounds | REPLACE via impostor tier |
| Marin grove redwoods | `src/gameplay/forest.ts` | 4200 (`TREE_TARGET`, 150 clusters) | ONE InstancedMesh of stylized redwoods, sway shader | REPLACE rendering only — animals/gummy/grove placement stay |
| Grass / wildflowers / bushes | `flora.ts` | 7500/700/1260 | instanced | KEEP as-is (out of scope) |

Total trees going SeedThree: ~620 park + ~1580 Marin near + 4200 redwoods + far pools ≈ **6,500–7,000 trees** vs the garden's 916. Naive reuse of the garden's far tier (~1.6k tris/tree) would be ~11M far tris — **not acceptable**. Hence the 3-tier design below.

### Species mapping (flora `TreeKind` → SeedThree design)
Reuse the 8 already-staged texture sets in `public/seedthree/` (bark/, leaves/ — 80M, already shipped). Designs live in `src/world/garden/seedTreeGarden.ts` `SEED_TREE_DESIGNS`; the city map should be its own table (new file, see Phase 0):

| flora kind | SeedThree species | notes |
|---|---|---|
| conifer | `douglasFir` | same design as garden coast redwood (id 0), taller controls for Marin |
| cypress | `pine` | garden id 2 (gnarly ponderosa read) |
| oak | `whiteOak` | garden id 4 |
| eucalyptus | `americanBeech` | garden id 6 |
| palm | `joshuaTree` | garden id 7; `nearClones: false` (rosette clone cost — see gotchas) |
| redwood (forest.ts) | `douglasFir` | distinct seed + `height` control ~30–34, dense grove read |
| bush | — | stays procedural (no SeedThree analog worth the cost) |

---

## 2. Target architecture — one shared engine, three tiers

Extract the garden's tree tech into a **portable, system-agnostic engine**: `src/world/seedForest/` (new folder, same portability discipline as `src/world/garden/`: consumers hand it slot lists; it owns rendering + LOD).

```
src/world/seedForest/
  templates.ts   — grow-once hero cache: species key → Promise<THREE.LOD>
  farTier.ts     — instanced LOD2 far sets over slot lists, CHUNKED (extracted buildFarSet + setFarSlotHidden from seedTreeGarden.ts)
  nearTier.ts    — NearTierManager (extracted, parameterized radii/caps)
  impostorTier.ts— crossplane billboard tier (2 quads/tree) via vendor impostor baker
  index.ts       — createSeedForest({ slots, designs, tiers }) → { group, update(camera), addSlots/removeSlots(key), stats }
```

### Tier boundaries (initial values — tune in Phase 4)
- **Near (hero clones)**: < 60 m, global cap ~24 clones (garden's numbers; may raise to 32). Real THREE.LOD with LOD0/1/2. CASTS shadows.
- **Mid (instanced LOD2)**: 60–220 m. The garden's far tier, but **chunked ~128 m** with real bounding spheres + `frustumCulled = true` (the garden uses `frustumCulled=false` because it's one 620×520 m patch — city-wide that would draw everything always; chunking is mandatory). Shadow policy decided in Phase 4 (default: castShadow **false** beyond the first CSM cascade — shadows are this app's #1 GPU cost at 4–7 ms).
- **Far (impostors)**: > 220 m. `vendor/SeedThree/src/core/impostor.js` — crossplane billboard baked from LOD0, ONE quad per plane, 2 planes = 4 tris/tree. Bake once per species at boot (offscreen, async after templates grow), one InstancedMesh per species per ~512 m chunk. NO shadows. 7,000 trees ≈ 28k tris total at this tier — trivial.

### Key engine contracts
- `templates.ts`: `getTemplate(designKey) → Promise<{ lod: THREE.LOD, lod2: Object3D }>` — each species grows **exactly once per session** regardless of how many systems use it (garden + Marin + city share). `createTree` is CPU-heavy (hundreds of ms per species); grow sequentially, never in parallel (thrashing — the garden already does this correctly). Reuse the garden's `loadTexture` (graceful 404 → procedural fallback) and `shadeSeedTreeFoliage` far-card shading.
- `farTier.ts`: input `Slot { x, y, z, yaw, scale, designKey, chunkKey? }`. Must support **add/removeSlots(chunkKey)** for tile streaming (Phase 2): per-chunk buckets so removal = drop the chunk's InstancedMeshes, no global rebuild.
- Slot hide/show for near-promotion reuses the garden's `ZERO_SCALE = 1e-6` + `addUpdateRange` partial-upload trick verbatim.
- The near-tier rebin self-drives via `onBeforeRender` on an always-rendered driver mesh gated to `isPerspectiveCamera` (shadow passes hand you the sun's ortho camera — the garden already guards this; keep the guard).
- The whole engine takes NO scene lights, adds NO lights (LightPool constraint: light COUNT change = 7 s pipeline rebuild).

### What the garden keeps
`src/world/garden/seedTreeGarden.ts` becomes a thin consumer of `seedForest` (its designs + slots + the garden-specific meadow `nearClone:false` flags). Garden visual output must be pixel-comparable before/after (same designs, same seeds, same slot math).

---

## 3. Phases — each is one agent handoff

Every phase ends GREEN: `npx tsc --noEmit` → 0 errors (ignore the pre-existing `src/gameplay/aiCars/index.ts` Trainer/Learner error if still present), `npm run build` succeeds, plus the phase's verify recipe. Commit per phase.

### Phase 0 — extract the engine (no visual change)
1. Create `src/world/seedForest/` per §2 by **extracting** (not rewriting) `buildFarSet`, `writeFarCardSlot`, `setFarSlotHidden`, `NearTierManager`, `prepareTemplate`, `shadeSeedTreeFoliage`, `loadTexture` from `src/world/garden/seedTreeGarden.ts`. Parameterize: radii, caps, rebin ms, chunk size, shadow flags.
2. Add chunking to the far tier (chunkKey → bucket group with computed boundingSphere, `frustumCulled=true`). The garden becomes a single chunk to preserve its current behavior exactly.
3. Add `templates.ts` grow-once cache; garden switches to it.
4. Rewire `seedTreeGarden.ts` to consume the engine. Public garden API (`src/world/garden/index.ts`) unchanged.
5. **Verify:** build green; Node probe of `src/world/garden/layout.ts` still deterministic (see §5 probe recipe); boot the app headless and confirm `[sfbg] SeedThree garden online: 7 species, ~900 trees` log still appears with the same instance count.

### Phase 1 — impostor tier
1. `impostorTier.ts`: at boot (after templates resolve, async, never blocking first paint) bake each used species' crossplane billboard with `vendor/SeedThree/src/core/impostor.js` (`processPixels`/bake entry — read the file header; it was built for exactly this). Cache textures per species in-session.
2. Far-tier chunks beyond `impostorDist` render as impostor InstancedMeshes instead of LOD2 sets. Cross-fade or hard-swap at the boundary — hard swap acceptable at 220 m; NO shader `If()` branches for fades (mix/multiply only — If()+mx_noise corrupts skipped pixels on this renderer, known hazard).
3. Wire the garden to use impostors past 220 m too (its far tris drop ~1.5M → ~4k beyond the boundary; big win on its own).
4. **Verify:** teleport camera 400 m from the garden, screenshot, trees still read as trees (crossplanes, not blobs); draw calls for the garden at that range ≤ 3/species; fps probe (§5) not worse than baseline.

### Phase 2 — city park scatter (tile-streamed)
1. In `flora.ts`, the per-tile tree path (`onTileGreens` → merged tree mesh) instead emits **slot lists** (positions already computed by the existing lawn-mask sampling — keep that placement math untouched) and calls `seedForest.addSlots(tileKey, slots)`; `dropTile` → `removeSlots(tileKey)`.
2. Keep the old merged-mesh path behind `FOLIAGE_TUNING` flag `seedTrees: { v: true }` (src/config.ts:92) — flag OFF = old trees, for A/B and rollback.
3. Respect the existing `highUp` gate (altitude detail-LOD skips park trees when cruising high — pass it through; when highUp, new tiles enqueue slots but the engine renders impostor tier ONLY).
4. `NO_FLORA` zones and Botanical Garden bounds exclusion: garden already excludes pines inside its bounds; ensure park scatter also skips `inBotanicalGarden` (import from `src/world/garden/layout.ts` — it's pure, no three).
5. **Verify:** drive-test recipe (§5) through Golden Gate Park and a downtown park at street level: tile load p95 must stay < 10 ms (memory baseline: 8.9 ms) — measure with the tile-jitter probe; toggling the flag swaps tree styles live after `flora` rebuild.

### Phase 3 — Marin (near-field pools + redwood grove)
1. `forest.ts` redwoods: keep grove placement math (150 clusters, 4200 points) but hand the points to `seedForest` as static slots (one chunkKey per grove or per 256 m cell). Delete the stylized redwood InstancedMesh + its sway shader. Animals, gummy launcher, ride logic untouched.
2. `flora.ts` Marin near-field tree pools (conifer/cypress/oak): replace with seedForest slots generated by the same camera-following cell walk — BUT prefer converting Marin to **static precomputed slots** over the `MARIN` bounds (deterministic hash like the garden) so the engine's chunk culling does the work instead of 18 m rebuilds. Bushes keep the old pool path.
3. Watch total counts: 4200 redwoods at LOD2 within 220 m of a player standing in the grove ≈ maybe 400–700 trees in mid tier — check `stats.farTriangles` stays < 2.5M in the worst spot (grove center).
4. **Verify:** teleport to grove center (-4500, -6300 area — confirm from forest.ts placement), fps probe ≥ baseline-10%; bears still rideable (E near a bear); screenshot of the grove at 50 m and 400 m.

### Phase 4 — perf gate + shadow policy (the make-or-break phase)
1. Baselines FIRST (before declaring done): run the §5 fps probe at 5 spots: downtown canyon, garden meadow, grove center, GG bridge deck, 300 m altitude overview. Compare against pre-Phase-2 numbers (agent must capture those in Phase 0 and commit them to `feature-research/seedtrees-baselines.json`).
2. Shadow policy sweep: {near-only, near+first-cascade-mid, all-mid} × measure. Shadows are the #1 GPU cost in this app (4–7 ms, more than half the city frame; there is already an every-other-frame shadow render throttle — do not break it). Expected outcome: near clones + mid tier within ~80 m cast; everything else `castShadow=false`.
3. Texture/memory audit: `renderer.info` textures + geometries before/after; species impostor bakes are ~1–2 MB each — fine; confirm no leaked buckets after roaming (roam 2 km, return, counts stable).
4. Draw-call budget: worst spot ≤ +40 draw calls vs old system (chunked far sets: ~8 species × (1 bark + ~4 card meshes) × visible chunks — if over budget, merge card buckets per chunk or grow chunk size).
5. Delete dead code: old flora tree geometry builders (`treeGeometry` merge paths for the 5 kinds), forest.ts redwood mesh + sway shader, once flag has soaked. Keep the flag one release.

---

## 4. Known gotchas (from this repo's history — respect these)
- **Shadows dominate GPU** (4–7 ms). Any tier that casts shadows multiplies its cost; the shadow throttle renders shadow maps every other frame — new meshes get that for free, don't bypass it.
- **Shader branches**: never use TSL `If()` with `mx_noise` in materials — corrupts skipped pixels. Distance fades = `mix`/`multiply` only.
- **Webdriver fps probes need `?fullfps`** — headless Chrome rAF-caps at ~20fps otherwise.
- **Quantized-mesh positionLocal amplification (~420×)** applies only to the meshopt city tiles, NOT SeedThree meshes — but if anyone bakes impostors onto quantized geometry, div by modelScale.
- **r185 instanced buffers**: `StaticDrawUsage` + `needsUpdate` on rewrite; `DynamicDrawUsage` re-uploads every frame regardless (botanicalGrass.ts has the comment).
- **Rosette species (joshuaTree/palm)**: THREE.LOD deep clone takes SECONDS (16 s measured) due to CAP-preallocated instanced buffers — `nearClones: false` for palms, always.
- **LightPool**: never add real Lights; light count change = 7 s scene-wide pipeline rebuild.
- **main.ts edit races**: one agent at a time touches main.ts; re-grep after any parallel work.
- **lil-gui dep** is required by the SeedThree API chain (already in package.json — don't remove).
- **`onBeforeRender` driver**: gate near-tier rebin to `isPerspectiveCamera` (shadow pass hands the ortho sun camera).
- **Preview**: `preview_start` is broken in this repo — use Bash vite on a fresh port (`SF_RELAY_PORT=8788`, kill after; shared 5179 = humans only).

## 5. Verify recipes (agents: copy-paste and adapt)
- **Build:** `npx tsc --noEmit` (expect only the pre-existing aiCars error, if any) then `npm run build`.
- **Layout determinism probe (pure Node, no GPU):** `node --experimental-strip-types` a script importing `src/world/garden/layout.ts` with a stub terrain `{groundHeight:()=>12, surfaceType:()=>1, isWater:()=>false}` → expect 916 trees, deterministic re-run. (Scratchpad example existed at gardenprobe.mjs; recreate.)
- **Headless app probe:** build, serve `dist/` via `node server/server.mjs` on a fresh port, headless Chrome with `--enable-unsafe-webgpu --use-angle=metal` flags + `?fullfps&autostart`, drive via CDP: blur the name input first (keys get eaten otherwise), `__sf.teleportToTarget(x, z)` or `player.teleportTo`, read `__sf.renderer.info` (draw calls, triangles), fps via rAF-delta sampling over 5 s. `__sf.garden.stats` and seedForest stats for counts.
- **Screenshots:** freeze pattern — `__sfManual` freeze BEFORE setting camera (player.update + afterSteps + renderPosition freeze; see repo memory "SF preview camera control": never proximity-hide meshes).
- **Tile-stream latency:** existing tile-jitter measurement (p95 attach time) — compare against 8.9 ms baseline.

## 6. Execution notes for the orchestrator
- Order: 0 → 1 → 2 → 3 → 4, sequential. Phases 1 and 2 could theoretically swap, but impostors-first (1) de-risks the tri-count math for everything after.
- Each phase = one Opus agent with THIS DOC + the phase number. Agent reads referenced files fully before editing (`seedTreeGarden.ts`, `flora.ts`, `forest.ts`, `impostor.js` header).
- Baselines from Phase 0 get committed (`feature-research/seedtrees-baselines.json`) so later agents compare against fixed numbers, not vibes.
- Rollback story: `FOLIAGE_TUNING.seedTrees` flag reverts city trees; garden unaffected; forest.ts revert = git.
