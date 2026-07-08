// Back-compat shim — the shared wind envelope moved to the ground-cover
// meta-module (src/world/groundcover/wind). The garden, wildlands, and future
// foliage systems all breathe to the same gust. Kept as a re-export so existing
// imports (`../garden/wind`) keep working.
export { windGustGlobal, updateWindGusts, windGustValue } from "../groundcover/wind";
