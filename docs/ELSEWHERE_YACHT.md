# The Elsewhere

Select **Yacht** in the vehicle bar or press **0**. Existing vehicle shortcuts 1–9 are preserved. The 76 m yacht enters deep open water and shares the existing boat buoyancy controller with a larger collision hull, wider wave probes, slower acceleration and broad turns.

- W/S throttle, A/D steering, Shift cruise.
- E or the yacht panel starts first-person deck exploration. Your selected avatar comes along on deck and uses the shared walk pose; WASD walks and Shift runs.
- E talks to nearby passengers, reads art, uses the promenade stairs, or boards Moth on a helipad.
- Moth: WASD horizontal flight, Space climb, Q descend. Approach either landing circle and press E to land. Flight stays within 1.2 km of the anchored yacht.
- R or **Return to helm** returns you and Moth to the helm/top pad. Choosing another vehicle leaves the yacht activity; choosing Walk disembarks.
- The star at the far end of the main gallery opens the Museum of Almosts. This room is discovered spatially, never listed in a travel menu.

Three walkable levels contain two swimming pools, a sky hot tub, listening lounge/piano, art salon, dining room, guest suite, and two helipads. Mara, Idris, Sol, and Juniper each have three conversation passages describing previous journeys and their next destination. Pools/spa have relaxation interactions; they do not invoke the ocean swimming controller. Stairs use explicit landing-to-landing interaction.

## Source and asset ownership

`tools/blender_elsewhere_yacht.py` builds the editable Blender source and raw GLB under `.data/yacht/`. Run Blender in the background:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b --python tools/blender_elsewhere_yacht.py
node tools/pack-elsewhere-yacht.mjs
```

The packer welds/deduplicates geometry, prunes unused data, quantizes and Meshopt-compresses the model. Only `public/models/yacht/elsewhere.glb` ships: approximately 503 KiB, 24 meshes, 12 materials, no textures. Static geometry batches by material; the door and helicopter retain movable nodes. Passenger rigs use the game's shared avatar system.

`src/vehicles/yacht/dimensions.ts` is boot-safe metadata. The model, navigation, stories, controller and panel live behind `loadVehicleRuntime('yacht')`. Explicit local selection loads and compiles the single model before showing it. A bounded shared prototype supports re-selection and nearby remotes; remote players cannot trigger the load. Abandoned yacht copies own their cloned GPU resources so disposal cannot invalidate the shared prototype. The local panel is hidden on exit.

Deck exploration and Moth's short scenic flights are local to the anchored yacht. Multiplayer advertises the yacht's hull pose; it does not replicate individual visitors or the onboard helicopter flight.

## Verification

```bash
node --experimental-strip-types tools/yacht-navigation-test.mjs
node tools/yacht-browser-probe.mjs
npm run test:boat-buoyancy
npm run build
```

The browser probe runs Chrome headlessly with WebGPU. It records boot, activation, exploration, and re-selection requests; checks the model is absent at boot and fetched once on selection; traverses the gallery/secret chamber/stairs/spa; talks to passengers; flies the helicopter; and checks return/exit cleanup. Screenshots and reports stay in `.data/yacht/`.

The pre-existing boat buoyancy probe currently reports 22 failures. Running it with the unmodified HEAD controller produces byte-identical measurements and failures; this addition preserves the original small-boat dynamics.
