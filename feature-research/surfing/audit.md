# Ocean Beach surfing — research and implementation audit

## Playable loop

Carve down a moving Ocean Beach face, alternate rail turns to build a combo,
launch from the lip, land for a score multiplier, and auto-reset after a wipeout.

## Controls: the pointer is the board

The whole activity is two mouse axes and one key, with no gestures, no modal
inputs and nothing that inverts when the ride comes around:

- **Mouse ↔** turns the nose, screen-relative — push right, go right, whichever
  way you are travelling and in the air. Keep turning and the board genuinely
  comes about; that *is* the cutback (the old double-tap gesture is gone). With
  the hand still, a trim spring eases the nose onto the nearest down-the-line
  heading, so a player cannot end up lost or backwards.
- **Mouse ↕** places the board on the wall: up climbs toward the lip, down drops
  to the flats for speed or stalls onto the tube line. It self-centres.
- **Space** always jumps. No speed gate, no lip gate — height is one smooth
  curve of how high on the wall and how fast you are, previewed live by the POP
  meter, and the same mouse spins and pitches the board in the air.

Keyboard A/D + W/S and both pad sticks feed the same two channels, so a pad or a
scripted driver plays identically. Mouse motion lands on `Input.surfDX/surfDY`,
never on `mouseDX/mouseDY`: the authored surf camera still consumes zero look
input, which is what keeps the frame stable while the pointer is steering.

## Camera

One boom, no second rig. It trails the live board heading — so the frame turns
with the rider — but the swing is clamped in the wave's own frame: free toward
the open shoulder, held short toward the wall, with the two branches meeting
exactly at the face-on view so a turn-around interpolates *through* the wave
face instead of behind it. The barrel shot is the same boom eased lower, shorter
and onto the tube line, not a camera that snaps into place.

One long-standing defect fixed here: `oceanBeachCrestBase` is periodic, so every
~16 s the crest train re-indexes by a wavelength. The rail-grip solve read that
as a ~9 km/s crest and teleported the rider a full wavelength offshore, cutting
the camera with them. `SurfController.#stepCrestX` now follows the re-index.

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
- Steering is banked at render-frame rate (`SurfController.steerSurf`, the same
  contract as the plane's `steerFly`) and consumed whole by the next fixed step,
  because a frame may run zero or three steps and a mouse delta is a per-frame
  quantity that must be applied exactly once.

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
- `tools/surf-probe.mjs` — headless-WebGPU acceptance run over the real app.
- `/tools/surf-feel-harness.html` — sub-second deterministic handling harness
  against the real controller/camera modules, for tuning iterations.
