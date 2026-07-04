import * as THREE from "three/webgpu";
import { time, hash, instanceIndex, positionLocal, abs, sin, vec3, float } from "three/tsl";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldMap } from "../world/heightmap";

/**
 * Things to hunt and gather. Two critters live around the player:
 *
 *  - Crabs scuttle along the waterline (spawned where land meets bay). They
 *    skitter sideways, panic away from you, and count into the satchel when
 *    you pounce close enough.
 *  - Butterflies drift over inland ground, bobbing on shader-flapped wings.
 *    Slower to flee, but they lift out of reach when spooked.
 *
 * Both are one InstancedMesh each — the wiggle/flap runs in the vertex shader
 * (per-instance phase off the hashed instance id, same recipe as the gulls),
 * so the CPU only steers. Catching one poofs a sparkle ring, bumps the count
 * and respawns it somewhere fresh, so the hunt never runs dry.
 */

type Critter = {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  turnTimer: number;
  fleeing: number; // seconds of panic left
  alive: boolean;
  phase: number;
  tone: THREE.Color;
};

type Poof = { x: number; y: number; z: number; age: number };

const CRABS = 9;
const BUTTERFLIES = 13;
const SPAWN_MIN = 18;
const SPAWN_MAX = 80;
const RESPAWN_DIST = 150;
const CRAB_CATCH = 1.45;
const FLY_CATCH = 1.3;
const POOF_LIFE = 0.7;

const BUTTERFLY_TONES = ["#ff8f5f", "#66c9ff", "#ffd94d", "#c98fff", "#7dff9a", "#ff7ab0"];

function crabGeometry(): THREE.BufferGeometry {
  const shell = new THREE.Color("#e06a3a");
  const dark = new THREE.Color("#a34423");
  const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const n = g.getAttribute("position").count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    return g;
  };
  const body = paint(new THREE.BoxGeometry(0.5, 0.18, 0.34), shell);
  body.translate(0, 0.16, 0);
  const clawL = paint(new THREE.BoxGeometry(0.16, 0.12, 0.2), dark);
  clawL.translate(-0.3, 0.14, 0.2);
  const clawR = paint(new THREE.BoxGeometry(0.16, 0.12, 0.2), dark);
  clawR.translate(0.3, 0.14, 0.2);
  const parts = [body, clawL, clawR];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      // legs stick out along X — the shader wiggles the outboard vertices
      const leg = paint(new THREE.BoxGeometry(0.34, 0.05, 0.05), dark);
      leg.translate(side * 0.4, 0.08, -0.12 + i * 0.12);
      parts.push(leg);
    }
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

function butterflyGeometry(): THREE.BufferGeometry {
  // two wing quads + a body sliver; vertexColors OFF (instanceColor tints wings)
  const wingL = new THREE.PlaneGeometry(0.34, 0.26);
  wingL.rotateX(-Math.PI / 2);
  wingL.translate(-0.18, 0, 0);
  const wingR = new THREE.PlaneGeometry(0.34, 0.26);
  wingR.rotateX(-Math.PI / 2);
  wingR.translate(0.18, 0, 0);
  const body = new THREE.BoxGeometry(0.045, 0.045, 0.24);
  const merged = mergeGeometries([wingL, wingR, body]);
  wingL.dispose();
  wingR.dispose();
  body.dispose();
  return merged;
}

export class Hunt {
  onCatch: (kind: "crab" | "butterfly") => void = () => {};

  #map: WorldMap;
  #crabs: Critter[] = [];
  #flies: Critter[] = [];
  #crabMesh: THREE.InstancedMesh;
  #flyMesh: THREE.InstancedMesh;
  #poofs: Poof[] = [];
  #poofMesh: THREE.InstancedMesh;

  #mat = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();
  #euler = new THREE.Euler();

