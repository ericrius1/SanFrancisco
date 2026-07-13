// Pure regression probe for the car's ramp-jump phase latch and airborne PD.
// Run: npm run test:car-jump

import {
  CarJumpState,
  landingImpactStrength,
  smoothstep01,
  stepAirAttitude
} from "../src/vehicles/car/jumpPhysics.ts";

const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

const ATTITUDE = {
  kp: 16,
  kd: 8,
  maxAcceleration: 22,
  yawDamping: 2.5,
  yawAcceleration: 3.5
};

const STATE = {
  takeoffClearance: 0.5,
  takeoffMinVerticalSpeed: 0.75,
  minimumAirTime: 0.18,
  landingClearance: 0.2,
  landingMaxVerticalSpeed: 0.65,
  landingMaxFallSpeed: 8,
  landingConfirmSteps: 2
};

function legacyOscillation() {
  const dt = 1 / 60;
  let angle = (15 * Math.PI) / 180;
  let omega = 0;
  let crossings = 0;
  let sign = Math.sign(angle);
  for (let i = 0; i < 3 / dt; i++) {
    // Exact one-axis equivalent of the removed controller defaults:
    // omega = omega*(1-airDamp*dt) + qError.x*airLevel.
    omega = omega * (1 - dt) - Math.sin(angle / 2) * 5;
    angle += omega * dt;
    const nextSign = Math.sign(angle);
    if (nextSign && nextSign !== sign) {
      crossings++;
      sign = nextSign;
    }
  }
  return crossings;
}

function simulateAttitude(hz, startOmega = 0) {
  const dt = 1 / hz;
  let angle = (15 * Math.PI) / 180;
  let omega = [startOmega, 0, 0];
  let crossings = 0;
  let sign = Math.sign(angle);
  let peak = angle;
  const samples = [];
  for (let i = 0; i < 3 * hz; i++) {
    const time = i * dt;
    const up = [0, Math.cos(angle), Math.sin(angle)];
    const next = [0, 0, 0];
    const assist = smoothstep01((time - 0.1) / 0.22);
    stepAirAttitude(up, [0, 1, 0], omega, 0, assist, dt, ATTITUDE, next);
    omega = next;
    angle += omega[0] * dt;
    peak = Math.max(peak, angle);
    const nextSign = Math.sign(angle);
    if (nextSign && nextSign !== sign) {
      crossings++;
      sign = nextSign;
    }
    if (hz === 60 && i % 15 === 14) {
      samples.push({
        time: Number(((i + 1) * dt).toFixed(2)),
        pitchDeg: Number(((angle * 180) / Math.PI).toFixed(2)),
        angularSpeed: Number(omega[0].toFixed(3))
      });
    }
  }
  return {
    crossings,
    finalDeg: (angle * 180) / Math.PI,
    peakDeg: (peak * 180) / Math.PI,
    samples
  };
}

function verifyPhaseLatch() {
  const jump = new CarJumpState();
  jump.reset(0.4);
  const dt = 1 / 60;
  const transitions = [];
  const step = (supportClearance, verticalSpeed) => {
    const transition = jump.update(
      { supportClearance, verticalSpeed, yaw: 0.4 },
      dt,
      STATE
    );
    if (transition !== "none") transitions.push(transition);
  };

  // Nose still supported on the ramp: high speed alone cannot launch us.
  step(0.15, 4);
  step(0.35, 4);
  // Chassis clears the ride target: one latched takeoff.
  step(0.55, 4);
  // Seam-like clearance changes and the apex cannot reacquire ground.
  for (let i = 0; i < 24; i++) step(i % 2 ? 0.1 : 0.6, i < 12 ? 2 : -0.2);
  assert(jump.airborne, "airborne latch dropped before a confirmed landing");
  step(0.6, -0.2); // clear the last one-frame seam candidate
  // Landing needs two consecutive descending support frames.
  step(0.15, -3);
  assert(jump.airborne, "landing committed on the first support frame");
  step(0.12, -2);
  assert(!jump.airborne, "landing did not commit after confirmed support");
  assert(
    transitions.join(",") === "takeoff,landing",
    `expected one takeoff and one landing, got ${transitions.join(",")}`
  );
  return transitions;
}

