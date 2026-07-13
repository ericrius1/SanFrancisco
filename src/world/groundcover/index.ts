// Ground-cover meta-module — the shared infrastructure every scattered-foliage
// system reuses so new grasses / flowers / systems don't re-implement it:
//
//   • wind        — one gust envelope all layers sway to (updateWindGusts each frame)
//   • displacers  — one player/creature trample field all layers bend away from
//
// The concrete systems (garden blade grass, wildlands wildflowers, wildlands
// grass, …) stay their OWN modules with their own geometry/material/group so
// each can be toggled independently — they just plug into this infrastructure.

export { windGustGlobal, updateWindGusts, windGustValue } from "../vegetation/wind";
export { groundSway, WIND_DIR } from "./sway";
export { hash2, valueNoise, smoothstep, worleyClump, type Clump } from "./scatter";
export { DISPLACERS, MAX_DISPLACERS, setGroundDisplacers, type GroundDisplacer } from "./displacers";
