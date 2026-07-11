# Audit — garage panel UI: custom color pickers + PLUME / 05 lab

## Files changed
- src/ui/boardSelector.ts
- index.html (board-panel CSS block only, between `.board-fx-chips .avatar-choice` and the 480px media query, plus additions inside the existing 339px media query)

## What changed per file

### src/ui/boardSelector.ts
- Imports: added `boardDeckHex/boardTrimHex/boardGlowHex/boardPlumeHex` from config.ts.
- `LabKind` gained `"plume"`; `PadKey` gained `"plumeReach" | "plumeShimmer"`. `isAudioLab` untouched (already returns false for "plume" → onPreview kind "surface").
- Module-level additions: `COLOR_ROWS` table (row → indexKey/hexKey/palette/resolver), `PICKER_SAT/PICKER_LIGHT_TOP/PICKER_LIGHT_BOTTOM` constants, `hexString`, `hslChannel`, `hslToHex`, `hexToHueLight` (no new deps).
- New class field `#pickerOpen: ColorRow | null` — single open picker at a time, survives re-renders (mirrors `#fxOpen`).
- `#swatch` re-keyed to `ColorRow`; normal swatch click now commits `{ [indexKey]: index, [hexKey]: null }` (palette pick clears custom paint); `.on` only when index matches AND hex is null. Glow-shadow treatment applies to both `glow` and `plume` rows.
- New `#customSwatch(row)` — 9th swatch, `avatar-swatch board-swatch-custom`, `.on` when hex non-null, click toggles `#pickerOpen` + re-render (no config edit).
- New `#colorPicker(row)` — slide-open drawer (`board-color-picker board-color-picker-<row>`, `.picker-open`) with a 240×90 hue×lightness canvas + `output.board-picker-hex` readout. Painted lazily (only when its row is open) via one ImageData pass; crosshair redraws restore from the cached base. Pointer capture; drags live-preview via `#onPreview({...cfg, [hexKey]: hex}, "surface")`; release commits via `#set({ [hexKey]: hex })`. Readout shows the row's resolved hex when no custom paint is set.
- New `#colorRow(label, row)` — returns `[row, picker]`; deck/ink/glow rows in `#render` now use it.
- New `#plumeLab()` — `#xyLab("plume", "PLUME / 05", "reach × shimmer", plumeReach × plumeShimmer, ["wisp","beam"] × ["calm","fizz"])`, then re-parks the pad into `div.board-plume-body` beside `div.board-plume-side` (sparks toggle `avatar-choice board-plume-sparks` + `div.board-plume-swatches` with 8 BOARD_GLOW_COLORS swatches + rainbow custom), and appends the plume `#colorPicker` full-width under the body. Appended after THRUST / 04 in `.board-labs`.
- New `#drawPlumePreview(time)` — dark gradient bg, 2 pods, 4 wisps each (length ∝ plumeReach with a breathing term so it never freezes, wobble/fizz ∝ plumeShimmer), core glow ellipse, white motes when `plumeSparks`; tinted via `boardPlumeHex`. Registered in `#startPreviewLoop`, in `#render`'s initial paint, and in `#xyLab`'s apply branch (`kind === "plume"`).
- `#render` toggle icon now resolves colors through `boardDeckHex/boardGlowHex` so custom paint shows on the HUD toggle.
- Class doc comment updated ("Three visual pads … inline hue×lightness picker …"). Header tagline unchanged (it never mentioned pads).
- `.board-lab-reroll` untouched — still exactly one (DECK / 01).

## DOM structure (as requested)

Color row (deck/ink/glow):
```
div.avatar-row
  div.avatar-label
  div.avatar-controls
    button.avatar-swatch ×8
    button.avatar-swatch.board-swatch-custom[.on]
div.board-color-picker.board-color-picker-<row>[.picker-open]
  canvas.board-picker-canvas (240×90)
  output.board-picker-hex        → "#3fae9c"
```

Plume lab:
```
section.board-lab.board-lab-plume
  div.board-lab-head  (title PLUME / 05, sub "reach × shimmer", readout)
  div.board-plume-body
    div.board-xy-pad  (canvas/grid/puck/axis spans, registered as "plume")
    div.board-plume-side
      button.avatar-choice.board-plume-sparks[.on]
      div.board-plume-swatches
        button.avatar-swatch ×8 (BOARD_GLOW_COLORS → plumeGlow, clears plumeHex)
        button.avatar-swatch.board-swatch-custom[.on]
  div.board-color-picker.board-color-picker-plume[.picker-open]
```

### index.html (CSS only)
New rules after `.board-fx-chips .avatar-choice`, matching the block's voice:
- `.board-swatch-custom` conic-gradient rainbow; `.on` white ring + teal halo + `::after "✓"`.
- `.board-color-picker` drawer (max-height/opacity/margin transition identical recipe to `.board-fx-drawer`; opens to 130px), `.board-picker-canvas` (hairline border, crosshair cursor, touch-action none), `.board-picker-hex` (mono teal readout).
- `.board-lab-plume { grid-column: 1 / -1 }`; `.board-plume-body` row flex; plume pad `flex: 1 1 55%`; `.board-plume-side` column 45%; `.board-plume-sparks` stretch; `.board-plume-swatches` wrap.
- ≤339px media query additions: plume body stacks vertically, pad/side full width, pad height 90px. ≤480px needed no new rules (existing `.board-xy-pad` height rule covers the plume pad; the plume flex override wins on specificity).

## Deviations from plan
- Normal swatches show `.on` only when no custom hex is set for that row, so exactly one chip reads selected per row. Spec only required the rainbow chip's `.on`; this seemed implied.
- HUD toggle icon colors now resolve through the hex helpers (was raw palette index) — keeps the toggle honest once custom paint exists; same file, two lines.
- Picker canvas stays blank while its drawer is closed (lazy paint per open); closed drawers are max-height 0 so nothing is visible.

## Test results
- `npx tsc --noEmit`: no errors in the two files I touched. Two pre-existing/concurrent TS6133 errors in `src/player/player.ts` (`#golfAddressSet`, `#golfMeshShift` unused) belong to another in-flight session — not touched.
- No dev servers or probes run (per instructions).

## Open risks
- tools/board-style-probe.mjs asserts pads === 4; now 5 — orchestrator to update (noted in task; probe file not touched).
- Crosshair inverse mapping assumes the hex lies in the picker's fixed-saturation plane; a hex from another source lands at nearest hue/lightness clamped — cosmetic only.
- Toggling a picker re-renders the whole panel (same cost as any `#set` commit); no new perf surface.
- index.html was modified concurrently mid-task (my first CSS edit was rejected as stale); I re-read the fresh file and re-applied — CSS landed only in the intended board block.