  constructor(map: WorldMap, scene: THREE.Scene) {
    this.#map = map;

    const crabMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 });
    // leg scuttle: outboard vertices (big |x|) pump up/down, phase per instance
    const crabPhase = hash(instanceIndex).mul(6.283);
    const wiggle = sin(time.mul(16).add(crabPhase)).mul(abs(positionLocal.x)).mul(0.16);
    crabMat.positionNode = positionLocal.add(vec3(float(0), wiggle, float(0)));
    this.#crabMesh = new THREE.InstancedMesh(crabGeometry(), crabMat, CRABS);
    this.#crabMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#crabMesh.frustumCulled = false;
    this.#crabMesh.castShadow = false;
    this.#crabMesh.receiveShadow = false;
    scene.add(this.#crabMesh);

    const flyMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, side: THREE.DoubleSide });
    // wing flap: everything off the centreline swings hard
    const flyPhase = hash(instanceIndex).mul(6.283);
    const flap = sin(time.mul(13).add(flyPhase)).mul(abs(positionLocal.x)).mul(1.35);
    flyMat.positionNode = positionLocal.add(vec3(float(0), flap, float(0)));
    this.#flyMesh = new THREE.InstancedMesh(butterflyGeometry(), flyMat, BUTTERFLIES);
    this.#flyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#flyMesh.setColorAt(0, new THREE.Color("#ffffff")); // attribute must exist pre-compile
    this.#flyMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.#flyMesh.frustumCulled = false;
    this.#flyMesh.castShadow = false;
    this.#flyMesh.receiveShadow = false;
    scene.add(this.#flyMesh);

    // catch sparkle: a ring of little octahedra that blooms and fades
    const poofMat = new THREE.MeshBasicMaterial({
      color: "#fff2b0",
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.#poofMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.09, 0), poofMat, 8 * 8);
    this.#poofMesh.count = 0;
    this.#poofMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#poofMesh.frustumCulled = false;
    scene.add(this.#poofMesh);

    for (let i = 0; i < CRABS; i++) this.#crabs.push(this.#blank());
    for (let i = 0; i < BUTTERFLIES; i++) this.#flies.push(this.#blank());
    // butterfly tones are fixed per instance — upload the color buffer once
    for (let i = 0; i < BUTTERFLIES; i++) this.#flyMesh.setColorAt(i, this.#flies[i].tone);
    this.#flyMesh.instanceColor!.needsUpdate = true;
  }

  #blank(): Critter {
    return {
      x: 0, y: -500, z: 0,
      heading: Math.random() * Math.PI * 2,
      speed: 0,
      turnTimer: 0,
      fleeing: 0,
      alive: false,
      phase: Math.random() * Math.PI * 2,
      tone: new THREE.Color(BUTTERFLY_TONES[Math.floor(Math.random() * BUTTERFLY_TONES.length)])
    };
  }

  /**
   * Shore spot: dry ground that reads as waterfront. True beaches (water a few
   * steps away) always qualify; low wharf/pier districts qualify when the bay
   * is within a block — the piers push the actual waterline ~100m out, but
   * crabs on the Embarcadero promenade are exactly the joke we want.
   */
  #findShore(px: number, pz: number): { x: number; z: number } | null {
    for (let tries = 0; tries < 8; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
      const x = px + Math.cos(a) * d;
      const z = pz + Math.sin(a) * d;
      if (this.#map.isWater(x, z)) continue;
      const g = this.#map.effectiveGround(x, z);
      if (g > 6.5) continue; // beaches and wharves sit low
      let water = false;
      for (const [ox, oz] of [[14, 0], [-14, 0], [0, 14], [0, -14]] as const) {
        if (this.#map.isWater(x + ox, z + oz)) {
          water = true;
          break;
        }
      }
      if (!water && g < 5) {
        // the Embarcadero pier belt holds the raw water line ~250m off the
        // promenade, so the wharf-district tier sniffs out to 240m
        for (const wr of [60, 140, 240]) {
          for (let k = 0; k < 8 && !water; k++) {
            const wa = (k / 8) * Math.PI * 2 + wr;
            water = this.#map.isWater(x + Math.cos(wa) * wr, z + Math.sin(wa) * wr);
          }
          if (water) break;
        }
      }
      if (water) return { x, z };
    }
    return null;
  }

  #findMeadow(px: number, pz: number): { x: number; z: number } | null {
    for (let tries = 0; tries < 8; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
      const x = px + Math.cos(a) * d;
      const z = pz + Math.sin(a) * d;
      if (!this.#map.isWater(x, z)) return { x, z };
    }
    return null;
  }

  #poof(x: number, y: number, z: number) {
    if (this.#poofs.length >= 8) this.#poofs.shift();
    this.#poofs.push({ x, y, z, age: 0 });
  }

  get aliveCrabs() {
    return this.#crabs.filter((c) => c.alive).length;
  }
  get aliveButterflies() {
    return this.#flies.filter((c) => c.alive).length;
  }

  update(dt: number, elapsed: number, playerPos: THREE.Vector3) {
    this.#steer(this.#crabs, dt, playerPos, true);
    this.#steer(this.#flies, dt, playerPos, false);
    this.#drawCrabs(elapsed);
    this.#drawFlies(elapsed);
    this.#drawPoofs(dt);
  }

  #steer(list: Critter[], dt: number, p: THREE.Vector3, crab: boolean) {
    for (const c of list) {
      if (!c.alive) {
        const spot = crab ? this.#findShore(p.x, p.z) : this.#findMeadow(p.x, p.z);
        if (!spot) continue;
        c.x = spot.x;
        c.z = spot.z;
        c.y = this.#map.effectiveGround(spot.x, spot.z);
        c.alive = true;
        c.fleeing = 0;
        continue;
      }
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d > RESPAWN_DIST) {
        c.alive = false; // left behind — respawn near the player next frame
        continue;
      }

      const dy = p.y - c.y;
      const catchR = crab ? CRAB_CATCH : FLY_CATCH;
      if (d < catchR && Math.abs(dy) < 2.2) {
        this.#poof(c.x, c.y + (crab ? 0.3 : 0.2), c.z);
        this.onCatch(crab ? "crab" : "butterfly");
        c.alive = false;
        continue;
      }

      // fear: bolt directly away while the player crowds in
      const spookR = crab ? 8 : 5.5;
      if (d < spookR) c.fleeing = crab ? 1.6 : 2.2;
      if (c.fleeing > 0) {
        c.fleeing -= dt;
        // bolt straight away: forward = (sin h, cos h), so away-from-player is
        // the heading pointing along (-dx, -dz)
        const want = Math.atan2(-dx, -dz);
        let diff = want - c.heading;
        diff = ((diff + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        c.heading += THREE.MathUtils.clamp(diff, -6 * dt, 6 * dt);
        c.speed = THREE.MathUtils.lerp(c.speed, crab ? 5.2 : 3.6, dt * 5);
      } else {
        c.turnTimer -= dt;
        if (c.turnTimer <= 0) {
          c.turnTimer = 0.8 + Math.random() * 2.4;
          c.heading += (Math.random() - 0.5) * 2.2;
          c.speed = crab ? 0.5 + Math.random() * 0.9 : 1 + Math.random() * 0.9;
        }
      }

      const nx = c.x + Math.sin(c.heading) * c.speed * dt;
      const nz = c.z + Math.cos(c.heading) * c.speed * dt;
      // stay off the water (crabs paddle at the very edge, butterflies bank away)
      if (this.#map.isWater(nx, nz)) {
        c.heading += Math.PI * (0.6 + Math.random() * 0.4);
      } else {
        c.x = nx;
        c.z = nz;
      }
      const ground = this.#map.effectiveGround(c.x, c.z);
      if (crab) {
        c.y = ground;
      } else {
        // butterflies float 1–2.5m up, higher while spooked
        const cruise = ground + 1.1 + Math.sin(c.phase * 7) * 0.4 + (c.fleeing > 0 ? 1.6 : 0);
        c.y = THREE.MathUtils.lerp(c.y, cruise, dt * 2.2);
      }
    }
  }

  #drawCrabs(elapsed: number) {
    this.#crabMesh.count = CRABS;
    for (let i = 0; i < this.#crabs.length; i++) {
      const c = this.#crabs[i];
      if (!c.alive) {
        this.#mat.makeTranslation(0, -500 - i, 0);
        this.#crabMesh.setMatrixAt(i, this.#mat);
        continue;
      }
      // crabs face SIDEWAYS to their travel — they scuttle, they don't stroll
      const yaw = Math.atan2(Math.sin(c.heading), Math.cos(c.heading)) + Math.PI / 2;
      const rock = Math.sin(elapsed * 10 + c.phase) * 0.06 * Math.min(1, c.speed);
      this.#euler.set(rock, yaw, 0, "YXZ");
      this.#quat.setFromEuler(this.#euler);
      this.#pos.set(c.x, c.y + 0.02, c.z);
      this.#mat.compose(this.#pos, this.#quat, this.#scale.setScalar(c.fleeing > 0 ? 1.05 : 1));
      this.#crabMesh.setMatrixAt(i, this.#mat);
    }
    this.#crabMesh.instanceMatrix.needsUpdate = true;
  }

  #drawFlies(elapsed: number) {
    this.#flyMesh.count = BUTTERFLIES;
    for (let i = 0; i < this.#flies.length; i++) {
      const c = this.#flies[i];
      if (!c.alive) {
        this.#mat.makeTranslation(0, -500 - i, 0);
        this.#flyMesh.setMatrixAt(i, this.#mat);
        continue;
      }
      const yaw = Math.atan2(Math.sin(c.heading), Math.cos(c.heading));
      const bob = Math.sin(elapsed * 3.4 + c.phase) * 0.14;
      this.#euler.set(0, yaw, Math.sin(elapsed * 2.2 + c.phase) * 0.18, "YXZ");
      this.#quat.setFromEuler(this.#euler);
      this.#pos.set(c.x, c.y + bob, c.z);
      this.#mat.compose(this.#pos, this.#quat, this.#scale.setScalar(1));
      this.#flyMesh.setMatrixAt(i, this.#mat);
    }
    this.#flyMesh.instanceMatrix.needsUpdate = true;
  }

  #drawPoofs(dt: number) {
    let n = 0;
    for (let i = this.#poofs.length - 1; i >= 0; i--) {
      const p = this.#poofs[i];
      p.age += dt;
      if (p.age > POOF_LIFE) {
        this.#poofs.splice(i, 1);
        continue;
      }
      const t = p.age / POOF_LIFE;
      const r = 0.25 + t * 1.15;
      const s = (1 - t) * 1.4;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + t * 2.4;
        this.#pos.set(p.x + Math.cos(a) * r, p.y + t * 0.9, p.z + Math.sin(a) * r);
        this.#mat.compose(this.#pos, this.#quat.identity(), this.#scale.setScalar(s));
        this.#poofMesh.setMatrixAt(n++, this.#mat);
      }
    }
    this.#poofMesh.count = n;
    if (n) this.#poofMesh.instanceMatrix.needsUpdate = true;
  }
}
