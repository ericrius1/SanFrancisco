/**
 * Local-space collision layout for the wandering ghost ship.
 *
 * Keep this data independent from Three/Box3D so the shape contract can be
 * checked by the lightweight Node probe without pulling the render runtime in.
 */
export type GhostShipColliderKind = "deck" | "guard" | "obstacle" | "stair";
export type GhostShipColliderActivation = "always" | "landed" | "airborne";

export type GhostShipColliderSpec = Readonly<{
  kind: GhostShipColliderKind;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw?: number;
  roll?: number;
  activation?: GhostShipColliderActivation;
}>;

export const GHOST_SHIP_DECK_TOP = 1.37;
export const GHOST_SHIP_STAIR_ZS = [-9.2, 11.5] as const;
export const GHOST_SHIP_STAIR_WIDTH = 3.2;
export const GHOST_SHIP_STAIR_INNER_X = 5.45;
export const GHOST_SHIP_STAIR_OUTER_X = 14.35;
export const GHOST_SHIP_STAIR_BOTTOM_Y = -5;
export const GHOST_SHIP_STAIR_STEPS = 15;

const deckBands = [
  { z: -20, halfWidth: 3.25 },
  { z: -16, halfWidth: 4.55 },
  { z: -12, halfWidth: 5.35 },
  { z: -8, halfWidth: 5.8 },
  { z: -4, halfWidth: 6.05 },
  { z: 0, halfWidth: 6.12 },
  { z: 4, halfWidth: 6.08 },
  { z: 8, halfWidth: 5.95 },
  { z: 12, halfWidth: 5.55 },
  { z: 16, halfWidth: 4.75 },
  { z: 20, halfWidth: 3.1 }
] as const;

const deckColliders: GhostShipColliderSpec[] = deckBands.map(({ z, halfWidth }) => ({
  kind: "deck",
  x: 0,
  y: GHOST_SHIP_DECK_TOP - 0.16,
  z,
  hx: halfWidth,
  hy: 0.16,
  hz: 2.12
}));

export function ghostShipRailXAtZ(side: -1 | 1, z: number): number {
  const t = Math.max(0, Math.min(1, (z + 21) / 42));
  return side * (3.5 + Math.sin(t * Math.PI) * 2.5);
}

export const GHOST_SHIP_RAIL_INTERVALS = (() => {
  const halfGap = GHOST_SHIP_STAIR_WIDTH * 0.55;
  const sorted = [...GHOST_SHIP_STAIR_ZS].sort((a, b) => a - b);
  const intervals: Array<readonly [number, number]> = [];
  let start = -21;
  for (const z of sorted) {
    intervals.push([start, z - halfGap]);
    start = z + halfGap;
  }
  intervals.push([start, 21]);
  return intervals;
})();

function railBox(
  side: -1 | 1,
  z0: number,
  z1: number,
  activation: GhostShipColliderActivation = "always"
): GhostShipColliderSpec {
  const x0 = ghostShipRailXAtZ(side, z0);
  const x1 = ghostShipRailXAtZ(side, z1);
  const dx = x1 - x0;
  const dz = z1 - z0;
  return {
    kind: "guard",
    x: (x0 + x1) * 0.5,
    y: 2.18,
    z: (z0 + z1) * 0.5,
    hx: 0.18,
    hy: 0.81,
    hz: Math.hypot(dx, dz) * 0.5 + 0.08,
    yaw: Math.atan2(dx, dz),
    activation
  };
}

const railColliders: GhostShipColliderSpec[] = [];
for (const side of [-1, 1] as const) {
  for (const [z0, z1] of GHOST_SHIP_RAIL_INTERVALS) {
    const segments = Math.ceil((z1 - z0) / 4);
    for (let i = 0; i < segments; i++) {
      const a = z0 + ((z1 - z0) * i) / segments;
      const b = z0 + ((z1 - z0) * (i + 1)) / segments;
      railColliders.push(railBox(side, a, b));
    }
  }
  // In flight, short gate sections restore the continuous collision rail over
  // the four stair openings. They retract only while the stairs are deployed.
  for (const z of GHOST_SHIP_STAIR_ZS) {
    const halfGap = GHOST_SHIP_STAIR_WIDTH * 0.55;
    railColliders.push(railBox(side, z - halfGap, z + halfGap, "airborne"));
  }
}

// The visible rails stop short of the pointed bow/stern. Close those gaps so a
// standing capsule cannot be swept off the deck during a turn.
railColliders.push(
  { kind: "guard", x: 0, y: 2.18, z: -21.04, hx: 3.62, hy: 0.81, hz: 0.18 },
  { kind: "guard", x: 0, y: 2.18, z: 21.04, hx: 3.62, hy: 0.81, hz: 0.18 }
);

