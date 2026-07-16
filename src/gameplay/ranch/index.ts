import * as THREE from "three/webgpu";
import type { WorldMap } from "../../world/heightmap";
import type { Physics } from "../../core/physics";
import type { GameSite } from "../siteGate";
import { HORSE, GOAT, type CreatureSpec } from "../../creatures/quadruped.ts";
import { CreaturePen, partMesh } from "./creaturePen";
import { RANCH_CENTER, RANCH_RADIUS, RANCH_SITE_PADS, HORSE_PADDOCK, GOAT_PEN } from "./meta";

/**
 * The Marina creature ranch — two more overnight-learning experiments beside
 * Biscuit's puppy nursery, each pen wired to its own trainer's checkpoint:
 *
 *  - HORSE PADDOCK ("Wild Ones"): three foals + a ring of show-jump rails.
 *    Their trainer runs the gallop-and-bound config (gallopBlend/boundReward),
 *    so overnight they should go from wobbling foals to bounding jumpers.
 *  - GOAT PEN ("Spring Goats"): two kids trained under doubled random shoves
 *    (SHOVE=2 balance-chaos experiment) — the sure-footed ones.
 *
 * Everything heavy is behind the lazy "ranch" optional site + siteGate.
 */

function dressHorse(s: CreatureSpec): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  const COAT = 0xa06a3c;
  const DARK = 0x7d5129;
  const torso = partMesh(new THREE.BoxGeometry(s.torso.half[0] * 2, s.torso.half[1] * 1.9, s.torso.half[2] * 2), COAT, 0.68);
  parts.push(torso);
  const neck = partMesh(new THREE.CylinderGeometry(0.07, 0.12, 0.44, 8), DARK, 0.72);
  neck.position.set(0, 0.24, 0.5);
  neck.rotation.x = -0.95;
  torso.add(neck);
  const head = partMesh(new THREE.BoxGeometry(0.13, 0.16, 0.3), DARK, 0.72);
  head.name = "horseHead"; // milestone accessories (plume) anchor here
  head.position.set(0, 0.44, 0.74);
  head.rotation.x = -0.35;
  torso.add(head);
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff2a4).multiplyScalar(0.18), transparent: true, opacity: 0.92, depthWrite: false, blending: THREE.AdditiveBlending });
  eyeMat.toneMapped = false;
  for (const sx of [-0.055, 0.055]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.017, 8, 6), eyeMat);
    eye.position.set(sx, 0.035, 0.13);
    head.add(eye);
  }
  const muzzle = partMesh(new THREE.BoxGeometry(0.1, 0.1, 0.14), 0x5e3d24, 0.78);
  muzzle.position.set(0, 0.4, 0.9);
  torso.add(muzzle);
  for (const sx of [-0.05, 0.05]) {
    const ear = partMesh(new THREE.ConeGeometry(0.035, 0.1, 6), 0x3b2716, 0.9);
    ear.position.set(sx, 0.56, 0.68);
    torso.add(ear);
  }
  const mane = partMesh(new THREE.BoxGeometry(0.04, 0.3, 0.42), 0x241408, 0.95);
  mane.position.set(0, 0.28, 0.52);
  mane.rotation.x = -0.95;
  torso.add(mane);
  const tail = partMesh(new THREE.CylinderGeometry(0.015, 0.06, 0.44, 6), 0x241408, 0.95);
  tail.position.set(0, 0.16, -0.56);
  tail.rotation.x = 0.7;
  torso.add(tail);
  for (const leg of s.legs) {
    const thigh = partMesh(new THREE.CapsuleGeometry(leg.thigh.radius, leg.thigh.halfHeight * 2, 4, 8), DARK, 0.76);
    parts.push(thigh);
    const shank = partMesh(new THREE.CapsuleGeometry(leg.shank.radius, leg.shank.halfHeight * 2, 4, 8), DARK, 0.76);
    const sock = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.04, leg.shank.radius * 1.08, 0.15, 8), 0xf0dcc0, 0.64);
    sock.position.set(0, -leg.shank.halfHeight * 0.48, 0);
    shank.add(sock);
    const hoof = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.15, leg.shank.radius * 0.9, 0.06, 8), 0x141010, 0.6);
    hoof.position.set(0, -leg.shank.halfHeight - 0.02, 0);
    shank.add(hoof);
    parts.push(shank);
  }
  return parts;
}

