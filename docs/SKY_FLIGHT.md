# Personal flight and the sky gardens

Flight is available on foot by default. Press **Space** to leave the ground,
**WASD** to fly along the view/strafe, **Space** or **U** to rise, **Q** to descend,
and **Shift** to accelerate. Mouse and trackpad use the existing look controls.
**C** cycles the existing third-person, first-person, and orbit cameras.
**G** starts personal flight or returns to natural gravity. Vehicles retain their
own controls; step off a ride before taking off personally.

Open **Flight & gravity** for a continuous slider from **-1** (inverse gravity),
through **0** (hover), to **+1** (Earth gravity). This changes only the local
character. The availability checkbox restores normal jumping when disabled.

Five small worlds above the city form a rising trail. **Find the sky gardens**
sets a direction signal. The panel's explicit **Travel to…** button takes you to
the next undiscovered garden through the normal covered arrival/history flow.
Each world has a radial gravity field: hover gives way to local attraction near
its surface. At -0.5 its local attraction balances; at -1 it repels you. Walking follows the curved surface;
Space launches outward, including from the underside. Local walking uses the
normal walk/run speeds, while open flight uses 22/95 metres per second.

Rest on a world for a moment to collect its story fragment. The Flight panel
keeps an expandable journal, saved locally between sessions. Visiting all five
opens the Last Seed and lights a thread between the gardens. These are original
places and story fragments inspired by the feeling of sky exploration.

## Ownership and loading

- `player/skyFlight.ts` owns per-player acceleration, surface collision, and
  orientation using the existing walking capsule. It compensates world gravity
  only for that capsule; it does not change the physics world's gravity.
- `world/skyIslands/metadata.ts` is boot-safe data and pure gravity sampling.
- `app/compose/skyFlight.ts` creates only a small launcher at boot. The panel
  loads on opening, geometry loads on altitude/proximity or explicit travel,
  and the shared `SiteFoliageStreamer` loads one nearby garden's vegetation.
- The foliage streamer supports an optional altitude for spherical residency.
  Existing ground-site registrations retain their horizontal landscape rings.
- Three alien flower forms extend `createAuthoredFlowerPatch`; geometry is built
  only when an authored patch requests one. Trees and shrubs use the same shared
  vegetation owners as the rest of the city.
- Distant island geometry and foliage dispose at separate hysteresis boundaries.
  The master foliage switch applies to all sky gardens. No extra scene lights,
  image downloads, or alternative rendering backends are used.

## Verification

`node tools/sky-flight-physics-probe.mjs` exercises hover, directional movement,
Earth/inverse acceleration, surface landing and walking, departure, suspension,
collision sweeps, and finite behavior at a planet's center.

The browser probe uses headless Chrome with WebGPU. It checks a fresh boot,
panel activation, island approach and subsequent travel request waterfalls, the
real walking capsule, first-person visibility, local gravity, the story journal,
and narrow-screen controls. Review artifacts are under `.data/sky-flight/`.
