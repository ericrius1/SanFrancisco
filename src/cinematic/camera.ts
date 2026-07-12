import * as THREE from "three/webgpu";
import type { WorldMap } from "../world/heightmap";
import type { WorldQueries } from "../core/worldQueries";
import { clamp01, smoothstep, vectorRail } from "./curves";
import type {
  CameraAudit,
  CameraAuditIssue,
  CameraPose,
  CinematicFrameState,
  CinematicShot,
  ShotSample
} from "./types";

const UP = new THREE.Vector3(0, 1, 0);
const TMP_DIR = new THREE.Vector3();
const TMP_ORIGIN = new THREE.Vector3();
const TMP_PREV_DIR = new THREE.Vector3();

export function createCameraPose(focalLength = 40): CameraPose {
  return {
    eye: new THREE.Vector3(),
    target: new THREE.Vector3(),
    focalLength,
    roll: 0
  };
}

export function setPose(
  out: CameraPose,
  eye: readonly [number, number, number] | THREE.Vector3,
  target: readonly [number, number, number] | THREE.Vector3,
  focalLength = 40,
  roll = 0
) {
  Array.isArray(eye) ? out.eye.set(eye[0], eye[1], eye[2]) : out.eye.copy(eye as THREE.Vector3);
  Array.isArray(target)
    ? out.target.set(target[0], target[1], target[2])
    : out.target.copy(target as THREE.Vector3);
  out.focalLength = focalLength;
  out.roll = roll;
  return out;
}

export function railCamera(options: {
  eye: readonly (readonly [number, number, number])[];
  target: readonly (readonly [number, number, number])[];
  focalLength?: number | ((sample: ShotSample) => number);
  easing?: (u: number) => number;
}) {
  const eyeRail = vectorRail(options.eye);
  const targetRail = vectorRail(options.target);
  const easing = options.easing ?? smoothstep;
  return (sample: ShotSample, out: CameraPose) => {
    const u = easing(sample.u);
    eyeRail(u, out.eye);
    targetRail(u, out.target);
    out.focalLength = typeof options.focalLength === "function"
      ? options.focalLength(sample)
      : options.focalLength ?? 40;
    out.roll = 0;
  };
}

export function orbitCamera(options: {
  focus: (out: THREE.Vector3) => THREE.Vector3;
  radius: number | ((sample: ShotSample) => number);
  height: number | ((sample: ShotSample) => number);
  azimuth: number | ((sample: ShotSample) => number);
  focalLength?: number | ((sample: ShotSample) => number);
}) {
  const focus = new THREE.Vector3();
  const value = (v: number | ((sample: ShotSample) => number), s: ShotSample) =>
    typeof v === "function" ? v(s) : v;
  return (sample: ShotSample, out: CameraPose) => {
    options.focus(focus);
    const azimuth = value(options.azimuth, sample);
    const radius = value(options.radius, sample);
    out.eye.set(
      focus.x + Math.sin(azimuth) * radius,
      focus.y + value(options.height, sample),
      focus.z + Math.cos(azimuth) * radius
    );
    out.target.copy(focus);
    out.focalLength = options.focalLength === undefined ? 40 : value(options.focalLength, sample);
    out.roll = 0;
  };
}

type ShotCameraDeps = {
  name: string;
  duration: number;
  camera: THREE.PerspectiveCamera;
  map?: WorldMap;
  worldQueries?: WorldQueries;
  shots: readonly CinematicShot[];
};

/**
 * Shot sequencer with physical-lens controls and a preflight audit. Camera
 * collision is audited along the authored rail; only a terrain floor clamp is
 * applied at runtime, avoiding the visible jitter of frame-by-frame pull-outs.
 */
export class ShotCamera {
  readonly name: string;
  readonly duration: number;
  readonly shots: readonly CinematicShot[];
  readonly audit: CameraAudit;

  #camera: THREE.PerspectiveCamera;
  #map?: WorldMap;
  #worldQueries?: WorldQueries;
  #pose = createCameraPose();
  #sample: ShotSample = { time: 0, localTime: 0, duration: 1, u: 0 };
  #active = 0;

  constructor(deps: ShotCameraDeps) {
    this.name = deps.name;
    this.duration = deps.duration;
    this.#camera = deps.camera;
    this.#map = deps.map;
    this.#worldQueries = deps.worldQueries;
    this.shots = [...deps.shots].sort((a, b) => a.start - b.start);
    this.#validate();
    this.audit = this.#preflight();
  }