function dressGoat(s: CreatureSpec): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  const COAT = 0xe8e2d4;
  const DARK = 0xcfc4ae;
  const torso = partMesh(new THREE.BoxGeometry(s.torso.half[0] * 2, s.torso.half[1] * 1.9, s.torso.half[2] * 2), COAT, 0.82);
  parts.push(torso);
  const head = partMesh(new THREE.BoxGeometry(0.12, 0.13, 0.18), COAT, 0.8);
  head.position.set(0, 0.18, 0.36);
  head.rotation.x = -0.2;
  torso.add(head);
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe9a4).multiplyScalar(0.16), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  eyeMat.toneMapped = false;
  for (const sx of [-0.045, 0.045]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), eyeMat);
    eye.position.set(sx, 0.02, 0.09);
    head.add(eye);
  }
  const snout = partMesh(new THREE.BoxGeometry(0.07, 0.06, 0.08), DARK, 0.82);
  snout.position.set(0, -0.03, 0.12);
  head.add(snout);
  const beard = partMesh(new THREE.ConeGeometry(0.02, 0.07, 6), DARK, 0.9);
  beard.position.set(0, -0.09, 0.1);
  beard.rotation.x = Math.PI;
  head.add(beard);
  for (const sx of [-0.045, 0.045]) {
    const horn = partMesh(new THREE.ConeGeometry(0.018, 0.11, 6), 0x8f8574, 0.6);
    horn.position.set(sx, 0.09, -0.02);
    horn.rotation.x = 0.5;
    head.add(horn);
    const ear = partMesh(new THREE.BoxGeometry(0.04, 0.02, 0.09), DARK, 0.85);
    ear.position.set(sx * 1.6, 0.03, -0.02);
    ear.rotation.z = sx > 0 ? -0.5 : 0.5;
    head.add(ear);
  }
  const tail = partMesh(new THREE.BoxGeometry(0.03, 0.08, 0.03), COAT, 0.85);
  tail.position.set(0, 0.12, -0.32);
  tail.rotation.x = -0.5;
  torso.add(tail);
  for (const leg of s.legs) {
    const thigh = partMesh(new THREE.CapsuleGeometry(leg.thigh.radius, leg.thigh.halfHeight * 2, 4, 8), DARK, 0.82);
    parts.push(thigh);
    const shank = partMesh(new THREE.CapsuleGeometry(leg.shank.radius, leg.shank.halfHeight * 2, 4, 8), COAT, 0.82);
    const hoof = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.05, leg.shank.radius * 0.85, 0.05, 8), 0x2b2620, 0.6);
    hoof.position.set(0, -leg.shank.halfHeight - 0.015, 0);
    shank.add(hoof);
    parts.push(shank);
  }
  return parts;
}

// ------------------------------------------------------ milestone accessories
// Earned by the trainer passing scripted trials (rl/tools/horseMilestones.ts):
// walk 5s -> saddle · gallop 5s -> plumed headpiece · jump+land -> gold wreath.
// Base-dim geometry attached to the torso, so it grows with the horse.

function buildSaddle(torso: THREE.Mesh): void {
  const blanket = partMesh(new THREE.BoxGeometry(0.5, 0.035, 0.5), 0x15a6b0, 0.42);
  blanket.position.set(0, 0.17, -0.03);
  torso.add(blanket);
  const saddle = partMesh(new THREE.BoxGeometry(0.36, 0.045, 0.32), 0x2b1a12, 0.58);
  saddle.position.set(0, 0.205, -0.06);
  torso.add(saddle);
  const horn = partMesh(new THREE.CylinderGeometry(0.02, 0.03, 0.06, 6), 0x2b1a12, 0.58);
  horn.position.set(0, 0.24, 0.08);
  torso.add(horn);
}

function buildPlume(torso: THREE.Mesh): void {
  const head = torso.getObjectByName("horseHead");
  if (!head) return;
  const band = partMesh(new THREE.CylinderGeometry(0.085, 0.085, 0.035, 10), 0xc9a227, 0.35);
  band.position.set(0, 0.075, -0.05);
  band.rotation.x = 0.35;
  head.add(band);
  const plume = partMesh(new THREE.ConeGeometry(0.045, 0.22, 8), 0xd0312d, 0.5);
  plume.position.set(0, 0.19, -0.07);
  head.add(plume);
  const tip = partMesh(new THREE.SphereGeometry(0.025, 8, 6), 0xffe08a, 0.4);
  tip.position.set(0, 0.31, -0.07);
  head.add(tip);
}

