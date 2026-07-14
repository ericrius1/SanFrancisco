import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import {
  createSurfaceSoftSpriteMaterial,
  horizontalSurfacePlane,
  SURFACE_SOFT_SPRITE,
  terrainSurfacePlane
} from "../src/gameplay/palaceReverie/surfaceSoftSprite.ts";

const signedDistance = (plane, point) =>
  plane.x * point.x + plane.y * point.y + plane.z * point.z + plane.w;

const water = horizontalSurfacePlane(2.45);
assert.equal(signedDistance(water, new THREE.Vector3(0, 2.45, 0)), 0);
assert.equal(signedDistance(water, new THREE.Vector3(0, 3.45, 0)), 1);

const slope = {
  groundTop(x, z) {
    return 4 + x * 0.2 - z * 0.1;
  }
};
const x = 7;
const z = -3;
const ground = slope.groundTop(x, z);
const terrain = terrainSurfacePlane(slope, x, z);
const normal = new THREE.Vector3(terrain.x, terrain.y, terrain.z);
assert.ok(Math.abs(normal.length() - 1) < 1e-12);
assert.ok(Math.abs(signedDistance(terrain, new THREE.Vector3(x, ground, z))) < 1e-12);
assert.ok(
  Math.abs(signedDistance(terrain, new THREE.Vector3(x, ground, z).add(normal)) - 1) < 1e-12
);

assert.ok(SURFACE_SOFT_SPRITE.heroFullDistance < SURFACE_SOFT_SPRITE.heroEndDistance);
assert.ok(SURFACE_SOFT_SPRITE.renderOrder > 11, "surface effects must render after lagoon/near water");

const texture = new THREE.Texture();
const soft = createSurfaceSoftSpriteMaterial({
  map: texture,
  opacity: 0.5,
  surfacePlane: water,
  feather: 0.4
});
assert.equal(soft.material.transparent, true);
assert.equal(soft.material.depthWrite, false);
assert.equal(soft.material.opacity, 0.5);
assert.ok(soft.material.opacityNode, "surface feather must own the sprite opacity node");
assert.notEqual(soft.surfacePlane, water, "each material owns a mutable plane uniform value");

console.log("PASS: Palace surface-soft sprites use normalized local planes and remain transparent");
