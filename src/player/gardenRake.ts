import type * as THREE from "three/webgpu";

/**
 * Activity-owned rake geometry handed to Player while it is being carried.
 * Every anchor must be a descendant of `root`:
 *
 * - `contact` is the centre of the tine tips (the authoritative sand contact),
 * - `rightGrip` is the lower/dominant-hand grip,
 * - `leftGrip` is the upper/off-hand grip.
 *
 * The grip anchors' local quaternions are also their desired hand frames. Their
 * local +X axes must run along the bamboo shaft; roll either anchor about +X to
 * choose which way that palm wraps the handle.
 */
export type GardenRakeTool = {
  root: THREE.Group;
  contact: THREE.Object3D;
  rightGrip: THREE.Object3D;
  leftGrip: THREE.Object3D;
  /** Rake-head bar direction in root-local space. Default: +X. */
  localAcross?: readonly [x: number, y: number, z: number];
  /** Tine-contact toward handle-top direction in root-local space. */
  localShaft?: readonly [x: number, y: number, z: number];
};

/**
 * Allocation-free activity → avatar pose packet. The sand simulation should
 * reuse one object and overwrite its fields each update. `contact*` is the
 * exact world-space point stamped by the simulation, `pull*` points from the
 * tine head toward the player, and `normal*` is the sand surface normal there.
 */
export type GardenRakeMotion = {
  /** Keep the tine head lowered even while the player pauses between strokes. */
  engaged: boolean;
  /** Simulation is actively stamping/displacing sand this frame. */
  dragging: boolean;
  contactX: number;
  contactY: number;
  contactZ: number;
  pullX: number;
  pullZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  /** Shaft elevation above the surface tangent, in radians. Default: 50°. */
  shaftElevation?: number;
  /** Additive forward torso hinge, in radians. Default: 0.24. */
  bodyLean?: number;
};

