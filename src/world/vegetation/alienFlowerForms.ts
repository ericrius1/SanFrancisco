/**
 * Optional authored flower silhouettes for the sky gardens. This module is
 * imported only by sky-island vegetation, keeping the extra geometry builders
 * out of ordinary terrestrial garden and wildland chunks.
 */

import {
  AUTHORED_FLOWER_GEOMETRY_KIT,
  registerAuthoredFlowerForm
} from "../wildlands/flowerRing";

const {
  makeStem,
  bloomRings,
  makeCentre,
  finalizeBloom,
  flowerClump
} = AUTHORED_FLOWER_GEOMETRY_KIT;

/** A hanging five-point bell on a tall stem, readable from above and below. */
function starbellGeometry() {
  const single = (height: number, spin: number) => {
    const parts = makeStem(height, 0.027);
    bloomRings(parts, height, [
      { count: 5, pitch: 1.85, len: 0.19, wid: 0.105, rise: 0.58, close: 0.12, cup: 0.9, out: 0.025, spin },
      { count: 5, pitch: 0.56, len: 0.11, wid: 0.07, rise: 0.8, close: 0.42, cup: 1.1, out: 0.008, spin: spin + 0.62 }
    ], 2);
    parts.push(makeCentre(0.026, height - 0.025, 0.075));
    return finalizeBloom(parts, height + 0.2);
  };
  return flowerClump([
    { geometry: single(0.68, 0), x: 0, z: 0, windPhase: 0.4, windGain: 1.2 },
    { geometry: single(0.5, 0.8), x: 0.19, z: 0.12, scale: 0.84, yaw: 2.1, windPhase: 2.6, windGain: 0.86 },
    { geometry: single(0.44, 1.3), x: -0.17, z: 0.13, scale: 0.76, yaw: 4.4, windPhase: 4.8, windGain: 1.08 }
  ]);
}

/** Broad, asymmetric crystalline petals around a slender forked cluster. */
function prismOrchidGeometry() {
  const single = (height: number, spin: number) => {
    const parts = makeStem(height, 0.03);
    bloomRings(parts, height, [
      { count: 3, pitch: 0.14, len: 0.27, wid: 0.13, rise: 0.28, close: 0.04, cup: 0.42, out: 0.018, spin },
      { count: 3, pitch: 0.92, len: 0.17, wid: 0.115, rise: 0.7, close: 0.36, cup: 1.2, out: 0.008, spin: spin + Math.PI / 3 }
    ], 3);
    parts.push(makeCentre(0.032, height + 0.02, 0.065));
    return finalizeBloom(parts, height + 0.3);
  };
  return flowerClump([
    { geometry: single(0.46, 0.2), x: 0, z: 0, yaw: 0.2, windPhase: 0.5 },
    { geometry: single(0.38, 1.1), x: 0.24, z: 0.08, scale: 0.9, yaw: 2.5, windPhase: 2.8 }
  ]);
}

/** Two oversized nested cups whose pale centres stay visible from the air. */
function moonCupGeometry() {
  const single = (height: number, spin: number) => {
    const parts = makeStem(height, 0.035);
    bloomRings(parts, height, [
      { count: 9, pitch: 0.32, len: 0.25, wid: 0.16, rise: 0.46, close: 0.22, cup: 0.88, out: 0.025, spin },
      { count: 7, pitch: 0.95, len: 0.15, wid: 0.11, rise: 0.82, close: 0.48, cup: 1.32, out: 0.008, spin: spin + 0.38 }
    ], 3);
    parts.push(makeCentre(0.047, height + 0.025, 0.038));
    return finalizeBloom(parts, height + 0.3);
  };
  return flowerClump([
    { geometry: single(0.36, 0), x: 0, z: 0, windPhase: 0.3, windGain: 0.9 },
    { geometry: single(0.31, 0.7), x: 0.28, z: 0.13, scale: 0.78, yaw: 2.8, windPhase: 3.1, windGain: 1.1 }
  ]);
}

let installed = false;

/** Installs the sky-only forms into the shared authored flower compiler. */
export function installSkyAlienFlowerForms(): void {
  if (installed) return;
  installed = true;
  registerAuthoredFlowerForm("starbell", { build: starbellGeometry, heads: 3 });
  registerAuthoredFlowerForm("prism-orchid", { build: prismOrchidGeometry, heads: 2 });
  registerAuthoredFlowerForm("moon-cup", { build: moonCupGeometry, heads: 2 });
}
