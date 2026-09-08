// Deterministic surf-control regression coverage with a tiny velocity-integrating
// physics facade. W may climb/pump along the wave but must never synthesize a
// jump; only the explicit jump request may transition the controller to air.

import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createServer } from "vite";

globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const vite = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  root: process.cwd(),
  server: { middlewareMode: true }
});

try {
  const { SurfController } = await vite.ssrLoadModule("/src/vehicles/surf/controller.ts");
  const { SurfCameraController } = await vite.ssrLoadModule("/src/vehicles/surf/camera.ts");
  const controller = new SurfController();
  const camera = new THREE.PerspectiveCamera(62, 1.6, 0.1, 1000);
  const rig = new SurfCameraController(62);
  const pose = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3()
  };
  const body = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    linear: new THREE.Vector3()
  };
  const world = {
    createBox({ position }) {
      body.position.fromArray(position);
      return 1;
    },
    setBodyGravityScale() {},
    setBodyTransform(_handle, position, quaternion) {
      body.position.fromArray(position);
      body.quaternion.fromArray(quaternion);
    },
    setBodyVelocity(_handle, linear) {
      body.linear.fromArray(linear);
    }
  };
  const ctx = {
    physics: { world },
    map: {},
    body: 0,
    position: pose.position,
    quaternion: pose.quaternion,
    velocity: pose.velocity,
    speed: 0,
    heading: 0,
    time: 0,
    indoor: false,
    raking: false,
    driveSpec: {}
  };
  const held = new Set();
  const input = {
    suspended: false,
    surfDX: 0,
    surfDY: 0,
    pressed: (code) => code === "KeyX",
    axis(negative, positive) {
      return (held.has(positive) ? 1 : 0) - (held.has(negative) ? 1 : 0);
    }
  };
  const dt = 1 / 60;
  const frame = {
    camYaw: 0,
    aim: new THREE.Vector3(0, 0, -1),
    v: { linear: [0, 0, 0], angular: [0, 0, 0] }
  };
  let touchdownDrop = 0;
  let maxAlongAcceleration = 0;
  const step = (steer = true) => {
    if (steer) controller.steerSurf(input, dt);
    const beforeY = body.position.y;
    const beforeVz = body.linear.z;
    const beforeLanding = controller.telemetry.landingSerial;
    ctx.time += dt;
    ctx.position.copy(body.position);
    ctx.quaternion.copy(body.quaternion);
    ctx.velocity.copy(body.linear);
    frame.v.linear[0] = body.linear.x;
    frame.v.linear[1] = body.linear.y;
    frame.v.linear[2] = body.linear.z;
    controller.update(ctx, dt, input, frame);
    body.position.addScaledVector(body.linear, dt);
    assert.equal(controller.telemetry.riderMotionRate, 1, "every step runs at real time, including X and big airs");
    assert.ok(controller.telemetry.hullClearance >= -0.001, "the board stays above the wave");
    if (controller.telemetry.landingSerial > beforeLanding) touchdownDrop = Math.max(touchdownDrop, beforeY - body.position.y);
    maxAlongAcceleration = Math.max(maxAlongAcceleration, Math.abs(body.linear.z - beforeVz) / dt);
    rig.update(dt, camera, { renderPosition: body.position, surfTelemetry: controller.telemetry, time: ctx.time });
  };

  ctx.position.set(-5923, 2.5, 3370);
  controller.enter(ctx);
  controller.spawnBody(ctx, 0);

  held.add("KeyW");
  let minCrestDistance = controller.telemetry.crestDistance;
  let maxPump = 0;
  let maxLipReadiness = 0;
  for (let frameIndex = 0; frameIndex < 900; frameIndex++) {
    step();
    minCrestDistance = Math.min(minCrestDistance, controller.telemetry.crestDistance);
    maxPump = Math.max(maxPump, controller.telemetry.pump);
    maxLipReadiness = Math.max(maxLipReadiness, controller.telemetry.lipReadiness);
  }
  held.delete("KeyW");

  assert.ok(maxPump > 0.8, "W must still drive the climb/pump control");
  assert.equal(
    controller.telemetry.launchSerial,
    0,
    "holding W must not auto-jump off the wave"
  );
  assert.equal(controller.telemetry.phase, "ride", "held climb must remain a supported ride");

  controller.requestJump();
  const launchBefore = controller.telemetry.launchSerial;
  for (let frameIndex = 0; frameIndex < 30 && controller.telemetry.phase !== "air"; frameIndex++) step();
  assert.equal(
    controller.telemetry.launchSerial,
    launchBefore + 1,
    "an explicit jump request must launch exactly once"
  );
  assert.equal(controller.telemetry.phase, "air", "explicit jump must enter the air phase");

  const launchBoom = rig.diagnostics().followYaw;
  let maxAirCameraTurn = 0;
  held.add("KeyD");
  for (let frameIndex = 0; frameIndex < 360 && controller.telemetry.phase === "air"; frameIndex++) {
    step();
    if (controller.telemetry.airborne) maxAirCameraTurn = Math.max(maxAirCameraTurn, Math.abs(rig.diagnostics().followYaw - launchBoom));
  }
  held.clear();
  assert.ok(Math.abs(controller.telemetry.landedSpin) > Math.PI * 1.8, "a high keyboard air supports a full rotation at normal speed");
  assert.ok(maxAirCameraTurn < 0.12, `the camera follows the flight, not the spin (${maxAirCameraTurn})`);
  assert.ok(touchdownDrop < 0.6, `touchdown must not snap down metres early (${touchdownDrop})`);
  maxAlongAcceleration = 0;
  for (let i = 0; i < 60; i++) step();
  assert.ok(maxAlongAcceleration < 200, `switch landing eases travel velocity (${maxAlongAcceleration})`);
  assert.equal(controller.telemetry.phase, "ride", "the explicit jump must land back into the ride");
  assert.equal(controller.telemetry.landingSerial, 1, "the explicit jump must land exactly once");

  const jumpFeel = { touchdownDrop, maxAirCameraTurn, maxAlongAcceleration, landedSpinDegrees: controller.telemetry.landedSpin * 180 / Math.PI };
  const frameRateYaw = [];
  for (const hz of [30, 60, 120]) {
    held.clear();
    input.suspended = false;
    ctx.time = 0;
    ctx.position.set(-5923, 2.5, 3370);
    controller.enter(ctx);
    controller.spawnBody(ctx, 0);
    rig.reset();
    for (let i = 0; i < 60; i++) step();
    held.add("KeyD");
    let accumulator = 0;
    for (let i = 0; i < hz * 2; i++) {
      controller.steerSurf(input, 1 / hz);
      accumulator += 1 / hz;
      while (accumulator >= dt - 1e-8) {
        step(false);
        accumulator -= dt;
      }
    }
    held.clear();
    for (let i = 0; i < 12; i++) step();
    frameRateYaw.push({ hz, yaw: controller.yaw });
  }
  const yawSpread = Math.max(...frameRateYaw.map(x => x.yaw)) - Math.min(...frameRateYaw.map(x => x.yaw));
  assert.ok(yawSpread < 0.06, `30/60/120 Hz input must produce the same turn (${yawSpread})`);
  // Ride the full length of the curved beach, including northern offshore
  // pockets that sit west of the old constant minX boundary.
  held.clear();
  ctx.time = 0;
  ctx.position.set(-5923, 2.5, 3370);
  controller.enter(ctx);
  controller.spawnBody(ctx, 0);
  const { oceanBeachOffshoreX, oceanBeachApproxShoreX } = await vite.ssrLoadModule("/src/world/oceanBeachWaves.ts");
  let minNorthZ = ctx.position.z;
  let resetFrames = 0;
  for (let i = 0; i < 60 * 210; i++) {
    const previousWave = controller.telemetry.waveSerial;
    step();
    minNorthZ = Math.min(minNorthZ, ctx.position.z);
    if (controller.telemetry.waveSerial > previousWave) resetFrames++;
    assert.ok(ctx.position.x > oceanBeachOffshoreX(ctx.position.z) + 16, "wave resets stay inside the curved offshore boundary");
    assert.ok(ctx.position.x < oceanBeachApproxShoreX(ctx.position.z) - 60, "endless ride stays offshore of the beach");
    assert.ok(controller.telemetry.inBreak, "long rides never lose the authored wave");
  }
  assert.ok(minNorthZ < 1450, "endurance reaches the north end and its changing shoreline");
  assert.ok(resetFrames < 35, `wave changes must not cascade every frame (${resetFrames})`);
  console.log(JSON.stringify({ enduranceSeconds: 210, minNorthZ, resetFrames }));

  // Hold a turn across automatic wave changes: the new pocket must keep the
  // same heading, and a jump queued on the handoff frame must still launch.
  ctx.time = 0;
  ctx.position.set(-5923, 2.5, 3370);
  controller.enter(ctx);
  controller.spawnBody(ctx, 0);
  held.add("KeyD");
  let turningHandoffs = 0;
  for (let i = 0; i < 1800; i++) {
    const previousWave = controller.telemetry.waveSerial;
    const previousYaw = controller.yaw;
    step();
    if (controller.telemetry.waveSerial > previousWave) {
      turningHandoffs++;
      const delta = Math.atan2(Math.sin(controller.yaw - previousYaw), Math.cos(controller.yaw - previousYaw));
      assert.ok(Math.abs(delta) < 0.08, `a wave change must not reset an ongoing turn (${delta})`);
    }
  }
  assert.ok(turningHandoffs > 0, "turn regression crosses a wave handoff");
  held.clear();
  const handoffLaunchBefore = controller.telemetry.launchSerial;
  body.position.x = oceanBeachApproxShoreX(body.position.z) - 95;
  controller.requestJump();
  step();
  assert.equal(controller.telemetry.launchSerial, handoffLaunchBefore + 1, "a wave change preserves the queued jump");
  console.log(JSON.stringify({ turningHandoffs, queuedJumpLaunched: true }));

  console.log(JSON.stringify({ frameRateYaw, yawSpread }));

  console.log(JSON.stringify({
    heldClimb: {
      launches: launchBefore,
      maxPump: Number(maxPump.toFixed(3)),
      maxLipReadiness: Number(maxLipReadiness.toFixed(3)),
      minCrestDistance: Number(minCrestDistance.toFixed(3))
    },
    feel: jumpFeel,
    explicitJump: { launched: true, landed: true }
  }, null, 2));
} finally {
  await vite.close();
}
