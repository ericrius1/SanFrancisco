import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { lightAnchor } from "../../player/lightPool";
import type { Cockpit } from "../../player/types";
import { applyVehicleShadowPolicy } from "../shadows";
import { rideHeightFromContact } from "../shared";
import {
  normalizeScooterConfig,
  scooterPaintHex,
  scooterSeatHex,
  scooterTrimHex,
  type ScooterConfig
} from "./config";
import {
  paintScooterSurface,
  prepareScooterSurface,
  scooterSurfacePaintKey
} from "./surfaceTexture";

export type ScooterAnim = {
  wheels: THREE.Group[];
  steering: THREE.Group;
  battery: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
};

type ScooterSurfaceState = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  artMaterial: THREE.MeshStandardMaterial;
  rimMaterial: THREE.MeshStandardMaterial;
  glassMaterial: THREE.MeshPhysicalMaterial;
  formGroup: THREE.Group;
  baseConfig: ScooterConfig;
  config: ScooterConfig;
  paintKey: string;
  loadSerial: number;
  assetsActivated: boolean;
  disposed: boolean;
};

const surfaceStates = new WeakMap<THREE.Group, ScooterSurfaceState>();

/** Wheel hub Y and tire outer radius in scooter-local space. */
export const SCOOTER_WHEEL_HUB_Y = 0.055;
export const SCOOTER_WHEEL_OUTER_RADIUS = 0.39 + 0.105;
export const SCOOTER_CONTACT_Y = SCOOTER_WHEEL_HUB_Y - SCOOTER_WHEEL_OUTER_RADIUS;
export const SCOOTER_RIDE_HEIGHT = rideHeightFromContact(SCOOTER_CONTACT_Y);

function roundedBox(w: number, h: number, d: number, r: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const x = w / 2;
  const y = h / 2;
  const rr = Math.min(r, x, y);
  shape.moveTo(-x + rr, -y);
  shape.lineTo(x - rr, -y);
  shape.quadraticCurveTo(x, -y, x, -y + rr);
  shape.lineTo(x, y - rr);
  shape.quadraticCurveTo(x, y, x - rr, y);
  shape.lineTo(-x + rr, y);
  shape.quadraticCurveTo(-x, y, -x, y - rr);
  shape.lineTo(-x, -y + rr);
  shape.quadraticCurveTo(-x, -y, -x + rr, -y);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: d,
    bevelEnabled: true,
    bevelSize: Math.min(0.045, rr * 0.34),
    bevelThickness: Math.min(0.045, d * 0.18),
    bevelSegments: 2
  });
  geometry.translate(0, 0, -d / 2);
  return geometry;
}

