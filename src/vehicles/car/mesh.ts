import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LIGHT_SCALE } from "../../config";
import type { Cockpit } from "../../player/types";
import { applyVehicleShadowPolicy } from "../shadows";
import {
  carInteriorHex,
  carRimHex,
  carTrimHex,
  normalizeCarConfig,
  type CarConfig,
  type CarForm,
  type CarWheel
} from "./config";
import {
  carDecalPaintKey,
  carSurfacePaintKey,
  paintCarDecal,
  paintCarSurface,
  prepareCarSurface
} from "./surfaceTexture";
import { attachCarLights, previewCarBrakeColor } from "./lights";
import { CarLoft, surfaceRibbon } from "./bodyLoft";

import { CAR_WHEEL_HUB_Y, CAR_WHEEL_RADIUS, CAR_CONTACT_Y } from "./dimensions";
export { CAR_WHEEL_HUB_Y, CAR_WHEEL_RADIUS, CAR_CONTACT_Y, CAR_RIDE_HEIGHT } from "./dimensions";

export type CarAnim = {
  wheels: THREE.Group[];
  steering: THREE.Group[];
  /** Sprung mass: everything but the wheels. Rolls, pitches and heaves. */
  body: THREE.Object3D | null;
  susp: CarSuspension;
};

/** Presentation-only suspension state (the physics body stays rigid). */
type CarSuspension = {
  ready: boolean;
  yaw: number;
  x: number;
  y: number;
  z: number;
  vy: number;
  speed: number;
  yawRate: number;
  accel: number;
  roll: number;
  rollV: number;
  pitch: number;
  pitchV: number;
  heave: number;
  heaveV: number;
};

function freshSuspension(): CarSuspension {
  return { ready: false, yaw: 0, x: 0, y: 0, z: 0, vy: 0, speed: 0, yawRate: 0, accel: 0, roll: 0, rollV: 0, pitch: 0, pitchV: 0, heave: 0, heaveV: 0 };
}

type FormSpec = {
  width: number;
  wheelX: number;
  frontAxle: number;
  rearAxle: number;
  cockpit: Cockpit;
  decalY: number;
  decalZ: number;
};

type CarSurfaceState = {
  surfaceCanvas: HTMLCanvasElement;
  surfaceTexture: THREE.CanvasTexture;
  decalCanvas: HTMLCanvasElement;
  decalTexture: THREE.CanvasTexture;
  paintMaterial: THREE.MeshPhysicalMaterial;
  decalMaterial: THREE.MeshBasicMaterial;
  config: CarConfig;
  surfaceKey: string;
  decalKey: string;
  loadSerial: number;
  assetsActivated: boolean;
  disposed: boolean;
};

const FORM_SPECS: Record<CarForm, FormSpec> = {
  "coast-coupe": {
    width: 2.24,
    wheelX: 1.04,
    frontAxle: -1.53,
    rearAxle: 1.53,
    cockpit: { seat: [-0.42, 0.54, 0.54], wheel: [-0.42, 0.68, -0.02] },
    decalY: 0.12,
    decalZ: 0.36
  },
  "apex-wedge": {
    width: 2.22,
    wheelX: 1.04,
    frontAxle: -1.6,
    rearAxle: 1.55,
    cockpit: { seat: [-0.42, 0.51, 0.58], wheel: [-0.42, 0.64, 0.02] },
    decalY: 0.08,
    decalZ: 0.25
  },
  "trail-box": {
    width: 2.34,
    wheelX: 1.12,
    frontAxle: -1.48,
    rearAxle: 1.46,
    cockpit: { seat: [-0.43, 0.63, 0.48], wheel: [-0.43, 0.78, -0.08] },
    decalY: 0.31,
    decalZ: 0.2
  },
  "mission-gt": {
    width: 2.27,
    wheelX: 1.06,
    frontAxle: -1.62,
    rearAxle: 1.54,
    cockpit: { seat: [-0.42, 0.56, 0.6], wheel: [-0.42, 0.7, 0.04] },
    decalY: 0.16,
    decalZ: 0.32
  }
};

const carAnimations = new WeakMap<THREE.Object3D, CarAnim>();
const surfaceStates = new WeakMap<THREE.Group, CarSurfaceState>();

export function collectCarAnim(root: THREE.Object3D): CarAnim {
  const wheels: THREE.Group[] = [];
  const steering: THREE.Group[] = [];
  let body: THREE.Object3D | null = null;
  root.traverse((object) => {
    if (!(object instanceof THREE.Group)) return;
    if (object.name.startsWith("car_wheel_")) wheels.push(object);
    if (object.name.startsWith("car_steer_")) steering.push(object);
    if (object.name === "car_body" && !body) body = object;
  });
  return { wheels, steering, body, susp: freshSuspension() };
}

type FormShape = {
  /** Side silhouette of the sprung body, [z, y]. */
  body: readonly (readonly [number, number])[];
  /** Side silhouette of the glasshouse, [z, y]. */
  cabin: readonly (readonly [number, number])[];
  bodyExponent: number;
  bodyTumble: number;
  bodyPlan: number;
  cabinWidth: number;
  cabinExponent: number;
  cabinTumble: number;
  cabinPlan: number;
};

