import * as THREE from "three/webgpu";
import {
  clamp,
  color,
  instancedBufferAttribute,
  mx_noise_float,
  smoothstep,
  uniform,
  uv,
  vec3
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import type { WorldMap } from "../world/heightmap";
import { CAR_SKID_TUNING } from "../vehicles/car/tuning";

type N = any;

const MAX_MARKS = 420;
const LIFT = 0.035;

type DriveLike = {
  mode: string;
  renderPosition: THREE.Vector3;
  renderQuaternion: THREE.Quaternion;
  driveSlideFeedback: {
    intensity: number;
    track: number;
    rear: number;
  };
  speed: number;
};

/**
 * Soft asphalt tire streaks shed under the rear wheels while sliding /
 * handbraking. Marks sit slightly above rideGround, fade over a few seconds,
 * and use normal blending so they read as rubber on road — not glow trails.
 */
export class SkidMarks {
  mesh: THREE.InstancedMesh;
  #spawn: THREE.InstancedBufferAttribute;
  #write = 0;
  #count = 0;
  #distAcc = 0;
  #uTime = uniform(0);
  #uLife = uniform(5.5);
  #uOpacity = uniform(0.42);
  #map: WorldMap;
  #mat4 = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #fwd = new THREE.Vector3();
  #right = new THREE.Vector3();
  #up = new THREE.Vector3(0, 1, 0);
  #scale = new THREE.Vector3();
  #q = new THREE.Quaternion();
  #wiggle = new THREE.Quaternion();
  #basis = new THREE.Matrix4();

  constructor(scene: THREE.Scene, map: WorldMap) {
    this.#map = map;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.#spawn = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKS), 1);
    this.#spawn.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MAX_MARKS; i++) this.#spawn.setX(i, -999);

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 2;
    mat.polygonOffsetUnits = 2;
    mat.fog = true;
    mat.toneMapped = false;

    const aSpawn = instancedBufferAttribute(this.#spawn) as unknown as N;
    const age = clamp(this.#uTime.sub(aSpawn).div(this.#uLife), 0, 1) as N;
    const fade = age.oneMinus().pow(1.35).mul(smoothstep(0.0, 0.08, age)) as N;
    const p = (uv() as N).mul(2).sub(1);
    // Soft elongated rubber dab — longer along local X (travel), soft edges.
    const edge = smoothstep(1.0, 0.35, p.x.abs().mul(0.92).add(p.y.abs().mul(1.35))) as N;
    const grain = mx_noise_float(vec3(p.x.mul(4.2), p.y.mul(9.0), aSpawn.mul(17.0)) as N)
      .mul(0.18)
      .add(0.82);
    mat.colorNode = (color(0x1c1a18) as N).mul(LIGHT_SCALE * 0.55);
    mat.opacityNode = edge.mul(fade).mul(this.#uOpacity).mul(grain);

    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_MARKS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  update(_dt: number, elapsed: number, player: DriveLike) {
    const tune = CAR_SKID_TUNING.values;
    this.#uTime.value = elapsed;
    this.#uLife.value = Math.max(0.5, tune.markLife);
    this.#uOpacity.value = tune.markOpacity;

    const driving = player.mode === "drive" || player.mode === "scooter";
    const intensity = driving ? player.driveSlideFeedback.intensity : 0;
    if (intensity > 0.06 && player.speed > 2) {
      this.#distAcc += player.speed * _dt * (0.55 + intensity);
      const spacing = Math.max(0.15, tune.markSpacing);
      while (this.#distAcc >= spacing) {
        this.#distAcc -= spacing;
        this.#stampPair(player, elapsed, intensity);
      }
    } else {
      this.#distAcc = 0;
    }
  }

  #stampPair(player: DriveLike, elapsed: number, intensity: number) {
    const q = player.renderQuaternion;
    this.#fwd.set(0, 0, -1).applyQuaternion(q);
    this.#fwd.y = 0;
    if (this.#fwd.lengthSq() < 1e-6) return;
    this.#fwd.normalize();
    this.#right.set(1, 0, 0).applyQuaternion(q);
    this.#right.y = 0;
    if (this.#right.lengthSq() < 1e-6) this.#right.set(1, 0, 0);
    else this.#right.normalize();

    const slide = player.driveSlideFeedback;
    const track = slide.track;
    const rear = slide.rear;
    const px = player.renderPosition.x;
    const pz = player.renderPosition.z;
    const baseY = player.renderPosition.y;

    this.#stamp(
      px - this.#right.x * track - this.#fwd.x * rear,
      pz - this.#right.z * track - this.#fwd.z * rear,
      baseY,
      elapsed,
      intensity
    );
    this.#stamp(
      px + this.#right.x * track - this.#fwd.x * rear,
      pz + this.#right.z * track - this.#fwd.z * rear,
      baseY,
      elapsed,
      intensity
    );
  }

  #stamp(x: number, z: number, refY: number, elapsed: number, intensity: number) {
    const tune = CAR_SKID_TUNING.values;
    const y = this.#map.rideGround(x, z, refY) + LIFT;
    const i = this.#write;
    this.#write = (this.#write + 1) % MAX_MARKS;
    this.#count = Math.max(this.#count, Math.min(MAX_MARKS, i + 1));
    this.mesh.count = this.#count;

    // Plane lies in XY; map local X→travel, Y→lateral, Z→up.
    this.#basis.makeBasis(this.#fwd, this.#right, this.#up);
    this.#q.setFromRotationMatrix(this.#basis);
    this.#wiggle.setFromAxisAngle(this.#up, (Math.random() - 0.5) * 0.12);
    this.#q.multiply(this.#wiggle);

    const len = tune.markLength * (0.75 + 0.55 * intensity);
    const wid = tune.markWidth * (0.85 + 0.4 * intensity);
    this.#mat4.compose(this.#pos.set(x, y, z), this.#q, this.#scale.set(len, wid, 1));
    this.mesh.setMatrixAt(i, this.#mat4);
    this.#spawn.setX(i, elapsed);

    this.mesh.instanceMatrix.needsUpdate = true;
    this.#spawn.needsUpdate = true;
  }
}
