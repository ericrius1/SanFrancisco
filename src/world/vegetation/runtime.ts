// Root runtime for state shared by every vegetation renderer.
//
// Tree, grass, and flower subsystems keep their specialized placement and draw
// strategies, but none of them owns the global wind clock or interaction field.

import { setGroundDisplacers, type GroundDisplacer } from "../groundcover/displacers";
import { applyVegetationTuning } from "./tuning";
import { updateWindGusts, windGustValue } from "./wind";

const NO_DISPLACERS: readonly GroundDisplacer[] = [];
applyVegetationTuning();

/** Advance shared vegetation state exactly once per live world frame. */
export function updateVegetationEnvironment(
  dt: number,
  displacers: readonly GroundDisplacer[] = NO_DISPLACERS
): number {
  // Keeps factory resets and programmatic tuning writes authoritative even when
  // they bypass a pane change callback. Three scalar uniform writes are trivial.
  applyVegetationTuning();
  setGroundDisplacers(displacers);
  return updateWindGusts(dt);
}

export { windGustValue };
export type { GroundDisplacer };