const FORM_SHAPES: Record<CarForm, FormShape> = {
  "coast-coupe": {
    body: [
      [2.32, -0.36], [-2.32, -0.36], [-2.42, -0.12], [-2.2, 0.17],
      [-1.35, 0.38], [0.58, 0.43], [1.62, 0.58], [2.31, 0.28]
    ],
    cabin: [[1.32, 0.39], [-0.95, 0.39], [-0.68, 0.97], [0.02, 1.14], [0.76, 1.02]],
    bodyExponent: 3.4,
    bodyTumble: 0.16,
    bodyPlan: 0.72,
    cabinWidth: 1.76,
    cabinExponent: 2.8,
    cabinTumble: 0.3,
    cabinPlan: 0.62
  },
  "apex-wedge": {
    body: [
      [2.38, -0.36], [-2.44, -0.36], [-2.5, -0.15], [-2.18, 0.08],
      [-1.05, 0.2], [0.36, 0.36], [1.78, 0.55], [2.38, 0.42]
    ],
    cabin: [[1.48, 0.38], [-0.62, 0.3], [-0.18, 1.02], [0.62, 1.12], [1.28, 0.76]],
    bodyExponent: 4.2,
    bodyTumble: 0.12,
    bodyPlan: 0.5,
    cabinWidth: 1.72,
    cabinExponent: 3,
    cabinTumble: 0.32,
    cabinPlan: 0.55
  },
  "trail-box": {
    body: [
      [2.2, -0.36], [-2.18, -0.36], [-2.3, -0.08], [-2.1, 0.42],
      [-1.48, 0.58], [1.7, 0.58], [2.22, 0.38]
    ],
    cabin: [[1.58, 0.54], [-1.02, 0.54], [-0.9, 1.35], [0.92, 1.35], [1.55, 1.05]],
    bodyExponent: 6,
    bodyTumble: 0.07,
    bodyPlan: 0.32,
    cabinWidth: 1.92,
    cabinExponent: 5,
    cabinTumble: 0.14,
    cabinPlan: 0.3
  },
  "mission-gt": {
    body: [
      [2.42, -0.36], [-2.48, -0.36], [-2.52, -0.1], [-2.2, 0.25],
      [-1.12, 0.45], [0.75, 0.48], [1.72, 0.63], [2.4, 0.34]
    ],
    cabin: [[1.48, 0.43], [-0.82, 0.43], [-0.46, 1.08], [0.34, 1.23], [1.18, 0.94]],
    bodyExponent: 3.8,
    bodyTumble: 0.14,
    bodyPlan: 0.62,
    cabinWidth: 1.74,
    cabinExponent: 3,
    cabinTumble: 0.3,
    cabinPlan: 0.58
  }
};

function spokeCount(style: CarWheel): number {
  if (style === "mesh-ten") return 12;
  if (style === "rally-eight") return 8;
  return 10;
}

/**
 * Collapse a group's direct child meshes into one mesh per material. The car
 * was ~100 draws (every spoke, lamp and trim box its own mesh); after this it
 * is ~25 with identical pixels, which matters for every remote driver and
 * parked abandoned car in view. Children that are groups are left alone.
 */
function mergeChildrenByMaterial(
  group: THREE.Object3D,
  casters: Set<THREE.Object3D>,
  receivers: Set<THREE.Object3D>
): void {
  const buckets = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || mesh.children.length > 0 || Array.isArray(mesh.material)) continue;
    const material = mesh.material as THREE.Material;
    let list = buckets.get(material);
    if (!list) buckets.set(material, (list = []));
    list.push(mesh);
  }
  for (const [material, meshes] of buckets) {
    if (meshes.length < 2) continue;
    const parts = meshes.map((mesh) => {
      mesh.updateMatrix();
      const clone = mesh.geometry.clone();
      clone.applyMatrix4(mesh.matrix);
      for (const name of Object.keys(clone.attributes)) {
        if (name !== "position" && name !== "normal" && name !== "uv") clone.deleteAttribute(name);
      }
      if (!clone.getAttribute("normal")) clone.computeVertexNormals();
      const flat = clone.index ? clone.toNonIndexed() : clone;
      if (flat !== clone) clone.dispose();
      return flat;
    });
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const batch = new THREE.Mesh(merged, material);
    batch.name = meshes[0].name || `car_batch_${(material as { name?: string }).name ?? ""}`;
    batch.userData = { ...meshes[0].userData };
    if (meshes.some((mesh) => casters.has(mesh))) casters.add(batch);
    if (meshes.some((mesh) => receivers.has(mesh))) receivers.add(batch);
    for (const mesh of meshes) {
      casters.delete(mesh);
      receivers.delete(mesh);
      group.remove(mesh);
    }
    group.add(batch);
  }
}

