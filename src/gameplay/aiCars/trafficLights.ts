import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../../world/heightmap";
import type { LightState, TrafficSignal, TrafficSignalSystem } from "./trafficSignals.ts";

const MAX_VISIBLE = 120;
const VIEW_R = 260;

type LightRig = {
  root: THREE.Group;
  axis0: SignalGantry;
  axis1: SignalGantry;
};

type SignalGantry = {
  root: THREE.Group;
  bulbs0: Record<LightState, THREE.Mesh>;
  bulbs1: Record<LightState, THREE.Mesh>;
};

export class TrafficLightView {
  #scene: THREE.Scene;
  #map: WorldMap;
  #signals: TrafficSignalSystem;
  #pool: LightRig[] = [];
  #near: TrafficSignal[] = [];
  #poleMat = new THREE.MeshStandardMaterial({ color: 0x171a1d, roughness: 0.58, metalness: 0.32 });
  #headMat = new THREE.MeshStandardMaterial({ color: 0x0d1013, roughness: 0.68, metalness: 0.16 });
  #redDim = new THREE.MeshBasicMaterial({ color: 0x56110c });
  #yellowDim = new THREE.MeshBasicMaterial({ color: 0x4b3607 });
  #greenDim = new THREE.MeshBasicMaterial({ color: 0x0a4c22 });
  #redLit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2b1f).multiplyScalar(LIGHT_SCALE * 0.64) });
  #yellowLit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd23a).multiplyScalar(LIGHT_SCALE * 0.58) });
  #greenLit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x36ff7a).multiplyScalar(LIGHT_SCALE * 0.6) });

  constructor(scene: THREE.Scene, map: WorldMap, signals: TrafficSignalSystem) {
    this.#scene = scene;
    this.#map = map;
    this.#signals = signals;
    for (let i = 0; i < MAX_VISIBLE; i++) {
      const rig = this.#makeRig();
      rig.root.visible = false;
      this.#pool.push(rig);
      this.#scene.add(rig.root);
    }
  }

  update(playerPos: THREE.Vector3, timeS: number): void {
    this.#signals.nearest(playerPos.x, playerPos.z, VIEW_R, MAX_VISIBLE, this.#near);
    for (let i = 0; i < this.#pool.length; i++) {
      const rig = this.#pool[i];
      const sig = this.#near[i];
      if (!sig) {
        rig.root.visible = false;
        continue;
      }
      rig.root.visible = true;
      rig.root.position.set(sig.x, this.#map.effectiveGround(sig.x, sig.z), sig.z);
      this.#setGantry(rig.axis0, sig, 0, timeS);
      this.#setGantry(rig.axis1, sig, 1, timeS);
    }
  }

  dispose(): void {
    for (const rig of this.#pool) this.#scene.remove(rig.root);
    this.#pool.length = 0;
  }

  #setBulbs(bulbs: Record<LightState, THREE.Mesh>, state: LightState): void {
    bulbs.red.material = state === "red" ? this.#redLit : this.#redDim;
    bulbs.yellow.material = state === "yellow" ? this.#yellowLit : this.#yellowDim;
    bulbs.green.material = state === "green" ? this.#greenLit : this.#greenDim;
    bulbs.red.scale.setScalar(state === "red" ? 1.16 : 0.9);
    bulbs.yellow.scale.setScalar(state === "yellow" ? 1.16 : 0.9);
    bulbs.green.scale.setScalar(state === "green" ? 1.16 : 0.9);
  }

  #setGantry(gantry: SignalGantry, signal: TrafficSignal, axis: 0 | 1, timeS: number): void {
    if (!this.#hasAxis(signal, axis)) {
      gantry.root.visible = false;
      return;
    }
    gantry.root.visible = true;
    gantry.root.rotation.y = this.#axisRotation(signal, axis);
    const state = this.#signals.stateForAxis(signal, axis, timeS);
    this.#setBulbs(gantry.bulbs0, state);
    this.#setBulbs(gantry.bulbs1, state);
  }

  #hasAxis(signal: TrafficSignal, axis: 0 | 1): boolean {
    return signal.approaches.some((a) => a.axis === axis);
  }

  #axisRotation(signal: TrafficSignal, axis: 0 | 1): number {
    const app = signal.approaches.find((a) => a.axis === axis);
    if (app) return Math.atan2(app.tangentZ, app.tangentX);
    const base = Math.atan2(signal.axisZ, signal.axisX);
    return axis === 0 ? base : base + Math.PI * 0.5;
  }

  #makeRig(): LightRig {
    const root = new THREE.Group();
    root.name = "TrafficLightRig";
    root.userData.trafficLightRig = true;
    const poleH = 5.45;
    const poleX = -4.0;
    const armY = 5.05;
    const armX = 0.7;
    const headY = 4.52;
    const headFaceZ = 0.25;
    const poleGeo = new THREE.CylinderGeometry(0.13, 0.16, poleH, 10);
    const armGeo = new THREE.BoxGeometry(9.6, 0.22, 0.22);
    const headGeo = new THREE.BoxGeometry(0.74, 1.55, 0.38);
    const bulbGeo = new THREE.SphereGeometry(0.19, 14, 10);

    const makeGantry = (name: string, shiftZ: number): SignalGantry => {
      const gantry = new THREE.Group();
      gantry.name = name;
      root.add(gantry);

      const pole = new THREE.Mesh(poleGeo, this.#poleMat);
      pole.position.set(poleX, poleH * 0.5, shiftZ);
      gantry.add(pole);

      const arm = new THREE.Mesh(armGeo, this.#poleMat);
      arm.position.set(armX, armY, shiftZ);
      gantry.add(arm);

      const makeHead = (x: number, z: number, yaw: number): Record<LightState, THREE.Mesh> => {
        const head = new THREE.Group();
        head.position.set(x, headY, shiftZ + z);
        head.rotation.y = yaw;
        gantry.add(head);

        const h = new THREE.Mesh(headGeo, this.#headMat);
        head.add(h);
        const red = new THREE.Mesh(bulbGeo, this.#redDim);
        const yellow = new THREE.Mesh(bulbGeo, this.#yellowDim);
        const green = new THREE.Mesh(bulbGeo, this.#greenDim);
        red.position.set(0, 0.46, headFaceZ);
        yellow.position.set(0, 0, headFaceZ);
        green.position.set(0, -0.46, headFaceZ);
        head.add(red, yellow, green);
        return { red, yellow, green };
      };

      return {
        root: gantry,
        bulbs0: makeHead(3.25, -0.24, 0),
        bulbs1: makeHead(-0.7, 0.24, Math.PI)
      };
    };

    return {
      root,
      axis0: makeGantry("TrafficLightAxis0", -0.18),
      axis1: makeGantry("TrafficLightAxis1", 0.18)
    };
  }
}
