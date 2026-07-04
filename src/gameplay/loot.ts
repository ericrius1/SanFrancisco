import * as THREE from "three/webgpu";
import { BodyType } from "box3d-wasm";
import { LIGHT_SCALE } from "../config";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";

/**
 * Treasure chests, Fortnite style. Golden chests conjure themselves on open
 * ground around the player, humming under a light beacon you can spot from a
 * block away. Walk up and one pops open on its own: the lid swings back and a
 * fountain of coins (and the odd big gem) sprays out. Coins scatter with a
 * toy ballistic sim, then magnet onto the player and count into the satchel.
 * Some chests throw in a fireworks salvo on top.
 *
 * Coins are pure visuals (no physics bodies) so a 20-coin burst costs nothing;
 * each chest does carry one static box so it thunks when you drive into it.
 */

type ChestState = "closed" | "opening" | "open";

type Chest = {
  group: THREE.Group;
  lid: THREE.Group;
  beacon: THREE.Mesh;
  seam: THREE.Mesh;
  body: number;
  x: number;
  y: number;
  z: number;
  state: ChestState;
  anim: number; // 0 closed .. 1 fully open
  sparkle: number; // burst flash timer
  yaw: number;
};

type Coin = {
  kind: "coin" | "gem";
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  spin: number;
  landed: boolean;
};

const MAX_CHESTS = 6;
const MAX_COINS = 220;
const CHEST_TRY_EVERY = 2.4;
const CHEST_MIN = 34;
const CHEST_MAX = 150;
const CHEST_DROP = 280;
const CHEST_SPACING = 46;
const OPEN_RANGE = 2.9;
const COIN_LIFE = 26;
const MAGNET_RANGE = 5.5;
const COLLECT_RANGE = 1.35;

const GOLD = new THREE.Color("#f5c34a");
const GEM_TONES = ["#ff4d88", "#4dc3ff", "#7dff9a", "#b06bff"];

function chestParts(): { base: THREE.Group; lid: THREE.Group } {
  const wood = new THREE.MeshStandardMaterial({ color: "#7a4f2b", roughness: 0.75 });
  const trim = new THREE.MeshStandardMaterial({
    color: "#e8b23d",
    roughness: 0.3,
    metalness: 0.75,
    emissive: "#8a5f14",
    emissiveIntensity: 0.35 * LIGHT_SCALE
  });
  const base = new THREE.Group();
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.52, 0.66), wood);
  tub.position.y = 0.26;
  base.add(tub);
  for (const sx of [-0.44, 0.44]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.56, 0.7), trim);
    band.position.set(sx, 0.27, 0);
    base.add(band);
  }
  const latch = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.06), trim);
  latch.position.set(0, 0.5, 0.34);
  base.add(latch);

  // lid pivots at the back-top edge of the tub
  const lid = new THREE.Group();
  lid.position.set(0, 0.52, -0.33);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 0.66), wood);
  cap.position.set(0, 0.13, 0.33);
  lid.add(cap);
  for (const sx of [-0.44, 0.44]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.34, 0.7), trim);
    band.position.set(sx, 0.14, 0.33);
    lid.add(band);
  }
  base.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  lid.traverse((o) => {
    o.castShadow = true;
  });
  return { base, lid };
}

export class Loot {
  /** Fired per pickup: kind and how many the satchel should add. */
  onCollect: (kind: "coin" | "gem", n: number) => void = () => {};
  /** A lucky chest celebrates itself. */
  onFireworks: (x: number, y: number, z: number) => void = () => {};
  onOpen: () => void = () => {};

  #physics: Physics;
  #map: WorldMap;
  #scene: THREE.Scene;
  #chests: Chest[] = [];
  #coins: Coin[] = [];
  #spawnTimer = 3;

  #coinMesh: THREE.InstancedMesh;
  #gemMesh: THREE.InstancedMesh;
  #beaconGeo = new THREE.CylinderGeometry(0.34, 0.5, 15, 10, 1, true);
  #beaconMat: THREE.MeshBasicMaterial;
  #seamGeo = new THREE.BoxGeometry(0.94, 0.05, 0.6);
  #seamMat: THREE.MeshStandardMaterial;

