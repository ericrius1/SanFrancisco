/**
 * Marin Headlands tunnel alignments in world metres.
 *
 * The endpoints are converted from the current OSM centre-lines:
 * - Baker–Barry / Bunker Road tunnel, way 23781511
 * - Robin Williams / Waldo tunnel pair, ways 27092098 + 513534048
 *
 * Keep this module free of Three.js so probes can validate the geographic
 * contract without constructing render state.
 */

export type MarinXZ = Readonly<{ x: number; z: number }>;

export type MarinTunnelBore = Readonly<{
  offset: number;
  halfWidth: number;
}>;

export type MarinTunnelSpec = Readonly<{
  id: "baker-barry" | "robin-williams";
  label: string;
  start: MarinXZ;
  end: MarinXZ;
  roadWidth: number;
  wallHeight: number;
  archRadius: number;
  cutoutHalfWidth: number;
  approachLength: number;
  bores: readonly MarinTunnelBore[];
  rainbowPortal?: "start" | "end";
  trafficSignals?: boolean;
}>;

export const MARIN_HEADLANDS_TUNNELS_CENTER = {
  x: -3976,
  z: -5810
} as const;

/** The historic single reversible-lane tunnel between Forts Baker and Barry. */
export const BAKER_BARRY_TUNNEL: MarinTunnelSpec = {
  id: "baker-barry",
  label: "Baker–Barry Tunnel",
  start: { x: -4332.4256, z: -5734.4008 },
  end: { x: -3685.7965, z: -5419.7736 },
  roadWidth: 7.2,
  wallHeight: 2.25,
  archRadius: 3.35,
  cutoutHalfWidth: 28,
  approachLength: 80,
  bores: [{ offset: 0, halfWidth: 3.35 }],
  trafficSignals: true
};

/**
 * The two US-101 bores above the Golden Gate approach. The centre-line uses
 * the mean of the northbound and southbound OSM ways so both portals share one
 * replacement-terrain footprint while retaining distinct openings.
 */
export const ROBIN_WILLIAMS_TUNNEL: MarinTunnelSpec = {
  id: "robin-williams",
  label: "Robin Williams Tunnel",
  start: { x: -3671.9, z: -5884.9 },
  end: { x: -3737.2, z: -6184.8 },
  roadWidth: 27.2,
  wallHeight: 3.4,
  archRadius: 6.15,
  cutoutHalfWidth: 34,
  approachLength: 82,
  bores: [
    { offset: -6.9, halfWidth: 5.9 },
    { offset: 6.9, halfWidth: 5.9 }
  ],
  rainbowPortal: "start"
};

export const MARIN_TUNNELS = [
  BAKER_BARRY_TUNNEL,
  ROBIN_WILLIAMS_TUNNEL
] as const;

export type TunnelFrame = Readonly<{
  centerX: number;
  centerZ: number;
  length: number;
  yaw: number;
  axisX: number;
  axisZ: number;
  rightX: number;
  rightZ: number;
}>;

export function tunnelFrame(spec: MarinTunnelSpec): TunnelFrame {
  const dx = spec.end.x - spec.start.x;
  const dz = spec.end.z - spec.start.z;
  const length = Math.hypot(dx, dz);
  const axisX = dx / length;
  const axisZ = dz / length;
  return {
    centerX: (spec.start.x + spec.end.x) * 0.5,
    centerZ: (spec.start.z + spec.end.z) * 0.5,
    length,
    yaw: Math.atan2(axisX, axisZ),
    axisX,
    axisZ,
    rightX: axisZ,
    rightZ: -axisX
  };
}

export function tunnelLocalPoint(
  frame: TunnelFrame,
  worldX: number,
  worldZ: number
): { lateral: number; along: number } {
  const dx = worldX - frame.centerX;
  const dz = worldZ - frame.centerZ;
  return {
    lateral: dx * frame.rightX + dz * frame.rightZ,
    along: dx * frame.axisX + dz * frame.axisZ
  };
}

export function tunnelWorldPoint(
  frame: TunnelFrame,
  lateral: number,
  along: number
): MarinXZ {
  return {
    x: frame.centerX + frame.rightX * lateral + frame.axisX * along,
    z: frame.centerZ + frame.rightZ * lateral + frame.axisZ * along
  };
}

export function tunnelGrade(
  startY: number,
  endY: number,
  frame: TunnelFrame,
  along: number
): number {
  const t = Math.max(0, Math.min(1, along / frame.length + 0.5));
  return startY + (endY - startY) * t;
}
