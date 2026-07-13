import { AFTERLIGHT_CENTER } from "./meta";

export { AFTERLIGHT_ARRIVAL, AFTERLIGHT_CENTER } from "./meta";

/**
 * Afterlight lives in the deliberately empty crown of Buena Vista Park. Keep
 * every authored position here so the quest, capture demo, minimap pin, and
 * site gate cannot drift apart while the experience is tuned.
 */
/** Keep the authored installation readable without sterilising the whole meadow. */
export function inAfterlightGroundcoverClear(x: number, z: number, pad = 0): boolean {
  const rx = 14.5 + Math.max(0, pad);
  const rz = 13 + Math.max(0, pad);
  const dx = (x - AFTERLIGHT_CENTER.x) / rx;
  const dz = (z - AFTERLIGHT_CENTER.z) / rz;
  return dx * dx + dz * dz <= 1;
}

export const AFTERLIGHT_TUNING = {
  questSeconds: 82,
  collectRadius: 3.25,
  interactRadius: 5.6,
  activatePad: 28,
  deactivatePad: 95,
  loomRadius: 5.2,
  echoFloatHeight: 2.25,
  echoReturnSeconds: 1.15,
  completionHoldSeconds: 7,
  whaleOrbitRadiusX: 34,
  whaleOrbitRadiusZ: 27,
  whaleCruiseHeight: 31,
  whaleRevealSeconds: 3.2,
  whaleDuration: 48,
  whaleFadeSeconds: 6
} as const;

/** Counter-clockwise route around the summit, all inside the tree-free ellipse. */
export const ECHO_LAYOUT = [
  { x: -37, z: -12, hue: 0x8df6df, note: "a low note returns" },
  { x: -22, z: 31, hue: 0xa6c8ff, note: "the grove answers" },
  { x: 8, z: -35, hue: 0xf8d879, note: "a warm note wakes" },
  { x: 35, z: 24, hue: 0xf4a8d4, note: "the fog begins to sing" },
  { x: 45, z: -10, hue: 0xc9a8ff, note: "the last note finds its way" }
] as const;

export const KEEPER_LAYOUT = [
  { id: "mara", name: "Mara", x: -3.6, z: 7.1, yaw: 2.72, seed: "afterlight-mara" },
  { id: "sol", name: "Sol", x: 3.8, z: 6.5, yaw: -2.68, seed: "afterlight-sol" }
] as const;

export type AfterlightPhase = "idle" | "active" | "failed" | "complete";
