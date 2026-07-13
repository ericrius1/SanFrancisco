# Japanese Tea Garden — implementation sources

Checked 2026-07-11. World geometry uses the project's pinned local-metre
projection (`+X east`, `+Z south`) and is authored at 1 unit = 1 metre.

## Geometry and placement

- [OpenStreetMap garden boundary, way 30900516](https://www.openstreetmap.org/way/30900516)
  - Current garden polygon and address.
  - OSM data is © OpenStreetMap contributors, licensed under ODbL.
- [OpenStreetMap Tea House, way 34220947](https://www.openstreetmap.org/way/34220947)
- [OpenStreetMap Gift Shop, way 34220963](https://www.openstreetmap.org/way/34220963)
- [OpenStreetMap Pagoda, way 34221099](https://www.openstreetmap.org/way/34221099)
- [OpenStreetMap Temple Gate, way 136888944](https://www.openstreetmap.org/way/136888944)
- [OpenStreetMap South Gate, way 136888948](https://www.openstreetmap.org/way/136888948)
- [OpenStreetMap Drum Bridge, way 136898969](https://www.openstreetmap.org/way/136898969)
- [DataSF Building Footprints](https://data.sfgov.org/Geographic-Locations-and-Boundaries/Building-Footprints/ynuv-fyni)
  - Cross-check for the Main Gate and Pagoda footprints/heights.
- [Official 2026 visitor map](https://gggp.org/wp-content/uploads/2026/05/20260315-JapaneseTeaGarden-Map-11x8-v4-FINAL-1.pdf)
  - Landmark names and schematic circulation: Main Entrance, Hagiwara Gate,
    Tea House, Gift Shop, Temple Gate, Pagoda Plaza, Long Bridge, Drum Bridge,
    Dry Landscape Garden, Mt. Fuji Hedge, and ponds.
  - The map is schematic and rotated, so OSM controls absolute placement.

## History and interpretation

- [Gardens of Golden Gate Park — Japanese Tea Garden](https://gggp.org/japanese-tea-garden/)
  - Qualified description as the oldest operating public Japanese garden in
    North America; Buddha, dry landscape, and 1915 Pagoda interpretation.
- [Gardens of Golden Gate Park — historical timeline](https://gggp.org/about/)
  - 1894 fair origins, Makoto Hagiwara and family, forced removal in 1942,
    1953 Peace Lantern, and later gate/bridge/Tea House work.
- [SF Rec & Parks — redesigned Pagoda Plaza](https://www.sfrecpark.org/m/newsflash/home/detail/1986)
  - 2022 Pagoda restoration, 2024 plaza, Tatsuyama stone, permeable paving,
    seven mature Japanese black pines, and new paths.
- [Gardens of Golden Gate Park — Hiroshima Day](https://gggp.org/commemorating-hiroshima-day/)
  - Two Hiroshima-survivor-descendant ginkgoes at Pagoda Plaza.
- [Gardens social story — Peace Lantern](https://gggp.org/wp-content/uploads/2025/08/JTG-Social-Story-2025.pdf)
  - Japanese schoolchildren contributed to the Lantern of Peace in 1953.
- [Japanese Tea Garden concessionaire — Tea House](https://www.japaneseteagardensf.com/tea-house)
  - Hagiwara family oral history around fortune cookies. The implementation
    labels this as a family account rather than a settled origin claim.
- [Densho Encyclopedia — Japanese Tea Garden](https://encyclopedia.densho.org/Japanese_Tea_Garden_%28San_Francisco%29/)
  - Japanese American history and the Hagiwara family's wartime removal.
- [Kew Plants of the World Online — Ginkgo biloba](https://powo.science.kew.org/taxon/urn%3Alsid%3Aipni.org%3Anames%3A262125-1/general-information)
  - Botanical context for the ginkgo tour stop.

## Interpretive guardrails

- Makoto Hagiwara died in 1925; the guide says the **Hagiwara family** was
  forcibly removed in 1942, never that Makoto himself was incarcerated.
- Use “forced removal” or “incarceration,” not euphemistic wartime language.
- The present Main Gate is not described as the untouched 1894 gate.
- The Pagoda is described as a 1915 exposition display moved into the garden,
  not as an originally functioning temple.
- The garden polygon is treated as implementation-grade crowdsourced geometry,
  not as a surveyed legal boundary.

