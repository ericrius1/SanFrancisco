# Native foliage texture pipeline

`npm run build:native-foliage-textures` regenerates every native tree texture
and `public/native-foliage/manifest.json`. The deterministic procedural
generator owns every source pixel; it has no imported texture or vendor
dependency.

The same command copies the matching Three r185 Basis Universal worker and
WASM runtime into `public/native-foliage/basis-r185/`. That versioned public
URL works in both Vite development and production and is safe to cache
immutably; the loader never depends on a bundler-generated `node_modules` URL.

The generated directory is owned by the tool and is replaced on every build.
Keep hand-authored source files elsewhere.

Texture filenames include a 16-character content digest. The manifest is
network-first/no-cache while immutable KTX2 payloads are cache-first, so a
rebake cannot strand returning service-worker clients on an old texture pack.

## Runtime contract

The manifest is keyed by reusable material-set IDs. Native archetypes request
those canonical IDs, so recipes can share textures without owning texture
paths. It contains only shader-owned controls (translucency, alpha cutoff, and
two-sidedness). Geometry dimensions, wind stiffness, and bark UV scale have one
canonical owner in the native tree recipes rather than a second texture table.

Each set has four base textures:

| Texture | Transfer | Packing | Encoder |
| --- | --- | --- | --- |
| `leaf-color.ktx2` | sRGB | RGB base color, A cutout opacity | UASTC + Zstd |
| `leaf-surface.ktx2` | linear | R normal X, G normal Y, B roughness, A translucency | UASTC + Zstd |
| `bark-color.ktx2` | sRGB | RGB base color | ETC1S |
| `bark-surface.ktx2` | linear | R normal X, G normal Y, B roughness | UASTC + Zstd |

Normal Z is reconstructed with
`sqrt(max(0, 1 - dot(normalXY, normalXY)))`. Color texture alpha remains linear
when the GPU decodes the texture's RGB channels as sRGB.

All textures are 512 x 512, carry a complete ten-level mip pyramid, and are
stored lower-left (`S=r,T=u`). Native foliage geometry uses `v=0` at the
branch/base and `v=1` at the free tip; this storage flip is deliberate because
`KTX2Loader` keeps compressed textures at `flipY=false`. The build and check
commands verify the orientation metadata on every container. Leaf color
mipmaps use alpha-coverage preservation at the material set's cutoff; this
keeps thin needles and cutout leaf edges from disappearing as quickly under
minification.

The runtime should initialize one shared `KTX2Loader`, call `detectSupport()` on
the active renderer, cache each manifest URI, and request only the material sets
needed by the active region. Seasonal color variants are separate assets so they
can remain unloaded until selected.

## Encoding choices and risks

- UASTC is used wherever cutout edges or packed normal data make ETC1S artifacts
  especially visible. This can be larger on the wire than WebP, but it uploads
  through GPU-native block compression and avoids decoding into full RGBA8
  texture storage on supported devices.
- Bark color tolerates ETC1S well and is substantially smaller. Very close hero
  trunks may expose ETC1S blocks; individual bark sets can move to UASTC if an
  in-world close-up proves that necessary.
- Packing roughness and translucency beside normal XY reduces texture objects,
  requests, and samples. It also means the four-channel leaf surface normally
  transcodes to an RGBA-capable GPU format instead of a two-channel BC5 normal
  format. The reduced sampler/request overhead is the intended tradeoff.
- Alpha coverage is necessarily discrete in the final 2 x 2 and 1 x 1 levels.
  Very distant foliage should still use geometric density/LOD fading rather
  than relying on the last texture mip to remove a whole crown cleanly.
- The procedural art is deliberately stylized and species-specific, but 512-px
  tiling bark can repeat on landmark trunks. Recipe-owned bark UV scale can be
  combined with seeded UV offset/rotation; landmark trees can later receive a
  dedicated non-tiling detail layer without changing the base pack.
- Basis transcode targets vary by device. BC, ETC2, and ASTC targets keep the
  textures compressed; an uncompressed fallback costs materially more GPU
  memory and should be visible in runtime diagnostics.
- Landscape and horizon crowns use opaque compiler-generated cluster
  silhouettes and recipe palettes. They do not request the manifest,
  transcoder, or KTX2 files; the four-map species set is leased only when a
  tree enters the close canopy/grove tiers. This removes distant alpha overdraw
  and avoids texture traffic merely because a forest is visible across town.

## Verification

`npm run check:native-foliage-textures` validates every manifest digest, KTX2
container with `ktx2check`, and the copied r185 transcoder bytes. The build
fixes encoder threads and UASTC RDO mode so identical inputs and tool versions
produce byte-identical outputs.

The current generated pack contains 46 KTX2 files (10 material sets, including
six lazy color variants) and is about 5.78 MiB. The same complete mip payload
would occupy about 54.67 MiB in its source RGB/RGBA representation. On a typical
block-compressed target, one active set's four base maps are approximately
1.17 MiB of GPU texture storage; variants add storage only when requested.