function verifyEdgeCases() {
  const dt = 1 / 60;
  const perch = new CarJumpState();
  perch.reset(0);
  // Spawn drops are not armed until the suspension has actually been reached.
  assert(
    perch.update({ supportClearance: 0.8, verticalSpeed: -1, yaw: 0 }, dt, STATE) === "none",
    "elevated spawn drop was misclassified as takeoff"
  );
  // Once armed, a stationary two-metre perch must retain ground controls.
  perch.update({ supportClearance: 0.1, verticalSpeed: 0, yaw: 0 }, dt, STATE);
  assert(
    perch.update({ supportClearance: 2, verticalSpeed: 0, yaw: 0 }, dt, STATE) === "none" &&
      !perch.airborne,
    "stationary perch was misclassified as airborne"
  );

  const impact = new CarJumpState();
  impact.reset(0);
  impact.forceAir(0);
  for (let i = 0; i < 14; i++) {
    impact.update({ supportClearance: 2, verticalSpeed: -4, yaw: 0 }, dt, STATE);
  }
  // Near terrain alone is not support during a high-speed impact. Wait until
  // Box3D has removed most of the downward speed, then confirm two frames.
  for (let i = 0; i < 2; i++) {
    impact.update({ supportClearance: 0.1, verticalSpeed: -40, yaw: 0 }, dt, STATE);
  }
  assert(impact.airborne, "hard descent committed landing before solver response");
  impact.update({ supportClearance: 0.1, verticalSpeed: 0.3, yaw: 0 }, dt, STATE);
  assert(impact.airborne, "landing committed on one post-impact frame");
  impact.update({ supportClearance: 0.1, verticalSpeed: 0.2, yaw: 0 }, dt, STATE);
  assert(!impact.airborne, "confirmed post-impact support did not land");

  // The acceleration cap is an invariant even for an extreme inherited spin
  // and the first tiny non-zero assist after the launch-pose hold.
  const spin = [8, 0, 0];
  const next = [0, 0, 0];
  stepAirAttitude([0, 1, 0], [0, 1, 0], spin, 0, 1e-6, dt, ATTITUDE, next);
  const delta = Math.hypot(next[0] - spin[0], next[1] - spin[1], next[2] - spin[2]);
  assert(
    delta <= ATTITUDE.maxAcceleration * dt + 1e-9,
    `air controller bypassed acceleration cap: delta omega ${delta}`
  );
  return { perchAirborne: perch.airborne, impactAirborne: impact.airborne, maxSpinDelta: delta };
}

function verifyLandingFeedbackScale() {
  const params = {
    minHeight: 0.65,
    maxHeight: 6.5,
    minFallDistance: 0.5,
    maxFallDistance: 6,
    heightWeight: 0.4,
    responseCurve: 0.7
  };
  const tiny = landingImpactStrength(0.4, 0.3, params);
  const medium = landingImpactStrength(3, 2.5, params);
  const high = landingImpactStrength(20, 20, params);
  const moreHeight = landingImpactStrength(4, 2, params);
  const lessHeight = landingImpactStrength(2, 2, params);
  const moreFall = landingImpactStrength(2, 4, params);
  const lessFall = landingImpactStrength(2, 2, params);
  assert(tiny === 0, `sub-threshold landing produced strength ${tiny}`);
  assert(medium > 0 && medium < 1, `medium landing was not inside the response range: ${medium}`);
  assert(high === 1, `large landing did not clamp to one: ${high}`);
  assert(moreHeight > lessHeight, "landing response ignored jump height");
  assert(moreFall > lessFall, "landing response ignored fall distance");
  return { tiny, medium, high, moreHeight, moreFall };
}

const legacyCrossings = legacyOscillation();
const fixed60 = simulateAttitude(60);
const rampKick = simulateAttitude(60, 1);
const rates = [30, 60, 120].map((hz) => ({ hz, ...simulateAttitude(hz) }));
const transitions = verifyPhaseLatch();
const edgeCases = verifyEdgeCases();
const landingFeedback = verifyLandingFeedbackScale();

assert(legacyCrossings >= 8, `legacy reproduction unexpectedly crossed only ${legacyCrossings} times`);
assert(fixed60.crossings <= 1, `new assist oscillated ${fixed60.crossings} times`);
assert(Math.abs(fixed60.finalDeg) < 0.1, `new assist retained ${fixed60.finalDeg.toFixed(2)}° after 3s`);
assert(rampKick.peakDeg > 20, "takeoff hold erased the ramp's natural nose-up kick");
assert(rampKick.crossings <= 1, "ramp-kick recovery oscillated around level");
assert(
  Math.max(...rates.map((r) => r.finalDeg)) - Math.min(...rates.map((r) => r.finalDeg)) < 0.06,
  "attitude result changed materially with integration rate"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      legacyCrossings,
      fixedCrossings: fixed60.crossings,
      phaseTransitions: transitions,
      edgeCases: {
        perchAirborne: edgeCases.perchAirborne,
        impactLanded: !edgeCases.impactAirborne,
        maxSpinDelta: Number(edgeCases.maxSpinDelta.toFixed(8))
      },
      landingFeedback: {
        tiny: landingFeedback.tiny,
        medium: Number(landingFeedback.medium.toFixed(3)),
        high: landingFeedback.high,
        heightSensitive: Number(landingFeedback.moreHeight.toFixed(3)),
        fallSensitive: Number(landingFeedback.moreFall.toFixed(3))
      },
      rampKickPeakDeg: Number(rampKick.peakDeg.toFixed(2)),
      rateFinalPitchDeg: rates.map((r) => ({ hz: r.hz, pitch: Number(r.finalDeg.toFixed(3)) })),
      samples60Hz: fixed60.samples
    },
    null,
    2
  )
);
