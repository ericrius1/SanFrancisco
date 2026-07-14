import * as THREE from "three/webgpu";
import type { FolderApi } from "tweakpane";
import { formatInteractPrompt } from "../../core/input";
import type { DebugMonitorBinding } from "../../ui/debug";
import type { GardenRakeMotion, GardenRakeTool } from "../../player/gardenRake";
import type { TeaGardenTerrain } from "./layout";
import {
  createSandSimulation,
  type SandSimulation,
  type SandSimulationStats
} from "./sandSimulation";

export const DRY_LANDSCAPE_CENTER = { x: -2344, z: 2166.5 } as const;
export const DRY_LANDSCAPE_RADII = { x: 10.8, z: 6.4 } as const;

const SAND_LIFT = 0.12;
const RIM_STONES = 96;
const PICKUP_RANGE = 3.7;
const RETURN_RANGE = 29;
// Far enough ahead that the handle top and both grips remain in front of the
// torso at the authored shaft elevation—not merely the tine head.
const RAKE_CONTACT_FORWARD = 1.44;
const RAKE_STAMP_MIN_DISTANCE = 0.018;
const RAKE_CONTACT_EPSILON = 0.28;
const RAKE_RACK = { x: -2354.45, z: 2169.15 } as const;

const ROCKS = [
  { x: -2341.05, z: 2164.55, scale: 1.42, yaw: 0.36 },
  { x: -2342.35, z: 2164.1, scale: 0.68, yaw: 1.15 },
  { x: -2340.05, z: 2165.35, scale: 0.58, yaw: 2.18 },
  { x: -2347.15, z: 2164.9, scale: 1.03, yaw: 2.45 },
  { x: -2348.08, z: 2165.52, scale: 0.52, yaw: 0.72 },
  { x: -2345.05, z: 2169.1, scale: 0.76, yaw: 1.76 }
] as const;

export type DryLandscapeDebugState = {
  held: boolean;
  raking: boolean;
  rakeEngaged: boolean;
  insideSand: boolean;
  distanceToRake: number;
  contact: { x: number; y: number; z: number };
  /** Tine-head back toward player direction, for pose/clearance diagnostics. */
  pull: { x: number; z: number };
  simulation: SandSimulationStats;
};

export type DryLandscape = {
  group: THREE.Group;
  update(dt: number, time: number, player: { x: number; y: number; z: number }, mode: string): void;
  interact(player: { x: number; y: number; z: number }, mode: string): boolean;
  addTuning(folder: FolderApi): DebugMonitorBinding[];
  syncTuning(): void;
  dispose(): void;
  debugState(): DryLandscapeDebugState;
};

export type DryLandscapeOptions = {
  renderer: THREE.WebGPURenderer;
  onCarryRake?: (rake: GardenRakeTool | null) => void;
  onRakeMotion?: (motion: Readonly<GardenRakeMotion> | null) => void;
  notify?: (message: string, seconds?: number) => void;
};

/** Elliptical activity mask shared by the sand, rake, and grass scatter. */
export function inDryLandscape(x: number, z: number, pad = 0): boolean {
  const rx = Math.max(0.1, DRY_LANDSCAPE_RADII.x + pad);
  const rz = Math.max(0.1, DRY_LANDSCAPE_RADII.z + pad);
  const nx = (x - DRY_LANDSCAPE_CENTER.x) / rx;
  const nz = (z - DRY_LANDSCAPE_CENTER.z) / rz;
  return nx * nx + nz * nz <= 1;
}