/** Front is local -Z, matching CarController. Every form stays inside one collider. */
export function buildCarMesh(raw?: CarConfig): THREE.Group {
  const config = normalizeCarConfig(raw);
  const spec = FORM_SPECS[config.form];
  const shape = FORM_SHAPES[config.form];
  const root = new THREE.Group();
  // The sprung mass. Wheels hang off the root; everything else rides here so
  // animateCar can roll/pitch/heave it over planted tyres.
  const body = new THREE.Group();
  body.name = "car_body";
  root.add(body);
  const casters = new Set<THREE.Object3D>();
  const receivers = new Set<THREE.Object3D>();
  const materials = new Set<THREE.Material>();

  const surfaceCanvas = document.createElement("canvas");
  surfaceCanvas.width = surfaceCanvas.height = 512;
  paintCarSurface(surfaceCanvas, config);
  const surfaceTexture = new THREE.CanvasTexture(surfaceCanvas);
  surfaceTexture.colorSpace = THREE.SRGBColorSpace;
  // Body UVs are a [0,1] side projection; clamp so the finish never tiles.
  surfaceTexture.wrapS = surfaceTexture.wrapT = THREE.ClampToEdgeWrapping;
  surfaceTexture.anisotropy = 4;

  const decalCanvas = document.createElement("canvas");
  decalCanvas.width = 512;
  decalCanvas.height = 256;
  paintCarDecal(decalCanvas, config);
  const decalTexture = new THREE.CanvasTexture(decalCanvas);
  decalTexture.colorSpace = THREE.SRGBColorSpace;
  decalTexture.anisotropy = 4;

  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: surfaceTexture,
    roughness: 0.24 + (100 - config.clearcoat) * 0.0032,
    metalness: 0.18,
    clearcoat: 0.25 + config.clearcoat * 0.0075,
    clearcoatRoughness: 0.06
  });
  const trim = new THREE.MeshStandardMaterial({ color: carTrimHex(config), roughness: 0.3, metalness: 0.7 });
  const darkTrim = new THREE.MeshStandardMaterial({ color: 0x0f1317, roughness: 0.7, metalness: 0.08 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x0b0d0f, roughness: 0.9, metalness: 0.02 });
  // No `transmission`: on the WebGPU path it adds a full-screen viewport copy
  // plus a mip chain every frame the car is on screen, for a tint that a plain
  // transparent coat reproduces at this size.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0f2230,
    roughness: 0.06,
    metalness: 0.0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const cabin = new THREE.MeshStandardMaterial({ color: 0x191a1c, roughness: 0.76, metalness: 0.02 });
  const interior = new THREE.MeshStandardMaterial({ color: carInteriorHex(config), roughness: 0.82, metalness: 0.01 });
  const rim = new THREE.MeshStandardMaterial({ color: carRimHex(config), roughness: 0.2, metalness: 0.95 });
  const caliper = new THREE.MeshStandardMaterial({ color: 0xe25b39, roughness: 0.4, metalness: 0.42 });
  const headlight = new THREE.MeshStandardMaterial({
    color: 0xfff5d7,
    emissive: 0xffe8ad,
    emissiveIntensity: 1.8 * LIGHT_SCALE,
    roughness: 0.18,
    metalness: 0.08
  });
  const taillight = new THREE.MeshStandardMaterial({
    color: 0xb61017,
    emissive: 0xff1b18,
    emissiveIntensity: 2.2 * LIGHT_SCALE,
    roughness: 0.25,
    metalness: 0.04
  });
  const indicator = new THREE.MeshStandardMaterial({
    color: 0xe89625,
    emissive: 0xff9b2b,
    emissiveIntensity: 1.1 * LIGHT_SCALE,
    roughness: 0.28
  });
  const plate = new THREE.MeshStandardMaterial({ color: 0xdde4df, roughness: 0.48, metalness: 0.02 });
  const decalMaterial = new THREE.MeshBasicMaterial({
    map: decalTexture,
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    side: THREE.DoubleSide
  });
  decalMaterial.visible = config.decal !== "none";
  for (const material of [paint, trim, darkTrim, tire, glass, cabin, interior, rim, caliper, headlight, taillight, indicator, plate, decalMaterial]) {
    materials.add(material);
  }

  const add = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    casts = false,
    parent: THREE.Object3D = body
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    parent.add(mesh);
    if (casts) casters.add(mesh);
    return mesh;
  };
  const box = (
    material: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    casts = false,
    parent: THREE.Object3D = body
  ) => add(new THREE.BoxGeometry(w, h, d), material, x, y, z, rx, ry, rz, casts, parent);

  // --- the shells -----------------------------------------------------------
  const archRadius = CAR_WHEEL_RADIUS + 0.07;
  const shell = new CarLoft({
    profile: shape.body,
    width: spec.width,
    exponent: shape.bodyExponent,
    tumblehome: shape.bodyTumble,
    planRadius: shape.bodyPlan,
    zSteps: 44,
    ringSteps: 40,
    arches: [spec.frontAxle, spec.rearAxle].map((z) => ({
      z,
      y: CAR_WHEEL_HUB_Y,
      radius: archRadius,
      innerX: spec.wheelX - 0.25
    }))
  });
  const lowerBody = add(shell.build(), paint, 0, 0, 0, 0, 0, 0, true);
  receivers.add(lowerBody);
  const glassShell = new CarLoft({
    profile: shape.cabin,
    width: shape.cabinWidth,
    exponent: shape.cabinExponent,
    tumblehome: shape.cabinTumble,
    planRadius: shape.cabinPlan,
    zSteps: 28,
    ringSteps: 28
  });
  add(glassShell.build(), glass);

  // Surface-hugging trim helpers. Everything bolted to the body is laid ON the
  // loft so nothing floats where the old flat side used to be.
  const flank = (z: number, y: number) => {
    const [lo, hi] = [shell.yMin + 0.01, shell.yMax - 0.01];
    let x = shell.sideX(z, Math.min(hi, Math.max(lo, y)));
    // Clamp onto the silhouette so a ribbon edge never collapses to x = 0.
    for (let k = 0; x <= 0.05 && k < 24; k++) x = shell.sideX(z, y + (y > 0 ? -1 : 1) * 0.02 * (k + 1));
    return x;
  };
  /** Horizontal band across the nose (end -1) or tail (end +1). */
  const endBand = (material: THREE.Material, end: -1 | 1, y: number, x0: number, x1: number, height: number, out = 0.012) =>
    add(
      surfaceRibbon(
        (t, s, o) => {
          const x = x0 + (x1 - x0) * t;
          const yy = y + (s - 0.5) * height;
          return o.set(x, yy, shell.endZ(x, yy, end) + end * out);
        },
        (_t, o) => o.set(0, 0, end),
        14
      ),
      material
    );
  /** Horizontal band along a flank (side ±1) between z0 and z1. */
  const flankBand = (material: THREE.Material, side: -1 | 1, y: number, z0: number, z1: number, height: number, out = 0.01) =>
    add(
      surfaceRibbon(
        (t, s, o) => {
          const z = z0 + (z1 - z0) * t;
          const yy = y + (s - 0.5) * height;
          return o.set(side * (flank(z, yy) + out), yy, z);
        },
        (_t, o) => o.set(side, 0, 0),
        16
      ),
      material
    );
  /** Vertical line on a flank (door shut lines). */
  const flankLine = (material: THREE.Material, side: -1 | 1, z: number, y0: number, y1: number, width: number, out = 0.006) =>
    add(
      surfaceRibbon(
        (t, s, o) => {
          const y = y0 + (y1 - y0) * t;
          const zz = z + (s - 0.5) * width;
          return o.set(side * (flank(zz, y) + out), y, zz);
        },
        (_t, o) => o.set(side, 0, 0),
        10
      ),
      material
    );
  const noseZ = (x: number, y: number) => shell.endZ(x, y, -1);
  const tailZ = (x: number, y: number) => shell.endZ(x, y, 1);

  // Cockpit furniture and tactile detail shared by all four silhouettes.
  box(cabin, 1.64, 0.1, 1.75, 0, 0.35, 0.52);
  box(cabin, 1.68, 0.19, 0.34, 0, 0.49, -0.42, config.form === "trail-box" ? 0 : 0.08);
  for (const sx of [-0.43, 0.43]) {
    box(interior, 0.58, 0.16, 0.62, sx, spec.cockpit.seat[1] - 0.18, spec.cockpit.seat[2] + 0.04);
    box(interior, 0.58, 0.5, 0.14, sx, spec.cockpit.seat[1] + 0.1, spec.cockpit.seat[2] + 0.33, 0.12);
    box(trim, 0.095, config.form === "trail-box" ? 0.72 : 0.34, 0.095, sx, config.form === "trail-box" ? 1.02 : 0.77, 1.1);
  }
  box(trim, 0.14, 0.2, 0.72, 0, 0.49, 0.62); // centre tunnel
  box(interior, 0.11, 0.08, 0.19, 0, 0.63, 0.4, -0.22); // shifter
  // Flat underbody: what you see up through the wheel wells and under the sills.
  box(darkTrim, spec.width - 0.62, 0.05, shell.zMax - shell.zMin - 0.55, 0, -0.33, (shell.zMax + shell.zMin) / 2);

  // Door cuts, handles, sills and flared arches give the body scale.
  const sillZ0 = spec.frontAxle + archRadius + 0.08;
  const sillZ1 = spec.rearAxle - archRadius - 0.08;
  for (const side of [-1, 1] as const) {
    flankLine(darkTrim, side, 0.91, -0.14, 0.34, 0.022);
    flankLine(darkTrim, side, -0.62, -0.14, 0.3, 0.018);
    flankBand(trim, side, -0.27, sillZ0, sillZ1, 0.07, 0.012);
    box(trim, 0.05, 0.05, 0.3, side * (flank(0.52, 0.3) + 0.018), 0.3, 0.52);
    for (const wheelZ of [spec.frontAxle, spec.rearAxle]) {
      // A 150° flare so its ends land above the sill instead of hanging below it.
      const sweep = 2.6;
      const arch = new THREE.TorusGeometry(archRadius, 0.045, 6, 22, sweep);
      arch.rotateZ((Math.PI - sweep) / 2);
      arch.rotateY(Math.PI / 2);
      add(arch, paint, side * (flank(wheelZ - archRadius, -0.12) + 0.01), CAR_WHEEL_HUB_Y, wheelZ);
    }
  }

  // Livery: laid on the flank as a conforming sheet, not a plane in the air.
  const decalGeometry = (side: -1 | 1) => {
    const cols = 18, rows = 6;
    const positions: number[] = [];
    const uvs: number[] = [];
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const u = c / cols, v = r / rows;
        const z = spec.decalZ + 0.975 - u * 1.95;
        const y = spec.decalY - 0.36 + v * 0.72;
        positions.push(side * (flank(z, y) + 0.008), y, z);
        uvs.push(u, v);
      }
    }
    const index: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        index.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(index);
    g.computeVertexNormals();
    return g;
  };
  for (const side of [-1, 1] as const) add(decalGeometry(side), decalMaterial);

  // Form-specific lamps, fascias, aero and protective hardware.
  const wing = (y: number, z: number, width: number, depth: number, tilt: number) => {
    box(paint, width, 0.055, depth, 0, y, z, tilt, 0, 0, true);
    for (const sx of [-1, 1]) {
      const x = sx * width * 0.34;
      // Uprights reach down to the deck surface under the blade.
      let top = shell.yMin;
      for (let yy = shell.yMax; yy > shell.yMin; yy -= 0.01) {
        if (shell.sideX(z, yy) >= Math.abs(x)) { top = yy; break; }
      }
      const h = Math.max(0.04, y - top);
      box(trim, 0.045, h, 0.1, x, top + h / 2, z + 0.02);
    }
  };
  if (config.form === "coast-coupe") {
    for (const x of [-0.72, 0.72]) {
      const lamp = add(new THREE.SphereGeometry(0.21, 18, 12), headlight, x, 0.19, noseZ(x, 0.19) + 0.035);
      lamp.scale.z = 0.36;
      add(new THREE.TorusGeometry(0.215, 0.022, 6, 24), trim, x, 0.19, noseZ(x, 0.19) + 0.02);
      endBand(indicator, -1, -0.03, x - 0.09 * Math.sign(x), x + 0.09 * Math.sign(x), 0.08);
    }
    endBand(darkTrim, -1, -0.16, -0.46, 0.46, 0.13);
    endBand(trim, -1, -0.245, -0.5, 0.5, 0.03, 0.016);
    endBand(taillight, 1, 0.24, -0.9, 0.9, 0.11);
    endBand(darkTrim, 1, 0.13, -0.86, 0.86, 0.06, 0.008);
    wing(0.66, 2.03, 1.68, 0.38, 0);
  } else if (config.form === "apex-wedge") {
    box(darkTrim, spec.width * 0.92, 0.05, 0.3, 0, -0.33, noseZ(0, -0.3) + 0.08);
    for (const s of [-1, 1]) endBand(headlight, -1, 0.04, s * 0.42, s * 1.0, 0.055);
    endBand(darkTrim, -1, -0.16, -0.55, 0.55, 0.12);
    endBand(taillight, 1, 0.36, -0.98, 0.98, 0.08);
    for (const s of [-1, 1]) endBand(darkTrim, 1, 0.05, s * 0.66, s * 1.0, 0.24);
    wing(0.74, 2.06, 1.95, 0.42, 0.04);
  } else if (config.form === "trail-box") {
    box(trim, spec.width + 0.04, 0.19, 0.23, 0, -0.16, noseZ(0, -0.16) - 0.06);
    for (const s of [-1, 1]) {
      endBand(headlight, -1, 0.24, s * 0.52, s * 0.92, 0.3);
      endBand(indicator, -1, 0.47, s * 0.62, s * 0.84, 0.08);
      endBand(taillight, 1, 0.27, s * 0.7, s * 1.02, 0.36);
    }
    endBand(darkTrim, -1, 0.21, -0.46, 0.46, 0.34);
    for (const x of [-0.34, -0.11, 0.11, 0.34]) box(trim, 0.05, 0.33, 0.05, x, 0.21, noseZ(x, 0.21) - 0.02);
    box(trim, spec.width - 0.08, 0.13, 0.22, 0, -0.18, tailZ(0, -0.18) + 0.05);
    // Open safari cage and roof light bar: detailed without hiding the driver.
    for (const x of [-0.78, 0.78]) {
      box(trim, 0.075, 0.9, 0.075, x, 0.94, -0.72, 0.04);
      box(trim, 0.075, 0.9, 0.075, x, 0.94, 1.0, -0.04);
      box(trim, 0.075, 0.075, 1.76, x, 1.38, 0.14);
    }
    box(trim, 1.72, 0.075, 0.075, 0, 1.38, -0.73);
    for (const x of [-0.62, -0.2, 0.2, 0.62]) box(headlight, 0.26, 0.2, 0.1, x, 1.46, -0.72);
  } else {
    for (const s of [-1, 1]) {
      endBand(headlight, -1, 0.21, s * 0.44, s * 1.02, 0.12);
      endBand(darkTrim, -1, -0.08, s * 0.58, s * 0.92, 0.14);
    }
    endBand(darkTrim, -1, -0.12, -0.36, 0.36, 0.15);
    endBand(trim, -1, -0.12, -0.38, 0.38, 0.02, 0.02);
    endBand(taillight, 1, 0.31, -0.96, 0.96, 0.1);
    endBand(trim, 1, 0.22, -0.9, 0.9, 0.025, 0.01);
    wing(0.62, 2.12, 1.66, 0.3, -0.03);
  }

  // Mirrors, number plate, exhausts and diffuser finish the beauty pass.
  const mirrorY = config.form === "trail-box" ? 0.86 : 0.65;
  for (const side of [-1, 1] as const) {
    const cx = glassShell.sideX(-0.62, mirrorY);
    const mx = side * (Math.max(cx, shape.cabinWidth * 0.38) + 0.13);
    box(trim, 0.2, 0.11, 0.15, mx, mirrorY, -0.66, 0, side * 0.12, 0);
    box(trim, 0.12, 0.03, 0.04, mx - side * 0.1, mirrorY - 0.04, -0.62);
    const exhaust = new THREE.CylinderGeometry(0.055, 0.065, 0.24, 12);
    exhaust.rotateX(Math.PI / 2);
    add(exhaust, trim, side * 0.55, -0.22, tailZ(side * 0.55, -0.22) - 0.03);
  }
  box(darkTrim, 1.25, 0.12, 0.24, 0, -0.29, tailZ(0, -0.27) - 0.08);
  box(plate, 0.46, 0.17, 0.03, 0, -0.04, tailZ(0, -0.04) + 0.008);

  // --- wheels (unsprung: children of the root, not the body) ----------------
  const wheelGeometry = new THREE.CylinderGeometry(CAR_WHEEL_RADIUS, CAR_WHEEL_RADIUS, 0.37, 28);
  wheelGeometry.rotateZ(Math.PI / 2);
  // Rounded shoulders: a torus at each sidewall lip reads as a real tyre.
  const shoulderGeometry = new THREE.TorusGeometry(CAR_WHEEL_RADIUS - 0.035, 0.035, 6, 28);
  shoulderGeometry.rotateY(Math.PI / 2);
  const discGeometry = new THREE.CylinderGeometry(0.285, 0.285, 0.035, 24);
  discGeometry.rotateZ(Math.PI / 2);
  const hubGeometry = new THREE.CylinderGeometry(0.085, 0.085, 0.42, 16);
  hubGeometry.rotateZ(Math.PI / 2);
  const rimGeometry = new THREE.TorusGeometry(0.315, 0.042, 8, 28);
  rimGeometry.rotateY(Math.PI / 2);
  const spokeGeometry = new THREE.BoxGeometry(config.wheel === "rally-eight" ? 0.065 : 0.048, 0.31, config.wheel === "mesh-ten" ? 0.035 : 0.052);

  const placements = [
    [-spec.wheelX, spec.frontAxle, "fl"],
    [spec.wheelX, spec.frontAxle, "fr"],
    [-spec.wheelX, spec.rearAxle, "rl"],
    [spec.wheelX, spec.rearAxle, "rr"]
  ] as const;
  const count = spokeCount(config.wheel);
  for (const [wx, wz, id] of placements) {
    const side = Math.sign(wx) || 1;
    const steering = new THREE.Group();
    steering.name = wz < 0 ? `car_steer_${id}` : `car_axle_${id}`;
    steering.position.set(wx, CAR_WHEEL_HUB_Y, wz);
    root.add(steering);
    const spin = new THREE.Group();
    spin.name = `car_wheel_${id}`;
    steering.add(spin);
    const wheel = add(wheelGeometry, tire, 0, 0, 0, 0, 0, 0, true, spin);
    wheel.scale.x = 1.03; // a little sidewall bulge without moving ground contact
    add(shoulderGeometry, tire, 0.175, 0, 0, 0, 0, 0, false, spin);
    add(shoulderGeometry, tire, -0.175, 0, 0, 0, 0, 0, false, spin);
    add(discGeometry, darkTrim, side * 0.13, 0, 0, 0, 0, 0, false, spin);
    const rimMesh = add(rimGeometry, rim, side * 0.205, 0, 0, 0, 0, 0, false, spin);
    rimMesh.name = `car_spokes_${id}`;
    rimMesh.userData.spokeCount = count;
    add(hubGeometry, rim, 0, 0, 0, 0, 0, 0, false, spin);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const spoke = add(spokeGeometry, rim, side * 0.205, Math.cos(angle) * 0.16, Math.sin(angle) * 0.16, angle, 0, 0, false, spin);
      if (config.wheel === "split-five") spoke.rotation.x += (i % 2 ? 0.045 : -0.045);
    }
    // Calipers steer with the wheel but do not rotate, making spin legible.
    box(caliper, 0.11, 0.18, 0.09, side * 0.16, 0.02, -0.21, 0, 0, 0, false, steering);
    mergeChildrenByMaterial(spin, casters, receivers);
  }
  mergeChildrenByMaterial(body, casters, receivers);
  // Every source geometry was either merged (cloned) or is still referenced;
  // dispose ownership follows the live mesh set, never the build-time list.
  const geometries = new Set<THREE.BufferGeometry>();
  const sourceGeometries = [wheelGeometry, shoulderGeometry, discGeometry, hubGeometry, rimGeometry, spokeGeometry];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) geometries.add(mesh.geometry);
  });
  for (const geometry of sourceGeometries) if (!geometries.has(geometry)) geometry.dispose();

  root.userData.cockpit = spec.cockpit;
  // Seat riders on the sprung body so they roll and pitch with the cabin.
  root.userData.cockpitParent = body;
  root.userData.passengerSeat = [-spec.cockpit.seat[0], spec.cockpit.seat[1], spec.cockpit.seat[2]] satisfies [number, number, number];
  root.userData.contactY = CAR_CONTACT_Y;
  root.userData.wheelContactY = CAR_CONTACT_Y;
  root.userData.carConfig = { ...config };
  const anim = collectCarAnim(root);
  root.userData.carAnim = anim;
  carAnimations.set(root, anim);
  // Volumetric headlamp beams + ground splash + brake-glow wiring on the shared
  // taillight material. Added before the shadow policy pass so the additive
  // cones are classified as non-casting / non-receiving like the other lamps.
  const lightRig = attachCarLights(root, taillight, config);

  const state: CarSurfaceState = {
    surfaceCanvas,
    surfaceTexture,
    decalCanvas,
    decalTexture,
    paintMaterial: paint,
    decalMaterial,
    config,
    surfaceKey: carSurfacePaintKey(config),
    decalKey: carDecalPaintKey(config),
    loadSerial: 0,
    assetsActivated: false,
    disposed: false
  };
  surfaceStates.set(root, state);
  applyVehicleShadowPolicy(root, casters, receivers);
  root.userData.dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    state.loadSerial++;
    surfaceStates.delete(root);
    carAnimations.delete(root);
    lightRig.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    surfaceTexture.dispose();
    decalTexture.dispose();
  };
  return root;
}

