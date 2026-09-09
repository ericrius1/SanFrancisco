import assert from 'node:assert/strict';
import { createBox3D, BodyType } from '../src/core/box3dWorld.ts';
import { WorldTime } from '../src/core/worldTime.ts';
const clock = new WorldTime();
clock.scale = 2; assert.equal(clock.scale, 1);
clock.scale = -1; assert.equal(clock.scale, 0);
const held = clock.nowMs(); clock.advance(10); assert.equal(clock.nowMs(), held);
clock.scale = 0.5; clock.advance(2); assert.equal(clock.nowMs(), held + 1000);
clock.scale = NaN; assert.equal(clock.scale, 0.5);

const engine = await createBox3D();
for (const scale of [1, 0.5, 0.1, 0.001, 0]) {
  const world = engine.createWorld([0, -10, 0]);
  const local = world.createSphere({ type: BodyType.Dynamic, position: [0, 100, 0], radius: 0.5 });
  const other = world.createSphere({ type: BodyType.Dynamic, position: [100, 100, 0], radius: 0.5 });
  world.setBodyVelocity(local, [6, 0, 0]); world.setBodyVelocity(other, [6, 0, 0]);
  for (let i = 0; i < 60; i++) world.stepDilated(1 / 60, local, scale);
  const player = world.getBodyTransform(local).position;
  const npc = world.getBodyTransform(other).position;
  assert(Math.abs(player[0] - 6) < 0.01, `player speed changed at ${scale}`);
  assert(Math.abs(npc[0] - 100 - 6 * scale) < 0.01, `world speed incorrect at ${scale}`);
  assert(Math.abs(world.getBodyVelocity(local).linear[1] + 10) < 0.01);
  assert(Math.abs(world.getBodyVelocity(other).linear[1] + 10 * scale) < 0.02);
  if (scale === 0) {
    assert.deepEqual(npc, [100, 100, 0]);
    world.stepDilated(1 / 60, local, 1);
    assert(Math.abs(world.getBodyVelocity(other).linear[0] - 6) < 0.01, 'resume lost momentum');
  }
  console.log({ scale, playerX: player[0], worldX: npc[0] - 100 });
  world.dispose();
}
const slowWorld = engine.createWorld([0, 0, 0]);
const slowBody = slowWorld.createSphere({ type: BodyType.Dynamic, position: [0, 0, 0], radius: 0.5 });
slowWorld.setBodyVelocity(slowBody, [1, 0, 0]);
for (let i = 0; i < 600; i++) slowWorld.stepDilated(1 / 60, 0, 0.01);
assert(Math.abs(slowWorld.getBodyTransform(slowBody).position[0] - 0.1) < 0.001, 'slow motion put a moving body to sleep');
assert(Math.abs(slowWorld.getBodyVelocity(slowBody).linear[0] - 1) < 0.001, 'slow motion lost momentum');
slowWorld.dispose();
console.log('World clock, player speed/gravity, world speed/gravity, freeze, resume and slow-motion sleep passed.');