export function buildScooterMesh(raw?: ScooterConfig): THREE.Group {
  const config = normalizeScooterConfig(raw);
  const root = new THREE.Group();
  root.name = "electric_scooter";
  const formGroup = new THREE.Group();
  formGroup.name = "scooter_form";
  root.add(formGroup);
  const shadowCasters: THREE.Mesh[] = [];
  const ownedGeometries = new Set<THREE.BufferGeometry>();

  const paint = new THREE.MeshStandardMaterial({ color: scooterPaintHex(config), roughness: 0.42, metalness: 0.08 });
  const trim = new THREE.MeshStandardMaterial({ color: scooterTrimHex(config), roughness: 0.32, metalness: 0.48 });
  const rubber = new THREE.MeshLambertMaterial({ color: 0x10161a });
  const wall = new THREE.MeshLambertMaterial({ color: config.whitewalls ? 0xeee9d8 : 0x252b30 });
  const seatMat = new THREE.MeshStandardMaterial({ color: scooterSeatHex(config), roughness: 0.78, metalness: 0 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x131c22, roughness: 0.62, metalness: 0.16 });
  const brushed = new THREE.MeshStandardMaterial({ color: 0xa8b4b7, roughness: 0.34, metalness: 0.74 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x8cd8e8,
    transparent: true,
    opacity: 0.18 + (config.screenTint / 100) * 0.5,
    roughness: 0.08,
    transmission: 0,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const head = new THREE.MeshLambertMaterial({ color: 0xfff2bf, emissive: 0xffe39a, emissiveIntensity: 2.1 * LIGHT_SCALE });
  const tail = new THREE.MeshLambertMaterial({ color: 0xe0282b, emissive: 0xff201b, emissiveIntensity: 2.25 * LIGHT_SCALE });
  const indicator = new THREE.MeshLambertMaterial({ color: 0xffa23a, emissive: 0xff7b18, emissiveIntensity: 1.35 * LIGHT_SCALE });
  const battery = new THREE.MeshStandardMaterial({ color: 0x72f0c0, emissive: 0x37e4a0, emissiveIntensity: 0.7 * LIGHT_SCALE, roughness: 0.34 });
  const rim = new THREE.MeshStandardMaterial({
    color: scooterTrimHex(config),
    emissive: scooterTrimHex(config),
    emissiveIntensity: (config.rimGlow / 100) * 0.34 * LIGHT_SCALE,
    roughness: 0.3,
    metalness: 0.55
  });
  const rotor = new THREE.MeshStandardMaterial({ color: 0xbcc5c6, roughness: 0.24, metalness: 0.82 });

  const surfaceCanvas = document.createElement("canvas");
  surfaceCanvas.width = 512;
  surfaceCanvas.height = 256;
  paintScooterSurface(surfaceCanvas, config);
  const surfaceTexture = new THREE.CanvasTexture(surfaceCanvas);
  surfaceTexture.colorSpace = THREE.SRGBColorSpace;
  surfaceTexture.anisotropy = 4;
  const artMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: surfaceTexture,
    roughness: 0.42,
    metalness: 0.08,
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });

  const ownedMaterials: THREE.Material[] = [
    paint,
    trim,
    rubber,
    wall,
    seatMat,
    dark,
    brushed,
    glass,
    head,
    tail,
    indicator,
    battery,
    rim,
    rotor,
    artMaterial
  ];

  const mesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    parent: THREE.Object3D = root,
    casts = false
  ) => {
    ownedGeometries.add(geometry);
    const item = new THREE.Mesh(geometry, material);
    item.position.set(x, y, z);
    parent.add(item);
    if (casts) shadowCasters.push(item);
    return item;
  };
  const box = (
    material: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    parent: THREE.Object3D = root,
    casts = false
  ) => mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z, parent, casts);
  const beam = (
    material: THREE.Material,
    radius: number,
    from: THREE.Vector3,
    to: THREE.Vector3,
    parent: THREE.Object3D = root,
    radialSegments = 8
  ) => {
    const delta = to.clone().sub(from);
    const item = mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), radialSegments), material, 0, 0, 0, parent);
    item.position.copy(from).add(to).multiplyScalar(0.5);
    item.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    return item;
  };

  const wheels: THREE.Group[] = [];
  const buildWheel = (parent: THREE.Object3D, x: number, y: number, z: number, front: boolean) => {
    const wheel = new THREE.Group();
    wheel.name = front ? "scooter_front_wheel" : "scooter_rear_wheel";
    wheel.position.set(x, y, z);
    parent.add(wheel);
    const tireGeo = new THREE.TorusGeometry(0.39, 0.105, 12, 30);
    tireGeo.rotateY(Math.PI / 2);
    mesh(tireGeo, rubber, 0, 0, 0, wheel, true);
    const wallGeo = new THREE.TorusGeometry(0.39, 0.066, 8, 30);
    wallGeo.rotateY(Math.PI / 2);
    mesh(wallGeo, wall, 0, 0, 0, wheel);
    const rimGeo = new THREE.TorusGeometry(0.3, 0.035, 8, 24);
    rimGeo.rotateY(Math.PI / 2);
    mesh(rimGeo, rim, 0, 0, 0, wheel);

    const count = config.wheel === "spoke" ? 10 : 7;
    for (let i = 0; i < count; i++) {
      const arm = new THREE.Group();
      arm.rotation.x = (i / count) * Math.PI * 2;
      wheel.add(arm);
      const spoke = box(
        config.wheel === "spoke" ? trim : rim,
        config.wheel === "spoke" ? 0.065 : 0.11,
        0.24,
        config.wheel === "spoke" ? 0.026 : 0.075,
        0,
        0.145,
        0,
        arm
      );
      if (config.wheel === "turbine") spoke.rotation.x = -0.16;
    }
    const hubGeo = new THREE.CylinderGeometry(front ? 0.12 : 0.165, front ? 0.12 : 0.165, 0.19, 18);
    hubGeo.rotateZ(Math.PI / 2);
    mesh(hubGeo, front ? trim : dark, 0, 0, 0, wheel);
    if (front) {
      const discGeo = new THREE.CylinderGeometry(0.205, 0.205, 0.022, 24);
      discGeo.rotateZ(Math.PI / 2);
      mesh(discGeo, rotor, -0.112, 0, 0, wheel);
      const discHub = new THREE.CylinderGeometry(0.06, 0.06, 0.03, 14);
      discHub.rotateZ(Math.PI / 2);
      mesh(discHub, dark, -0.128, 0, 0, wheel);
    }
    wheels.push(wheel);
    return wheel;
  };

  // The whole front assembly shares a steering pivot: wheel, fender, one-sided
  // swing arm, steering column, headlamp, bars, mirrors, and screen all move as
  // one connected mechanism rather than floating around the apron.
  const steering = new THREE.Group();
  steering.name = "scooter_steering_assembly";
  steering.position.set(0, 0, -1.08);
  root.add(steering);
  buildWheel(steering, 0, SCOOTER_WHEEL_HUB_Y, 0, true);
  buildWheel(root, 0, SCOOTER_WHEEL_HUB_Y, 1.01, false);

  const lowerFork = new THREE.Vector3(-0.2, 0.2, 0.015);
  const upperFork = new THREE.Vector3(-0.08, 1.31, 0.23);
  const stemTop = new THREE.Vector3(0, 1.52, 0.25);
  beam(trim, 0.06, lowerFork, upperFork, steering, 10);
  beam(paint, 0.095, new THREE.Vector3(-0.16, 0.43, 0.07), new THREE.Vector3(-0.09, 1.12, 0.2), steering, 10);
  beam(dark, 0.06, lowerFork, new THREE.Vector3(0, SCOOTER_WHEEL_HUB_Y, 0), steering, 9);
  beam(trim, 0.055, upperFork, stemTop, steering, 10);
  // Exposed spring/damper opposite the swing arm is the stylized echo of
  // Vespa's oscillating-arm suspension and makes the load path easy to read.
  beam(dark, 0.072, new THREE.Vector3(0.18, 0.28, 0.02), new THREE.Vector3(0.1, 0.74, 0.12), steering, 10);
  beam(battery, 0.038, new THREE.Vector3(0.18, 0.31, 0.02), new THREE.Vector3(0.11, 0.68, 0.1), steering, 10);
  box(dark, 0.12, 0.22, 0.13, -0.22, 0.13, -0.13, steering); // brake caliper, fixed to fork

  const fenderGeo = new THREE.TorusGeometry(0.43, 0.045, 7, 20, Math.PI * 1.04);
  fenderGeo.rotateY(Math.PI / 2);
  mesh(fenderGeo, paint, 0, SCOOTER_WHEEL_HUB_Y, 0, steering, true);

  const handlebar = new THREE.Group();
  handlebar.position.copy(stemTop);
  steering.add(handlebar);
  box(trim, 0.86, 0.055, 0.055, 0, 0, 0, handlebar);
  box(rubber, 0.19, 0.095, 0.11, -0.45, 0, 0, handlebar);
  box(rubber, 0.19, 0.095, 0.11, 0.45, 0, 0, handlebar);
  box(dark, 0.36, 0.13, 0.18, 0, 0.03, 0.1, handlebar); // digital dash pod
  const dash = box(battery, 0.23, 0.055, 0.11, 0, 0.07, 0.0, handlebar);
  dash.rotation.x = -0.34;
  const lamp = mesh(new THREE.SphereGeometry(0.21, 20, 14), head, 0, -0.08, -0.16, handlebar);
  lamp.scale.set(1.05, 0.92, 0.48);

  for (const side of [-1, 1]) {
    beam(trim, 0.018, new THREE.Vector3(side * 0.32, 0.04, 0.02), new THREE.Vector3(side * 0.53, 0.34, 0.08), handlebar, 7);
    const mirror = mesh(new THREE.SphereGeometry(0.115, 12, 8), dark, side * 0.54, 0.36, 0.08, handlebar);
    mirror.scale.set(1.25, 0.82, 0.24);
    const indicatorLens = mesh(new THREE.SphereGeometry(0.065, 10, 7), indicator, side * 0.36, -0.12, -0.13, handlebar);
    indicatorLens.scale.set(1.2, 0.75, 0.55);
  }

  if (config.screen !== "none") {
    const screenW = config.screen === "touring" ? 0.86 : 0.64;
    const screenH = config.screen === "touring" ? 0.74 : 0.38;
    const screen = mesh(new THREE.PlaneGeometry(screenW, screenH), glass, 0, config.screen === "touring" ? 0.35 : 0.25, 0.12, handlebar);
    screen.rotation.x = -0.18;
    for (const side of [-1, 1]) {
      beam(trim, 0.015, new THREE.Vector3(side * 0.21, 0.06, 0.08), new THREE.Vector3(side * screenW * 0.4, screenH * 0.58, 0.12), handlebar, 6);
    }
  }

  // Monocoque step-through body. The apron, floor spine, under-seat battery
  // shell and steering-neck bridge overlap deliberately so every structural
  // load has an attached visual path.
  const stance = (config.stance - 50) / 50;
  const volume = (config.bodyVolume - 50) / 50;
  const bodyHeightBias = config.body === "touring" ? 0.1 : config.body === "sport" ? -0.08 : 0;
  const bodyWidth = 0.79 + volume * 0.105 + (config.body === "touring" ? 0.04 : 0);
  const shieldHeight = 1.02 + stance * 0.14 + bodyHeightBias;
  const haunchHeight = 0.73 + volume * 0.11 + (config.body === "sport" ? -0.055 : 0.03);
  const haunchDepth = 0.88 + volume * 0.12 + (config.body === "touring" ? 0.08 : 0);
  const seatY = 1.04 + stance * 0.075 + bodyHeightBias * 0.35;

  box(dark, 0.57, 0.16, 1.32, 0, 0.24, 0.02, formGroup, true); // structural battery tray
  box(paint, 0.68, 0.23, 1.18, 0, 0.35, 0.23, formGroup, true); // floor monocoque
  box(trim, 0.63, 0.045, 0.9, 0, 0.49, -0.05, formGroup); // step-through deck
  box(dark, 0.5, 0.018, 0.68, 0, 0.515, -0.04, formGroup); // rubber foot mat
  for (let i = -2; i <= 2; i++) box(trim, 0.42, 0.012, 0.018, 0, 0.529, -0.04 + i * 0.11, formGroup);

  const haunch = mesh(roundedBox(bodyWidth, haunchHeight, haunchDepth, 0.2), paint, 0, 0.6 + volume * 0.025, 0.62, formGroup, true);
  haunch.rotation.x = -0.045;
  const shield = mesh(roundedBox(bodyWidth + 0.045, shieldHeight, 0.24, 0.21), paint, 0, 0.8 + stance * 0.03, -0.69, formGroup, true);
  shield.rotation.x = -0.1;
  const innerApron = mesh(roundedBox(bodyWidth * 0.72, shieldHeight * 0.68, 0.055, 0.15), dark, 0, 0.73, -0.55, formGroup);
  innerApron.rotation.x = -0.1;
  // Fixed bridge terminates at the rotating stem's upper pivot in world space.
  beam(paint, 0.105, new THREE.Vector3(0, 0.96, -0.64), new THREE.Vector3(0, 1.34, -0.84), formGroup, 10);
  beam(trim, 0.047, new THREE.Vector3(0, 1.18, -0.76), new THREE.Vector3(0, 1.41, -0.83), formGroup, 9);

  // Generated artwork lives on lacquered inset panels, not across seams or
  // hardware. Both sides share one bounded canvas texture and GPU upload.
  const artW = haunchDepth * 0.76;
  const artH = haunchHeight * 0.6;
  for (const side of [-1, 1]) {
    const panel = mesh(new THREE.PlaneGeometry(artW, artH), artMaterial, side * (bodyWidth * 0.5 + 0.047), 0.62, 0.61, formGroup);
    panel.rotation.y = side * Math.PI / 2;
    panel.rotation.z = side * 0.02;
  }

  // Battery/motor story: glowing charge window in the floor and a dark direct-
  // drive pod hugging the rear wheel. No exhaust is present on this EV.
  box(battery, 0.31, 0.034, 0.38, 0, 0.54, 0.02, formGroup);
  const motorPod = mesh(roundedBox(0.51, 0.25, 0.42, 0.1), dark, 0, 0.27, 0.86, formGroup);
  motorPod.rotation.x = 0.04;
  for (const x of [-0.19, -0.095, 0, 0.095, 0.19]) box(trim, 0.025, 0.13, 0.31, x, 0.28, 0.88, formGroup);
  beam(dark, 0.058, new THREE.Vector3(0.28, 0.76, 0.64), new THREE.Vector3(0.28, 0.16, 0.98), formGroup, 9);
  beam(battery, 0.03, new THREE.Vector3(0.28, 0.68, 0.69), new THREE.Vector3(0.28, 0.22, 0.94), formGroup, 9);

  // Seat upholstery has real segmentation and piping while preserving the
  // established driver/passenger/pet anchors.
  const seatLength = config.seat === "petpad" ? 1.44 : 1.34;
  if (config.seat === "saddle") {
    const front = mesh(roundedBox(0.61, 0.19, 0.62, 0.15), seatMat, 0, seatY, 0.18, formGroup, true);
    front.rotation.x = -0.025;
    const rear = mesh(roundedBox(0.61, 0.19, 0.61, 0.15), seatMat, 0, seatY + 0.015, 0.86, formGroup, true);
    rear.rotation.x = -0.015;
  } else {
    const seat = mesh(roundedBox(0.62, 0.19, seatLength, 0.16), seatMat, 0, seatY, 0.48, formGroup, true);
    seat.rotation.x = -0.024;
    for (const z of [0.08, 0.46, 0.84]) box(trim, 0.56, 0.018, 0.025, 0, seatY + 0.103, z, formGroup);
  }
  box(trim, 0.64, 0.035, seatLength * 0.9, 0, seatY - 0.105, 0.5, formGroup);
  if (config.seat === "petpad") {
    box(seatMat, 0.075, 0.18, 0.58, -0.33, seatY + 0.13, 0.86, formGroup);
    box(seatMat, 0.075, 0.18, 0.58, 0.33, seatY + 0.13, 0.86, formGroup);
  }

  for (const side of [-1, 1]) {
    const turn = mesh(new THREE.SphereGeometry(0.075, 10, 7), indicator, side * bodyWidth * 0.39, 0.91, -0.83, formGroup);
    turn.scale.set(1.15, 0.75, 0.42);
  }
  box(tail, 0.43, 0.14, 0.08, 0, 0.82, 1.12, formGroup);
  box(trim, 0.48, 0.035, 0.045, 0, 0.93, 1.125, formGroup); // tail-light brow
  root.add(lightAnchor({ color: 0xffedbd, intensity: 0.43 * LIGHT_SCALE, distance: 14 }, 0, 1.44, -1.28));

  // A small planted kickstand reinforces that the floor/frame is not floating.
  beam(dark, 0.035, new THREE.Vector3(-0.24, 0.2, 0.43), new THREE.Vector3(-0.42, SCOOTER_CONTACT_Y + 0.025, 0.58), formGroup, 7);
  beam(dark, 0.035, new THREE.Vector3(0.24, 0.2, 0.43), new THREE.Vector3(0.42, SCOOTER_CONTACT_Y + 0.025, 0.58), formGroup, 7);

  if (config.cargo === "rack" || config.cargo === "topbox") {
    for (const x of [-0.28, 0, 0.28]) beam(trim, 0.02, new THREE.Vector3(x, seatY + 0.02, 1.04), new THREE.Vector3(x, seatY + 0.04, 1.47), formGroup, 6);
    for (const x of [-0.29, 0.29]) beam(trim, 0.024, new THREE.Vector3(x, 0.83, 1.12), new THREE.Vector3(x, seatY + 0.04, 1.38), formGroup, 6);
  }
  if (config.cargo === "topbox") {
    const topbox = mesh(roundedBox(0.68, 0.44, 0.52, 0.13), paint, 0, seatY + 0.27, 1.35, formGroup, true);
    topbox.rotation.x = -0.02;
    box(trim, 0.61, 0.035, 0.45, 0, seatY + 0.265, 1.35, formGroup);
    box(tail, 0.36, 0.07, 0.025, 0, seatY + 0.22, 1.62, formGroup);
  }
  if (config.cargo === "basket") {
    const basket = new THREE.Group();
    basket.position.set(0, 1.08, -0.92);
    formGroup.add(basket);
    for (const x of [-0.32, -0.16, 0, 0.16, 0.32]) beam(trim, 0.014, new THREE.Vector3(x, -0.2, -0.23), new THREE.Vector3(x, 0.2, -0.18), basket, 5);
    for (const z of [-0.23, 0.22]) beam(trim, 0.018, new THREE.Vector3(-0.34, -0.2, z), new THREE.Vector3(0.34, -0.2, z), basket, 5);
    for (const y of [-0.2, 0.2]) beam(trim, 0.018, new THREE.Vector3(-0.34, y, -0.23), new THREE.Vector3(0.34, y, -0.18), basket, 5);
  }

  const cockpitY = seatY + 0.035;
  root.userData.contactY = SCOOTER_CONTACT_Y;
  root.userData.cockpit = { seat: [0, cockpitY, 0.1] } satisfies Cockpit;
  root.userData.passengerSeat = [0, cockpitY + 0.03, 0.82] as [number, number, number];
  root.userData.scooterConfig = { ...config };
  const petSeat = new THREE.Group();
  petSeat.name = "scooter_pet_seat";
  petSeat.position.set(0, cockpitY + 0.11, 0.86);
  formGroup.add(petSeat);
  root.userData.petSeat = petSeat;
  root.userData.scooterAnim = { wheels, steering, battery, rim } satisfies ScooterAnim;

  const state: ScooterSurfaceState = {
    canvas: surfaceCanvas,
    texture: surfaceTexture,
    artMaterial,
    rimMaterial: rim,
    glassMaterial: glass,
    formGroup,
    baseConfig: config,
    config,
    paintKey: scooterSurfacePaintKey(config),
    loadSerial: 0,
    assetsActivated: false,
    disposed: false
  };
  surfaceStates.set(root, state);
  applyVehicleShadowPolicy(root, shadowCasters);
  root.userData.dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    state.loadSerial++;
    surfaceStates.delete(root);
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    surfaceTexture.dispose();
  };
  return root;
}

