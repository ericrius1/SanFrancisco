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
  const controller = new SurfController();
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
    pressed: () => false,
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
  const step = () => {
    ctx.time += dt;
    ctx.position.copy(body.position);
    ctx.quaternion.copy(body.quaternion);
    ctx.velocity.copy(body.linear);
    frame.v.linear[0] = body.linear.x;
    frame.v.linear[1] = body.linear.y;
    frame.v.linear[2] = body.linear.z;
    controller.update(ctx, dt, input, frame);
    body.position.addScaledVector(body.linear, dt);
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

  for (let frameIndex = 0; frameIndex < 360 && controller.telemetry.phase === "air"; frameIndex++) step();
  assert.equal(controller.telemetry.phase, "ride", "the explicit jump must land back into the ride");
  assert.equal(controller.telemetry.landingSerial, 1, "the explicit jump must land exactly once");

  console.log(JSON.stringify({
    heldClimb: {
      launches: launchBefore,
      maxPump: Number(maxPump.toFixed(3)),
      maxLipReadiness: Number(maxLipReadiness.toFixed(3)),
      minCrestDistance: Number(minCrestDistance.toFixed(3))
    },
    explicitJump: {
      launches: controller.telemetry.launchSerial,
      landings: controller.telemetry.landingSerial,
      phase: controller.telemetry.phase
    }
  }, null, 2));
} finally {
  await vite.close();
}
