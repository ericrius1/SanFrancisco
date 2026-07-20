import type { WorldMap } from "../../world/heightmap";
import { HANG_GLIDING_SITE } from "./meta.ts";

export type HangGlidingGate = Readonly<{
  x: number;
  y: number;
  z: number;
  radius: number;
}>;

export type HangGlidingThermal = Readonly<{
  x: number;
  z: number;
  radius: number;
  strength: number;
  baseY: number;
  topY: number;
}>;

export type HangGlidingCourse = Readonly<{
  access: Readonly<{ x: number; y: number; z: number; heading: number }>;
  launch: Readonly<{ x: number; y: number; z: number; heading: number }>;
  deck: Readonly<{ x: number; y: number; z: number; hx: number; hy: number; hz: number }>;
  gates: readonly HangGlidingGate[];
  thermals: readonly HangGlidingThermal[];
  landing: Readonly<{ x: number; y: number; z: number; radius: number; heading: number }>;
}>;

const GATE_XZ = [
  [-1110, 3710],
  [-1550, 3470],
  [-2020, 3200],
  [-2520, 2920],
  [-3020, 2660]
] as const;

/**
 * A westbound 2.7 km glide from Sutro's upper service deck into Golden Gate
 * Park. All heights are resolved from the live map, so streamed terrain and
 * the legacy full-map path produce the same generous, readable gate corridor.
 */
export function createHangGlidingCourse(map: WorldMap): HangGlidingCourse {
  const towerGround = map.groundHeight(HANG_GLIDING_SITE.x, HANG_GLIDING_SITE.z);
  const deckY = towerGround + 252.3;
  const launchY = deckY + 1.45;
  const landingX = -3460;
  const landingZ = 2450;
  const landingGround = map.effectiveGround(landingX, landingZ);
  const drops = [42, 94, 151, 216, 286] as const;
  const clearances = [105, 92, 78, 63, 48] as const;
  const gates = GATE_XZ.map(([x, z], index) => ({
    x,
    z,
    y: Math.max(map.effectiveGround(x, z) + clearances[index], launchY - drops[index]),
    radius: index === 0 ? 23 : 21
  }));

  const thermals = [
    { x: -1390, z: 3550, radius: 145, strength: 5.6 },
    { x: -2350, z: 3020, radius: 155, strength: 6.2 }
  ].map((thermal) => {
    const baseY = map.effectiveGround(thermal.x, thermal.z) + 8;
    return { ...thermal, baseY, topY: baseY + 230 };
  });

  return {
    access: {
      x: HANG_GLIDING_SITE.x + 62,
      y: map.effectiveGround(HANG_GLIDING_SITE.x + 62, HANG_GLIDING_SITE.z),
      z: HANG_GLIDING_SITE.z,
      heading: Math.PI / 2
    },
    deck: {
      x: HANG_GLIDING_SITE.x - 25,
      y: deckY,
      z: HANG_GLIDING_SITE.z,
      hx: 17,
      hy: 0.28,
      hz: 5.4
    },
    launch: {
      x: HANG_GLIDING_SITE.x - 38,
      y: launchY,
      z: HANG_GLIDING_SITE.z,
      heading: Math.PI / 2
    },
    gates,
    thermals,
    landing: {
      x: landingX,
      y: landingGround + 0.12,
      z: landingZ,
      radius: 34,
      heading: Math.PI / 2
    }
  };
}

export function sampleHangGlidingLift(
  thermals: readonly HangGlidingThermal[],
  x: number,
  z: number,
  time: number
): number {
  let lift = 0;
  for (let i = 0; i < thermals.length; i++) {
    const thermal = thermals[i];
    const distance = Math.hypot(x - thermal.x, z - thermal.z);
    if (distance >= thermal.radius) continue;
    const core = 1 - distance / thermal.radius;
    const pulse = 0.88 + Math.sin(time * 0.72 + i * 2.1) * 0.12;
    lift += thermal.strength * core * core * pulse;
  }
  return lift;
}
