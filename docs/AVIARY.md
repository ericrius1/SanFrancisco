# Flight atelier

The editable master is `assets-src/aviary/aviary.blend`. It contains Pearl (ivory coastal gull), Lagoon (turquoise crested jay), and Ember (copper kestrel), with packed painted plumage, modeled feather edges, seven-bone rigs, and Fly / Glide / Scatter actions. The initial geometric blockouts have been replaced by meshes derived from GPT-generated artwork and refined in Blender.

## View and edit

Open the master in Blender. The active flight atelier scene lines up all three birds. Toggle the numbered collections in the Outliner to isolate a species; press Space to play the flight loop. Select a rig and use the NLA Editor to mute Fly and unmute Glide or Scatter. Enable only one track for ordinary preview. The hidden `90 REFERENCES` collection contains the packed concept plate and individual GPT species references.

The meshes retain their full source detail. Export applies the disabled `Game export` decimation modifier once on a temporary copy; keep it before the Armature modifier. Edit the source mesh, weights, materials, or actions normally. Keep the rig and mesh names, seven bones, and three animation names stable. Export temporarily reveals hidden bird collections and restores studio positions, rotations, visibility, animation mutes, selection, mode, and frame afterward. Original meshes are never reduced in place.

Save the `.blend`, then run:

```bash
npm run birds:export
```

This opens the saved master in background Blender, exports each species, and rebuilds the compressed game assets. It does not regenerate the models or overwrite manual art edits. Blender defaults to the macOS application; set `BLENDER_BIN` for another installation. Texture packing requires Khronos `toktx`; set `TOKTX_BIN` to its executable. This workspace also has a local KTX 4.4.2 tool under `.data/aviary/ktx-tools/`. Install the official [KTX tools](https://github.com/KhronosGroup/KTX-Software/releases) when moving the project elsewhere.

For unsaved Blender edits, run `tools/aviary/export_blender.py` through Blender's Python console/MCP, then `npm run birds:pack`. Save the master as well to retain those edits. Intermediate files live under `.data/aviary/`; each finished GLB is validated before atomically replacing its public version.

The independent WebGPU viewer is `/aviary.html`. It supports individual inspection, all three together, orbit/zoom, animation selection, a 48-bird flock, and a moving plane obstacle. Models load on selection. `npm run test:aviary` runs the headless viewer acceptance test; `node tools/aviary/game-probe.mjs` checks real-world loading and unloading. Set `SF_PROBE_URL` if the preview is on a different port.

## Shipping budget

| Species | Triangles | GLB download, approximately | Draws per habitat |
| --- | ---: | ---: | ---: |
| Pearl | 15,552 | 1.62 MiB | 1 |
| Lagoon | 16,144 | 1.71 MiB | 1 |
| Ember | 16,207 | 1.82 MiB | 1 |

`public/models/aviary/manifest.json` records the current exact export counts and bytes. Packing uses meshopt compression and position/normal quantization, 2048px color maps in ETC1S KTX2, and 1024px normal maps in UASTC KTX2, with mipmaps. Nearly uniform roughness is a material constant. No alpha feather cards are used; feather edges are geometry and fine vane detail is in the color/normal maps.

The browser verified that both maps remain compressed on the GPU. All three species plus their animation atlases occupied 12.1 MiB on the tested Mac/Chrome configuration. Format choice varies by adapter; allow roughly 6.7 MiB of textures plus a 32 KiB animation atlas per resident species. At most two habitats are resident in the world. Detailed geometry is intended for local flocks, not thousands of full-detail birds at once.

## Portable runtime and world expansion

`src/world/aviary/{catalog,asset,flock,runtime}.ts` has no SF map/player dependency. Copy those modules and `public/models/aviary/` to another Three.js WebGPU project. Supply a compatible Basis transcoder directory from the same Three.js release (this project uses r185), then register habitats:

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

The GPU samples shared bone matrices baked from the actual Blender clips. Instances have independent phases, banking, and flight/glide/scatter blending. No per-bird CPU animation mixers or transform uploads run each frame. Nearby cohorts simulate at 30 Hz, distant cohorts at 15 Hz; draw counts fall to 24 and then 12 at distance. This is a bounded local flock system, with no terrain collision mesh or independently simulated feather cloth. Place habitat volumes above terrain and away from buildings.

SF placement is in `src/app/compose/aviary.ts`: Pearl at Lands End, Lagoon in the Presidio, Ember at Corona Heights. Terrain samples lift each habitat above its local ground. Only placement metadata and the proximity gate load at boot. The runtime, models, and texture transcoder activate after arrival when a habitat is nearby. Leaving releases meshes, materials, buffers, atlases, and unused species textures. Add habitats there as the map expands, or register/unregister them from another region owner.

## Art sources and research

GPT image generation produced `assets-src/aviary/concept-v2.png` and the three species studies. The concept prompt and modeling direction are recorded in `assets-src/aviary/art-direction.md`. Tripo v3.1 converted those studies into base meshes; original inputs remain in `assets-src/aviary/source/`. `refine_blender.py` corrects orientation and shoulder centering; `rig_blender.py` binds blended shoulder/wrist weights. These are deliberate rebuild tools that replace mesh data. `build_blender.py` is the historical rig/studio bootstrap, not the normal art or export command.

Behavior follows the local steering principles in [Reynolds' boids](https://www.red3d.com/cwr/boids/). The GPU execution approach was informed by the [Three.js WebGPU birds example](https://threejs.org/examples/webgpu_compute_birds.html). Shipping geometry uses [EXT_meshopt_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md); texture encoding uses [Khronos KTX-Software](https://github.com/KhronosGroup/KTX-Software). Image-to-mesh conversion uses the [Tripo generation API](https://platform.tripo3d.ai/docs/generation). No stock bird models were used.
