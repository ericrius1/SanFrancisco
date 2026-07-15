import * as THREE from "three/webgpu";
import {
  instancedBufferAttribute,
  mix,
  positionWorld,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec2,
  vec3
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { tunables } from "../core/persist";
import type { PlayerMode } from "../player/types";
import { waterHeight, type WorldMap } from "./heightmap";

type N = any;

const MAX_ECHOES = 24;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3();

export const WATER_ECHO_TUNING = tunables("waterEchoes", {
  enabled: { v: true, label: "water echoes" },
  intensity: { v: 1, min: 0, max: 2, step: 0.05, label: "overall intensity" },
  shadow: { v: 0.92, min: 0, max: 1.5, step: 0.05, label: "broken silhouettes" },
  glow: { v: 1.1, min: 0, max: 2, step: 0.05, label: "colored shimmer" },
  altitudeSpread: { v: 0.012, min: 0, max: 0.03, step: 0.001, label: "height spread" },
  maxAltitude: { v: 420, min: 40, max: 1000, step: 10, label: "maximum source height" },
  maxDistance: { v: 1600, min: 200, max: 4000, step: 50, label: "camera distance" },
  maxSources: { v: 12, min: 1, max: MAX_ECHOES, step: 1, label: "source budget" }
});

export type WaterEchoStyle = "streak" | "wing" | "burst";

export type WaterEchoSource = {
  position: THREE.Vector3;
  color: THREE.ColorRepresentation;
  width: number;
  length: number;
  heading?: number;
  strength?: number;
  glow?: number;
  importance?: number;
  seed?: number;
  style?: WaterEchoStyle;
};

type PendingEcho = {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  width: number;
  length: number;
  heading: number;
  strength: number;
  glow: number;
  importance: number;
  seed: number;
  style: number;
};

type VisibleEcho = PendingEcho & {
  cx: number;
  cy: number;
  cz: number;
  altitude: number;
  visibility: number;
  score: number;
};

const styleIndex = (style: WaterEchoStyle | undefined) =>
  style === "wing" ? 1 : style === "burst" ? 2 : 0;

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Sparse, semantic reflections for the open water. Sources submit only a pose,
 * scale and colour; the renderer turns the most relevant few into broken dark
 * echoes plus colored light streaks. No scene capture and no full-bay texture
 * lookup are involved: the work is two instanced draws over small local quads,
 * and both meshes disappear when the source list is empty.
 */
export class WaterEchoes {
  readonly shadows: THREE.InstancedMesh;
  readonly lights: THREE.InstancedMesh;

  #map: WorldMap;
  #time = uniform(0);
  #intensity = uniform(WATER_ECHO_TUNING.values.intensity);
  #shadowAmount = uniform(WATER_ECHO_TUNING.values.shadow);
  #glowAmount = uniform(WATER_ECHO_TUNING.values.glow);
  #color: THREE.InstancedBufferAttribute;
  #data: THREE.InstancedBufferAttribute;
  #pending: PendingEcho[] = [];
  #visible: VisibleEcho[] = [];
  #camera: THREE.Camera | null = null;
  #sourceColor = new THREE.Color();
  #cameraForward = new THREE.Vector3();
  #toEcho = new THREE.Vector3();
  #projected = new THREE.Vector3();
  #dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, map: WorldMap) {
    this.#map = map;

    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.#color = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ECHOES * 3), 3);
    this.#data = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ECHOES * 4), 4);
    this.#color.setUsage(THREE.DynamicDrawUsage);
    this.#data.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("echoColor", this.#color);
    geometry.setAttribute("echoData", this.#data);

    const colorV = varying(instancedBufferAttribute(this.#color) as N) as N;
    const dataV = varying(instancedBufferAttribute(this.#data) as N) as N;
    const q = uv().mul(2).sub(1).toVar();
    const oval = smoothstep(1.02, 0.52, vec2(q.x, q.y.mul(0.92)).length()).toVar();
    const isWing = step(0.5, dataV.y).mul(step(dataV.y, 1.5)).toVar();
    const isBurst = step(1.5, dataV.y).toVar();
    const isStreak = isWing.add(isBurst).oneMinus().toVar();

    // A readable bird-like echo: long body, broad swept wings and two tail
    // streamers. Wave bands later break it apart so it never reads as a decal.
    const body = smoothstep(0.2, 0.035, q.x.abs())
      .mul(smoothstep(1.0, 0.18, q.y.abs()));
    const wingLine = q.y.add(q.x.abs().mul(0.34)).sub(0.03).abs();
    const wings = smoothstep(0.23, 0.035, wingLine)
      .mul(smoothstep(1.0, 0.16, q.x.abs()));
    const tailGate = smoothstep(0.05, 0.52, q.y);
    const tailLine = q.x.abs().sub(q.y.mul(0.22)).abs();
    const tail = smoothstep(0.13, 0.025, tailLine).mul(tailGate);
    const wingShape = body.max(wings).max(tail).mul(oval).toVar();

    const streakCore = smoothstep(0.72, 0.04, q.x.abs())
      .mul(smoothstep(1.0, 0.1, q.y.abs()))
      .mul(oval);
    const radius = q.length();
    const burstShape = smoothstep(0.22, 0.02, radius.sub(0.52).abs())
      .add(smoothstep(0.24, 0.02, radius))
      .mul(oval)
      .clamp(0, 1);
    const shape = streakCore.mul(isStreak)
      .add(wingShape.mul(isWing))
      .add(burstShape.mul(isBurst))
      .toVar();

    // Two cheap directional waves fracture every source in world space. The
    // marks therefore swim with the bay rather than with their receiver quad.
    const breakA = sin(positionWorld.x.mul(0.34).add(positionWorld.z.mul(0.19)).add(this.#time.mul(1.1)));
    const breakB = sin(positionWorld.x.mul(-0.16).add(positionWorld.z.mul(0.43)).sub(this.#time.mul(0.82)).add(dataV.w.mul(9.1)));
    const breakup = smoothstep(-0.65, 0.8, breakA.add(breakB.mul(0.62)))
      .mul(0.72)
      .add(0.28)
      .toVar();

    const shadowMaterial = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    shadowMaterial.colorNode = mix(vec3(0.006, 0.018, 0.024), colorV.mul(0.11), 0.62);
    shadowMaterial.opacityNode = shape
      .mul(breakup)
      .mul(dataV.x)
      .mul(this.#intensity)
      .mul(this.#shadowAmount)
      .mul(0.72)
      .clamp(0, 0.86);

    // The additive layer uses narrower fragments of the same semantic shape.
    // It supplies fire, navigation lights and magical color without requiring
    // those source materials to render a second time.
    const strand = sin(q.x.mul(23).add(q.y.mul(4)).add(dataV.w.mul(17)).sub(this.#time.mul(1.7)))
      .mul(0.5)
      .add(0.5);
    const filament = smoothstep(0.48, 0.94, strand)
      .mul(breakup)
      .mul(shape)
      .add(shape.mul(breakup).mul(isWing).mul(0.24))
      .clamp(0, 1)
      .toVar();
    const lightMaterial = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });
    lightMaterial.colorNode = colorV.mul(0.92 * LIGHT_SCALE).mul(this.#intensity).mul(this.#glowAmount);
    lightMaterial.opacityNode = filament.mul(dataV.z).mul(0.9).clamp(0, 1);

    this.shadows = new THREE.InstancedMesh(geometry, shadowMaterial, MAX_ECHOES);
    this.lights = new THREE.InstancedMesh(geometry, lightMaterial, MAX_ECHOES);
    for (const mesh of [this.shadows, this.lights]) {
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 12.2;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.shadows.name = "water_echo_shadows";
    this.lights.name = "water_echo_lights";
    this.lights.renderOrder = 12.3;
    scene.add(this.shadows, this.lights);
  }

  beginFrame(time: number, camera: THREE.Camera): void {
    this.#time.value = time;
    this.#intensity.value = WATER_ECHO_TUNING.values.intensity;
    this.#shadowAmount.value = WATER_ECHO_TUNING.values.shadow;
    this.#glowAmount.value = WATER_ECHO_TUNING.values.glow;
    this.#camera = camera;
    this.#pending.length = 0;
  }

  emit(source: WaterEchoSource): void {
    if (!WATER_ECHO_TUNING.values.enabled || this.#pending.length >= MAX_ECHOES * 4) return;
    this.#sourceColor.set(source.color);
    this.#pending.push({
      x: source.position.x,
      y: source.position.y,
      z: source.position.z,
      r: this.#sourceColor.r,
      g: this.#sourceColor.g,
      b: this.#sourceColor.b,
      width: Math.max(0.25, source.width),
      length: Math.max(0.25, source.length),
      heading: source.heading ?? 0,
      strength: Math.max(0, source.strength ?? 1),
      glow: Math.max(0, source.glow ?? 0),
      importance: Math.max(0.01, source.importance ?? 1),
      seed: source.seed ?? 0.5,
      style: styleIndex(source.style)
    });
  }

  endFrame(): void {
    const camera = this.#camera;
    const tuning = WATER_ECHO_TUNING.values;
    this.#visible.length = 0;
    if (!camera || !tuning.enabled || tuning.intensity <= 0 || this.#pending.length === 0) {
      this.#setCount(0);
      return;
    }

    camera.getWorldDirection(this.#cameraForward);
    const cam = camera.position;
    const maxDistance = tuning.maxDistance;
    const maxAltitude = tuning.maxAltitude;

    for (const source of this.#pending) {
      if (!this.#map.isWater(source.x, source.z)) continue;
      const sourceSurface = waterHeight(source.x, source.z, this.#time.value);
      const altitude = source.y - sourceSurface;
      const cameraAltitude = cam.y - sourceSurface;
      if (altitude < -0.5 || altitude > maxAltitude || cameraAltitude <= 0.1) continue;

      // Intersect the camera→mirrored-source ray with the water plane. This is
      // the correct flat-mirror footprint; the shader then fractures it into a
      // rough-water impression instead of pretending the bay is polished glass.
      const mirrorT = cameraAltitude / Math.max(0.1, cameraAltitude + altitude);
      const cx = cam.x + (source.x - cam.x) * mirrorT;
      const cz = cam.z + (source.z - cam.z) * mirrorT;
      if (!this.#map.isWater(cx, cz)) continue;
      const cy = waterHeight(cx, cz, this.#time.value) + 0.07;

      const distance = this.#toEcho.set(cx - cam.x, cy - cam.y, cz - cam.z).length();
      if (distance > maxDistance || this.#toEcho.dot(this.#cameraForward) <= 0) continue;
      this.#projected.set(cx, cy, cz).project(camera);
      if (Math.abs(this.#projected.x) > 1.45 || Math.abs(this.#projected.y) > 1.45) continue;

      const distanceFade = 1 - smooth01(maxDistance * 0.72, maxDistance, distance);
      const altitudeFade = 1 - smooth01(maxAltitude * 0.74, maxAltitude, altitude);
      const visibility = distanceFade * altitudeFade;
      if (visibility <= 0.002) continue;
      this.#visible.push({
        ...source,
        cx,
        cy,
        cz,
        altitude,
        visibility,
        score: source.importance * visibility / (1 + distance / 500)
      });
    }

    this.#visible.sort((a, b) => b.score - a.score);
    const count = Math.min(MAX_ECHOES, Math.round(tuning.maxSources), this.#visible.length);
    for (let i = 0; i < count; i++) this.#writeInstance(i, this.#visible[i]);
    this.#color.needsUpdate = count > 0;
    this.#data.needsUpdate = count > 0;
    this.shadows.instanceMatrix.needsUpdate = count > 0;
    this.lights.instanceMatrix.needsUpdate = count > 0;
    this.#setCount(count);
  }

  #writeInstance(index: number, echo: VisibleEcho): void {
    const spread = 1 + Math.min(echo.altitude, 180) * WATER_ECHO_TUNING.values.altitudeSpread;
    const width = echo.width * spread;
    const length = echo.length * spread;
    this.#color.setXYZ(index, echo.r, echo.g, echo.b);
    this.#data.setXYZW(
      index,
      echo.strength * echo.visibility,
      echo.style,
      echo.glow * echo.visibility,
      echo.seed
    );

    this.#dummy.position.set(echo.cx, echo.cy, echo.cz);
    this.#dummy.quaternion.setFromAxisAngle(Y_AXIS, echo.heading);
    this.#dummy.scale.set(width, 1, length);
    this.#dummy.updateMatrix();
    this.shadows.setMatrixAt(index, this.#dummy.matrix);

    const viewYaw = Math.atan2(this.#camera!.position.x - echo.cx, this.#camera!.position.z - echo.cz);
    const lightYaw = echo.style === 1 ? echo.heading : viewYaw;
    this.#dummy.quaternion.setFromAxisAngle(Y_AXIS, lightYaw);
    this.#dummy.scale.set(width * 0.86, 1, length * (echo.style === 1 ? 1.08 : 1.7));
    this.#dummy.updateMatrix();
    this.lights.setMatrixAt(index, this.#dummy.matrix);
  }

  #setCount(count: number): void {
    this.shadows.count = count;
    this.lights.count = count;
    this.shadows.visible = count > 0 && WATER_ECHO_TUNING.values.shadow > 0;
    this.lights.visible = count > 0 && WATER_ECHO_TUNING.values.glow > 0;
  }
}

type EmbodimentEchoState = {
  mode: PlayerMode;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  speed: number;
};

const EMBODIMENT_ECHOES: Partial<Record<PlayerMode, Omit<WaterEchoSource, "position" | "heading">>> = {
  walk: { color: 0xa9d8d2, width: 1.2, length: 2.4, strength: 0.45, glow: 0.03, style: "streak" },
  drive: { color: 0xffb36b, width: 5.2, length: 9, strength: 0.55, glow: 0.22, style: "streak" },
  scooter: { color: 0x78ffd4, width: 2.2, length: 4.8, strength: 0.5, glow: 0.18, style: "streak" },
  plane: { color: 0xa8cfff, width: 14, length: 18, strength: 0.72, glow: 0.12, importance: 3, style: "wing" },
  boat: { color: 0xffd39a, width: 7.5, length: 13, strength: 0.65, glow: 0.16, importance: 2, style: "streak" },
  speedboat: { color: 0x9deaff, width: 6.5, length: 17, strength: 0.68, glow: 0.24, importance: 2, style: "streak" },
  drone: { color: 0x9efcff, width: 5, length: 5, strength: 0.5, glow: 0.34, importance: 2, style: "burst" },
  board: { color: 0x64ffe0, width: 2.8, length: 6.5, strength: 0.48, glow: 0.16, style: "streak" },
  surf: { color: 0x76ffe5, width: 5.5, length: 12, strength: 0.42, glow: 0.2, style: "streak" },
  bird: { color: 0xff8a32, width: 17, length: 25, strength: 0.9, glow: 1.3, importance: 10, style: "wing" }
};

/** Submit any local or remote embodiment through the same reflection language. */
export function emitEmbodimentWaterEcho(echoes: WaterEchoes, state: EmbodimentEchoState): void {
  const preset = EMBODIMENT_ECHOES[state.mode];
  if (!preset) return;
  FORWARD.set(0, 0, 1).applyQuaternion(state.quaternion);
  const speedStretch = Math.min(1.8, Math.max(0, state.speed) * 0.012);
  echoes.emit({
    ...preset,
    position: state.position,
    heading: Math.atan2(FORWARD.x, FORWARD.z),
    length: preset.length * (1 + speedStretch),
    glow: (preset.glow ?? 0) * (1 + speedStretch * 0.35),
    seed: state.mode === "bird" ? 0.73 : 0.31
  });
}
