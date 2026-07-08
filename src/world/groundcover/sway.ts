// Shared ground-cover wind SWAY — the temporal bend signal grass + flowers ride.
//
// One TSL function returns the sway amount at a world-XZ anchor (a scalar the
// caller multiplies by WIND_DIR and its own amplitude × tip weight). Because every
// layer leans along the SAME WIND_DIR with the SAME phase and the SAME gust, grass
// and flowers move in lockstep instead of fighting — the whole meadow breathes as
// one. Dual-frequency (a low body oscillation + a faster flutter) mixed with a
// two-octave scrolling mx_noise gust, all under the shared windGustGlobal envelope
// so what you SEE matches the wind you HEAR.
//
// Promoted out of bladeGrass.ts (grass now calls groundSway verbatim, so its look
// is unchanged) — this is the "put the learnings in the meta-module" step: any new
// foliage gets the one canonical, harmonised wind for free.

import { mix, mx_noise_float, sin, time, vec2 } from "three/tsl";
import * as THREE from "three/webgpu";
import { windSpeed, windStrength } from "../../../vendor/SeedThree/src/core/wind.js";
import { windGustGlobal } from "./wind";

// TSL's d.ts narrows chained vector nodes too aggressively for vendored JS uniforms.
type TslNode = any;

/** Prevailing wind direction on the XZ plane — every foliage layer leans along it. */
export const WIND_DIR = new THREE.Vector3(0.85, 0, 0.53).normalize();

const windSpeedNode = windSpeed as TslNode;
const windStrengthNode = windStrength as TslNode;

/**
 * Shared sway amount at a world-space XZ anchor (`vec2` node: x = worldX, y = worldZ).
 * Multiply the result by WIND_DIR and your own amplitude × per-vertex tip weight to
 * bend a blade/stem. This is the botanical-garden grass's original grassSway body,
 * unchanged, so grass renders identically — flowers just call the same function.
 */
export function groundSway(anchorWorldXZ: TslNode): TslNode {
  const t = time.mul(windSpeedNode);
  const phase = anchorWorldXZ.x.mul(0.35).add(anchorWorldXZ.y.mul(0.27)).mul(2.2);
  const sine = sin(t.mul(1.15).add(phase)).mul(0.72).add(sin(t.mul(2.63).add(phase.mul(1.9))).mul(0.28));
  const gustScale = 1 / 18;
  const scroll = vec2(WIND_DIR.x, WIND_DIR.z).mul(t.mul(1.4 * gustScale));
  const nUv = anchorWorldXZ.mul(gustScale).sub(scroll);
  const gust = mx_noise_float(nUv).add(mx_noise_float(nUv.mul(3.1).add(vec2(37.7, 17.3))).mul(0.4)).mul(1.25);
  // windGustGlobal is the shared CPU gust envelope that also drives the procedural
  // wind audio — swells you hear are swells you see.
  const gustEnvelope = (windGustGlobal as TslNode).mul(1.3).add(0.3);
  return mix(sine, gust, 0.55).mul(windStrengthNode.mul(0.34)).mul(gustEnvelope);
}
