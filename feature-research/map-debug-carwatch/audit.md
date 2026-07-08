# Audit — watch-cars key + big-map Training/Debug layer

## Files changed
- `src/main.ts` — wired live debug getters into the Minimap constructor; added `carViewIdx` counter + the watch-cars key handler.
- `src/ui/minimap.ts` — debug-getter constructor params/fields, big-map-only "Training layer" toggle button + legend, live `#drawBigDebug` overlay.
- `src/ui/hud.ts` — added the `N` = "watch cars" chip to the keyboard control legend.
- `index.html` — CSS for `.bigmap-debug*` (toggle button + legend dots).

## Key chosen
**KeyN** (not KeyV as the plan suggested). `KeyV` is already bound in `main.ts` to `toggleMic()` (WebRTC voice-chat mic on/off) — taking it would have broken an existing feature. `KeyN` was unused anywhere in the input map. Mnemonic: "next car". This is the one intentional deviation from the plan; everything else matches.

## What changed per file

### src/main.ts
- Minimap constructor call (~line 668) now passes two extra live getters:
  - `() => (aiCars.debugCars() ?? []).map(c => ({ x: c.x, z: c.z }))`
  - `() => (horses.debugStates() ?? []).map(h => ({ x: h.wx, z: h.wz, fallen: h.fallen }))`
  Both are null-safe (`?? []`) so absent features degrade to empty overlays.
- Added `let carViewIdx = -1;` right after `minimap.onTeleport = teleportToTarget;`.
- In the input loop next to the KeyC/KeyV checks, added the KeyN handler: advances `carViewIdx` mod `cars.length`, calls the SAME `teleportToTarget(x, z, name)` path the minimap uses, with `name = "▶ AI car N/48"`. Guards on empty `debugCars()` (no-op). The HUD note is produced by `teleportToTarget` itself ("Teleported to ▶ AI car N/48"), which avoids the flicker of an immediately-overridden `hud.message`.

### src/ui/minimap.ts
- Exported types `MapDebugCar = {x,z}` and `MapDebugHorse = {x,z,fallen}`.
- Fields `#getDebugCars?`, `#getDebugHorses?` (optional), `#debugLayerOn = false`.
- Constructor gained two optional trailing params; stored on the fields (existing 3-arg call sites keep working).
- `#buildBig`: when at least one debug getter is present, appends a `.bigmap-debug` row (button "Training layer" + cyan/orange legend) to `.bigmap-inner`. The button lives on the BIG map panel only (appended to the bigmap DOM, not the `#hud .minimap` wrap). Default OFF; click toggles `#debugLayerOn`, `.on` class, aria-pressed, and redraws.
- `#drawBig`: added `if (this.#debugLayerOn) this.#drawBigDebug(...)` after the (disabled) places pass, before remote players.
- New `#drawBigDebug`: fetches car/horse getters LIVE each draw (not cached), projects with the same `px`/`pz` big-map math, draws cyan (`#4fd1ff`) car dots and orange (`#ffb454`) / red-if-fallen (`#ff5a5a`) horse dots, culled to the viewport. Because `update()` calls `#drawBig` every frame while expanded, dots animate.

### src/ui/hud.ts
- Added `{ c: ["N"], label: "watch cars" }` to the keyboard `extraRows` legend, next to the `C` camera entry. Pad legend untouched (feature is keyboard-only).

### index.html
- Added `.bigmap-debug`, `.bigmap-debug-btn(.on/:hover)`, `.bigmap-debug-legend`, `.bigmap-debug-key`, `.bigmap-debug-dot` styles. Mirrors the parked `.mm-layer` look (dim/desaturated when off, cyan glow when on), scoped to the bigmap which lives on `document.body` rather than `#hud`.

## Deviations from plan
1. **KeyN instead of KeyV** — see "Key chosen". KeyV collides with the existing voice mic toggle.
2. HUD note text is `"Teleported to ▶ AI car N/48"` (the `▶ AI car N/48` string passed as the teleport `toName`) rather than a standalone `hud.message`. This reuses the required `teleportToTarget` path and avoids a one-frame flicker where the async teleport's own "Teleported" message would overwrite a separate note.
3. Optional car-dot click-to-teleport was skipped (plan marked it optional) — the landmark select flow doesn't cleanly extend to live moving points, so it was left out to avoid complexity.

## Test results
- `npx tsc --noEmit`: my four files are clean. The ONLY error reported is `src/world/sky.ts(498,…)` (a vec3/float node type mismatch). `sky.ts` is NOT in my plan and is being edited concurrently by another in-flight task (`git diff --stat` shows 75 uncommitted insertions there that I did not make). I did not touch it per guardrails.
- Headless CDP verify (fresh vite on 5214, relay 8788, killed after):
  - **KeyN teleport**: player `(-2982,-2798)` → after N#1 `(-2923,-2173)` (Δ 627 m) with HUD "Teleported to ▶ AI car 1/48"; after N#2 `(-2905,-2212)` (Δ 42 m, car→car) with "Teleported to ▶ AI car 2/48". Cycles + notes confirmed.
  - **Big-map toggle**: `.bigmap-debug-btn` present, text "Training layer", default `aria-pressed=false`; after click `aria-pressed=true` + `.on`. Screenshots: `bigmap_debug_off.png` (no dots) vs `bigmap_debug_on.png` (cyan car dots scattered city-wide). `bigmap_garden_horses.png` shows the amber horse cluster on the Botanical Garden meadow.
  - **Live**: sampled `debugCars()` 1.2 s apart — positions differ (cars moving), confirming per-draw fetch not caching. Horses: 8, clustered ~(-2200, 2470).
  - **Minimap-only guard**: collapsed `.minimap` contains 0 `.mm-layer` and 0 `.bigmap-debug-btn` — debug controls/dots are bigmap-exclusive.
  - Screenshots in scratchpad: `bigmap_debug_off.png`, `bigmap_debug_on.png`, `bigmap_garden_horses.png`, `minimap_collapsed.png`.

## Open risks
- The `sky.ts` tsc error means a full `tsc --noEmit` is non-zero on this branch until the parallel task lands its fix; it is unrelated to and unaffected by these changes.
- Debug getters call `aiCars.debugCars()` / `horses.debugStates()` every big-map frame. Both are cheap array maps over ≤48 / 8 entries and only run while the big map is open with the layer enabled — negligible.
