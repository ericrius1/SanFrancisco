export type HangGliderIntent = Readonly<{
  roll: number;
  pitch: number;
  tuck: boolean;
  flare: boolean;
}>;

export type HangGliderFlightState = {
  heading: number;
  pitch: number;
  bank: number;
  airspeed: number;
};

export type HangGliderFlightStep = Readonly<{
  horizontalSpeed: number;
  verticalSpeed: number;
  sinkRate: number;
  thermalLift: number;
  stalled: boolean;
}>;

export type HangGliderFlightProfile = Readonly<{
  launchSpeed: number;
  baseSink: number;
  step: (
    state: HangGliderFlightState,
    intent: HangGliderIntent,
    dt: number,
    thermalLift: number
  ) => HangGliderFlightStep;
}>;

export const HANG_GLIDER_FLIGHT = {
  launchSpeed: 22,
  bestGlideSpeed: 21,
  stallSpeed: 13.5,
  minSpeed: 9,
  maxSpeed: 42,
  maxBank: 0.88,
  maxPitchUp: 0.3,
  maxPitchDown: -0.42,
  bankResponse: 3.7,
  pitchResponse: 3.2,
  turnRate: 0.92,
  speedResponse: 0.72,
  baseSink: 0.78,
  pitchLiftScale: 0.2
} as const;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const approachExp = (value: number, target: number, rate: number, dt: number): number =>
  value + (target - value) * (1 - Math.exp(-Math.max(0, dt) * rate));

/**
 * Deterministic arcade aerodynamics shared by the live controller and the
 * contract probe. It is deliberately a polar, not powered-flight math: speed
 * comes from lowering the nose, bank costs altitude, a flare trades speed for
 * a soft touchdown, and rising air is the only sustained source of height.
 */
export function stepHangGliderFlight(
  state: HangGliderFlightState,
  intent: HangGliderIntent,
  dt: number,
  thermalLift: number
): HangGliderFlightStep {
  const cfg = HANG_GLIDER_FLIGHT;
  const roll = clamp(intent.roll, -1, 1);
  const pitch = clamp(intent.pitch, -1, 1);
  const targetBank = roll * cfg.maxBank;
  const targetPitch = clamp(
    pitch * 0.27 - (intent.tuck ? 0.2 : 0) + (intent.flare ? 0.23 : 0),
    cfg.maxPitchDown,
    cfg.maxPitchUp
  );

  state.bank = approachExp(state.bank, targetBank, cfg.bankResponse, dt);
  state.pitch = approachExp(state.pitch, targetPitch, cfg.pitchResponse, dt);

  // In this world frame increasing yaw turns toward local left, so a positive
  // right bank subtracts heading. Extra speed makes the same weight shift carve
  // a little wider, matching the relaxed Pilotwings-style cadence.
  const speedTurn = clamp(cfg.bestGlideSpeed / Math.max(8, state.airspeed), 0.62, 1.28);
  state.heading -= Math.sin(state.bank) * cfg.turnRate * speedTurn * dt;

  const targetSpeed = clamp(
    cfg.bestGlideSpeed - state.pitch * 35 + (intent.tuck ? 7 : 0) - (intent.flare ? 5.5 : 0),
    cfg.minSpeed,
    cfg.maxSpeed
  );
  state.airspeed = approachExp(state.airspeed, targetSpeed, cfg.speedResponse, dt);

  const slow = Math.max(0, (cfg.bestGlideSpeed - state.airspeed) / cfg.bestGlideSpeed);
  const fast = Math.max(0, (state.airspeed - cfg.bestGlideSpeed) / cfg.bestGlideSpeed);
  const bankLoad = 1 / Math.max(0.52, Math.cos(state.bank));
  const stalled = state.airspeed < cfg.stallSpeed;
  const sinkRate =
    cfg.baseSink +
    slow * slow * 7.2 +
    fast * fast * 2.1 +
    (bankLoad - 1) * 2.6 +
    (stalled ? (cfg.stallSpeed - state.airspeed) * 0.72 + 2.2 : 0) +
    (intent.flare ? 0.28 : 0);

  // A pitch-up exchanges stored speed for a brief climb. Because target speed
  // then falls and the polar steepens, holding the bar back becomes a stall —
  // it never creates free altitude.
  const pitchLift = Math.sin(state.pitch) * state.airspeed * cfg.pitchLiftScale;
  const verticalSpeed = thermalLift + pitchLift - sinkRate;
  return {
    horizontalSpeed: Math.cos(state.pitch) * state.airspeed,
    verticalSpeed,
    sinkRate,
    thermalLift,
    stalled
  };
}

/** Injected into the persistent plane controller only when Skyline Glide is
 * activated, keeping this solver out of the clean-boot module graph. */
export const HANG_GLIDER_PROFILE: HangGliderFlightProfile = {
  launchSpeed: HANG_GLIDER_FLIGHT.launchSpeed,
  baseSink: HANG_GLIDER_FLIGHT.baseSink,
  step: stepHangGliderFlight
};
