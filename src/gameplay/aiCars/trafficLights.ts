import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../../world/heightmap";
import type { LightState, TrafficSignal, TrafficSignalSystem } from "./trafficSignals.ts";

const MAX_VISIBLE = 120;
const VIEW_R = 260;

type LightRig = {
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
  #poleMat = new THREE.MeshStandardMaterial({ color: 0x2f3439, roughness: 0.62, metalness: 0.25 });
  #headMat = new THREE.MeshStandardMaterial({ color: 0x15191d, roughness: 0.7, metalness: 0.1 });
  #redDim = new THREE.MeshBasicMaterial({ color: 0x3a0806 });
  #yellowDim = new THREE.MeshBasicMaterial({ color: 0x332504 });
  #greenDim = new THREE.MeshBasicMaterial({ color: 0x063316 });
  #redLit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2b1f).multiplyScalar(LIGHT_SCALE * 0.55) });
  #yellowLit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd23a).multiplyScalar(LIGHT_SCALE * 0.48) });
  #greenLit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x36ff7a).multiplyScalar(LIGHT_SCALE * 0.5) });

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
      rig.root.rotation.y = Math.atan2(sig.axisZ, sig.axisX);
      this.#setBulbs(rig.bulbs0, this.#signals.stateForAxis(sig, 0, timeS));
      this.#setBulbs(rig.bulbs1, this.#signals.stateForAxis(sig, 1, timeS));
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
    bulbs.red.scale.setScalar(state === "red" ? 1.18 : 0.82);
    bulbs.yellow.scale.setScalar(state === "yellow" ? 1.18 : 0.82);
    bulbs.green.scale.setScalar(state === "green" ? 1.18 : 0.82);
  }

  #makeRig(): LightRig {
    const root = new THREE.Group();
    root.name = "TrafficLightRig";
    root.userData.trafficLightRig = true;
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 4.8, 8);
    const armGeo = new THREE.BoxGeometry(7.8, 0.12, 0.12);
    const headGeo = new THREE.BoxGeometry(0.42, 1.1, 0.22);
    const bulbGeo = new THREE.SphereGeometry(0.11, 10, 8);

    const pole = new THREE.Mesh(poleGeo, this.#poleMat);
    pole.position.set(-3.2, 2.4, 0);
    root.add(pole);

    const arm = new THREE.Mesh(armGeo, this.#poleMat);
    arm.position.set(0.45, 4.55, 0);
    root.add(arm);

    const makeHead = (x: number, z: number, yaw: number): Record<LightState, THREE.Mesh> => {
      const h = new THREE.Mesh(headGeo, this.#headMat);
      h.position.set(x, 4.05, z);
      h.rotation.y = yaw;
      root.add(h);
      const red = new THREE.Mesh(bulbGeo, this.#redDim);
      const yellow = new THREE.Mesh(bulbGeo, this.#yellowDim);
      const green = new THREE.Mesh(bulbGeo, this.#greenDim);
      red.position.set(x, 4.35, z + 0.13);
      yellow.position.set(x, 4.05, z + 0.13);
      green.position.set(x, 3.75, z + 0.13);
      red.rotation.y = yaw;
      yellow.rotation.y = yaw;
      green.rotation.y = yaw;
      root.add(red, yellow, green);
      return { red, yellow, green };
    };

    return {
      root,
      bulbs0: makeHead(2.8, -0.12, 0),
      bulbs1: makeHead(-0.8, 0.12, Math.PI)
    };
  }
}