/** First-use gate for the selected GPT Image finish and decal. */
export async function activateCarAssets(root: THREE.Group): Promise<void> {
  const state = surfaceStates.get(root);
  if (!state || state.disposed) return;
  state.assetsActivated = true;
  const serial = ++state.loadSerial;
  const surfaceKey = state.surfaceKey;
  const decalKey = state.decalKey;
  await prepareCarSurface(state.config);
  if (state.disposed || serial !== state.loadSerial || surfaceKey !== state.surfaceKey || decalKey !== state.decalKey) return;
  paintCarSurface(state.surfaceCanvas, state.config);
  paintCarDecal(state.decalCanvas, state.config);
  state.surfaceTexture.needsUpdate = true;
  state.decalTexture.needsUpdate = true;
  state.decalMaterial.visible = state.config.decal !== "none";
}

/** Local-only held-control preview: update the live car without a rebuild or network broadcast. */
export function previewCarConfig(root: THREE.Group, raw: CarConfig): void {
  const state = surfaceStates.get(root);
  if (!state || state.disposed) return;
  const config = normalizeCarConfig(raw);
  state.config = config;
  state.surfaceKey = carSurfacePaintKey(config);
  state.decalKey = carDecalPaintKey(config);
  root.userData.carConfig = { ...config };
  paintCarSurface(state.surfaceCanvas, config);
  paintCarDecal(state.decalCanvas, config);
  state.surfaceTexture.needsUpdate = true;
  state.decalTexture.needsUpdate = true;
  state.decalMaterial.visible = config.decal !== "none";
  state.paintMaterial.roughness = 0.24 + (100 - config.clearcoat) * 0.0032;
  state.paintMaterial.clearcoat = 0.25 + config.clearcoat * 0.0075;
  previewCarBrakeColor(root, config);
  if (state.assetsActivated) void activateCarAssets(root);
}

