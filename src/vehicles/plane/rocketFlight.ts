export type RocketFlightProfile = {
  readonly launchPitch: number;
  readonly launchSpeed: number;
  readonly minimumSpeed: number;
  readonly maximumAltitude: number;
  readonly throttleRate: number;
  readonly throttleResponse: number;
  readonly boostResponse: number;
  readonly boostSpeedMultiplier: number;
  speedLimit(altitude: number): number;
  spaceFactor(altitude: number): number;
  orbitFactor(altitude: number): number;
  stage(altitude: number): RocketFlightTelemetry["stage"];
};

const LIMITS = {
  launchPitch: 1.02,
  launchSpeed: 96,
  minimumSpeed: 48,
  seaLevelMaxSpeed: 285,
  spaceMaxSpeed: 5200,
  throttleRate: 0.55,
  throttleResponse: 0.72,
  boostResponse: 1.45,
  boostSpeedMultiplier: 15,
  atmosphereEdge: 8_000,
  orbitAltitude: 22_000,
  deepSpaceAltitude: 48_000,
  maximumAltitude: 4_000_000
} as const;

export const ROCKET_FLIGHT = LIMITS;

export type RocketFlightTelemetry = {
  active: boolean;
  altitude: number;
  verticalSpeed: number;
  speed: number;
  throttle: number;
  boost: boolean;
  spaceFactor: number;
  orbitFactor: number;
  stage: "launch" | "stratosphere" | "edge" | "orbit" | "deep-space";
};

export function smoothRange(start: number, end: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - start) / Math.max(1e-6, end - start)));
  return t * t * (3 - 2 * t);
}

export function rocketStage(altitude: number): RocketFlightTelemetry["stage"] {
  if (altitude < 3_500) return "launch";
  if (altitude < LIMITS.atmosphereEdge) return "stratosphere";
  if (altitude < LIMITS.orbitAltitude) return "edge";
  if (altitude < LIMITS.deepSpaceAltitude) return "orbit";
  return "deep-space";
}

export function rocketSpeedLimit(altitude: number): number {
  const vacuum = smoothRange(1_500, LIMITS.deepSpaceAltitude, altitude);
  return (
    LIMITS.seaLevelMaxSpeed +
    (LIMITS.spaceMaxSpeed - LIMITS.seaLevelMaxSpeed) * vacuum
  );
}

/** Supplied by Marin's optional chunk only when the launch field hydrates. */
export const MARIN_ROCKET_FLIGHT: RocketFlightProfile = {
  launchPitch: LIMITS.launchPitch,
  launchSpeed: LIMITS.launchSpeed,
  minimumSpeed: LIMITS.minimumSpeed,
  maximumAltitude: LIMITS.maximumAltitude,
  throttleRate: LIMITS.throttleRate,
  throttleResponse: LIMITS.throttleResponse,
  boostResponse: LIMITS.boostResponse,
  boostSpeedMultiplier: LIMITS.boostSpeedMultiplier,
  speedLimit: rocketSpeedLimit,
  spaceFactor: (altitude) => smoothRange(LIMITS.atmosphereEdge * 0.72, LIMITS.orbitAltitude, altitude),
  orbitFactor: (altitude) => smoothRange(LIMITS.orbitAltitude * 0.78, LIMITS.deepSpaceAltitude, altitude),
  stage: rocketStage
};

/**
 * Predicts distance along a clean, full-throttle boosted launch. The compressed
 * solar route uses this same flight profile, keeping its milestone times honest
 * when the pilot holds W + Shift and stays on the locator.
 */
export function expectedBoostedRocketDistance(seconds: number): number {
  if (seconds <= 0) return 0;

  const step = 1 / 30;
  const verticalShare = Math.sin(LIMITS.launchPitch);
  let elapsed = 0;
  let distance = 0;
  let speed = LIMITS.launchSpeed;
  let throttle = 0.58;

  while (elapsed < seconds) {
    const dt = Math.min(step, seconds - elapsed);
    throttle = Math.min(1, throttle + LIMITS.throttleRate * dt);
    const altitude = Math.max(0, distance * verticalShare);
    const limit = rocketSpeedLimit(altitude);
    const targetSpeed = Math.max(
      LIMITS.minimumSpeed,
      limit * (0.28 + throttle * 0.72) * LIMITS.boostSpeedMultiplier
    );
    speed += (targetSpeed - speed) * (1 - Math.exp(-LIMITS.boostResponse * dt));
    distance += speed * dt;
    elapsed += dt;
  }

  return distance;
}