const obstacleColliders: GhostShipColliderSpec[] = [
  // Masts: low, compact collision columns preserve the broad deck routes.
  { kind: "obstacle", x: 0, y: 7.8, z: -6, hx: 0.38, hy: 6.5, hz: 0.38 },
  { kind: "obstacle", x: 0, y: 6.8, z: 8, hx: 0.34, hy: 5.5, hz: 0.34 },
  { kind: "obstacle", x: 0, y: 5.3, z: 18, hx: 0.3, hy: 4, hz: 0.3 },
  // One solid plinth under the hot tub is both cheaper and safer than four
  // floating rim boxes; the visible rim remains the exact visual boundary.
  { kind: "obstacle", x: 0, y: 2.01, z: -13, hx: 3.9, hy: 0.64, hz: 2.65 }
];

const stairColliders: GhostShipColliderSpec[] = [];
const stairDx = GHOST_SHIP_STAIR_OUTER_X - GHOST_SHIP_STAIR_INNER_X;
const stairDy = GHOST_SHIP_DECK_TOP - GHOST_SHIP_STAIR_BOTTOM_Y;
const stairLength = Math.hypot(stairDx, stairDy);
const stairSlope = Math.atan2(stairDy, stairDx);
for (const side of [-1, 1] as const) {
  for (const z of GHOST_SHIP_STAIR_ZS) {
    const x = side * (GHOST_SHIP_STAIR_INNER_X + GHOST_SHIP_STAIR_OUTER_X) * 0.5;
    const y = (GHOST_SHIP_DECK_TOP + GHOST_SHIP_STAIR_BOTTOM_Y) * 0.5;
    const roll = -side * stairSlope;
    stairColliders.push({
      kind: "stair",
      x,
      y: y - 0.08,
      z,
      hx: stairLength * 0.5 + 0.12,
      hy: 0.16,
      hz: GHOST_SHIP_STAIR_WIDTH * 0.5,
      roll,
      activation: "landed"
    });
    for (const edge of [-1, 1] as const) {
      stairColliders.push({
        kind: "guard",
        x,
        y: y + 0.72,
        z: z + edge * GHOST_SHIP_STAIR_WIDTH * 0.5,
        hx: stairLength * 0.5 + 0.12,
        hy: 0.56,
        hz: 0.12,
        roll,
        activation: "landed"
      });
    }
  }
}

export const GHOST_SHIP_COLLIDER_SPECS: readonly GhostShipColliderSpec[] = [
  ...deckColliders,
  ...railColliders,
  ...obstacleColliders,
  ...stairColliders
];

const hullSections = [
  { z: -23.2, halfWidth: 0 },
  { z: -20, halfWidth: 3.25 },
  { z: -16, halfWidth: 4.55 },
  { z: -12, halfWidth: 5.35 },
  { z: -8, halfWidth: 5.8 },
  { z: -4, halfWidth: 6.05 },
  { z: 0, halfWidth: 6.12 },
  { z: 4, halfWidth: 6.08 },
  { z: 8, halfWidth: 5.95 },
  { z: 12, halfWidth: 5.55 },
  { z: 16, halfWidth: 4.75 },
  { z: 20, halfWidth: 3.1 },
  { z: 23.4, halfWidth: 0 }
] as const;

export function ghostShipDeckHalfWidth(z: number): number {
  if (z < hullSections[0].z || z > hullSections[hullSections.length - 1].z) return 0;
  for (let i = 0; i < hullSections.length - 1; i++) {
    const a = hullSections[i];
    const b = hullSections[i + 1];
    if (z > b.z) continue;
    const t = (z - a.z) / (b.z - a.z);
    return a.halfWidth + (b.halfWidth - a.halfWidth) * t;
  }
  return 0;
}

/** A body-centre gate used before applying the ship's frame delta to a walker. */
export function ghostShipLocalPointIsAboard(x: number, y: number, z: number): boolean {
  const halfWidth = ghostShipDeckHalfWidth(z);
  return (
    halfWidth > 0 &&
    Math.abs(x) <= halfWidth + 0.45 &&
    y >= GHOST_SHIP_DECK_TOP + 0.35 &&
    y <= GHOST_SHIP_DECK_TOP + 5.2
  );
}

/** Safe, walkable targets used when leaving any one of the twelve deck seats. */
export const GHOST_SHIP_DECK_EXIT_LOCAL = [
  [-1.7, 2.34, 14.5],
  [1.7, 2.34, 14.5],
  [-2.5, 2.34, 5.5],
  [2.5, 2.34, 5.5],
  [-2.7, 2.34, 0],
  [2.7, 2.34, 0],
  [-2.5, 2.34, -9.2],
  [2.5, 2.34, -9.2],
  [-1.55, 2.34, -18.2],
  [1.55, 2.34, -18.2],
  [-2.15, 2.34, -9.5],
  [2.15, 2.34, -9.5]
] as const;
