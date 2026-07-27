import { tunables } from "../../core/persist";

export const BIRD_TUNING = tunables("movement.bird", {
  maxSpeed: { v: 34, min: 5, max: 100, step: 1, label: "max speed" },
  tuckMax: { v: 110, min: 30, max: 250, step: 1, label: "tuck max" },
  strafeFactor: { v: 0.85, min: 0.2, max: 1, step: 0.05, label: "strafe ×" },
  response: { v: 2.2, min: 0.5, max: 10, step: 0.1, label: "response" },
  yawFollow: { v: 5.5, min: 0.5, max: 15, step: 0.5, label: "yaw follow" },
  flapClimb: { v: 9, min: 2, max: 30, step: 0.5, label: "flap climb" },
  sink: { v: 1.8, min: 0, max: 10, step: 0.2, label: "idle sink" },
  // A creature with this span should read as heavy, so this is the cadence of
  // a full power/recovery stroke rather than a small-bird flutter rate. Effort
  // and airspeed scale it from here (see wingbeat.ts).
  flapHz: { v: 1.35, min: 0.45, max: 4, step: 0.05, label: "flap rate" },
  // Wingtip travel either side of the rest silhouette, in radians, at full
  // stroke. The gather is the shallower half and the power stroke drives
  // further — a wing that swings evenly about level reads as waving. The
  // gather is capped where a hard-climb beat would otherwise carry the two
  // tips together over the phoenix's back and scissor the feather fans.
  strokeUp: { v: 1.1, min: 0.3, max: 2.4, step: 0.05, label: "stroke up" },
  strokeDown: { v: 1.7, min: 0.3, max: 2.6, step: 0.05, label: "stroke down" },
  bankPerSpeed: { v: 0.045, min: 0, max: 0.15, step: 0.005, label: "bank/speed" },
  maxBank: { v: 0.85, min: 0, max: 1.4, step: 0.05, label: "max bank" },
  twirlRate: { v: 6.5, min: 2, max: 14, step: 0.5, label: "twirl rate" }
});
