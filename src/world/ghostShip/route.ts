import { sanFranciscoCivilNow, type SfCivilTime } from "../solar.ts";

/** Reserved negative presence id for a passenger anchored to the public ship. */
export const GHOST_SHIP_RIDE_ID = -1001;
export const GHOST_SHIP_SEAT_COUNT = 12;
export const GHOST_SHIP_DETAIL_WAKE_DISTANCE = 1800;
/** Stable minimap pin name; position tracks the live wall-clock route. */
export const GHOST_SHIP_LANDMARK_NAME = "Ghost Ship";

export type GhostShipPose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  landed: boolean;
  landingName: string | null;
  localHour: number;
  showerActive: boolean;
};

export type GhostShipLanding = {
  name: string;
  x: number;
  z: number;
  yaw: number;
  startHour: number;
  endHour: number;
};

type RoutePoint = { x: number; z: number; altitude: number };

// A broad citywide loop: Pacific headlands → bridge → north waterfront →
// downtown → Mission hills → Golden Gate Park. It repeats continuously, but
// the civil date offsets the spline so consecutive nights do not look cloned.
const AIR_ROUTE: RoutePoint[] = [
  { x: -5850, z: 900, altitude: 330 },
  { x: -3180, z: -3370, altitude: 470 },
  { x: 520, z: -2750, altitude: 380 },
  { x: 4300, z: -450, altitude: 520 },
  { x: 1450, z: 2860, altitude: 360 },
  { x: -2680, z: 2520, altitude: 410 }
];

/** Guaranteed dry-ground stops spread through the SF civil day. */
const DAILY_LANDINGS: GhostShipLanding[] = [
  {
    name: "Marina Green",
    x: -700,
    z: -2350,
    yaw: 0.4,
    startHour: 8.0,
    endHour: 8.95
  },
  {
    name: "Golden Gate Park polo field",
    x: -5000,
    z: 2500,
    yaw: -0.42,
    startHour: 10.5,
    endHour: 11.45
  },
  {
    name: "Botanical Garden Great Meadow",
    x: -2260,
    z: 2450,
    yaw: 1.1,
    startHour: 13.0,
    endHour: 13.95
  },
  {
    name: "Corona Heights meadow",
    x: 350,
    z: 2700,
    yaw: -0.8,
    startHour: 15.5,
    endHour: 16.45
  },
  {
    name: "Mission Dolores Park",
    x: 1480,
    z: 3120,
    yaw: 0.2,
    startHour: 18.0,
    endHour: 18.95
  },
  {
    name: "Presidio parade ground",
    x: -1680,
    z: -1050,
    yaw: 0.12,
    startHour: 20.75,
    endHour: 21.9
  },
  {
    name: "Fort Mason lawn",
    x: 1180,
    z: -1750,
    yaw: 1.6,
    startHour: 23.1,
    endHour: 23.98
  }
];

const LATE_LANDINGS: GhostShipLanding[] = [
  {
    name: "Golden Gate Park polo field",
    x: -5000,
    z: 2500,
    yaw: -0.42,
    startHour: 2.0,
    endHour: 2.9
  },
  {
    name: "Botanical Garden Great Meadow",
    x: -2260,
    z: 2450,
    yaw: 1.1,
    startHour: 2.0,
    endHour: 2.9
  },
  {
    name: "Presidio parade ground",
    x: -1680,
    z: -1050,
    yaw: 0.12,
    startHour: 2.0,
    endHour: 2.9
  }
];

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function dateSeed(civil: SfCivilTime): number {
  let n = civil.year * 372 + civil.month * 31 + civil.day;
  n ^= n >>> 16;
  n = Math.imul(n, 0x45d9f3b);
  n ^= n >>> 16;
  return n >>> 0;
}

/** Every civil day gets the full daytime roster plus one late-night stop. */
export function ghostShipLandingsForCivilDate(civil: SfCivilTime): GhostShipLanding[] {
  const seed = dateSeed(civil);
  return [...DAILY_LANDINGS, LATE_LANDINGS[seed % LATE_LANDINGS.length]];
}

/** First free one-based deck station, or 0 when the public ship is full. */
export function ghostShipClaimSeat(occupiedSeats: readonly number[]): number {
  const occupied = new Set(occupiedSeats);
  for (let seat = 1; seat <= GHOST_SHIP_SEAT_COUNT; seat++) {
    if (!occupied.has(seat)) return seat;
  }
  return 0;
}

function catmull(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * b +
    (-a + c) * t +
    (2 * a - 5 * b + 4 * c - d) * t2 +
    (-a + 3 * b - 3 * c + d) * t3
  );
}

