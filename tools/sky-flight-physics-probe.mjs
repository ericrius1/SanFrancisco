import assert from "node:assert/strict";
import { createServer } from "vite";
import * as THREE from "three/webgpu";

// Load the real controller through Vite so this Node probe exercises the same
// extensionless TypeScript graph as the browser build, without duplicating its
// movement/gravity equations in a test-only module.
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true }
});

const [{ SkyFlightController }, { SKY_ISLANDS }] = await Promise.all([
  vite.ssrLoadModule("/src/player/skyFlight.ts"),
  vite.ssrLoadModule("/src/world/skyIslands/metadata.ts")
]);

const DT = 1 / 60;
const WORLD_GRAVITY = new THREE.Vector3(0, -9.81, 0);

class ProbeInput {
  suspended = false;
  axes = new Map();
  held = new Set();
  edges = new Set();

  axis(negative, positive) {
    return this.axes.get(`${negative}|${positive}`) ?? 0;
  }

  down(code) {
    return this.held.has(code);
  }

  pressed(code) {
    return this.edges.has(code);
  }

  clearEdges() {
    this.edges.clear();
  }
}

function createHarness(position, wallZ = null) {
  const ctx = {
    body: 1,
    position: position.clone(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    speed: 0,
    heading: 0,
    time: 0,
    indoor: false,
    raking: false,
    driveSpec: {},
    map: {
      effectiveGround: () => 0
    }
  };
  let commanded = new THREE.Vector3();
  let velocity = new THREE.Vector3();
  let writes = 0;
  ctx.physics = {
    world: {
      setBodyVelocity(_body, linear) {
        commanded.fromArray(linear);
        writes++;
      },
      setBodyTransform() {}
    },
    supportBelow(x, y, z, reach) {
      void x; void z;
      return y >= 0 && y <= reach ? { y: 0, nx: 0, ny: 1, nz: 0 } : null;
    },
    raycastWorld(origin, direction, maxDistance) {
      if (wallZ === null || direction.z >= -1e-8 || origin.z <= wallZ) return null;
      const distance = (wallZ - origin.z) / direction.z;
      if (distance < 0 || distance > maxDistance) return null;
      return {
        point: origin.clone().addScaledVector(direction, distance),
        normal: new THREE.Vector3(0, 0, 1),
        kind: "building"
      };
    }
  };

  const input = new ProbeInput();
  const frame = {
    camYaw: 0,
    aim: new THREE.Vector3(0, 0, -1),
    v: { linear: [0, 0, 0], angular: [0, 0, 0] }
  };

  function step(controller) {
    frame.v.linear[0] = velocity.x;
    frame.v.linear[1] = velocity.y;
    frame.v.linear[2] = velocity.z;
    const owns = controller.update(ctx, DT, input, frame);
    if (owns) {
      // Box3D applies the unchanged global gravity after the controller write.
      velocity.copy(commanded).addScaledVector(WORLD_GRAVITY, DT);
      ctx.position.addScaledVector(velocity, DT);
      ctx.velocity.copy(velocity);
      ctx.speed = velocity.length();
    }
    input.clearEdges();
    return owns;
  }

  return { ctx, input, frame, step, velocity: () => velocity.clone(), writes: () => writes };
}

function run(harness, controller, seconds) {
  for (let i = 0; i < Math.round(seconds / DT); i++) harness.step(controller);
}

try {
  // Space's render-rate latch activates default-available flight immediately.
  {
    const c = new SkyFlightController();
    const h = createHarness(new THREE.Vector3(9000, 500, 9000));
    c.requestTakeoff();
    assert.equal(h.step(c), true);
    assert.equal(c.active, true);
    assert.ok(h.velocity().y > 10, `takeoff was not immediate: vy=${h.velocity().y}`);
  }

  // Open-sky W follows camera pitch; released hover damps all inherited motion.
  {
    const c = new SkyFlightController();
    c.setGravity(0);
    const h = createHarness(new THREE.Vector3(9000, 700, 9000));
    h.frame.aim.set(0, 0.6, -0.8).normalize();
    h.input.axes.set("KeyS|KeyW", 1);
    run(h, c, 1.5);
    assert.ok(h.velocity().z < -16, `W did not produce forward flight: vz=${h.velocity().z}`);
    assert.ok(h.velocity().y > 9, `camera pitch did not lift W flight: vy=${h.velocity().y}`);
    h.input.axes.clear();
    run(h, c, 1.5);
    assert.ok(h.velocity().length() < 0.01, `zero-g hover did not settle: speed=${h.velocity().length()}`);
  }

  // Earth and inverse settings accelerate continuously, without terminal damping.
  {
    const positive = new SkyFlightController();
    positive.setGravity(1);
    const down = createHarness(new THREE.Vector3(9000, 1000, 9000));
    run(down, positive, 1);
    assert.ok(down.velocity().y < -9.6, `full gravity failed to accumulate: vy=${down.velocity().y}`);

    const inverse = new SkyFlightController();
    inverse.setGravity(-1);
    const up = createHarness(new THREE.Vector3(9000, 1000, 9000));
    run(up, inverse, 1);
    assert.ok(up.velocity().y > 9.6, `inverse gravity failed to accumulate: vy=${up.velocity().y}`);
  }

  // Default hover does not suppress an island's own attraction. At contact the
  // capsule stands radial, remains outside the analytic sphere, and can jump off.
  {
    const island = SKY_ISLANDS[0];
    const contact = island.landingRadius + 0.9;
    const c = new SkyFlightController();
    const h = createHarness(new THREE.Vector3(island.center.x + contact + 18, island.center.y, island.center.z));
    c.setGravity(0);
    run(h, c, 1);
    assert.ok(h.velocity().x < -2, `default island gravity did not attract: vx=${h.velocity().x}`);

    h.ctx.position.set(island.center.x + contact + 0.001, island.center.y, island.center.z);
    // Start the contact phase without inherited approach speed.
    c.suspend(h.ctx);
    h.step(c);
    assert.equal(c.currentIsland?.id, island.id);
    assert.equal(c.grounded, true);
    const radialUp = new THREE.Vector3(0, 1, 0).applyQuaternion(c.orientation);
    assert.ok(radialUp.x > 0.999, `capsule did not align radial: up=${radialUp.toArray()}`);
    const before = h.ctx.position.distanceTo(new THREE.Vector3(island.center.x, island.center.y, island.center.z));
    h.input.edges.add("Space");
    h.step(c);
    const after = h.ctx.position.distanceTo(new THREE.Vector3(island.center.x, island.center.y, island.center.z));
    assert.ok(after > before + 0.08, `local Space jump did not depart sphere: ${before} -> ${after}`);

    c.setGravity(-1);
    run(h, c, 0.5);
    assert.ok(h.velocity().dot(c.up) > 3, "inverse gravity did not reflect the local island field");
  }

  // An impossible centre spawn is projected out along a finite fallback normal.
  {
    const island = SKY_ISLANDS[1];
    const c = new SkyFlightController();
    c.setGravity(0);
    const h = createHarness(new THREE.Vector3(island.center.x, island.center.y, island.center.z));
    h.step(c);
    assert.ok(Number.isFinite(h.ctx.position.x + h.ctx.position.y + h.ctx.position.z));
    assert.ok(
      h.ctx.position.distanceTo(new THREE.Vector3(island.center.x, island.center.y, island.center.z)) >= island.landingRadius,
      "sphere-centre recovery remained inside the island"
    );
  }

  // Grounded tangent travel follows the sphere instead of departing along the
  // tangent line, and uses walk pace even while the flight layer is available.
  {
    const island = SKY_ISLANDS[0];
    const centre = new THREE.Vector3(island.center.x, island.center.y, island.center.z);
    const contact = island.landingRadius + 0.9 + 0.035;
    const c = new SkyFlightController();
    const h = createHarness(centre.clone().add(new THREE.Vector3(contact, 0, 0)));
    h.step(c);
    h.input.axes.set("KeyS|KeyW", 1);
    run(h, c, 8);
    const radiusError = Math.abs(h.ctx.position.distanceTo(centre) - contact);
    assert.ok(radiusError < 0.08, `surface walk left spherical shell by ${radiusError}m`);
    assert.ok(h.velocity().length() < 5.4, `surface walk used flight speed: ${h.velocity().length()}m/s`);
  }

  // Five-ray swept volume stops boost flight before crossing a thin wall.
  {
    const c = new SkyFlightController();
    c.setGravity(0);
    const h = createHarness(new THREE.Vector3(9000, 100, 9000), 8995);
    h.input.axes.set("KeyS|KeyW", 1);
    h.input.held.add("ShiftLeft");
    run(h, c, 1);
    assert.ok(h.ctx.position.z > 8994.9, `boost tunneled through wall: z=${h.ctx.position.z}`);
    assert.equal(c.grounded, true);
  }

  // Suspension cannot consume a pending launch or movement input.
  {
    const c = new SkyFlightController();
    const h = createHarness(new THREE.Vector3(9000, 100, 9000));
    c.requestTakeoff();
    h.input.suspended = true;
    h.input.axes.set("KeyS|KeyW", 1);
    assert.equal(h.step(c), false);
    assert.equal(h.writes(), 0);
    h.input.suspended = false;
    assert.equal(h.step(c), true);
  }

  // The garden override must remain continuous while crossing into inverse
  // gravity: half-inverse balances its field without an abrupt sign jump.
  {
    const island = SKY_ISLANDS[0];
    const samples = [0, -0.25, -0.5, -0.75, -1].map((gravity) => {
      const c = new SkyFlightController();
      c.setGravity(gravity);
      const h = createHarness(new THREE.Vector3(island.center.x + 80, island.center.y, island.center.z));
      h.step(c);
      return h.velocity().x;
    });
    assert.ok(samples[0] < 0 && samples[4] > 0, "garden slider must span attraction and repulsion");
    assert.ok(Math.abs(samples[2]) < 1e-8, "half-inverse should balance local gravity");
    for (let i = 1; i < samples.length - 1; i++) {
      assert.ok(Math.abs(samples[i] - (samples[0] + (samples[4] - samples[0]) * i / 4)) < 1e-8,
        "local gravity slider introduced an acceleration discontinuity");
    }
  }

  console.log(JSON.stringify({ ok: true, cases: 9 }, null, 2));
} finally {
  await vite.close();
}