function buildWreath(torso: THREE.Mesh): void {
  const wreath = partMesh(new THREE.TorusGeometry(0.16, 0.028, 8, 20), 0xc9a227, 0.3);
  wreath.position.set(0, 0.2, 0.42);
  wreath.rotation.x = Math.PI / 2 - 0.55; // hangs around the neck root
  torso.add(wreath);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leaf = partMesh(new THREE.ConeGeometry(0.02, 0.06, 5), 0x3f7d2c, 0.55);
    leaf.position.set(Math.cos(a) * 0.16, 0.2 + Math.sin(a) * 0.05, 0.42 + Math.sin(a) * 0.14);
    leaf.rotation.z = a;
    torso.add(leaf);
  }
}

export class Ranch {
  readonly root = new THREE.Group();
  #pens: CreaturePen[] = [];

  constructor(map: WorldMap, physics: Physics, scene: THREE.Scene) {
    const horsePen = new CreaturePen(
      {
        id: "horses",
        title: "WILD ONES",
        center: { x: HORSE_PADDOCK.x, z: HORSE_PADDOCK.z },
        radius: HORSE_PADDOCK.r,
        count: 3,
        spec: HORSE,
        policyUrl: "/models/horse_policy.json",
        dress: dressHorse,
        scaleForGen: (gen) => 1.0 + 1.1 * Math.min(1, gen / 400),
        statusForGen: (gen) =>
          gen <= 0 ? "newborn foals" : gen < 40 ? "finding their legs" : gen < 120 ? "learning to run" : gen < 250 ? "cantering!" : "galloping & jumping!",
        roamSpeed: () => {
          const r = Math.random();
          return r < 0.6 ? 0.18 + Math.random() * 0.2 : r < 0.9 ? 0.45 + Math.random() * 0.15 : 0.68 + Math.random() * 0.15;
        },
        jumps: { count: 4, ringR: 15, railTop: 0.5 },
        signAngle: Math.PI * 0.72,
        brainHeight: 1.0,
        milestones: {
          url: "/models/horse_milestones.json",
          accessories: [
            { key: "walk", label: "walk", build: buildSaddle },
            { key: "gallop", label: "gallop", build: buildPlume },
            { key: "jump", label: "jump", build: buildWreath }
          ]
        }
      },
      map.groundTop(HORSE_PADDOCK.x, HORSE_PADDOCK.z),
      physics
    );
    const goatPen = new CreaturePen(
      {
        id: "goats",
        title: "SPRING GOATS",
        center: { x: GOAT_PEN.x, z: GOAT_PEN.z },
        radius: GOAT_PEN.r,
        count: 2,
        spec: GOAT,
        policyUrl: "/models/goat_policy.json",
        dress: dressGoat,
        scaleForGen: (gen) => 0.7 + 0.55 * Math.min(1, gen / 300),
        statusForGen: (gen) =>
          gen <= 0 ? "wobbly kids" : gen < 40 ? "learning to stand" : gen < 120 ? "finding footing" : gen < 250 ? "sure-footed" : "unshakeable!",
        roamSpeed: () => (Math.random() < 0.7 ? 0.16 + Math.random() * 0.18 : 0.42 + Math.random() * 0.2),
        signAngle: Math.PI * 0.3,
        brainHeight: 0.7
      },
      map.groundTop(GOAT_PEN.x, GOAT_PEN.z),
      physics
    );
    this.#pens = [horsePen, goatPen];
    for (const pen of this.#pens) this.root.add(pen.root);
    this.root.visible = false;
    scene.add(this.root);
  }

  siteHooks(): GameSite {
    return {
      id: "ranch",
      contains: (x, z, pad) => {
        const dx = x - RANCH_CENTER.x;
        const dz = z - RANCH_CENTER.z;
        const r = RANCH_RADIUS + pad;
        return dx * dx + dz * dz < r * r;
      },
      activatePad: RANCH_SITE_PADS.activate,
      deactivatePad: RANCH_SITE_PADS.deactivate,
      setAwake: (on) => {
        this.root.visible = on;
        for (const pen of this.#pens) pen.setAwake(on);
      }
    };
  }

  update(dt: number, camera: THREE.Camera): void {
    for (const pen of this.#pens) pen.update(dt, camera);
  }

  debugState(): ReturnType<CreaturePen["debugState"]>[] {
    return this.#pens.map((pen) => pen.debugState());
  }
}

export function createRanch(map: WorldMap, physics: Physics, scene: THREE.Scene): Ranch {
  return new Ranch(map, physics, scene);
}
