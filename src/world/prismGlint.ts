import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";

/**
 * Shared-uniform bridge between the prism kite's light rig and the water.
 *
 * The prism's dispersed fan hangs in the air over the beach; the sea under it
 * should carry its reflection — colored streaks breaking up in the ripple the
 * way any bright light over water does. The water shader can compute that
 * view-correctly for almost nothing (see oceanSurfaceRadiance's prism lobe):
 * a fragment sparkles when its reflected eye ray passes near the beam segment,
 * so the only thing the kite has to tell the water is where the beam IS.
 *
 * prismLight.ts writes these each frame it is lit; the near water sheet reads
 * them. A plain module keeps the two decoupled — no imports across the
 * kite/water boundary in either direction beyond this file, no per-frame
 * allocation, and zero cost when strength sits at 0 (the term multiplies out).
 *
 * One writer at a time: the last lit prism to update wins the frame. Today
 * that is at most the encounter's prism plus a player-flown one, which are
 * never both near the same water; if that changes, this becomes a small array.
 */
export const PRISM_GLINT = {
  /** Beam origin — the sail, world space. Parked far underwater when unlit. */
  origin: uniform(new THREE.Vector3(0, -500, 0)),
  /** Unit beam direction (down-sun, tilted into the beach, swung by bank). */
  dir: uniform(new THREE.Vector3(0, -1, 0)),
  /** Unit across-beam axis the spectrum is spread along (horizontal). */
  across: uniform(new THREE.Vector3(1, 0, 0)),
  /** x: beam length (m) · y: half-width at the far end (m) · z: strength 0..1. */
  params: uniform(new THREE.Vector3(54, 14, 0))
};
