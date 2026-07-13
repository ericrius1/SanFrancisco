# Ocean Beach surfing — research and implementation audit

## Playable loop

Carve down a moving Ocean Beach face, alternate rail turns to build a combo,
launch from the lip, land for a score multiplier, and auto-reset after a wipeout.

## References

- *Kelly Slater's Pro Surfer*: readable third-person face positioning, linked
  tricks/combos, a special meter, and explicit launch/air moves.
  <https://gamefaqs.gamespot.com/ps2/470398-kelly-slaters-pro-surfer/faqs/35383>
- Chentanez & Müller, *Real-time Breaking Waves for Shallow Water Simulations*:
  breaking-wave visual detail can be layered over a lower-cost heightfield.
  <https://matthias-research.github.io/pages/publications/breakingWaves.pdf>
- Tavakkol & Lynett, *Celeris*: coastal wave behavior is strongly shaped by
  shallow-water propagation and bathymetry, but a full Boussinesq solver is far
  beyond the frame budget of this city-scale game.
  <https://arxiv.org/abs/1611.05984>
- California Coastal Commission Ocean Beach adaptation exhibits: Ocean Beach
  modeling uses offshore buoy conditions plus NOAA bathymetry, supporting the
  authored west-to-east Pacific swell and sandbar variation used here.
  <https://documents.coastal.ca.gov/reports/2024/11/Th10a/Th10a-11-2024-exhibits-2.pdf>

## Chosen model

- Custom fixed-step arcade physics, one dynamic board body/collider, no new
  physics dependency and no GPU readback.
- Periodic shoreward wave train, 112 m crest spacing, 9.2 m/s phase speed,
  approximately 3.7 m set-wave amplitude.
- Broad offshore shoulder + narrow shoreward face approximates shoaling while
  remaining analytically sampleable by the CPU controller and TSL water shader.
- The local near-water patch is refined to 96×96 vertices at Ocean Beach; green
  face tint, white crest foam and 480 localized spray points make the break read.
- Surf input is authored rather than rigid-body simulated: wave carry, pumping,
  carving, tuck speed, launch gravity, landing window and wipeout/reset.

## Audio matrix

| Event | Runtime sound |
| --- | --- |
| Ride / rail | Speed-driven band-passed procedural noise |
| Wave face | Low-passed breaker roar driven by face proximity |
| Carve | Short filtered-noise rail slash |
| Landing | Pitched procedural thump |
| Wipeout | Longer low-passed noise wash |

All surf audio uses the existing FX gain, mute/volume controls and gesture-based
AudioContext unlock. No external audio files or credentials are required.

## Verification

- Production TypeScript/Vite build.
- Clean browser console.
- Surf vehicle visible in the shared vehicle row.
- Fresh mode entry places the board on the moving face.
- Real Space input: `ON THE LIP` → `AIR` → scored `BIG AIR` landing.
- Wipeout path resets onto the next set; `R` also restarts at the break.