/** Lightweight held-drag preview; pointer-up still rebuilds the final geometry once. */
export function previewScooterConfig(root: THREE.Group, raw: ScooterConfig): void {
  const state = surfaceStates.get(root);
  if (!state || state.disposed) return;
  const config = normalizeScooterConfig(raw);
  const baseStance = 0.86 + state.baseConfig.stance * 0.0028;
  const nextStance = 0.86 + config.stance * 0.0028;
  const baseVolume = 0.88 + state.baseConfig.bodyVolume * 0.0024;
  const nextVolume = 0.88 + config.bodyVolume * 0.0024;
  state.formGroup.scale.set(nextVolume / baseVolume, nextStance / baseStance, 1);
  state.rimMaterial.emissiveIntensity = (config.rimGlow / 100) * 0.34 * LIGHT_SCALE;
  state.glassMaterial.opacity = 0.18 + (config.screenTint / 100) * 0.5;
  state.config = config;
  root.userData.scooterConfig = { ...config };
  const paintKey = scooterSurfacePaintKey(config);
  if (paintKey !== state.paintKey) {
    state.paintKey = paintKey;
    paintScooterSurface(state.canvas, config);
    state.texture.needsUpdate = true;
    if (state.assetsActivated) void activateScooterAssets(root);
  }
}

