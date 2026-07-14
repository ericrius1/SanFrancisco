# Historical map generation prompts

These are the approved built-in image-generation prompts for the first two
geographically registered historical map plates. Control images are generated
with `node tools/build-historical-map-control.mjs` and
`node tools/build-historical-map-control.mjs --detail`.

## Golden Gate / Presidio overview

```text
Use case: style-transfer
Asset type: geographically registered game-map underlay tile
Input images: Image 1 is the edit target and exact geometry control.
Primary request: repaint Image 1 as an exceptionally beautiful San Francisco cartographic plate from approximately 1895–1915.
Style/medium: hand-colored copperplate engraving and restrained lithography on warm ivory rag paper; elegant civic survey map; fine archival ink work.
Composition/framing: preserve the exact top-down orthographic framing, aspect ratio, coastline, land masses, park boundaries, bridge alignment, and every road centerline from Image 1. The output must register directly over Image 1 without repositioning or changing geography.
Color palette: warm ivory and pale sepia urban land; muted moss and sage parks; desaturated teal-blue water; charcoal-brown ink; restrained rust-red bridge.
Materials/textures: subtle aged paper fibers, extremely fine engraved water wave lines, delicate park stippling, restrained hill hachures and contour engraving, slight ink bleed, quiet tonal variation. Keep texture scale fine enough for a zoomable game map.
Constraints: change only the visual materials and cartographic treatment; keep all geometry and proportions fixed; preserve every existing street and do not add, remove, bend, or reroute roads; preserve the exact coastline and green-area silhouettes; no perspective; no 3D buildings; no labels; no letters; no numbers; no icons; no pins; no legend; no compass rose; no border; no vignette; no decorative objects; no modern satellite imagery; no watermark. Carry paper and texture naturally through every image edge so adjacent tiles can blend.
```

## Golden Gate close detail

```text
Use case: style-transfer
Asset type: geographically registered close-zoom game-map detail tile
Input images: Image 1 is the edit target and exact geometry/composition control.
Primary request: repaint this exact close-up of the Golden Gate Bridge main span as an exceptionally detailed San Francisco cartographic plate from approximately 1895–1915.
Style/medium: hand-colored copperplate engraving and restrained lithography on warm ivory rag paper; elegant civic survey map; archival hairline ink work.
Composition/framing: preserve Image 1's exact top-down orthographic framing, portrait aspect ratio, bridge position, bridge angle, bridge width, and underlying water/land distribution. The output must register directly over Image 1. Keep the bridge crossing from top edge to bottom edge at the same coordinates.
Color palette: warm ivory paper undertone; desaturated teal-blue water; charcoal-brown engraving ink; restrained rust-red bridge.
Materials/textures: very fine dense engraved water-current lines, bathymetric contour strokes, subtle paper fibers, slight period ink bleed, tiny crosshatching. This is a close-zoom tile covering only 500 by 750 meters, so render the engraving substantially finer and crisper than an overview map.
Constraints: change only visual materials and cartographic treatment; preserve the bridge exactly; do not add land, coastlines, roads, buildings, or geographic objects; no perspective; no 3D; no labels; no letters; no numbers; no icons; no pins; no legend; no compass rose; no border; no vignette; no decorative objects; no modern imagery; no watermark. Continue the water engraving and paper texture naturally through all four edges.
```