  #tmpMat = new THREE.Matrix4();
  #tmpQuat = new THREE.Quaternion();
  #tmpScale = new THREE.Vector3();
  #tmpVec = new THREE.Vector3();

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene) {
    this.#physics = physics;
    this.#map = map;
    this.#scene = scene;

    const coinMat = new THREE.MeshStandardMaterial({
      color: GOLD,
      roughness: 0.25,
      metalness: 0.85,
      emissive: "#7a5a10",
      emissiveIntensity: 0.4 * LIGHT_SCALE
    });
    this.#coinMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 14), coinMat, MAX_COINS);
    this.#coinMesh.count = 0;
    this.#coinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#coinMesh.frustumCulled = false;
    scene.add(this.#coinMesh);

    const gemMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.12,
      metalness: 0.55,
      emissive: "#3a2a66",
      emissiveIntensity: 0.3 * LIGHT_SCALE
    });
    this.#gemMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.26, 0), gemMat, 48);
    this.#gemMesh.count = 0;
    this.#gemMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#gemMesh.setColorAt(0, new THREE.Color("#ffffff")); // attribute exists before first pipeline compile
    this.#gemMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.#gemMesh.frustumCulled = false;
    scene.add(this.#gemMesh);

    this.#beaconMat = new THREE.MeshBasicMaterial({
      color: "#ffd76a",
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.#seamMat = new THREE.MeshStandardMaterial({
      color: "#ffd76a",
      emissive: "#ffb52e",
      emissiveIntensity: 1.1 * LIGHT_SCALE,
      roughness: 0.4
    });
  }

  get chestCount() {
    return this.#chests.length;
  }
  get coinCount() {
    return this.#coins.length;
  }

  /** Drop a chest at an exact spot (debug/demo hook). */
  spawnChestAt(x: number, z: number): boolean {
    return this.#spawnChest(x, z);
  }

  #spawnChest(x: number, z: number): boolean {
    if (this.#chests.length >= MAX_CHESTS) return false;
    if (this.#map.isWater(x, z)) return false;
    const y = this.#map.effectiveGround(x, z);
    if (this.#physics.pointInBuilding(x, y + 0.8, z, 1.2)) return false;
    for (const c of this.#chests) {
      if (Math.hypot(c.x - x, c.z - z) < CHEST_SPACING) return false;
    }

    const { base, lid } = chestParts();
    const group = new THREE.Group();
    group.add(base);
    group.add(lid);
    const yaw = Math.random() * Math.PI * 2;
    group.position.set(x, y, z);
    group.rotation.y = yaw;

    // each chest fades its own beacon on open, so the material can't be shared
    const beacon = new THREE.Mesh(this.#beaconGeo, this.#beaconMat.clone());
    beacon.position.y = 7.6;
    group.add(beacon);
    const seam = new THREE.Mesh(this.#seamGeo, this.#seamMat);
    seam.position.set(0, 0.53, 0.02);
    group.add(seam);

    this.#scene.add(group);
    const body = this.#physics.world.createBox({
      type: BodyType.Static,
      position: [x, y + 0.35, z],
      halfExtents: [0.52, 0.35, 0.35],
      friction: 0.6
    });
    this.#physics.world.setBodyTransform(body, [x, y + 0.35, z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);

    this.#chests.push({ group, lid, beacon, seam, body, x, y, z, state: "closed", anim: 0, sparkle: 0, yaw });
    return true;
  }

  #dropChest(chest: Chest) {
    const i = this.#chests.indexOf(chest);
    if (i === -1) return;
    this.#chests.splice(i, 1);
    this.#physics.world.destroyBody(chest.body);
    this.#scene.remove(chest.group);
    (chest.beacon.material as THREE.Material).dispose(); // per-chest clone
    // everything else is shared geometry/material and stays alive
  }

  #open(chest: Chest) {
    chest.state = "opening";
    chest.sparkle = 1;
    this.onOpen();

    // the payout: a fountain of coins, a few gems, sometimes a firework salvo
    const coins = 13 + Math.floor(Math.random() * 8);
    const gems = Math.random() < 0.55 ? 1 + Math.floor(Math.random() * 3) : 0;
    const lidDir = this.#tmpVec.set(Math.sin(chest.yaw), 0, Math.cos(chest.yaw)); // local +Z, where the lid faces
    for (let n = 0; n < coins + gems; n++) {
      if (this.#coins.length >= MAX_COINS) break;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      this.#coins.push({
        kind: n < coins ? "coin" : "gem",
        pos: new THREE.Vector3(chest.x, chest.y + 0.75, chest.z),
        vel: new THREE.Vector3(
          Math.cos(a) * r * 2.6 + lidDir.x * 1.4,
          4.2 + Math.random() * 3.4,
          Math.sin(a) * r * 2.6 + lidDir.z * 1.4
        ),
        age: 0,
        spin: Math.random() * Math.PI * 2,
        landed: false
      });
    }
    if (Math.random() < 0.28) this.onFireworks(chest.x, chest.y + 1, chest.z);
  }

  update(dt: number, playerPos: THREE.Vector3, elapsed: number) {
    // conjure new chests in the ring around the player
    this.#spawnTimer -= dt;
    if (this.#spawnTimer <= 0) {
      this.#spawnTimer = CHEST_TRY_EVERY;
      if (this.#chests.length < MAX_CHESTS) {
        const a = Math.random() * Math.PI * 2;
        const d = CHEST_MIN + Math.random() * (CHEST_MAX - CHEST_MIN);
        this.#spawnChest(playerPos.x + Math.cos(a) * d, playerPos.z + Math.sin(a) * d);
      }
    }

    for (const chest of [...this.#chests]) {
      const dist = Math.hypot(playerPos.x - chest.x, playerPos.z - chest.z);
      if (dist > CHEST_DROP) {
        this.#dropChest(chest);
        continue;
      }
      if (chest.state === "closed") {
        // idle shimmer: the seam breathes, the beacon slowly twists
        const pulse = 0.75 + Math.sin(elapsed * 3.1 + chest.x) * 0.45;
        this.#seamMat.emissiveIntensity = (0.7 + pulse * 0.6) * LIGHT_SCALE;
        chest.beacon.rotation.y = elapsed * 0.4;
        if (dist < OPEN_RANGE && Math.abs(playerPos.y - chest.y) < 3.4) this.#open(chest);
      } else if (chest.state === "opening") {
        chest.anim = Math.min(1, chest.anim + dt * 2.4);
        // overshoot ease: the lid flies back and settles
        const t = chest.anim;
        const angle = -(Math.PI * 0.62) * (1 - Math.pow(1 - t, 3));
        chest.lid.rotation.x = angle;
        chest.beacon.scale.y = 1 - t;
        chest.beacon.position.y = 7.6 * (1 - t) + 1.2;
        (chest.beacon.material as THREE.MeshBasicMaterial).opacity = 0.16 * (1 - t);
        chest.seam.visible = false;
        if (t >= 1) {
          chest.state = "open";
          chest.beacon.visible = false;
        }
      }
      if (chest.sparkle > 0) chest.sparkle -= dt;
    }

    this.#updateCoins(dt, playerPos, elapsed);
  }

  #updateCoins(dt: number, playerPos: THREE.Vector3, elapsed: number) {
    let collectedCoins = 0;
    let collectedGems = 0;
    for (let i = this.#coins.length - 1; i >= 0; i--) {
      const c = this.#coins[i];
      c.age += dt;
      if (c.age > COIN_LIFE) {
        this.#coins.splice(i, 1);
        continue;
      }
      const dx = playerPos.x - c.pos.x;
      const dy = playerPos.y + 0.9 - c.pos.y;
      const dz = playerPos.z - c.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < COLLECT_RANGE) {
        if (c.kind === "coin") collectedCoins++;
        else collectedGems++;
        this.#coins.splice(i, 1);
        continue;
      }
      if (d < MAGNET_RANGE) {
        // magnet: accelerate hard at the player, killing ballistic motion
        const pull = 26 * (1 - d / MAGNET_RANGE) + 6;
        c.vel.x += (dx / d) * pull * dt * 4;
        c.vel.y += (dy / d) * pull * dt * 4;
        c.vel.z += (dz / d) * pull * dt * 4;
        c.vel.multiplyScalar(Math.max(0, 1 - dt * 1.6)); // drag so it homes, not orbits
        c.landed = false;
      } else if (!c.landed) {
        c.vel.y -= 7.4 * dt;
      }
      c.pos.addScaledVector(c.vel, dt);
      const ground = this.#map.effectiveGround(c.pos.x, c.pos.z) + 0.16;
      if (c.pos.y < ground) {
        c.pos.y = ground;
        if (c.vel.y < -1.4) {
          c.vel.y = -c.vel.y * 0.38;
          c.vel.x *= 0.7;
          c.vel.z *= 0.7;
        } else if (d >= MAGNET_RANGE) {
          c.vel.set(0, 0, 0);
          c.landed = true;
        } else {
          c.vel.y = Math.max(0, c.vel.y);
        }
      }
    }
    if (collectedCoins) this.onCollect("coin", collectedCoins);
    if (collectedGems) this.onCollect("gem", collectedGems);

    // draw: coins spin on Y; the last 2s shrink away
    let ci = 0;
    let gi = 0;
    const gemColor = new THREE.Color();
    for (const c of this.#coins) {
      const fade = c.age > COIN_LIFE - 2 ? (COIN_LIFE - c.age) / 2 : 1;
      this.#tmpQuat.setFromAxisAngle(upY, c.spin + elapsed * 4.2);
      if (c.kind === "coin") {
        if (ci >= MAX_COINS) continue;
        // coins stand on edge and spin like Mario's
        this.#tmpQuat.multiply(coinTilt);
        this.#tmpMat.compose(c.pos, this.#tmpQuat, this.#tmpScale.setScalar(fade));
        this.#coinMesh.setMatrixAt(ci++, this.#tmpMat);
      } else {
        if (gi >= 48) continue;
        this.#tmpMat.compose(c.pos, this.#tmpQuat, this.#tmpScale.setScalar(fade * 1.15));
        this.#gemMesh.setMatrixAt(gi, this.#tmpMat);
        gemColor.set(GEM_TONES[(Math.abs(Math.round(c.spin * 100)) % GEM_TONES.length)]);
        this.#gemMesh.setColorAt(gi, gemColor);
        gi++;
      }
    }
    this.#coinMesh.count = ci;
    this.#gemMesh.count = gi;
    if (ci) this.#coinMesh.instanceMatrix.needsUpdate = true;
    if (gi) {
      this.#gemMesh.instanceMatrix.needsUpdate = true;
      this.#gemMesh.instanceColor!.needsUpdate = true;
    }
  }
}

const upY = new THREE.Vector3(0, 1, 0);
const coinTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
