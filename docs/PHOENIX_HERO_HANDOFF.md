# Phoenix hero handoff

This is a Tripo-authored, Blender-rigged phoenix intended to replace the old
procedural mesh while keeping flight, secondary motion, heat, and fire fully
procedural in Three.js. It is already placed in the open weather scene at
Blender world position `(384, 1952, 700)`.

## Deliverables

- Near/cinematic LOD: `public/models/phoenix-hero.glb`
- Distant/default LOD: `public/models/phoenix-hero-lod1.glb`
- Origin-normalized Blender asset: `assets-src/phoenix/phoenix-hero.blend`
- Live collection: `PHOENIX_HERO` in
  `/Users/eric/EricAssetLibrary/world-building/sanfrancisco.blend`
- Idempotent Blender builder: `tools/blender_phoenix_hero.py`
- Lossless geometry compressor: `tools/optimize-phoenix.mjs`
- Structural audit: `tools/phoenix-asset-audit.mjs`
- Headless WebGPU runtime audit: `tools/phoenix-runtime-probe.mjs`
- Final look-dev render:
  `.data/phoenix/phoenix_hero_tripo_weather.png`
- Deformation QA render:
  `.data/phoenix/phoenix_hero_deformation_test.png`

The original pre-phoenix scene backup remains at
`/Users/eric/EricAssetLibrary/world-building/sanfrancisco.pre-phoenix-20260714.blend`.

## Runtime budget

| Item | LOD0 | LOD1 |
| --- | ---: | ---: |
| File size, meshopt GLB | 3,298,076 bytes | 2,654,608 bytes |
| Vertices | 38,949 | 19,740 |
| Triangles | 58,000 | 23,000 |
| Skinned primitives / materials | 1 / 1 | 1 / 1 |
| Bones | 17 | 17 |
| Baked clips | 0 | 0 |

Both LODs embed the same one-material 2K PBR atlas set:

- `PHX_BaseColor_2K`: WebP, 1,134,346 bytes
- `PHX_Normal_2K`: WebP, 429,550 bytes
- `PHX_ORM_2K`: WebP, 379,824 bytes

The Tripo master remains available under `assets-src/phoenix/tripo/source/` and
contains 96,977 triangles with 8K base color plus 4K normal/ORM. The shipping
meshes retain the silhouette-bearing primary feathers while reducing texture
GPU cost to three 2K maps.

Both GLBs require `MeshoptDecoder`. Import and configure it only after the
phoenix feature's first-use gate; do not make meshopt or either phoenix GLB part
of clean boot.

## Current Three.js integration

The playable mount loads LOD0 from `src/vehicles/bird/asset.ts` on its existing
bird-mode first-use gate. The old `dressPhoenix()` geometry is no longer called.
The runtime resolves the five authored attachment nodes, maps the +X-facing rig
into the game's local -Z convention, and continues to drive all 17 bones from
the existing flight controller.

`src/vehicles/bird/plumage.ts` converts the imported atlas material to one
`MeshStandardNodeMaterial`. `_PHX_FLUTTER`, flap pressure, airspeed, and wind
drive three bands of vertex-stage motion: broad wash, a travelling span ripple,
and restrained high-frequency tip turbulence. `_PHX_HEAT` drives pulsing
coal-red/gold emission while the imported base-color, normal, and ORM maps stay
intact.

A dedicated compute dispatch is intentionally not used for this one 38,949
vertex hero. Direct vertex-stage TSL performs the deformation only for visible
draws and avoids a writable storage buffer, extra dispatch, synchronization,
and position-stream readback. The mount therefore remains one skinned mesh and
one material/draw call.

## LOD and loading policy

- Load only LOD1 for ordinary distant flight.
- Load LOD0 only for a close approach, mount state, photo mode, or cinematic.
- Choose by projected screen radius rather than a fixed world distance. A good
  initial promotion threshold is roughly 180-220 pixels.
- Do not request both GLBs on first activation. Cache the active asset, and
  dispose the inactive LOD when the owning activity safely ends.
- Distant remote players keep the existing procedural/fallback visual until the
  local phoenix feature is active and relevant.

The required waterfall remains: zero phoenix requests at clean boot, one chosen
GLB on first activation, and only the other LOD if a later screen-size change
actually requires it.

## Stable rig contract

The two GLBs contain the same semantic skeleton:

- Body: `root`, `spine01`, `chest`
- Neck/head: `neck01`, `neck02`, `head`
- Left wing: `wing_arm_L`, `wing_forearm_L`, `wing_hand_L`
- Right wing: `wing_arm_R`, `wing_forearm_R`, `wing_hand_R`
- Tail: `tail01`, `tail02`, `tail03`, `tail04`, `tail05`

The beak points glTF `+X`. Capture each bone's imported rest quaternion and
multiply procedural deltas from that rest pose; do not overwrite the rest pose
with the old procedural bird's absolute Euler values. The authored deformation
axes are:

