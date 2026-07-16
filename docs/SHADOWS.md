# Shadow architecture

San Francisco uses one physical sun with three player-centric projection maps.
The maps have fixed light-space extents and world-snapped texel grids, so camera
FOV, orbit, shake, and indoor transitions cannot resize or phase-shift them.

| Domain | Extent | Resolution | Texel size | Caster policy | Update policy |
| --- | ---: | ---: | ---: | --- | --- |
| Hero | 32 m | 1024² | 3.125 cm | Player, current vehicle, held items, animated nearby actors | Every rendered frame |
| Local | 96 m | 1536² | 6.25 cm | Stable nearby static geometry/proxies | 4.5 m anchor, 0.05° sun, or local content revision |
| Far | 1024 m | 1024² | 1 m | Coarse skyline/massing proxies only | 8 m anchor, 0.15° sun, or far content revision |

The three factors are selected with real light-space coordinates. Every domain
uses radial distance in the light's projection plane, so its transition cannot
draw the square shape of its orthographic texture across the terrain. Hero
fades to neutral over its final 5 m and finishes 0.125 m inside the map. Local
hands off continuously to far over a broad 24 m feather (23.75–47.75 m), which
prevents long, nearly solid low-sun shadows from revealing the local projection
boundary anywhere in the world. Once the world-locked field has valid coverage
it owns the far domain outside that local feather; the raster far map is the
fallback during low/stale sun or a field rebuild. That fallback fades over its
final 96 m and reaches neutral 4 m inside its projection edge. Do not multiply
the field over the far map: they represent the same direct occlusion and must
replace/crossfade one another.

Projection-edge fades must be radial, broad enough for a dark field rather than
only an isolated object shadow, and finish *inside* the corresponding
orthographic map. Ending at or beyond the camera extent lets PCF filtering
repeat a boundary texel into a long light-space wedge. A narrow or square-metric
fade can still expose the projection footprint as a screen-spanning rectangle
under a grazing sun even when the sampling itself is technically in bounds.

## Caster layers

Use the helpers in `src/world/shadows/shadowLayers.ts`; do not set selective
camera layer bits ad hoc.

- `HERO_DYNAMIC`: moving/deforming silhouettes. Keep this tier deliberately
  small because it renders every frame.
- `LOCAL_STATIC`: detailed static shapes that matter close to the player.
- `FAR_PROXY`: only coarse massing that remains meaningful at 1 m/texel.
- Shadow-only proxies have no beauty-camera bit. Beauty meshes can retain layer
  0 while adding one selective shadow layer.

Streamed buildings use collider microproxies, trees use stable trunk/crown
proxies, and CityGen chunks use one coarse massing proxy. Landmark, Palace, and
Sutro far geometry follows the same rule. Sub-metre wires, scree, shrubs,
planting, netting, facade detail, and alpha-hashed foliage must not enter FAR.

Static membership changes must call `Sky.invalidateStaticShadows(scope)`. Use
`"local"`, `"far"`, or `"all"` so a distant stream event does not refresh the
near map. Projection refreshes are completed—not merely requested—before they
are counted by diagnostics.

## Far and contact complements

`FarOcclusionField` builds a 16 m, world-locked RG16F height/occlusion atlas in a
worker. It coalesces streaming bursts, enforces a maximum revision latency,
fades stale low-sun data out, and fades through the raster far map before a new
revision becomes visible. It is a skyline/terrain representation, not a close
shadow map.

The contact complement is a deterministic half-resolution, six-tap screen-space
ray pass driven by the beauty depth buffer. It has no jitter or temporal history;
soft depth evidence and receiver-edge damping prevent binary foot/wheel flicker.
It remains subtle (`0.14` default intensity) and complements rather than replaces
the 3.125 cm hero projection.

## Diagnostics and regression tests

Press `/` for FPS, frame time, and the Tweakpane diagnostics. The Shadows folder
reports each domain's completed update rate, age, texel size, and reason. Press
`m` for spatial landmark overlays and `.` to reset all tunables to source-code
defaults.

Run:

```sh
npm run test:shadows:analysis
npm run test:shadows:far-field
npm run test:shadows:contact
npm run test:shadows:temporal
```

The analysis command includes the projection-edge contract: monotonic hero and
local retirement, a broad local feather, fully neutral samples before map
edges, and an inside-safe far handoff.

The temporal probe uses a hero-only moving caster and neutral receiver material
to detect stationary shimmer and 2/4-frame update impulses. It manually advances
Three's NodeFrame when driving the renderer outside RAF.

`ClipmapShadowNode` is the sun's complete received-shadow composition. Adding a
separate `material.receivedShadowNode` without auditing Three's child ShadowNode
behavior can apply that material factor once per projection; treat such a change
as an architecture change and re-run the temporal and visual probes.

## TSL branch rule (load-bearing)

WGSL materializes each TSL node once, inside the *first* branch that references
it. A node referenced from a second `If`/`ElseIf`/`Else` arm reads that arm's
zero-initialized private var instead of re-evaluating. This silently zeroed the
far factor beyond the local feather (a player-centric dark ring with a sharp
inner edge at the feather radius, fading out toward the far projection edge)
while every input — maps, matrices, bindings — measured healthy. Rules inside
`ClipmapShadowNode.setup` (and any node shared across materials):

- A domain sample or shared atlas sample may be referenced by at most one
  branch arm. To keep a sampling skip, gate the sample into a pre-declared
  neutral `toVar()` in its own single-purpose `If`, then compose branch-free.
- Never re-reference a sampled node from a second arm "because the weights
  differ" — express weight differences as arithmetic over the hoisted var.