function hash(index: number, salt: number): number {
  let value = Math.imul(index ^ salt, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function createRim(map: TeaGardenTerrain): THREE.InstancedMesh {
  const geometry = new THREE.DodecahedronGeometry(0.5, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0xa6a18f,
    roughness: 0.98,
    metalness: 0,
    vertexColors: true
  });
  const mesh = new THREE.InstancedMesh(geometry, material, RIM_STONES);
  mesh.name = "dry_landscape_hand_set_stone_rim";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < RIM_STONES; i++) {
    const angle = (i / RIM_STONES) * Math.PI * 2;
    const stagger = (hash(i, 131) - 0.5) * 0.12;
    const x = DRY_LANDSCAPE_CENTER.x + Math.cos(angle) * (DRY_LANDSCAPE_RADII.x + stagger);
    const z = DRY_LANDSCAPE_CENTER.z + Math.sin(angle) * (DRY_LANDSCAPE_RADII.z + stagger);
    dummy.position.set(x, map.groundTop(x, z) + 0.105, z);
    dummy.rotation.set((hash(i, 137) - 0.5) * 0.14, -angle + (hash(i, 139) - 0.5) * 0.18, (hash(i, 149) - 0.5) * 0.12);
    dummy.scale.set(0.66 + hash(i, 151) * 0.12, 0.18 + hash(i, 157) * 0.055, 0.4 + hash(i, 163) * 0.07);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    color.setHex(i % 13 === 0 ? 0x849074 : i % 5 === 0 ? 0xb0aa97 : 0x9b988a);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createRockIslands(map: TeaGardenTerrain): THREE.Group {
  const group = new THREE.Group();
  group.name = "dry_landscape_stone_islands";
  const stoneMaterials = [
    new THREE.MeshStandardMaterial({ color: 0x696a64, roughness: 0.96, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x77776f, roughness: 0.98, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x5c605b, roughness: 0.94, flatShading: true })
  ];
  const moss = new THREE.MeshStandardMaterial({ color: 0x758651, roughness: 1, flatShading: true });
  const rockGeometry = new THREE.IcosahedronGeometry(1, 1);
  const capGeometry = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.48);
  ROCKS.forEach((spec, index) => {
    const y = map.groundTop(spec.x, spec.z) + SAND_LIFT;
    const rock = new THREE.Mesh(rockGeometry, stoneMaterials[index % stoneMaterials.length]);
    rock.name = "dry_landscape_weathered_stone";
    rock.position.set(spec.x, y + spec.scale * 0.43, spec.z);
    rock.rotation.set(0.06 * (index % 3), spec.yaw, -0.04 * (index % 2));
    rock.scale.set(spec.scale * 1.15, spec.scale * 0.88, spec.scale);
    rock.castShadow = true;
    rock.receiveShadow = true;
    group.add(rock);
    if (index === 0 || index === 3 || index === 5) {
      const cap = new THREE.Mesh(capGeometry, moss);
      cap.name = "dry_landscape_velvet_moss_cap";
      cap.position.set(spec.x - spec.scale * 0.1, y + spec.scale * 1.14, spec.z + spec.scale * 0.04);
      cap.rotation.y = spec.yaw;
      cap.scale.set(spec.scale * 0.73, spec.scale * 0.18, spec.scale * 0.62);
      cap.receiveShadow = true;
      group.add(cap);
    }
  });
  return group;
}

function cylinderBetween(a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.92, direction.length(), 8), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function createRake(): GardenRakeTool {
  const root = new THREE.Group();
  root.name = "dry_landscape_little_rake";
  const bamboo = new THREE.MeshStandardMaterial({ color: 0xc18a43, roughness: 0.82 });
  const darkBamboo = new THREE.MeshStandardMaterial({ color: 0x7c512b, roughness: 0.9 });
  const cord = new THREE.MeshStandardMaterial({ color: 0xb5392f, roughness: 0.84 });
  const top = new THREE.Vector3(0, 0, 0);
  const head = new THREE.Vector3(0, -1.52, 0.5);
  const handle = cylinderBetween(top, head, 0.035, bamboo);
  handle.name = "garden_rake_bamboo_handle";
  handle.castShadow = true;
  handle.receiveShadow = true;
  root.add(handle);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.09, 0.1), darkBamboo);
  bar.name = "garden_rake_head_bar";
  bar.position.copy(head);
  bar.castShadow = true;
  bar.receiveShadow = true;
  root.add(bar);
  for (let i = 0; i < 7; i++) {
    const tine = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.25, 0.045), darkBamboo);
    tine.name = "garden_rake_tine";
    tine.position.set(-0.45 + i * 0.15, head.y - 0.13, head.z + 0.04);
    tine.rotation.x = -0.18;
    tine.receiveShadow = true;
    root.add(tine);
  }
  const tie = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 5, 10), cord);
  tie.name = "garden_rake_vermilion_wish_cord";
  tie.rotation.x = Math.PI / 2;
  tie.position.set(0, -0.23, 0.075);
  root.add(tie);

  // These anchors are the contract between the activity, the GPU brush, and
  // the Player's two-hand IK. The visible rake can be restyled without ever
  // reintroducing a guessed trail point or a floating head.
  const gripTilt = -Math.atan2(0.5, 1.52);
  const contact = new THREE.Object3D();
  contact.name = "garden_rake_tine_contact";
  contact.position.set(0, -1.777, 0.54);
  const rightGrip = new THREE.Object3D();
  rightGrip.name = "garden_rake_grip_right";
  rightGrip.position.set(0, -0.456, 0.15);
  rightGrip.rotation.set(gripTilt, 0, Math.PI / 2);
  const leftGrip = new THREE.Object3D();
  leftGrip.name = "garden_rake_grip_left";
  leftGrip.position.set(0, -0.182, 0.06);
  leftGrip.quaternion.copy(rightGrip.quaternion).multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)
  );
  root.add(contact, rightGrip, leftGrip);
  return {
    root,
    contact,
    rightGrip,
    leftGrip,
    localAcross: [1, 0, 0],
    localShaft: [0, 1.52, -0.5]
  };
}

