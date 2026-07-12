# Windows look out to the real world — audit

## Files changed

- `src/world/citygen/render/shellBatch.ts` — added `setShellHidden(hidden)` to `ShellHandle` (+ impl).
- `src/world/citygen/render.ts` — added `setShellHidden` to `BuiltBuilding`; forwarded `windows` into `buildInterior`.
- `src/world/citygen/interior/interior.ts` — `buildInterior` takes a `windows` param; added `localWindowOpenings()` (world→local rotation + edge match).
- `src/world/citygen/interior/shell.ts` — `dressInteriorShell` takes `windowOpenings`; carves real holes (unified with the door-notch split) instead of the old opaque `int.window`/`haze`/`city` fake-view quads.
- `src/world/citygen/stream/ring.ts` — `BuiltGroup` gained `windows` + `setShellHidden`; `ensureInterior` passes windows through and hides the shell+glass on build; `disposeInterior` restores both on exit.
- `tools/window-lookout-probe.mjs` (new) — verification probe (not shipped code).

## What changed, per file

**shellBatch.ts**: `ShellHandle.setShellHidden(hidden)` loops `placed` and calls `p.batch.mesh.setVisibleAt(p.inst, !hidden)` for every instance (walls/roof/trim/stoop/doors) this building owns in the batch. Cheap — a handful of `setVisibleAt` calls, only ever for the one occupied building.

**render.ts**: `BuiltBuilding.setShellHidden` added to the interface. Batched path delegates to `shellHandle.setShellHidden` (+ `winHandle` for the rare window-slot-overflow bake fallback). Bundle fallback path toggles `group.visible` + `group.needsUpdate`. `buildInterior(spec, mats, windows = [])` now forwards `windows` to `buildInteriorParts`.

**interior/interior.ts**: new `localWindowOpenings(windows, poly, ctrX, ctrZ, cosT, sinT)` rotates each `ModuleInstance`'s two pane-corner points into the SAME local frame the room plan uses (the existing −θ-about-centroid map), matches the transformed outward normal against each `poly` edge's inward normal (dot ≈ 1 after negation), and returns `{edge, t0, t1, y0, y1}` records. Computed once per building (not per floor); `dressInteriorShell` filters by y-range per storey. `buildInterior(spec, zone, windows = [])` computes this once and passes it to every `dressInteriorShell` call.

**interior/shell.ts**: `dressInteriorShell` gained a `windowOpenings` param and a `WindowOpening` export. Per edge: `edgeOpenings` = openings matching this edge + current storey band. The door case and the plain-wall case are unified into one cut-sweep (mirrors the pre-existing door-split technique): a sorted list of cuts (door notch + real window openings, with the rare door-overlapping window excluded) drives `wallSpan` calls that leave true holes — solid strip, sill-to-floor band (skipped for the door cut, which is void to the floor), head-to-ceiling band, repeat. When `hasRealWindows` (this building has any ModuleInstance window data), the old synthetic per-position loop (`nWin`/`winW` grid + `int.window`/`int.window.haze`/`int.window.city` flat quads) is skipped entirely for every edge; instead a new branch frames each real opening with the same muntin/trim `bar()` boxes and pushes the same `windowKeepouts` AABB, just keyed off the real `w.t0/t1/y0/y1` instead of the synthetic grid. Buildings with no window instances (empty `windowOpenings`) get byte-for-byte the old opaque behavior — the fallback path is untouched.

**stream/ring.ts**: `BuiltGroup.windows`/`setShellHidden` added (both already existed on `BuiltBuilding` in render.ts). `ensureInterior` passes `e.detail?.windows ?? []` into `buildInterior`, then calls `e.detail?.setShellHidden(true)` + `e.detail?.setGlassHidden(true)` right after the interior is built (only fires once per entry, guarded by the existing `if (e.interior || ...) return`). `disposeInterior` calls both setters with `false` before/around the existing collider teardown, guarded with `?.` since it's also called from `dropDetail` (which nulls `e.detail` right after).