/** First-use gate for generated paint/decal files. */
export async function activateScooterAssets(root: THREE.Group): Promise<void> {
  const state = surfaceStates.get(root);
  if (!state || state.disposed) return;
  state.assetsActivated = true;
  const serial = ++state.loadSerial;
  const paintKey = state.paintKey;
  await prepareScooterSurface(state.config);
  if (state.disposed || serial !== state.loadSerial || paintKey !== state.paintKey) return;
  paintScooterSurface(state.canvas, state.config);
  state.texture.needsUpdate = true;
}

export function animateScooter(root: THREE.Group, dt: number, speed: number, steer: number, boost: boolean): void {
  const anim = root.userData.scooterAnim as ScooterAnim | undefined;
  if (!anim) return;
  const spin = dt * speed / SCOOTER_WHEEL_OUTER_RADIUS;
  for (const wheel of anim.wheels) wheel.rotation.x -= spin;
  const turn = THREE.MathUtils.clamp(steer, -1, 1) * 0.34;
  anim.steering.rotation.y += (turn - anim.steering.rotation.y) * Math.min(1, dt * 12);
  anim.battery.emissiveIntensity += ((boost ? 1.28 : 0.68) * LIGHT_SCALE - anim.battery.emissiveIntensity) * Math.min(1, dt * 8);
  const state = surfaceStates.get(root);
  if (state) {
    const baseGlow = (state.config.rimGlow / 100) * 0.34;
    const speedGlow = Math.min(0.26, Math.abs(speed) * 0.006);
    anim.rim.emissiveIntensity += ((baseGlow + speedGlow + (boost ? 0.32 : 0)) * LIGHT_SCALE - anim.rim.emissiveIntensity) * Math.min(1, dt * 7);
  }
}
