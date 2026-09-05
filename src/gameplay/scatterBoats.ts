// Scattered boardable bay boats — walk/swim up + E to drive one off.
// First extraction of the main.ts decomposition plan (docs/MAIN_DECOMPOSITION.md):
// pure spawn data + wiring, no per-frame logic of its own. The boats are
// persistent AbandonedMounts; they sail themselves (AbandonedMounts #sailBoat)
// and far-hide past FAR_HIDE_DISTANCE so they never cost draws city-side.
import * as THREE from "three/webgpu";
import { waterHeight } from "../world/heightmap";
import { loadVehicleRuntime } from "../vehicles/runtime";
import type { PlayerMode } from "../player/types";
import type { AbandonedMounts } from "./abandonedMounts";

// Midpoint spots sit between two known-water spots so wanderers stay in open bay.
const SAIL_SPOTS: readonly [number, number, number][] = [
  [2600, -2400, 1.2],
  [-700, -2380, 0.4],
  [1700, -3550, 2.3],
  [4000, -2000, -1.0],
  [-1500, -2500, 0.8],
  [3300, -2200, 0.0],
  [-1100, -2440, 2.0]
];

const SPEED_SPOTS: readonly [number, number, number][] = [
  [3300, -2600, -0.6],
  [900, -2950, 1.7],
  [-2350, -2150, 0.2],
  [4550, -1650, -1.4],
  [250, -3750, 2.9],
  [3925, -2125, 1.0],
  [575, -3350, -2.0]
];

/** Coordinates are cheap at boot. Only a nearby, first-use boat is built. */
export function createScatterBoats(mounts: AbandonedMounts) {
  const entries = [
    ...SAIL_SPOTS.map(pose => ({ mode: "boat" as const, pose, loaded: false, pending: false })),
    ...SPEED_SPOTS.map(pose => ({ mode: "speedboat" as const, pose, loaded: false, pending: false }))
  ];
  let initial: { x: number; z: number } | null = null;
  let active = false;
  return (focus: THREE.Vector3, mode: PlayerMode): void => {
    initial ??= { x: focus.x, z: focus.z };
    active ||= mode !== "walk" || Math.hypot(focus.x - initial.x, focus.z - initial.z) > 12;
    if (!active) return;
    for (const entry of entries) {
      const [x, z, heading] = entry.pose;
      if (entry.loaded || entry.pending || Math.hypot(focus.x-x,focus.z-z) > 650) continue;
      entry.pending = true;
      void loadVehicleRuntime(entry.mode).then(() => {
        // Teleporting during import must not construct the abandoned fleet.
        if (Math.hypot(focus.x-x,focus.z-z) > 750) return;
        mounts.spawn(entry.mode, {
          position: new THREE.Vector3(x, waterHeight(x,z,0)+0.4, z),
          quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),heading),
          linear: [0,0,0], angular: [0,0,0]
        }, { persistent: true });
        entry.loaded = true;
      }).catch(error => console.warn("[bay boats]", error)).finally(() => { entry.pending = false; });
      break; // one new boat per update, even on a cold waterfront arrival
    }
  };
}
