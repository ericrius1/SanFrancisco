import * as THREE from "three/webgpu";
import { BodyType } from "box3d-wasm";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../../world/heightmap";
import type { Physics } from "../../core/physics";
import { HORSE, type CreatureSpec, type Link } from "../../creatures/quadruped";
import { HorseRagdoll } from "./horseRagdoll";

/**
 * A herd of horses roaming a raised grass platform in Golden Gate Park. Each is
 * a live box3d ragdoll (its own private world) driven by a procedural gait every
 * frame, drawn as a dressed-up capsule horse that tracks the ragdoll.
 *
 * The terrain here is a steep, flora-choked hill you clip through, so instead of
 * fighting it we float a flat platform above it (visual disc + one static
 * collider) and let the horses AND the rider live on that.
 */

const PARK = { x: -5250, z: 2380 };
const PLATFORM_Y = 35;
const PLATFORM_R = 85;
const ROAM = 78;
const COUNT = 20;
const DOWN_SECONDS = 10;
const GOAL_EASE = 0.45;
const SCALE = 2.3;

type HorseMeshes = { group: THREE.Group; parts: THREE.Mesh[] };
type Horse = {
  rag: HorseRagdoll;
  m: HorseMeshes;
  anchor: { x: number; z: number };
  wanderYaw: number;
  wanderTimer: number;
  speedNonDim: number;
  gx: number; gz: number;
  downTimer: number;
  wx: number; wy: number; wz: number;
  wq: [number, number, number, number];
};

function partMesh(geo: THREE.BufferGeometry, color: number, rough: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: rough,
    metalness: 0.03,
    emissive: new THREE.Color(color).multiplyScalar(0.28),
    emissiveIntensity: 0.014 * LIGHT_SCALE
  });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function glowMaterial(color: number, intensity: number, opacity = 1): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(intensity),
    transparent: opacity < 1,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  mat.toneMapped = false;
  return mat;
}

export class HorseHerd {
  #box3d: any;
  #world: any;
  #scene: THREE.Scene;
  #spec: CreatureSpec = HORSE;
  #horses: Horse[] = [];
  #ready = false;
  #ridden = -1;
  #steerYaw = 0;
  #riddenSpeed = 0.55;
  #forceSpeed: number | null = null;

  constructor(physics: Physics, _map: WorldMap, scene: THREE.Scene) {
    this.#box3d = physics.box3d;
    this.#world = physics.world;
    this.#scene = scene;
    this.#buildPlatform();
    this.#spawn();
    this.#ready = true;
  }