const SUSP = {
  rollOmega: 8.5,
  rollZeta: 0.42,
  pitchOmega: 8,
  pitchZeta: 0.45,
  heaveOmega: 10.5,
  heaveZeta: 0.36,
  /** rad per m/s² of lateral acceleration (body leans out of the turn). */
  rollGain: 0.0042,
  rollMax: 0.06,
  /** rad per m/s² of longitudinal acceleration (squat on throttle, dive on brakes). */
  pitchGain: 0.0036,
  pitchMax: 0.05,
  /** Fraction of a sudden vertical-velocity change fed into heave. */
  heaveKick: 0.075,
  heaveMin: -0.11,
  heaveMax: 0.07
};

const _m = new THREE.Matrix4();

/**
 * Visible spoke rotation, front-wheel steering and a damped presentation
 * suspension for local and remote cars. The suspension reads the root's own
 * motion (previous-frame world matrix), so remote cars — which only report a
 * pose and a speed — lean, squat and land exactly like the local one.
 *
 * `steer` may be omitted: the front wheels then follow the measured yaw rate.
 */
export function animateCar(root: THREE.Group, dt: number, speed: number, steer?: number): void {
  let anim = carAnimations.get(root);
  if (!anim) {
    anim = collectCarAnim(root);
    carAnimations.set(root, anim);
  }
  const s = anim.susp;
  _m.copy(root.matrixWorld);
  const e = _m.elements;
  const fx = -e[8], fz = -e[10];
  const yaw = Math.atan2(-fx, -fz);
  const px = e[12], py = e[13], pz = e[14];
  const step = Math.min(dt, 1 / 20);
  let signedSpeed = speed;
  if (!s.ready || dt <= 1e-5 || dt > 0.25) {
    s.ready = true;
    s.yaw = yaw;
    s.x = px;
    s.y = py;
    s.z = pz;
    s.vy = 0;
    s.speed = speed;
  } else {
    const dx = px - s.x, dz = pz - s.z;
    const moved = Math.hypot(dx, dz);
    // Teleports and respawns reset the sim instead of slamming the springs.
    if (moved > 40 * dt + 2) {
      s.yaw = yaw;
      s.vy = 0;
      s.speed = speed;
      s.roll = s.rollV = s.pitch = s.pitchV = s.heave = s.heaveV = 0;
    } else {
      // Signed travel along the nose so reversing spins the wheels backwards.
      const along = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
      if (moved > 1e-3 && along < 0) signedSpeed = -Math.abs(speed);
      let dYaw = yaw - s.yaw;
      if (dYaw > Math.PI) dYaw -= Math.PI * 2;
      if (dYaw < -Math.PI) dYaw += Math.PI * 2;
      const yawRate = dYaw / dt;
      const vy = (py - s.y) / dt;
      const accel = (speed - s.speed) / dt;
      // Low-pass the measured rates: remote poses arrive at 12 Hz.
      const lp = 1 - Math.exp(-dt * 10);
      s.yawRate += (yawRate - s.yawRate) * lp;
      s.accel += (THREE.MathUtils.clamp(accel, -40, 40) - s.accel) * lp;
      // A sudden change in vertical velocity (landing, curb, crest) kicks the
      // heave spring; smooth slopes barely register.
      const dvy = vy - s.vy;
      if (Math.abs(dvy) < 30) s.heaveV -= dvy * SUSP.heaveKick;
      s.vy = vy;
      s.speed = speed;
      s.yaw = yaw;
    }
  }
  s.x = px;
  s.y = py;
  s.z = pz;

  const lateral = Math.abs(speed) * s.yawRate;
  const rollTarget = THREE.MathUtils.clamp(-lateral * SUSP.rollGain, -SUSP.rollMax, SUSP.rollMax);
  const pitchTarget = THREE.MathUtils.clamp(s.accel * SUSP.pitchGain, -SUSP.pitchMax, SUSP.pitchMax);
  const spring = (x: number, v: number, target: number, omega: number, zeta: number): [number, number] => {
    const a = omega * omega * (target - x) - 2 * zeta * omega * v;
    const nv = v + a * step;
    return [x + nv * step, nv];
  };
  [s.roll, s.rollV] = spring(s.roll, s.rollV, rollTarget, SUSP.rollOmega, SUSP.rollZeta);
  [s.pitch, s.pitchV] = spring(s.pitch, s.pitchV, pitchTarget, SUSP.pitchOmega, SUSP.pitchZeta);
  [s.heave, s.heaveV] = spring(s.heave, s.heaveV, 0, SUSP.heaveOmega, SUSP.heaveZeta);
  s.heave = THREE.MathUtils.clamp(s.heave, SUSP.heaveMin, SUSP.heaveMax);
  if (anim.body) {
    anim.body.position.y = s.heave;
    anim.body.rotation.set(s.pitch, 0, s.roll);
  }

  const spin = (dt * signedSpeed) / CAR_WHEEL_RADIUS;
  for (const wheel of anim.wheels) wheel.rotation.x -= spin;
  const wheelbase = 3.1;
  const steerInput = steer ?? THREE.MathUtils.clamp((s.yawRate * wheelbase) / Math.max(Math.abs(speed), 2) / 0.34, -1, 1) * Math.sign(signedSpeed || 1);
  const turn = THREE.MathUtils.clamp(steerInput, -1, 1) * 0.34;
  for (const pivot of anim.steering) {
    pivot.rotation.y += (turn - pivot.rotation.y) * Math.min(1, dt * 11);
  }
}