## Deviations from plan

- **Door + window unification (beyond the plan's literal wording)**: the plan said to mirror the door split for the non-door branch. I found that a street-facing ground-floor edge commonly carries BOTH the door AND flanking bay windows (very common Victorian frontage), and the literal `if (isDoor) {...} else {...}` structure would silently drop real windows on that edge (they'd get frame/keepout boxes with no actual hole, or nothing at all). I unified door + window carving into one sorted-cuts sweep on every edge so bay windows beside a working front door also carve correctly. A real window overlapping the door notch itself (a transom, not authored by this grammar) is excluded from carving to avoid double-cutting the door's own lintel geometry — negligible in practice.
- Everything else matches the plan as scoped (ShellHandle/BuiltBuilding/BuiltGroup additions, ensureInterior/disposeInterior wiring, world→local window matching approach).

## Test results

- `npx tsc --noEmit`: clean, no errors.
- No other source file calls `buildInterior`/`dressInteriorShell` besides the ones edited (confirmed via grep); `tools/citygen-interior-layout-probe.mjs` only pattern-matches the string, doesn't import the function.
- Verification probe `tools/window-lookout-probe.mjs` (headless Chrome, own vite+relay port, `--use-angle=metal --enable-unsafe-webgpu`, drives `__sf.tick()`, waits on `__sf.renderIdle()`):
  - Streamed near (900, 2400), entered the nearest detail building (cx≈951.5, cz≈2400.5, base 47.3 / top 57.8 — a multi-storey Victorian).
  - `citygenRing.current.isPlayerInside()` → `true`; `stats().interiors` → `1`.
  - 12-angle camera sweep from the room center: several angles show real exterior geometry through the wall — a neighboring building's window glass (dark navy pane with light mullions, in clear off-axis perspective, NOT matching the old fallback's flat light-blue `int.window` color `0xbcd6ea`) and, after the door+window unification fix, a full window aperture directly beside an interior doorway leading toward a plain gray exterior surface (a close neighbor/party wall) — both consistent with a true carved hole, not the painted parallax panel. Other angles show plain interior partition walls, which is expected (no window on those wall segments).
  - Zero console errors/exceptions captured via CDP `Runtime.exceptionThrown`/`Runtime.consoleAPICalled` during the whole run.
  - Screenshots saved under `.data/citygen-shots/window_lookout_0.jpg` .. `window_lookout_11.jpg` (gitignored `.data/` dir, not part of the diff).

## Open risks / limitations

- **Edge-matching tolerance**: `localWindowOpenings` matches a window to a `poly` edge by dot-product alignment (≥0.7) and perpendicular-distance error (≤0.6m). On a rare degenerate/concave footprint this could silently drop a window (no hole, no fallback quad either, since `hasRealWindows` is decided globally not per-window) — the wall would show plain plaster where a window should be. Not observed in the probe run, but not exhaustively fuzzed either.
- **Transom-over-door windows**: intentionally not carved (excluded to avoid conflicting with the door's own lintel cut). Not currently authored by the grammar, so likely a non-issue today.
- **Multiplayer/neighbor visibility**: only the OCCUPIED building's shell hides; this is correct for the single-player case the task specified. If another player could see the first player's building from outside while they're inside, they'd see it vanish — out of scope per the task brief ("single-player, you're inside... acceptable").
- Did not add an automated pixel-color assertion (no JPEG decoder readily available in this environment without new deps); verification is visual (screenshots read via the multimodal Read tool) plus the structural checks (isPlayerInside, interiors count, absence of the old fallback's telltale color, zero console errors).
- Perf: not re-measured (task notes headless perf is thermally noisy and this is a correctness-only pass). The added `setShellHidden`/`setGlassHidden` calls only fire on interior enter/exit, gated by the existing hysteresis (GATE_DILATE/GATE_DISPOSE), so cost is a few `setVisibleAt` calls + one texel write, not per-frame.