function airPose(civil: SfCivilTime, hour: number): GhostShipPose {
  const count = AIR_ROUTE.length;
  const offset = (dateSeed(civil) % count) / count;
  const loop = (((hour / 24 + offset) % 1) + 1) % 1;
  const scaled = loop * count;
  const i1 = Math.floor(scaled) % count;
  const t = scaled - Math.floor(scaled);
  const at = (offsetIndex: number) => AIR_ROUTE[(i1 + offsetIndex + count) % count];
  const p0 = at(-1);
  const p1 = at(0);
  const p2 = at(1);
  const p3 = at(2);
  const x = catmull(p0.x, p1.x, p2.x, p3.x, t);
  const z = catmull(p0.z, p1.z, p2.z, p3.z, t);
  const altitude = catmull(p0.altitude, p1.altitude, p2.altitude, p3.altitude, t);
  const aheadT = Math.min(1, t + 0.002);
  const aheadX = catmull(p0.x, p1.x, p2.x, p3.x, aheadT);
  const aheadZ = catmull(p0.z, p1.z, p2.z, p3.z, aheadT);
  const dx = aheadX - x;
  const dz = aheadZ - z;
  const seconds = hour * 3600;
  const night = hour >= 19 || hour < 5.2;

  return {
    x,
    y: altitude + Math.sin(seconds * 0.0021) * 12,
    z,
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.sin(seconds * 0.0013) * 0.018,
    roll: Math.sin(seconds * 0.0017 + 1.4) * 0.042,
    landed: false,
    landingName: null,
    localHour: hour,
    // A short, deterministic shower about every seven minutes after dark.
    showerActive: night && seconds % 420 < 38
  };
}

function shortestAngle(from: number, to: number): number {
  return ((((to - from) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

function applyLanding(
  civil: SfCivilTime,
  landing: GhostShipLanding,
  groundHeight: (x: number, z: number) => number
): GhostShipPose {
  const duration = landing.endHour - landing.startHour;
  const progress = clamp01((civil.hour - landing.startHour) / duration);
  // Spend most of each window on the ground so the ship is catchable.
  const descentEnd = 0.18;
  const ascentStart = 0.82;
  const landingY = groundHeight(landing.x, landing.z) + 5.2;

  if (progress < descentEnd) {
    const air = airPose(civil, landing.startHour);
    const t = smooth(progress / descentEnd);
    return {
      ...air,
      x: lerp(air.x, landing.x, t),
      y: lerp(air.y, landingY, t),
      z: lerp(air.z, landing.z, t),
      yaw: air.yaw + shortestAngle(air.yaw, landing.yaw) * t,
      pitch: air.pitch * (1 - t),
      roll: air.roll * (1 - t),
      landingName: landing.name,
      localHour: civil.hour
    };
  }

  if (progress <= ascentStart) {
    return {
      x: landing.x,
      y: landingY,
      z: landing.z,
      yaw: landing.yaw,
      pitch: 0,
      roll: 0,
      landed: true,
      landingName: landing.name,
      localHour: civil.hour,
      showerActive: false
    };
  }

  const air = airPose(civil, landing.endHour);
  const t = smooth((progress - ascentStart) / (1 - ascentStart));
  return {
    ...air,
    x: lerp(landing.x, air.x, t),
    y: lerp(landingY, air.y, t),
    z: lerp(landing.z, air.z, t),
    yaw: landing.yaw + shortestAngle(landing.yaw, air.yaw) * t,
    pitch: air.pitch * t,
    roll: air.roll * t,
    landingName: landing.name,
    localHour: civil.hour
  };
}

/** Shared, wall-clock route. Local sky scrubbing cannot desynchronize riders. */
export function ghostShipPoseAt(
  epochMs: number,
  groundHeight: (x: number, z: number) => number
): GhostShipPose {
  const civil = sanFranciscoCivilNow(new Date(epochMs));
  return ghostShipPoseForCivil(civil, groundHeight);
}

/** Civil-time form used by the per-frame proxy after its once-a-minute clock sync. */
export function ghostShipPoseForCivil(
  civil: SfCivilTime,
  groundHeight: (x: number, z: number) => number
): GhostShipPose {
  for (const landing of ghostShipLandingsForCivilDate(civil)) {
    if (civil.hour >= landing.startHour && civil.hour <= landing.endHour) {
      return applyLanding(civil, landing, groundHeight);
    }
  }
  return airPose(civil, civil.hour);
}
