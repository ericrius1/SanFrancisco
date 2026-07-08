// Shared ground-cover player interaction — the trample field.
//
// One uniform array of displacer slots (player + creatures) that EVERY
// ground-cover layer reads: the botanical-garden blade grass, the wildlands
// grass, and the wildflowers all bend away from the same points. Written once
// per frame from main; the layers just sample it in their vertex shaders.
//
// This is the "meta" glue the individual modules (grass, flowers) share — like
// the wind gust envelope (garden/wind.ts) — while each keeps its own geometry,
// material, and scatter. Slot layout xyzw = (worldX, worldZ, radius, strength);
// radius 0 disables a slot.

import * as THREE from "three/webgpu";
import { uniformArray } from "three/tsl";

export const MAX_DISPLACERS = 12;

const DISPLACER_DATA = Array.from({ length: MAX_DISPLACERS }, () => new THREE.Vector4(0, 0, 0, 0));

/** The shared uniform array. Layers read this directly in their materials. */
export const DISPLACERS = uniformArray(DISPLACER_DATA);

export type GroundDisplacer = { x: number; z: number; radius: number; strength: number };

/** Write the active displacers for this frame (player, creatures). NaN-guarded:
 *  a single bad value would smear vertices across the sky. */
export function setGroundDisplacers(list: readonly GroundDisplacer[]) {
  let slot = 0;
  for (const d of list) {
    if (slot >= MAX_DISPLACERS) break;
    if (!Number.isFinite(d.x) || !Number.isFinite(d.z) || !Number.isFinite(d.strength)) continue;
    if (!(d.radius > 0)) continue;
    DISPLACER_DATA[slot].set(d.x, d.z, Math.min(d.radius, 12), Math.min(Math.max(d.strength, 0), 3));
    slot++;
  }
  for (; slot < MAX_DISPLACERS; slot++) {
    const v = DISPLACER_DATA[slot];
    if (v.z !== 0) v.set(0, 0, 0, 0);
  }
}
