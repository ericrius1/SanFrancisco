/** USA Pickleball regulation dimensions, expressed in metres. */
export const PICKLEBALL_COURT = Object.freeze({
  width: 6.096, // 20 ft
  length: 13.4112, // 44 ft
  halfWidth: 3.048,
  halfLength: 6.7056,
  nonVolleyLine: 2.1336, // 7 ft from the net
  lineWidth: 0.0508, // 2 in
  netCentreHeight: 0.8636, // 34 in
  netSidelineHeight: 0.9144, // 36 in
  netPostX: 3.3528, // 22 ft post-to-post
  // Current USA Pickleball minimum playing surface: 30 x 60 ft. The painted
  // court stays 20 x 44 ft inside this runoff apron.
  apronWidth: 9.144,
  apronLength: 18.288,
  ballRadius: 0.037,
  paddleRadius: 0.215,
  paddleThickness: 0.018
});

export const PICKLEBALL_TUNING = Object.freeze({
  fixedStep: 1 / 120,
  maxFrameDelta: 0.1,
  gravity: 9.81,
  airDrag: 0.0062,
  magnus: 0.00042,
  groundRestitution: 0.72,
  groundGrip: 0.91,
  netRestitution: 0.18,
  netGrip: 0.72,
  maxBallSpeed: 19.5,
  playerSpeed: 3.5,
  playerSprintSpeed: 4.5,
  aiSpeed: 3.25,
  playerAcceleration: 15,
  interactionRadius: 2.35,
  swingDuration: 0.44,
  swingContactStart: 0.14,
  swingContactEnd: 0.29,
  swingCooldown: 0.38,
  serveDelay: 1.15,
  pointDelay: 1.65,
  gameResetDelay: 4.25
});
