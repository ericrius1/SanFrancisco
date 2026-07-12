import type * as THREE from "three/webgpu";

export type Vec3Like = readonly [number, number, number] | THREE.Vector3;

/** Mutable output reused by every camera rig to keep the render loop alloc-free. */
export type CameraPose = {
  eye: THREE.Vector3;
  target: THREE.Vector3;
  focalLength: number;
  roll: number;
};

export type ShotSample = {
  /** Absolute cinematic time, in seconds. */
  time: number;
  /** Time since this shot's first frame, in seconds. */
  localTime: number;
  /** Shot duration, in seconds. */
  duration: number;
  /** Clamped normalized shot progress. */
  u: number;
};

export type CameraSafety = {
  /** Minimum lens height above the terrain query surface. */
  floorClearance?: number;
  /** Report line-of-sight blockers during preflight. Runtime correction is avoided. */
  auditOcclusion?: boolean;
};

export type CinematicShot = {
  id: string;
  start: number;
  end: number;
  /** Pure camera function: the same sample must always produce the same pose. */
  camera: (sample: ShotSample, out: CameraPose) => void;
  safety?: CameraSafety;
};

export type CinematicCue = {
  id: string;
  at: number;
  run: () => void;
};

export type OverlayAlign = "left" | "right" | "center";

export type OverlayCue = {
  id: string;
  start: number;
  end: number;
  eyebrow?: string;
  title: string;
  detail?: string;
  accent?: string;
  align?: OverlayAlign;
  /** Seconds used for both the in and out envelope. */
  fade?: number;
};

export type CameraAuditIssue = {
  shot: string;
  at: number;
  kind: "floor" | "occlusion" | "speed" | "reversal";
  detail: string;
};

export type CameraAudit = {
  samples: number;
  issues: CameraAuditIssue[];
};

export type CinematicFrameState = {
  name: string;
  time: number;
  duration: number;
  shot: string;
  shotProgress: number;
  camera: {
    eye: [number, number, number];
    target: [number, number, number];
    focalLength: number;
  };
};
