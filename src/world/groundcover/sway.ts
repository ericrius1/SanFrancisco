// Shared ground-cover wind SWAY — the temporal bend signal grass + flowers ride.
//
// One TSL function returns the downwind load at a world-XZ anchor. Every layer
// shares an integrated clock and gust envelope, so live tempo changes cannot jump
// phase and the meadow breathes as one. A persistent downwind bias carries slow
// body motion, restrained flutter, and a broad scrolling gust field; foliage no
// longer rocks through a full upwind reversal every half-cycle.
//
// Centralized here so every current and future foliage renderer inherits the same
// temporal and directional behavior instead of growing a competing oscillator.

import { mx_noise_float, sin, vec2 } from "three/tsl";
import { WIND_DIR, windGustGlobal, windPhase, windStrength } from "../vegetation/wind";

// TSL's d.ts narrows chained vector nodes too aggressively for shared uniforms.
type TslNode = any;

export { WIND_DIR };

const windPhaseNode = windPhase as TslNode;
const windStrengthNode = windStrength as TslNode;

const WIND_LOAD_SCALE = 0.34;
const WIND_FLOW_CURL_GAIN = 0.28;

function coherentWindLoad(anchorWorldXZ: TslNode, detailed: boolean): TslNode {
  const along = anchorWorldXZ.x.mul(WIND_DIR.x).add(anchorWorldXZ.y.mul(WIND_DIR.z));
  const across = anchorWorldXZ.x.mul(-WIND_DIR.z).add(anchorWorldXZ.y.mul(WIND_DIR.x));
  const bodyPhase = windPhaseNode.mul(0.62).sub(along.mul(0.085)).add(across.mul(0.025));
  const body = sin(bodyPhase);
  const flutter = sin(
    windPhaseNode
      .mul(1.37)
      .sub(along.mul(0.17))
      .sub(across.mul(0.08))
      .add(body.mul(0.28))
  );
  let load = body.mul(0.22).add(flutter.mul(0.06)).add(0.5);

  if (detailed) {
    const fieldScale = 1 / 24;
    const scroll = vec2(WIND_DIR.x, WIND_DIR.z).mul(windPhaseNode.mul(0.62 * fieldScale));
    const p = anchorWorldXZ.mul(fieldScale).sub(scroll);
    const spatialGust = mx_noise_float(p)
      .add(mx_noise_float(p.mul(2.3).add(vec2(31.7, 19.1))).mul(0.35));
    load = load.add(spatialGust.mul(0.13));
  }

  const gustEnvelope = (windGustGlobal as TslNode).mul(1.0).add(0.4);
  return load.clamp(0.08, 1).mul(windStrengthNode.mul(WIND_LOAD_SCALE)).mul(gustEnvelope);
}

/**
 * Shared sway amount at a world-space XZ anchor (`vec2` node: x = worldX, y = worldZ).
 * Multiply the result by WIND_DIR and your own amplitude × per-vertex tip weight to
 * bend a blade/stem. The result remains non-negative: wind load can ease almost
 * away, but it never snaps the whole plant through the prevailing direction.
 */
export function groundSway(anchorWorldXZ: TslNode): TslNode {
  return coherentWindLoad(anchorWorldXZ, true);
}

/**
 * Shared wind as a spatially-varying FLOW (vec2 x=worldX bend, y=worldZ bend),
 * with a broad curl perturbation around the prevailing heading. The raw curl is
 * deliberately not normalized: near a zero-gradient crossing it smoothly fades
 * away instead of letting numerical noise flip a unit direction abruptly.
 */
export function groundSwayFlow(anchorWorldXZ: TslNode): TslNode {
  const sway = groundSway(anchorWorldXZ);
  const base = vec2(WIND_DIR.x, WIND_DIR.z);
  const baseDir = base.div(base.length().max(1e-3));
  const flowScale = 1 / 30;
  const scroll = baseDir.mul(windPhaseNode.mul(0.38 * flowScale));
  const p = anchorWorldXZ.mul(flowScale).sub(scroll);
  const eps = 0.5;
  const dPsiDz = mx_noise_float(p.add(vec2(0, eps))).sub(mx_noise_float(p.sub(vec2(0, eps))));
  const dPsiDx = mx_noise_float(p.add(vec2(eps, 0))).sub(mx_noise_float(p.sub(vec2(eps, 0))));
  const curl = vec2(dPsiDz, dPsiDx.negate());
  const dir = baseDir.add(curl.mul(WIND_FLOW_CURL_GAIN));
  const dirN = dir.div(dir.length().max(1e-3));
  return dirN.mul(sway);
}

/** Reduced distance grade: same body/flutter phase without the scrolling detail field. */
export function groundSwayLite(anchorWorldXZ: TslNode): TslNode {
  return coherentWindLoad(anchorWorldXZ, false);
}
