import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { Cockpit } from "../../player/types";
import { applyVehicleShadowPolicy } from "../shadows";
import { rideHeightFromContact } from "../shared";
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

/** Wheel hub and actual tire radius in mesh space (root = physics body centre). */
export const CAR_WHEEL_HUB_Y = -0.38;
export const CAR_WHEEL_RADIUS = 0.43;
export const CAR_CONTACT_Y = CAR_WHEEL_HUB_Y - CAR_WHEEL_RADIUS;
export const CAR_RIDE_HEIGHT = rideHeightFromContact(CAR_CONTACT_Y);

export type CarAnim = {
  wheels: THREE.Group[];
  steering: THREE.Group[];
};

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
  root.traverse((object) => {
    if (!(object instanceof THREE.Group)) return;
    if (object.name.startsWith("car_wheel_")) wheels.push(object);
    if (object.name.startsWith("car_steer_")) steering.push(object);
  });
  return { wheels, steering };
}

/** Extruded side silhouette: authored in local Z/Y, extruded across local X. */
function profileGeometry(width: number, points: readonly (readonly [number, number])[], bevel = 0.045): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(-points[i][0], points[i][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    steps: 1,
    bevelEnabled: bevel > 0,
    bevelSegments: 2,
    bevelSize: bevel,
    bevelThickness: bevel,
    curveSegments: 4
  });
  geometry.translate(0, 0, -width / 2);
  geometry.rotateY(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function spokeCount(style: CarWheel): number {
  if (style === "mesh-ten") return 12;
  if (style === "rally-eight") return 8;
  return 10;
}

/** Front is local -Z, matching CarController. Every form stays inside one collider. */
export function buildCarMesh(raw?: CarConfig): THREE.Group {
  const config = normalizeCarConfig(raw);
  const spec = FORM_SPECS[config.form];
  const root = new THREE.Group();
  const shadowCasters: THREE.Mesh[] = [];
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  const surfaceCanvas = document.createElement("canvas");
  surfaceCanvas.width = surfaceCanvas.height = 512;
  paintCarSurface(surfaceCanvas, config);
  const surfaceTexture = new THREE.CanvasTexture(surfaceCanvas);
  surfaceTexture.colorSpace = THREE.SRGBColorSpace;
  surfaceTexture.wrapS = surfaceTexture.wrapT = THREE.RepeatWrapping;
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
    clearcoatRoughness: 0.12
  });
  const trim = new THREE.MeshStandardMaterial({ color: carTrimHex(config), roughness: 0.34, metalness: 0.62 });
  const darkTrim = new THREE.MeshStandardMaterial({ color: 0x11161a, roughness: 0.72, metalness: 0.08 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x080a0c, roughness: 0.93, metalness: 0.02 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x183246,
    roughness: 0.12,
    metalness: 0.05,
    transmission: 0.16,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const cabin = new THREE.MeshStandardMaterial({ color: 0x191a1c, roughness: 0.76, metalness: 0.02 });
  const interior = new THREE.MeshStandardMaterial({ color: carInteriorHex(config), roughness: 0.82, metalness: 0.01 });
  const rim = new THREE.MeshStandardMaterial({ color: carRimHex(config), roughness: 0.22, metalness: 0.92 });
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

  const add = <G extends THREE.BufferGeometry>(
    geometry: G,
    material: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    casts = false,
    parent: THREE.Object3D = root
  ) => {
    geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    parent.add(mesh);
    if (casts) shadowCasters.push(mesh);
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
    parent: THREE.Object3D = root
  ) => add(new THREE.BoxGeometry(w, h, d), material, x, y, z, rx, ry, rz, casts, parent);

  const bodyProfiles: Record<CarForm, readonly (readonly [number, number])[]> = {
    "coast-coupe": [
      [2.32, -0.36], [-2.32, -0.36], [-2.42, -0.12], [-2.2, 0.17],
      [-1.35, 0.38], [0.58, 0.43], [1.62, 0.58], [2.31, 0.28]
    ],
    "apex-wedge": [
      [2.38, -0.36], [-2.44, -0.36], [-2.5, -0.15], [-2.18, 0.08],
      [-1.05, 0.2], [0.36, 0.36], [1.78, 0.55], [2.38, 0.42]
    ],
    "trail-box": [
      [2.2, -0.36], [-2.18, -0.36], [-2.3, -0.08], [-2.1, 0.42],
      [-1.48, 0.58], [1.7, 0.58], [2.22, 0.38]
    ],
    "mission-gt": [
      [2.42, -0.36], [-2.48, -0.36], [-2.52, -0.1], [-2.2, 0.25],
      [-1.12, 0.45], [0.75, 0.48], [1.72, 0.63], [2.4, 0.34]
    ]
  };
  const lowerBody = add(profileGeometry(spec.width, bodyProfiles[config.form], config.form === "apex-wedge" ? 0.025 : 0.055), paint, 0, 0, 0, 0, 0, 0, true);

  const cabinProfiles: Record<CarForm, readonly (readonly [number, number])[]> = {
    "coast-coupe": [[1.32, 0.39], [-0.95, 0.39], [-0.68, 0.97], [0.02, 1.14], [0.76, 1.02]],
    "apex-wedge": [[1.48, 0.38], [-0.62, 0.3], [-0.18, 1.02], [0.62, 1.12], [1.28, 0.76]],
    "trail-box": [[1.58, 0.54], [-1.02, 0.54], [-0.9, 1.35], [0.92, 1.35], [1.55, 1.05]],
    "mission-gt": [[1.48, 0.43], [-0.82, 0.43], [-0.46, 1.08], [0.34, 1.23], [1.18, 0.94]]
  };
  const cabinWidth = config.form === "trail-box" ? 1.9 : 1.72;
  add(profileGeometry(cabinWidth, cabinProfiles[config.form], 0.025), glass);

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

  // Door cuts, handles, rocker panels and wheel arches give the body scale.
  for (const side of [-1, 1] as const) {
    const sideX = side * (spec.width / 2 + 0.046);
    box(darkTrim, 0.022, 0.52, 0.022, sideX, 0.12, 0.91, 0, 0, -0.05);
    box(trim, 0.052, 0.07, 2.7, sideX, -0.27, 0.02);
    box(trim, 0.055, 0.055, 0.32, sideX, 0.38, 0.52);
    for (const wheelZ of [spec.frontAxle, spec.rearAxle]) {
      const arch = new THREE.TorusGeometry(CAR_WHEEL_RADIUS + 0.035, 0.035, 6, 20, Math.PI);
      arch.rotateY(Math.PI / 2);
      add(arch, paint, sideX, CAR_WHEEL_HUB_Y, wheelZ);
    }
    const decal = add(new THREE.PlaneGeometry(1.95, 0.72), decalMaterial, sideX + side * 0.012, spec.decalY, spec.decalZ, 0, side * Math.PI / 2);
    decal.scale.x = side;
  }

  // Form-specific brightwork, fascias, aero and protective hardware.
  if (config.form === "coast-coupe") {
    for (const x of [-0.72, 0.72]) {
      const lamp = add(new THREE.SphereGeometry(0.22, 16, 10), headlight, x, 0.2, -2.29);
      lamp.scale.z = 0.34;
      box(indicator, 0.18, 0.1, 0.07, x, -0.02, -2.39);
    }
    box(trim, 0.88, 0.13, 0.08, 0, -0.16, -2.4);
    box(taillight, 1.75, 0.13, 0.08, 0, 0.27, 2.32);
    box(paint, 1.68, 0.055, 0.38, 0, 0.68, 2.03, 0, 0, 0, true);
    box(trim, 1.38, 0.07, 0.08, 0, 1.14, 0.12);
  } else if (config.form === "apex-wedge") {
    box(trim, 2.18, 0.08, 0.35, 0, -0.29, -2.39);
    for (const x of [-0.72, 0.72]) box(headlight, 0.58, 0.065, 0.08, x, 0.11, -2.36, 0, 0, sideSlope(x));
    box(taillight, 1.92, 0.095, 0.08, 0, 0.38, 2.37);
    for (const x of [-0.84, 0.84]) box(darkTrim, 0.3, 0.26, 0.07, x, 0.05, 2.38);
    box(paint, 1.95, 0.065, 0.42, 0, 0.75, 2.06, 0.04, 0, 0, true);
    box(trim, 1.48, 0.06, 0.08, 0, 1.12, 0.42);
  } else if (config.form === "trail-box") {
    box(trim, 2.38, 0.19, 0.23, 0, -0.16, -2.23);
    for (const x of [-0.72, 0.72]) {
      box(headlight, 0.42, 0.32, 0.08, x, 0.24, -2.24);
      box(indicator, 0.19, 0.1, 0.08, x, 0.48, -2.23);
    }
    for (const x of [-0.46, -0.23, 0, 0.23, 0.46]) box(darkTrim, 0.07, 0.35, 0.08, x, 0.2, -2.25);
    box(taillight, 0.3, 0.38, 0.09, -0.85, 0.27, 2.22);
    box(taillight, 0.3, 0.38, 0.09, 0.85, 0.27, 2.22);
    box(trim, 2.26, 0.13, 0.22, 0, -0.18, 2.22);
    // Open safari cage and roof light bar: detailed without hiding the driver.
    for (const x of [-0.78, 0.78]) {
      box(trim, 0.075, 0.9, 0.075, x, 0.94, -0.72, 0.04);
      box(trim, 0.075, 0.9, 0.075, x, 0.94, 1.0, -0.04);
      box(trim, 0.075, 0.075, 1.76, x, 1.38, 0.14);
    }
    box(trim, 1.72, 0.075, 0.075, 0, 1.38, -0.73);
    for (const x of [-0.62, -0.2, 0.2, 0.62]) box(headlight, 0.26, 0.2, 0.1, x, 1.46, -0.72);
  } else {
    for (const x of [-0.74, 0.74]) {
      box(headlight, 0.6, 0.13, 0.08, x, 0.22, -2.45, 0, 0, sideSlope(x) * 0.5);
      box(darkTrim, 0.34, 0.14, 0.08, x, -0.08, -2.46);
    }
    box(trim, 0.72, 0.14, 0.08, 0, -0.12, -2.47);
    box(taillight, 1.9, 0.12, 0.08, 0, 0.33, 2.41);
    box(paint, 1.72, 0.06, 0.32, 0, 0.76, 2.08, 0, 0, 0, true);
    box(trim, 1.44, 0.06, 0.08, 0, 1.2, 0.38);
  }

  // Mirrors, number plates, exhausts and lower diffuser finish the beauty pass.
  for (const side of [-1, 1] as const) {
    box(trim, 0.24, 0.12, 0.17, side * (spec.width / 2 + 0.05), config.form === "trail-box" ? 0.86 : 0.65, -0.65);
    const exhaust = new THREE.CylinderGeometry(0.055, 0.065, 0.24, 10);
    exhaust.rotateX(Math.PI / 2);
    add(exhaust, trim, side * 0.55, -0.21, 2.36);
  }
  box(darkTrim, 1.25, 0.12, 0.24, 0, -0.27, 2.28);
  box(plate, 0.46, 0.18, 0.035, 0, -0.02, 2.42);

  const wheelGeometry = new THREE.CylinderGeometry(CAR_WHEEL_RADIUS, CAR_WHEEL_RADIUS, 0.37, 24);
  wheelGeometry.rotateZ(Math.PI / 2);
  const discGeometry = new THREE.CylinderGeometry(0.285, 0.285, 0.035, 24);
  discGeometry.rotateZ(Math.PI / 2);
  const hubGeometry = new THREE.CylinderGeometry(0.085, 0.085, 0.42, 16);
  hubGeometry.rotateZ(Math.PI / 2);
  const rimGeometry = new THREE.TorusGeometry(0.315, 0.042, 8, 28);
  rimGeometry.rotateY(Math.PI / 2);
  const spokeGeometry = new THREE.BoxGeometry(config.wheel === "rally-eight" ? 0.065 : 0.048, 0.31, config.wheel === "mesh-ten" ? 0.035 : 0.052);
  for (const geometry of [wheelGeometry, discGeometry, hubGeometry, rimGeometry, spokeGeometry]) geometries.add(geometry);

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
    add(discGeometry, darkTrim, side * 0.13, 0, 0, 0, 0, 0, false, spin);
    add(rimGeometry, rim, side * 0.205, 0, 0, 0, 0, 0, false, spin);
    add(hubGeometry, rim, 0, 0, 0, 0, 0, 0, false, spin);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const spoke = add(spokeGeometry, rim, side * 0.205, Math.cos(angle) * 0.16, Math.sin(angle) * 0.16, angle, 0, 0, false, spin);
      spoke.name = `car_spoke_${id}_${i}`;
      if (config.wheel === "split-five") spoke.rotation.x += (i % 2 ? 0.045 : -0.045);
    }
    // Calipers steer with the wheel but do not rotate, making spin legible.
    box(caliper, 0.11, 0.18, 0.09, side * 0.16, 0.02, -0.21, 0, 0, 0, false, steering);
  }

  root.userData.cockpit = spec.cockpit;
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
  applyVehicleShadowPolicy(root, shadowCasters, [lowerBody]);
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

function sideSlope(x: number): number {
  return x < 0 ? -0.08 : 0.08;
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

/** Visible spoke rotation and front-wheel steering for local and remote cars. */
export function animateCar(root: THREE.Group, dt: number, speed: number, steer: number): void {
  let anim = carAnimations.get(root);
  if (!anim) {
    anim = collectCarAnim(root);
    carAnimations.set(root, anim);
  }
  const spin = dt * speed / CAR_WHEEL_RADIUS;
  for (const wheel of anim.wheels) wheel.rotation.x -= spin;
  const turn = THREE.MathUtils.clamp(steer, -1, 1) * 0.34;
  for (const pivot of anim.steering) {
    pivot.rotation.y += (turn - pivot.rotation.y) * Math.min(1, dt * 11);
  }
}