  get platformY(): number { return PLATFORM_Y; }
  get paddockCenter(): { x: number; y: number; z: number } { return { x: PARK.x, y: PLATFORM_Y, z: PARK.z }; }
  debugStates(): { upY: number; tall: number; down: number; fallen: boolean; speed: number }[] {
    return this.#horses.map((h) => {
      const t = h.rag.torsoLink;
      const q = t.quat;
      const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
      return { upY, tall: t.pos[1] / h.rag.standY, down: h.downTimer, fallen: h.rag.fallen, speed: Math.hypot(t.vel[0], t.vel[2]) };
    });
  }
  get center(): { x: number; z: number } { return PARK; }
  onPlatform(x: number, z: number): boolean {
    return (x - PARK.x) * (x - PARK.x) + (z - PARK.z) * (z - PARK.z) < PLATFORM_R * PLATFORM_R;
  }

  #buildPlatform(): void {
    this.#world.createBox({
      type: BodyType.Static,
      position: [PARK.x, PLATFORM_Y - 1.5, PARK.z],
      halfExtents: [PLATFORM_R, 1.5, PLATFORM_R],
      friction: 0.9
    });
    const grass = new THREE.Mesh(
      new THREE.CircleGeometry(PLATFORM_R, 64),
      new THREE.MeshStandardMaterial({
        color: 0x7fae45,
        roughness: 0.88,
        emissive: 0x1d3812,
        emissiveIntensity: 0.04 * LIGHT_SCALE
      })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(PARK.x, PLATFORM_Y + 0.02, PARK.z);
    grass.receiveShadow = true;
    this.#scene.add(grass);
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(PLATFORM_R, PLATFORM_R * 0.98, 3, 64, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x526f2d, roughness: 0.95, emissive: 0x16220d, emissiveIntensity: 0.025 * LIGHT_SCALE })
    );
    rim.position.set(PARK.x, PLATFORM_Y - 1.5, PARK.z);
    this.#scene.add(rim);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(PLATFORM_R * 0.985, 0.2, 8, 128),
      glowMaterial(0xb5ff76, LIGHT_SCALE * 0.045, 0.58)
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(PARK.x, PLATFORM_Y + 0.12, PARK.z);
    this.#scene.add(ring);
  }

  #buildDressedHorse(): THREE.Mesh[] {
    const s = this.#spec;
    const parts: THREE.Mesh[] = [];
    const torso = partMesh(new THREE.BoxGeometry(s.torso.half[0] * 2, s.torso.half[1] * 1.9, s.torso.half[2] * 2), 0x9a6538, 0.68);
    torso.scale.setScalar(SCALE);
    parts.push(torso);
    const neck = partMesh(new THREE.CylinderGeometry(0.07, 0.12, 0.44, 8), 0x81512e, 0.72);
    neck.position.set(0, 0.24, 0.5); neck.rotation.x = -0.95; torso.add(neck);
    const head = partMesh(new THREE.BoxGeometry(0.13, 0.16, 0.3), 0x81512e, 0.72);
    head.position.set(0, 0.44, 0.74); head.rotation.x = -0.35; torso.add(head);
    const eyeMat = glowMaterial(0xfff2a4, LIGHT_SCALE * 0.18, 0.92);
    for (const sx of [-0.055, 0.055]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.017, 8, 6), eyeMat);
      eye.position.set(sx, 0.035, 0.13);
      head.add(eye);
    }
    const muzzle = partMesh(new THREE.BoxGeometry(0.1, 0.1, 0.14), 0x69442c, 0.78);
    muzzle.position.set(0, 0.4, 0.9); torso.add(muzzle);
    for (const sx of [-0.05, 0.05]) {
      const ear = partMesh(new THREE.ConeGeometry(0.035, 0.1, 6), 0x3b2716, 0.9);
      ear.position.set(sx, 0.56, 0.68); torso.add(ear);
    }
    const mane = partMesh(new THREE.BoxGeometry(0.04, 0.3, 0.42), 0x241408, 0.95);
    mane.position.set(0, 0.28, 0.52); mane.rotation.x = -0.95; torso.add(mane);
    const tail = partMesh(new THREE.CylinderGeometry(0.015, 0.06, 0.44, 6), 0x241408, 0.95);
    tail.position.set(0, 0.16, -0.56); tail.rotation.x = 0.7; torso.add(tail);
    const blanket = partMesh(new THREE.BoxGeometry(0.5, 0.035, 0.5), 0x15a6b0, 0.42);
    blanket.position.set(0, 0.17, -0.03);
    torso.add(blanket);
    const saddle = partMesh(new THREE.BoxGeometry(0.36, 0.045, 0.32), 0x2b1a12, 0.58);
    saddle.position.set(0, 0.205, -0.06);
    torso.add(saddle);
    for (const leg of s.legs) {
      const thigh = partMesh(new THREE.CapsuleGeometry(leg.thigh.radius, leg.thigh.halfHeight * 2, 4, 8), 0x754727, 0.76);
      thigh.scale.setScalar(SCALE);
      parts.push(thigh);
      const shank = partMesh(new THREE.CapsuleGeometry(leg.shank.radius, leg.shank.halfHeight * 2, 4, 8), 0x754727, 0.76);
      shank.scale.setScalar(SCALE);
      const sock = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.04, leg.shank.radius * 1.08, 0.15, 8), 0xf0dcc0, 0.64);
      sock.position.set(0, -leg.shank.halfHeight * 0.48, 0);
      shank.add(sock);
      const hoof = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.15, leg.shank.radius * 0.9, 0.06, 8), 0x141010, 0.6);
      hoof.position.set(0, -leg.shank.halfHeight - 0.02, 0); shank.add(hoof);
      parts.push(shank);
    }
    return parts;
  }

  #buildMeshes(): HorseMeshes {
    const group = new THREE.Group();
    const parts = this.#buildDressedHorse();
    for (const p of parts) group.add(p);
    this.#scene.add(group);
    return { group, parts };
  }

  #spawn(): void {
    for (let i = 0; i < COUNT; i++) {
      const a = (i / COUNT) * Math.PI * 2 + Math.random();
      const r = 6 + Math.random() * (ROAM - 8);
      const anchor = { x: PARK.x + Math.cos(a) * r, z: PARK.z + Math.sin(a) * r };
      const rag = new HorseRagdoll(this.#box3d, this.#spec, SCALE);
      const yaw = Math.random() * Math.PI * 2;
      rag.setGoal(Math.sin(yaw), Math.cos(yaw));
      const m = this.#buildMeshes();
      this.#horses.push({ rag, m, anchor, wanderYaw: yaw, wanderTimer: 2 + Math.random() * 4, speedNonDim: 0.2 + Math.random() * 0.25, gx: Math.sin(yaw), gz: Math.cos(yaw), downTimer: 0, wx: anchor.x, wy: PLATFORM_Y, wz: anchor.z, wq: [0, 0, 0, 1] });
    }
  }

  prePhysics(dt: number): void {
    if (!this.#ready) return;
    for (let idx = 0; idx < this.#horses.length; idx++) {
      const h = this.#horses[idx];
      if (h.downTimer > 0) {
        h.downTimer -= dt;
        h.rag.update(dt);
        if (h.downTimer <= 0) { h.rag.setDowned(false); h.rag.reset(); }
        continue;
      }
      if (h.rag.fallen) {
        h.downTimer = DOWN_SECONDS;
        h.rag.setDowned(true);
        if (idx === this.#ridden) this.#ridden = -1;
        continue;
      }
      let tx: number, tz: number, spd: number;
      if (idx === this.#ridden) {
        tx = -Math.sin(this.#steerYaw);
        tz = -Math.cos(this.#steerYaw);
        spd = this.#riddenSpeed;
      } else {
        h.wanderTimer -= dt;
        const t = h.rag.torsoLink;
        const wx = h.anchor.x + t.pos[0];
        const wz = h.anchor.z + t.pos[2];
        const toCx = PARK.x - wx;
        const toCz = PARK.z - wz;
        if (Math.hypot(toCx, toCz) > ROAM) {
          h.wanderYaw = Math.atan2(toCx, toCz);
          h.wanderTimer = 2 + Math.random() * 3;
        } else if (h.wanderTimer <= 0) {
          h.wanderYaw += (Math.random() - 0.5) * 1.6;
          h.wanderTimer = 3 + Math.random() * 5;
          const r = Math.random();
          h.speedNonDim = r < 0.7 ? 0.2 + Math.random() * 0.2 : r < 0.93 ? 0.45 + Math.random() * 0.15 : 0.7 + Math.random() * 0.15;
        }
        tx = Math.sin(h.wanderYaw);
        tz = Math.cos(h.wanderYaw);
        spd = h.speedNonDim;
      }
      const k = 1 - Math.exp(-dt / GOAL_EASE);
      h.gx += (tx - h.gx) * k;
      h.gz += (tz - h.gz) * k;
      h.rag.setGoal(h.gx, h.gz);
      h.rag.setSpeed(this.#forceSpeed ?? spd);
      h.rag.update(dt);
    }
  }

  #poseMesh(mesh: THREE.Mesh, link: Link, ox: number, oy: number, oz: number): void {
    mesh.position.set(ox + link.pos[0], oy + link.pos[1], oz + link.pos[2]);
    mesh.quaternion.set(link.quat[0], link.quat[1], link.quat[2], link.quat[3]);
  }

  nearest(px: number, pz: number, maxDist: number): number {
    if (!this.#ready) return -1;
    let best = -1;
    let bd = maxDist * maxDist;
    for (let i = 0; i < this.#horses.length; i++) {
      const h = this.#horses[i];
      const d = (h.wx - px) * (h.wx - px) + (h.wz - pz) * (h.wz - pz);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  mount(i: number): void { if (i >= 0 && i < this.#horses.length) this.#ridden = i; }
  dismount(): void { this.#ridden = -1; }
  get riddenIndex(): number { return this.#ridden; }
  steer(yaw: number): void { this.#steerYaw = yaw; }
  setRiddenSpeed(nonDim: number): void { this.#riddenSpeed = Math.max(0, Math.min(0.9, nonDim)); }
  debugForceSpeed(nonDim: number | null): void { this.#forceSpeed = nonDim; }
  jumpRidden(): void { if (this.#ridden >= 0) this.#horses[this.#ridden].rag.jump(); }
  debugJumpAll(): void { for (const h of this.#horses) if (h.downTimer <= 0) h.rag.jump(); }
  riddenSeat(outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
    if (this.#ridden < 0) return false;
    const h = this.#horses[this.#ridden];
    outQuat.set(h.wq[0], h.wq[1], h.wq[2], h.wq[3]);
    outPos.set(h.wx, h.wy + 0.75 * SCALE, h.wz);
    return true;
  }

  update(_dt: number, _camera: THREE.Camera): void {
    if (!this.#ready) return;
    for (const h of this.#horses) {
      const t = h.rag.torsoLink;
      const ox = h.anchor.x;
      const oy = PLATFORM_Y;
      const oz = h.anchor.z;
      h.wx = ox + t.pos[0]; h.wy = oy + t.pos[1]; h.wz = oz + t.pos[2];
      h.wq[0] = t.quat[0]; h.wq[1] = t.quat[1]; h.wq[2] = t.quat[2]; h.wq[3] = t.quat[3];
      this.#poseMesh(h.m.parts[0], t, ox, oy, oz);
      const legs = h.rag.legLinks;
      for (let i = 0; i < legs.length; i++) {
        this.#poseMesh(h.m.parts[1 + i * 2], legs[i].thigh, ox, oy, oz);
        this.#poseMesh(h.m.parts[2 + i * 2], legs[i].shank, ox, oy, oz);
      }
    }
  }
}
