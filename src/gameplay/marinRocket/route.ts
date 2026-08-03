import { expectedBoostedRocketDistance } from "../../vehicles/plane/rocketFlight";

export type CelestialId =
  | "earth"
  | "moon"
  | "mars"
  | "venus"
  | "mercury"
  | "sun"
  | "jupiter"
  | "saturn"
  | "uranus"
  | "neptune";

export type CelestialRouteStop = {
  id: CelestialId;
  label: string;
  atlasColumn: number;
  atlasRow: number;
  plannedSeconds: number;
  routeDistance: number;
  yawOffset: number;
  pitchOffset: number;
  displaySize: number;
  encounterRadius: number;
  home?: boolean;
};

type AuthoredStop = Omit<CelestialRouteStop, "routeDistance">;

// The order makes a readable compressed grand tour rather than pretending to
// preserve real astronomical scale. These are full-throttle Shift-boost times;
// normal drive retains the earlier, slower tour pacing.
const AUTHORED_ROUTE: readonly AuthoredStop[] = [
  { id: "earth", label: "Earth", atlasColumn: 4, atlasRow: 0, plannedSeconds: 0, yawOffset: 0, pitchOffset: 0, displaySize: 80_000, encounterRadius: 40_000, home: true },
  { id: "moon", label: "Moon", atlasColumn: 0, atlasRow: 0, plannedSeconds: 9.75, yawOffset: 0, pitchOffset: 0, displaySize: 24_000, encounterRadius: 18_000 },
  { id: "mars", label: "Mars", atlasColumn: 0, atlasRow: 1, plannedSeconds: 14, yawOffset: -0.22, pitchOffset: -0.1, displaySize: 21_000, encounterRadius: 18_000 },
  { id: "venus", label: "Venus", atlasColumn: 3, atlasRow: 0, plannedSeconds: 18, yawOffset: 0.24, pitchOffset: -0.16, displaySize: 27_000, encounterRadius: 21_000 },
  { id: "mercury", label: "Mercury", atlasColumn: 2, atlasRow: 0, plannedSeconds: 21, yawOffset: 0.12, pitchOffset: 0.18, displaySize: 17_000, encounterRadius: 15_000 },
  { id: "sun", label: "Sun", atlasColumn: 1, atlasRow: 0, plannedSeconds: 25, yawOffset: -0.12, pitchOffset: 0.12, displaySize: 115_000, encounterRadius: 57_000 },
  { id: "jupiter", label: "Jupiter", atlasColumn: 1, atlasRow: 1, plannedSeconds: 31, yawOffset: -0.27, pitchOffset: -0.24, displaySize: 72_000, encounterRadius: 42_000 },
  { id: "saturn", label: "Saturn", atlasColumn: 2, atlasRow: 1, plannedSeconds: 38, yawOffset: 0.28, pitchOffset: -0.18, displaySize: 104_000, encounterRadius: 55_000 },
  { id: "uranus", label: "Uranus", atlasColumn: 3, atlasRow: 1, plannedSeconds: 44, yawOffset: -0.24, pitchOffset: 0.15, displaySize: 41_000, encounterRadius: 30_000 },
  { id: "neptune", label: "Neptune", atlasColumn: 4, atlasRow: 1, plannedSeconds: 50, yawOffset: 0.26, pitchOffset: 0.04, displaySize: 44_000, encounterRadius: 32_000 }
];

export const CELESTIAL_ROUTE: readonly CelestialRouteStop[] = AUTHORED_ROUTE.map((stop) => ({
  ...stop,
  // Earth sits behind and to the side of the launch line as a homeward view.
  // Destinations place their near encounter edge—not their centre—on the
  // schedule, so a clean boosted flight announces arrival at the headline time.
  routeDistance: stop.home
    ? -42_000
    : expectedBoostedRocketDistance(stop.plannedSeconds) +
      stop.encounterRadius
}));

export const CELESTIAL_TARGETS = CELESTIAL_ROUTE.filter((stop) => !stop.home);

export function formatMissionTime(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