function createRakeRack(map: TeaGardenTerrain, rake: GardenRakeTool): THREE.Group {
  const group = new THREE.Group();
  group.name = "dry_landscape_rake_rack";
  const y = map.groundTop(RAKE_RACK.x, RAKE_RACK.z);
  group.position.set(RAKE_RACK.x, y, RAKE_RACK.z);
  group.rotation.y = -0.36;
  const bamboo = new THREE.MeshStandardMaterial({ color: 0x76502d, roughness: 0.92 });
  for (const x of [-0.38, 0.38]) {
    const upright = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 1.28, 7), bamboo);
    upright.position.set(x, 0.64, 0);
    upright.castShadow = true;
    upright.receiveShadow = true;
    group.add(upright);
  }
  const rest = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.94, 7), bamboo);
  rest.rotation.z = Math.PI / 2;
  rest.position.y = 1.05;
  rest.castShadow = true;
  rest.receiveShadow = true;
  group.add(rest);
  group.add(rake.root);
  rake.root.position.set(0.1, 1.92, -0.05);
  rake.root.rotation.set(0.08, 0.08, -0.12);
  return group;
}

function nearRock(x: number, z: number, clearance = 0.25): boolean {
  return ROCKS.some((rock) => Math.hypot(x - rock.x, z - rock.z) < rock.scale * 1.15 + clearance);
}

function createLeafScatter(map: TeaGardenTerrain): THREE.InstancedMesh {
  const shape = new THREE.BufferGeometry();
  shape.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, -0.12, -0.075, 0, 0, 0, 0, 0.12, 0.075, 0, 0
  ], 3));
  shape.setIndex([0, 1, 2, 0, 2, 3]);
  shape.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0xb35b3e, roughness: 0.94, side: THREE.DoubleSide, vertexColors: true });
  const count = 22;
  const mesh = new THREE.InstancedMesh(shape, material, count);
  mesh.name = "dry_landscape_fallen_maple_leaves";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const angle = hash(i, 401) * Math.PI * 2;
    const radius = 0.74 + hash(i, 409) * 0.2;
    const x = DRY_LANDSCAPE_CENTER.x + Math.cos(angle) * DRY_LANDSCAPE_RADII.x * radius;
    const z = DRY_LANDSCAPE_CENTER.z + Math.sin(angle) * DRY_LANDSCAPE_RADII.z * radius;
    dummy.position.set(x, map.groundTop(x, z) + SAND_LIFT + 0.032, z);
    dummy.rotation.set((hash(i, 419) - 0.5) * 0.2, hash(i, 421) * Math.PI * 2, (hash(i, 431) - 0.5) * 0.16);
    dummy.scale.setScalar(0.72 + hash(i, 433) * 0.48);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    color.setHex(i % 4 === 0 ? 0xd18a42 : i % 3 === 0 ? 0x8f4939 : 0xb35b3e);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  return mesh;
}

