import * as THREE from "three/webgpu";
import { PICKLEBALL_TUNING as T } from "./constants";
import type { PickleballSide } from "./types";

type Owned = { dispose(): void };

export type PickleballRigPose = {
  speed: number;
  swingTime: number;
  elapsed: number;
  lookX: number;
  lookY: number;
};

const _worldPosition = new THREE.Vector3();
const _worldQuaternion = new THREE.Quaternion();
const _courtQuaternion = new THREE.Quaternion();

/** Lightweight articulated placeholder athlete with an attached paddle. */
export class PickleballPlayerRig {
  readonly side: PickleballSide;
  readonly group = new THREE.Group();
  readonly paddleAnchor = new THREE.Group();

  #body = new THREE.Group();
  #torso = new THREE.Group();
  #head = new THREE.Group();
  #armL = new THREE.Group();
  #foreL = new THREE.Group();
  #armR = new THREE.Group();
  #foreR = new THREE.Group();
  #legL = new THREE.Group();
  #shinL = new THREE.Group();
  #legR = new THREE.Group();
  #shinR = new THREE.Group();
  #owned: Owned[] = [];

  constructor(side: PickleballSide) {
    this.side = side;
    this.group.name = side === 0 ? "pickleball-player-near" : "pickleball-player-far";
    this.group.rotation.y = side === 0 ? Math.PI : 0;
    this.group.add(this.#body);
    this.#build();
  }

  /** Apply an allocation-free procedural idle/run/swing pose. */
  pose(state: PickleballRigPose): void {
    const run = THREE.MathUtils.clamp(state.speed / T.playerSpeed, 0, 1);
    const cycle = state.elapsed * (7.2 + run * 3.4);
    const stride = Math.sin(cycle) * 0.72 * run;
    const idle = Math.sin(state.elapsed * 2.1 + this.side * 1.7);

    this.#body.position.y = 0.015 + Math.abs(Math.sin(cycle)) * 0.035 * run + idle * 0.004;
    this.#body.rotation.z = Math.sin(cycle * 0.5) * 0.025 * run;
    this.#torso.rotation.set(0.04 + run * 0.08, 0, -stride * 0.025);
    this.#head.rotation.set(-0.03 + state.lookY * 0.12, state.lookX * 0.22, -idle * 0.012);

    this.#legL.rotation.set(stride, 0, 0.025);
    this.#legR.rotation.set(-stride, 0, -0.025);
    this.#shinL.rotation.x = Math.max(0, -stride) * 0.75;
    this.#shinR.rotation.x = Math.max(0, stride) * 0.75;

    this.#armL.rotation.set(-stride * 0.55 - 0.12, 0, 0.08);
    this.#foreL.rotation.set(-0.3, 0, 0);
    this.#armR.rotation.set(stride * 0.35 - 0.24, -0.08, -0.13);
    this.#foreR.rotation.set(-0.55, 0.08, -0.03);

    if (state.swingTime >= 0 && state.swingTime <= T.swingDuration) {
      const p = THREE.MathUtils.clamp(state.swingTime / T.swingDuration, 0, 1);
      const wind = THREE.MathUtils.smoothstep(p, 0, 0.28);
      const drive = THREE.MathUtils.smoothstep(p, 0.25, 0.58);
      const settle = THREE.MathUtils.smoothstep(p, 0.64, 1);
      const stroke = drive - settle * 0.72;

      // Compact forehand: coil, accelerate across the body, finish high.
      this.#torso.rotation.y = -0.32 * wind + 0.68 * stroke;
      this.#torso.rotation.x += 0.08 * stroke;
      this.#armR.rotation.x = THREE.MathUtils.lerp(-0.22, -1.18, drive) + settle * 0.42;
      this.#armR.rotation.y = -0.18 - 0.78 * wind + 1.65 * stroke;
      this.#armR.rotation.z = -0.26 - 0.42 * drive;
      this.#foreR.rotation.x = -0.78 + 0.52 * drive;
      this.#foreR.rotation.y = -0.18 + 0.62 * stroke;
      this.#head.rotation.y -= 0.12 * wind - 0.24 * stroke;
    }
  }

  /** Reads the animated paddle face in court-local coordinates. */
  readPaddlePose(courtRoot: THREE.Object3D, outCenter: THREE.Vector3, outNormal: THREE.Vector3): void {
    courtRoot.updateWorldMatrix(true, false);
    this.paddleAnchor.updateWorldMatrix(true, false);
    this.paddleAnchor.getWorldPosition(_worldPosition);
    outCenter.copy(_worldPosition);
    courtRoot.worldToLocal(outCenter);

    this.paddleAnchor.getWorldQuaternion(_worldQuaternion);
    courtRoot.getWorldQuaternion(_courtQuaternion).invert();
    outNormal.set(0, 0, 1).applyQuaternion(_worldQuaternion).applyQuaternion(_courtQuaternion).normalize();
  }

  worldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateWorldMatrix(true, false);
    return this.group.getWorldPosition(out);
  }

