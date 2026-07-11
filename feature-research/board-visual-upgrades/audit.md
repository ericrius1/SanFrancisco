# Audit — hoverboard halo comet + thruster plumes

## Files changed
- src/vehicles/board/mesh.ts
- src/vehicles/board/tuning.ts
- src/player/tuning.ts

## What changed per file

### src/vehicles/board/mesh.ts
- Imports: added `mix` (three/tsl), `boardTrimHex`/`boardGlowHex`/`boardPlumeHex` (./config, replacing direct `BOARD_DECK_COLORS`/`BOARD_GLOW_COLORS` imports), `HALO_TUNING` (./tuning).
- `surfacePaintKey`: now also keys on `deckHex|trimHex|glowHex` so custom paint repaints the canvas.
- `buildBoardMesh`: trim/glow colors resolved via `boardTrimHex(cfg)`/`boardGlowHex(cfg)` so custom hex overrides flow to fins/rails/underglow/light anchors.
- New `buildPlumeMaterial` (MeshBasicNodeMaterial, DoubleSide, transparent, depthWrite false, additive): colorNode = plume tint mixed toward white near the pod, ×LIGHT_SCALE; opacityNode = branchless scrolling bands (sin + wobble, contrast scaled by shimmer) × tip fade × strength. No If().
- New types `BoardHalo`, `BoardPlume`, `PlumeUniforms`; `BoardAnim` gains `halo?: BoardHalo` and `plume: BoardPlume`.
- Thruster pods: per pod a `plumeRoot` group holds one shared-material cone shell (unit CylinderGeometry translated so top = y0, `scale.y` = length) + 3 spark motes (shared SphereGeometry, one shared additive MeshBasicMaterial). All geometries via `geo()`, materials via `mat()` (dispose covered).
- Halo fin: single orbiting spark + its `spinners` entry removed; replaced by 12 orbs (one unit-sphere geometry, per-orb additive MeshBasicMaterial) on a group at the ring centre, driven by `anim.halo`.
- `updateBoardSurface`: additionally refreshes plume reach/shimmer/sparks/color (uniform + mote material + mote visibility) for instant pad-drag preview.
- `animateBoard` (signature unchanged): plume time advance `dt·(0.8 + shimmer·2.2 + norm·0.8)` (frozen under reducedMotion, glow stays), strength from reach ×1.4 when boosting, eased cone length (reach + speed + boost), mote spiral/pulse; halo comet integrates θ with ω = orbitSpeed·(1 − slowdown·sin²θ), spread eased at `collapse` rate toward `tailSpread·(ω/ωmax)`, per-orb position/taper/pulse/HSL gradient (head deep hue → tip near-white, tip brightest), all read live from `HALO_TUNING.values`. Uniforms/transforms/colors only — no repaints, uploads, swaps, or geometry changes.

### src/vehicles/board/tuning.ts
- Added `HALO_TUNING = tunables("board.halo", ...)`: `count` (7, 2–12), `orbitSpeed` (2.6), `slowdown` (0.72, "pole stall"), `tailSpread` (1.6, "tail whip"), `collapse` (4, "collapse snap"), `taper` (0.8), `hueDeep` (232), `hueGlow` (187), `whiten` (0.85, "tip whiten"), `sat` (0.85).

### src/player/tuning.ts
- Import `HALO_TUNING` from `../vehicles/board/tuning` (index.ts does not re-export it); after `BOARD_TUNING.bind(folders.board)` added `HALO_TUNING.bind(folders.board.addFolder({ title: "halo comet" }))`.

## Deviations from plan
- None of substance. Minor choices within spec latitude: motes use ONE shared material (spec allowed shared tint) recolored in updateBoardSurface; halo omega also spools slightly with board speed (matches the old spinner's speed feel; spread ratio uses unspooled ω so the collapse behaviour is unaffected); reducedMotion leaves motes at their build-time static pose rather than hiding them.

## Test results
- `npx tsc --noEmit`: zero errors in the three task files. One pre-existing/concurrent error remains in `src/ui/boardSelector.ts(813)` (`'#colorRow' is declared but its value is never read`) — that file is owned by the concurrent session and outside this task's file list; not touched.
- No dev server / probes run (per task constraints).

## Open risks
- Visuals unverified in-browser (spec forbade running the app); plume band frequency/alpha and comet hues may want an eyeball pass with tools/board-style-probe.mjs later.
- `boardSelector.ts` tsc error will block a clean build until the other session lands its change.
