# Presidio Golf Course source ledger

The game models **Presidio Golf Course** at 300 Finley Road. The Olympic Club is
a different property near Lake Merced and is not the course represented here.

## Runtime geometry

- OpenStreetMap course boundary: <https://www.openstreetmap.org/way/16650363>
- OSM golf tagging: <https://wiki.openstreetmap.org/wiki/Tag%3Agolf%3Dhole>
- License/attribution: <https://www.openstreetmap.org/copyright> (ODbL,
  `© OpenStreetMap contributors`)
- Captured through Overpass on 2026-07-10. Reproducible snapshots are in
  `data/raw/golf-presidio.json` and `data/raw/golf-presidio-rels.json`; bake with
  `node tools/bake-golf.mjs`.

The snapshot supplies 18 hole routes, 19 fairways, 20 greens (including
practice/extra greens), 56 tees, 48 bunkers, 7 explicit rough patches, and 28
cart paths. Because OSM's explicit rough coverage is sparse, the game defines
rough as the course boundary under all more-specific surfaces.

## Official course facts and visual reference

- March 2026 official scorecard (par, four tee yardages, handicaps):
  <https://www.presidiogolf.com/wp-content/uploads/2026/03/PGC-Scorecard.pdf>
- Official hole-by-hole flyovers:
  <https://www.presidiogolf.com/course/hole-by-hole-tour/>
- Official course/gallery page: <https://www.presidiogolf.com/course/>
- Presidio Trust 2016 NHPA report (Fowler & Simpson-style bunker restoration):
  <https://wp.presidio.gov/wp-content/uploads/2023/07/2016-PT-NHPA-Annual-Report.pdf>

Official photos/video are reference-only and are not bundled into the game.

## Open terrain and imagery

- USGS 3DEP 1 m bare-earth DEM, CA_SanFrancisco_B23 (public domain):
  <https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/CA_SanFrancisco_B23/TIFF/USGS_1M_10_x54y419_CA_SanFrancisco_B23.tif>
- USDA NAIP 2024 ImageServer (public-domain aerial QA; local acquisition
  2024-05-29):
  <https://apps.geo.fpac.usda.gov/geo-imagery/rest/services/naip/conus_naip/ImageServer>
- DataSF five-foot contours (PDDL 1.0; QA fallback, different vertical datum):
  <https://data.sfgov.org/Energy-and-Environment/Elevation-Contours/6d73-6c4f>
- CC0 reference photo:
  <https://commons.wikimedia.org/wiki/File:Presidio_Golf_Course_-_San_Francisco,_CA.jpg>

The current city terrain remains the project's shared USGS-derived heightmap.
Golf applies a small continuous low-pass to that rendered ground and uses the
same sampled surface for its mesh and ball simulation. A future terrain rebake
can clip the 1 m 3DEP tile above without changing course geometry.

## Known approximations

- Daily pin placements and tee-marker positions move; OSM route endpoints and
  mapped tee centroids are nominal anchors.
- A 1 m bare-earth DEM does not provide putting-grade green micro-breaks.
- Bunker lip depth, sand firmness, turf speed, and moisture are not public
  construction data and remain tuned gameplay values.
- No reusable current CAD/green-contour construction plan was found. Current
  OSM geometry, 2024 NAIP, official flyovers, and post-2016 bunker imagery take
  precedence over historical plans.
