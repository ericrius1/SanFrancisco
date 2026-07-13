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
