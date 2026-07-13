import { PALACE_FINE_ARTS, PALACE_LAGOON } from "../../world/heightmap";

export { REVERIE_CENTER } from "./meta";

/**
 * Palace Reverie — a blue-hour art experience at the Palace of Fine Arts.
 * Every authored world position lives here so the quest, minimap pin, site
 * gate, NPCs, and cinematic cannot drift apart while the piece is tuned.
 */

/** Rotunda / palace landmark for camera look-ats. */
export const REVERIE_ROTUNDA = {
  x: PALACE_FINE_ARTS.x,
  z: PALACE_FINE_ARTS.z,
  y: 28
} as const;

export const REVERIE_TUNING = {
  activatePad: 55,
  deactivatePad: 140,
  interactRadius: 3.4,
  promptRadius: 11,
  lampAwakenSeconds: 0.72,
  completionHoldSeconds: 20,
  floatLanternCount: 30,
  fireflyBase: 22,
  fireflyPerLamp: 9
} as const;

/** Shore greeting spot — looking across the lagoon toward the rotunda. */
export const REVERIE_SPAWN = {
  x: -248,
  z: -1410,
  heading: -2.35 // faces WNW toward rotunda + north colonnade
} as const;

/**
 * Memory lamps along the peristyle wings (game frame). Angles match the
 * authored colonnade spans in world/palaceColonnade.ts so lamps sit between
 * real columns instead of floating in the lawn.
 */
const PERISTYLE_R = 112;
const CX = PALACE_FINE_ARTS.x;
const CZ = PALACE_FINE_ARTS.z;

function lampAt(deg: number, hue: number, whisper: string) {
  const a = (deg * Math.PI) / 180;
  return {
    x: CX + Math.cos(a) * PERISTYLE_R,
    z: CZ + Math.sin(a) * PERISTYLE_R,
    hue,
    whisper
  };
}

export const LAMP_LAYOUT = [
  lampAt(120, 0x9ef0ff, "a cool note opens across the water"),
  lampAt(140, 0xffd6a0, "warm stone remembers its name"),
  lampAt(158, 0xf4b4ff, "the gallery hums under its breath"),
  lampAt(208, 0xa8ffd2, "the lagoon answers in green"),
  lampAt(228, 0xffc4d8, "the last light finds its way home")
] as const;

export const NPC_LAYOUT = [
  {
    id: "inez",
    name: "Inez",
    role: "painter",
    x: -262,
    z: -1402,
    yaw: -2.4,
    seed: "palace-reverie-inez",
    hello: "Inez: The peristyle forgets how to glow after noon. Follow the shore lights — wake each lamp with E.",
    midway: "Inez: Yes — keep going. Watch the ribbons gather. The lagoon is listening.",
    done: "Inez: There. The palace is remembering itself. Stay for the blue hour."
  },
  {
    id: "rook",
    name: "Rook",
    role: "night watch",
    x: -410,
    z: -1388,
    yaw: 0.85,
    seed: "palace-reverie-rook",
    hello: "Rook: Stand by a dim lamp and press E. Softly — they scare easy. The pulsing one wants you next.",
    midway: "Rook: Good. Count the lit ones if you like — the rotunda already knows.",
    done: "Rook: Blue hour belongs to you now. Wander the colonnade as long as you like."
  }
] as const;

export type ReveriePhase = "idle" | "active" | "complete";

export function inReverieFootprint(x: number, z: number, pad = 0): boolean {
  // Soft ellipse covering lagoon + both peristyle wings + shore approach.
  const dx = (x - PALACE_LAGOON.x) / (PALACE_LAGOON.radiusX + 70 + pad);
  const dz = (z - PALACE_LAGOON.z) / (PALACE_LAGOON.radiusZ + 55 + pad);
  return dx * dx + dz * dz <= 1;
}
