# Building facade source art

Generated with Codex's built-in `gpt-image-2` image path as four square,
front-facing, orthographic, one-storey/one-bay PBR texture sources:

- late-19th-century muted red brick with dressed-stone trim
- early-20th-century warm buff limestone
- classic San Francisco sage painted stucco
- 1930s warm-gray early-modern concrete

Shared prompt constraints: facade fills the frame; camera perpendicular; flat
overcast reference light; exactly one centered window bay; restrained age and
weathering; continuous wall material at every edge; no street, sky, people,
signs, text, doors, balconies, perspective, vignette, or watermark.

`tools/build-building-facade-textures.mjs` normalizes these sources, blends
opposing edges, adds wrap gutters, derives the glass mask and packed
height/roughness surface map, and emits KTX2 plus WebP runtime atlases. The bake
requires Khronos `toktx`; set `TOKTX_BIN` when it is not installed at the
repository's default tooling path.
