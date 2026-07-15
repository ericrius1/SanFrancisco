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
import { WIND_DIR, windGustGlobal, windSpeed, windStrength } from "../vegetation/wind";

// TSL's d.ts narrows chained vector nodes too aggressively for shared uniforms.
type TslNode = any;

export { WIND_DIR };

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

// How far the local swirl pulls the bend direction off the prevailing WIND_DIR.
// Keep this below 0.5: at an exact half-blend an opposing curl vector cancels the
// prevailing vector to zero, producing thin dead-wind seams where the normalized
// direction becomes numerically unstable. 0.38 still gives broad visible arcs
// while retaining a guaranteed prevailing component everywhere.
const WIND_FLOW_MIX = 0.38;

/**
 * Shared wind as a spatially-varying FLOW (vec2 x=worldX bend, y=worldZ bend),
 * a drop-in for the old `WIND_DIR.mul(groundSway(xz))` term. Same magnitude and
 * gust envelope as `groundSway` (so what you hear still matches what you see), but
 * the *direction* now swirls: it is the prevailing heading blended with the CURL
 * of the same scrolling noise the gust rides. Curl of a scalar potential ψ is
 * `(∂ψ/∂z, −∂ψ/∂x)`, which is divergence-free — the meadow eddies and leans in
 * gusting arcs instead of every blade tilting the one identical way, with no
 * "sucking toward a point" a raw noise vector would give. Callers lift it to 3-D
 * as `vec3(flow.x, 0, flow.y)`.
 */
export function groundSwayFlow(anchorWorldXZ: TslNode): TslNode {
  const sway = groundSway(anchorWorldXZ); // unchanged scalar magnitude / envelope
  const base = vec2(WIND_DIR.x, WIND_DIR.z);
  const baseDir = base.div(base.length().max(1e-3));
  // Low-frequency scrolling potential (bigger cells than the gust so eddies read
  // as gusting arcs, not fizz), then central-difference its curl.
  const t = time.mul(windSpeedNode);
  const flowScale = 1 / 30;
  const scroll = baseDir.mul(t.mul(0.55 * flowScale));
  const p = anchorWorldXZ.mul(flowScale).sub(scroll);
  const eps = 0.5;
  const dPsiDz = mx_noise_float(p.add(vec2(0, eps))).sub(mx_noise_float(p.sub(vec2(0, eps))));
  const dPsiDx = mx_noise_float(p.add(vec2(eps, 0))).sub(mx_noise_float(p.sub(vec2(eps, 0))));
  const curl = vec2(dPsiDz, dPsiDx.negate());
  const curlDir = curl.div(curl.length().max(1e-3));
  const dir = mix(baseDir, curlDir, WIND_FLOW_MIX);
  const dirN = dir.div(dir.length().max(1e-3));
  return dirN.mul(sway);
}

/** One-sine distance grade: same direction, speed, strength and gust envelope. */
export function groundSwayLite(anchorWorldXZ: TslNode): TslNode {
  const t = time.mul(windSpeedNode);
  const phase = anchorWorldXZ.x.mul(0.35).add(anchorWorldXZ.y.mul(0.27)).mul(2.2);
  const sine = sin(t.mul(1.15).add(phase));
  const gustEnvelope = (windGustGlobal as TslNode).mul(1.3).add(0.3);
  return sine.mul(windStrengthNode.mul(0.34)).mul(gustEnvelope);
}