export function createDryLandscape(map: TeaGardenTerrain, options: DryLandscapeOptions): DryLandscape {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_dry_landscape";

  const simulation: SandSimulation = createSandSimulation({
    renderer: options.renderer,
    map,
    center: DRY_LANDSCAPE_CENTER,
    radii: DRY_LANDSCAPE_RADII,
    sandLift: SAND_LIFT,
    rocks: ROCKS.map((rock) => ({
      x: rock.x,
      z: rock.z,
      radius: rock.scale * 1.15 + 0.16
    }))
  });
  group.add(simulation.mesh, createRim(map), createRockIslands(map), createLeafScatter(map));

  const rake = createRake();
  const rack = createRakeRack(map, rake);
  group.add(rack);

  let held = false;
  let raking = false;
  let rakeEngaged = false;
  let insideSand = false;
  let distanceToRake = Number.POSITIVE_INFINITY;
  let promptVisible = false;
  let previousPlayer: { x: number; z: number } | null = null;
  let previousContactValid = false;
  let previousContactX = 0;
  let previousContactZ = 0;
  let pullX = 0;
  let pullZ = -1;
  let disposed = false;

  const motion: GardenRakeMotion = {
    engaged: false,
    dragging: false,
    contactX: RAKE_RACK.x,
    contactY: map.groundTop(RAKE_RACK.x, RAKE_RACK.z) + SAND_LIFT,
    contactZ: RAKE_RACK.z,
    pullX,
    pullZ,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    shaftElevation: THREE.MathUtils.degToRad(55),
    bodyLean: 0.34
  };
  const stamp = {
    previous: { x: 0, z: 0 },
    current: { x: 0, z: 0 },
    across: { x: 1, z: 0 },
    pull: { x: 0, z: -1 }
  };

  const resetRakePose = () => {
    rack.add(rake.root);
    rake.root.position.set(0.1, 1.92, -0.05);
    rake.root.rotation.set(0.08, 0.08, -0.12);
    rake.root.scale.setScalar(1);
    rake.root.visible = true;
  };

  const setRaking = (next: boolean) => {
    if (raking === next) return;
    raking = next;
  };

  const publishMotion = (engaged: boolean, dragging: boolean) => {
    rakeEngaged = engaged;
    motion.engaged = engaged;
    motion.dragging = dragging;
    motion.pullX = pullX;
    motion.pullZ = pullZ;
    options.onRakeMotion?.(motion);
  };

  const setHeld = (next: boolean, message?: string) => {
    if (held === next) return;
    held = next;
    setRaking(false);
    rakeEngaged = false;
    previousContactValid = false;
    previousPlayer = null;
    if (next) {
      rake.root.removeFromParent();
      options.onCarryRake?.(rake);
    } else {
      options.onRakeMotion?.(null);
      options.onCarryRake?.(null);
      resetRakePose();
    }
    if (message) options.notify?.(message, 3.3);
  };

  return {
    group,
    update(dt, _time, player, mode) {
      if (disposed) return;
      distanceToRake = Math.hypot(player.x - RAKE_RACK.x, player.z - RAKE_RACK.z);
      insideSand = inDryLandscape(player.x, player.z, -0.55);
      if (!held) {
        if (mode === "walk" && distanceToRake <= PICKUP_RANGE + 1.2 && !promptVisible) {
          options.notify?.(formatInteractPrompt("pick up the little garden rake"), 2.1);
          promptVisible = true;
        } else if (distanceToRake > PICKUP_RANGE + 1.8) {
          promptVisible = false;
        }
        simulation.update(dt);
        return;
      }
      if (mode !== "walk" || Math.hypot(player.x - DRY_LANDSCAPE_CENTER.x, player.z - DRY_LANDSCAPE_CENTER.z) > RETURN_RANGE) {
        setHeld(false, "The rake has returned to its garden stand.");
        simulation.update(dt);
        return;
      }
      if (!previousPlayer) {
        previousPlayer = { x: player.x, z: player.z };
        publishMotion(false, false);
        simulation.update(dt);
        return;
      }
      const moveX = player.x - previousPlayer.x;
      const moveZ = player.z - previousPlayer.z;
      const moved = Math.hypot(moveX, moveZ);
      previousPlayer.x = player.x;
      previousPlayer.z = player.z;
      if (moved >= RAKE_STAMP_MIN_DISTANCE) {
        // GardenRakeMotion.pull is head→player. The player is pushing the rake,
        // so it points opposite travel and places the grounded head in front.
        pullX = -moveX / moved;
        pullZ = -moveZ / moved;
      }

      motion.contactX = player.x - pullX * RAKE_CONTACT_FORWARD;
      motion.contactZ = player.z - pullZ * RAKE_CONTACT_FORWARD;
      motion.contactY = map.groundTop(motion.contactX, motion.contactZ) + SAND_LIFT + 0.006;
      const hL = map.groundTop(motion.contactX - RAKE_CONTACT_EPSILON, motion.contactZ);
      const hR = map.groundTop(motion.contactX + RAKE_CONTACT_EPSILON, motion.contactZ);
      const hD = map.groundTop(motion.contactX, motion.contactZ - RAKE_CONTACT_EPSILON);
      const hU = map.groundTop(motion.contactX, motion.contactZ + RAKE_CONTACT_EPSILON);
      const nx = hL - hR;
      const ny = RAKE_CONTACT_EPSILON * 2;
      const nz = hD - hU;
      const normalLength = Math.hypot(nx, ny, nz) || 1;
      motion.normalX = nx / normalLength;
      motion.normalY = ny / normalLength;
      motion.normalZ = nz / normalLength;

      const engaged =
        insideSand &&
        inDryLandscape(motion.contactX, motion.contactZ, -0.4) &&
        !nearRock(motion.contactX, motion.contactZ, 0.22);
      const dragging = engaged && moved >= RAKE_STAMP_MIN_DISTANCE;
      publishMotion(engaged, dragging);
      setRaking(dragging);

      if (!engaged) {
        previousContactValid = false;
        simulation.update(dt);
        return;
      }

      if (dragging && previousContactValid) {
        const contactDistance = Math.hypot(
          motion.contactX - previousContactX,
          motion.contactZ - previousContactZ
        );
        // A teleport or tab-resume must not carve a stripe across the garden.
        if (contactDistance <= 1.35 && contactDistance >= RAKE_STAMP_MIN_DISTANCE * 0.45) {
          stamp.previous.x = previousContactX;
          stamp.previous.z = previousContactZ;
          stamp.current.x = motion.contactX;
          stamp.current.z = motion.contactZ;
          stamp.across.x = pullZ;
          stamp.across.z = -pullX;
          // Sand stores the actual tool-travel direction for directional
          // shading, which is opposite the shaft's head→player pose axis.
          stamp.pull.x = -pullX;
          stamp.pull.z = -pullZ;
          simulation.queueStamp(stamp);
        }
      }
      previousContactX = motion.contactX;
      previousContactZ = motion.contactZ;
      previousContactValid = true;
      simulation.update(dt);
    },
    interact(player, mode) {
      if (disposed) return false;
      if (held) {
        setHeld(false, "Rake returned. The sand will remember your strokes and softly settle.");
        return true;
      }
      if (mode !== "walk" || Math.hypot(player.x - RAKE_RACK.x, player.z - RAKE_RACK.z) > PICKUP_RANGE) return false;
      setHeld(true, "Rake in both hands — walk through the sand to sculpt seven real furrows. E returns it.");
      return true;
    },
    addTuning(folder) {
      return simulation.addTuning(folder);
    },
    syncTuning() {
      simulation.syncTuning();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (held) setHeld(false);
      simulation.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || mesh === simulation.mesh) return;
        geometries.add(mesh.geometry);
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) materials.add(material);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.removeFromParent();
    },
    debugState() {
      return {
        held,
        raking,
        rakeEngaged,
        insideSand,
        distanceToRake,
        contact: { x: motion.contactX, y: motion.contactY, z: motion.contactZ },
        pull: { x: motion.pullX, z: motion.pullZ },
        simulation: simulation.stats
      };
    }
  };
}