- wing local X: flap/out-of-plane motion
- wing local Z: spread/fold in the feather plane
- wing local Y: feather-bank twist
- tail local X: lateral sway
- tail local Z: fan/curl shaping
- neck/head local Z: look yaw; local X: pitch/breath follow-through

Use asymmetric phase and amplitude across the three wing stages. The outer hand
chain should lag the arm by roughly 8-14% of a flap cycle; the five tail bones
should accumulate progressively rather than receive one identical rotation.

## Attachment nodes

The GLBs include bone-parented nodes for procedural effects:

- `PHX_Gen_Trail_L` -> `tail05`
- `PHX_Gen_Trail_R` -> `tail05`
- `PHX_Gen_Fire_Core` -> `chest`
- `PHX_Gen_Wingtip_L` -> `wing_hand_L`
- `PHX_Gen_Wingtip_R` -> `wing_hand_R`

Use these for GPU ember ribbons, heat haze, local light placement, and wingtip
sparks. Fire geometry is intentionally not baked into the GLB.

## Shader contract

Each skinned primitive exports:

- `_PHX_FLUTTER`: zero near rigid quills/body and strongest at free wing/tail
  tips.
- `_PHX_HEAT`: the authored ember/emission distribution, strongest through the
  tail and outer flight feathers.

The audit verifies both exact glTF semantics. Depending on the Three.js loader
version, custom attribute keys may be preserved or lowercased; resolve
`_PHX_FLUTTER`/`_phx_flutter` and `_PHX_HEAT`/`_phx_heat` once at load time.

In TSL/WGSL, displace the final skinned position along its normal with layered
low-frequency wing wash plus high-frequency tip flutter. Multiply emission and
subtle hue shift by `_PHX_HEAT`, airspeed, flap effort, and a slow ember pulse.
Keep this on GPU—no per-feather CPU transforms or readback. The detailed eye is
part of the PBR atlas; do not replace it with a flat emissive sphere.

## Tripo and Blender provenance

- Multiview generation task:
  `521366b4-a10c-4d77-9350-8dd2ad6856a2`
- Model: `v3.1-20260211`
- Inputs: front, mirrored left profile, back, right profile
- Generation: detailed geometry, extreme PBR texture, 100,000-face ceiling,
  original-image texture alignment, one fused mesh, UV export, no quad/parts
- Pre-rig task: `fe1fc89b-ff38-4fd6-8f99-5281dffa4c13`
- Tripo avian rig task:
  `9acedeff-a4c3-41a5-863f-a54056ca1a2b`

The Tripo rig output was rejected: it contained only root plus three tail bones
and no wing chains. Blender supplies the final 17-bone rig and deterministic
four-influence skin weights. There are no Tripo or Blender animation clips.

## Validation

Run:

```bash
node tools/phoenix-asset-audit.mjs
SF_PROBE_URL=http://127.0.0.1:5243 node tools/phoenix-runtime-probe.mjs
```

Verified on both GLBs:

- exact triangle targets and one skinned primitive
- one material and three 2K WebP PBR textures
- 17/17 semantic bones and five attachment nodes
- no `JOINTS_1`, therefore at most four exported skin influences
- `_PHX_FLUTTER` and `_PHX_HEAT` round-trip through Blender and meshopt
- zero baked animation clips
- exaggerated wing/head/tail pose renders without tears, shards, or rigid tail
  hinging
- clean boot makes zero phoenix requests; first bird activation requests LOD0
  exactly once and never requests the legacy `/models/phoenix.glb`
- WebGPU compiles one `MeshStandardNodeMaterial` with position and emissive
  nodes, all three PBR maps, both feather aliases, and both trail/wingtip pairs
- runtime screenshot: `.data/phoenix/phoenix-runtime.png`

## Reference ledger

- Yes — `/Users/eric/.agents/skills/threejs-3d-generator/references/api-notes.md`
- Yes — `/Users/eric/.agents/skills/threejs-3d-generator/references/threejs-integration.md`
- Yes — `/Users/eric/.agents/skills/threejs-3d-generator/references/image-generator-workflows.md`
- Yes — `/Users/eric/.codex/skills/webgpu-skill/SKILL.md`
- Yes — `/Users/eric/.codex/skills/webgpu-threejs-tsl/docs/core-concepts.md`
- Yes — `/Users/eric/.codex/skills/webgpu-threejs-tsl/docs/materials.md`
- Yes — `/Users/eric/.codex/skills/webgpu-threejs-tsl/docs/compute-shaders.md`
- Yes — `/Users/eric/.agents/skills/threejs-debug-profiler/references/debug-profile-checklists.md`
- Yes — `/Users/eric/.agents/skills/threejs-debug-profiler/references/checklists/scene-debugging.md`
- Yes — `/Users/eric/.agents/skills/threejs-debug-profiler/references/checklists/performance-profile.md`