  apply(time: number): CinematicFrameState {
    const shot = this.#shotAt(time);
    this.#fillSample(shot, time);
    shot.camera(this.#sample, this.#pose);
    this.#applyFloor(shot);

    this.#camera.position.copy(this.#pose.eye);
    this.#camera.up.copy(UP);
    this.#camera.lookAt(this.#pose.target);
    if (this.#pose.roll !== 0) this.#camera.rotateZ(this.#pose.roll);
    const focalLength = Math.max(12, Math.min(180, this.#pose.focalLength));
    this.#camera.setFocalLength(focalLength);
    this.#camera.updateProjectionMatrix();
    this.#camera.updateMatrixWorld();

    return {
      name: this.name,
      time,
      duration: this.duration,
      shot: shot.id,
      shotProgress: this.#sample.u,
      camera: {
        eye: this.#pose.eye.toArray() as [number, number, number],
        target: this.#pose.target.toArray() as [number, number, number],
        focalLength
      }
    };
  }

  #validate() {
    if (this.shots.length === 0) throw new Error(`${this.name}: cinematic has no shots`);
    let cursor = 0;
    for (const shot of this.shots) {
      if (!(shot.end > shot.start)) throw new Error(`${this.name}/${shot.id}: invalid time range`);
      if (Math.abs(shot.start - cursor) > 1e-4) {
        throw new Error(`${this.name}: shot timeline gap/overlap before ${shot.id} at ${cursor.toFixed(3)}s`);
      }
      cursor = shot.end;
    }
    if (Math.abs(cursor - this.duration) > 1e-4) {
      throw new Error(`${this.name}: shots end at ${cursor}s, expected ${this.duration}s`);
    }
  }

  #shotAt(time: number) {
    const t = Math.min(this.duration - 1e-7, Math.max(0, time));
    while (this.#active < this.shots.length - 1 && t >= this.shots[this.#active].end) this.#active++;
    while (this.#active > 0 && t < this.shots[this.#active].start) this.#active--;
    return this.shots[this.#active];
  }

  #fillSample(shot: CinematicShot, time: number) {
    const duration = shot.end - shot.start;
    this.#sample.time = time;
    this.#sample.localTime = Math.max(0, time - shot.start);
    this.#sample.duration = duration;
    this.#sample.u = clamp01(this.#sample.localTime / duration);
  }

  #applyFloor(shot: CinematicShot) {
    if (!this.#map) return;
    const clearance = shot.safety?.floorClearance ?? 0.5;
    const floor = this.#map.effectiveGround(this.#pose.eye.x, this.#pose.eye.z) + clearance;
    if (this.#pose.eye.y < floor) this.#pose.eye.y = floor;
  }

  #preflight(): CameraAudit {
    const issues: CameraAuditIssue[] = [];
    const pose = createCameraPose();
    const previousEye = new THREE.Vector3();
    const previousDir = new THREE.Vector3();
    let havePrevious = false;
    let samples = 0;

    for (const shot of this.shots) {
      const count = Math.max(8, Math.ceil((shot.end - shot.start) * 6));
      havePrevious = false; // cuts deliberately break velocity continuity
      for (let i = 0; i <= count; i++) {
        const time = THREE.MathUtils.lerp(shot.start, shot.end - 1e-5, i / count);
        this.#fillSample(shot, time);
        shot.camera(this.#sample, pose);
        samples++;

        if (this.#map) {
          const floor = this.#map.effectiveGround(pose.eye.x, pose.eye.z);
          const clearance = pose.eye.y - floor;
          const required = shot.safety?.floorClearance ?? 0.5;
          if (clearance < required - 0.02) {
            issues.push({
              shot: shot.id,
              at: time,
              kind: "floor",
              detail: `camera is ${clearance.toFixed(2)}m above terrain (needs ${required.toFixed(2)}m)`
            });
          }
        }

        if (shot.safety?.auditOcclusion && this.#worldQueries) {
          TMP_DIR.copy(pose.eye).sub(pose.target);
          const distance = TMP_DIR.length();
          if (distance > 1.5) {
            TMP_DIR.divideScalar(distance);
            TMP_ORIGIN.copy(pose.target).addScaledVector(TMP_DIR, 0.7);
            const hit = this.#worldQueries.raycast(TMP_ORIGIN, TMP_DIR, Math.max(0, distance - 0.9), {
              ignoreSelf: true
            });
            if (hit && hit.distance > 0.7) {
              issues.push({
                shot: shot.id,
                at: time,
                kind: "occlusion",
                detail: `${hit.kind} blocks the lens at ${hit.distance.toFixed(1)}m`
              });
            }
          }
        }

        TMP_PREV_DIR.copy(pose.target).sub(pose.eye).normalize();
        if (havePrevious) {
          const step = pose.eye.distanceTo(previousEye);
          if (step > 3.2) {
            issues.push({
              shot: shot.id,
              at: time,
              kind: "speed",
              detail: `camera advances ${step.toFixed(2)}m per preflight sample`
            });
          }
          if (TMP_PREV_DIR.dot(previousDir) < 0.35) {
            issues.push({
              shot: shot.id,
              at: time,
              kind: "reversal",
              detail: "view direction changes abruptly inside the shot"
            });
          }
        }
        previousEye.copy(pose.eye);
        previousDir.copy(TMP_PREV_DIR);
        havePrevious = true;
      }
    }
    return { samples, issues: dedupeIssues(issues) };
  }
}

function dedupeIssues(issues: CameraAuditIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.shot}:${issue.kind}:${Math.round(issue.at * 2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
