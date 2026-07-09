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
  head0: SignalHead;
  head1: SignalHead;
};

type SignalHead = {
  root: THREE.Group;
  bulbs: Record<LightState, THREE.Mesh>;
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
    const approaches = signal.approaches.filter((a) => a.axis === axis);
    if (approaches.length === 0) {
      gantry.root.visible = false;
      return;
    }
    gantry.root.visible = true;
    gantry.root.rotation.y = this.#axisRotation(signal, axis);
    const state = this.#signals.stateForAxis(signal, axis, timeS);
    this.#orientHeads(gantry, approaches);
    this.#setBulbs(gantry.head0.bulbs, state);
    this.#setBulbs(gantry.head1.bulbs, state);
  }

  #axisRotation(signal: TrafficSignal, axis: 0 | 1): number {
    const app = signal.approaches.find((a) => a.axis === axis);
    if (app) return Math.atan2(app.tangentX, app.tangentZ);
    const base = Math.atan2(signal.axisX, signal.axisZ);
    return axis === 0 ? base : base + Math.PI * 0.5;
  }

  #orientHeads(gantry: SignalGantry, approaches: TrafficSignal["approaches"]): void {
    const axisYaw = gantry.root.rotation.y;
    const axisX = Math.sin(axisYaw);
    const axisZ = Math.cos(axisYaw);
    let pos = false;
    let neg = false;
    let maxLanes = 1;
    for (const app of approaches) {
      const dot = app.tangentX * axisX + app.tangentZ * axisZ;
      if (dot >= 0) pos = true;
      else neg = true;
      maxLanes = Math.max(maxLanes, app.lanes);
    }

    const bothDirections = pos && neg;
    gantry.head0.root.visible = true;
    gantry.head1.root.visible = bothDirections || maxLanes > 1 || approaches.length > 1;

    // Approach tangents point toward the junction. Signal faces point back at
    // the approaching drivers; one-way multi-lane approaches get matching heads.
    if (bothDirections) {
      gantry.head0.root.rotation.y = 0;
      gantry.head1.root.rotation.y = Math.PI;
    } else if (pos) {
      gantry.head0.root.rotation.y = Math.PI;
      gantry.head1.root.rotation.y = Math.PI;
    } else {
      gantry.head0.root.rotation.y = 0;
      gantry.head1.root.rotation.y = 0;
    }
    gantry.head0.root.position.x = bothDirections ? 3.95 : maxLanes > 1 ? 4.35 : 2.95;
    gantry.head1.root.position.x = bothDirections ? -1.1 : 0.9;
  }

  #makeRig(): LightRig {
    const root = new THREE.Group();
    root.name = "TrafficLightRig";
    root.userData.trafficLightRig = true;
    const poleH = 7.05;
    const poleX = -5.8;
    const armY = 6.46;
    const armX = 0.85;
    const headY = 5.78;
    const headFaceZ = 0.37;
    const poleGeo = new THREE.CylinderGeometry(0.24, 0.29, poleH, 14);
    const armGeo = new THREE.BoxGeometry(13.5, 0.42, 0.38);
    const headGeo = new THREE.BoxGeometry(1.18, 2.34, 0.68);
    const bulbGeo = new THREE.CircleGeometry(0.33, 22);

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

      const makeHead = (x: number, z: number, yaw: number): SignalHead => {
        const head = new THREE.Group();
        head.position.set(x, headY, shiftZ + z);
        head.rotation.y = yaw;
        gantry.add(head);

        const h = new THREE.Mesh(headGeo, this.#headMat);
        head.add(h);
        const red = new THREE.Mesh(bulbGeo, this.#redDim);
        const yellow = new THREE.Mesh(bulbGeo, this.#yellowDim);
        const green = new THREE.Mesh(bulbGeo, this.#greenDim);
        red.position.set(0, 0.74, headFaceZ);
        yellow.position.set(0, 0, headFaceZ);
        green.position.set(0, -0.74, headFaceZ);
        head.add(red, yellow, green);
        return { root: head, bulbs: { red, yellow, green } };
      };

      return {
        root: gantry,
        head0: makeHead(3.95, -0.28, 0),
        head1: makeHead(-1.1, 0.28, Math.PI)
      };
    };

    return {
      root,
      axis0: makeGantry("TrafficLightAxis0", -0.18),
      axis1: makeGantry("TrafficLightAxis1", 0.18)
    };
  }
}
