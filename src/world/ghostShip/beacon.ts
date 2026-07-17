import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import { sanFranciscoCivilNow, sfCivilFromScalarDays, sfCivilScalarDays } from "../solar";
import { ghostShipPoseForCivil, type GhostShipPose } from "./route";

/**
 * Request-free horizon proxy. The detailed ship, hot-tub solver, steam and star
 * shower stay in the optional ghostShip chunk until this silhouette approaches.
 */
export class GhostShipBeacon {
  readonly root = new THREE.Group();
  readonly pose: GhostShipPose;

  #scene: THREE.Scene;
  #map: WorldMap;
  #materials: THREE.Material[] = [];
  #geometries: THREE.BufferGeometry[] = [];
  #clockSyncMs = Date.now();
  #clockSyncCivil = sanFranciscoCivilNow(new Date(this.#clockSyncMs));
  #clockOverrideMs: number | null = null;

  constructor(scene: THREE.Scene, map: WorldMap) {
    this.#scene = scene;
    this.#map = map;
    this.root.name = "ghost_ship_horizon_proxy";

    const hullGeometry = new THREE.CapsuleGeometry(3.2, 22, 4, 10);
    hullGeometry.rotateX(Math.PI / 2);
    hullGeometry.scale(1, 0.62, 1);
    const hullMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x38215d).multiplyScalar(1.55),
      transparent: true,
      opacity: 0.68,
      depthWrite: false
    });
    const hull = new THREE.Mesh(hullGeometry, hullMaterial);
    hull.position.y = -1.2;
    this.root.add(hull);

    const mastGeometry = new THREE.CylinderGeometry(0.16, 0.24, 19, 5);
    const sailGeometry = new THREE.PlaneGeometry(11, 10, 1, 1);
    const spectralMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x73e9ff).multiplyScalar(1.8),
      transparent: true,
      opacity: 0.31,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    for (const z of [-6, 8]) {
      const mast = new THREE.Mesh(mastGeometry, spectralMaterial);
      mast.position.set(0, 8.5, z);
      const sail = new THREE.Mesh(sailGeometry, spectralMaterial);
      sail.position.set(0.3, 10, z - 0.2);
      sail.rotation.y = 0.06;
      this.root.add(mast, sail);
    }

    const bulbGeometry = new THREE.SphereGeometry(0.22, 6, 4);
    const bulbMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const bulbs = new THREE.InstancedMesh(bulbGeometry, bulbMaterial, 28);
    const dummy = new THREE.Object3D();
    const colors = [0x65f5ff, 0xff70dc, 0xffdc65, 0x9b7dff];
    for (let i = 0; i < 28; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const along = Math.floor(i / 2) / 13;
      dummy.position.set(side * (2.2 + Math.sin(along * Math.PI) * 2.1), 1.6, -19 + along * 38);
      dummy.updateMatrix();
      bulbs.setMatrixAt(i, dummy.matrix);
      bulbs.setColorAt(i, new THREE.Color(colors[i % colors.length]).multiplyScalar(2.2));
    }
    bulbs.instanceMatrix.needsUpdate = true;
    if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;
    this.root.add(bulbs);

    this.#geometries.push(hullGeometry, mastGeometry, sailGeometry, bulbGeometry);
    this.#materials.push(hullMaterial, spectralMaterial, bulbMaterial);
    this.pose = this.#poseAt(this.#clockSyncMs);
    this.#applyPose(this.pose);
    scene.add(this.root);
  }

  update(epochMs = Date.now()): GhostShipPose {
    epochMs = this.#clockOverrideMs ?? epochMs;
    if (Math.abs(epochMs - this.#clockSyncMs) >= 60_000) {
      this.#clockSyncMs = epochMs;
      this.#clockSyncCivil = sanFranciscoCivilNow(new Date(epochMs));
    }
    const next = this.#poseAt(epochMs);
    Object.assign(this.pose, next);
    this.#applyPose(this.pose);
    return this.pose;
  }

  /** Deterministic capture/probe clock. Null returns to the shared wall clock. */
  setClockOverride(epochMs: number | null): void {
    this.#clockOverrideMs = epochMs !== null && Number.isFinite(epochMs) ? epochMs : null;
    if (this.#clockOverrideMs !== null) {
      this.#clockSyncMs = this.#clockOverrideMs;
      this.#clockSyncCivil = sanFranciscoCivilNow(new Date(this.#clockOverrideMs));
    }
  }

  #poseAt(epochMs: number): GhostShipPose {
    const civil = sfCivilFromScalarDays(
      sfCivilScalarDays(this.#clockSyncCivil) + (epochMs - this.#clockSyncMs) / 86_400_000
    );
    return ghostShipPoseForCivil(civil, (x, z) => this.#map.effectiveGround(x, z));
  }

  horizontalDistanceTo(position: THREE.Vector3): number {
    return Math.hypot(position.x - this.pose.x, position.z - this.pose.z);
  }

  set detailedVisible(visible: boolean) {
    this.root.visible = !visible;
  }

  #applyPose(pose: GhostShipPose): void {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.order = "YXZ";
    this.root.rotation.set(pose.pitch, pose.yaw, pose.roll);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const geometry of this.#geometries) geometry.dispose();
    for (const material of this.#materials) material.dispose();
    this.#geometries.length = 0;
    this.#materials.length = 0;
    void this.#scene;
  }
}
