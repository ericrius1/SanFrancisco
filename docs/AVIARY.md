# Flight atelier

The editable master is `assets-src/aviary/aviary.blend`. It contains Pearl (ivory coastal gull), Lagoon (turquoise crested jay), and Ember (copper kestrel), with packed painted plumage, modeled feather edges, seven-bone rigs, and Fly / Glide / Scatter / Perch actions. The initial geometric blockouts have been replaced by meshes derived from GPT-generated artwork and refined in Blender.

## View and edit

Open the master in Blender. The active flight atelier scene lines up all three birds. Toggle the numbered collections in the Outliner to isolate a species; press Space to play the flight loop. Select a rig and use the NLA Editor to mute Fly and unmute Glide, Scatter, or Perch. Enable only one track for ordinary preview. The hidden `90 REFERENCES` collection contains the packed concept plate and individual GPT species references.

The meshes retain their full source detail. Export applies the disabled `Game export` decimation modifier once on a temporary copy; keep it before the Armature modifier. Edit the source mesh, weights, materials, or actions normally. Keep the rig and mesh names, seven bones, and four animation names stable. Export temporarily reveals hidden bird collections and restores studio positions, rotations, visibility, animation mutes, selection, mode, and frame afterward. Original meshes are never reduced in place.

Save the `.blend`, then run:

```bash
npm run birds:export
```