  dispose(): void {
    for (const item of this.#owned) item.dispose();
    this.#owned.length = 0;
    this.group.removeFromParent();
  }

  #build(): void {
    const skin = new THREE.MeshStandardNodeMaterial({ color: this.side === 0 ? 0xc98762 : 0x8f5d45, roughness: 0.86 });
    const shirt = new THREE.MeshStandardNodeMaterial({ color: this.side === 0 ? 0xe25743 : 0x36a0a8, roughness: 0.9 });
    const shorts = new THREE.MeshStandardNodeMaterial({ color: 0x202733, roughness: 0.92 });
    const shoe = new THREE.MeshStandardNodeMaterial({ color: 0xf2eee4, roughness: 0.82 });
    const hair = new THREE.MeshStandardNodeMaterial({ color: this.side === 0 ? 0x3b251b : 0x211b18, roughness: 1 });
    const paddleFace = new THREE.MeshStandardNodeMaterial({
      color: this.side === 0 ? 0xf1c84c : 0xed6f91,
      roughness: 0.58,
      metalness: 0.04
    });
    const paddleEdge = new THREE.MeshStandardNodeMaterial({ color: 0x191d20, roughness: 0.48 });
    this.#owned.push(skin, shirt, shorts, shoe, hair, paddleFace, paddleEdge);

    const geometry = (g: THREE.BufferGeometry) => {
      this.#owned.push(g);
      return g;
    };
    const box = (parent: THREE.Object3D, w: number, h: number, d: number, material: THREE.Material, y: number) => {
      const mesh = new THREE.Mesh(geometry(new THREE.BoxGeometry(w, h, d)), material);
      mesh.position.y = y;
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    const pelvis = box(this.#body, 0.38, 0.22, 0.25, shorts, 0.72);
    pelvis.name = "pelvis";

    this.#torso.position.y = 0.78;
    this.#body.add(this.#torso);
    const chest = box(this.#torso, 0.52, 0.64, 0.28, shirt, 0.31);
    chest.name = "torso";

    this.#head.position.y = 0.69;
    this.#torso.add(this.#head);
    const neck = box(this.#head, 0.13, 0.13, 0.13, skin, -0.02);
    neck.name = "neck";
    const headMesh = new THREE.Mesh(geometry(new THREE.SphereGeometry(0.19, 12, 9)), skin);
    headMesh.position.y = 0.18;
    headMesh.scale.set(0.9, 1.12, 0.92);
    headMesh.castShadow = true;
    this.#head.add(headMesh);
    const hairMesh = new THREE.Mesh(geometry(new THREE.SphereGeometry(0.195, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.48)), hair);
    hairMesh.position.y = 0.24;
    hairMesh.scale.set(0.92, 0.8, 0.95);
    hairMesh.castShadow = true;
    this.#head.add(hairMesh);

    this.#buildArm(1, this.#armL, this.#foreL, skin, shirt, false, paddleFace, paddleEdge, geometry, box);
    this.#buildArm(-1, this.#armR, this.#foreR, skin, shirt, true, paddleFace, paddleEdge, geometry, box);
    this.#buildLeg(1, this.#legL, this.#shinL, skin, shorts, shoe, geometry, box);
    this.#buildLeg(-1, this.#legR, this.#shinR, skin, shorts, shoe, geometry, box);
  }

  #buildArm(
    sideX: 1 | -1,
    arm: THREE.Group,
    fore: THREE.Group,
    skin: THREE.Material,
    shirt: THREE.Material,
    hasPaddle: boolean,
    paddleFace: THREE.Material,
    paddleEdge: THREE.Material,
    geometry: (g: THREE.BufferGeometry) => THREE.BufferGeometry,
    box: (parent: THREE.Object3D, w: number, h: number, d: number, material: THREE.Material, y: number) => THREE.Mesh
  ): void {
    arm.position.set(sideX * 0.31, 0.56, 0);
    this.#torso.add(arm);
    box(arm, 0.17, 0.39, 0.18, shirt, -0.18);
    fore.position.y = -0.38;
    arm.add(fore);
    box(fore, 0.145, 0.36, 0.15, skin, -0.17);
    const hand = box(fore, 0.14, 0.16, 0.14, skin, -0.4);

    if (!hasPaddle) return;
    const paddle = new THREE.Group();
    paddle.name = "pickleball-paddle";
    paddle.position.set(0, -0.2, -0.015);
    hand.add(paddle);

    const handle = box(paddle, 0.055, 0.24, 0.055, paddleEdge, -0.09);
    handle.name = "pickleball-paddle-handle";
    const edgeGeometry = geometry(new THREE.CylinderGeometry(0.152, 0.152, 0.022, 20));
    edgeGeometry.rotateX(Math.PI / 2);
    const edge = new THREE.Mesh(edgeGeometry, paddleEdge);
    edge.position.y = -0.31;
    edge.scale.y = 1.18;
    edge.castShadow = true;
    paddle.add(edge);
    const faceGeometry = geometry(new THREE.CylinderGeometry(0.139, 0.139, 0.026, 20));
    faceGeometry.rotateX(Math.PI / 2);
    const face = new THREE.Mesh(faceGeometry, paddleFace);
    face.name = "pickleball-paddle-face";
    face.position.y = -0.31;
    face.scale.y = 1.18;
    face.castShadow = true;
    paddle.add(face);

    this.paddleAnchor.position.set(0, -0.31, 0);
    paddle.add(this.paddleAnchor);
  }

  #buildLeg(
    sideX: 1 | -1,
    leg: THREE.Group,
    shin: THREE.Group,
    skin: THREE.Material,
    shorts: THREE.Material,
    shoe: THREE.Material,
    geometry: (g: THREE.BufferGeometry) => THREE.BufferGeometry,
    box: (parent: THREE.Object3D, w: number, h: number, d: number, material: THREE.Material, y: number) => THREE.Mesh
  ): void {
    leg.position.set(sideX * 0.13, 0.68, 0);
    this.#body.add(leg);
    box(leg, 0.19, 0.34, 0.21, shorts, -0.16);
    box(leg, 0.155, 0.2, 0.17, skin, -0.42);
    shin.position.y = -0.5;
    leg.add(shin);
    box(shin, 0.15, 0.43, 0.16, skin, -0.2);
    const foot = new THREE.Mesh(geometry(new THREE.BoxGeometry(0.18, 0.12, 0.31)), shoe);
    foot.position.set(0, -0.44, -0.075);
    foot.castShadow = true;
    shin.add(foot);
  }
}