This opens the saved master in background Blender, exports each species, and rebuilds the compressed game assets. It does not regenerate the models or overwrite manual art edits. Blender defaults to the macOS application; set `BLENDER_BIN` for another installation. Texture packing requires Khronos `toktx`; set `TOKTX_BIN` to its executable. This workspace also has a local KTX 4.4.2 tool under `.data/aviary/ktx-tools/`. Install the official [KTX tools](https://github.com/KhronosGroup/KTX-Software/releases) when moving the project elsewhere.

For unsaved Blender edits, run `tools/aviary/export_blender.py` through Blender's Python console/MCP, then `npm run birds:pack`. Save the master as well to retain those edits. Intermediate files live under `.data/aviary/`; each finished GLB is validated before atomically replacing its public version. Packing also regenerates `assetVersions.ts` from SHA-256 content hashes. Model URLs include those versions, so returning players receive new Blender exports despite long-lived world-asset caches.

The independent WebGPU viewer is `/aviary.html`. It supports individual inspection, all three together, orbit/zoom, animation selection, a 48-bird flock, and a moving plane obstacle. Models load on selection. `npm run test:aviary` runs the headless viewer acceptance test; `node tools/aviary/game-probe.mjs` checks real-world loading and unloading. Set `SF_PROBE_URL` if the preview is on a different port.

## Shipping budget

| Species | Triangles | GLB download, approximately | Draws per habitat |
| --- | ---: | ---: | ---: |
| Pearl | 15,552 | 1.62 MiB | 1 |
| Lagoon | 16,144 | 1.71 MiB | 1 |
| Ember | 15,719 | 1.78 MiB | 1 |

`public/models/aviary/manifest.json` records the current exact export counts and bytes. Packing uses meshopt compression and position/normal quantization, 2048px color maps in ETC1S KTX2, and 1024px normal maps in UASTC KTX2, with mipmaps. Nearly uniform roughness is a material constant. No alpha feather cards are used; feather edges are geometry and fine vane detail is in the color/normal maps.

The browser verified that both maps remain compressed on the GPU. All three species plus their animation atlases occupied 12.1 MiB on the tested Mac/Chrome configuration. Format choice varies by adapter; allow roughly 6.7 MiB of textures plus a 43 KiB animation atlas per resident species. At most twelve habitats, 320 simulated birds, and three species are resident in the world. Detailed geometry is used within 95 m. Shared, compact meshoptimizer LODs target 2,200 triangles to 320 m and 420 triangles beyond. All tiers retain the full population and the original compressed textures, feather silhouettes, skin weights and animations. No additional LOD model downloads are needed.

## Portable runtime and world expansion

`src/world/aviary/{catalog,asset,assetVersions,flock,runtime}.ts` has no SF map/player dependency. Copy those modules and `public/models/aviary/` to another Three.js WebGPU project. Supply a compatible Basis transcoder directory from the same Three.js release (this project uses r185), then register habitats:

```ts
const aviary = createAviary(renderer, scene, {
  assetBaseUrl: '/models/aviary/',
  transcoderPath: '/basis/',
});
aviary.register({
  id: 'coast-west', species: 'pearl-gull',
  center: { x: 0, y: 60, z: 0 }, radius: 80,
  count: 48, seed: 17, loadDistance: 350, unloadDistance: 510,
});
// Call from the host frame loop. Influencer coordinates are world coordinates.
aviary.update(dt, elapsed, { position: plane.position, velocity: plane.velocity, radius: 15 });
// When a region is removed: aviary.unregister('coast-west').
// When the host shuts down: aviary.dispose().
```

The host must create a WebGPU renderer directly and fail clearly if WebGPU is unavailable. This runtime has no alternative rendering backend.

Each habitat has a bounded cohort of up to 64 birds. WebGPU compute handles separation, alignment, cohesion, altitude control, and a soft circling boundary. A swept obstacle capsule anticipates an approaching plane; alarm accelerates birds and blends into Scatter, then decays back into ordinary flight. Two compute passes prevent invocations from reading partially updated neighbors. Neighbor search is local to a habitat, so expanding the world does not create a global all-pairs loop.

The GPU samples shared bone matrices baked from the actual Blender clips. Instances have independent phases, banking, and flight/glide/scatter blending. No per-bird CPU animation mixers or transform uploads run each frame. Nearby cohorts simulate at 30 Hz, middle-distance cohorts at 15 Hz, and distant cohorts at 10 Hz. All birds remain drawn at every distance. Species scale is increased about 20%; a gradual additional distance scale (up to 1.65×) preserves silhouettes against the skyline. Habitat admission is ranked twice per second or immediately after substantial travel. This is a bounded local flock system, with no terrain collision mesh or independently simulated feather cloth. Place habitat volumes above terrain and away from buildings.

SF placement is in `src/world/aviary/cityHabitats.ts`: landmark flocks plus a deterministic 440 m neighborhood grid now extend through the city, Marin and outlying coasts. Neighborhood groups contain 8–36 birds. Habitats stream at 1,450 m with a 1,700 m unload radius, subject to the same global population budget. The host resolves terrain/building clearance at admission. Three additional world-fixed groups of 20, 16 and 24 birds populate the player's route at different depths when entering a new 160 m cell. The closest uses a 12 m radius and flies 7 m above open street clearance; larger encounters use 32 m volumes above roofs. Three skyline sectors reserve distant populations around 1.15 km. Previous anchors linger to 540 m; the camera does not drag an existing flock around.

Tree landings use `vegetation/treePerches.ts`, a lightweight registry owned by shared `NativeTreeForest` chunk residency. A target is sampled from an actual upward-facing outer branch surface in the compiled tree geometry, transformed by the tree's scale/yaw/root and its parent world transform. Only visible attached trees qualify, and unloading or hiding a tree invalidates its targets. This never requests or creates vegetation. One nearby 14-bird Lagoon group can send up to five individuals to different branches. GPU steering brakes into the landing; the authored Perch action folds the wings and adds breathing/head movement. Staggered rest windows produce departures and returns, and a nearby player/plane or disappearing tree causes takeoff. Wind displacement of branch tips is not replicated by the perch target; contacts use their base branch surface.

Portable hosts can provide `getPerches(habitat)` returning `{x,y,z,active()}` targets in world coordinates. The SF host queries tree metadata every 3.5 seconds, spatially rejects distant chunks, and samples/caches each prototype's branch once. Wildlife does not own tree residency. Only placement metadata and the proximity gate load at boot; runtime, models and transcoder activate five seconds after arrival. Admission is serial and species assets are shared. Departure releases meshes, material, compute buffers, all geometry LODs, atlases and unused textures.


## Art sources and research

GPT image generation produced `assets-src/aviary/concept-v2.png` and the three species studies. The concept prompt and modeling direction are recorded in `assets-src/aviary/art-direction.md`. Tripo v3.1 converted those studies into base meshes; original inputs remain in `assets-src/aviary/source/`. `refine_blender.py` corrects orientation and shoulder centering; `rig_blender.py` binds blended shoulder/wrist weights. Ember now uses `ember-reference-v3.png`, regenerated with a short straight neck and forward-facing horizontal flight profile; its old raised/backward head was replaced at the source-mesh level. These are deliberate rebuild tools that replace mesh data. `build_blender.py` is the historical rig/studio bootstrap, not the normal art or export command.

Behavior follows the local steering principles in [Reynolds' boids](https://www.red3d.com/cwr/boids/). The GPU execution approach was informed by the [Three.js WebGPU birds example](https://threejs.org/examples/webgpu_compute_birds.html). Shipping geometry uses [EXT_meshopt_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md); texture encoding uses [Khronos KTX-Software](https://github.com/KhronosGroup/KTX-Software). Image-to-mesh conversion uses the [Tripo generation API](https://platform.tripo3d.ai/docs/generation). No stock bird models were used.

## Validation record

- TypeScript and the production build's contract checks passed, including the world light budget. The separate studio viewer is explicitly registered as an off-world light helper.
- The current revision passed TypeScript and an isolated production build at `.data/aviary/revision/dist`, including a separate dynamic aviary runtime chunk. An isolated output avoids interfering with other active builds in this shared checkout.
- Headless Chrome exercised the isolated production viewer: zero model requests before selection; exactly the selected model on activation and the newly selected model afterward; all three animated birds; finite moving GPU flock positions; plane alarm and recovery; compressed color and normal maps; responsive layout; disposal; no JavaScript or WebGPU errors.
- Headless production world testing verified zero bird code/models at downtown boot; nearby-only activation after arrival; 16 birds across two downtown groups, 43 across two Lands End groups, and 15 across three Corona groups; finite moving GPU positions; submission to the real world renderer; the previous 96-bird/four-group/two-species limits; and zero resident bird texture bytes after departure. Close views verified the actual models over the coastline and downtown rooftops, including the corrected Ember profile.
- `export_probe.py` verifies hidden/excluded collections, Pose Mode, frame, original mesh coordinates, modifiers, and animation mutes survive export. Temporary export copies are removed. All 63 animation channels per species survived the export comparison; Ember was subsequently rebuilt with corrected forward-flight anatomy.

Local logs and screenshots are under `.data/aviary/`. The final Blender studio render is `assets-src/aviary/preview.png`.

### Expanded life acceptance (September 8)

`tools/aviary/life-probe.mjs` checks increased downtown populations and geometric LOD budgets, then waits for real tree residency at the Tea Garden, reads GPU rest state to confirm completed landings, and verifies approaching a landed bird triggers takeoff. Screenshots include normal flight views and a branch inspection. The gallery also checks identical vertex formats across LODs to prevent normalized attribute layout corruption.
